/**
 * Catalog controller and provider registration.
 *
 * Every catalog model is registered as `openai-responses` against the proxy's
 * `{root}/backend-api/codex` endpoint, so CLIProxyAPI serves them over HTTP/SSE
 * and authenticates upstream with its own Codex OAuth credential. The catalog's
 * `prefer_websockets` flag selects the upstream transport inside the proxy and
 * does not change the client API.
 *
 * The catalog is refreshed through nyan's `refreshModels` hook, which is generation
 * checked and can be re-run from `/cpa-refresh`.
 */

import type { RefreshModelsContext } from "@ny4n/ai";
import { streamSimple as nyanStreamSimple } from "@ny4n/ai/compat";
import { APP_NAME } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "../../core/extensions/types.ts";
import { loadCatalogCache, saveCatalogCache } from "./cache.ts";
import {
	CatalogHttpError,
	type CatalogModel,
	type ChatModelConfig,
	type CpaModel,
	fetchCatalog,
	mapCatalog,
	reconcileCatalog,
} from "./catalog.ts";
import {
	apiKeySource,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	defaultBaseUrlInput,
	firstNonEmpty,
	hasStoredLogin,
	isConfiguredDefaultModel,
	loadConfigSafe,
	loadConfiguredDefault,
	overridesPath,
	resolveCatalogMinRefreshMs,
	resolveCodexWsApiKey,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
	saveConfig,
} from "./config.ts";
import { errorMessage, isStaleContextError, log } from "./log.ts";
import { type CompiledOverrides, loadOverrides } from "./overrides.ts";
import {
	buildCostCatalog,
	type CostCatalog,
	emptyCostCatalog,
	fetchModelsDevCatalog,
	isModelsDevCacheFresh,
	readModelsDevCache,
} from "./pricing.ts";

/** The baseUrl is recovered from the OAuth refresh payload after a restart. */
export function encodeCredentialMeta(baseUrl: string): string {
	return JSON.stringify({ baseUrl });
}

export function decodeCredentialMeta(refresh: string | undefined): string | undefined {
	if (!refresh?.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(refresh) as { baseUrl?: unknown };
		return typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
	} catch {
		return undefined;
	}
}

export interface CatalogSnapshot {
	models: CatalogModel[];
	fetchedAt?: number;
	fromCache: boolean;
	error?: string;
}

/** How eagerly a refresh resolves the models.dev pricing document. */
export type PricingMode = "await" | "background";

export interface CatalogControllerOptions {
	/**
	 * Called after a background pricing fetch repriced the in-memory catalog, so the
	 * owner can re-register the provider with the updated costs.
	 */
	onCatalogUpdated?: () => void;
}

/** Options of one catalog refresh. Presence of `verification` is what makes a refresh a login verification. */
interface CatalogRefreshOptions {
	allowNetwork: boolean;
	force?: boolean;
	signal?: AbortSignal;
	pricing?: PricingMode;
	/** A login's verification: fetch with this key at this base URL, never with the ones the connection resolves. */
	verification?: { readonly apiKey: string; readonly baseUrlInput: string };
}

export class CatalogController {
	private models: CatalogModel[] = [];
	private fetchedAt: number | undefined;
	private lastError: string | undefined;
	private lastSource: "remote" | "cache" | "none" = "none";
	private costCatalog: CostCatalog = emptyCostCatalog();
	private costCatalogLoadedAt = 0;
	private costCatalogFetch: Promise<void> | undefined;
	private notices: string[] = [];
	private inFlight: Promise<void> | undefined;
	private inFlightVerifying = false;
	private overrides: CompiledOverrides | undefined;
	/** The raw entries of the last successful fetch, for repricing without a refetch. */
	private lastEntries: CpaModel[] | undefined;
	private lastModelsUrl: string | undefined;
	private lastFailure: CatalogFailure | undefined;

	private readonly agentDir: string;
	private readonly providerId: string;
	private readonly options: CatalogControllerOptions;

	constructor(agentDir: string, providerId: string, options: CatalogControllerOptions = {}) {
		this.agentDir = agentDir;
		this.providerId = providerId;
		this.options = options;
	}

