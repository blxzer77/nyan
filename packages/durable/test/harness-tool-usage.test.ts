import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Models,
	type ToolResultMessage,
	Type,
	type Usage,
} from "@ny4n/ai";
import {
	type ConversationId,
	defineTool,
	type Harness,
	MemoryStorage,
	type NestedToolExecutionResult,
	ToolResultEntry,
	UsageDoc,
} from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { usageProblem } from "../src/harness/usage.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const spend: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

const CALL_ID = (id: string) => fauxAssistantMessage([fauxToolCall("paid", {}, { id })], { stopReason: "toolUse" });
const DONE = fauxAssistantMessage([fauxText("done")]);

/** Runs the conversation with a `paid` tool that returns each of `usages` in turn, then `DONE`. */
async function run(usages: unknown[], setup: ChatSetup = chatSetup()) {
	let next = 0;
	addTool(
		setup.registry,
		defineTool({
			name: "paid",
			description: "paid",
			parameters: Type.Object({}),
			execute: async () => ({ output: [{ type: "text", text: "work done" }], usage: usages[next++] as Usage }),
		}),
	);
	const responses: AssistantMessage[] = usages.map((_, index) => CALL_ID(`c${index + 1}`));
	setup.faux.setResponses([...responses, DONE]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	const results = (await allEntries(root))
		.filter((entry) => ToolResultEntry.is(entry))
		.map((entry) => entry.model![0] as ToolResultMessage);
	return { harness, root, setup, status: settled.status, results };
}

async function ledger(harness: Harness, root: { readonly id: ConversationId }) {
	return (await harness.snapshot(UsageDoc, root.id, context))?.tools ?? {};
}

const textOf = (result: ToolResultMessage | undefined) =>
	result?.content.map((item) => (item.type === "text" ? item.text : "")).join("|");

describe("usageProblem", () => {
	it("accepts the usage the ledger can add", () => {
		expect(usageProblem(spend)).toBeUndefined();
		expect(usageProblem({ ...spend, cacheWrite1h: 0, reasoning: 5 })).toBeUndefined();
		// Dropped when stored, so not a field the ledger would keep.
		expect(usageProblem({ ...spend, note: undefined })).toBeUndefined();
	});

	it.each([
		["a negative counter", { ...spend, input: -1 }],
		["a negative cost", { ...spend, cost: { ...spend.cost, total: -0.01 } }],
		["a negative optional counter", { ...spend, reasoning: -5 }],
		["a NaN counter", { ...spend, output: Number.NaN }],
		["an unknown field", { ...spend, note: "free text" }],
		["an unknown cost field", { ...spend, cost: { ...spend.cost, tax: 1 } }],
		["no cost", { ...spend, cost: undefined }],
		["not an object", 5],
	])("rejects %s", (_label, usage) => {
		expect(usageProblem(usage)).toEqual(expect.any(String));
	});
});

describe("a tool result's usage", () => {
	it("is added to the ledger and stored on the result when it is valid", async () => {
		const { harness, root, results, status } = await run([spend]);
		expect(status).toBe("done");
		expect(results[0]?.usage).toEqual(spend);
		expect(await ledger(harness, root)).toEqual({ paid: spend });
		await harness.close(context);
	});

	it.each([
		["NaN", { ...spend, input: Number.NaN }],
		["a negative counter", { ...spend, output: -4 }],
		["an unknown field", { ...spend, note: "x" }],
	])("keeps the result and drops the usage, with a warning, for %s", async (_label, bad) => {
		const { harness, root, setup, results, status } = await run([bad]);
		expect(status).toBe("done");
		// Before the check the commit threw and the model saw "Tool result unavailable".
		expect(results).toHaveLength(1);
		expect(results[0]?.usage).toBeUndefined();
		expect(textOf(results[0])).toContain("work done");
		expect(textOf(results[0])).toContain(
			"[warn] The usage of tool call c1 was not recorded, so nyan.usage counts less than the tool spent",
		);
		expect(await ledger(harness, root)).toEqual({});
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(
			expect.stringContaining("Tool paid returned usage that was not recorded"),
		);
		await harness.close(context);
	});

	it("is dropped when adding it would make the ledger infinite, and the earlier total stays", async () => {
		const huge: Usage = { ...spend, cost: { ...spend.cost, total: 1e308 } };
		const { harness, root, results, status } = await run([huge, huge]);
		expect(status).toBe("done");
		expect(results).toHaveLength(2);
		expect(results[0]?.usage).toEqual(huge);
		expect(results[1]?.usage).toBeUndefined();
		expect(textOf(results[1])).toContain("not finite");
		const total = (await ledger(harness, root)).paid;
		expect(total?.cost.total).toBe(1e308);
		// The first call's other counters were added once, not twice.
		expect(total?.input).toBe(1);
		await harness.close(context);
	});
});

/** `models` whose `streamSimple` answers each request with the next of `finals`, as the provider sent it. */
function answering(models: Models, finals: AssistantMessage[]): Models {
	let next = 0;
	const streamSimple = () => {
		const final = finals[next++]!;
		return {
			[Symbol.asyncIterator]: async function* () {},
			result: async () => final,
		} as unknown as ReturnType<Models["streamSimple"]>;
	};
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("a provider response's usage", () => {
	const answer = (usage: Usage) => ({ ...fauxAssistantMessage("hi"), usage });

	// Not dropped like a tool's: the answer, the ledger and the entry are one commit, so the run ends faulted. The user
	// gets the named failure through the submission, and nothing is half-written.
	it("ends the run unanswered and faulted, with the cause, when a counter is not finite", async () => {
		const base = chatSetup();
		const setup: ChatSetup = { ...base, models: answering(base.models, [answer({ ...spend, input: Number.NaN })]) };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled).toMatchObject({
			status: "unanswered",
			reason: "faulted",
			detail: expect.stringContaining("not strict JSON"),
		});
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["nyan.user"]);
		expect((await harness.usage(context)).models).toEqual({});
		await harness.close(context);
	});

	it("ends the run unanswered and faulted, naming the model, when the ledger would overflow", async () => {
		const huge: Usage = { ...spend, cost: { ...spend.cost, total: 1e308 } };
		const base = chatSetup();
		const setup: ChatSetup = { ...base, models: answering(base.models, [answer(huge), answer(huge)]) };
		// The task is faulted, which settles the submission; the fault is not also sent to the host's report callback.
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await (await root.submit({ type: "input", content: "one" }, context)).wait(context);
		expect(first.status).toBe("done");
		const second = await (await root.submit({ type: "input", content: "two" }, context)).wait(context);
		expect(second).toMatchObject({
			status: "unanswered",
			reason: "faulted",
			detail: expect.stringContaining("The usage of faux/faux-1 cannot be recorded"),
		});
		const kinds = (await allEntries(root)).map((entry) => entry.kind);
		expect(kinds.filter((kind) => kind === "nyan.assistant")).toHaveLength(1);
		expect((await harness.usage(context)).models["faux/faux-1"]?.cost.total).toBe(1e308);
		await harness.close(context);
	});
});

