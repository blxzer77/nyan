import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import {
	type BoundaryDecision,
	type Conversation,
	defineTool,
	type EntryRecord,
	type GenerationBoundary,
	GenerationTask,
	LiveDoc,
	MemoryStorage,
	ToolResultEntry,
} from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addHooks, addTool, describeMessage } from "./harness-support.ts";
import { context } from "./session-support.ts";

type Sent = string[][];

function recording(sent: Sent, text: string): FauxResponseStep {
	return (request) => {
		sent.push(request.messages.map(describeMessage));
		return fauxAssistantMessage([fauxText(text)]);
	};
}

const nudge = (text: string) => ({
	kind: "app.nudge",
	model: [{ role: "user" as const, content: text, timestamp: 1 }],
});
const note = (n: number) => ({ kind: "app.note", data: { n } });

async function submit(root: Conversation, content: string): Promise<string> {
	return (await (await root.submit({ type: "input", content }, context)).wait(context)).status;
}

const kindsOf = (entries: readonly EntryRecord[]) => entries.map((entry) => entry.kind);

function boundaries(setup: ChatSetup, decide: (boundary: GenerationBoundary) => BoundaryDecision | undefined) {
	const seen: GenerationBoundary[] = [];
	addHooks(setup.registry, GenerationTask, {
		onBoundary: (boundary) => {
			seen.push(boundary);
			return decide(boundary);
		},
	});
	return seen;
}

describe("onBoundary at a final answer", () => {
	it("appends the returned entries after the answer, attributed to the generation task", async () => {
		const setup = chatSetup();
		const seen = boundaries(setup, (boundary) =>
			boundary.kind === "turn_end" ? { entries: [note(1), note(2)] } : undefined,
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		const entries = await allEntries(root);
		expect(kindsOf(entries)).toEqual(["nyan.user", "nyan.assistant", "app.note", "app.note"]);
		expect(entries.slice(2).map((entry) => entry.data)).toEqual([{ n: 1 }, { n: 2 }]);
		const generation = entries[1]!.byTaskId;
		expect(generation).toBeDefined();
		expect(entries.slice(2).every((entry) => entry.byTaskId === generation)).toBe(true);
		// A final answer is committed together with its boundary, so there is no assistant entry to name yet.
		expect(seen.map((boundary) => [boundary.kind, boundary.assistantEntry, boundary.toolResults])).toEqual([
			["turn_end", undefined, []],
			["settle", undefined, []],
		]);
		expect(seen[1]!.entries).toHaveLength(2);
		await harness.close(context);
	});

	it("lets a later handler see and replace what an earlier one asked for", async () => {
		const setup = chatSetup();
		const first = boundaries(setup, (boundary) =>
			boundary.kind === "turn_end" ? { entries: [note(1)] } : undefined,
		);
		const second = boundaries(setup, (boundary) =>
			boundary.kind === "turn_end" ? { entries: [...boundary.entries, note(2)] } : { entries: [] },
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(second[0]!.entries.map((entry) => entry.data)).toEqual([{ n: 1 }]);
		// The settle call replaced the list with an empty one, so nothing was appended.
		expect(kindsOf(await allEntries(root))).toEqual(["nyan.user", "nyan.assistant"]);
		expect(first).toHaveLength(2);
		await harness.close(context);
	});

	it("continues with one more request whose context ends with the drafted user message", async () => {
		const setup = chatSetup();
		let asked = 0;
		boundaries(setup, (boundary) =>
			boundary.kind === "settle" && asked++ === 0 ? { entries: [nudge("keep going")], continue: true } : undefined,
		);
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "one"), recording(sent, "two")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(sent).toHaveLength(2);
		expect(sent[1]!.at(-1)).toBe("user:keep going");
		expect(kindsOf(await allEntries(root))).toEqual(["nyan.user", "nyan.assistant", "app.nudge", "nyan.assistant"]);
		await harness.close(context);
	});

	it("asks for settle only when nothing already continues the run", async () => {
		const setup = chatSetup();
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "again" } : undefined) });
		const seen = boundaries(setup, () => undefined);
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "one"), recording(sent, "two")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		// The first answer ends a turn but not the run; only the second answer settles.
		expect(seen.map((boundary) => boundary.kind)).toEqual(["turn_end", "turn_end", "settle"]);
		await harness.close(context);
	});

	it("keeps a queued input ahead of continue and still appends the entries", async () => {
		const setup = chatSetup();
		let asked = 0;
		boundaries(setup, (boundary) =>
			boundary.kind === "settle" && asked++ === 0 ? { entries: [nudge("keep going")], continue: true } : undefined,
		);
		const sent: Sent = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const busy = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const first: FauxResponseStep = async (request) => {
			sent.push(request.messages.map(describeMessage));
			reached();
			await gate;
			return fauxAssistantMessage([fauxText("one")]);
		};
		setup.faux.setResponses([first, recording(sent, "two")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const original = await root.submit({ type: "input", content: "go" }, context);
		await busy;
		const queued = await root.submit({ type: "input", content: "next", whenBusy: "followUp" }, context);
		release();
		expect((await original.wait(context)).status).toBe("done");
		expect((await queued.wait(context)).status).toBe("done");
		// The queued input started the second request; continue did not add a third.
		expect(sent).toHaveLength(2);
		expect(sent[1]!.at(-1)).toBe("user:next");
		expect(kindsOf(await allEntries(root))).toContain("app.nudge");
		await harness.close(context);
	});

	it("reports a continue that would end the request with the answer, and does not continue", async () => {
		const setup = chatSetup();
		boundaries(setup, (boundary) => (boundary.kind === "settle" ? { continue: true } : undefined));
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "one"), recording(sent, "never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(sent).toHaveLength(1);
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(
			expect.stringContaining("asked to continue without a user message"),
		);
		await harness.close(context);
	});

	it("reports a throw and goes on with the next handler", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			onBoundary: () => {
				throw new Error("boundary failed");
			},
		});
		boundaries(setup, (boundary) => (boundary.kind === "turn_end" ? { entries: [note(1)] } : undefined));
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(kindsOf(await allEntries(root))).toEqual(["nyan.user", "nyan.assistant", "app.note"]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("boundary failed");
		await harness.close(context);
	});

	it("is not asked for a turn that ends in an error", async () => {
		const setup = chatSetup();
		setup.settings.retry = { enabled: false };
		const seen = boundaries(setup, () => undefined);
		setup.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("unanswered");
		expect(seen).toEqual([]);
		await harness.close(context);
	});
});

