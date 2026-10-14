/**
 * Tool discovery for `searchTools()` in codemode scripts and the optional `tool_search` tool. Both rank
 * with the BM25 ranker of `@ny4n/codemode/search`, which durable's code mode uses too; this module
 * builds each tool's search text.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`codemode` and `deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

import { Bm25Ranker, collectSchemaText, type ToolSearchDocument } from "@ny4n/codemode/search";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";

export {
	Bm25Ranker,
	type ToolRanker,
	type ToolSearchDocument,
	type ToolSearchMatch,
	tokenize,
} from "@ny4n/codemode/search";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/**
 * Search text of a tool: the name, the name with `_`
 * as spaces, the description, schema descriptions and property names, and the namespace with its
 * description and instructions.
 */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	collectSchemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	loaded: string[];
}

export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether `tool_search` can load a tool with this exposure. */
function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 */
function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/**
 * The `tool_search` description. It does not list the searchable tools or their namespaces, so it
 * stays the same while tools are registered, for example when MCP servers connect.
 */
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		reachesTools: () => "all",
		async execute(_toolCallId, { query, limit }) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
