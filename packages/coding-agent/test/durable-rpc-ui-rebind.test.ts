import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";

/**
 * The durable RPC mode replaces the session behind a running client (`new_session`) and opens another one
 * (`switch_session`). Each of those opens has its own extension runner, so the mode has to bind its UI context to it:
 * an unbound runner reports `ctx.hasUI === false` and answers every dialog unanswered, and the client sees a command
 * run as if the user had cancelled every prompt.
 */

const rpcIo = vi.hoisted(() => ({
	lines: [] as string[],
	handler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.lines.push(line);
	},
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	flushRawStdout: vi.fn(async () => {}),
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.handler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type Record_ = Record<string, unknown>;

function records(): Record_[] {
	return rpcIo.lines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record_);
}

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

let requests = 0;

async function write(command: Record_): Promise<void> {
	await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 10_000 });
	rpcIo.handler?.(`${JSON.stringify({ ...command, id: `req-${++requests}` })}\n`);
}

/** Send a command and wait for its response; a command holds its response until its handler returns. */
async function send(command: Record_): Promise<Record_> {
	await write(command);
	const id = `req-${requests}`;
	let response: Record_ | undefined;
	await vi.waitFor(
		() => {
			response = records().find((record) => record.type === "response" && record.id === id);
			expect(response).toBeDefined();
		},
		{ timeout: 20_000 },
	);
	return response as Record_;
}

describe("durable RPC extension UI after a reopen", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let exit: MockInstance;
	let probe: InlineExtension;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-rpc-rebind-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-rpc-rebind-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		rpcIo.lines = [];
		rpcIo.handler = undefined;
		requests = 0;
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		// The command asks a dialog and reports both what the mode offers it and what the user answered.
		probe = (pi: ExtensionAPI) => {
			pi.registerCommand("probe", {
				description: "Probe command",
				handler: async (_args, ctx) => {
					const answer = await ctx.ui.select("Probe dialog", ["first", "second"]);
					ctx.ui.notify(`ui:${ctx.hasUI} answer:${answer ?? "none"}`);
				},
			});
		};
	});

	afterEach(async () => {
		process.stdin.emit("end");
		await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20_000 });
		exit.mockRestore();
		process.stdin.removeAllListeners("end");
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	/** Start the adapter with a faux provider and the probe command. */
	async function start(): Promise<void> {
		const faux = fauxProvider();
		faux.setResponses([() => fauxAssistantMessage([fauxText("answer")])]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi) => {
			pi.registerProvider(faux.provider);
		};
		void runDurableRpc({
			cwd,
			extensionFactories: [provider, probe],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 20_000 });
	}

	/** Run `/probe` and answer its dialog, returning what the command reported. */
	async function probeWithDialog(): Promise<string> {
		const from = records().length;
		await write({ type: "prompt", message: "/probe" });
		const id = `req-${requests}`;
		let request: Record_ | undefined;
		await vi.waitFor(
			() => {
				request = records()
					.slice(from)
					.find((record) => record.type === "extension_ui_request" && record.method === "select");
				expect(request).toBeDefined();
			},
			{ timeout: 20_000 },
		);
		const requestId = String(request?.id);
		rpcIo.handler?.(`${JSON.stringify({ type: "extension_ui_response", id: requestId, value: "second" })}\n`);
		await vi.waitFor(
			() => {
				expect(records().some((record) => record.type === "response" && record.id === id)).toBe(true);
			},
			{ timeout: 20_000 },
		);
		const notice = records()
			.slice(from)
			.find((record) => record.type === "extension_ui_request" && record.method === "notify");
		return String(notice?.message);
	}

	test("an extension command keeps its dialogs after new_session and switch_session", async () => {
		await start();

		// The first session, as the client that has not replaced anything yet sees it.
		const first = await probeWithDialog();
		expect(first).toBe("ui:true answer:second");
		const state = (await send({ type: "get_state" })).data as { readonly sessionFile: string };
		const firstDirectory = dirname(state.sessionFile);

		await send({ type: "new_session" });
		const afterNew = await probeWithDialog();
		expect(afterNew).toBe("ui:true answer:second");

		// Switching back opens yet another session, with its own runner.
		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: true, data: { cancelled: false } });
		const afterSwitch = await probeWithDialog();
		expect(afterSwitch).toBe("ui:true answer:second");
	});
});
