import type { AgentMessage } from "@ny4n/agent-core";
import type { AssistantMessage, AssistantMessageEvent, JsonObject, JsonValue } from "@ny4n/ai";
import type { AgentEvent, EntryRecord, MessageChange } from "@ny4n/durable";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";

/** Translate durable's event stream to the published JSON event vocabulary. */
export class DurableJsonEventAdapter {
	#partial: AssistantMessage | undefined;
	readonly #readMessages: () => readonly AgentMessage[];

	constructor(readMessages: () => readonly AgentMessage[]) {
		this.#readMessages = readMessages;
	}

	translate(events: readonly AgentEvent[]): JsonAgentSessionEvent[] {
		const translated: JsonAgentSessionEvent[] = [];
		for (const event of events) translated.push(...this.#translate(event));
		return translated;
	}

	#translate(event: AgentEvent): JsonAgentSessionEvent[] {
		switch (event.type) {
			case "snapshot":
				return [];
			case "run_start":
				return [{ type: "agent_start" }];
			case "run_end":
				return [
					{
						type: "agent_end",
						messages: [...this.#readMessages()],
						willRetry: false,
					},
					{ type: "agent_settled", aborted: false },
				];
			case "turn_start":
				return [{ type: "turn_start" }];
			case "turn_end": {
				const message = this.#readMessages().findLast((candidate) => candidate.role === "assistant");
				return message === undefined ? [] : [{ type: "turn_end", message, toolResults: [] }];
			}
			case "message_start":
				if (event.message.role === "assistant") this.#partial = event.message;
				return [{ type: "message_start", message: event.message }];
			case "message_update":
				return this.#messageUpdates(event.usage, event.changes);
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") this.#partial = undefined;
				return message === undefined ? [] : [{ type: "message_end", message }];
			}
			case "tool_execution_start":
				return [
					{
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			case "tool_execution_update":
				return [
					{
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: {},
						partialResult: partialToolResult(event.output, event.details, event.diagnostics),
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			case "tool_execution_end":
				return [
					{
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: toolResult(event.entry),
						isError: toolResultIsError(event.entry),
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			case "compaction_start":
				return [{ type: "compaction_start", reason: event.reason }];
			case "compaction_end":
				return [
					{
						type: "compaction_end",
						reason: event.reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						...(event.error === undefined ? {} : { errorMessage: event.error }),
					},
				];
			case "auto_retry_start":
				return [
					{
						type: "auto_retry_start",
						attempt: event.attempt,
						maxAttempts: event.attempt,
						delayMs: Math.max(0, event.at - Date.now()),
						errorMessage: event.errorMessage,
					},
				];
			case "auto_retry_end":
				return [{ type: "auto_retry_end", success: true, attempt: event.attempt }];
			case "task_failed":
				return [{ type: "agent_end", messages: [...this.#readMessages()], willRetry: false }];
			case "deferred_poll":
			case "inbox_update":
			case "submission":
			case "entry_appended":
			case "agent_changed":
			case "usage_changed":
				return [];
		}
	}

	#messageUpdates(usage: AssistantMessage["usage"], changes: readonly MessageChange[]): JsonAgentSessionEvent[] {
		const updates: JsonAgentSessionEvent[] = [];
		for (const change of changes) {
			const partial = this.#applyChange(change);
			if (partial === undefined) continue;
			const assistantMessageEvent = messageEvent(change, partial);
			if (assistantMessageEvent === undefined) continue;
			updates.push(
				toJsonEvent({
					type: "message_update",
					message: { ...partial, usage },
					assistantMessageEvent,
				}),
			);
		}
		return updates;
	}

	#applyChange(change: MessageChange): AssistantMessage | undefined {
		const current = this.#partial;
		if (change.type === "message") {
			this.#partial = change.message;
			return this.#partial;
		}
		if (current === undefined) return undefined;
		const content = [...current.content];
		if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start") {
			content[change.contentIndex] = change.block;
		} else if (change.type === "text_delta") {
			const block = content[change.contentIndex];
			if (block?.type === "text") content[change.contentIndex] = { ...block, text: block.text + change.delta };
		} else if (change.type === "thinking_delta") {
			const block = content[change.contentIndex];
			if (block?.type === "thinking")
				content[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
		} else if (change.type === "toolcall_delta") {
			const block = content[change.contentIndex];
			if (block?.type === "toolCall") {
				content[change.contentIndex] = {
					...block,
					arguments: appendJsonString(block.arguments, change.path, change.delta),
				};
			}
		} else if (change.type === "block") {
			content[change.contentIndex] = change.block;
		}
		this.#partial = { ...current, content };
		return this.#partial;
	}
}

function messageEvent(change: MessageChange, partial: AssistantMessage): AssistantMessageEvent | undefined {
	switch (change.type) {
		case "text_start":
			return { type: "text_start", contentIndex: change.contentIndex, partial };
		case "text_delta":
			return { type: "text_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "thinking_start":
			return { type: "thinking_start", contentIndex: change.contentIndex, partial };
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: change.contentIndex, partial };
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: change.contentIndex, delta: change.delta, partial };
		case "block": {
			if (change.block.type === "text")
				return { type: "text_end", contentIndex: change.contentIndex, content: change.block.text, partial };
			if (change.block.type === "thinking")
				return { type: "thinking_end", contentIndex: change.contentIndex, content: change.block.thinking, partial };
			return { type: "toolcall_end", contentIndex: change.contentIndex, toolCall: change.block, partial };
		}
		case "message":
			return terminalMessageEvent(change.message);
	}
}

function terminalMessageEvent(message: AssistantMessage): AssistantMessageEvent {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return { type: "error", reason: message.stopReason, error: message };
	}
	return {
		type: "done",
		reason: message.stopReason === "pending" || message.stopReason === "deferred" ? "stop" : message.stopReason,
		message,
	};
}

function appendJsonString(value: JsonObject, path: readonly (string | number)[], delta: string): JsonObject {
	if (path.length === 0) return value;
	const [head, ...tail] = path;
	const copy: JsonObject = { ...value };
	const child = copy[head];
	if (tail.length === 0) {
		copy[head] = `${typeof child === "string" ? child : ""}${delta}`;
	} else {
		copy[head] = appendJsonString(isJsonObject(child) ? child : {}, tail, delta);
	}
	return copy;
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function partialToolResult(
	output: { readonly trimStart?: number; readonly append?: string } | { readonly set: string } | undefined,
	details: unknown,
	diagnostics: readonly unknown[] | undefined,
): {
	content: { type: "text"; text: string }[];
	isError: boolean;
	details?: unknown;
	diagnostics?: readonly unknown[];
} {
	const text = output === undefined ? "" : "set" in output ? output.set : (output.append ?? "");
	return {
		content: [{ type: "text", text }],
		isError: false,
		...(details === undefined ? {} : { details }),
		...(diagnostics === undefined ? {} : { diagnostics }),
	};
}

function toolResult(entry: EntryRecord | undefined): { content: unknown[]; isError: boolean; details?: unknown } {
	const message = entry?.model?.[0];
	if (message?.role !== "toolResult") return { content: [], isError: true };
	return {
		content: message.content,
		isError: message.isError,
		...(message.details === undefined ? {} : { details: message.details }),
	};
}

function toolResultIsError(entry: EntryRecord | undefined): boolean {
	return toolResult(entry).isError;
}
