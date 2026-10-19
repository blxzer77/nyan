import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";

/**
 * The durable RPC session operations through `--mode rpc`'s module, with a faux provider and a temporary home: queue
 * clearing, entries, the display name, and the HTML export. The RPC adapter opens its own session, so the fake stdout
 * and stdin are captured here and `stdin` end runs its shutdown.
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

let requests = 0;

/** Send one command and wait for its response. */
async function send(command: Record_): Promise<Record_> {
	const id = `req-${++requests}`;
	await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 10_000 });
	rpcIo.handler?.(`${JSON.stringify({ ...command, id })}\n`);
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

/** Send a command without waiting for its response; a prompt holds its response until the run settles. */
async function sendLater(command: Record_): Promise<string> {
	const id = `req-${++requests}`;
	await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 10_000 });
	rpcIo.handler?.(`${JSON.stringify({ ...command, id })}\n`);
	return id;
}

/** An answer the test holds back, so the conversation stays busy while the test queues input. */
function gate(): { step: FauxResponseStep; release: () => void } {
	let release: () => void = () => {};
	const step: FauxResponseStep = () =>
		new Promise<AssistantMessage>((resolve) => {
			release = () => resolve(fauxAssistantMessage("released"));
		});
	return { step, release: () => release() };
}

/** The session an export embeds, decoded: the page carries it base64-encoded. */
function exportedSessionData(html: string): Record_ {
	const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/u.exec(html);
	expect(match).not.toBeNull();
	return JSON.parse(Buffer.from(match?.[1] ?? "", "base64").toString("utf8")) as Record_;
}

const answer = (text: string): FauxResponseStep => fauxAssistantMessage([fauxText(text)]);

