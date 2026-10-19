import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@ny4n/ai";
import { copyJson, type Draft, type JsonRepresentation } from "@ny4n/chord";
import type { UsageState } from "@ny4n/durable";
import {
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmingStatus,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
	MAX_IDLE_WARMING_AGE_MS,
	MAX_WARMING_AGE_MS,
} from "../cache-warmer.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { CacheWarmingMode } from "../settings-manager.ts";

/** The request whose prompt cache entry should be kept warm, exactly as the conversation sent it. */
export interface DurableCacheWarmRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
}

export interface DurableCacheWarmerOptions {
	/** Sends the refresh: the same provider runtime the real request went through. */
	readonly models: Pick<ModelRuntime, "streamSimple">;
	/** nyan's `cacheWarming` setting; read on every decision, so a change needs no listener. */
	readonly getMode: () => CacheWarmingMode;
	/** Asks the session's extensions; a handler may replace nyan's action. */
	readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Prompt size of the last answer on the conversation, as the provider reported it. */
	readonly promptTokens: () => number;
	/** Whether the conversation still extends the request this run warms; checked before each refresh. */
	readonly isCurrent: (request: DurableCacheWarmRequest) => boolean;
	/** Adds one refresh's usage to the conversation's ledger, in one commit. */
	readonly recordUsage: (model: Model<Api>, usage: Usage) => Promise<void>;
	/** Reports a refresh whose outcome is unknown, or usage the ledger refused. Never a success. */
	readonly report: (message: string) => void;
}

interface ActiveWarmRun extends DurableCacheWarmRequest {
	readonly ttlMs: number;
	readonly delayMs: number;
	/** Latest safe time to send this refresh, keeping half of the original expiry margin. */
	refreshDeadlineAt: number;
	readonly startedAt: number;
	readonly controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry warm on the durable path.
 *
 * Durable's generation task owns the conversation's requests; this owns only the refreshes, which append nothing and
 * settle nothing. Its state is in memory by design: a restart reopens the conversation and the next real request starts
 * a new run. The policy, the TTL and delay rules, and the economics are the legacy session's (`cache-warmer.ts`), so
 * `streaming`, `idle`, and `off` mean the same thing on both paths.
 */
export class DurableCacheWarmer {
	readonly #options: DurableCacheWarmerOptions;
	#run?: ActiveWarmRun;
	#inactive: CacheWarmingStatus = { state: "inactive", reason: "waiting for first request" };

	constructor(options: DurableCacheWarmerOptions) {
		this.#options = options;
	}

