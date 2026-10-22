import type { Message } from "@ny4n/ai/contracts";
import { describe, expect, it } from "vitest";
import { isProtected, type Protection, type ProtectionOptions } from "../src/context/protection.ts";
import type { ContextLayout } from "../src/context/types.ts";
import { idFromNumber } from "../src/ids.ts";
import { type ConversationId, type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "../src/types.ts";

const systemMessage = (): Message => ({ role: "system", content: "base prompt", timestamp: 1 });
const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const toolMessage = (): Message => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "file" }],
	isError: false,
	timestamp: 1,
});

/** A context whose entries are numbered from 1; `parts[0]` is the head marker when `head` is set. */
function layoutOf(parts: readonly (readonly Message[])[], head = false): ContextLayout {
	const conversationId: ConversationId = ROOT_CONVERSATION_ID;
	const entries: EntryRecord[] = parts.map((_, index) => ({
		id: idFromNumber<EntryId>(index + 1),
		conversationId,
		kind: index === 0 && head ? "nyan.compaction" : "nyan.test",
	}));
	return { head: head ? entries[0] : undefined, entries, contributions: parts };
}

const at = (index: number): EntryId => idFromNumber<EntryId>(index);

type Row = {
	readonly name: string;
	readonly parts: readonly (readonly Message[])[];
	readonly head?: boolean;
	readonly index: number;
	readonly options?: ProtectionOptions;
	readonly expected: Protection;
};

describe("isProtected", () => {
	const rows: readonly Row[] = [
		{
			name: "a system entry",
			parts: [[systemMessage()], [userMessage("hi")], [toolMessage()]],
			index: 0,
			expected: { protected: true, reason: "system" },
		},
		{
			name: "the first user entry after the head marker",
			parts: [[userMessage("summary")], [userMessage("hi")], [toolMessage()]],
			head: true,
			index: 1,
			expected: { protected: true, reason: "first-user-after-head" },
		},
		{
			name: "an entry of the in-flight turn",
			parts: [[userMessage("hi")], [toolMessage()]],
			index: 1,
			options: { inFlightFrom: at(2) },
			expected: { protected: true, reason: "in-flight-turn" },
		},
		{
			name: "a protected fact",
			parts: [[userMessage("hi")], [toolMessage()]],
			index: 1,
			options: { isProtectedFact: (entryId) => entryId === at(2) },
			expected: { protected: true, reason: "fact" },
		},
		{
			name: "a settled tool result",
			parts: [[userMessage("hi")], [toolMessage()]],
			index: 1,
			expected: { protected: false },
		},
		{
			name: "the head marker, which a later summary may summarize",
			parts: [[userMessage("summary")], [userMessage("hi")]],
			head: true,
			index: 0,
			expected: { protected: false },
		},
		{
			name: "the in-flight turn outranks a system entry in it",
			parts: [[systemMessage()], [toolMessage()]],
			index: 0,
			options: { inFlightFrom: at(1) },
			expected: { protected: true, reason: "in-flight-turn" },
		},
		{
			name: "a fact outranks a system entry",
			parts: [[systemMessage()]],
			index: 0,
			options: { isProtectedFact: (entryId) => entryId === at(1) },
			expected: { protected: true, reason: "fact" },
		},
		{
			name: "a system entry outranks the first user entry it also opens with",
			parts: [[userMessage("hi"), systemMessage()]],
			index: 0,
			expected: { protected: true, reason: "system" },
		},
		{
			name: "a fact lookup that declines leaves the position unprotected",
			parts: [[userMessage("hi")], [toolMessage()]],
			index: 1,
			options: { isProtectedFact: () => false },
			expected: { protected: false },
		},
	];
	for (const row of rows) {
		it(`protects ${row.name}`, () => {
			expect(isProtected(layoutOf(row.parts, row.head ?? false), row.index, row.options)).toStrictEqual(
				row.expected,
			);
		});
	}

	const positions: readonly number[] = [-1, 2, 0.5];
	for (const position of positions) {
		it(`refuses position ${position}, which is not an entry`, () => {
			const context = layoutOf([[userMessage("hi")], [toolMessage()]]);
			expect(() => isProtected(context, position)).toThrow(
				new RangeError(
					`Context position ${position} is not an entry: the context has ${context.entries.length} entries`,
				),
			);
		});
	}
});
