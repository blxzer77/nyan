import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	Type,
} from "@ny4n/ai";
import { type Conversation, defineTool, GenerationTask, MemoryStorage, ToolResultEntry } from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addHooks, addSection, addTool, describeMessage } from "./harness-support.ts";
import { context } from "./session-support.ts";

type Sent = string[][];

/** A faux step that records the request it received and answers `text`. */
function recording(sent: Sent, text: string): FauxResponseStep {
	return (request) => {
		sent.push(request.messages.map(describeMessage));
		return fauxAssistantMessage([fauxText(text)]);
	};
}

async function submit(root: Conversation, content: string): Promise<string> {
	return (await (await root.submit({ type: "input", content }, context)).wait(context)).status;
}

/**
 * Two turns whose prompt differs, so the second request holds two positional system entries: the baseline, and the
 * delta the changed section appended. Returns the second request.
 */
async function secondRequest(prepare: (setup: ChatSetup) => void): Promise<string[]> {
	const setup = chatSetup();
	let rules = "A";
	addSection(setup.registry, "rules", () => rules, { tag: false });
	prepare(setup);
	const sent: Sent = [];
	setup.faux.setResponses([recording(sent, "one"), recording(sent, "two")]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	expect(await submit(root, "first")).toBe("done");
	rules = "B";
	expect(await submit(root, "second")).toBe("done");
	await harness.close(context);
	return sent[1]!;
}

describe("transformConversation", () => {
	it("keeps the positional system entries when the handler returns the messages it received", async () => {
		const baseline = await secondRequest(() => {});
		expect(baseline.filter((line) => line.startsWith("system:"))).toHaveLength(2);
		const unchanged = await secondRequest((setup) =>
			addHooks(setup.registry, GenerationTask, {
				transformConversation: ({ messages }) => ({ messages: [...messages] }),
			}),
		);
		expect(unchanged).toEqual(baseline);
	});

	it("restores prompt and tool state in front of a replaced conversation", async () => {
		const baseline = await secondRequest(() => {});
		const replaced = await secondRequest((setup) =>
			addHooks(setup.registry, GenerationTask, {
				transformConversation: ({ messages }) => ({
					messages: [...messages, { role: "user", content: "added", timestamp: 0 }],
				}),
			}),
		);
		// One merged system message leads; the conversation follows with the handler's message last.
		expect(replaced.filter((line) => line.startsWith("system:"))).toEqual(["system:rules"]);
		expect(replaced[0]).toBe("system:rules");
		expect(replaced.slice(1)).toEqual([...baseline.filter((line) => !line.startsWith("system:")), "user:added"]);
	});

	it("shows handlers no system message, runs before beforeRequest, and chains the replacements", async () => {
		const setup = chatSetup();
		addSection(setup.registry, "rules", () => "A", { tag: false });
		const seen: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			transformConversation: ({ messages }) => {
				seen.push(`one:${messages.map((message) => message.role).join(",")}`);
				return { messages: [...messages, { role: "user", content: "p1", timestamp: 0 }] };
			},
		});
		addHooks(setup.registry, GenerationTask, {
			transformConversation: ({ messages }) => {
				seen.push(`two:${messages.map(describeMessage).join(",")}`);
				return { messages: [...messages, { role: "user", content: "p2", timestamp: 0 }] };
			},
		});
		addHooks(setup.registry, GenerationTask, {
			beforeRequest: ({ messages }) => {
				seen.push(`before:${messages.map(describeMessage).join(",")}`);
				return undefined;
			},
		});
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "answer")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(seen).toEqual(["one:user", "two:user:go,user:p1", "before:system:rules,user:go,user:p1,user:p2"]);
		expect(sent[0]).toEqual(["system:rules", "user:go", "user:p1", "user:p2"]);
		await harness.close(context);
	});

	it("reports a throw, goes on with the next handler, and runs again for each request of a run", async () => {
		const setup = chatSetup();
		let calls = 0;
		addHooks(setup.registry, GenerationTask, {
			transformConversation: () => {
				calls++;
				throw new Error("transform failed");
			},
		});
		addHooks(setup.registry, GenerationTask, {
			transformConversation: ({ messages }) => ({
				messages: [...messages, { role: "user", content: "x", timestamp: 0 }],
			}),
		});
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "again" } : undefined) });
		const sent: Sent = [];
		setup.faux.setResponses([recording(sent, "one"), recording(sent, "two")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(calls).toBe(2);
		expect(sent.every((request) => request.at(-1) === "user:x")).toBe(true);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("transform failed");
		await harness.close(context);
	});
});

function answerOf(entries: Awaited<ReturnType<typeof allEntries>>): AssistantMessage {
	return entries.findLast((entry) => entry.kind === "nyan.assistant")!.model![0] as AssistantMessage;
}

