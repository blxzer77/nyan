import type { Message } from "@ny4n/ai/contracts";
import type { EntryId, EntryRecord } from "../types.ts";

/**
 * The part of a `ContextView` (section 9.3) the context primitives read: the head marker, the active entries, and each
 * entry's model messages after edits. Structural, so `ContextView` and a hand-built fixture are both accepted, and the
 * primitives stay free of the harness.
 */
export type ContextLayout = {
	/** Newest applicable head marker, if any. It is `entries[0]` whenever it exists. */
	readonly head: { readonly id: EntryId } | undefined;
	/** Raw active entries: the head marker followed by the non-head entries of the range. */
	readonly entries: readonly EntryRecord[];
	/** Per entry of `entries`, its model messages, before tool result ordering. */
	readonly contributions: readonly (readonly Message[])[];
};
