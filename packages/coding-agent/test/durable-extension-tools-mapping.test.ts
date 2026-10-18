import { Type } from "@ny4n/ai";
import { describe, expect, test } from "vitest";
import { type ToolBridge, toDurableTool } from "../src/core/durable/extension-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

/**
 * The mapping table of the hooks note, field by field. A Nyan tool that the durable path cannot reach is not installed;
 * the rest become durable registrations with the callers and deferral the table names.
 */

const params = Type.Object({});
const bridge: ToolBridge = { run: () => Promise.reject(new Error("the mapping does not execute tools")) };

function definition(overrides: Partial<ToolDefinition<typeof params>> = {}): ToolDefinition<typeof params> {
	return {
		name: "probe",
		label: "probe",
		description: "probe tool",
		parameters: params,
		execute: async () => ({ content: [], details: undefined }),
		...overrides,
	};
}

describe("Nyan tool to durable registration", () => {
	test("a hidden tool is not installed: legacy registers it but nothing reaches it", () => {
		expect(toDurableTool(definition({ exposure: "hidden" }), bridge)).toBeUndefined();
	});

	test("a direct tool is offered to the model and callable from tools, not deferred", () => {
		const registration = toDurableTool(definition({ exposure: "direct" }), bridge);
		expect(registration?.name).toBe("probe");
		expect(registration?.callers).toBeUndefined();
		expect(registration?.deferred).toBeUndefined();
	});

	test("a model-only tool is callable from the model only", () => {
		expect(toDurableTool(definition({ exposure: "model-only" }), bridge)?.callers).toEqual(["model"]);
	});

	test("a codemode tool is callable from tools only: the model is never offered it", () => {
		const registration = toDurableTool(definition({ exposure: "codemode" }), bridge);
		expect(registration?.callers).toEqual(["tools"]);
		expect(registration?.deferred).toBeUndefined();
	});

	test("a deferred tool is installed deferred: tool search loads it for the model", () => {
		expect(toDurableTool(definition({ exposure: "deferred" }), bridge)?.deferred).toBe(true);
	});

	test("a direct tool that is not active by default is deferred", () => {
		expect(toDurableTool(definition({ exposure: "direct", defaultActive: false }), bridge)?.deferred).toBe(true);
	});

	test("an output schema becomes the structured output schema, and the execution mode carries over", () => {
		const schema = Type.Object({ ok: Type.Boolean() });
		const registration = toDurableTool(definition({ outputSchema: schema, executionMode: "sequential" }), bridge);
		expect(registration?.structuredOutputSchema).toBe(schema);
		expect(registration?.executionMode).toBe("sequential");
	});
});
