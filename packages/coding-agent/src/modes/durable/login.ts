import type { AuthEvent, AuthPrompt } from "@ny4n/ai";
import type { Component, SelectItem, TUI } from "@ny4n/tui";
import { getAuthPath } from "../../config.ts";
import { compareLoginProviders } from "../../core/auth-guidance.ts";
import type { Notice } from "../../core/durable/runtime.ts";
import { CredentialSynchronizationError, type ModelRuntime } from "../../core/model-runtime.ts";
import { isResolveOnlyApiKeyMethod } from "../../core/provider-composer.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { LoginDialogComponent } from "../interactive/components/login-dialog.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../interactive/components/oauth-selector.ts";

/** The terminal side of `/login` and `/logout`: the dialogs, the switches between them, and the notices. */
export interface DurableLoginUi {
	/** Show a component in place of the editor until `restore` is called. */
	present(component: Component, focus: Component): void;
	restore(): void;
	/** A filterable list; undefined when the user cancelled. */
	select(title: string, items: readonly SelectItem[]): Promise<string | undefined>;
	notify(message: string, type?: Notice["level"]): void;
}

export interface DurableLoginDeps {
	readonly settings: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	/** The terminal the dialogs draw on and their URLs open from. */
	readonly tui: TUI;
	readonly ui: DurableLoginUi;
}

/** The providers this build can log in to: an OAuth sign-in, or an API-key method that asks the user. */
function loginProviderOptions(runtime: ModelRuntime): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of runtime.getProviders()) {
		const authStatus = runtime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: runtime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		const subscription = provider.auth.oauth?.isSubscription === true;
		if (provider.auth.oauth !== undefined) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
				subscription,
			});
		}
		if (provider.auth.apiKey !== undefined && !isResolveOnlyApiKeyMethod(provider.auth.apiKey)) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
				subscription,
			});
		}
	}
	return options.sort(compareLoginProviders);
}

/** Ask which provider, and which of its methods, with the legacy selector over both. */
async function chooseProvider(
	deps: DurableLoginDeps,
	options: readonly AuthSelectorProvider[],
	search?: string,
): Promise<AuthSelectorProvider | undefined> {
	const chosen = await new Promise<string | undefined>((resolve) => {
		const selector = new OAuthSelectorComponent(
			"login",
			[...options],
			(providerId, authType) => {
				deps.ui.restore();
				resolve(`${providerId}\u0000${authType}`);
			},
			() => {
				deps.ui.restore();
				resolve(undefined);
			},
			search,
		);
		deps.ui.present(selector, selector);
	});
	if (chosen === undefined) return undefined;
	const [providerId, authType] = chosen.split("\u0000");
	return options.find((option) => option.id === providerId && option.authType === authType);
}

/** The provider a `/login <ref>` argument names, when it names exactly one method. */
function namedProviders(
	options: readonly AuthSelectorProvider[],
	ref: string,
): readonly AuthSelectorProvider[] | "several" | undefined {
	const wanted = ref.trim().toLowerCase();
	if (wanted.length === 0) return undefined;
	const matches = options.filter(
		(option) => option.id.toLowerCase() === wanted || option.name.toLowerCase() === wanted,
	);
	if (matches.length === 0) return undefined;
	const ids = new Set(matches.map((option) => option.id));
	return ids.size === 1 ? matches : "several";
}

