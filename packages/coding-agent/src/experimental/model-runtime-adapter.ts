import type { ModelRuntime as DurableModelRuntime } from "@nyan/ai/contracts";
import type { ModelRuntime as ProviderModelRuntime } from "../core/model-runtime.ts";

/**
 * Expose only the provider operations that durable generation is allowed to use.
 *
 * The coding-agent runtime also owns provider catalogs, credentials, OAuth, and
 * model composition. Those capabilities stay in the product shell; durable
 * receives this narrow port so its dependency cannot grow by structural typing.
 */
export function createDurableModelRuntime(runtime: ProviderModelRuntime): DurableModelRuntime {
	return {
		getModel: (provider, id) => runtime.getModel(provider, id),
		streamSimple: (model, context, options) => runtime.streamSimple(model, context, options),
		completeSimple: (model, context, options) => runtime.completeSimple(model, context, options),
		fetchDeferred: (model, handle, options) => runtime.fetchDeferred(model, handle, options),
		cancelDeferred: (model, handle, options) => runtime.cancelDeferred(model, handle, options),
	};
}
