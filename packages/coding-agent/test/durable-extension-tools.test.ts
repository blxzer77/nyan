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
 * Nyan tools on the durable path, with a faux provider registered by an extension. Each request is recorded: the tool
 * names the Harness declared, and the messages as JSON (system sections, tool results).
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

/** A faux response that records the request before answering with `answer`. */
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

/** A Nyan tool that answers with `run(text)`; extra fields extend the definition. */
function textTool(
	name: string,
	run: (input: string) => string | Promise<string>,
	extra: Partial<ToolDefinition<typeof params>> = {},
): ToolDefinition<typeof params> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: params,
		execute: async (_id, args) => ({ content: [{ type: "text", text: await run(args.text) }], details: undefined }),
		...extra,
	};
}

describe("extension tools on the durable path", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let durable: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-tools-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-tools-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		await durable?.close();
		durable = undefined;
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	/** Opens a session whose model is a faux provider scripted with `responses`. */
	async function open(responses: FauxResponseStep[], factories: InlineExtension[]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		durable = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return durable;
	}

	async function say(session: OpenDurableResult, content: string): Promise<string> {
		return (await session.controller.submitAndWait(content, "followUp")).status;
	}

	test("a registered tool is offered, runs, and its result and prompt snippet reach the next request", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const session = await open(
			[recording(seen, () => call("echo", { text: "hi" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(
						textTool(
							"echo",
							(input) => {
								runs.push(input);
								return `echo:${input}`;
							},
							{
								promptSnippet: "Echo text back.",
								promptGuidelines: ["Use echo to check the bridge."],
							},
						),
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[0]?.offered).toContain("echo");
		expect(runs).toEqual(["hi"]);
		expect(seen[1]?.text).toContain("echo:hi");
		expect(seen[1]?.text).toContain("Echo text back.");
		expect(seen[1]?.text).toContain("Use echo to check the bridge.");
	});

	test("tool_call can block a call: the reason reaches the model and the tool does not run", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const session = await open(
			[recording(seen, () => call("echo", { text: "hi" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(
						textTool("echo", (input) => {
							runs.push(input);
							return "ran";
						}),
					);
					pi.on("tool_call", (event) =>
						event.toolName === "echo" ? { block: true, reason: "BLOCK-MARK" } : undefined,
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(runs).toEqual([]);
		expect(seen[1]?.text).toContain("BLOCK-MARK");
	});

	test("tool_call can change the arguments in place, and the tool runs with the changed ones", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const session = await open(
			[recording(seen, () => call("echo", { text: "hi" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(
						textTool("echo", (input) => {
							runs.push(input);
							return `echo:${input}`;
						}),
					);
					pi.on("tool_call", (event) => {
						if (event.toolName === "echo") (event.input as Record<string, unknown>).text = "changed";
					});
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(runs).toEqual(["changed"]);
		expect(seen[1]?.text).toContain("echo:changed");
	});

	test("tool_result can replace the result the model sees", async () => {
		const seen: Seen[] = [];
		const session = await open(
			[recording(seen, () => call("echo", { text: "hi" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(textTool("echo", (input) => `echo:${input}`));
					pi.on("tool_result", (event) =>
						event.toolName === "echo" ? { content: [{ type: "text", text: "REDACTED" }] } : undefined,
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[1]?.text).toContain("REDACTED");
		expect(seen[1]?.text).not.toContain("echo:hi");
	});

	test("a tool registered during a run, after session start, is installed and offered in the next request", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const session = await open(
			[
				recording(seen, () => call("register", { text: "now" })),
				recording(seen, () => call("late", { text: "x" }, "t2")),
				recording(seen, () => text("done")),
			],
			[
				(pi) => {
					pi.registerTool(
						textTool("register", () => {
							// Registration after load: the runner's refreshTools must install the tool for the next request.
							pi.registerTool(
								textTool("late", (input) => {
									runs.push(input);
									return "late ran";
								}),
							);
							return "registered";
						}),
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[0]?.offered).not.toContain("late");
		expect(seen[1]?.offered).toContain("late");
		expect(runs).toEqual(["x"]);
	});

	test("setActiveTools activates a deferred tool, which is offered from the next request", async () => {
		const seen: Seen[] = [];
		const runs: string[] = [];
		const session = await open(
			[
				recording(seen, () => call("activate", { text: "now" })),
				recording(seen, () => call("later", { text: "x" }, "t2")),
				recording(seen, () => text("done")),
			],
			[
				(pi) => {
					pi.registerTool(
						textTool(
							"later",
							(input) => {
								runs.push(input);
								return "later ran";
							},
							{ exposure: "deferred" },
						),
					);
					pi.registerTool(
						textTool("activate", () => {
							pi.setActiveTools([...pi.getActiveTools(), "later"]);
							return "activated";
						}),
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[0]?.offered).not.toContain("later");
		expect(seen[1]?.offered).toContain("later");
		expect(runs).toEqual(["x"]);
	});

	test("exposure decides who is offered a tool: direct tools are offered; codemode, deferred, and hidden are not", async () => {
		const seen: Seen[] = [];
		const session = await open(
			[recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(textTool("direct-one", (input) => input));
					pi.registerTool(textTool("scripted", (input) => input, { exposure: "codemode" }));
					pi.registerTool(textTool("deferred-one", (input) => input, { exposure: "deferred" }));
					pi.registerTool(textTool("hidden-one", (input) => input, { exposure: "hidden" }));
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[0]?.offered).toContain("direct-one");
		expect(seen[0]?.offered).not.toContain("scripted");
		expect(seen[0]?.offered).not.toContain("deferred-one");
		expect(seen[0]?.offered).not.toContain("hidden-one");
	});

	test("a tool that declares an output schema but returns no structuredContent is an error result", async () => {
		const seen: Seen[] = [];
		const session = await open(
			[recording(seen, () => call("typed", { text: "hi" })), recording(seen, () => text("done"))],
			[
				(pi) => {
					pi.registerTool(
						textTool("typed", () => "plain text", { outputSchema: Type.Object({ ok: Type.Boolean() }) }),
					);
				},
			],
		);
		expect(await say(session, "go")).toBe("done");
		expect(seen[1]?.text).toContain('"isError":true');
	});
});
