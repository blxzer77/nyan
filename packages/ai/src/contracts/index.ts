/**
 * Stable provider-neutral contracts used by the Agent runtime.
 *
 * Provider catalogs, OAuth, compatibility helpers, and API implementations are intentionally
 * not exported from this entry point. Keep this surface small: consumers that only need to
 * run an agent should not acquire the provider implementation graph.
 */

export type { Static, TSchema } from "typebox";

export type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	CacheRetention,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	JsonObject,
	JsonValue,
	Message,
	Model,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderResponse,
	RequestTransforms,
	SimpleStreamOptions,
	StopReason,
	SystemMessage,
	TextContent,
	ThinkingBudgets,
	Tool,
	ToolCall,
	ToolReference,
	ToolResultMessage,
	TranscriptContext,
	Transport,
	Usage,
	UserMessage,
} from "../types.ts";

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	RequestTransforms,
	SimpleStreamOptions,
} from "../types.ts";

/**
 * Provider-neutral model operations required by the durable Agent runtime.
 *
 * `Models` implements this shape, but the durable layer only depends on these
 * operations. Provider catalogs, credentials, OAuth, and provider mutation
 * stay behind the host's adapter and are not part of the durable contract.
 *
 * `streamSimple` may be given `RequestTransforms` (the `transformHeaders` of a durable hook). An implementer applies
 * them itself, as `Models` does, or hands the options on to a delegate that does; it must not pass them to a raw
 * provider adapter, which ignores them.
 */
export interface ModelRuntime {
	getModel(provider: string, id: string): Model<Api> | undefined;
	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions & RequestTransforms,
	): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
	fetchDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

export { AssistantMessageEventStream, createAssistantMessageEventStream, EventStream } from "../utils/event-stream.ts";
export { parseStreamingJson } from "../utils/json-parse.ts";
export type { ToolStateChanges } from "../utils/transcript.ts";
export {
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	toToolDeclaration,
} from "../utils/transcript.ts";
export { validateToolArguments } from "../utils/validation.ts";