describe("a nested call's usage", () => {
	async function nested(usages: unknown[]) {
		const setup = chatSetup();
		let next = 0;
		addTool(
			setup.registry,
			defineTool({
				name: "paid",
				description: "paid",
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: "inner" }], usage: usages[next++] as Usage }),
			}),
		);
		const seen: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			defineTool({
				name: "batch",
				description: "batch",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					for (let call = 0; call < usages.length; call++)
						seen.push(await api.executeTool("paid", {}, callContext));
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("batch", {}, { id: "b1" })], { stopReason: "toolUse" }),
			DONE,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		return { harness, root, seen, setup, status: settled.status };
	}

	it("is dropped with a warning when a counter is not finite, and the caller still gets the result", async () => {
		const { harness, root, seen, setup, status } = await nested([{ ...spend, input: Number.NaN }]);
		expect(status).toBe("done");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.usage).toBeUndefined();
		expect(seen[0]?.isError).toBe(false);
		expect(seen[0]?.diagnostics).toContainEqual(
			expect.objectContaining({
				severity: "warn",
				code: "invalid_usage",
				message: expect.stringContaining("tool call b1/1 was not recorded"),
			}),
		);
		expect(await ledger(harness, root)).toEqual({});
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(
			expect.stringContaining("returned usage that was not recorded"),
		);
		await harness.close(context);
	});

	it("is dropped with a warning when adding it would make the ledger infinite", async () => {
		const huge: Usage = { ...spend, cost: { ...spend.cost, total: 1e308 } };
		const { harness, root, seen, status } = await nested([huge, huge]);
		expect(status).toBe("done");
		expect(seen[0]?.usage).toEqual(huge);
		expect(seen[1]?.usage).toBeUndefined();
		expect(seen[1]?.diagnostics).toContainEqual(expect.objectContaining({ severity: "warn", code: "invalid_usage" }));
		expect((await ledger(harness, root)).paid?.cost.total).toBe(1e308);
		await harness.close(context);
	});
});
