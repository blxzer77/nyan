import { describe, expect, it } from "vitest";
import { Bm25Ranker, collectSchemaText, type ToolSearchDocument, tokenize } from "../src/search.ts";

describe("tokenize", () => {
	it("splits camelCase and snake_case, drops stop words, and folds plurals", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
	});
});

describe("collectSchemaText", () => {
	it("collects descriptions and property names through nested schemas", () => {
		const parts: string[] = [];
		collectSchemaText(
			{
				type: "object",
				description: "Root",
				properties: {
					state: { type: "string", description: "open or closed" },
					labels: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
					either: { anyOf: [{ description: "first" }, { description: "second" }] },
				},
			},
			parts,
		);
		expect(parts).toEqual(["Root", "state", "open or closed", "labels", "name", "either", "first", "second"]);
	});

	it("ignores values that are not schemas", () => {
		const parts: string[] = [];
		collectSchemaText(undefined, parts);
		collectSchemaText(true, parts);
		collectSchemaText([{ description: "ignored" }], parts);
		expect(parts).toEqual([]);
	});
});

describe("Bm25Ranker", () => {
	const documents: ToolSearchDocument[] = [
		{ name: "list_issues", text: "list_issues list issues List issues in a repository. state open or closed" },
		{ name: "create_pull_request", text: "create_pull_request create pull request Open a pull request." },
		{ name: "search_issues", text: "search_issues search issues Search Linear issues by text." },
		{ name: "docs_search", text: "docs_search docs search Search the documentation." },
	];

	it("ranks by term relevance and respects the limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("issue", documents, 8).map((match) => match.name)).toEqual(["search_issues", "list_issues"]);
		expect(ranker.rank("pull requests", documents, 8)[0].name).toBe("create_pull_request");
		expect(ranker.rank("search", documents, 1)).toHaveLength(1);
		expect(ranker.rank("closed", documents, 8).map((match) => match.name)).toEqual(["list_issues"]);
	});

	it("returns nothing for unknown, empty, or stop-word queries and for a non-positive limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("kubernetes", documents, 8)).toEqual([]);
		expect(ranker.rank("the", documents, 8)).toEqual([]);
		expect(ranker.rank("", documents, 8)).toEqual([]);
		expect(ranker.rank("issue", documents, 0)).toEqual([]);
		expect(ranker.rank("issue", [], 8)).toEqual([]);
	});

	it("keeps document order for equal scores", () => {
		const twins: ToolSearchDocument[] = [
			{ name: "first", text: "alpha" },
			{ name: "second", text: "alpha" },
		];
		expect(new Bm25Ranker().rank("alpha", twins, 8).map((match) => match.name)).toEqual(["first", "second"]);
	});
});