describe("onBoundary drafts that cannot be used", () => {
	const user = { role: "user" as const, content: "x", timestamp: 1 };
	const bad: [string, unknown][] = [
		["a built-in kind", { kind: "nyan.assistant", data: {} }],
		["an empty kind", { kind: "" }],
		["a head marker", { kind: "app.cut", head: 1, model: [user] }],
		["an assistant message", { kind: "app.x", model: [{ role: "assistant", content: [], timestamp: 1 }] }],
		["a user message without a timestamp", { kind: "app.x", model: [{ role: "user", content: "x" }] }],
		["an edit of an entry that is not active", { kind: "app.x", edits: [{ target: 999_999, action: "omit" }] }],
		["data that is not strict JSON", { kind: "app.x", data: { value: Number.NaN } }],
	];

	it.each(bad)("drops the whole list, with its continue, for %s", async (_label, draft) => {
		const setup = chatSetup();
		boundaries(setup, (boundary) =>
			boundary.kind === "turn_end"
				? { entries: [note(1), draft as never, nudge("keep going")], continue: true }
				: undefined,
		);
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "one"), recording(sent, "never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		// The valid drafts around the bad one are dropped too, and the run did not continue.
		expect(kindsOf(await allEntries(root))).toEqual(["nyan.user", "nyan.assistant"]);
		expect(sent).toHaveLength(1);
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(
			expect.stringContaining("onBoundary returned entries that cannot be used"),
		);
		await harness.close(context);
	});

	// The target is a real, active entry, so only the edit's own shape can be what is rejected.
	const badEdits: [string, unknown, string][] = [
		["an unknown action", { action: "delete" }, "unknown action delete"],
		// Read as `undefined.filter` on every later context derivation, which would make the conversation unreadable.
		["a replacement without messages", { action: "replace" }, "has a replacement that is not a list"],
		[
			"a replacement with an assistant message",
			{ action: "replace", messages: [{ role: "assistant", content: [], timestamp: 1 }] },
			"has a replacement message that is not a user message",
		],
		[
			"a replacement without a timestamp",
			{ action: "replace", messages: [{ role: "user", content: "x" }] },
			"has a replacement user message without a timestamp",
		],
		[
			"a replacement message without content",
			{ action: "replace", messages: [{ role: "user", timestamp: 1 }] },
			"has a replacement user message without content",
		],
		[
			"an omit that carries messages",
			{ action: "omit", messages: [{ role: "user", content: "x", timestamp: 1 }] },
			"has an omit edit with messages",
		],
	];

	it.each(badEdits)("drops %s even when its target is active", async (_label, edit, expected) => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		addHooks(setup.registry, GenerationTask, {
			onBoundary: async (boundary) =>
				boundary.kind === "turn_end"
					? {
							entries: [
								{
									kind: "app.x",
									edits: [
										{ target: (await root.context(context)).entries[0]!.id, ...(edit as object) } as never,
									],
								},
							],
						}
					: undefined,
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("one")])]);
		expect(await submit(root, "go")).toBe("done");
		expect(kindsOf(await allEntries(root))).toEqual(["nyan.user", "nyan.assistant"]);
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(expect.stringContaining(expected));
		// The conversation is still readable.
		expect((await root.context(context)).messages.length).toBeGreaterThan(0);
		await harness.close(context);
	});

	it("accepts a replacement made of user messages", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		let first = true;
		addHooks(setup.registry, GenerationTask, {
			onBoundary: async (boundary) => {
				if (boundary.kind !== "turn_end" || !first) return undefined;
				first = false;
				return {
					entries: [
						{
							kind: "app.redact",
							edits: [
								{
									target: (await root.context(context)).entries[0]!.id,
									action: "replace" as const,
									messages: [{ role: "user" as const, content: "[redacted]", timestamp: 1 }],
								},
							],
						},
					],
				};
			},
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("one")])]);
		expect(await submit(root, "secret")).toBe("done");
		expect(setup.reports).toEqual([]);
		const texts = (await root.context(context)).messages.map((message) => textOf(message) ?? "");
		expect(texts).toContain("[redacted]");
		expect(texts).not.toContain("secret");
		await harness.close(context);
	});

	it("accepts a context edit of an active entry", async () => {
		const setup = chatSetup();
		let firstUser = 0;
		boundaries(setup, (boundary) =>
			boundary.kind === "turn_end" && firstUser++ === 0 ? { entries: [] } : undefined,
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "first")).toBe("done");
		const target = (await allEntries(root))[0]!.id;
		addHooks(setup.registry, GenerationTask, {
			onBoundary: (boundary) =>
				boundary.kind === "turn_end"
					? { entries: [{ kind: "app.omit", edits: [{ target, action: "omit" }] }] }
					: undefined,
		});
		expect(await submit(root, "second")).toBe("done");
		const view = await root.context(context);
		expect(view.messages.map((message) => textOf(message) ?? "")).not.toContain("first");
		await harness.close(context);
	});
});

