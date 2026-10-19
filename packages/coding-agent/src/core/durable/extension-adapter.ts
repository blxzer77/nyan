import type { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@ny4n/agent-core";
import type { Api, Message, Model, UserMessage } from "@ny4n/ai";
import {
	type BoundaryEntry,
	type CompactionHooks,
	CompactionTask,
	defineExtension,
	type EntryId,
	type Extension,
	type GenerationHooks,
	GenerationTask,
	hook,
	type ToolHooks,
	ToolTask,
} from "@ny4n/durable";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "../compaction/compaction.ts";
import { createFileOps } from "../compaction/utils.ts";
import type { ExtensionRunner } from "../extensions/runner.ts";
import type { ContextEditEntryDraft, SessionBoundaryDraft } from "../extensions/types.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { isJsonObject, isJsonValue } from "./extension-tools.ts";

/**
 * The provider call that some async work belongs to: the model and abort signal the extension context reports as
 * `ctx.model` and `ctx.signal`. A hook handler that calls an extension runs in this scope with the hook context's
 * `abortSignal`, so `ctx.signal` is the signal of the run the handler belongs to (legacy passes `agent.signal` there);
 * the model stays unset so `ctx.model` falls back to the agent's model.
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

type BoundarySessionReader = Pick<ReadonlySessionManager, "getEntry">;

function getSessionEntry(manager: BoundarySessionReader | undefined, id: string): SessionEntry | undefined {
	try {
		return manager?.getEntry(id);
	} catch {
		return undefined;
	}
}

function getSessionProjection(
	manager: ReadonlySessionManager | undefined,
): ReturnType<ReadonlySessionManager["buildSessionProjection"]> | undefined {
	try {
		return manager?.buildSessionProjection();
	} catch {
		return undefined;
	}
}

function durableEntryId(value: string): EntryId | undefined {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? (number as EntryId) : undefined;
}

export function durableBoundaryEntriesToLegacy(
	entries: readonly BoundaryEntry[],
	manager: BoundarySessionReader | undefined,
	report: (message: string) => void,
): SessionBoundaryDraft[] | undefined {
	const result: SessionBoundaryDraft[] = [];
	for (const entry of entries) {
		if (entry.edits !== undefined) {
			for (const edit of entry.edits) {
				const target = getSessionEntry(manager, String(edit.target));
				if (
					target === undefined ||
					(target.type !== "message" && target.type !== "custom_message") ||
					(target.type === "message" && target.message.role !== "user")
				) {
					report(`context_edit target ${String(edit.target)} is not a user or custom-message entry`);
					return undefined;
				}
				let replacement: ContextEditEntryDraft["replacement"] = null;
				if (edit.action === "replace") {
					const message = edit.messages?.[0];
					if (edit.messages === undefined || edit.messages.length !== 1 || message?.role !== "user") {
						report(`context_edit target ${String(edit.target)} has a replacement that is not one user message`);
						return undefined;
					}
					const content = message.content;
					const validContent =
						typeof content === "string" ||
						(Array.isArray(content) && content.every((part) => part.type === "text" || part.type === "image"));
					if (!validContent) {
						report(`context_edit target ${String(edit.target)} has non-user replacement content`);
						return undefined;
					}
					replacement = { content };
				}
				result.push({ type: "context_edit", targetId: String(edit.target), replacement });
			}
		}
		if (entry.model !== undefined) {
			const message = entry.model[0];
			if (entry.model.length !== 1 || message?.role !== "user") {
				report(`boundary kind ${entry.kind} has a model that is not one user message`);
				return undefined;
			}
			if (entry.kind === "custom_message") {
				const data = isJsonObject(entry.data) ? entry.data : {};
				const customType = typeof data.customType === "string" ? data.customType : "durable.custom_message";
				const display = typeof data.display === "boolean" ? data.display : true;
				result.push({
					type: "custom_message",
					customType,
					content: message.content,
					display,
					...(data.details === undefined ? {} : { details: data.details }),
				});
			} else {
				result.push({ type: "custom_message", customType: entry.kind, content: message.content, display: true });
			}
		} else if (entry.edits !== undefined) {
		} else if (entry.kind === "compaction") {
			report("compaction boundary drafts are owned by the durable compaction task");
			return undefined;
		} else {
			result.push({
				type: "custom",
				customType: entry.kind,
				...(entry.data === undefined ? {} : { data: entry.data }),
			});
		}
	}
	return result;
}

/**
 * `timestamp` stamps the user messages the drafts create. The caller passes a value taken from the boundary (its
 * assistant message), so the mapping is a pure function of its input: a handler that runs again after a crash before the
 * boundary commit, on the same input, proposes the same entries.
 */
export function legacyBoundaryEntriesToDurable(
	entries: readonly SessionBoundaryDraft[],
	manager: BoundarySessionReader | undefined,
	report: (message: string) => void,
	timestamp: number,
): BoundaryEntry[] | undefined {
	const result: BoundaryEntry[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "custom":
				if (entry.customType.length === 0 || entry.customType.startsWith("nyan.")) {
					report(`custom boundary kind must be non-empty and not start with nyan.: ${entry.customType}`);
					return undefined;
				}
				if (entry.data !== undefined && !isJsonValue(entry.data)) {
					report(`custom boundary ${entry.customType} has non-JSON data`);
					return undefined;
				}
				result.push({ kind: entry.customType, ...(entry.data === undefined ? {} : { data: entry.data }) });
				break;
			case "custom_message": {
				if (entry.customType.length === 0 || entry.customType.startsWith("nyan.")) {
					report(`custom message kind must be non-empty and not start with nyan.: ${entry.customType}`);
					return undefined;
				}
				const data: Record<string, unknown> = { customType: entry.customType, display: entry.display };
				if (entry.details !== undefined) data.details = entry.details;
				if (!isJsonValue(data)) {
					report(`custom message ${entry.customType} has non-JSON details`);
					return undefined;
				}
				result.push({
					kind: "custom_message",
					model: [{ role: "user", content: entry.content, timestamp }],
					data,
				});
				break;
			}
			case "context_edit": {
				const target = durableEntryId(entry.targetId);
				if (target === undefined) {
					report(`context_edit target ${entry.targetId} is not a durable entry id`);
					return undefined;
				}
				const source = getSessionEntry(manager, entry.targetId);
				if (
					source === undefined ||
					(source.type !== "message" && source.type !== "custom_message") ||
					(source.type === "message" && source.message.role !== "user")
				) {
					report(`context_edit target ${entry.targetId} is not a user or custom-message entry`);
					return undefined;
				}
				result.push({
					kind: "context_edit",
					edits: [
						entry.replacement === null
							? { target, action: "omit" }
							: {
									target,
									action: "replace",
									messages: [
										{
											role: "user",
											content: entry.replacement.content as UserMessage["content"],
											timestamp,
										},
									],
								},
					],
				});
				break;
			}
			case "compaction":
				report("compaction boundary drafts are refused; durable compaction owns the commit");
				return undefined;
		}
	}
	return result;
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
	sessionManager?: ReadonlySessionManager,
	reportBoundaryError?: (message: string) => void,
	turnCounter: { value: number } = { value: 0 },
): Partial<GenerationHooks> {
	const members: Partial<GenerationHooks> = {};

	if (
		runner.hasHandlers("before_agent_start") ||
		runner.hasHandlers("context_with_system") ||
		getBeforeRequestEffects !== undefined
	) {
		members.beforeRequest = async ({ messages }, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
				const effects = getBeforeRequestEffects?.();
				let next = [...messages];
				if (effects !== undefined) {
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
				}
				// Phase two of the request transform: `context` ran as `transformConversation`, which never sees system
				// messages; these handlers see the full request and their output is the request, as legacy `emitContext` does.
				if (runner.hasHandlers("context_with_system")) {
					next = (await runner.emitContextWithSystem(next)).filter(isPlainMessage);
				}
				return JSON.stringify(next) === JSON.stringify(messages) ? undefined : { messages: next };
			});
	}

	if (runner.hasHandlers("context")) {
		members.transformConversation = async ({ messages }, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
				const before = JSON.stringify(messages);
				const next = (await runner.emitConversationContext([...messages])).filter(isPlainMessage);
				// Returning an unchanged list would still replace the request, which collapses the system entries into one
				// leading message and changes the prompt-cache prefix; an unchanged result therefore stays undefined.
				return JSON.stringify(next) === before ? undefined : { messages: next };
			});
	}

	if (runner.hasHandlers("turn_end") || runner.hasHandlers("agent_before_settle")) {
		members.onBoundary = async (boundary, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
				const eventType = boundary.kind === "settle" ? "agent_before_settle" : "turn_end";
				const entries = durableBoundaryEntriesToLegacy(boundary.entries, sessionManager, (message) =>
					reportBoundaryError?.(`${eventType}: ${message}`),
				);
				if (entries === undefined) return boundary.continue ? { continue: true } : undefined;
				const toolResults = boundary.toolResults.flatMap((id) => {
					const entry = getSessionEntry(sessionManager, String(id));
					return entry?.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [];
				});
				const baseEvent =
					boundary.kind === "settle"
						? ({
								type: "agent_before_settle",
								outcome: "completed",
								entries,
								continue: boundary.continue,
							} as const)
						: {
								type: "turn_end" as const,
								outcome: "completed" as const,
								message: boundary.assistant,
								toolResults,
								turnIndex: turnCounter.value++,
								timestamp: Date.now(),
								messageEntryId: String(boundary.assistantEntry ?? ""),
								toolResultEntryIds: boundary.toolResults.map(String),
								entries,
								continue: boundary.continue,
							};
				const result = await runner.emitBoundary(baseEvent, async (_drafts) => {
					const projection = getSessionProjection(sessionManager);
					return {
						contextEntries: projection?.entries ?? [],
						contextMessages: projection?.messages ?? [boundary.assistant],
						llmMessages: (projection?.messages ?? [boundary.assistant]).filter(isPlainMessage),
						pendingMessages: [],
						canContinue: true,
					};
				});
				const durableEntries = legacyBoundaryEntriesToDurable(
					result.entries,
					sessionManager,
					(message) => reportBoundaryError?.(`${eventType}: ${message}`),
					boundary.assistant.timestamp,
				);
				if (durableEntries === undefined) return boundary.continue ? { continue: true } : undefined;
				return {
					...(durableEntries.length === 0 ? {} : { entries: durableEntries }),
					...(result.continue ? { continue: true } : {}),
				};
			});
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
		members.onStreamEvent = async ({ event, attempt }, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
				const message = "partial" in event ? event.partial : "message" in event ? event.message : event.error;
				await runner.emit({ type: "message_update", message, assistantMessageEvent: event, attempt });
			});
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
export function createToolHooks(runner: ExtensionRunner, scope: ProviderCallScope): Partial<ToolHooks> {
	const members: Partial<ToolHooks> = {};

	if (runner.hasHandlers("tool_call")) {
		members.beforeTool = async (call, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
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
			});
	}

	if (runner.hasHandlers("tool_execution_update")) {
		members.onToolUpdate = async (update, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
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
			});
	}

	if (runner.hasHandlers("tool_result")) {
		members.afterTool = async (call, result, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
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
			});
	}

	return members;
}

