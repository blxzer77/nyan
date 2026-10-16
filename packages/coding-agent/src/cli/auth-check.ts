import type { CredentialStore } from "@ny4n/ai";
import { getAuthCredential } from "../core/auth-credential.ts";
import { createEventBus } from "../core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { InlineExtension } from "../core/extensions/types.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, validateAuthCommandArgs } from "./auth-command.ts";

export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
export type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_not_available"
	| "invalid_state";

export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	reason?: AuthCheckReason;
	authType?: "api_key" | "oauth";
}

export async function checkProviderAuth(
	args: Args,
	modelRuntime: ModelRuntime,
	options: { refresh: boolean } = { refresh: false },
): Promise<AuthCheckResult> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "check");
	let provider = cliProvider;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		provider = resolved.model.provider;
	}
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	if (modelRuntime.getError()) {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
	if (!modelRuntime.getProvider(provider)) {
		return { status: "not_ready", provider, reason: "provider_not_found" };
	}
	try {
		const auth = await modelRuntime.checkAuth(provider);
		if (!auth) return { status: "not_ready", provider, reason: "credentials_not_configured" };
		if (options.refresh && !(await modelRuntime.getAuth(provider))) {
			return { status: "not_ready", provider, reason: "credentials_not_configured" };
		}
		return { status: "ready", provider, authType: auth.type };
	} catch {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
}

export async function getProviderCredential(
	providerId: string,
	modelRuntime: ModelRuntime,
	credentials: CredentialStore,
	options: { refresh: boolean },
): Promise<string | undefined> {
	const credential = await credentials.read(providerId);
	if (!options.refresh && credential?.type === "oauth") return credential.access;
	return getAuthCredential(await modelRuntime.getAuth(providerId));
}

export async function registerExtensionProviders(
	runtime: ModelRuntime,
	extensionFactories?: InlineExtension[],
): Promise<void> {
	if (!extensionFactories || extensionFactories.length === 0) return;
	const extRuntime = createExtensionRuntime();
	for (const factory of extensionFactories) {
		const fn = typeof factory === "function" ? factory : factory.factory;
		if (fn) {
			await loadExtensionFromFactory(
				fn,
				process.cwd(),
				createEventBus(),
				extRuntime,
				typeof factory === "object" ? `builtin:${factory.name}` : "<inline>",
			);
		}
	}
	for (const { name, config } of extRuntime.pendingProviderRegistrations) {
		runtime.registerProvider(name, config);
	}
	for (const { provider } of extRuntime.pendingNativeProviderRegistrations) {
		runtime.registerNativeProvider(provider);
	}
}

export async function createAuthCheckModelRuntime(
	credentials: CredentialStore,
	extensionFactories?: InlineExtension[],
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await registerExtensionProviders(runtime, extensionFactories);
	return runtime;
}