const CALL = fauxAssistantMessage([fauxToolCall("report", {}, { id: "c1" })], { stopReason: "toolUse" });

function reporting(control?: { terminate: true }) {
	return defineTool({
		name: "report",
		description: "Reports",
		parameters: Type.Object({}),
		execute: async () => ({
			output: [{ type: "text", text: "reported" }],
			...(control === undefined ? {} : { control }),
		}),
	});
}

describe("onBoundary after a tool round", () => {
	it("names the committed assistant and result entries and appends the drafts after the results", async () => {
		const setup = chatSetup();
		addTool(setup.registry, reporting());
		const seen = boundaries(setup, (boundary) =>
			boundary.kind === "turn_end" && boundary.toolResults.length > 0
				? { entries: [note(7)], continue: true }
				: undefined,
		);
		setup.faux.setResponses([CALL, fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		const entries = await allEntries(root);
		const round = seen[0]!;
		expect(round.kind).toBe("turn_end");
		expect(entries.find((entry) => entry.id === round.assistantEntry)?.kind).toBe("nyan.assistant");
		expect(round.toolResults).toEqual(entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.id));
		const kinds = kindsOf(entries);
		expect(kinds.indexOf("app.note")).toBe(kinds.indexOf("nyan.tool-result") + 1);
		// The round continued on its own, once; `continue` neither added a request nor was reported.
		expect(kinds.filter((kind) => kind === "nyan.assistant")).toHaveLength(2);
		expect(setup.reports).toEqual([]);
		// The final answer then raises its own turn_end and settle.
		expect(seen.map((boundary) => boundary.kind)).toEqual(["turn_end", "turn_end", "settle"]);
		await harness.close(context);
	});

	it("raises settle for a round that terminates the run", async () => {
		const setup = chatSetup();
		addTool(setup.registry, reporting({ terminate: true }));
		const seen = boundaries(setup, () => undefined);
		setup.faux.setResponses([CALL]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(seen.map((boundary) => boundary.kind)).toEqual(["turn_end", "settle"]);
		expect(seen[1]!.assistantEntry).toBeDefined();
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});
});
