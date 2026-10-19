import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Message, Model, Usage } from "@ny4n/ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import type { UsageState } from "@ny4n/durable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CacheWarmingDecisionEvent,
	type CacheWarmingStatus,
	getCacheWarmingDelayMs,
} from "../src/core/cache-warmer.ts";
import { addWarmUsage, DurableCacheWarmer, type DurableCacheWarmRequest } from "../src/core/durable/cache-warmer.ts";
import { openDurable } from "../src/core/durable/runtime.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";

/**
 * Cache warming on the durable path: the legacy policy (`streaming`, `idle`, `off`, the dollar threshold) applied to the
 * request durable's generation task actually sends, with the refresh's spend committed to the conversation's ledger.
 */

const usage: Usage = {
	input: 10,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 111,
	cost: { input: 0.0003, output: 0.000075, cacheRead: 0.0003, cacheWrite: 0, total: 0.000675 },
};

/** A model with prices that make a refresh worthwhile at a 100 000-token prompt, and a five-prompt cache tier. */
const model = {
	id: "test-model",
	name: "Test",
	provider: "test",
	// Not Anthropic budget-based thinking: the one-token output cap does not change this request's cache key.
	api: "openai-completions",
	reasoning: true,
	input: ["text"],
	cost: { input: 30, output: 75, cacheRead: 3, cacheWrite: 37.5 },
	contextWindow: 200_000,
	maxTokens: 8192,
	promptCache: { short: 100, long: 3600 },
} as unknown as Model<Api>;

const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }];
const context = { messages } as Context;

function request(requestModel: Model<Api> = model): DurableCacheWarmRequest {
	return {
		model: requestModel,
		context,
		options: { sessionId: "session-1", reasoning: "high", timeoutMs: 1000 },
	};
}

function answer(options: { maxTokens?: number } | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "test",
		model: model.id,
		usage,
		stopReason: options?.maxTokens === 1 ? "length" : "stop",
		timestamp: 2,
	};
}

interface Harness {
	readonly warmer: DurableCacheWarmer;
	readonly streamSimple: ReturnType<typeof vi.fn>;
	readonly recordUsage: ReturnType<typeof vi.fn>;
	readonly decide: ReturnType<typeof vi.fn>;
	readonly reports: string[];
	setMode(mode: CacheWarmingMode): void;
	setCurrent(current: boolean): void;
	readonly status: () => CacheWarmingStatus;
}

function harness(
	options: {
		readonly mode?: CacheWarmingMode;
		readonly promptTokens?: number;
		readonly reply?: (model: Model<Api>, options: unknown) => Promise<AssistantMessage>;
	} = {},
): Harness {
	let mode: CacheWarmingMode = options.mode ?? "streaming";
	let current = true;
	const reports: string[] = [];
	const recordUsage = vi.fn(async () => {});
	const decide = vi.fn(async (event: CacheWarmingDecisionEvent) => event.action);
	const reply =
		options.reply ??
		(async (_model: Model<Api>, sent: unknown) => answer(sent as { maxTokens?: number } | undefined));
	/** The warmer's provider: one call per refresh, answering with `reply`. */
	const streamSimple = vi.fn((sentModel: Model<Api>, _context: Context, sent: unknown) => ({
		result: async () => reply(sentModel, sent),
	}));
	const warmer = new DurableCacheWarmer({
		models: { streamSimple: streamSimple as never },
		getMode: () => mode,
		decide,
		promptTokens: () => options.promptTokens ?? 100_000,
		isCurrent: () => current,
		recordUsage,
		report: (message) => reports.push(message),
	});
	return {
		warmer,
		streamSimple,
		recordUsage,
		decide,
		reports,
		setMode: (next) => {
			mode = next;
		},
		setCurrent: (next) => {
			current = next;
		},
		status: () => warmer.status,
	};
}

const delay = getCacheWarmingDelayMs(100_000)!;

