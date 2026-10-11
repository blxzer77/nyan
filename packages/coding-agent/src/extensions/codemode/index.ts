/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * `codemode` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`; the MCP extension activates it when MCP tools are only reachable from scripts.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	mode?: CodemodeMode;
	/** Overrides the `codemode.inlineBudget` setting. */
	inlineBudget?: number;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	models?: boolean;
}

function readMode(nyan: ExtensionAPI): CodemodeMode {
	return nyan.getSettings().codemode?.mode === "only" ? "only" : "on";
}

function readInlineBudget(nyan: ExtensionAPI): number | undefined {
	const budget = nyan.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (nyan) => {
		nyan.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => nyan.appendEntry(customType, data),
				models: options.models ?? true,
				getToolNamespace: (name) => nyan.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(nyan.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () => options.mode ?? readMode(nyan),
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(nyan),
			}),
			defaultActive: false,
		});
	};
}

export default createCodemodeExtension();
