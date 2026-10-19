import { describe, expect, test } from "vitest";
import { customMessageView } from "../src/core/durable/custom-message.ts";

/** The durable TUI's decision for a boundary `custom_message` entry: `display: false` shows nothing, as legacy. */
describe("durable custom message view", () => {
	test("shows a visible custom message as text with its type", () => {
		expect(
			customMessageView({
				data: { customType: "probe.reminder", display: true },
				model: [{ role: "user", content: "remember this", timestamp: 0 }],
			}),
		).toEqual({ customType: "probe.reminder", text: "remember this" });
	});

	test("shows nothing for display: false", () => {
		expect(
			customMessageView({
				data: { customType: "probe.reminder", display: false },
				model: [{ role: "user", content: "hidden reminder", timestamp: 0 }],
			}),
		).toBeUndefined();
	});

	test("joins text blocks and keeps a message with no content", () => {
		expect(
			customMessageView({
				data: { customType: "probe.parts" },
				model: [
					{
						role: "user",
						content: [
							{ type: "text", text: "one" },
							{ type: "text", text: "two" },
						],
						timestamp: 0,
					},
				],
			}),
		).toEqual({ customType: "probe.parts", text: "one\ntwo" });
		expect(customMessageView({ data: { customType: "probe.empty" } })).toEqual({
			customType: "probe.empty",
			text: "",
		});
	});
});
