import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@ny4n/agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
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
 * The `input` pipeline of the durable path. Legacy runs it at every submit entry, before skill and prompt-template
 * expansion, and a handler may transform the input, take it (`handled`), or leave it alone. The durable controller runs
 * it in `submit` and `submitAndWait`, so the TUI, print, JSON, and RPC paths all see the same handlers.
 */

const holdParams = Type.Object({});

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

interface Input {
	readonly text: string;
	readonly source: string;
	readonly streamingBehavior: string | undefined;
}

describe("durable input event", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-input-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-input-cwd-"));
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

	/** Opens the session and records the messages of every request. */
	async function open(
		factories: InlineExtension[],
		requests: AgentMessage[][],
		templateDir?: string,
	): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
			...(templateDir === undefined ? {} : { resources: { promptTemplatePaths: [templateDir] } }),
		});
		return session;
	}

	const lastUserText = (messages: AgentMessage[]): string => {
		const last = messages.findLast((message) => message.role === "user");
		if (last === undefined || !("content" in last)) return "";
		return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
	};

	test("a transform is what gets submitted", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("input", (event) => ({ action: "transform", text: `TRANSFORMED:${event.text}` }));
				},
			],
			requests,
		);
		expect((await settlement(current.controller.submitAndWait("original", "followUp"))).status).toBe("done");
		expect(lastUserText(requests[0] ?? [])).toBe("TRANSFORMED:original");
	});

	test("handled submits nothing, and continue submits the input as it is", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("input", (event) => (event.text === "take it" ? { action: "handled" } : { action: "continue" }));
				},
			],
			requests,
		);
		expect(await current.controller.submitAndWait("take it", "followUp")).toEqual({ handled: true });
		expect(requests).toHaveLength(0);
		expect(current.view.current().conversation.entries.some((entry) => entry.kind === "nyan.user")).toBe(false);

		expect((await settlement(current.controller.submitAndWait("keep it", "followUp"))).status).toBe("done");
		expect(lastUserText(requests[0] ?? [])).toBe("keep it");
	});

	test("a handled input on the TUI path submits nothing either", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
			requests,
		);
		await current.controller.submit("from the editor", "steer");
		expect(requests).toHaveLength(0);
		expect(current.view.current().conversation.entries.some((entry) => entry.kind === "nyan.user")).toBe(false);
	});

	test("the handlers run before skill and prompt-template expansion", async () => {
		const templateDir = join(cwd, "templates");
		await mkdir(templateDir, { recursive: true });
		await writeFile(
			join(templateDir, "probe.md"),
			"---\nname: probe\ndescription: Probe template\n---\nMARKER-TEMPLATE-$1\n",
		);
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					// The handler rewrites the input into a template call; only expansion after the handlers reaches the model.
					pi.on("input", () => ({ action: "transform", text: "/probe value" }));
				},
			],
			requests,
			templateDir,
		);
		expect((await settlement(current.controller.submitAndWait("/probe other", "followUp"))).status).toBe("done");
		expect(lastUserText(requests[0] ?? [])).toContain("MARKER-TEMPLATE-value");
	});

	test("the source and the streaming behavior are passed to the handlers", async () => {
		const seen: Input[] = [];
		const requests: AgentMessage[][] = [];
		const started: { release?: () => void; running?: boolean } = {};
		const waiting = new Promise<void>((resolve) => {
			started.release = resolve;
		});
		const hold: ToolDefinition<typeof holdParams> = {
			name: "hold",
			label: "hold",
			description: "answers once the test releases it",
			parameters: holdParams,
			execute: async () => {
				started.running = true;
				await waiting;
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxToolCall("hold", {}, { id: "call-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi) => {
			pi.registerProvider(faux.provider);
			pi.registerTool(hold);
			pi.on("input", (event) => {
				seen.push({ text: event.text, source: event.source, streamingBehavior: event.streamingBehavior });
			});
		};
		const current = await openDurable({
			cwd,
			extensionFactories: [provider],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		session = current;
		const running = settlement(current.controller.submitAndWait("idle", "followUp", { source: "rpc" }));
		await vi.waitFor(() => expect(started.running).toBe(true), { timeout: 20_000 });
		// A steer arrives during the run: legacy hands the handler the behavior it will be delivered with.
		await current.controller.submit("step", "steer");
		started.release?.();
		expect((await running).status).toBe("done");
		expect(seen).toEqual([
			{ text: "idle", source: "rpc", streamingBehavior: undefined },
			{ text: "step", source: "interactive", streamingBehavior: "steer" },
		]);
	});
});