	get status(): CacheWarmingStatus {
		if (this.#options.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.#run;
		if (run === undefined) return this.#inactive;
		if (!this.#options.isCurrent(run)) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.#evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return refreshing
			? { state: "refreshing", nextWarmAt: run.nextWarmAt, decision }
			: { state: "scheduled", nextWarmAt: run.nextWarmAt, decision };
	}

	/**
	 * Keep the request a real request just sent warm. A new request replaces the previous run, so no refresh can race
	 * the request it would have warmed for.
	 */
	start(request: DurableCacheWarmRequest): void {
		this.#clearRun();
		const mode = this.#options.getMode();
		if (mode === "off") {
			this.#stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.#stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.#stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.#stop("cache lifetime unavailable");
			return;
		}
		const run: ActiveWarmRun = {
			...request,
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
		};
		this.#run = run;
		this.#schedule(run);
	}

	/** The run ended: `streaming` warming stops here, `idle` warming continues under its own horizon. */
	onAgentSettled(): void {
		const run = this.#run;
		if (run === undefined) return;
		if (this.#options.getMode() === "streaming") {
			this.#stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) this.#stop("30-minute idle safety limit reached");
	}

	/** The conversation moved (a fork, a conversation switch, a model change, or the closing session). */
	cancel(reason = "inactive"): void {
		this.#stop(reason);
	}

	#clearRun(): void {
		const run = this.#run;
		if (run === undefined) return;
		this.#run = undefined;
		if (run.timer !== undefined) clearTimeout(run.timer);
		run.controller.abort();
	}

	#stop(reason: string, decision?: CacheWarmingDecision): void {
		this.#clearRun();
		this.#inactive = { state: "inactive", reason, ...(decision === undefined ? {} : { decision }) };
	}

	#schedule(run: ActiveWarmRun): void {
		run.nextWarmAt = Date.now() + run.delayMs;
		// A timer can run late after sleep or event-loop blockage; keep half of the planned pre-expiry margin for that
		// delay and request dispatch, because a late refresh is likely a full-price cache write, not a warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.#stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.#refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	async #refresh(run: ActiveWarmRun): Promise<void> {
		run.timer = undefined;
		if (!this.#validateRun(run)) return;
		if (this.#deadlineMissed(run)) return;
		const decision = this.#evaluate(run);
		let action = decision.action;
		try {
			action = await this.#options.decide({
				type: "cache_warming_decision",
				warmCost: decision.warmCost,
				missCost: decision.missCost,
				continuationProbability: decision.continuationProbability,
				action,
			});
		} catch {
			// An extension's failure falls back to nyan's own decision; the runner reports it separately.
		}
		if (!this.#validateRun(run)) return;
		if (this.#deadlineMissed(run)) return;
		if (action === "stop") {
			this.#stop(
				action === decision.action
					? decision.economicsAvailable
						? "expected savings below threshold"
						: "cache economics unavailable"
					: "stopped by extension",
				decision,
			);
			return;
		}
		// The refresh is the real request with a one-token output cap and its own signal: the same model, messages,
		// provider session, thinking level, and request transforms, so it writes the same cache entry.
		const options: SimpleStreamOptions = {
			...run.options,
			maxTokens: 1,
			maxRetries: 0,
			signal: run.controller.signal,
		};
		try {
			const message = await this.#options.models.streamSimple(run.model, run.context, options).result();
			if (!this.#validateRun(run)) return;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				this.#options.report(
					`Cache refresh for ${run.model.provider}/${run.model.id} did not answer: ${message.errorMessage ?? message.stopReason}`,
				);
			} else {
				await this.#options.recordUsage(run.model, message.usage);
			}
		} catch (error) {
			// An aborted refresh is the run being cancelled, which `clearRun` already explains.
			if (this.#run === run) {
				this.#options.report(
					`Cache refresh for ${run.model.provider}/${run.model.id} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (this.#run === run) this.#schedule(run);
	}

	#deadlineMissed(run: ActiveWarmRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.#stop("cache refresh deadline missed");
		return true;
	}

	#validateRun(run: ActiveWarmRun): boolean {
		if (this.#run !== run) return false;
		const mode = this.#options.getMode();
		const reason =
			mode === "off"
				? "cache warming disabled"
				: mode === "streaming" && run.phase === "idle"
					? "agent run settled"
					: !this.#options.isCurrent(run)
						? "conversation context changed"
						: undefined;
		if (reason === undefined) return true;
		this.#stop(reason);
		return false;
	}

	#evaluate(run: ActiveWarmRun): CacheWarmingDecision {
		return evaluateCacheWarming({
			model: run.model,
			promptTokens: this.#options.promptTokens(),
			phase: run.phase,
		});
	}
}

const WARM_USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const WARM_OPTIONAL_COUNTERS = ["cacheWrite1h", "reasoning"] as const;
const WARM_COST_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/**
 * Add one refresh's usage to a `nyan.usage` bucket, which is the ledger durable's own provider usage goes into, keyed
 * `provider/modelId` like the conversation's answers. Durable exports the ledger document but not its `recordUsage`
 * helper, so the sum is repeated here with the same rule: a counter that would stop being finite is not added, and the
 * caller drops the usage and reports why, rather than throwing inside the commit.
 *
 * Returns the reason the usage was not added, or `undefined` when it was.
 */
export function addWarmUsage(totals: Draft<UsageState["models"]>, key: string, usage: Usage): string | undefined {
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	if (total === undefined) {
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
		return undefined;
	}
	for (const name of WARM_USAGE_COUNTERS) {
		if (!Number.isFinite(total[name] + usage[name])) return `${name} would stop being finite`;
	}
	for (const name of WARM_OPTIONAL_COUNTERS) {
		const added = usage[name];
		if (added !== undefined && !Number.isFinite((total[name] ?? 0) + added)) return `${name} would stop being finite`;
	}
	for (const name of WARM_COST_COUNTERS) {
		if (!Number.isFinite(total.cost[name] + usage.cost[name])) return `cost.${name} would stop being finite`;
	}
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
	return undefined;
}