describe("rewriteMessage", () => {
	it("commits the replacement and shows it to afterResponse", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({ message: { ...message, content: [{ type: "text", text: "rewritten" }] } }),
		});
		const observed: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => void observed.push(textOf(message) ?? ""),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("original")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(textOf(answerOf(await allEntries(root)))).toBe("rewritten");
		expect(observed).toEqual(["rewritten"]);
		await harness.close(context);
	});

	it("records the replacement's usage in the ledger", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({
				message: {
					...message,
					usage: {
						...message.usage,
						totalTokens: 1234,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.5 },
					},
				},
			}),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("original")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		const total = (await harness.usage(context)).models["faux/faux-1"]!;
		expect(total.totalTokens).toBe(1234);
		expect(total.cost.total).toBe(9.5);
		await harness.close(context);
	});

	it("chains replacements and lets a handler that returns nothing keep the message", async () => {
		const setup = chatSetup();
		const textNow = (message: AssistantMessage) => textOf(message) ?? "";
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({
				message: { ...message, content: [{ type: "text", text: `${textNow(message)}+1` }] },
			}),
		});
		addHooks(setup.registry, GenerationTask, { rewriteMessage: () => undefined });
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({
				message: { ...message, content: [{ type: "text", text: `${textNow(message)}+2` }] },
			}),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("base")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(textOf(answerOf(await allEntries(root)))).toBe("base+1+2");
		await harness.close(context);
	});

	it("lets the tool calls of a replacement start a tool round", async () => {
		const setup = chatSetup();
		const ran: string[] = [];
		addTool(
			setup.registry,
			defineTool({
				name: "echo",
				description: "Echo",
				parameters: Type.Object({}),
				execute: async () => {
					ran.push("echo");
					return { output: [{ type: "text", text: "echoed" }] };
				},
			}),
		);
		let rewrites = 0;
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) =>
				rewrites++ === 0
					? {
							message: {
								...message,
								content: [fauxToolCall("echo", {}, { id: "c1" })],
								stopReason: "toolUse",
							},
						}
					: undefined,
		});
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("no call here")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(ran).toEqual(["echo"]);
		expect((await allEntries(root)).filter((entry) => ToolResultEntry.is(entry))).toHaveLength(1);
		await harness.close(context);
	});

	it("is what makes a rewritten error message retryable", async () => {
		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) =>
				message.stopReason === "error"
					? { message: { ...message, errorMessage: `503 Service Unavailable: ${message.errorMessage}` } }
					: undefined,
		});
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "stream ended unexpectedly" }),
			fauxAssistantMessage([fauxText("recovered")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(textOf(answerOf(await allEntries(root)))).toBe("recovered");
		await harness.close(context);
	});

	const invalidReplacements: [string, (message: AssistantMessage) => unknown][] = [
		["no usage", (message) => ({ ...message, usage: undefined })],
		[
			"a non-finite optional usage counter",
			(message) => ({ ...message, usage: { ...message.usage, cacheWrite1h: Number.NaN } }),
		],
		["a string optional usage counter", (message) => ({ ...message, usage: { ...message.usage, reasoning: "5" } })],
		["the wrong role", (message) => ({ ...message, role: "user" })],
		["a deferred stop reason", (message) => ({ ...message, stopReason: "deferred" })],
		["no timestamp", (message) => ({ ...message, timestamp: "yesterday" })],
		[
			"a tool call without an id",
			(message) => ({ ...message, content: [{ type: "toolCall", name: "read", arguments: {} }] }),
		],
		[
			"a tool call without a name",
			(message) => ({ ...message, content: [{ type: "toolCall", id: "c1", arguments: {} }] }),
		],
	];

	it.each(invalidReplacements)("reports a replacement with %s and keeps the message", async (_label, replace) => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({ message: replace(message) as AssistantMessage }),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("original")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(textOf(answerOf(await allEntries(root)))).toBe("original");
		expect(setup.reports.map((error) => (error as Error).message)).toContainEqual(
			expect.stringContaining("rewriteMessage returned a message that cannot be used"),
		);
		await harness.close(context);
	});

	it("is not called for a deferred result, only for the terminal message", async () => {
		const setup = chatSetup({ deferred: { pendingFetches: 1, pollAfterMs: 1 } });
		setup.settings.stream = { deferred: true };
		const seen: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => void seen.push(`${message.stopReason}:${textOf(message) ?? ""}`),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("late")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(seen).toEqual(["stop:late"]);
		await harness.close(context);
	});

	it("reports a throw and goes on", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: () => {
				throw new Error("rewrite failed");
			},
		});
		addHooks(setup.registry, GenerationTask, {
			rewriteMessage: (message) => ({ message: { ...message, content: [{ type: "text", text: "second" }] } }),
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("original")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect(await submit(root, "go")).toBe("done");
		expect(textOf(answerOf(await allEntries(root)))).toBe("second");
		expect(setup.reports.map((error) => (error as Error).message)).toContain("rewrite failed");
		await harness.close(context);
	});
});