describe("durable cache warming", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("warms while the run continues, and records the refresh in the ledger", async () => {
		const test_ = harness();
		test_.warmer.start(request());
		expect(test_.status()).toMatchObject({ state: "scheduled", decision: { phase: "streaming", action: "warm" } });

		await vi.advanceTimersByTimeAsync(delay);

		expect(test_.streamSimple).toHaveBeenCalledTimes(1);
		const [sentModel, sentContext, sentOptions] = test_.streamSimple.mock.calls[0]!;
		// The refresh is the real request: same model object, same messages, same provider session and thinking level,
		// with only the output cap, the retries, and the signal replaced.
		expect(sentModel).toBe(model);
		expect(sentContext).toBe(context);
		expect(sentOptions).toMatchObject({
			sessionId: "session-1",
			reasoning: "high",
			timeoutMs: 1000,
			maxTokens: 1,
			maxRetries: 0,
		});
		expect(sentOptions.signal).toBeInstanceOf(AbortSignal);
		expect(sentOptions.signal.aborted).toBe(false);
		// The spend is committed through the injected ledger writer, not kept in memory.
		expect(test_.recordUsage).toHaveBeenCalledTimes(1);
		expect(test_.recordUsage).toHaveBeenCalledWith(model, usage);
		expect(test_.reports).toEqual([]);
		// Warming continues for the next refresh interval.
		expect(test_.status()).toMatchObject({ state: "scheduled" });
	});

	test("keeps warming after the run settles in idle mode", async () => {
		const test_ = harness({ mode: "idle" });
		test_.warmer.start(request());
		test_.warmer.onAgentSettled();

		expect(test_.status()).toMatchObject({
			decision: { phase: "idle", continuationProbability: 0.15, action: "warm" },
		});
		await vi.advanceTimersByTimeAsync(delay);
		expect(test_.streamSimple).toHaveBeenCalledTimes(1);
	});

	test("stops when the run settles in streaming mode", async () => {
		const test_ = harness();
		test_.warmer.start(request());
		test_.warmer.onAgentSettled();

		expect(test_.status()).toEqual({ state: "inactive", reason: "agent run settled" });
		await vi.advanceTimersByTimeAsync(delay * 4);
		expect(test_.streamSimple).not.toHaveBeenCalled();
	});

	test("never warms with cache warming off", async () => {
		const test_ = harness({ mode: "off" });
		test_.warmer.start(request());

		expect(test_.status()).toEqual({ state: "inactive", reason: "cache warming disabled" });
		await vi.advanceTimersByTimeAsync(delay * 4);
		expect(test_.streamSimple).not.toHaveBeenCalled();
	});

	test("does not warm when the expected saving is below the threshold", async () => {
		const test_ = harness({ promptTokens: 100 });
		test_.warmer.start(request());

		expect(test_.status()).toMatchObject({
			state: "scheduled",
			decision: { economicsAvailable: true, action: "stop" },
		});
		await vi.advanceTimersByTimeAsync(delay);
		expect(test_.streamSimple).not.toHaveBeenCalled();
		expect(test_.status()).toMatchObject({ state: "inactive", reason: "expected savings below threshold" });
	});

	test("a new real request replaces the run instead of racing it", async () => {
		const test_ = harness();
		test_.warmer.start(request());
		await vi.advanceTimersByTimeAsync(delay - 1);
		const second = { ...request(), context: { messages: [...messages] } as Context };
		test_.warmer.start(second);
		// The replaced run's timer is gone, not merely ignored when it fires.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		expect(test_.streamSimple).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(delay);
		expect(test_.streamSimple).toHaveBeenCalledTimes(1);
		expect(test_.streamSimple.mock.calls[0]![1]).toBe(second.context);
	});

	test("cancelling leaves no timer and no request", async () => {
		const test_ = harness();
		test_.warmer.start(request());
		test_.warmer.cancel("session closed");

		expect(test_.status()).toEqual({ state: "inactive", reason: "session closed" });
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(delay * 4);
		expect(test_.streamSimple).not.toHaveBeenCalled();
	});

	test("a decided stop ends warming with the extension as the reason", async () => {
		const test_ = harness();
		test_.decide.mockImplementation(async () => "stop");
		test_.warmer.start(request());
		await vi.advanceTimersByTimeAsync(delay);

		expect(test_.streamSimple).not.toHaveBeenCalled();
		expect(test_.status()).toMatchObject({ state: "inactive", reason: "stopped by extension" });
		// The economics of the fake model at a 100 000-token prompt: a cache read plus one output token, against losing
		// the 3.75-dollar cache write.
		const asked = test_.decide.mock.calls[0]![0];
		expect(asked).toMatchObject({ type: "cache_warming_decision", continuationProbability: 1, action: "warm" });
		expect(asked.warmCost).toBeCloseTo(0.300075, 10);
		expect(asked.missCost).toBeCloseTo(3.45, 10);
	});

	test("a failed refresh is reported, never recorded, and warming continues", async () => {
		const failing = harness({
			reply: async () => {
				throw new Error("socket closed");
			},
		});
		failing.warmer.start(request());
		await vi.advanceTimersByTimeAsync(delay);

		expect(failing.recordUsage).not.toHaveBeenCalled();
		expect(failing.reports).toEqual(["Cache refresh for test/test-model failed: socket closed"]);
		expect(failing.status()).toMatchObject({ state: "scheduled" });

		const errored = harness({
			reply: async () => ({ ...answer(undefined), stopReason: "error", errorMessage: "503" }),
		});
		errored.warmer.start(request());
		await vi.advanceTimersByTimeAsync(delay);

		expect(errored.recordUsage).not.toHaveBeenCalled();
		expect(errored.reports).toEqual(["Cache refresh for test/test-model did not answer: 503"]);
	});

	test("stops when the conversation no longer extends the request", async () => {
		const test_ = harness();
		test_.warmer.start(request());
		test_.setCurrent(false);
		expect(test_.status()).toEqual({ state: "inactive", reason: "conversation context changed" });

		test_.setCurrent(true);
		test_.warmer.start(request());
		test_.setCurrent(false);
		await vi.advanceTimersByTimeAsync(delay);
		expect(test_.streamSimple).not.toHaveBeenCalled();
	});

	test("does not replay a request whose cache key the output cap would change", async () => {
		const budgeted = { ...model, api: "anthropic-messages", compat: undefined } as unknown as Model<Api>;
		const test_ = harness();
		test_.warmer.start({ ...request(budgeted), options: { reasoning: "high" } });
		// Anthropic budget-based thinking derives `budget_tokens` from `max_tokens`, which the refresh changes.
		expect(test_.status()).toEqual({ state: "inactive", reason: "request cannot be replayed safely" });
	});
});

