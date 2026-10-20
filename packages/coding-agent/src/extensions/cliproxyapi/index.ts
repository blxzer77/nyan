/**
 * CLIProxyAPI provider for nyan.
 *
 * Design notes:
 *
 * - Every catalog model uses nyan-ai's built-in `openai-responses` against
 *   `{root}/backend-api/codex/responses`. The catalog's `prefer_websockets` flag
 *   picks the upstream transport inside CLIProxyAPI and does not change the
 *   client API.
 * - The catalog comes from `/v1/models?client_version=pi` through nyan's
 *   `refreshModels` hook, and is corrected by a declarative overrides file rather
 *   than by editing this extension.
 * - `service_tier: "priority"` (Fast) is injected through `before_provider_request`
 *   for both CLIProxyAPI models and native `openai-codex` GPT models.
 */

import { createHash } from "node:crypto";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { registerCommands } from "./commands.ts";
import {
	configPath,
	defaultBaseUrlInput,
	ENV,
	loadConfigSafe,
	overridesPath,
	resolveConnection,
	resolveFastDefault,
	resolveIdentity,
	resolveManagementKey,
	resolvePauseDefault,
} from "./config.ts";
import { FastModeController, withPriorityServiceTier } from "./fast.ts";
import { errorMessage, isStaleContextError, log, setQuiet } from "./log.ts";
import { loadOverrides } from "./overrides.ts";
import { PauseController, waitForPauseToEnd } from "./pause.ts";
import { CatalogController, flushNotices, registerProvider } from "./provider.ts";
import { fetchManagementQuota, QuotaPoller } from "./quota.ts";
import { registerTransientErrorNormalizer } from "./retry.ts";
import { TelemetryHub } from "./telemetry.ts";
import { UsageReporter } from "./usage.ts";

export { reconcileCatalog, toCatalogModel } from "./catalog.ts";
export { resolveEndpoints } from "./config.ts";
export { FastModeController, persistFastPreference, withPriorityServiceTier } from "./fast.ts";
export { computeTokensPerSecond, type RequestMetrics, summarizeRequests } from "./metrics.ts";
export { buildThinkingLevelMap, compileOverrides, resolveOverride } from "./overrides.ts";
export { PauseController } from "./pause.ts";
export { buildCostCatalog, computeCost, matchCost } from "./pricing.ts";
export {
	classifyQuotaWindow,
	parseCodexQuotaSignals,
	parseManagementAuthFiles,
	type QuotaSnapshot,
	type QuotaWindow,
} from "./quota.ts";
export { normalizeTransientError } from "./retry.ts";
export {
	QUOTA_EVENT_CHANNEL,
	type QuotaView,
	REQUEST_EVENT_CHANNEL,
	type TelemetryHub,
	type TelemetrySnapshot,
} from "./telemetry.ts";
export { formatElapsed, formatTokens, UsageReporter } from "./usage.ts";

const FAST_STATUS_KEY = "cpa-fast";

/**
 * What the footer should say, derived from what the pause gate and Fast actually do.
 *
 * The pause gate applies to this provider and native `openai-codex` requests;
 * a `paused` label on another provider's model would claim a gate that does not exist.
 */
export function buildStatusLabels(
	model: { provider: string; id: string } | undefined,
	fastMode: FastModeController,
	pauseMode: PauseController,
	providerId: string,
): { fast?: "on" | "off"; paused: boolean } {
	if (!model || (model.provider !== providerId && model.provider !== "openai-codex")) {
		return { paused: false };
	}
	const fast = fastMode.stateForModel(model, providerId);
	return { ...(fast ? { fast } : {}), paused: pauseMode.isEnabled() };
}

/** What a user who selects CLIProxyAPI without a connection needs to do, naming every way to configure it. */
function notConfiguredHint(agentDir: string, identity: { providerId: string; providerName: string }): string {
	return (
		`not configured. Run /login ${identity.providerName} or /login ${identity.providerId}, ` +
		`or set ${configPath(agentDir)} / ${ENV.apiKey}.`
	);
}

