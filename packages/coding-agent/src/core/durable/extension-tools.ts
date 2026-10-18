import type { JsonValue } from "@ny4n/chord";
import {
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type PromptInput,
	section,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@ny4n/durable";
import type { ExtensionToolContext, ToolDefinition, ToolExposure } from "../extensions/types.ts";

/**
 * Runs one tool call's execution with its own context. The host implements it: the context's `ctx.model` and
 * `ctx.signal` belong to this call, as they do for provider calls.
 */
export interface ToolBridge {
	run<T>(signal: AbortSignal | undefined, execute: (context: ExtensionToolContext) => Promise<T>): Promise<T>;
}

/** A value the durable transcript and the provider accept: plain JSON, with finite numbers. */
export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}

type Execution = Awaited<ReturnType<ToolDefinition["execute"]>>;

/**
 * Legacy activates `direct` and `model-only` tools when they are registered and the other exposures not, unless the tool's
 * `defaultActive` says otherwise. The active set changes later through `setActiveTools()`.
 */
export function isActiveByDefault(definition: ToolDefinition): boolean {
	const exposure: ToolExposure = definition.exposure ?? "direct";
	return definition.defaultActive ?? (exposure === "direct" || exposure === "model-only");
}

/**
 * The durable registration of one Nyan tool. The mapping table is in the hooks note; fields the durable path does not use
 * are listed there with the reason. `active` is the tool's place in the active set: an inactive tool is one the model gets
 * only after it is activated (tool search loads it in batch 2b), which is `deferred` here. Returns undefined for `hidden`
 * tools: legacy registers them but nothing reaches them, so they are not installed.
 */
export function toDurableTool(
	definition: ToolDefinition,
	bridge: ToolBridge,
	active: boolean,
): ToolRegistration | undefined {
	const exposure: ToolExposure = definition.exposure ?? "direct";
	if (exposure === "hidden") return undefined;
	// A codemode tool that is active is declared to the model, as legacy declares it.
	const deferred = !active && exposure !== "codemode";
	const callers =
		exposure === "codemode" && !active
			? (["tools"] as const)
			: exposure === "model-only"
				? (["model"] as const)
				: undefined;
	return defineTool({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
		...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
		...(definition.outputSchema === undefined ? {} : { structuredOutputSchema: definition.outputSchema }),
		...(callers === undefined ? {} : { callers }),
		...(deferred ? { deferred: true as const } : {}),
		execute: (args, api, context) =>
			bridge.run(context.abortSignal, async (toolContext) =>
				toDurableResult(
					definition,
					await definition.execute(
						api.callId,
						args,
						context.abortSignal,
						(partial) => streamText(api, partial.content),
						toolContext,
					),
				),
			),
	});
}

/** Running output reaches the durable call as it arrives; details are taken from the final result. */
function streamText(api: ToolExecutionApi, content: Execution["content"]): void {
	for (const block of content) {
		if (block.type === "text") api.output(block.text);
	}
}

function toDurableResult(definition: ToolDefinition, result: Execution): ToolExecutionResult {
	const details = isJsonValue(result.details) ? result.details : undefined;
	const structured = isJsonValue(result.structuredContent) ? result.structuredContent : undefined;
	// Durable requires `structuredOutput` from a tool that declares a schema, unless the result is an error. Legacy
	// accepted a text-only result there; the hooks note records this as a deliberate change.
	if (definition.outputSchema !== undefined && structured === undefined && result.isError !== true) {
		return {
			output: result.content,
			isError: true,
			diagnostics: [
				{
					severity: "error",
					message: `${definition.name} declares an output schema and returned no structuredContent`,
				},
			],
		};
	}
	return {
		output: result.content,
		...(structured === undefined ? {} : { structuredOutput: structured }),
		...(result.isError === undefined ? {} : { isError: result.isError }),
		...(details === undefined ? {} : { details }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(result.terminate === true ? { control: { terminate: true as const } } : {}),
	};
}

/** One installed Nyan tool: its legacy definition and the durable registration built from it. */
export interface BridgedTool {
	readonly definition: ToolDefinition;
	readonly registration: ToolRegistration;
}

/**
 * The extension that carries the bridged tools. It replaces itself by name on every sync, so the registry always holds
 * the runner's current tools. Its prompt section adds `promptSnippet` and `promptGuidelines` for the tools the request
 * offers, as legacy's system prompt does for custom tools.
 */
export function toolsExtension(tools: readonly BridgedTool[]): Extension {
	return defineExtension({
		name: "nyan.extension-tools",
		tools: tools.map((tool) => tool.registration),
		sections: [section("extension_tools", (input) => guidance(tools, input))],
	});
}

function guidance(tools: readonly BridgedTool[], input: PromptInput): string | undefined {
	const offered = new Set(input.agent.tools.map((tool) => tool.name));
	const offeredTools = tools.filter((tool) => offered.has(tool.definition.name));
	const snippets = offeredTools.flatMap((tool) =>
		tool.definition.promptSnippet === undefined
			? []
			: [`- ${tool.definition.name}: ${tool.definition.promptSnippet}`],
	);
	const guidelines = offeredTools.flatMap((tool) =>
		(tool.definition.promptGuidelines ?? []).map((line) => `- ${line}`),
	);
	const lines = [
		...(snippets.length === 0 ? [] : ["Extension tools:", ...snippets]),
		...(guidelines.length === 0 ? [] : ["Extension tool guidelines:", ...guidelines]),
	];
	return lines.length === 0 ? undefined : lines.join("\n");
}