describe("cache warming usage in the durable ledger", () => {
	test("sums one refresh into the model's bucket", () => {
		const totals: Record<string, Usage> = {};
		const bucket = totals as unknown as Parameters<typeof addWarmUsage>[0];
		expect(addWarmUsage(bucket, "test/test-model", usage)).toBeUndefined();
		expect(addWarmUsage(bucket, "test/test-model", usage)).toBeUndefined();
		expect(totals["test/test-model"]).toEqual({
			input: 20,
			output: 2,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 222,
			cost: { input: 0.0006, output: 0.00015, cacheRead: 0.0006, cacheWrite: 0, total: 0.00135 },
		});
	});

	test("refuses a sum that would stop being finite", () => {
		const huge: Usage = { ...usage, cost: { ...usage.cost, total: 1e308 } };
		const totals = { "test/test-model": huge };
		const bucket = totals as unknown as Parameters<typeof addWarmUsage>[0];
		expect(addWarmUsage(bucket, "test/test-model", huge)).toBe("cost.total would stop being finite");
		expect(totals["test/test-model"]!.cost.total).toBe(1e308);
	});
});

/**
 * The wiring, end to end: a real durable session keeps its prompt cache warm during a tool turn, and the refresh's spend
 * reaches the conversation's `nyan.usage` ledger through a commit. Real timers, because the warm delay and the tool are
 * the clock.
 */
describe("cache warming on a durable session", () => {
	let home: string;
	let cwd: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-warm-home-"));
		cwd = await mkdtemp(join(tmpdir(), "nyan-warm-cwd-"));
		await mkdir(join(home, ".nyan", "agent"), { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("NYAN_CODING_AGENT_DIR", join(home, ".nyan", "agent"));
		vi.stubEnv("NYAN_OFFLINE", "1");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	test("warms during a tool turn and commits the refresh to the ledger", async () => {
		const faux = fauxProvider({
			models: [{ id: "faux-1", reasoning: true, cost: { input: 30, output: 75, cacheRead: 3, cacheWrite: 37.5 } }],
		});
		// An 11-second cache tier: the refresh is scheduled one second after the real request.
		faux.getModel().promptCache = { short: 11 };
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { text: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("warm")]),
			fauxAssistantMessage([fauxText("answer")]),
		]);
		const slowTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "slow",
				label: "Slow",
				description: "Sleeps, so the run is still active when the refresh is due.",
				parameters: Type.Object({ text: Type.String() }),
				execute: async () => {
					await new Promise((resolve) => setTimeout(resolve, 1500));
					return { content: [{ type: "text" as const, text: "slept" }], details: undefined };
				},
			});
		};
		const model = faux.getModel();
		const durable = await openDurable({
			cwd,
			extensionFactories: [(pi) => pi.registerProvider(faux.provider), slowTool],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: {
				cwd,
				mode: "print",
				hasUI: false,
				ui: {
					select: async () => undefined,
					confirm: async () => false,
					input: async () => undefined,
					notify: () => {},
				},
			},
		});
		const ledger = (): UsageState =>
			(durable.view.current().conversation.docs["nyan.usage"] ?? { models: {}, tools: {} }) as UsageState;
		const settle = async (until: () => boolean, what: string): Promise<void> => {
			const deadline = Date.now() + 20_000;
			while (!until()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		try {
			// A prompt long enough that the refresh is expected to save more than the threshold.
			void durable.controller.submit(`say hi ${"context ".repeat(2000)}`, "steer");
			await settle(() => ledger().models["faux/faux-1"] !== undefined, "the first request's usage");
			const before = ledger().models["faux/faux-1"]!;
			await settle(
				() => faux.state.callCount >= 2 && ledger().models["faux/faux-1"]!.totalTokens > before.totalTokens,
				"the refresh",
			);
			const after = ledger().models["faux/faux-1"]!;

			// The refresh is the request's own prompt: every token it read came from the cache entry the real request
			// wrote, which is only true when the refresh sent the same messages, session, and thinking level.
			expect(after.cacheRead - before.cacheRead).toBe(before.cacheRead + before.input);
			expect(after.input - before.input).toBe(0);
			expect(after.cacheWrite - before.cacheWrite).toBe(0);
			// The scripted refresh answered "warm": four characters, one token.
			expect(after.output - before.output).toBe(1);
			expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
		} finally {
			await durable.close();
		}
	}, 30_000);
});
