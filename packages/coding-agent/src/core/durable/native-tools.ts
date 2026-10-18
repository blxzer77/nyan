import { CodemodeSandbox, loadQuickJSWasm } from "@ny4n/codemode";
import { type CodemodeNamespace, createCodemodeExtension } from "@ny4n/durable/codemode";
import { createToolSearchExtension, TOOL_SEARCH_TOOL_NAME } from "@ny4n/durable/tool-search";

export { TOOL_SEARCH_TOOL_NAME };

import { Type } from "@ny4n/ai";
import { defineExtension, type Extension } from "@ny4n/durable";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import type { SourceInfo } from "../../utils/source-info.ts";
import { acquireCodemodeWorker, CODEMODE_MEMORY_LIMIT_BYTES } from "../codemode-workers.ts";
import type { ToolInfo, ToolNamespace } from "../extensions/types.ts";

/**
 * The durable versions of codemode and tool search. They are not runner tools: the registry holds them while they are
 * active, and the host reports them to other extensions through `getAllTools()` with the same metadata the legacy tools
 * had, so the MCP extension's activation logic sees them without change.
 */
export const CODEMODE_TOOL_NAME = "codemode";
/** Name of the durable codemode extension; the inactive placeholder uses it to replace the extension by name. */
export const CODEMODE_EXTENSION_NAME = "codemode";
/** Name of the durable tool-search extension. */
export const TOOL_SEARCH_EXTENSION_NAME = "tool-search";

const SOURCE: SourceInfo = { path: "builtin:durable", source: "builtin", scope: "temporary", origin: "top-level" };

/**
 * Metadata of the native tools, as `getAllTools()` reports them. Both are `model-only` and inactive by default, as the
 * legacy definitions are. `reachesTools` is `"all"` for both: codemode's legacy function narrows it to the servers a
 * script names, which this path does not do yet, so MCP waits for every server before a codemode call (slower, not wrong).
 */
export const NATIVE_TOOL_INFOS: readonly ToolInfo[] = [
	{
		name: CODEMODE_TOOL_NAME,
		description: "Runs a script that calls the callable tools.",
		parameters: Type.Object({}),
		exposure: "model-only",
		reachesTools: () => "all",
		sourceInfo: SOURCE,
	},
	{
		name: TOOL_SEARCH_TOOL_NAME,
		description: "Loads deferred tools that match a query.",
		parameters: Type.Object({}),
		exposure: "model-only",
		reachesTools: () => "all",
		sourceInfo: SOURCE,
	},
];

/**
 * The QuickJS sandbox of the durable codemode. Its paths come from the legacy configuration (`src/config.ts`), and its
 * worker slots from `core/codemode-workers.ts`, so the legacy and durable paths share the limit of two workers.
 * Created on first activation, since loading the wasm reads a file.
 */
export function createCodemodeSandbox(): CodemodeSandbox {
	return new CodemodeSandbox({
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
		memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
		acquireWorker: acquireCodemodeWorker,
	});
}

/**
 * The codemode groups for the tools' namespaces. Durable groups tools by name prefix, so a namespace's name is its
 * prefix: MCP tool names begin with their namespace's name (`mcp__<server>__`). Aliases are not used on this path.
 */
export function codemodeNamespaces(namespaces: readonly ToolNamespace[]): CodemodeNamespace[] {
	const byName = new Map<string, CodemodeNamespace>();
	for (const namespace of namespaces) {
		if (byName.has(namespace.name)) continue;
		byName.set(namespace.name, {
			name: namespace.name,
			prefix: namespace.name,
			...(namespace.description === undefined ? {} : { description: namespace.description }),
			...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
		});
	}
	return [...byName.values()];
}

export function codemodeExtension(
	sandbox: CodemodeSandbox,
	namespaces: readonly CodemodeNamespace[],
	inlineBudget: number | undefined,
): Extension {
	return createCodemodeExtension({
		sandbox,
		namespaces,
		...(inlineBudget === undefined ? {} : { inlineBudget }),
	});
}

export function toolSearchExtension(): Extension {
	return createToolSearchExtension();
}

/** An extension with no tools that replaces the installed one of the same name: the native tool is off. */
export function inactiveExtension(name: string): Extension {
	return defineExtension({ name, tools: [] });
}
