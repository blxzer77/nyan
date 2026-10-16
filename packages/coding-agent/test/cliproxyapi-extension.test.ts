import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadCatalogCache, saveCatalogCache } from "../src/extensions/cliproxyapi/cache.ts";
import {
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	loadConfig,
	resolveEndpoints,
	saveConfig,
} from "../src/extensions/cliproxyapi/config.ts";
import { FastModeController, withPriorityServiceTier } from "../src/extensions/cliproxyapi/fast.ts";
import cliproxyApiExtension from "../src/extensions/cliproxyapi/index.ts";
import { buildThinkingLevelMap, compileOverrides, resolveOverride } from "../src/extensions/cliproxyapi/overrides.ts";
import { PauseController } from "../src/extensions/cliproxyapi/pause.ts";
import { computeCost, parseModelsDevCost } from "../src/extensions/cliproxyapi/pricing.ts";
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
