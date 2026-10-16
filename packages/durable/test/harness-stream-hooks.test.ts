import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	type Models,
	Type,
} from "@ny4n/ai";
import {
	defineTool,
	GenerationTask,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

async function runOnce(
	setup: ChatSetup,
	steps: (FauxResponseStep | AssistantMessage)[],
): Promise<{ status: string; harness: Harness; root: Awaited<ReturnType<typeof openChat>>["root"] }> {
	setup.faux.setResponses(steps);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	return { status: settled.status, harness, root };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("onStreamEvent", () => {
	it("delivers every stream event in order to every observer before afterResponse runs", async () => {
		const setup = chatSetup();
		const seen: string[] = [];
		const attempts = new Set<number>();
		addHooks(setup.registry, GenerationTask, {
			onStreamEvent: async ({ event, attempt }) => {
				// A slow observer: the read loop must not wait for it, and delivery must still be sequential.
				await sleep(2);
				seen.push(`a:${event.type}`);
				attempts.add(attempt);
			},
		});
		addHooks(setup.registry, GenerationTask, { onStreamEvent: ({ event }) => void seen.push(`b:${event.type}`) });
		const afterResponse: string[] = [];
		addHooks(setup.registry, GenerationTask, { afterResponse: () => void afterResponse.push(seen.join(",")) });
		const { status, harness } = await runOnce(setup, [fauxAssistantMessage([fauxText("hello world")])]);
		expect(status).toBe("done");
		// Each event reaches `a` and then `b`, before the next event starts.
		const pairs = seen.map((entry) => entry.split(":")[0]);
		expect(pairs.filter((_, index) => index % 2 === 0).every((who) => who === "a")).toBe(true);
		expect(pairs.filter((_, index) => index % 2 === 1).every((who) => who === "b")).toBe(true);
		const types = seen.filter((entry) => entry.startsWith("a:")).map((entry) => entry.slice(2));
		expect(types[0]).toBe("start");
		expect(types.at(-1)).toBe("done");
		expect(types).toContain("text_delta");
		expect([...attempts]).toEqual([1]);
		// Everything was delivered by the time afterResponse observed the terminal message.
		expect(afterResponse).toEqual([seen.join(",")]);
		await harness.close(context);
	});

	it("reports an observer's throw and keeps delivering", async () => {
		const setup = chatSetup();
		const events: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			onStreamEvent: () => {
				throw new Error("stream observer failed");
			},
		});
		addHooks(setup.registry, GenerationTask, { onStreamEvent: ({ event }) => void events.push(event.type) });
		const { status, harness } = await runOnce(setup, [fauxAssistantMessage([fauxText("hi")])]);
		expect(status).toBe("done");
		expect(events.at(-1)).toBe("done");
		expect(setup.reports.map((error) => (error as Error).message)).toContain("stream observer failed");
		await harness.close(context);
	});

	it("does not slow the read loop: the partial reaches nyan.live while an observer is parked and the stream is open", async () => {
		const base = chatSetup();
		base.settings.progress = { partialIntervalMs: 1 };
		const gate = Promise.withResolvers<void>();
		const streamOpen = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		// One delta carrying a partial, then the stream stays open until the test lets it end.
		const stream = (): ReturnType<Models["streamSimple"]> => {
			const partial = fauxAssistantMessage("partial", { stopReason: "pending" });
			const events = async function* () {
				yield { type: "text_delta", contentIndex: 0, delta: "partial", partial };
				await streamOpen.promise;
			};
			const final = fauxAssistantMessage("final");
			return { [Symbol.asyncIterator]: events, result: async () => final } as unknown as ReturnType<
				Models["streamSimple"]
			>;
		};
		const models = new Proxy(base.models, {
			get(target, property) {
				if (property === "streamSimple") return stream;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const setup: ChatSetup = { ...base, models };
		addHooks(setup.registry, GenerationTask, {
			onStreamEvent: async ({ event }) => {
				if (event.type !== "text_delta") return;
				observed.resolve();
				await gate.promise;
			},
		});
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await observed.promise;
		// The observer is parked on the delta and the stream has not ended. If the read loop waited for the observer, the
		// partial, which it records after handing the event over, would never be published.
		await waitFor(async () => {
			const live = await harness.snapshot(LiveDoc, root.id, context);
			return textOf(live?.generation?.message as Message | undefined) === "partial";
		});
		streamOpen.resolve();
		gate.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		await harness.close(context);
	});

	it("stops waiting for an observer that never returns when the run is aborted", async () => {
		const setup = chatSetup();
		let reached!: () => void;
		const observed = new Promise<void>((resolve) => {
			reached = resolve;
		});
		addHooks(setup.registry, GenerationTask, {
			onStreamEvent: () => {
				reached();
				return new Promise<never>(() => {});
			},
		});
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await observed;
		const live = await harness.snapshot(LiveDoc, root.id, context);
		await harness.abortTask(live!.run!.taskId, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		await harness.close(context);
	});

	it("streams from the start again for each request of a run", async () => {
		const setup = chatSetup();
		const starts: AssistantMessageEvent["type"][] = [];
		addHooks(setup.registry, GenerationTask, {
			onStreamEvent: ({ event }) => void (event.type === "start" && starts.push(event.type)),
		});
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "again" } : undefined) });
		const { status, harness } = await runOnce(setup, [
			fauxAssistantMessage([fauxText("one")]),
			fauxAssistantMessage([fauxText("two")]),
		]);
		expect(status).toBe("done");
		expect(starts).toHaveLength(2);
		await harness.close(context);
	});
});

