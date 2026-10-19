import type { AgentMessage } from "@ny4n/agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	JsonObject,
	JsonValue,
	ModelThinkingLevel,
	ToolResultMessage,
} from "@ny4n/ai";
import type { AgentEvent, EntryRecord, MessageChange } from "@ny4n/durable";
import type { SessionEntry } from "../../core/session-manager.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";

/** The texts waiting in a conversation's queue, as the published `queue_update` reports them. */
export interface QueuedTexts {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

/**
 * Translate durable's event stream to the published JSON event vocabulary.
 *
 * The published vocabulary is the legacy path's (`docs/json.md`): a client written for `--mode json` or `--mode rpc`
 * must see the same event types from either path (N2 gate, Decisions #18 and #21). Where durable's own events carry less
 * than a published event needs, this adapter keeps the little state the difference requires: the in-flight assistant
 * partial, the arguments and accumulated output of a running tool call, the turn's tool results, the active thinking
 * level, and the queue it last published.
 */
export class DurableJsonEventAdapter {
	#partial: AssistantMessage | undefined;
	/** Whether the in-flight assistant message has published a `message_update` yet. */
	#partialUpdated = false;
	#thinkingLevel: ModelThinkingLevel | undefined;
	/** The queue this adapter last published; a session starts with no queued input, as legacy's queue does. */
	#queue: QueuedTexts = { steering: [], followUp: [] };
	readonly #readMessages: () => readonly AgentMessage[];
	readonly #readQueue: () => Promise<QueuedTexts>;
	readonly #toolArgs = new Map<string, JsonObject>();
	readonly #toolText = new Map<string, string>();
	#turnToolResults: ToolResultMessage[] = [];

	constructor(readMessages: () => readonly AgentMessage[], readQueue: () => Promise<QueuedTexts>) {
		this.#readMessages = readMessages;
		this.#readQueue = readQueue;
	}

