import type { AssistantMessage, Usage } from "@ny4n/ai";
import type { AgentEvent, ConversationId, EntryId, EntryRecord } from "@ny4n/durable";
import { describe, expect, test } from "vitest";
import { DurableJsonEventAdapter, type QueuedTexts } from "../src/modes/durable/json-events.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "openai-completions",
	provider: "test",
	model: "test-model",
	usage,
	stopReason: "pending",
	timestamp: 1,
};

const answered: AssistantMessage = { ...assistant, content: [{ type: "text", text: "hello" }], stopReason: "stop" };

const entry: EntryRecord = {
	id: 2 as EntryId,
	conversationId: 1 as ConversationId,
	kind: "nyan.assistant",
	model: [answered],
};

const noQueue: QueuedTexts = { steering: [], followUp: [] };

function adapterOf(queue: QueuedTexts = noQueue): DurableJsonEventAdapter {
	return new DurableJsonEventAdapter(
		() => [assistant],
		async () => queue,
	);
}

describe("durable JSON events", () => {
	test("keeps the published event vocabulary while applying durable deltas", async () => {
		const adapter = adapterOf();
		const events: AgentEvent[] = [
			{ type: "run_start", inputs: [] },
			{ type: "message_start", message: assistant },
			{
				type: "message_update",
				usage,
				changes: [{ type: "text_delta", contentIndex: 0, delta: "hello" }],
			},
		];

		expect((await adapter.translate(events)).map((event) => event.type)).toEqual([
			"agent_start",
			"message_start",
			"message_update",
		]);
		expect((await adapter.translate([events[2]!]))[0]).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		});
	});

	test("publishes one message_update before message_end when the partial never streamed", async () => {
		const adapter = adapterOf();
		const translated = await adapter.translate([
			{ type: "message_start", message: assistant },
			{ type: "message_end", entry },
		]);
		expect(translated.map((event) => event.type)).toEqual(["message_start", "message_update", "message_end"]);
		expect(translated[1]).toMatchObject({
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "done", reason: "stop" },
		});
	});

	test("does not add a second message_update when the partial already published one", async () => {
		const adapter = adapterOf();
		const translated = await adapter.translate([
			{ type: "message_start", message: assistant },
			{ type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: "hello" }] },
			{ type: "message_end", entry },
		]);
		expect(translated.map((event) => event.type)).toEqual(["message_start", "message_update", "message_end"]);
	});

	test("publishes the queued texts an inbox change leaves", async () => {
		const queue: QueuedTexts = { steering: ["steer this"], followUp: ["then this"] };
		const adapter = adapterOf(queue);
		expect(await adapter.translate([{ type: "inbox_update", items: [] }])).toEqual([
			{ type: "queue_update", steering: ["steer this"], followUp: ["then this"] },
		]);
	});

	test("does not repeat a queue it already published", async () => {
		let queue: QueuedTexts = { steering: ["steer this"], followUp: [] };
		const adapter = new DurableJsonEventAdapter(
			() => [],
			async () => queue,
		);
		expect((await adapter.translate([{ type: "inbox_update", items: [] }])).length).toBe(1);
		expect(await adapter.translate([{ type: "inbox_update", items: [] }])).toEqual([]);
		queue = { steering: [], followUp: [] };
		expect(await adapter.translate([{ type: "inbox_update", items: [] }])).toEqual([
			{ type: "queue_update", steering: [], followUp: [] },
		]);
	});
});
