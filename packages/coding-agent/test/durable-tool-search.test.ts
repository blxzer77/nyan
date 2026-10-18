import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	Type,
} from "@ny4n/ai";
import { getCurrentTools } from "@ny4n/ai/utils/transcript";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type {
	ExtensionAPI,
	InlineExtension,
	ProjectTrustContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

/**
 * The durable tool search, tested on its own: it is off until activated, it loads a deferred tool that matches its query
 * into the next request, and `getAllTools()` reports it with the metadata MCP reads. The tools are scripted with a faux
 * provider; the deferred tool is one the model is not offered until the search loads it.
 */

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

type Seen = { readonly offered: string[] };

function recording(seen: Seen[], answer: () => AssistantMessage): FauxResponseStep {
	return (context) => {
		seen.push({ offered: getCurrentTools(context.messages).map((tool) => tool.name) });
		return answer();
	};
}

const call = (name: string, args: Record<string, string>, id = "t1") =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const text = (answer: string) => fauxAssistantMessage([fauxText(answer)]);

const params = Type.Object({ text: Type.String() });

function textTool(
	name: string,
	run: (input: string) => string,
	extra: Partial<ToolDefinition<typeof params>> = {},
): ToolDefinition<typeof params> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: params,
		execute: async (_id, args) => ({ content: [{ type: "text", text: run(args.text) }], details: undefined }),
		...extra,
	};
}

describe("durable tool search", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-search-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-search-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	async function open(responses: FauxResponseStep[], factories: InlineExtension[]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("tool search is off until activated; once active, a query loads the deferred tool into the next request", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const current = await open(
			[
				recording(seen, () => call("activate", { text: "now" })),
				recording(seen, () => call("tool_search", { query: "late" }, "s1")),
				recording(seen, () => call("late_tool", { text: "x" }, "l1")),
				recording(seen, () => text("done")),
			],
			[
				(pi) => {
					pi.registerTool(
						textTool("activate", () => {
							pi.setActiveTools([...pi.getActiveTools(), "tool_search"]);
							return "activated";
						}),
					);
					pi.registerTool(
						textTool(
							"late_tool",
							(input) => {
								runs.push(input);
								return "late ran";
							},
							{ exposure: "deferred" },
						),
					);
				},
			],
		);
		expect(await current.controller.submitAndWait("go", "followUp")).toMatchObject({ status: "done" });
		expect(seen[0]?.offered).not.toContain("tool_search");
		expect(seen[0]?.offered).not.toContain("late_tool");
		expect(seen[1]?.offered).toContain("tool_search");
		// The search loads the deferred tool: the request after the search declares it.
		expect(seen[1]?.offered).not.toContain("late_tool");
		expect(seen[2]?.offered).toContain("late_tool");
		expect(runs).toEqual(["x"]);
	});

	test("getAllTools reports tool_search with the metadata MCP reads: model-only exposure and a reachesTools function", async () => {
		const seen: Seen[] = [];
		let entries: { name: string; exposure: string; reachesTools?: unknown }[] = [];
		const current = await open(
			[recording(seen, () => call("reader", { text: "x" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(
						textTool("reader", (input) => {
							entries = pi.getAllTools();
							return input;
						}),
					);
				},
			],
		);
		expect(await current.controller.submitAndWait("go", "followUp")).toMatchObject({ status: "done" });
		const search = entries.find((entry) => entry.name === "tool_search");
		expect(search?.exposure).toBe("model-only");
		expect(typeof search?.reachesTools).toBe("function");
	});
});