describe("durable RPC session operations", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let exit: MockInstance;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-rpc-ops-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-rpc-ops-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		rpcIo.lines = [];
		rpcIo.handler = undefined;
		requests = 0;
		// The adapter ends its shutdown with `process.exit`; the test keeps the process.
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	});

	afterEach(async () => {
		process.stdin.emit("end");
		await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20_000 });
		exit.mockRestore();
		// The adapter registers its shutdown on `process.stdin` and does not remove it; only this file listens here.
		process.stdin.removeAllListeners("end");
		vi.unstubAllEnvs();
		// A durable session worker can still be writing under $HOME when the test ends; retry, as Node documents.
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	/** Start the adapter with scripted faux answers; the resolved promise never settles, as the real mode. */
	async function start(responses: FauxResponseStep[]): Promise<void> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		void runDurableRpc({
			cwd,
			extensionFactories: [provider],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: {
				cwd,
				mode: "print",
				hasUI: false,
				ui: {
					select: async () => undefined,
					confirm: async () => false,
					input: async () => undefined,
					notify: () => {},
				},
			},
		});
		await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 20_000 });
	}

	test("clear_queue returns the waiting steering and follow-up texts", async () => {
		const held = gate();
		await start([held.step]);
		// The prompt's response waits for the run, which the gate holds open.
		const prompt = await sendLater({ type: "prompt", message: "start" });
		await vi.waitFor(
			async () => {
				const state = await send({ type: "get_state" });
				expect(state.data).toMatchObject({ isStreaming: true });
			},
			{ timeout: 20_000 },
		);
		// Both commands queue their input before they wait for the run.
		const steer = await sendLater({ type: "steer", message: "change direction" });
		const followUp = await sendLater({ type: "follow_up", message: "summarize" });
		await vi.waitFor(
			async () => {
				const state = await send({ type: "get_state" });
				expect(state.data).toMatchObject({ pendingMessageCount: 2 });
			},
			{ timeout: 20_000 },
		);

		const cleared = await send({ type: "clear_queue" });
		expect(cleared).toMatchObject({ success: true, command: "clear_queue" });
		expect(cleared.data).toEqual({ steering: ["change direction"], followUp: ["summarize"] });
		const after = await send({ type: "get_state" });
		expect(after.data).toMatchObject({ pendingMessageCount: 0 });

		held.release();
		await vi.waitFor(
			() => {
				for (const id of [prompt, steer, followUp]) {
					expect(records().some((record) => record.type === "response" && record.id === id)).toBe(true);
				}
			},
			{ timeout: 20_000 },
		);
	});

	test("get_entries maps the session to legacy entries with a cursor and a leaf", async () => {
		await start([answer("first answer")]);
		await send({ type: "prompt", message: "hello" });

		const all = await send({ type: "get_entries" });
		expect(all).toMatchObject({ success: true, command: "get_entries" });
		const entries = (all.data as { entries: Record_[] }).entries;
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "message", parentId: null, message: { role: "user" } });
		expect(entries[1]).toMatchObject({
			type: "message",
			parentId: entries[0]?.id,
			message: { role: "assistant" },
		});
		const leafId = (all.data as { leafId: string }).leafId;
		expect(leafId).toBe(entries[1]?.id);
		expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

		const since = await send({ type: "get_entries", since: entries[0]?.id });
		expect((since.data as { entries: Record_[] }).entries.map((entry) => entry.id)).toEqual([entries[1]?.id]);
		expect((since.data as { leafId: string }).leafId).toBe(leafId);

		// A cursor at the leaf returns nothing, and the leaf still names the newest entry of the session.
		const atLeaf = await send({ type: "get_entries", since: leafId });
		expect((atLeaf.data as { entries: Record_[] }).entries).toEqual([]);
		expect((atLeaf.data as { leafId: string }).leafId).toBe(leafId);

		const unknown = await send({ type: "get_entries", since: "not-an-entry" });
		expect(unknown).toMatchObject({ success: false, command: "get_entries" });
		expect(String(unknown.error)).toContain("Entry not found: not-an-entry");
	});

	/** The `get_state` data, which the session operations read and change. */
	async function state(): Promise<Record_> {
		return (await send({ type: "get_state" })).data as Record_;
	}

	test("set_session_name stores the name beside the database, and an empty name clears it", async () => {
		await start([answer("hi")]);
		await send({ type: "prompt", message: "hello" });
		expect((await state()).sessionName).toBeUndefined();

		expect(await send({ type: "set_session_name", name: "my-test-session" })).toMatchObject({ success: true });
		expect((await state()).sessionName).toBe("my-test-session");
		const sessionFile = String((await state()).sessionFile);
		const metadata = join(dirname(sessionFile), "session.json");
		expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({ name: "my-test-session" });

		// Legacy trims the name and drops line breaks; an empty name clears the title.
		await send({ type: "set_session_name", name: "  a\nb  " });
		expect((await state()).sessionName).toBe("a b");
		await send({ type: "set_session_name", name: "" });
		expect((await state()).sessionName).toBeUndefined();
		expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({});

		// A new session has its own directory, so it starts without a name.
		await send({ type: "new_session" });
		expect((await state()).sessionName).toBeUndefined();
	});

	test("export_html writes the session as a standalone page", async () => {
		await start([answer("exported answer")]);
		await send({ type: "prompt", message: "hello export" });
		const sessionId = String((await state()).sessionId);

		const explicit = join(cwd, "explicit.html");
		const exported = await send({ type: "export_html", outputPath: explicit });
		expect(exported).toMatchObject({ success: true, command: "export_html" });
		expect((exported.data as { path: string }).path).toBe(explicit);
		const html = readFileSync(explicit, "utf8");
		const data = exportedSessionData(html);
		expect(data.header).toMatchObject({ id: sessionId, cwd });
		const messages = JSON.stringify((data.entries as Record_[]).map((entry) => entry.message));
		expect(messages).toContain("hello export");
		expect(messages).toContain("exported answer");

		// Without an output path the file is named after the session, as a JSONL session's export is, and lands in the
		// working directory of the process.
		const fallback = await send({ type: "export_html" });
		const path = (fallback.data as { path: string }).path;
		expect(basename(path)).toBe(`nyan-session-${sessionId}.html`);
		expect(existsSync(path)).toBe(true);
		rmSync(path, { force: true });
	});

	test("abort_retry stays unavailable until durable can cancel a retry wait alone", async () => {
		await start([answer("hi")]);
		const retry = await send({ type: "abort_retry" });
		expect(retry).toMatchObject({ success: false, command: "abort_retry" });
		expect(String(retry.error)).toContain("retry-only cancellation");
	});
});