	getSnapshot(): CatalogSnapshot {
		return {
			models: this.models,
			fetchedAt: this.fetchedAt,
			fromCache: this.lastSource === "cache",
			error: this.lastError,
		};
	}

	getModels(): CatalogModel[] {
		return this.models;
	}

	getModelsById(): Map<string, CatalogModel> {
		return new Map(this.models.map((model) => [model.meta.id, model]));
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	/** Why the last fetch failed. A refresh that does not fetch (no credential, cache only, throttled) clears it; see `getLastError` for those. */
	getLastFailure(): CatalogFailure | undefined {
		return this.lastFailure;
	}

	getLastSource(): "remote" | "cache" | "none" {
		return this.lastSource;
	}

	getFetchedAt(): number | undefined {
		return this.fetchedAt;
	}

	getOverrides(): CompiledOverrides {
		return this.overrides ?? loadOverrides(this.agentDir);
	}

	getCostCatalog(): CostCatalog {
		return this.costCatalog;
	}

	/** Model ids the catalog advertises a priority service tier for. */
	fastModelIds(): string[] {
		return this.models.filter((model) => model.meta.fast).map((model) => model.meta.id);
	}

	/** Notices produced by the last refresh; drained so each is shown once. */
	takeNotices(): string[] {
		const pending = this.notices;
		this.notices = [];
		return pending;
	}

	findModel(id: string): CatalogModel | undefined {
		const normalized = id.trim().toLowerCase();
		return this.models.find((model) => model.meta.id.toLowerCase() === normalized);
	}

	configs(): ChatModelConfig[] {
		return this.models.filter((model) => model.meta.listing !== "hidden").map((model) => model.config);
	}

	/**
	 * Resolve the models.dev pricing document.
	 *
	 * A fresh on-disk cache is applied synchronously, so a warm start never waits on
	 * the network. `background` leaves only the fetch off the critical path: the
	 * models are registered with the cached (or no) rates and repriced when the
	 * document lands. `await` blocks, for user-initiated refreshes where the listing
	 * should show real prices immediately.
	 */
	private async ensureCostCatalog(pricingEnabled: boolean, mode: PricingMode, signal?: AbortSignal): Promise<void> {
		if (!pricingEnabled) {
			this.costCatalog = emptyCostCatalog();
			this.costCatalogLoadedAt = Date.now();
			return;
		}
		if (this.isCostCatalogLoaded()) {
			return;
		}
		const cached = readModelsDevCache(this.agentDir);
		if (cached) {
			this.applyCostCatalog(cached.providers);
			if (isModelsDevCacheFresh(cached.timestamp)) {
				return;
			}
		}
		if (mode === "background") {
			void this.refreshCostCatalogInBackground(signal);
			return;
		}
		try {
			const snapshot = await fetchModelsDevCatalog(this.agentDir, signal ? { signal } : {});
			if (snapshot) {
				this.applyCostCatalog(snapshot.providers);
			}
		} catch (error) {
			log.debug("cost catalog unavailable", errorMessage(error));
		}
	}

	/** models.dev is a large document; re-read it at most once per process per 5 minutes. */
	private isCostCatalogLoaded(): boolean {
		return Date.now() - this.costCatalogLoadedAt < 5 * 60 * 1000 && this.costCatalog.exact.size > 0;
	}

	private applyCostCatalog(providers: Record<string, unknown>): void {
		this.costCatalog = buildCostCatalog(providers);
		this.costCatalogLoadedAt = Date.now();
	}

	/**
	 * Fetch pricing off the critical path, then reprice the catalog already fetched.
	 * Deduplicated: concurrent refreshes share one fetch.
	 */
	private async refreshCostCatalogInBackground(signal?: AbortSignal): Promise<void> {
		if (this.costCatalogFetch) {
			await this.costCatalogFetch;
			return;
		}
		this.costCatalogFetch = (async () => {
			try {
				const snapshot = await fetchModelsDevCatalog(this.agentDir, signal ? { signal } : {});
				if (!snapshot) {
					return;
				}
				this.applyCostCatalog(snapshot.providers);
				this.reapplyEntries();
				log.debug("pricing refreshed in the background");
				this.options.onCatalogUpdated?.();
			} catch (error) {
				log.debug("background cost catalog refresh failed", errorMessage(error));
			} finally {
				this.costCatalogFetch = undefined;
			}
		})();
		await this.costCatalogFetch;
	}

	/** Recompute the in-memory catalog from the last fetch with the current pricing. */
	private reapplyEntries(): void {
		if (!this.lastEntries || !this.lastModelsUrl) {
			return;
		}
		const overrides = this.overrides ?? loadOverrides(this.agentDir);
		const now = Date.now();
		const fresh = mapCatalog(this.lastEntries, { overrides, costCatalog: this.costCatalog, now });
		const final = reconcileCatalog(fresh, this.models, overrides, now, this.fetchedAt ?? now);
		this.applyCatalog(final.models, "remote", now);
		saveCatalogCache(this.agentDir, this.lastModelsUrl, this.models);
	}

	private applyCatalog(models: CatalogModel[], source: "remote" | "cache", fetchedAt: number): void {
		// Every catalog model is served by this provider. Models the catalog marks
		// `prefer_websockets` are kept here too: the flag picks the upstream
		// transport inside CLIProxyAPI and says nothing about which client provider
		// should own the model, so dropping them only made them unreachable.
		this.models = models;
		this.fetchedAt = fetchedAt;
		this.lastSource = source;
	}

	/**
	 * The models known before this fetch: in-memory state when present, otherwise the
	 * on-disk cache. Seeding from the cache is what makes a pin survive a restart,
	 * since a model missing from the first fetch of a process has no other source.
	 */
	private knownModels(modelsUrl: string): KnownModels {
		if (this.models.length > 0) {
			return {
				models: this.models,
				fetchedAt: this.fetchedAt,
				source: this.lastSource === "none" ? "remote" : this.lastSource,
			};
		}
		const cached = loadCatalogCache(this.agentDir, modelsUrl);
		if (cached) {
			return { models: cached.models, fetchedAt: cached.fetchedAt, source: "cache" };
		}
		return { models: [], source: "none" };
	}

	private reportDroppedModels(dropped: string[], retained: CatalogModel[]): void {
		const unlistedInUse = retained.filter((model) => model.meta.listing === "unlisted").map((model) => model.meta.id);
		if (unlistedInUse.length > 0) {
			log.info(
				`${unlistedInUse.length} model(s) missing from the latest catalog, retained for the grace period`,
				unlistedInUse.slice(0, 8).join(", "),
			);
		}
		if (dropped.length === 0) {
			return;
		}

		// Only warn when a dropped model is actively in use; a quiet catalog change
		// should not produce a notification on every startup.
		const configured = loadConfiguredDefault(this.agentDir);
		const inUse = dropped.filter((id) => isConfiguredDefaultModel(configured, id, this.providerId));
		if (inUse.length === 0) {
			log.info(`dropped ${dropped.length} model(s) no longer in the catalog`, dropped.slice(0, 8).join(", "));
			return;
		}
		const list = inUse.slice(0, 3).join(", ");
		this.notices.push(
			`Model ${list} was removed from the CLIProxyAPI catalog. Pin it in ${overridesPath(this.agentDir, loadConfigSafe(this.agentDir).config)} to keep it.`,
		);
	}

	/**
	 * A model that appeared in the catalog is worth one notice: the operator may have
	 * just enabled a route the user wants. The first fetch of a process is not a delta,
	 * so only changes against a known catalog are reported.
	 */
	private reportAddedModels(previous: CatalogModel[], models: CatalogModel[]): void {
		if (previous.length === 0) {
			return;
		}
		const knownIds = new Set(previous.map((model) => model.meta.id));
		const added = models.filter((model) => !knownIds.has(model.meta.id)).map((model) => model.meta.id);
		if (added.length === 0) {
			return;
		}
		const shown = added.slice(0, 8);
		log.info(`${added.length} new model(s) in the catalog`, shown.join(", "));
		this.notices.push(
			`${added.length} new model(s) available from CLIProxyAPI: ${shown.join(", ")}${added.length > shown.length ? ", ..." : ""}`,
		);
	}

	/**
	 * Fetch the catalog and update in-memory state.
	 *
	 * An ordinary refresh keeps the previously known models when the fetch fails, so the picker does not empty out
	 * because the proxy hiccuped, and it throws only for a settings file it cannot read. An unusable base URL is recorded as a failure, like a failed
	 * fetch. A verification never
	 * rejects: its failure is returned as `verificationFailure`, which is the answer the login reports.
	 */
	async refresh(options: CatalogRefreshOptions): Promise<CatalogSnapshot & { verificationFailure?: CatalogFailure }> {
		// An ordinary refresh may share an ordinary refresh already in flight, as it did before login verification. A
		// verification never shares a result: it waits for whatever is in flight and then fetches with its own key. The
		// throttle in `shouldFetch` still lets concurrent ordinary callers share one request.
		const verifying = options.verification !== undefined;
		if (this.inFlight && !verifying && !this.inFlightVerifying) {
			await this.inFlight;
			return this.getSnapshot();
		}
		// The verification's own outcome, captured inside its task: the shared `lastFailure` is only read for display.
		let verificationFailure: CatalogFailure | undefined;
		const previous = this.inFlight;
		const task: Promise<void> = (async () => {
			await previous?.catch(() => {});
			if (!verifying) {
				await this.runRefresh(options, {});
				return;
			}
			const outcome: { failure?: CatalogFailure } = {};
			try {
				await this.runRefresh(options, outcome);
			} catch (error) {
				this.lastError = errorMessage(error);
				this.lastFailure = classifyFailure(error);
				outcome.failure = this.lastFailure;
			}
			verificationFailure = outcome.failure;
		})();
		this.inFlight = task;
		this.inFlightVerifying = verifying;
		try {
			await task;
		} finally {
			if (this.inFlight === task) {
				this.inFlight = undefined;
				this.inFlightVerifying = false;
			}
		}
		return { ...this.getSnapshot(), ...(verifying ? { verificationFailure } : {}) };
	}

	private async runRefresh(options: CatalogRefreshOptions, outcome: { failure?: CatalogFailure }): Promise<void> {
		// A verification at another base URL must not change what the session reports about its own catalog.
		if (options.verification === undefined) this.lastFailure = undefined;
		const overrides = loadOverrides(this.agentDir);
		this.overrides = overrides;

		const identity = resolveIdentity(this.agentDir);
		let connection: ReturnType<typeof resolveConnectionForRefresh>;
		try {
			connection = resolveConnectionForRefresh(this.agentDir, identity.providerId, options.verification);
		} catch (error) {
			// A base URL that does not parse leaves nothing to fetch from. It is recorded like a failed fetch, not thrown: the
			// login's own sync would otherwise fail a login whose key was just verified at the URL it entered.
			const message = `CLIProxyAPI base URL is not valid (${errorMessage(error)}). Check CLIPROXYAPI_BASE_URL, cliproxyapi.json, and the stored login.`;
			// A verification's answer is about its own base URL, so it goes to the verification and not the session's status.
			outcome.failure = { reason: "unavailable", message };
			if (options.verification === undefined) {
				this.lastError = message;
				this.lastFailure = outcome.failure;
				if (!this.notices.includes(message)) this.notices.push(message);
			}
			return;
		}
		if (!connection) {
			this.lastError = "no CLIProxyAPI credential configured";
			log.debug("refresh skipped: not configured");
			return;
		}
		// A verification at a base URL other than the session's checks its key there and leaves the catalog and its cache alone.
		// A session whose own base URL cannot be read has nothing to differ from: the login that set it up registered the URL it checked.
		const sessionUrl = sessionModelsUrl(this.agentDir, identity.providerId);
		const verifiesOtherEndpoint =
			options.verification !== undefined && sessionUrl !== "unreadable" && sessionUrl !== connection.modelsUrl;
		if (!verifiesOtherEndpoint) this.lastModelsUrl = connection.modelsUrl;

		await this.ensureCostCatalog(overrides.defaults.pricing, options.pricing ?? "await", options.signal);

		const known = this.knownModels(connection.modelsUrl);

		if (!options.allowNetwork) {
			if (known.models.length > 0) {
				this.applyCatalog(known.models, known.source === "cache" ? "cache" : "remote", known.fetchedAt ?? 0);
			}
			return;
		}

		const now = Date.now();
		// Extension load, nyan's own model refresh and session_start can all fire within
		// seconds of each other; an explicit force always goes to the network.
		// A verification always fetches: its verdict is about its key, not about a recent fetch.
		if (!this.shouldFetch(now, options.force || options.verification !== undefined)) {
			log.debug("catalog refresh skipped: a successful fetch happened moments ago");
			return;
		}

		try {
			const entries = await fetchCatalog(connection.modelsUrl, connection.apiKey, {
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (!verifiesOtherEndpoint) this.applyFetchedEntries(entries, known, now);
		} catch (error) {
			if (options.signal?.aborted) {
				return;
			}
			const failure = classifyFailure(error);
			outcome.failure = failure;
			if (!verifiesOtherEndpoint) {
				this.lastError = errorMessage(error);
				this.lastFailure = failure;
			}
			if (options.verification === undefined) {
				if (failure.reason === "rejected" && failure.httpStatus !== undefined) {
					this.notices.push(
						rejectedKeyNotice(this.agentDir, identity.providerId, identity.providerName, failure.httpStatus),
					);
				}
				log.warn(`catalog refresh failed: ${errorMessage(error)}`);
			} else {
				// The login reports a verification's failure itself, so it adds no notice and no second warning.
				log.debug(`credential verification failed: ${errorMessage(error)}`);
			}

			// Keep the known list so a proxy hiccup does not empty the picker.
			if (!verifiesOtherEndpoint && known.models.length > 0) {
				this.applyCatalog(known.models, known.source === "cache" ? "cache" : "remote", known.fetchedAt ?? 0);
			}
		}
	}

	/** Whether a network fetch is worth it right now. */
	private shouldFetch(now: number, force?: boolean): boolean {
		if (force || this.lastSource !== "remote" || this.fetchedAt === undefined) {
			return true;
		}
		return now - this.fetchedAt >= resolveCatalogMinRefreshMs();
	}

	/** Map, reconcile, report and cache one successful fetch. */
	private applyFetchedEntries(entries: CpaModel[], known: KnownModels, now: number): void {
		const overrides = this.overrides ?? loadOverrides(this.agentDir);
		this.lastEntries = entries;
		const fresh = mapCatalog(entries, { overrides, costCatalog: this.costCatalog, now });
		// Reconcile against the known state, measuring any grace period from the fetch
		// that last listed the model rather than from this one.
		const baselineFetchedAt = known.fetchedAt ?? now;
		const final = reconcileCatalog(fresh, known.models, overrides, now, baselineFetchedAt);
		this.reportDroppedModels(final.dropped, final.models);
		this.reportAddedModels(known.models, final.models);
		this.applyCatalog(final.models, "remote", now);
		this.lastError = undefined;
		this.lastFailure = undefined;
		if (this.lastModelsUrl) {
			saveCatalogCache(this.agentDir, this.lastModelsUrl, this.models);
		}
	}
}

/** The catalog state a refresh reconciles against. */
interface KnownModels {
	models: CatalogModel[];
	fetchedAt?: number;
	source: "remote" | "cache" | "none";
}

/** The verdicts the refresh contract defines, read from the contract so the vocabulary cannot drift. */
type CredentialVerdict = Parameters<NonNullable<RefreshModelsContext["reportCredentialVerdict"]>>[0];

/**
 * Why the last refresh had no usable answer. `reason` is the discriminant: `rejected` when the proxy refused the key,
 * `unavailable` when it gave no usable answer at all.
 */
export interface CatalogFailure {
	reason: Exclude<CredentialVerdict, "verified">;
	message: string;
	/** The HTTP status the proxy answered with, when it answered. */
	httpStatus?: number;
}

function classifyFailure(error: unknown): CatalogFailure {
	const httpStatus = error instanceof CatalogHttpError ? error.status : undefined;
	const refused = httpStatus === 401 || httpStatus === 403;
	return {
		reason: refused ? "rejected" : "unavailable",
		message: errorMessage(error),
		...(httpStatus !== undefined ? { httpStatus } : {}),
	};
}

/** The secret a stored credential carries: an API key, or the access token of an OAuth login. */
function credentialSecret(credential: RefreshModelsContext["credential"]): string | undefined {
	let secret: string | undefined;
	if (credential?.type === "api_key") secret = credential.key;
	else if (credential?.type === "oauth") secret = credential.access;
	const trimmed = secret?.trim();
	return trimmed ? trimmed : undefined;
}

/** Warns when the key the model list is fetched with is not the one this login entered. */
function warnIfKeyOverridden(
	agentDir: string,
	providerId: string,
	entered: string,
	credentialType: "api_key" | "oauth",
): void {
	let runtimeKey: string | undefined;
	try {
		runtimeKey = resolveConnection(agentDir, providerId)?.apiKey;
	} catch {
		// A malformed CLIPROXYAPI_BASE_URL is reported by the refresh that follows; a hint about the key does not add to it.
		return;
	}
	if (!runtimeKey || runtimeKey === entered) return;
	const source = apiKeySource(agentDir, providerId);
	if (source.kind === "environment") {
		log.warn(overriddenKeyMessage("CLIPROXYAPI_API_KEY", providerId, credentialType));
	} else if (source.kind === "config") {
		log.warn(overriddenKeyMessage(`The apiKey field in ${source.path}`, providerId, credentialType));
	}
}

function overriddenKeyMessage(subject: string, providerId: string, credentialType: "api_key" | "oauth"): string {
	const head = `${subject} is set to a different key than the one just entered.`;
	return credentialType === "api_key"
		? `${head} The model list is fetched with that key. A key stored by an API-key login is not used for requests: run ${APP_NAME} login ${providerId} without --method.`
		: `${head} The model list is fetched with that key, while requests use the key this login stored. Remove the setting so both use the same key.`;
}

/** Names the variable that sends the login to a base URL other than the one it checked, or undefined when none does. */
function endpointOverrideNotice(entered: string, effective: string): string | undefined {
	try {
		if (resolveEndpoints(entered).rootOrigin === resolveEndpoints(effective).rootOrigin) return undefined;
	} catch {
		// A malformed override variable is reported by the refresh that follows; it must not fail a correct login.
		return undefined;
	}
	return `CLIPROXYAPI_BASE_URL is set to ${effective}, so the model list and requests go there, not to the URL you entered (${entered}). The key was checked at ${entered}.`;
}

/** Says where the rejected key is set and how to correct it, since logging in does not always change it. */
function rejectedKeyNotice(agentDir: string, providerId: string, providerName: string, status: number): string {
	const source = apiKeySource(agentDir, providerId);
	if (source.kind === "environment") {
		return `CLIProxyAPI rejected the API key in the environment variable CLIPROXYAPI_API_KEY (HTTP ${status}). Logging in does not change it: correct or unset that variable, then run /cpa-refresh.`;
	}
	if (source.kind === "config") {
		return `CLIProxyAPI rejected the apiKey in ${source.path} (HTTP ${status}). That field is read before the stored login: correct or remove it there, then run /cpa-refresh.`;
	}
	return `CLIProxyAPI rejected the credential (HTTP ${status}). Re-run /login ${providerName} to reconfigure.`;
}

/** Whether a base URL parses, so a session can register it. */
function isUsableBaseUrl(baseUrlInput: string): boolean {
	try {
		resolveEndpoints(baseUrlInput);
		return true;
	} catch {
		return false;
	}
}

/**
 * The models URL the session's catalog uses, from the base URL the session connects to whether or not it has a key.
 * `"unreadable"` when that base URL does not parse, which leaves nothing to differ from.
 */
function sessionModelsUrl(agentDir: string, providerId: string): string {
	try {
		return resolveEndpoints(defaultBaseUrlInput(agentDir, providerId)).modelsUrl;
	} catch {
		return "unreadable";
	}
}

/** Resolve the connection a refresh needs. A verification uses the key and the base URL its login recorded. */
function resolveConnectionForRefresh(
	agentDir: string,
	providerId: string,
	verification?: { apiKey: string; baseUrlInput: string },
): { modelsUrl: string; apiKey: string; baseUrlInput: string } | null {
	if (verification !== undefined) {
		const { apiKey, baseUrlInput } = verification;
		return { modelsUrl: resolveEndpoints(baseUrlInput).modelsUrl, apiKey, baseUrlInput };
	}
	const connection = resolveConnection(agentDir, providerId);
	return connection
		? { modelsUrl: connection.modelsUrl, apiKey: connection.apiKey, baseUrlInput: connection.baseUrlInput }
		: null;
}

export interface ProviderRegistrationOptions {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey?: string;
	catalog: CatalogController;
	/** Proxy key whose JWT payload supplies the account id to nyan-ai's Codex API. */
	codexWsApiKey?: string;
	onConfigured?: (baseUrlInput: string, apiKey: string) => Promise<void>;
}

/** Build the `/login` handler set and the provider config. */
export function buildProviderRegistration(options: ProviderRegistrationOptions): ProviderConfig {
	const { agentDir, providerId, providerName, baseUrlInput, apiKey, catalog } = options;
	const endpoints = resolveEndpoints(baseUrlInput);
	const defaultBaseUrl = firstNonEmpty(baseUrlInput, DEFAULT_BASE_URL)!;
	const codexWsApiKey = firstNonEmpty(options.codexWsApiKey, resolveCodexWsApiKey(agentDir));

	return {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		// The catalog maps every model to `openai-responses`, so this handler is not
		// selected today. It stays wired so an explicit `openai-codex-responses`
		// model keeps working: nyan-ai's Codex API derives the account id from the
		// bridge key's JWT payload, and CLIProxyAPI must list the same key in its
		// access list for that path to authenticate.
		api: "openai-codex-responses",
		...(codexWsApiKey
			? {
					streamSimple: (model, context, streamOptions) =>
						nyanStreamSimple(model, context, { ...streamOptions, apiKey: codexWsApiKey }),
				}
			: {}),
		// Passing apiKey as well as oauth would make `/login <provider>` ask the user
		// to choose between the API-key and account paths. Ambient auth is only needed
		// when no `/login` credential exists.
		...(apiKey ? { apiKey } : {}),
		models: catalog.configs(),
		refreshModels: async (ctx: RefreshModelsContext) => {
			// Ordinary refreshes (startup, /cpa-refresh, `nyan update models`) use the key nyan resolves, keep the last list
			// on failure and throw nothing, as they did before login verification existed.
			if (ctx.verifyCredential !== true || !ctx.allowNetwork) {
				await catalog.refresh({ allowNetwork: ctx.allowNetwork, force: ctx.force === true, signal: ctx.signal });
				return catalog.configs();
			}
			// A verification authenticates with the key the login stored, never with one the connection would prefer, and
			// reports its verdict. A stored login with no key cannot be verified, so the login is refused.
			const credential = ctx.credential;
			const entered = credentialSecret(credential);
			if (credential === undefined || entered === undefined) {
				ctx.reportCredentialVerdict?.("rejected");
				throw new Error("the stored login has no key to verify");
			}
			// An OAuth login records the base URL it checked, and the key is verified there, not at whatever
			// CLIPROXYAPI_BASE_URL names. An API-key login records none: its key is verified at the configured base URL,
			// the one its requests use. A stored OAuth login with no recorded base URL is not guessed at: it stays unverified.
			const recordedBaseUrl = credential.type === "oauth" ? decodeCredentialMeta(credential.refresh) : undefined;
			if (credential.type === "oauth" && recordedBaseUrl === undefined) {
				throw new Error("the stored login does not record the base URL it was checked at");
			}
			const baseUrlInput = recordedBaseUrl ?? defaultBaseUrlInput(agentDir, providerId);
			warnIfKeyOverridden(agentDir, providerId, entered, credential.type);
			const verification = await catalog.refresh({
				allowNetwork: true,
				force: true,
				signal: ctx.signal,
				verification: { apiKey: entered, baseUrlInput },
			});
			const failure = verification.verificationFailure;
			if (failure && !ctx.signal.aborted) {
				ctx.reportCredentialVerdict?.(failure.reason);
				throw new Error(failure.message);
			}
			// The proxy accepted the credential it was just given, and the provider says so. A cancelled check says nothing.
			if (!ctx.signal.aborted) ctx.reportCredentialVerdict?.("verified");
			return catalog.configs();
		},
		oauth: {
			name: providerName,
			async login(callbacks) {
				let promptDefaultBaseUrl = defaultBaseUrl;
				// Validate by fetching the catalog; HTTP 200 (even with an empty catalog)
				// means the base URL and key are usable, so re-prompt only on failure.
				for (;;) {
					if (callbacks.signal?.aborted) {
						throw new Error("Login cancelled");
					}
					callbacks.onProgress?.(
						`Configure ${providerName}. Preferred base URL form: host:port (for example http://127.0.0.1:8317).`,
					);
					const baseUrlRaw = await callbacks.onPrompt({
						message: `${providerName} base URL [${promptDefaultBaseUrl}]:`,
						placeholder: promptDefaultBaseUrl,
						allowEmpty: true,
					});
					const enteredBaseUrl = firstNonEmpty(baseUrlRaw, promptDefaultBaseUrl)!;
					try {
						resolveEndpoints(enteredBaseUrl);
					} catch (error) {
						callbacks.onProgress?.(`Invalid base URL: ${errorMessage(error)}`);
						promptDefaultBaseUrl = enteredBaseUrl;
						continue;
					}

					const enteredApiKey = (
						await callbacks.onPrompt({
							message: `${providerName} API key:`,
							placeholder: "sk-...",
							allowEmpty: false,
						})
					).trim();
					if (!enteredApiKey) {
						callbacks.onProgress?.("API key cannot be empty.");
						promptDefaultBaseUrl = enteredBaseUrl;
						continue;
					}

					callbacks.onProgress?.("Validating credentials via the models endpoint...");
					try {
						const endpoints = resolveEndpoints(enteredBaseUrl);
						const entries = await fetchCatalog(endpoints.modelsUrl, enteredApiKey, {
							...(callbacks.signal ? { signal: callbacks.signal } : {}),
						});
						saveConfig(agentDir, {
							baseUrl: enteredBaseUrl,
							apiKey: enteredApiKey,
							providerId,
							providerName,
						});
						const savedBaseUrl = defaultBaseUrlInput(agentDir, providerId);
						const usable = isUsableBaseUrl(savedBaseUrl);
						const override = usable
							? endpointOverrideNotice(enteredBaseUrl, savedBaseUrl)
							: `CLIPROXYAPI_BASE_URL is not a valid base URL. This session uses ${enteredBaseUrl}; correct the setting to change it.`;
						if (override) callbacks.onProgress?.(override);
						// Validation only needs HTTP 200; the catalog itself is fetched by the
						// refresh that `onConfigured` runs, and that path writes the cache.
						// The session registers the base URL the catalog uses, so its model list and its requests agree.
						await options.onConfigured?.(usable ? savedBaseUrl : enteredBaseUrl, enteredApiKey);
						callbacks.onProgress?.(`Registered ${entries.length} model(s) from ${endpoints.modelsUrl}.`);
						return {
							refresh: encodeCredentialMeta(enteredBaseUrl),
							access: enteredApiKey,
							expires: Date.now() + CREDENTIAL_TTL_MS,
						};
					} catch (error) {
						if (callbacks.signal?.aborted) {
							throw new Error("Login cancelled");
						}
						callbacks.onProgress?.(
							`Login validation failed: ${errorMessage(error)}\nPlease re-enter the base URL and API key.`,
						);
						promptDefaultBaseUrl = enteredBaseUrl;
					}
				}
			},
			async refreshToken(credentials) {
				// API keys do not expire; keep the stored payload and extend its window.
				return { ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
	};
}

/** Register or replace the provider with the current catalog. */
export function registerProvider(options: ProviderRegistrationOptions): void {
	const { pi, providerId, catalog } = options;
	const hasLogin = hasStoredLogin(options.agentDir, providerId);
	const apiKey = hasLogin ? undefined : options.apiKey;
	// Replace the previous registration so an older ambient key cannot linger.
	pi.unregisterProvider(providerId);
	pi.registerProvider(providerId, buildProviderRegistration({ ...options, apiKey }));
	log.debug(`registered provider ${providerId} with ${catalog.configs().length} model(s)`);
}

/** Flush pending catalog notices to the UI, if a context is available. */
export function flushNotices(catalog: CatalogController, ctx: ExtensionContext | undefined): void {
	if (!ctx?.hasUI) {
		catalog.takeNotices();
		return;
	}
	for (const notice of catalog.takeNotices()) {
		try {
			ctx.ui.notify(notice, "warning");
		} catch (error) {
			if (!isStaleContextError(error)) {
				log.debug("failed to show notice", errorMessage(error));
			}
		}
	}
}
