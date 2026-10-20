import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";

/**
 * The durable RPC mode replaces the session behind a running client (`new_session`) and opens another one
 * (`switch_session`). Each of those opens has its own extension runner, so the mode has to bind its UI context to it:
 * an unbound runner reports `ctx.hasUI === false` and answers every dialog unanswered, and the client sees a command
 * run as if the user had cancelled every prompt. A dialog the client has not answered when the session it belongs to
 * goes away is settled with its default, and its id stops answering; a response shaped for another dialog is refused.
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

describe("durable RPC extension UI", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let exit: MockInstance;
	let probe: InlineExtension;

	// `process.exit` stays mocked for the whole file: a shutdown that a test starts itself finishes after the test, and a
	// restored process.exit would end the runner.
	beforeAll(() => {
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	});

	afterAll(() => {
		exit.mockRestore();
	});

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
		exit.mockClear();
		// The command asks a dialog and reports both what the mode offers it and what the user answered.
		probe = (pi: ExtensionAPI) => {
			pi.registerCommand("probe", {
				description: "Probe command",
				handler: async (_args, ctx) => {
					const answer = await ctx.ui.select("Probe dialog", ["first", "second"]);
					ctx.ui.notify(`ui:${ctx.hasUI} answer:${answer ?? "none"}`);
				},
			});
			pi.registerCommand("probe-confirm", {
				description: "Probe command with a confirm dialog",
				handler: async (_args, ctx) => {
					const confirmed = await ctx.ui.confirm("Probe confirm", "Continue?");
					ctx.ui.notify(`confirmed:${confirmed}`);
				},
			});
		};
	});

	afterEach(async () => {
		process.stdin.emit("end");
		await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20_000 });
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

	/** Run `/probe` and wait for its dialog request, without answering it. */
	async function openDialog(): Promise<string> {
		const from = records().length;
		await write({ type: "prompt", message: "/probe" });
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
		return String(request?.id);
	}

	/** The lines the probe command reported, in the order it reported them. */
	function notices(from: number): string[] {
		return records()
			.slice(from)
			.filter((record) => record.type === "extension_ui_request" && record.method === "notify")
			.map((record) => String(record.message));
	}

	/** Answer one dialog request as the client does. */
	function answer(requestId: string, response: Record_): void {
		rpcIo.handler?.(`${JSON.stringify({ type: "extension_ui_response", id: requestId, ...response })}\n`);
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

	test("a dialog the client leaves open is answered with its default when the session is replaced", async () => {
		await start();
		const from = records().length;
		const requestId = await openDialog();

		// A new session closes the session the command belongs to. Without settling, the command would wait on the dialog
		// for the rest of the run and an answer sent now would make it continue against the replaced session.
		await send({ type: "new_session" });
		await vi.waitFor(() => expect(notices(from)).toEqual(["ui:true answer:none"]), { timeout: 20_000 });

		answer(requestId, { value: "second" });
		const after = await probeWithDialog();
		expect(after).toBe("ui:true answer:second");
		expect(notices(from)).toEqual(["ui:true answer:none", "ui:true answer:second"]);
		expect(records().filter((record) => record.command === "extension_ui_response")).toEqual([]);
	});

	test("a dialog the client leaves open is answered with its default when the client switches session", async () => {
		await start();
		const state = (await send({ type: "get_state" })).data as { readonly sessionFile: string };
		const firstDirectory = dirname(state.sessionFile);
		await send({ type: "new_session" });

		const from = records().length;
		await openDialog();
		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: true, data: { cancelled: false } });
		await vi.waitFor(() => expect(notices(from)).toEqual(["ui:true answer:none"]), { timeout: 20_000 });
	});

	test("a dialog the client leaves open is answered with its default when the connection closes", async () => {
		await start();
		const from = records().length;
		await openDialog();

		process.stdin.emit("end");
		await vi.waitFor(() => expect(notices(from)).toEqual(["ui:true answer:none"]), { timeout: 20_000 });
		expect(exit).toHaveBeenCalledWith(0);
	});

	test("a confirm dialog takes its own answer, not only the select shape", async () => {
		await start();
		const from = records().length;
		await write({ type: "prompt", message: "/probe-confirm" });
		let request: Record_ | undefined;
		await vi.waitFor(
			() => {
				request = records()
					.slice(from)
					.find((record) => record.type === "extension_ui_request" && record.method === "confirm");
				expect(request).toBeDefined();
			},
			{ timeout: 20_000 },
		);
		answer(String(request?.id), { confirmed: true });
		await vi.waitFor(() => expect(notices(from)).toEqual(["confirmed:true"]), { timeout: 20_000 });
	});

	test("a response shaped for another dialog is refused and its own answer still arrives", async () => {
		await start();
		const from = records().length;
		const requestId = await openDialog();

		// `confirmed` answers a confirm dialog, not the select this request asked for. It used to be read as no answer at
		// all, which the command could not tell apart from the user cancelling.
		answer(requestId, { confirmed: true });
		await vi.waitFor(
			() =>
				expect(
					records()
						.slice(from)
						.find((record) => record.command === "extension_ui_response"),
				).toMatchObject({
					success: false,
					error: `Response for ${requestId} does not answer a select dialog`,
				}),
			{ timeout: 20_000 },
		);
		expect(notices(from)).toEqual([]);

		answer(requestId, { value: "second" });
		await vi.waitFor(() => expect(notices(from)).toEqual(["ui:true answer:second"]), { timeout: 20_000 });
	});
});