	async translate(events: readonly AgentEvent[]): Promise<JsonAgentSessionEvent[]> {
		const translated: JsonAgentSessionEvent[] = [];
		for (let index = 0; index < events.length; index++) {
			const event = events[index]!;
			// A bash execution entry is not a conversation message on the legacy path: its RPC command answers with the
			// output and streams `bash_execution_update`, and publishes no message events for the entry it records.
			if (event.type === "message_start" && isBashExecutionEntry(modelEntryAfter(events, index))) continue;
			if (event.type === "message_end" && isBashExecutionEntry(event.entry)) continue;
			// Durable's `inbox_update` names the queued items by id and mode; `queue_update` carries their texts, which
			// only the `nyan.inbox` document holds, so each change is read back (Decision #31).
			if (event.type === "inbox_update") {
				const queue = await this.#readQueue();
				if (sameQueue(this.#queue, queue)) continue;
				this.#queue = queue;
				translated.push({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] });
				continue;
			}
			translated.push(...this.#translate(event));
		}
		return translated;
	}

	#translate(event: AgentEvent): JsonAgentSessionEvent[] {
		switch (event.type) {
			case "snapshot":
				// The snapshot seeds the thinking level, so the first `agent_changed` reports a real change.
				this.#thinkingLevel = event.agent.thinkingLevel;
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
				this.#turnToolResults = [];
				return [{ type: "turn_start" }];
			case "turn_end": {
				const message = this.#readMessages().findLast((candidate) => candidate.role === "assistant");
				if (message === undefined) return [];
				const toolResults = this.#turnToolResults;
				this.#turnToolResults = [];
				return [{ type: "turn_end", message, toolResults }];
			}
			case "message_start":
				if (event.message.role === "assistant") {
					this.#partial = event.message;
					this.#partialUpdated = false;
				}
				return [{ type: "message_start", message: event.message }];
			case "message_update": {
				const updates = this.#messageUpdates(event.usage, event.changes);
				if (updates.length > 0) this.#partialUpdated = true;
				return updates;
			}
			case "message_end": {
				const message = event.entry.model?.[0];
				const events: JsonAgentSessionEvent[] = [];
				if (message?.role === "assistant") {
					// A partial commits at most every 100 ms, so a provider that answers within one interval publishes none.
					// Legacy publishes one `message_update` per provider event, so the completed message is published as one
					// update before `message_end` (Decision #31).
					if (!this.#partialUpdated) {
						events.push(
							toJsonEvent({
								type: "message_update",
								message,
								assistantMessageEvent: terminalMessageEvent(message),
							}),
						);
					}
					this.#partial = undefined;
					this.#partialUpdated = false;
				}
				if (message !== undefined) events.push({ type: "message_end", message });
				// A boundary `custom_message` is a user message for the model and an appended custom entry for a client. The
				// legacy path publishes only the entry; the message events stay, because Decisions #18 and #21 keep every
				// streamed event.
				const appended = appendedEntry(event.entry);
				if (appended !== undefined) events.push({ type: "entry_appended", entry: appended });
				return events;
			}
			case "tool_execution_start":
				this.#toolArgs.set(event.toolCallId, event.args);
				this.#toolText.delete(event.toolCallId);
				return [
					{
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			case "tool_execution_update": {
				const text = accumulateOutput(this.#toolText.get(event.toolCallId) ?? "", event.output);
				this.#toolText.set(event.toolCallId, text);
				return [
					{
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: this.#toolArgs.get(event.toolCallId) ?? {},
						partialResult: partialToolResult(text, event.details, event.diagnostics),
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			}
			case "tool_execution_end": {
				const result = toolResult(event.entry);
				this.#toolArgs.delete(event.toolCallId);
				this.#toolText.delete(event.toolCallId);
				const message = event.entry?.model?.[0];
				if (message?.role === "toolResult") this.#turnToolResults.push(message);
				const durationMs = message?.role === "toolResult" ? message.durationMs : undefined;
				return [
					{
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result,
						isError: toolResultIsError(event.entry),
						...(durationMs === undefined ? {} : { durationMs }),
						...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
					},
				];
			}
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
			case "agent_changed": {
				const level = event.agent.thinkingLevel;
				const previous = this.#thinkingLevel;
				this.#thinkingLevel = level;
				// Legacy publishes a level it can select, never "off": a change to "off" is reported as a clamped level.
				if (level === undefined || level === "off" || level === previous) return [];
				return [{ type: "thinking_level_changed", level }];
			}
			case "entry_appended": {
				const entry = appendedEntry(event.entry);
				return entry === undefined ? [] : [{ type: "entry_appended", entry }];
			}
			case "task_failed":
				return [{ type: "agent_end", messages: [...this.#readMessages()], willRetry: false }];
			case "deferred_poll":
			case "inbox_update":
			case "submission":
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

/** Whether two published queues hold the same texts, in the same order: a queue with no change in it publishes none. */
function sameQueue(previous: QueuedTexts, next: QueuedTexts): boolean {
	const same = (a: readonly string[], b: readonly string[]): boolean =>
		a.length === b.length && a.every((text, index) => text === b[index]);
	return same(previous.steering, next.steering) && same(previous.followUp, next.followUp);
}

/** The entry a `message_end` right after `index` carries, when the two were emitted for the same entry. */
function modelEntryAfter(events: readonly AgentEvent[], index: number): EntryRecord | undefined {
	const next = events[index + 1];
	return next?.type === "message_end" ? next.entry : undefined;
}

/** A bash execution entry: durable records the command's output as a user message, legacy publishes no message. */
function isBashExecutionEntry(entry: EntryRecord | undefined): boolean {
	return entry?.kind === "bashExecution";
}

/**
 * The legacy session entry an appended durable entry stands for, or undefined when legacy has none.
 *
 * A durable entry carries no timestamp or parent: the legacy shape needs both, so a message-backed entry dates itself
 * from its message and a data-only entry is dated when it is published.
 */
function appendedEntry(record: EntryRecord): SessionEntry | undefined {
	const message = record.model?.[0];
	const data = record.data !== undefined && isJsonObject(record.data) ? record.data : {};
	const timestamp = new Date(message?.timestamp ?? Date.now()).toISOString();
	const base = { id: String(record.id), parentId: null, timestamp };
	if (record.kind === "custom_message") {
		if (message?.role !== "user") return undefined;
		const customType = typeof data.customType === "string" ? data.customType : "durable.custom_message";
		return {
			type: "custom_message",
			...base,
			customType,
			content: message.content,
			display: typeof data.display === "boolean" ? data.display : true,
			...(data.details === undefined ? {} : { details: data.details }),
		};
	}
	// `nyan.` kinds are durable bookkeeping: durable's own user, system, reset, and assistant entries.
	if (record.kind.length === 0 || record.kind.startsWith("nyan.")) return undefined;
	// A kind with a model message other than a custom message is a conversation entry, not a custom one.
	if (record.model !== undefined) return undefined;
	return {
		type: "custom",
		...base,
		customType: record.kind,
		...(record.data === undefined ? {} : { data: record.data }),
	};
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

/**
 * The output a tool has reported so far. Durable sends a window: the text it dropped from the front and the text it
 * appended, or the replacement text. The published `partialResult` is the accumulated result, as on the legacy path.
 */
function accumulateOutput(
	previous: string,
	output: { trimStart?: number; append?: string } | { set: string } | undefined,
): string {
	if (output === undefined) return previous;
	if ("set" in output) return output.set;
	return `${previous.slice(output.trimStart ?? 0)}${output.append ?? ""}`;
}

function partialToolResult(
	text: string,
	details: unknown,
	diagnostics: readonly unknown[] | undefined,
): {
	content: { type: "text"; text: string }[];
	isError: boolean;
	details?: unknown;
	diagnostics?: readonly unknown[];
} {
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