/** Bridges the legacy compaction veto/custom-summary event to durable's first-decision hook. */
export function createCompactionHooks(
	runner: ExtensionRunner,
	scope: ProviderCallScope,
	reportBoundaryError?: (message: string) => void,
	getModel?: () => Model<Api> | undefined,
): Partial<CompactionHooks> {
	if (!runner.hasHandlers("session_before_compact")) return {};
	return {
		beforeCompact: async (compaction, _api, context) =>
			inProviderCall(scope, undefined, context.abortSignal, async () => {
				const preparation: CompactionPreparation = {
					firstKeptEntryId: String(compaction.firstKept),
					messagesToSummarize: [...compaction.messages],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: compaction.messages.reduce((total, message) => total + estimateTokens(message), 0),
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
				const proposedFirstKept =
					typeof summary.firstKeptEntryId === "string" ? durableEntryId(summary.firstKeptEntryId) : undefined;
				const acceptsFirstKept =
					summary.firstKeptEntryId === String(compaction.firstKept) && proposedFirstKept !== undefined;
				if (!acceptsFirstKept) {
					reportBoundaryError?.(
						`session_before_compact proposed firstKeptEntryId ${summary.firstKeptEntryId}; durable cut ${String(compaction.firstKept)} remains`,
					);
				}
				if (summary.details !== undefined && !isJsonValue(summary.details)) {
					reportBoundaryError?.("session_before_compact returned non-JSON details; details were refused");
				}
				const model = getModel?.();
				if (summary.usage !== undefined && (model === undefined || !isJsonValue(summary.usage))) {
					reportBoundaryError?.(
						"session_before_compact returned usage that cannot be attributed to a durable model",
					);
				}
				return {
					summary: summary.summary,
					...(acceptsFirstKept ? { firstKept: proposedFirstKept } : {}),
					...(summary.details !== undefined && isJsonValue(summary.details) ? { details: summary.details } : {}),
					...(summary.usage !== undefined && model !== undefined && isJsonValue(summary.usage)
						? { usage: { model: { provider: model.provider, modelId: model.id }, usage: summary.usage } }
						: {}),
				};
			}),
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