export default async function cliproxyApiExtension(pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	if (process.env[ENV.quiet] === "1" || process.env[ENV.quiet] === "true") {
		setQuiet(true);
	}

	const identity = resolveIdentity(agentDir);
	// The connection the provider is currently registered with, so a background pricing
	// refresh can re-register with the same one.
	let activeConnection: { baseUrlInput: string; apiKey: string } | undefined;
	const catalog = new CatalogController(agentDir, identity.providerId, {
		onCatalogUpdated: () => {
			fastMode.setSupportedModelIds(catalog.fastModelIds());
			if (!activeConnection) {
				return;
			}
			registerProvider({
				pi,
				agentDir,
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: activeConnection.baseUrlInput,
				apiKey: activeConnection.apiKey,
				catalog,
			});
		},
	});

	let fastEnabled = false;
	try {
		fastEnabled = resolveFastDefault(agentDir);
	} catch (error) {
		log.warn(`invalid Fast configuration, using off: ${errorMessage(error)}`);
	}
	const fastMode = new FastModeController(fastEnabled);

	let pauseEnabled = false;
	try {
		pauseEnabled = resolvePauseDefault(agentDir);
	} catch (error) {
		log.warn(`invalid pause configuration, using off: ${errorMessage(error)}`);
	}
	const pauseMode = new PauseController(pauseEnabled);

	const telemetry = new TelemetryHub({
		events: pi.events,
		managementKeyConfigured: resolveManagementKey(agentDir) !== undefined,
	});
	// The 5h and weekly plan quota lives on the proxy. Poll it only when a management key is configured; the
	// key and the proxy address are read on every poll so editing the config takes effect without a restart.
	const quotaPoller = new QuotaPoller({
		fetch: async (signal) => {
			const managementKey = resolveManagementKey(agentDir);
			telemetry.setManagementKeyConfigured(managementKey !== undefined);
			const connection = resolveConnection(agentDir, identity.providerId);
			if (!connection) return { status: "network_error", message: "no CLIProxyAPI connection is configured" };
			return fetchManagementQuota({ rootOrigin: connection.rootOrigin, managementKey, signal });
		},
		onResult: (result) => telemetry.applyManagementResult(result),
		// Not the key itself: a short digest, so the poller can recognise a key the proxy already rejected.
		fingerprint: () => {
			const managementKey = resolveManagementKey(agentDir);
			const connection = resolveConnection(agentDir, identity.providerId);
			return managementKey && connection
				? createHash("sha256").update(`${connection.rootOrigin}\n${managementKey}`).digest("hex").slice(0, 16)
				: undefined;
		},
	});

	const usage = new UsageReporter({
		providerId: identity.providerId,
		pauseMode,
		isFastEffective: (model) => fastMode.isEffectiveForModel(model, identity.providerId),
		nextRequestId: () => telemetry.nextRequestId(),
		onRequest: (record) => telemetry.recordRequest(record),
		onResponseHeaders: (headers) => telemetry.observeResponseHeaders(headers),
	});
	usage.register(pi);
	registerTransientErrorNormalizer(pi, identity.providerId);

	/**
	 * Gate every provider request behind the pause setting, and inject the priority
	 * service tier when Fast applies. `before_provider_request` hands back a
	 * replacement payload, so this needs no stream handler.
	 *
	 * Covers both providers this extension handles: models served by `providerId`
	 * and nyan's native `openai-codex` GPT models (see `FastModeController.managesModel`).
	 * The usage summary below is narrower on purpose — it reports what went through
	 * the proxy, so a native Codex request is not counted there.
	 */
	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!model || (model.provider !== identity.providerId && model.provider !== "openai-codex")) {
			return;
		}
		// ctx.signal is read before the first await: an abort or a closed Harness releases the wait.
		await waitForPauseToEnd(agentDir, pauseMode, ctx.signal);

		if (!fastMode.isEffectiveForModel(model, identity.providerId)) {
			return undefined;
		}
		const next = withPriorityServiceTier(event.payload);
		log.debug(`fast enabled for ${model.id}`);
		return next;
	});

	// Status labels for Fast and Pause. These use the built-in status row instead of
	// patching the footer component, so a nyan update cannot break them.
	const refreshStatus = (ctx: ExtensionContext | undefined): void => {
		if (!ctx?.hasUI) {
			return;
		}
		try {
			const model = ctx.model;
			const labels = buildStatusLabels(model, fastMode, pauseMode, identity.providerId);
			const parts: string[] = [];
			// A Fast-capable model always says which way the switch is set, so "off" is
			// distinguishable from "this model has no Fast tier" (which shows nothing).
			if (labels.fast === "on") {
				parts.push(ctx.ui.theme.fg("warning", "fast on"));
			} else if (labels.fast === "off") {
				parts.push(ctx.ui.theme.fg("dim", "fast off"));
			}
			if (labels.paused) {
				parts.push(ctx.ui.theme.fg("warning", "paused"));
			}
			ctx.ui.setStatus(FAST_STATUS_KEY, parts.length > 0 ? parts.join(" ") : undefined);
		} catch (error) {
			if (!isStaleContextError(error)) {
				log.debug("failed to update status", errorMessage(error));
			}
		}
	};

	// Commands redraw the labels themselves after they flip a switch; otherwise the
	// footer would stay stale until the next model change.
	registerCommands({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		catalog,
		fastMode,
		pauseMode,
		usage,
		telemetry,
		quotaPoller,
		defaultBaseUrl: defaultBaseUrlInput(agentDir, identity.providerId),
		refreshStatus,
	});

	// The extension loads for every user, including the many who never use CLIProxyAPI, so startup says nothing. The hint
	// appears once the provider is actually selected, and the `/cpa-*` commands print it themselves.
	let notConfiguredHintShown = false;
	pi.on("model_select", (event, ctx) => {
		refreshStatus(ctx);
		if (event.model.provider !== identity.providerId) return;
		if (notConfiguredHintShown || resolveConnection(agentDir, identity.providerId) !== null) return;
		notConfiguredHintShown = true;
		log.warn(notConfiguredHint(agentDir, identity));
	});

	// A finished run is the moment the proxy has just recorded a fresh quota observation for the credential
	// that served it. The poller throttles itself, so a burst of short runs costs one request a minute.
	pi.on("agent_settled", () => {
		if (resolveManagementKey(agentDir) === undefined) return;
		void quotaPoller.refresh().catch((error) => log.debug("quota poll failed", errorMessage(error)));
	});

	let registerConfigured: (baseUrlInput: string, apiKey: string) => Promise<void>;
	const refreshCatalogInBackground = (
		connection: { baseUrlInput: string; apiKey: string },
		ctx?: ExtensionContext,
	): void => {
		void catalog
			.refresh({ allowNetwork: true, pricing: "background" })
			.then(() => {
				fastMode.setSupportedModelIds(catalog.fastModelIds());
				activeConnection = connection;
				registerProvider({
					pi,
					agentDir,
					providerId: identity.providerId,
					providerName: identity.providerName,
					baseUrlInput: connection.baseUrlInput,
					apiKey: connection.apiKey,
					catalog,
					onConfigured: registerConfigured,
				});
				flushNotices(catalog, ctx);
				refreshStatus(ctx);
			})
			.catch((error) => log.debug(`background catalog refresh failed: ${errorMessage(error)}`));
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshStatus(ctx);
		flushNotices(catalog, ctx);

		// Refresh the catalog in the background so startup is not blocked by a slow
		// proxy, then re-register with the latest list. Pricing is fetched in the
		// background too: a cold models.dev cache must not delay the first render.
		const connection = resolveConnection(agentDir, identity.providerId);
		if (!connection) {
			return;
		}
		if (resolveManagementKey(agentDir) !== undefined) {
			void quotaPoller.refresh().catch((error) => log.debug("quota poll failed", errorMessage(error)));
		}
		try {
			// Use the cache immediately; a network refresh runs in the background below.
			await catalog.refresh({ allowNetwork: false, pricing: "background" });
			fastMode.setSupportedModelIds(catalog.fastModelIds());
			activeConnection = { baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey };
			registerProvider({
				pi,
				agentDir,
				providerId: identity.providerId,
				providerName: identity.providerName,
				baseUrlInput: connection.baseUrlInput,
				apiKey: connection.apiKey,
				catalog,
				onConfigured: registerConfigured,
			});
			flushNotices(catalog, ctx);
			refreshStatus(ctx);
			refreshCatalogInBackground(connection, ctx);
		} catch (error) {
			log.warn(`catalog cache load failed: ${errorMessage(error)}`);
		}
	});
	pi.on("session_shutdown", () => {
		refreshStatus(undefined);
	});

	registerConfigured = async (baseUrlInput: string, apiKey: string): Promise<void> => {
		// The login has just checked this key and base URL against the proxy. A refresh that then fails, for example on a
		// malformed CLIPROXYAPI_BASE_URL, must not turn a correct login into a validation failure, so it is logged as a warning, not thrown.
		try {
			await catalog.refresh({ allowNetwork: true, force: true, pricing: "background" });
		} catch (error) {
			log.warn("catalog refresh after login failed", errorMessage(error));
		}
		fastMode.setSupportedModelIds(catalog.fastModelIds());
		activeConnection = { baseUrlInput, apiKey };
		registerProvider({
			pi,
			agentDir,
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput,
			apiKey,
			catalog,
			onConfigured: registerConfigured,
		});
	};

	const connection = resolveConnection(agentDir, identity.providerId);
	const overrides = loadOverrides(agentDir);

	if (!connection) {
		// Register anyway so the provider appears in /login, `nyan login <provider>` resolves it, and the `/cpa-*`
		// commands can report what is missing. Nothing is printed here: see the `model_select` hint.
		registerProvider({
			pi,
			agentDir,
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: defaultBaseUrlInput(agentDir, identity.providerId),
			catalog,
			onConfigured: registerConfigured,
		});
		return;
	}

	// Register cached models immediately. The network refresh below is deliberately
	// detached so an unavailable proxy cannot block nyan startup.
	try {
		await catalog.refresh({ allowNetwork: false, pricing: "background" });
	} catch (error) {
		log.warn(`initial catalog cache load failed: ${errorMessage(error)}`);
	}
	fastMode.setSupportedModelIds(catalog.fastModelIds());
	activeConnection = { baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey };

	registerProvider({
		pi,
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: connection.baseUrlInput,
		apiKey: connection.apiKey,
		catalog,
		onConfigured: registerConfigured,
	});
	refreshCatalogInBackground({ baseUrlInput: connection.baseUrlInput, apiKey: connection.apiKey });

	if (!overrides.found) {
		log.debug(
			`no overrides file at ${overridesPath(agentDir, loadConfigSafe(agentDir).config)}; using catalog values`,
		);
	}
	for (const problem of overrides.problems) {
		log.warn(`override problem: ${problem}`);
	}

	const snapshot = catalog.getSnapshot();
	log.info(
		`ready: ${snapshot.models.length} model(s) from ${catalog.getLastSource()}` +
			`${snapshot.error ? ` (last refresh failed: ${snapshot.error})` : ""}`,
	);
	if (snapshot.models.length === 0) {
		log.warn("the catalog returned no usable models. Run /cpa-refresh once the proxy lists models.");
	}
}
