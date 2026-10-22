import type { EntryId } from "../types.ts";
import type { ContextLayout } from "./types.ts";

/**
 * Identity of one context read and the cut selected from it (section 8.8), compared instead of hashing the summarized
 * content: entries are immutable and their ids increase, and the active list after a marker is fixed by that marker's
 * id, so the triple identifies both the summarized prefix and the read that produced it.
 */
export type ContextBasis = {
	/** The head marker in effect, or absent when the context starts at the transcript's first entry. */
	readonly head: EntryId | undefined;
	/** How many active entries the summary covers, the head marker included. */
	readonly entryCount: number;
	/** Newest entry of the read, the value `SummaryRequest.tail` pins while a summary is written. */
	readonly tailId: EntryId;
};

/**
 * The basis of `layout` cut at `cut`: the summary covers the entries before `cut` and keeps the rest. A later read
 * recomputes it; a different triple means an entry was appended, the cut moved, or another marker took over, so the
 * summary no longer describes this context and must not be committed (section 8.8).
 *
 * `cut` counts entries, so it runs from 1 (the head marker alone, or the first entry) to `entries.length` (the whole
 * context summarized). A context with no entry has neither a cut nor a basis.
 */
export function basisOf(layout: ContextLayout, cut: number): ContextBasis {
	const entries = layout.entries;
	if (!Number.isInteger(cut) || cut < 1 || cut > entries.length) {
		throw new RangeError(`Cut ${cut} does not cover 1 to ${entries.length} entries of the context`);
	}
	return { head: layout.head?.id, entryCount: cut, tailId: entries[entries.length - 1]!.id };
}
