import type { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@ny4n/agent-core";
import type { Api, Message, Model, ToolResultMessage, UserMessage } from "@ny4n/ai";
import {
	type CompactionHooks,
	CompactionTask,
	defineExtension,
	type Extension,
	type GenerationHooks,
	GenerationTask,
	hook,
	type ToolHooks,
	ToolTask,
} from "@ny4n/durable";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../compaction/compaction.ts";
import { createFileOps } from "../compaction/utils.ts";
import type { ExtensionRunner } from "../extensions/runner.ts";
import { isJsonObject, isJsonValue } from "./extension-tools.ts";

/**
 * The provider call that some async work belongs to: the model and abort signal the extension context reports as
 * `ctx.model` and `ctx.signal`.
 */
export interface ProviderCall {
	readonly model: Model<Api> | undefined;
	readonly signal: AbortSignal | undefined;
}

/**
 * One store for the whole process. Each provider call runs inside its own async context, so calls that interleave (a
 * subagent's request next to the parent's) never read each other's model or signal. A plain shared variable would: a
 * call that finishes first restores the value under a call that is still running.
 */
export type ProviderCallScope = AsyncLocalStorage<ProviderCall>;

export interface BeforeRequestEffects {
	readonly systemPrompt?: string;
	readonly messages: readonly UserMessage[];
	messagesApplied: boolean;
}

/** Runs `run` as the provider call described by `model` and `signal`; the values hold for everything `run` awaits. */
export function inProviderCall<T>(
	scope: ProviderCallScope,
	model: Model<Api> | undefined,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	return scope.run({ model, signal }, run);
}

/**
 * The conversation message a handler returned. `context` may also yield custom messages, which the durable request cannot
 * carry, so they are dropped.
 */
function isPlainMessage(message: AgentMessage): message is Message {
	return (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult" ||
		message.role === "system"
	);
}

/**
 * The generation-hook members that carry the Nyan handlers. A member exists only when a loaded extension handles its
 * event, so an installation without such handlers costs nothing on the request path: the hook members switch provider
 * callbacks on, see `HookRunner.has()`.
 *
 * The request and lifecycle members are installed only when their corresponding Nyan handlers exist. The adapter owns the
 * Nyan-specific composition and durable owns the recoverable hook execution.
 */
export function createProviderHooks(
	runner: ExtensionRunner,
	scope: ProviderCallScope,
	getBeforeRequestEffects?: () => BeforeRequestEffects | undefined,
): Partial<GenerationHooks> {
	const members: Partial<GenerationHooks> = {};

	if (runner.hasHandlers("before_agent_start") || getBeforeRequestEffects !== undefined) {
		members.beforeRequest = async ({ messages }) => {
			const effects = getBeforeRequestEffects?.();
			if (effects === undefined) return undefined;
			const next = [...messages];
			if (effects.systemPrompt !== undefined) {
				const index = next.findIndex((message) => message.role === "system");
				const system = index >= 0 ? next[index] : undefined;
				if (system?.role === "system") next[index] = { ...system, content: effects.systemPrompt };
			}
			if (!effects.messagesApplied && effects.messages.length > 0) {
				const index = next.findIndex((message) => message.role === "system");
				next.splice(index < 0 ? 0 : index + 1, 0, ...effects.messages);
				effects.messagesApplied = true;
			}
			return JSON.stringify(next) === JSON.stringify(messages) ? undefined : { messages: next };
		};
	}

	if (runner.hasHandlers("context")) {
		members.transformConversation = async ({ messages }) => {
			const before = JSON.stringify(messages);
			const next = (await runner.emitContext([...messages])).filter(isPlainMessage);
			// Returning an unchanged list would still replace the request, which collapses the system entries into one
			// leading message and changes the prompt-cache prefix; an unchanged result therefore stays undefined.
			return JSON.stringify(next) === before ? undefined : { messages: next };
		};
	}

	if (runner.hasHandlers("turn_end") || runner.hasHandlers("agent_before_settle")) {
		members.onBoundary = async (boundary) => {
			const baseEvent =
				boundary.kind === "settle"
					? ({ type: "agent_before_settle", outcome: "completed" } as const)
					: {
							type: "turn_end" as const,
							outcome: "completed" as const,
							message: boundary.assistant,
							toolResults: [] as ToolResultMessage[],
							turnIndex: 0,
							timestamp: Date.now(),
							messageEntryId: String(boundary.assistantEntry ?? ""),
							toolResultEntryIds: [],
						};
			const result = await runner.emitBoundary(baseEvent, async (_entries) => ({
				contextEntries: [],
				contextMessages: [boundary.assistant],
				llmMessages: [boundary.assistant],
				pendingMessages: [],
				canContinue: true,
			}));
			return result.continue ? { continue: true } : undefined;
		};
	}

	if (runner.hasHandlers("before_provider_request")) {
		members.beforeProviderRequest = async ({ payload, model }, _api, context) =>
			inProviderCall(scope, model, context.abortSignal, async () => {
				const next = await runner.emitBeforeProviderRequest(payload);
				return next === payload ? undefined : { payload: next };
			});
	}

	if (runner.hasHandlers("before_provider_headers")) {
		members.beforeProviderHeaders = async ({ headers, model }, _api, context) =>
			inProviderCall(scope, model, context.abortSignal, async () => {
				const next = await runner.emitBeforeProviderHeaders(headers);
				return next === headers ? undefined : { headers: next };
			});
	}

	if (runner.hasHandlers("after_provider_response")) {
		members.afterProviderResponse = async (response, _api, context) =>
			inProviderCall(scope, response.model, context.abortSignal, async () => {
				await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
			});
	}

	if (runner.hasHandlers("provider_stream_event")) {
		members.onProviderStreamEvent = async ({ data, model }, _api, context) =>
			inProviderCall(scope, model, context.abortSignal, async () => {
				await runner.emit({
					type: "provider_stream_event",
					provider: model.provider,
					api: model.api,
					model: model.id,
					data,
				});
			});
	}

	if (runner.hasHandlers("message_update")) {
		members.onStreamEvent = async ({ event, attempt }) => {
			const message = "partial" in event ? event.partial : "message" in event ? event.message : event.error;
			await runner.emit({ type: "message_update", message, assistantMessageEvent: event, attempt });
		};
	}

	if (runner.hasHandlers("message_end")) {
		members.rewriteMessage = async (message, _api, context) => {
			if (message.role !== "assistant") return undefined;
			// The message carries no model here, so `ctx.model` falls back to the agent's model.
			return inProviderCall(scope, undefined, context.abortSignal, async () => {
				const next = await runner.emitMessageEnd({ type: "message_end", message });
				if (next === undefined || next === message) return undefined;
				// The Harness requires a replacement of the same kind; a different role is an extension bug, reported here.
				if (next.role !== "assistant") {
					throw new Error(`message_end handlers must return an assistant message, got ${next.role}`);
				}
				return { message: next };
			});
		};
	}

	return members;
}

/**
 * The tool-event members: `tool_call` runs before a call's intent is recorded (`beforeTool`), and `tool_result` before
 * its result is committed (`afterTool`). Each exists only when a loaded extension handles its event.
 */
export function createToolHooks(runner: ExtensionRunner): Partial<ToolHooks> {
	const members: Partial<ToolHooks> = {};

	if (runner.hasHandlers("tool_call")) {
		members.beforeTool = async (call) => {
			const input: Record<string, unknown> = { ...call.arguments };
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolCallId: call.id,
				toolName: call.name,
				input,
			});
			if (result?.block === true) return { block: result.reason ?? `Blocked by an extension: ${call.name}` };
			// Handlers change the call by mutating `input`, as legacy does; the change replaces the arguments when it is JSON.
			if (JSON.stringify(input) === JSON.stringify(call.arguments) || !isJsonObject(input)) return undefined;
			return { arguments: input };
		};
	}

	if (runner.hasHandlers("tool_execution_update")) {
		members.onToolUpdate = async (update) => {
			await runner.emit({
				type: "tool_execution_update",
				toolCallId: update.call.id,
				toolName: update.call.name,
				args: update.call.arguments,
				partialResult: {
					...(update.output === undefined ? {} : { content: [{ type: "text", text: update.output }] }),
					...(update.details === undefined ? {} : { details: update.details }),
					...(update.diagnostics === undefined ? {} : { diagnostics: update.diagnostics }),
				},
				...(update.call.parent?.callId === undefined ? {} : { parentToolCallId: update.call.parent.callId }),
			});
		};
	}

	if (runner.hasHandlers("tool_result")) {
		members.afterTool = async (call, result) => {
			const changed = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: call.id,
				toolName: call.name,
				input: { ...call.arguments },
				content: result.output ?? [],
				details: result.details,
				isError: result.isError === true,
			});
			if (changed === undefined) return undefined;
			return {
				...result,
				...(changed.content === undefined ? {} : { output: changed.content }),
				...(changed.details === undefined || !isJsonValue(changed.details) ? {} : { details: changed.details }),
				...(changed.isError === undefined ? {} : { isError: changed.isError }),
				...(changed.structuredContent === undefined || !isJsonValue(changed.structuredContent)
					? {}
					: { structuredOutput: changed.structuredContent }),
			};
		};
	}

	return members;
}

