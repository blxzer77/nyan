import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@ny4n/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ProviderConfig } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadCatalogCache, saveCatalogCache } from "../src/extensions/cliproxyapi/cache.ts";
import {
	AUTH_FILE_NAME,
	apiKeySource,
	CONFIG_FILE_NAME,
	configPath,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	loadConfig,
	OVERRIDES_FILE_NAME,
	overridesPath,
	resolveConnection,
	resolveEndpoints,
	saveConfig,
} from "../src/extensions/cliproxyapi/config.ts";
import { FastModeController, withPriorityServiceTier } from "../src/extensions/cliproxyapi/fast.ts";
import cliproxyApiExtension from "../src/extensions/cliproxyapi/index.ts";
import { buildThinkingLevelMap, compileOverrides, resolveOverride } from "../src/extensions/cliproxyapi/overrides.ts";
import { PauseController } from "../src/extensions/cliproxyapi/pause.ts";
import { computeCost, parseModelsDevCost } from "../src/extensions/cliproxyapi/pricing.ts";
import { CatalogController, encodeCredentialMeta } from "../src/extensions/cliproxyapi/provider.ts";
import { formatElapsed, formatTokens, UsageReporter } from "../src/extensions/cliproxyapi/usage.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nyan-cpa-test-"));
	created.push(dir);
	return dir;
}

