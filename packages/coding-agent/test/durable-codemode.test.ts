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
import { settlement } from "./durable-submission.ts";

/**
 * The durable codemode, tested on its own: the tool is off until it is activated, a script calls a tool whose exposure
 * is `codemode`, the namespace descriptions reach the section, and `getAllTools()` reports the native tool with the
 * metadata MCP reads. A faux provider scripts the model; no sandbox is mocked, so the scripts really run in a worker.
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

type Seen = { readonly offered: string[]; readonly text: string };

function recording(seen: Seen[], answer: () => AssistantMessage): FauxResponseStep {
	return (context) => {
		seen.push({
			offered: getCurrentTools(context.messages).map((tool) => tool.name),
			text: JSON.stringify(context.messages),
		});
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

/** Activates `codemode` through `setActiveTools`, as the MCP extension does when it needs it. */
const activateCodemode = (pi: ExtensionAPI) =>
	textTool("activate", () => {
		pi.setActiveTools([...pi.getActiveTools(), "codemode"]);
		return "activated";
	});

describe("durable codemode", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-codemode-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-codemode-cwd-"));
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

	test("codemode is off until it is activated; once active, a script calls a codemode-exposed tool and its result returns", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const current = await open(
			[
				recording(seen, () => call("activate", { text: "now" })),
				recording(seen, () => call("codemode", { code: "text(await tools.scripted({ text: 'inner' }));" }, "c1")),
				recording(seen, () => text("done")),
			],
			[
				(pi) => {
					pi.registerTool(activateCodemode(pi));
					pi.registerTool(
						textTool(
							"scripted",
							(input) => {
								runs.push(input);
								return `scripted:${input}`;
							},
							{ exposure: "codemode" },
						),
					);
				},
			],
		);
		expect(await settlement(current.controller.submitAndWait("go", "followUp"))).toMatchObject({ status: "done" });
		expect(seen[0]?.offered).not.toContain("codemode");
		expect(seen[1]?.offered).toContain("codemode");
		// The scripted tool is reached only through codemode: the model was never offered it.
		expect(seen[1]?.offered).not.toContain("scripted");
		expect(runs).toEqual(["inner"]);
		const codemodeResult = JSON.parse(seen[2]?.text ?? "[]") as {
			role: string;
			isError?: boolean;
			content?: unknown;
		}[];
		// The last tool result is the codemode call's: the first one is `activate`.
		const result = codemodeResult.filter((message) => message.role === "toolResult").at(-1);
		expect(result?.isError).toBe(false);
		expect(JSON.stringify(result?.content)).toContain("scripted:inner");
	});

	test("the codemode section lists a namespace with its description, so the script can find its tools", async () => {
		const seen: Seen[] = [];
		const current = await open(
			[recording(seen, () => call("activate", { text: "now" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(activateCodemode(pi));
					pi.registerTool(
						textTool("mcp__docs__read", (input) => input, {
							exposure: "codemode",
							namespace: { name: "mcp__docs", description: "DOCS-NAMESPACE-MARK" },
						}),
					);
				},
			],
		);
		expect(await settlement(current.controller.submitAndWait("go", "followUp"))).toMatchObject({ status: "done" });
		expect(seen[1]?.text).toContain("DOCS-NAMESPACE-MARK");
	});

	test("getAllTools reports codemode with the metadata MCP reads: model-only exposure and a reachesTools function", async () => {
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
		expect(await settlement(current.controller.submitAndWait("go", "followUp"))).toMatchObject({ status: "done" });
		const codemode = entries.find((entry) => entry.name === "codemode");
		expect(codemode?.exposure).toBe("model-only");
		expect(typeof codemode?.reachesTools).toBe("function");
	});
});
