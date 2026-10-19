import type { Api, Context, Model, ModelsSimpleStreamOptions } from "@ny4n/ai";
import type { ModelRuntime as DurableModelRuntime } from "@ny4n/ai/contracts";
import type { ModelRuntime as ProviderModelRuntime } from "../model-runtime.ts";

/**
 * What the durable host learns about a request before it is forwarded, which is the only place the request durable's
 * generation task actually sends can be observed: `streamSimple` is that request, and compaction summarization uses
 * `completeSimple` with `cacheRetention: "none"`.
 */
export interface DurableModelRuntimeHooks {
	readonly onSessionRequest?: (
		model: Model<Api>,
		context: Context,
		options: ModelsSimpleStreamOptions | undefined,
	) => void;
}

/**
 * Expose only the provider operations that durable generation is allowed to use.
 *
 * The coding-agent runtime also owns provider catalogs, credentials, OAuth, and
 * model composition. Those capabilities stay in the product shell; durable
 * receives this narrow port so its dependency cannot grow by structural typing.
 */
export function createDurableModelRuntime(
	runtime: ProviderModelRuntime,
	hooks: DurableModelRuntimeHooks = {},
): DurableModelRuntime {
	return {
		getModel: (provider, id) => runtime.getModel(provider, id),
		streamSimple: (model, context, options) => {
			hooks.onSessionRequest?.(model, context, options);
			return runtime.streamSimple(model, context, options);
		},
		completeSimple: (model, context, options) => runtime.completeSimple(model, context, options),
		fetchDeferred: (model, handle, options) => runtime.fetchDeferred(model, handle, options),
		cancelDeferred: (model, handle, options) => runtime.cancelDeferred(model, handle, options),
	};
}
