import type { Message } from "@ny4n/ai/contracts";
import { describe, expect, it } from "vitest";
import { basisOf, type ContextBasis } from "../src/context/basis.ts";
import type { ContextLayout } from "../src/context/types.ts";
import { idFromNumber } from "../src/ids.ts";
import { type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "../src/types.ts";

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

/** A context whose entries are numbered from 1; `head` makes the first entry the head marker. */
function layoutOf(count: number, head = false): ContextLayout {
	const entries: EntryRecord[] = Array.from({ length: count }, (_, index) => ({
		id: idFromNumber<EntryId>(index + 1),
		conversationId: ROOT_CONVERSATION_ID,
		kind: index === 0 && head ? "nyan.compaction" : "nyan.test",
	}));
	return {
		head: head ? entries[0] : undefined,
		entries,
		contributions: entries.map((entry) => [userMessage(`${entry.id}`)]),
	};
}

type Row = {
	readonly name: string;
	readonly count: number;
	readonly head?: boolean;
	readonly cut: number;
	readonly expected: ContextBasis;
};

describe("basisOf", () => {
	const rows: readonly Row[] = [
		{
			name: "a context under a head marker",
			count: 3,
			head: true,
			cut: 2,
			expected: { head: idFromNumber<EntryId>(1), entryCount: 2, tailId: idFromNumber<EntryId>(3) },
		},
		{
			name: "a context without a head marker",
			count: 2,
			cut: 1,
			expected: { head: undefined, entryCount: 1, tailId: idFromNumber<EntryId>(2) },
		},
		{
			name: "a cut that covers the whole context",
			count: 3,
			head: true,
			cut: 3,
			expected: { head: idFromNumber<EntryId>(1), entryCount: 3, tailId: idFromNumber<EntryId>(3) },
		},
	];
	for (const row of rows) {
		it(`describes ${row.name}`, () => {
			expect(basisOf(layoutOf(row.count, row.head ?? false), row.cut)).toStrictEqual(row.expected);
		});
	}

	it("distinguishes two cuts of the same context", () => {
		const context = layoutOf(3, true);
		expect(basisOf(context, 1)).not.toStrictEqual(basisOf(context, 2));
	});

	const refused: readonly { readonly count: number; readonly cut: number; readonly message: string }[] = [
		{ count: 3, cut: 0, message: "Cut 0 does not cover 1 to 3 entries of the context" },
		{ count: 3, cut: 4, message: "Cut 4 does not cover 1 to 3 entries of the context" },
		{ count: 3, cut: 1.5, message: "Cut 1.5 does not cover 1 to 3 entries of the context" },
		{ count: 0, cut: 1, message: "Cut 1 does not cover 1 to 0 entries of the context" },
	];
	for (const row of refused) {
		it(`refuses cut ${row.cut} of ${row.count} entries`, () => {
			expect(() => basisOf(layoutOf(row.count), row.cut)).toThrow(new RangeError(row.message));
		});
	}
});
