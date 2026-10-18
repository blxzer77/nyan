import type { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Model } from "@ny4n/ai";
import {
	defineExtension,
	type Extension,
	type GenerationHooks,
	GenerationTask,
	hook,
	type ToolHooks,
	ToolTask,
} from "@ny4n/durable";
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
 * The generation-hook members that carry the Nyan handlers. A member exists only when a loaded extension handles its
 * event, so an installation without such handlers costs nothing on the request path: the hook members switch provider
 * callbacks on, see `HookRunner.has()`.
 *
 * Not bridged yet: `before_agent_start` (needs the run's prompt and system options), `turn_end` and `agent_before_settle`
 * (`onBoundary`), tool events, and `context`. Each is a named gap for task C, not a silent no-op.
 */
export function createProviderHooks(runner: ExtensionRunner, scope: ProviderCallScope): Partial<GenerationHooks> {
	const members: Partial<GenerationHooks> = {};

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

/**
 * The durable extension that carries the members of both tasks. It has no hooks when no loaded extension handles a
 * provider or tool event, so such an installation adds nothing to either path.
 */
export function createHookAdapter(generation: Partial<GenerationHooks>, tools: Partial<ToolHooks>): Extension {
	const hooks = [
		...(Object.keys(generation).length === 0 ? [] : [hook(GenerationTask, generation)]),
		...(Object.keys(tools).length === 0 ? [] : [hook(ToolTask, tools)]),
	];
	return defineExtension({ name: "nyan.extension-host", hooks });
}
