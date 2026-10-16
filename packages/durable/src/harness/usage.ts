import type { Usage } from "@ny4n/ai/contracts";
import { copyJson, type Draft, type JsonRepresentation } from "@ny4n/chord";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

/** Ledger of one conversation's own spend: its entries, and compaction summarization attempts, which have none. */
export type UsageState = {
	/** Assistant entries and summarization attempts, keyed `provider/modelId`. */
	models: Record<string, JsonRepresentation<Usage>>;
	/** Tool results, keyed by tool name; their usage has no model identity. */
	tools: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "nyan.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** Add `usage` to one bucket of the conversation's `nyan.usage`, in the commit that records the response. */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// Own keys only: a tool may be called `toString`.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	else addUsage(total, usage);
}

/** Add every counter of `usage` to `total`; optional counters are added once either side reports them. */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
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
}

/** Add every bucket of `state` into `sum`. */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
			if (total !== undefined) addUsage(total, usage);
			else
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}

const USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function finiteCounters(value: unknown, keys: readonly string[]): boolean {
	if (value === null || typeof value !== "object") return false;
	return keys.every((key) => Number.isFinite((value as Record<string, unknown>)[key]));
}

/**
 * Why `usage`, which a hook supplied, cannot be added to the ledger, or `undefined` when it can. `recordUsage` runs
 * inside a commit, where a missing or non-finite counter, or a value that is not strict JSON, would throw and fault the
 * task. The optional counters count too: a string would be concatenated, not added.
 */
export function usageProblem(usage: unknown): string | undefined {
	if (!finiteCounters(usage, USAGE_COUNTERS) || !finiteCounters((usage as { cost?: unknown }).cost, COST_COUNTERS)) {
		return "its usage or cost has a missing or non-finite counter";
	}
	const optional = usage as { cacheWrite1h?: unknown; reasoning?: unknown };
	for (const [name, value] of Object.entries({ cacheWrite1h: optional.cacheWrite1h, reasoning: optional.reasoning })) {
		if (value !== undefined && !Number.isFinite(value)) return `its usage counter ${name} is not a finite number`;
	}
	try {
		copyJson(usage as Usage, { omitUndefinedProperties: true });
	} catch (error) {
		return `its usage is not strict JSON: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}
