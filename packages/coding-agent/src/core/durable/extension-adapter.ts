import type { Api, Model } from "@ny4n/ai";
import { defineExtension, type Extension, type GenerationHooks, GenerationTask, hook } from "@ny4n/durable";
import type { ExtensionRunner } from "../extensions/runner.ts";

/**
 * The provider call in flight. Extension handlers read `ctx.model` and `ctx.signal` through the runner's context, and
 * the runner builds that context from these values at the start of each emit, so the host sets them just before it.
 */
export interface ProviderCallScope {
	model: Model<Api> | undefined;
	signal: AbortSignal | undefined;
}

/** Runs `run` with `scope` describing the call, and restores the previous values after it settles. */
async function inCall<T>(
	scope: ProviderCallScope,
	model: Model<Api> | undefined,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const previous = { model: scope.model, signal: scope.signal };
	scope.model = model;
	scope.signal = signal;
	try {
		return await run();
	} finally {
		scope.model = previous.model;
		scope.signal = previous.signal;
	}
}

/**
 * The durable extension that carries the Nyan handlers as generation-hook members. A member is registered only when a
 * loaded extension handles its event, so an installation without such handlers costs nothing on the request path (the
 * hook members switch provider callbacks on, see `HookRunner.has()`).
 *
 * Not bridged yet: `before_agent_start` (needs the run's prompt and system options), `turn_end` and `agent_before_settle`
 * (`onBoundary`), tool events, and `context`. Each of these is a named gap for task C, not a silent no-op.
 */
export function createHookAdapter(runner: ExtensionRunner, scope: ProviderCallScope): Extension {
	const members: Partial<GenerationHooks> = {};

	if (runner.hasHandlers("before_provider_request")) {
		members.beforeProviderRequest = async ({ payload, model }, _api, context) =>
			inCall(scope, model, context.abortSignal, async () => {
				const next = await runner.emitBeforeProviderRequest(payload);
				return next === payload ? undefined : { payload: next };
			});
	}

	if (runner.hasHandlers("before_provider_headers")) {
		members.beforeProviderHeaders = async ({ headers, model }, _api, context) =>
			inCall(scope, model, context.abortSignal, async () => {
				const next = await runner.emitBeforeProviderHeaders(headers);
				return next === headers ? undefined : { headers: next };
			});
	}

	if (runner.hasHandlers("after_provider_response")) {
		members.afterProviderResponse = async (response, _api, context) =>
			inCall(scope, response.model, context.abortSignal, async () => {
				await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
			});
	}

	if (runner.hasHandlers("provider_stream_event")) {
		members.onProviderStreamEvent = async ({ data, model }, _api, context) =>
			inCall(scope, model, context.abortSignal, async () => {
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
			// The message carries no model of its own here; the context falls back to the agent's model.
			return inCall(scope, undefined, context.abortSignal, async () => {
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

	return defineExtension({
		name: "nyan.extension-host",
		hooks: Object.keys(members).length === 0 ? [] : [hook(GenerationTask, members)],
	});
}
