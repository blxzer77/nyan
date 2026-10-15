import type { AssistantMessage, Usage } from "@ny4n/ai";
import type { AgentEvent } from "@ny4n/durable";
import { describe, expect, test } from "vitest";
import { DurableJsonEventAdapter } from "../src/modes/durable/json-events.ts";

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

describe("durable JSON events", () => {
	test("keeps the published event vocabulary while applying durable deltas", () => {
		const adapter = new DurableJsonEventAdapter(() => [assistant]);
		const events: AgentEvent[] = [
			{ type: "run_start", inputs: [] },
			{ type: "message_start", message: assistant },
			{
				type: "message_update",
				usage,
				changes: [{ type: "text_delta", contentIndex: 0, delta: "hello" }],
			},
		];

		expect(adapter.translate(events).map((event) => event.type)).toEqual([
			"agent_start",
			"message_start",
			"message_update",
		]);
		expect(adapter.translate([events[2]!])[0]).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		});
	});
});