describe("CLIProxyAPI extension", () => {
	it("ships as a built-in replaceable extension", () => {
		expect(builtInExtensions).toContainEqual(
			expect.objectContaining({ name: "cliproxyapi", builtin: true, replaceable: true }),
		);
	});

	it("registers provider and slash commands on extension load", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			cliproxyApiExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:cliproxyapi",
		);

		expect(extension.commands.has("cpa-refresh")).toBe(true);
		expect(extension.commands.has("cpa-models")).toBe(true);
		expect(extension.commands.has("cpa-doctor")).toBe(true);
		expect(extension.commands.has("cpa-usage")).toBe(true);
		expect(extension.commands.has("cpa-overrides")).toBe(true);
		expect(extension.commands.has("fast")).toBe(true);
		expect(extension.commands.has("pause")).toBe(true);
		expect(extension.commands.has("continue")).toBe(true);

		const registered = runtime.pendingProviderRegistrations.find((entry) => entry.name === DEFAULT_PROVIDER_ID);
		expect(registered).toBeDefined();
		expect(registered?.config.name).toBe(DEFAULT_PROVIDER_NAME);
		expect(registered?.config.oauth).toBeDefined();
	});

	it("loads through DefaultResourceLoader as builtin:cliproxyapi", async () => {
		const cwd = tempDir();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: builtInExtensions,
		});
		await loader.reload();
		const extensions = loader.getExtensions().extensions;
		expect(extensions.map((e) => e.path)).toContain("builtin:cliproxyapi");
	});

	describe("endpoints resolution", () => {
		it("normalizes base URLs into inference and models endpoints", () => {
			const res1 = resolveEndpoints("http://127.0.0.1:8317");
			expect(res1.rootOrigin).toBe("http://127.0.0.1:8317");
			expect(res1.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/codex");
			expect(res1.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=pi");

			const res2 = resolveEndpoints("http://127.0.0.1:8317/v1");
			expect(res2.rootOrigin).toBe("http://127.0.0.1:8317");
			expect(res2.inferenceBaseUrl).toBe("http://127.0.0.1:8317/backend-api/codex");

			const res3 = resolveEndpoints("http://localhost:50123/backend-api/codex");
			expect(res3.rootOrigin).toBe("http://localhost:50123");
			expect(res3.inferenceBaseUrl).toBe("http://localhost:50123/backend-api/codex");
		});

		it("throws on empty base URL", () => {
			expect(() => resolveEndpoints("   ")).toThrow("baseUrl is empty");
		});
	});

	describe("config storage", () => {
		it("saves and loads config atomically", () => {
			const dir = tempDir();
			saveConfig(dir, { baseUrl: "http://127.0.0.1:9999", apiKey: "sk-test", fast: true });
			const loaded = loadConfig(dir);
			expect(loaded.baseUrl).toBe("http://127.0.0.1:9999");
			expect(loaded.apiKey).toBe("sk-test");
			expect(loaded.fast).toBe(true);
		});
	});

	describe("FastModeController", () => {
		it("controls priority service tier per model", () => {
			const fast = new FastModeController(true);
			fast.setSupportedModelIds(["claude-3-7-sonnet", "gpt-4o"]);

			expect(
				fast.isFastCapableModel({ provider: DEFAULT_PROVIDER_ID, id: "claude-3-7-sonnet" }, DEFAULT_PROVIDER_ID),
			).toBe(true);
			expect(fast.isFastCapableModel({ provider: DEFAULT_PROVIDER_ID, id: "llama-3-8b" }, DEFAULT_PROVIDER_ID)).toBe(
				false,
			);
			expect(fast.isFastCapableModel({ provider: "openai-codex", id: "gpt-5-codex" }, DEFAULT_PROVIDER_ID)).toBe(
				true,
			);
			expect(fast.isFastCapableModel({ provider: "anthropic", id: "claude-3" }, DEFAULT_PROVIDER_ID)).toBe(false);

			expect(withPriorityServiceTier({ prompt: "hello" })).toEqual({
				prompt: "hello",
				service_tier: "priority",
			});
		});
	});

	describe("PauseController", () => {
		it("tracks paused duration accurately", () => {
			const pause = new PauseController(false);
			expect(pause.isEnabled()).toBe(false);

			pause.setEnabled(true, 1000);
			expect(pause.isEnabled()).toBe(true);
			expect(pause.totalPausedMs(1500)).toBe(500);

			pause.setEnabled(false, 2000);
			expect(pause.isEnabled()).toBe(false);
			expect(pause.totalPausedMs(3000)).toBe(1000);
		});
	});

	describe("UsageReporter", () => {
		it("formats tokens and elapsed time", () => {
			expect(formatTokens(500)).toBe("500");
			expect(formatTokens(2500)).toBe("2.5k");
			expect(formatTokens(1_500_000)).toBe("1.50M");

			expect(formatElapsed(45)).toBe("45s");
			expect(formatElapsed(125)).toBe("2m 5s");
			expect(formatElapsed(3665)).toBe("1h 1m 5s");
		});

		it("computes throughput (tps)", () => {
			const tps = UsageReporter.computeTps(200, 2000, 1000);
			expect(tps).toBe(200);

			// Under 250ms returns undefined
			expect(UsageReporter.computeTps(200, 1100, 1000)).toBeUndefined();
		});
	});

	describe("overrides", () => {
		it("compiles and resolves model overrides with pattern fallbacks", () => {
			const compiled = compileOverrides(
				{
					defaults: { contextWindow: 200000 },
					models: {
						"gpt-special": { contextWindow: 500000, pin: true },
					},
					patterns: [{ match: "^claude-", maxTokens: 64000 }],
				},
				"/tmp/test.json",
				true,
			);

			const exact = resolveOverride(compiled, "gpt-special");
			expect(exact?.contextWindow).toBe(500000);
			expect(exact?.pin).toBe(true);

			const pattern = resolveOverride(compiled, "claude-3-7-sonnet");
			expect(pattern?.maxTokens).toBe(64000);
		});

		it("builds thinking level map correctly", () => {
			const map = buildThinkingLevelMap(["low", "medium", "high", "none"]);
			expect(map.low).toBe("low");
			expect(map.medium).toBe("medium");
			expect(map.high).toBe("high");
			expect(map.off).toBe("none");
			expect(map.minimal).toBeNull();
		});
	});

	describe("catalog cache", () => {
		it("saves and loads reconciled catalog cache", () => {
			const dir = tempDir();
			const modelsUrl = "http://127.0.0.1:8317/v1/models";
			saveCatalogCache(dir, modelsUrl, [
				{
					config: {
						id: "model-1",
						name: "Model 1",
						api: "openai-responses",
						input: ["text"],
						cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
						reasoning: false,
					},
					meta: {
						id: "model-1",
						name: "Model 1",
						listing: "listed",
						listed: true,
						pinned: false,
						fast: false,
						costSource: "none",
						catalog: { reasoningLevels: [] },
						extras: {},
					},
				},
			]);

			const cached = loadCatalogCache(dir, modelsUrl);
			expect(cached).toBeDefined();
			expect(cached?.models.length).toBe(1);
			expect(cached?.models[0]?.config.id).toBe("model-1");

			// Cache for different URL is ignored
			expect(loadCatalogCache(dir, "http://other/v1/models")).toBeUndefined();
		});
	});

	describe("never reads ~/.pi/agent", () => {
		// Nyan does not read ~/.pi; these files are planted under a fake HOME to prove the
		// extension resolves only from the agent dir passed in, even when ~/.pi exists.
		const fileHome = tempDir();
		const agentDir = tempDir();
		const piAgent = join(fileHome, ".pi", "agent");
		// The planted cache carries this URL, so a reintroduced fallback returns it instead of undefined.
		const piModelsUrl = "http://pi-host:1111/v1/models";

		function plantPiAgent(): void {
			mkdirSync(piAgent, { recursive: true });
			writeFileSync(
				join(piAgent, CONFIG_FILE_NAME),
				JSON.stringify({ baseUrl: "http://pi-host:1111", apiKey: "pi-config-key" }),
			);
			writeFileSync(
				join(piAgent, AUTH_FILE_NAME),
				JSON.stringify({ cliproxyapi: { type: "api_key", key: "pi-auth-key" } }),
			);
			writeFileSync(join(piAgent, OVERRIDES_FILE_NAME), JSON.stringify({ defaults: { contextWindow: 111111 } }));
			writeFileSync(
				join(piAgent, "cliproxyapi-catalog.json"),
				JSON.stringify({ version: 2, fetchedAt: 1, modelsUrl: piModelsUrl, models: [] }),
			);
		}

		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const previousOverrides = process.env.CLIPROXYAPI_OVERRIDES_FILE;
		const previousApiKey = process.env.CLIPROXYAPI_API_KEY;
		const previousBaseUrl = process.env.CLIPROXYAPI_BASE_URL;

		function restoreEnv(name: string, value: string | undefined): void {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}

		afterEach(() => {
			restoreEnv("HOME", previousHome);
			restoreEnv("USERPROFILE", previousUserProfile);
			restoreEnv("CLIPROXYAPI_OVERRIDES_FILE", previousOverrides);
			restoreEnv("CLIPROXYAPI_API_KEY", previousApiKey);
			restoreEnv("CLIPROXYAPI_BASE_URL", previousBaseUrl);
		});

		it("ignores ~/.pi/agent/cliproxyapi.json", () => {
			process.env.HOME = fileHome;
			process.env.USERPROFILE = fileHome;
			delete process.env.CLIPROXYAPI_API_KEY;
			delete process.env.CLIPROXYAPI_BASE_URL;
			plantPiAgent();

			expect(loadConfig(agentDir)).toEqual({});
			expect(resolveConnection(agentDir, DEFAULT_PROVIDER_ID)).toBeNull();
		});

		it("ignores ~/.pi/agent/cliproxyapi-overrides.json", () => {
			process.env.HOME = fileHome;
			process.env.USERPROFILE = fileHome;
			delete process.env.CLIPROXYAPI_OVERRIDES_FILE;
			plantPiAgent();

			expect(overridesPath(agentDir, {})).toBe(join(agentDir, OVERRIDES_FILE_NAME));
		});

		it("ignores ~/.pi/agent/auth.json credentials", () => {
			process.env.HOME = fileHome;
			process.env.USERPROFILE = fileHome;
			delete process.env.CLIPROXYAPI_API_KEY;
			delete process.env.CLIPROXYAPI_BASE_URL;
			plantPiAgent();

			expect(resolveConnection(agentDir, DEFAULT_PROVIDER_ID)).toBeNull();
		});

		it("ignores ~/.pi/agent/cliproxyapi-catalog.json", () => {
			process.env.HOME = fileHome;
			process.env.USERPROFILE = fileHome;
			plantPiAgent();

			expect(loadCatalogCache(agentDir, piModelsUrl)).toBeUndefined();
		});
	});

	describe("credential verification and rejected keys", () => {
		const servers: Server[] = [];
		afterEach(async () => {
			await Promise.all(
				servers.splice(0).map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
							server.closeAllConnections();
						}),
				),
			);
		});

		/** A proxy that accepts exactly one key and records every Authorization header it receives. */
		async function proxy(acceptedKey: string): Promise<{ baseUrl: string; seen: string[] }> {
			const seen: string[] = [];
			const server = createServer((request, response) => {
				const authorization = request.headers.authorization ?? "";
				seen.push(authorization);
				if (authorization !== `Bearer ${acceptedKey}`) {
					response.writeHead(401, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ error: { message: "invalid api key" } }));
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ models: [{ slug: "verify-model", context_window: 1000, max_tokens: 100 }] }));
			});
			servers.push(server);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
		}

		/** An agent dir whose models.dev pricing lookup is off, so a test makes no request but the proxy's. */
		function agentDirWithoutPricing(): string {
			const dir = tempDir();
			writeFileSync(join(dir, OVERRIDES_FILE_NAME), JSON.stringify({ defaults: { pricing: false } }));
			return dir;
		}

		/** Sets connection variables for one test; the returned function restores the previous values. */
		function setEnv(vars: Record<string, string>): () => void {
			const names = [
				"CLIPROXYAPI_BASE_URL",
				"CLIPROXYAPI_API_KEY",
				"CLIPROXYAPI_OVERRIDES_FILE",
				"NYAN_CODING_AGENT_DIR",
			];
			const saved = names.map((name) => [name, process.env[name]] as const);
			for (const name of names) delete process.env[name];
			Object.assign(process.env, vars);
			return () => {
				for (const [name, value] of saved) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			};
		}

		it("verifies with the typed key even when an environment key is set", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "env-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				const snapshot = await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				expect(controller.getLastFailure()).toBeUndefined();
				expect(snapshot.models.map((model) => model.meta.id)).toEqual(["verify-model"]);
				expect(seen).toEqual(["Bearer typed-key"]);
			} finally {
				restore();
			}
		});

		it("keeps the environment key for an ordinary refresh", async () => {
			const { baseUrl, seen } = await proxy("env-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "env-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				expect(controller.getLastFailure()).toBeUndefined();
				expect(seen).toEqual(["Bearer env-key"]);
			} finally {
				restore();
			}
		});

		/** The provider config the built-in extension registers, loaded the way nyan loads it (agent dir from the environment). */
		async function registeredCpa(): Promise<ProviderConfig> {
			const runtime = createExtensionRuntime();
			await loadExtensionFromFactory(
				cliproxyApiExtension,
				process.cwd(),
				createEventBus(),
				runtime,
				"builtin:cliproxyapi",
			);
			const entry = runtime.pendingProviderRegistrations.find(
				(registered) => registered.name === DEFAULT_PROVIDER_ID,
			);
			if (!entry) throw new Error("CLIProxyAPI did not register");
			return entry.config;
		}

		/** The context a login's verification refresh receives: a forced refresh with the stored credential. */
		function verificationContext(
			key: string,
			type: "oauth" | "api_key",
			verdicts: string[] = [],
			recordedBaseUrl?: string,
		): RefreshModelsContext {
			const credential =
				type === "oauth"
					? {
							type: "oauth" as const,
							access: key,
							refresh: recordedBaseUrl === undefined ? "" : encodeCredentialMeta(recordedBaseUrl),
							expires: Date.now() + 100_000,
						}
					: { type: "api_key" as const, key };
			return {
				credential,
				publish: async () => true,
				allowNetwork: true,
				force: true,
				signal: new AbortController().signal,
				verifyCredential: true,
				reportCredentialVerdict: (verdict) => {
					verdicts.push(verdict);
				},
			};
		}

		/** The context of an ordinary refresh (startup, /cpa-refresh, nyan update models): no verification flag. */
		function ordinaryContext(key: string): RefreshModelsContext {
			return {
				credential: { type: "api_key" as const, key },
				publish: async () => true,
				allowNetwork: true,
				force: true,
				signal: new AbortController().signal,
			};
		}

		it("names the environment variable when the key from it is rejected", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "wrong-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				const notices = controller.takeNotices();
				expect(notices).toEqual([expect.stringContaining("CLIPROXYAPI_API_KEY")]);
				expect(notices[0]).toContain("/cpa-refresh");
				expect(notices[0]).not.toContain("Re-run /login");
			} finally {
				restore();
			}
		});

		it("names the apiKey field of cliproxyapi.json when the key in it is rejected", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			saveConfig(agentDir, { baseUrl, apiKey: "wrong-key" });
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir });
			try {
				const controller = new CatalogController(agentDir, DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				const notice = controller.takeNotices()[0];
				expect(notice).toContain(join(agentDir, CONFIG_FILE_NAME));
				expect(notice).toContain("apiKey");
				expect(notice).not.toContain("Re-run /login");
			} finally {
				restore();
			}
		});

		it("keeps the re-login hint when the stored login is rejected", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			writeFileSync(
				join(agentDir, AUTH_FILE_NAME),
				JSON.stringify({ [DEFAULT_PROVIDER_ID]: { type: "api_key", key: "wrong-key" } }),
			);
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir, CLIPROXYAPI_BASE_URL: baseUrl });
			try {
				const controller = new CatalogController(agentDir, DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				expect(controller.takeNotices()[0]).toContain(`Re-run /login ${DEFAULT_PROVIDER_NAME}`);
			} finally {
				restore();
			}
		});

		it("warns when CLIPROXYAPI_API_KEY is not the key the login entered", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDir,
				CLIPROXYAPI_BASE_URL: baseUrl,
				CLIPROXYAPI_API_KEY: "env-key",
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await refreshModels(verificationContext("typed-key", "oauth", [], baseUrl));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("CLIPROXYAPI_API_KEY is set to a different key"));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("requests use the key this login stored"));
			} finally {
				warn.mockRestore();
				restore();
			}
		});

		it("does not warn when the environment key is the one entered", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDir,
				CLIPROXYAPI_BASE_URL: baseUrl,
				CLIPROXYAPI_API_KEY: "typed-key",
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await refreshModels(verificationContext("typed-key", "oauth", [], baseUrl));
				expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("is set to a different key"));
			} finally {
				warn.mockRestore();
				restore();
			}
		});

		it("warns about the apiKey field of cliproxyapi.json for an API-key login, and names the login to use", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			saveConfig(agentDir, { baseUrl, apiKey: "config-key" });
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await refreshModels(verificationContext("typed-key", "api_key"));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("The apiKey field in"));
				expect(warn).toHaveBeenCalledWith(expect.stringContaining(`login ${DEFAULT_PROVIDER_ID} without --method`));
			} finally {
				warn.mockRestore();
				restore();
			}
		});

		it("says when CLIPROXYAPI_BASE_URL sends the login to another base URL than the one entered", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir, CLIPROXYAPI_BASE_URL: "http://127.0.0.1:1" });
			try {
				const login = (await registeredCpa()).oauth?.login;
				if (!login) throw new Error("no oauth login");
				const answers = [baseUrl, "typed-key"];
				const progress: string[] = [];
				await login({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => answers.shift() ?? "",
					onProgress: (message) => progress.push(message),
					onSelect: async () => undefined,
				});
				expect(progress).toContainEqual(
					expect.stringContaining("CLIPROXYAPI_BASE_URL is set to http://127.0.0.1:1"),
				);
			} finally {
				restore();
			}
		});

		it("says nothing about a base URL when no variable moves the login", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir });
			try {
				const login = (await registeredCpa()).oauth?.login;
				if (!login) throw new Error("no oauth login");
				const answers = [baseUrl, "typed-key"];
				const progress: string[] = [];
				await login({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => answers.shift() ?? "",
					onProgress: (message) => progress.push(message),
					onSelect: async () => undefined,
				});
				expect(progress.some((message) => message.includes("CLIPROXYAPI_BASE_URL"))).toBe(false);
			} finally {
				restore();
			}
		});

		it("verifies a login at the base URL it entered, not at CLIPROXYAPI_BASE_URL", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(),
				CLIPROXYAPI_BASE_URL: "http://127.0.0.1:1",
			});
			try {
				const { oauth, refreshModels } = await registeredCpa();
				if (!refreshModels) throw new Error("no refreshModels");
				const login = oauth?.login;
				if (!login) throw new Error("no oauth login");
				const answers = [baseUrl, "typed-key"];
				const stored = await login({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => answers.shift() ?? "",
					onProgress: () => {},
					onSelect: async () => undefined,
				});
				const verdicts: string[] = [];
				// The credential the login just stored, as the verification receives it.
				await refreshModels({
					...verificationContext("typed-key", "oauth", verdicts),
					credential: { type: "oauth" as const, ...stored },
				});
				expect(verdicts).toEqual(["verified"]);
				expect(seen).toContain("Bearer typed-key");
			} finally {
				restore();
			}
		});

		it("leaves a stored login that recorded no base URL unverified rather than guessing one", async () => {
			const verdicts: string[] = [];
			const { refreshModels } = await registeredCpa();
			if (!refreshModels) throw new Error("no refreshModels");
			await expect(refreshModels(verificationContext("typed-key", "oauth", verdicts))).rejects.toThrow(
				"the stored login does not record the base URL it was checked at",
			);
			expect(verdicts).toEqual([]);
		});

		it("records an unusable base URL as a failure instead of throwing from an ordinary refresh", async () => {
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: "not a url", CLIPROXYAPI_API_KEY: "env-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				// The login's own sync and startup both make this call; neither may fail a login over the setting.
				await expect(controller.refresh({ allowNetwork: false })).resolves.toBeDefined();
				expect(controller.getLastFailure()).toMatchObject({ reason: "unavailable" });
				expect(controller.getLastError()).toContain("base URL is not valid");
				expect(controller.takeNotices()).toEqual([expect.stringContaining("base URL is not valid")]);
			} finally {
				restore();
			}
		});

		it("registers the base URL the catalog uses after a login, so requests go where the model list does", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(),
				CLIPROXYAPI_BASE_URL: "http://127.0.0.1:9",
			});
			try {
				const runtime = createExtensionRuntime();
				await loadExtensionFromFactory(
					cliproxyApiExtension,
					process.cwd(),
					createEventBus(),
					runtime,
					"builtin:cliproxyapi",
				);
				const login = runtime.pendingProviderRegistrations.find((r) => r.name === DEFAULT_PROVIDER_ID)?.config.oauth
					?.login;
				if (!login) throw new Error("no oauth login");
				const answers = [baseUrl, "typed-key"];
				await login({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => answers.shift() ?? "",
					onProgress: () => {},
					onSelect: async () => undefined,
				});
				// The login registers again after it stores the key; the registration replaces the first.
				const registered = runtime.pendingProviderRegistrations.find((r) => r.name === DEFAULT_PROVIDER_ID)?.config
					.baseUrl;
				if (!registered) throw new Error("no registration after login");
				expect(new URL(registered).port).toBe("9");
			} finally {
				restore();
			}
		});

		it("keeps one pending notice for a malformed base URL across the cache and network phases", async () => {
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: "not a url", CLIPROXYAPI_API_KEY: "env-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: false });
				await controller.refresh({ allowNetwork: true });
				expect(controller.takeNotices()).toEqual([expect.stringContaining("base URL is not valid")]);
			} finally {
				restore();
			}
		});

		it("records a verification's failure as its own answer when the settings file cannot be read", async () => {
			const { baseUrl } = await proxy("typed-key");
			const dir = agentDirWithoutPricing();
			writeFileSync(join(dir, "cliproxyapi.json"), "{not json");
			const controller = new CatalogController(dir, DEFAULT_PROVIDER_ID);
			const result = await controller.refresh({
				allowNetwork: true,
				force: true,
				verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
			});
			expect(result.verificationFailure).toMatchObject({ reason: "unavailable" });
			expect(controller.getLastError()).toBeUndefined();
		});

		it("always fetches a verification, even one asked not to use the network", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				const result = await controller.refresh({
					allowNetwork: false,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				expect(result.verificationFailure).toBeUndefined();
				expect(seen).toEqual(["Bearer typed-key"]);
			} finally {
				restore();
			}
		});

		it("checks a login's key at the base URL it entered without replacing the session's catalog", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: "http://127.0.0.1:1" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				const result = await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				expect(result.verificationFailure).toBeUndefined();
				expect(seen).toEqual(["Bearer typed-key"]);
				expect(controller.getModels()).toEqual([]);
			} finally {
				restore();
			}
		});

		it("always fetches a verification, even inside the throttle window of a recent fetch", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "typed-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				const result = await controller.refresh({
					allowNetwork: true,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				expect(result.verificationFailure).toBeUndefined();
				expect(seen).toEqual(["Bearer typed-key", "Bearer typed-key"]);
			} finally {
				restore();
			}
		});

		it("reports a failed verification at another base URL without changing the session's status", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				const result = await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: "http://127.0.0.1:1" },
				});
				expect(result.verificationFailure).toMatchObject({ reason: "unavailable" });
				expect(controller.getLastError()).toBeUndefined();
				expect(controller.getLastFailure()).toBeUndefined();
			} finally {
				restore();
			}
		});

		it("applies a verification's catalog when the session's own base URL cannot be read", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: "not a url" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				const result = await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				expect(result.verificationFailure).toBeUndefined();
				expect(controller.getModels().map((model) => model.meta.id)).toEqual(["verify-model"]);
			} finally {
				restore();
			}
		});

		it("does not hand a verification the answer of a refresh made with another key", async () => {
			const { baseUrl, seen } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "env-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				// The environment-key refresh is still in flight when the verification starts, as at extension load.
				const startup = controller.refresh({ allowNetwork: true });
				await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: baseUrl },
				});
				await startup;
				expect(controller.getLastFailure()).toBeUndefined();
				expect(seen).toContain("Bearer typed-key");
			} finally {
				restore();
			}
		});

		it("names the HTTP status of a key the proxy refuses with 403", async () => {
			const server = createServer((_request, response) => {
				response.writeHead(403, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { message: "forbidden" } }));
			});
			servers.push(server);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl, CLIPROXYAPI_API_KEY: "wrong-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({ allowNetwork: true });
				const notices = controller.takeNotices();
				expect(notices[0]).toContain("(HTTP 403)");
			} finally {
				restore();
			}
		});

		it("records a malformed base URL as a failed answer instead of rejecting", async () => {
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: "not a url", CLIPROXYAPI_API_KEY: "typed-key" });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await expect(
					controller.refresh({
						allowNetwork: true,
						force: true,
						verification: { apiKey: "typed-key", baseUrlInput: "not a url" },
					}),
				).resolves.toMatchObject({ verificationFailure: { reason: "unavailable" } });
				expect(controller.getLastFailure()).toBeUndefined();
			} finally {
				restore();
			}
		});

		it("keeps a correct key when CLIPROXYAPI_BASE_URL is malformed", async () => {
			const { baseUrl } = await proxy("typed-key");
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir });
			try {
				const login = (await registeredCpa()).oauth?.login;
				if (!login) throw new Error("no oauth login");
				process.env.CLIPROXYAPI_BASE_URL = "not a url";
				const answers = [baseUrl, "typed-key"];
				// A third question would mean the login looped on a hint, so it fails loudly instead of answering forever.
				const credential = await login({
					onAuth: () => {},
					onDeviceCode: () => {},
					onPrompt: async () => {
						const answer = answers.shift();
						if (answer === undefined) throw new Error("the login asked more questions than expected");
						return answer;
					},
					onSelect: async () => undefined,
				});
				expect(credential).toMatchObject({ access: "typed-key" });
			} finally {
				restore();
			}
		});

		it("an ordinary refresh uses the key the runtime resolves, not the stored login's", async () => {
			const { baseUrl, seen } = await proxy("env-key");
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(),
				CLIPROXYAPI_BASE_URL: baseUrl,
				CLIPROXYAPI_API_KEY: "env-key",
			});
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await expect(refreshModels(ordinaryContext("stored-key"))).resolves.toBeDefined();
				expect(seen).toEqual(["Bearer env-key"]);
			} finally {
				restore();
			}
		});

		it("an ordinary refresh that the proxy refuses throws nothing, as before login verification existed", async () => {
			const { baseUrl } = await proxy("other-key");
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(),
				CLIPROXYAPI_BASE_URL: baseUrl,
				CLIPROXYAPI_API_KEY: "env-key",
			});
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await expect(refreshModels(ordinaryContext("stored-key"))).resolves.toBeDefined();
			} finally {
				restore();
			}
		});

		it("a verification authenticates with the stored key and reports a refusal as rejected", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(), CLIPROXYAPI_BASE_URL: baseUrl });
			const verdicts: string[] = [];
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await expect(refreshModels(verificationContext("wrong-key", "api_key", verdicts))).rejects.toThrow(/401/);
				expect(verdicts).toEqual(["rejected"]);
			} finally {
				restore();
			}
		});

		it("a verification the proxy accepts reports the credential verified", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(), CLIPROXYAPI_BASE_URL: baseUrl });
			const verdicts: string[] = [];
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await refreshModels(verificationContext("typed-key", "api_key", verdicts));
				expect(verdicts).toEqual(["verified"]);
			} finally {
				restore();
			}
		});

		it("a verification reports a proxy that does not answer as unavailable", async () => {
			const closed = createServer();
			closed.listen(0, "127.0.0.1");
			await once(closed, "listening");
			const port = (closed.address() as AddressInfo).port;
			await new Promise<void>((resolve) => closed.close(() => resolve()));
			const restore = setEnv({
				NYAN_CODING_AGENT_DIR: agentDirWithoutPricing(),
				CLIPROXYAPI_BASE_URL: `http://127.0.0.1:${port}`,
			});
			const verdicts: string[] = [];
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await expect(refreshModels(verificationContext("typed-key", "api_key", verdicts))).rejects.toThrow();
				expect(verdicts).toEqual(["unavailable"]);
			} finally {
				restore();
			}
		});

		it("a verification of a stored login with no key is refused as rejected", async () => {
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDirWithoutPricing() });
			const verdicts: string[] = [];
			try {
				const refreshModels = (await registeredCpa()).refreshModels;
				if (!refreshModels) throw new Error("no refreshModels");
				await expect(refreshModels(verificationContext("  ", "api_key", verdicts))).rejects.toThrow(
					/no key to verify/,
				);
				expect(verdicts).toEqual(["rejected"]);
			} finally {
				restore();
			}
		});

		it("names the source of the key a connection uses, in the same order the connection reads it", () => {
			const agentDir = agentDirWithoutPricing();
			const restore = setEnv({ NYAN_CODING_AGENT_DIR: agentDir, CLIPROXYAPI_BASE_URL: "http://127.0.0.1:1" });
			try {
				writeFileSync(
					join(agentDir, AUTH_FILE_NAME),
					JSON.stringify({ [DEFAULT_PROVIDER_ID]: { type: "api_key", key: "stored-key" } }),
				);
				expect(apiKeySource(agentDir, DEFAULT_PROVIDER_ID)).toEqual({ kind: "stored" });
				expect(resolveConnection(agentDir, DEFAULT_PROVIDER_ID)?.apiKey).toBe("stored-key");

				saveConfig(agentDir, { apiKey: "config-key" });
				expect(apiKeySource(agentDir, DEFAULT_PROVIDER_ID)).toEqual({
					kind: "config",
					path: configPath(agentDir),
				});
				expect(resolveConnection(agentDir, DEFAULT_PROVIDER_ID)?.apiKey).toBe("config-key");

				process.env.CLIPROXYAPI_API_KEY = "env-key";
				expect(apiKeySource(agentDir, DEFAULT_PROVIDER_ID)).toEqual({ kind: "environment" });
				expect(resolveConnection(agentDir, DEFAULT_PROVIDER_ID)?.apiKey).toBe("env-key");
			} finally {
				restore();
			}
		});

		it("classifies a key the proxy refuses as rejected", async () => {
			const { baseUrl } = await proxy("typed-key");
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: baseUrl });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "wrong-key", baseUrlInput: baseUrl },
				});
				expect(controller.getLastFailure()).toMatchObject({ reason: "rejected" });
			} finally {
				restore();
			}
		});

		it("classifies a proxy that does not answer as unavailable, not as rejected", async () => {
			const closed = createServer();
			closed.listen(0, "127.0.0.1");
			await once(closed, "listening");
			const port = (closed.address() as AddressInfo).port;
			await new Promise<void>((resolve) => closed.close(() => resolve()));
			const restore = setEnv({ CLIPROXYAPI_BASE_URL: `http://127.0.0.1:${port}` });
			try {
				const controller = new CatalogController(agentDirWithoutPricing(), DEFAULT_PROVIDER_ID);
				await controller.refresh({
					allowNetwork: true,
					force: true,
					verification: { apiKey: "typed-key", baseUrlInput: `http://127.0.0.1:${port}` },
				});
				expect(controller.getLastFailure()).toMatchObject({ reason: "unavailable" });
			} finally {
				restore();
			}
		});
	});

	describe("pricing", () => {
		it("parses models.dev cost and computes usage cost", () => {
			const cost = parseModelsDevCost({ input: 3, output: 15, cache_read: 0.75, cache_write: 3.75 });
			expect(cost).toBeDefined();
			expect(cost?.input).toBe(3);
			expect(cost?.output).toBe(15);
			expect(cost?.cacheRead).toBe(0.75);

			const total = computeCost({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 }, cost!);
			// 1000*3 + 500*15 + 2000*0.75 = 3000 + 7500 + 1500 = 12000 / 1_000_000 = 0.012
			expect(total).toBe(0.012);
		});
	});
});