const EchoParameters = Type.Object({});

function reporting(
	body: (api: Parameters<ToolRegistration["execute"]>[1]) => void | Promise<void>,
	extra: Partial<ToolRegistration> = {},
): ToolRegistration {
	return defineTool({
		name: "report",
		description: "Reports progress",
		parameters: EchoParameters,
		execute: async (_args, api) => {
			await body(api);
			return { output: [{ type: "text", text: "final" }] };
		},
		...extra,
	});
}

const CALL = fauxAssistantMessage([fauxToolCall("report", {}, { id: "c1" })], { stopReason: "toolUse" });
const DONE = fauxAssistantMessage([fauxText("done")]);

describe("onToolUpdate", () => {
	it("delivers output, details, and diagnostics before the call settles", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			reporting(async (api) => {
				api.output("alpha ");
				api.diagnostic({ severity: "info", message: "halfway" });
				api.output("beta");
				await api.details({ step: 2 }, context);
			}),
		);
		const updates: { output?: string; details?: unknown; diagnostics?: unknown; call: string }[] = [];
		addHooks(setup.registry, ToolTask, {
			onToolUpdate: (update) =>
				void updates.push({
					call: update.call.id,
					...(update.output === undefined ? {} : { output: update.output }),
					...(update.details === undefined ? {} : { details: update.details }),
					...(update.diagnostics === undefined ? {} : { diagnostics: update.diagnostics }),
				}),
		});
		// `afterTool` runs after the call's updates were drained and before its result is committed.
		let atAfterTool = "";
		addHooks(setup.registry, ToolTask, {
			afterTool: () => {
				atAfterTool = updates.map((update) => update.output ?? "").join("");
				return undefined;
			},
		});
		const { status, harness } = await runOnce(setup, [CALL, DONE]);
		expect(status).toBe("done");
		expect(updates.every((update) => update.call === "c1")).toBe(true);
		expect(updates.map((update) => update.output ?? "").join("")).toBe("alpha beta");
		expect(atAfterTool).toBe("alpha beta");
		expect(updates.some((update) => JSON.stringify(update.details) === '{"step":2}')).toBe(true);
		expect(
			updates.flatMap((update) => (update.diagnostics ?? []) as { message: string }[]).map((d) => d.message),
		).toEqual(["halfway"]);
		await harness.close(context);
	});

	it("coalesces updates behind a slow observer: one in flight, output kept whole", async () => {
		const setup = chatSetup();
		const chunks = Array.from({ length: 60 }, (_, index) => `${index},`);
		addTool(
			setup.registry,
			reporting(async (api) => {
				for (const chunk of chunks) api.output(chunk);
			}),
		);
		let inFlight = 0;
		let maxInFlight = 0;
		const deliveries: string[] = [];
		addHooks(setup.registry, ToolTask, {
			onToolUpdate: async (update) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(10);
				deliveries.push(update.output ?? "");
				inFlight--;
			},
		});
		const { status, harness } = await runOnce(setup, [CALL, DONE]);
		expect(status).toBe("done");
		expect(maxInFlight).toBe(1);
		// Sixty synchronous pushes reach the observer as far fewer deliveries, and nothing is lost.
		expect(deliveries.length).toBeLessThan(chunks.length);
		expect(deliveries.join("")).toBe(chunks.join(""));
		await harness.close(context);
	});

	it("caps pending output at maxBytes and counts what it dropped", async () => {
		const setup = chatSetup();
		const chunks = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"];
		addTool(
			setup.registry,
			reporting(
				async (api) => {
					for (const chunk of chunks) api.output(chunk);
				},
				{ outputLimits: { maxBytes: 10 } },
			),
		);
		let delivered = "";
		let dropped = 0;
		addHooks(setup.registry, ToolTask, {
			onToolUpdate: async (update) => {
				await sleep(10);
				delivered += update.output ?? "";
				dropped += update.droppedBytes ?? 0;
			},
		});
		const { status, harness } = await runOnce(setup, [CALL, DONE]);
		expect(status).toBe("done");
		expect(dropped).toBeGreaterThan(0);
		// Every pushed byte was either delivered or counted as dropped.
		expect(new TextEncoder().encode(delivered).length + dropped).toBe(chunks.join("").length);
		await harness.close(context);
	});

	it("reports an observer's throw and keeps the call running", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			reporting((api) => {
				api.output("x");
			}),
		);
		addHooks(setup.registry, ToolTask, {
			onToolUpdate: () => {
				throw new Error("tool observer failed");
			},
		});
		const { status, harness } = await runOnce(setup, [CALL, DONE]);
		expect(status).toBe("done");
		expect(setup.reports.map((error) => (error as Error).message)).toContain("tool observer failed");
		await harness.close(context);
	});

	// Gating the delivery on `has()` only saves work: with no observer the pump would have nothing to call, so nothing
	// observable differs. This pins that a streaming tool is unaffected, not the gate itself.
	it("lets a tool stream output and details when no observer exists", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			reporting(async (api) => {
				api.output("x");
				await api.details({ step: 1 }, context);
			}),
		);
		const { status, harness, root } = await runOnce(setup, [CALL, DONE]);
		expect(status).toBe("done");
		expect(setup.reports).toEqual([]);
		// The details the tool reported are the result's, since it returned none of its own.
		const [result] = (await allEntries(root)).filter((entry) => ToolResultEntry.is(entry));
		expect(result?.model?.[0]).toMatchObject({ role: "toolResult", details: { step: 1 } });
		await harness.close(context);
	});
});