/** Bridges the legacy compaction veto/custom-summary event to durable's first-decision hook. */
export function createCompactionHooks(runner: ExtensionRunner): Partial<CompactionHooks> {
	if (!runner.hasHandlers("session_before_compact")) return {};
	return {
		beforeCompact: async (compaction, _api, context) => {
			const preparation: CompactionPreparation = {
				firstKeptEntryId: String(compaction.firstKept),
				messagesToSummarize: [...compaction.messages],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 0,
				fileOps: createFileOps(),
				settings: DEFAULT_COMPACTION_SETTINGS,
			};
			const result = await runner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: [],
				reason: compaction.reason,
				willRetry: false,
				signal: context.abortSignal ?? new AbortController().signal,
			});
			if (result === undefined) return undefined;
			if (result.cancel) return { decline: true };
			if (!("compaction" in result) || result.compaction === undefined) return undefined;
			const summary = result.compaction;
			return {
				summary: summary.summary,
				...(summary.details !== undefined && isJsonValue(summary.details) ? { details: summary.details } : {}),
			};
		},
	};
}

/**
 * The durable extension that carries the members of both tasks. It has no hooks when no loaded extension handles a
 * provider or tool event, so such an installation adds nothing to either path.
 */
export function createHookAdapter(
	generation: Partial<GenerationHooks>,
	tools: Partial<ToolHooks>,
	compaction: Partial<CompactionHooks> = {},
): Extension {
	const hooks = [
		...(Object.keys(generation).length === 0 ? [] : [hook(GenerationTask, generation)]),
		...(Object.keys(tools).length === 0 ? [] : [hook(ToolTask, tools)]),
		...(Object.keys(compaction).length === 0 ? [] : [hook(CompactionTask, compaction)]),
	];
	return defineExtension({ name: "nyan.extension-host", hooks });
}
