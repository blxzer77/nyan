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

/**
 * Add `usage` to one bucket of the conversation's `nyan.usage`, in the commit that records the response. A sum that is
 * not finite, such as two `1e308` costs, is not added: the ledger stays as it was and the result says why, so a caller
 * can drop the usage instead of throwing inside the commit, which would fault its task.
 */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<string | undefined> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	// Own keys only: a tool may be called `toString`.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	if (total === undefined) {
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
		return undefined;
	}
	const overflow = overflowingCounter(total, usage);
	if (overflow !== undefined) {
		return `adding it would make the ledger's ${overflow} counter for ${JSON.stringify(key)} not finite`;
	}
	addUsage(total, usage);
	return undefined;
}

/**
 * `recordUsage` for spend the Harness itself measured, a provider's response: a sum that is not finite is a broken
 * invariant, not something to drop, so the commit throws.
 */
export async function recordProviderUsage(
	tx: Tx,
	conversationId: ConversationId,
	key: string,
	usage: Usage,
): Promise<void> {
	const problem = await recordUsage(tx, conversationId, "models", key, usage);
	if (problem !== undefined) throw new Error(`The usage of ${key} cannot be recorded: ${problem}`);
}

/** The first counter whose sum with `usage` is not finite, or `undefined` when `addUsage` keeps them all finite. */
function overflowingCounter(total: Readonly<Usage>, usage: Usage): string | undefined {
	for (const name of USAGE_COUNTERS) if (!Number.isFinite(total[name] + usage[name])) return name;
	for (const name of OPTIONAL_COUNTERS) {
		const added = usage[name];
		if (added !== undefined && !Number.isFinite((total[name] ?? 0) + added)) return name;
	}
	for (const name of COST_COUNTERS) if (!Number.isFinite(total.cost[name] + usage.cost[name])) return `cost.${name}`;
	return undefined;
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
const OPTIONAL_COUNTERS = ["cacheWrite1h", "reasoning"] as const;
const COST_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** A counter the ledger can add: a finite number, and not negative, since spend never gives tokens or money back. */
function countable(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function countableCounters(value: unknown, keys: readonly string[]): boolean {
	if (value === null || typeof value !== "object") return false;
	return keys.every((key) => countable((value as Record<string, unknown>)[key]));
}

/** The first own key of `value` that is not in `known`, or `undefined`. A key set to `undefined` is dropped when stored. */
function unknownKey(value: object, known: readonly string[]): string | undefined {
	return Object.entries(value).find(([key, item]) => item !== undefined && !known.includes(key))?.[0];
}

/**
 * Why `usage`, which a hook or a tool supplied, cannot be added to the ledger, or `undefined` when it can.
 * `recordUsage` runs inside a commit, where a missing, negative or non-finite counter, or a value that is not strict
 * JSON, would throw or corrupt the ledger. The optional counters count too: a string would be concatenated, not added.
 * Fields the ledger does not add are refused, since the ledger would store them unchecked.
 */
export function usageProblem(usage: unknown): string | undefined {
	if (
		!countableCounters(usage, USAGE_COUNTERS) ||
		!countableCounters((usage as { cost?: unknown }).cost, COST_COUNTERS)
	) {
		return "its usage or cost has a missing, negative or non-finite counter";
	}
	const shape = usage as { cost: object };
	const extraCost = unknownKey(shape.cost, COST_COUNTERS);
	const extra =
		unknownKey(shape, [...USAGE_COUNTERS, ...OPTIONAL_COUNTERS, "cost"]) ??
		(extraCost === undefined ? undefined : `cost.${extraCost}`);
	if (extra !== undefined) return `its usage has a field the ledger does not count: ${extra}`;
	const optional = usage as Record<(typeof OPTIONAL_COUNTERS)[number], unknown>;
	for (const name of OPTIONAL_COUNTERS) {
		if (optional[name] !== undefined && !countable(optional[name])) {
			return `its usage counter ${name} is not a finite, non-negative number`;
		}
	}
	try {
		copyJson(usage as Usage, { omitUndefinedProperties: true });
	} catch (error) {
		return `its usage is not strict JSON: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}
