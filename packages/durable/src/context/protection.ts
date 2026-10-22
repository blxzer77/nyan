import type { EntryId } from "../types.ts";
import type { ContextLayout } from "./types.ts";

/** Why one position of a context is protected (section 8.8). */
export type ProtectionReason = "system" | "first-user-after-head" | "in-flight-turn" | "fact";

/** A position's protection. `reason` is present exactly when `protected` is true. */
export type Protection =
	| { readonly protected: false; readonly reason?: never }
	| { readonly protected: true; readonly reason: ProtectionReason };

/** What the caller knows about the conversation the context belongs to. */
export type ProtectionOptions = {
	/**
	 * First entry of the run that is still in flight, from `nyan.live.run`. Every entry at or after it belongs to the
	 * turn the model is working on, so the turn is never masked and never summarized.
	 */
	readonly inFlightFrom?: EntryId;
	/**
	 * Whether an entry is a protected fact. N5 supplies this from its fact markers; N4 passes nothing and no position is
	 * protected for that reason.
	 */
	readonly isProtectedFact?: (entryId: EntryId) => boolean;
};

const UNPROTECTED: Protection = { protected: false };

/**
 * Whether the active entry at `index` is protected (section 8.8). A protected position is never masked, and is never
 * the entry a summary starts at; `in-flight-turn` and `fact` are never summarized at all.
 *
 * The reason reported is the strictest that applies (`in-flight-turn`, `fact`, `system`, `first-user-after-head`), so a
 * caller that acts on the reason never summarizes a turn that must survive verbatim. Positions are `0` to
 * `entries.length - 1`; anything else throws, because a position that is not an entry cannot be answered.
 */
export function isProtected(layout: ContextLayout, index: number, options: ProtectionOptions = {}): Protection {
	if (!Number.isInteger(index) || index < 0 || index >= layout.entries.length) {
		throw new RangeError(
			`Context position ${index} is not an entry: the context has ${layout.entries.length} entries`,
		);
	}
	const entry = layout.entries[index]!;
	if (options.inFlightFrom !== undefined && entry.id >= options.inFlightFrom) {
		return { protected: true, reason: "in-flight-turn" };
	}
	if (options.isProtectedFact?.(entry.id) === true) return { protected: true, reason: "fact" };
	const contributed = layout.contributions[index] ?? [];
	if (contributed.some((message) => message.role === "system")) return { protected: true, reason: "system" };
	if (firstUserPosition(layout) === index) return { protected: true, reason: "first-user-after-head" };
	return UNPROTECTED;
}

/**
 * Position of the first entry that begins with a user message, at or after the head marker: the request a summary must
 * not make its own start. `undefined` when every entry opens with something else.
 */
function firstUserPosition(layout: ContextLayout): number | undefined {
	const start = layout.head === undefined ? 0 : 1;
	for (let index = start; index < layout.entries.length; index++) {
		if (layout.contributions[index]?.[0]?.role === "user") return index;
	}
	return undefined;
}
