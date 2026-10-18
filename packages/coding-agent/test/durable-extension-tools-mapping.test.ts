import { Type } from "@ny4n/ai";
import { describe, expect, test } from "vitest";
import { isActiveByDefault, type ToolBridge, toDurableTool } from "../src/core/durable/extension-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

/**
 * The mapping table of the hooks note, field by field. A Nyan tool that the durable path cannot reach is not installed;
 * the rest become durable registrations with the callers and deferral the table names. `active` is the tool's place in
 * the active set, which legacy sets on registration (`isActiveByDefault`) and `setActiveTools()` changes.
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
		expect(toDurableTool(definition({ exposure: "hidden" }), bridge, true)).toBeUndefined();
	});

	test("an active direct tool is offered to the model and callable from tools, not deferred", () => {
		const registration = toDurableTool(definition({ exposure: "direct" }), bridge, true);
		expect(registration?.name).toBe("probe");
		expect(registration?.callers).toBeUndefined();
		expect(registration?.deferred).toBeUndefined();
	});

	test("a model-only tool is callable from the model only", () => {
		expect(toDurableTool(definition({ exposure: "model-only" }), bridge, true)?.callers).toEqual(["model"]);
	});

	test("an inactive codemode tool is callable from tools only: the model is never offered it", () => {
		const registration = toDurableTool(definition({ exposure: "codemode" }), bridge, false);
		expect(registration?.callers).toEqual(["tools"]);
		expect(registration?.deferred).toBeUndefined();
	});

	test("a codemode tool that is activated is declared to the model", () => {
		const registration = toDurableTool(definition({ exposure: "codemode" }), bridge, true);
		expect(registration?.callers).toBeUndefined();
		expect(registration?.deferred).toBeUndefined();
	});

	test("an inactive deferred tool is installed deferred, and activating it offers it", () => {
		expect(toDurableTool(definition({ exposure: "deferred" }), bridge, false)?.deferred).toBe(true);
		expect(toDurableTool(definition({ exposure: "deferred" }), bridge, true)?.deferred).toBeUndefined();
	});

	test("a direct tool that is not active is deferred until it is activated", () => {
		expect(toDurableTool(definition({ exposure: "direct" }), bridge, false)?.deferred).toBe(true);
	});

	test("the default activation: direct and model-only are active, the others are not, and defaultActive overrides", () => {
		expect(isActiveByDefault(definition({ exposure: "direct" }))).toBe(true);
		expect(isActiveByDefault(definition({ exposure: "model-only" }))).toBe(true);
		expect(isActiveByDefault(definition({ exposure: "codemode" }))).toBe(false);
		expect(isActiveByDefault(definition({ exposure: "deferred" }))).toBe(false);
		expect(isActiveByDefault(definition({ exposure: "direct", defaultActive: false }))).toBe(false);
	});

	test("an output schema becomes the structured output schema, and the execution mode carries over", () => {
		const schema = Type.Object({ ok: Type.Boolean() });
		const registration = toDurableTool(
			definition({ outputSchema: schema, executionMode: "sequential" }),
			bridge,
			true,
		);
		expect(registration?.structuredOutputSchema).toBe(schema);
		expect(registration?.executionMode).toBe("sequential");
	});
});