/** A question the provider's login asks, answered through the dialog that is on screen. */
async function promptThrough(
	deps: DurableLoginDeps,
	dialog: LoginDialogComponent,
	prompt: AuthPrompt,
): Promise<string> {
	const answered = (() => {
		if (prompt.type === "manual_code") {
			return dialog.showManualInput(prompt.message, { allowEmpty: prompt.allowEmpty });
		}
		if (prompt.type === "select") {
			return deps.ui
				.select(
					prompt.message,
					prompt.options.map((option) => ({
						value: option.id,
						label: option.label,
						...(option.description === undefined ? {} : { description: option.description }),
					})),
				)
				.then((value) => {
					// The list replaced the dialog; put the provider's own screen back for what comes next.
					deps.ui.present(dialog, dialog);
					return value ?? "";
				});
		}
		return dialog.showPrompt(prompt.message, prompt.placeholder, { allowEmpty: prompt.allowEmpty });
	})();
	if (prompt.signal === undefined) return answered;
	const signal = prompt.signal;
	if (signal.aborted) throw new Error("Login cancelled");
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<string>((_resolve, reject) => {
		onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([answered, aborted]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

/** What the provider's login shows and asks while it waits: the same dialog methods legacy uses. */
function notifyDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") {
		dialog.showAuth(event.url, event.instructions);
	} else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("Waiting for authentication...");
	} else if (event.type === "info") {
		dialog.showInfo(event.message, event.links);
	} else {
		dialog.showProgress(event.message);
	}
}

/** Run the chosen provider's login, with its dialog on screen. */
async function authenticate(deps: DurableLoginDeps, option: AuthSelectorProvider): Promise<void> {
	const dialog = new LoginDialogComponent(deps.tui, option.id, () => {}, option.name);
	deps.ui.present(dialog, dialog);
	try {
		await deps.modelRuntime.login(
			option.id,
			option.authType,
			{
				signal: dialog.signal,
				prompt: (prompt) => promptThrough(deps, dialog, prompt),
				notify: (event) => notifyDialog(dialog, event),
			},
			{ getDeviceId: () => deps.settings.getOrCreateDeviceId() },
		);
	} finally {
		deps.ui.restore();
	}
}

/** A provider that reads credentials from its environment needs no login here; its dialog says so. */
async function showAmbient(deps: DurableLoginDeps, option: AuthSelectorProvider): Promise<void> {
	const dialog = new LoginDialogComponent(
		deps.tui,
		option.id,
		() => deps.ui.restore(),
		option.name,
		`${option.name} setup`,
	);
	dialog.showInfo(`${option.method?.name ?? "Authentication"} is configured outside nyan.`, [], true);
	deps.ui.present(dialog, dialog);
}

/**
 * `/login [provider]`: sign in to a provider and store the credential where nyan's auth file keeps it. The catalog of a
 * provider is refreshed afterwards, so `/model` lists the models the credential unlocks.
 */
export async function runLogin(deps: DurableLoginDeps, providerRef?: string): Promise<void> {
	const options = loginProviderOptions(deps.modelRuntime);
	if (options.length === 0) {
		deps.ui.notify("No login methods available.", "warning");
		return;
	}
	let option: AuthSelectorProvider | undefined;
	if (providerRef !== undefined && providerRef.trim().length > 0) {
		const named = namedProviders(options, providerRef);
		if (named === "several") option = await chooseProvider(deps, options, providerRef.trim());
		else if (named === undefined) {
			deps.ui.notify(`No provider matches "${providerRef.trim()}".`, "error");
			return;
		} else option = named[0];
	} else {
		option = await chooseProvider(deps, options);
	}
	if (option === undefined) {
		deps.ui.notify("Login cancelled");
		return;
	}
	if (option.authType === "api_key" && option.method?.login === undefined) {
		await showAmbient(deps, option);
		return;
	}

	const label = option.authType === "oauth" ? `Logged in to ${option.name}` : `Saved API key for ${option.name}`;
	try {
		await authenticate(deps, option);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof CredentialSynchronizationError) {
			deps.ui.notify(`${label}, but local model state could not be synchronized: ${message}`, "error");
		} else if (message === "Login cancelled") {
			deps.ui.notify("Login cancelled");
		} else {
			deps.ui.notify(`Failed to login to ${option.name}: ${message}`, "error");
		}
		return;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const result = await deps.modelRuntime.refresh({ providers: [option.id], signal: controller.signal });
		if (result.aborted) {
			deps.ui.notify(`${label}, but its model catalog refresh timed out; using cached models.`, "warning");
		} else if (result.errors.size > 0) {
			deps.ui.notify(`${label}, but its model catalog could not be refreshed; using cached models.`, "warning");
		}
	} catch (error) {
		deps.ui.notify(
			`${label}, but its model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	} finally {
		clearTimeout(timeout);
	}
	deps.ui.notify(`${label}. Credentials saved to ${getAuthPath()}. Use /model to select a model.`);
}

/** `/logout`: remove the credentials nyan stored, leaving environment variables and models.json alone. */
export async function runLogout(deps: DurableLoginDeps): Promise<void> {
	let stored: Awaited<ReturnType<ModelRuntime["listCredentials"]>>;
	try {
		stored = await deps.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) });
	} catch (error) {
		deps.ui.notify(
			`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	if (stored.length === 0) {
		deps.ui.notify(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		);
		return;
	}
	const providers: AuthSelectorProvider[] = stored
		.map(({ providerId, type }) => {
			const provider = deps.modelRuntime.getProvider(providerId);
			return {
				id: providerId,
				name: provider?.name ?? providerId,
				authType: type,
				status: { type, source: "stored credential" },
				subscription: provider?.auth.oauth?.isSubscription === true,
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));

	const chosen = await new Promise<AuthSelectorProvider | undefined>((resolve) => {
		const selector = new OAuthSelectorComponent(
			"logout",
			providers,
			(providerId) => {
				deps.ui.restore();
				resolve(providers.find((provider) => provider.id === providerId));
			},
			() => {
				deps.ui.restore();
				resolve(undefined);
			},
		);
		deps.ui.present(selector, selector);
	});
	if (chosen === undefined) {
		deps.ui.notify("Logout cancelled");
		return;
	}
	try {
		await deps.modelRuntime.logout(chosen.id, { signal: AbortSignal.timeout(15_000) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.ui.notify(
			error instanceof CredentialSynchronizationError
				? `Credentials removed for ${chosen.name}, but local model state could not be synchronized: ${message}`
				: `Logout failed: ${message}`,
			"error",
		);
		return;
	}
	deps.ui.notify(
		chosen.authType === "oauth"
			? `Logged out of ${chosen.name}`
			: `Removed stored API key for ${chosen.name}. Environment variables and models.json config are unchanged.`,
	);
}
