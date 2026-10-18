import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

/**
 * MCP acceptance for the durable path. The server is the shared stdio fixture from packages/mcp, started as a local child
 * process with `process.execPath`; no network. The model is a faux provider scripted to call the server's `echo` tool.
 * The default exposure of MCP tools is `codemode`, which reaches the model only through codemode (batch 2b), so the
 * server is configured `direct` here.
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

const wrapper = fileURLToPath(new URL("./fixtures/mcp-stdio-probe.mjs", import.meta.url));

vi.setConfig({ testTimeout: 60_000 });

let home: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "nyan-mcp-home-"));
	agentDir = join(home, ".nyan", "agent");
	cwd = await mkdtemp(join(tmpdir(), "nyan-mcp-cwd-"));
	await mkdir(agentDir, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
});

/** True once the process is gone; false when it is still running after the wait. */
async function exited(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

test("an MCP tool is offered, runs in a local stdio child, and the child exits when the session closes", async () => {
	const pidFile = join(home, "mcp-probe.pid");
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { probe: { command: process.execPath, args: [wrapper, pidFile], exposure: "direct" } },
		}),
	);

	const faux = fauxProvider();
	const offered: string[][] = [];
	const texts: string[] = [];
	let toolName: string | undefined;
	const first: FauxResponseStep = (context): AssistantMessage => {
		const names = getCurrentTools(context.messages).map((tool) => tool.name);
		offered.push(names);
		toolName = names.find((name) => name.includes("echo"));
		if (toolName === undefined) return fauxAssistantMessage([fauxText("no echo tool offered")]);
		return fauxAssistantMessage([fauxToolCall(toolName, { text: "via-mcp" }, { id: "m1" })], {
			stopReason: "toolUse",
		});
	};
	const second: FauxResponseStep = (context): AssistantMessage => {
		texts.push(JSON.stringify(context.messages));
		return fauxAssistantMessage([fauxText("done")]);
	};
	faux.setResponses([first, second]);
	const model = faux.getModel();
	const provider: InlineExtension = (pi: ExtensionAPI) => {
		pi.registerProvider(faux.provider);
	};

	const durable: OpenDurableResult = await openDurable({
		cwd,
		extensionFactories: [provider, ...builtInExtensions],
		model: { provider: model.provider, modelId: model.id },
		projectTrustContext: { ...headless, cwd },
	});
	let pid: number | undefined;
	try {
		const settled = await durable.controller.submitAndWait("go", "followUp");
		expect(settled.status).toBe("done");
		expect(toolName, JSON.stringify({ offered, notices: durable.view.current().notices })).toBeDefined();
		expect(offered[0]).toContain(toolName);
		// The tool's own result, not the arguments the model sent: a blocked call has an error result instead.
		const messages: { role: string; isError?: boolean; content?: unknown }[] = JSON.parse(texts[0] ?? "[]");
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.isError).toBe(false);
		expect(JSON.stringify(toolResult?.content)).toContain("via-mcp");
		// The MCP tool_call handler reads the runner's tool list; a handler error would show here as a notice.
		expect(durable.view.current().notices.map((notice) => notice.message)).toEqual([]);
		pid = Number(await readFile(pidFile, "utf8"));
		expect(Number.isInteger(pid)).toBe(true);
	} finally {
		await durable.close("quit");
	}
	if (pid === undefined) throw new Error("the MCP child did not record its pid");
	// Closing the session shuts the MCP client down, which ends the stdio child.
	expect(await exited(pid)).toBe(true);
});

test("an MCP tool with the default exposure is reached through codemode: MCP activates codemode, and a script calls the tool", async () => {
	const pidFile = join(home, "mcp-probe-codemode.pid");
	await writeFile(
		join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [wrapper, pidFile] } } }),
	);
	const faux = fauxProvider();
	const offered: string[][] = [];
	const messages: string[] = [];
	const record =
		(answer: () => AssistantMessage): FauxResponseStep =>
		(context): AssistantMessage => {
			offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
			messages.push(JSON.stringify(context.messages));
			return answer();
		};
	faux.setResponses([
		record(() => fauxAssistantMessage([fauxToolCall("wait", {}, { id: "w1" })], { stopReason: "toolUse" })),
		record(() =>
			fauxAssistantMessage(
				[
					fauxToolCall(
						"codemode",
						{ code: "text(await tools.mcp__probe__echo({ text: 'via-codemode' }));" },
						{ id: "c1" },
					),
				],
				{ stopReason: "toolUse" },
			),
		),
		record(() => fauxAssistantMessage([fauxText("done")])),
	]);
	const model = faux.getModel();
	const provider: InlineExtension = (pi: ExtensionAPI) => {
		pi.registerProvider(faux.provider);
		// Waits until the MCP tool is registered. Codemode may be active before that: MCP activates it from the config at
		// session start, before the server has connected.
		pi.registerTool({
			name: "wait",
			label: "wait",
			description: "Waits until codemode is active.",
			parameters: Type.Object({}),
			execute: async () => {
				const ready = () =>
					pi.getActiveTools().includes("codemode") &&
					pi.getAllTools().some((tool) => tool.name === "mcp__probe__echo");
				for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				return { content: [{ type: "text", text: "waited" }], details: undefined };
			},
		});
	};

	const durable: OpenDurableResult = await openDurable({
		cwd,
		extensionFactories: [provider, ...builtInExtensions],
		model: { provider: model.provider, modelId: model.id },
		projectTrustContext: { ...headless, cwd },
	});
	let pid: number | undefined;
	try {
		expect((await durable.controller.submitAndWait("go", "followUp")).status).toBe("done");
		expect(offered[1]).toContain("codemode");
		expect(offered[1]).not.toContain("mcp__probe__echo");
		const last = (JSON.parse(messages[2] ?? "[]") as { role: string; isError?: boolean; content?: unknown }[])
			.filter((message) => message.role === "toolResult")
			.at(-1);
		expect(last?.isError, JSON.stringify(last?.content)).toBe(false);
		expect(JSON.stringify(last?.content)).toContain("via-codemode");
		pid = Number(await readFile(pidFile, "utf8"));
	} finally {
		await durable.close("quit");
	}
	if (pid === undefined) throw new Error("the MCP child did not record its pid");
	expect(await exited(pid)).toBe(true);
});
