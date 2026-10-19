import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	ExtensionAPI,
	ExtensionHandler,
	InlineExtension,
	SessionStartEvent,
} from "../src/core/extensions/types.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";

/**
 * The durable RPC session operations through `--mode rpc`'s module, with a faux provider and a temporary home: queue
 * clearing, entries, the display name, the HTML export, and the fork commands. The RPC adapter opens its own session,
 * so the fake stdout and stdin are captured here and `stdin` end runs its shutdown.
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

async function waitForResponse(id: string): Promise<Record_> {
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
	async function start(responses: FauxResponseStep[], extra?: InlineExtension): Promise<void> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		void runDurableRpc({
			cwd,
			extensionFactories: extra === undefined ? [provider] : [provider, extra],
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
		expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({ cwd, name: "my-test-session" });

		// Legacy trims the name and drops line breaks; an empty name clears the title.
		await send({ type: "set_session_name", name: "  a\nb  " });
		expect((await state()).sessionName).toBe("a b");
		await send({ type: "set_session_name", name: "" });
		expect((await state()).sessionName).toBeUndefined();
		expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({ cwd });

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

	test("abort_retry ends the retry wait with the error the last attempt failed on", async () => {
		// A backoff far longer than the test, so only the stop request can end the wait.
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { baseDelayMs: 30_000, maxAgentDelayMs: 30_000 } }),
		);
		await start([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			answer("never"),
		]);
		// The prompt's response waits for the run, which the retry holds open.
		const prompt = await sendLater({ type: "prompt", message: "hello" });
		await vi.waitFor(() => expect(records().some((record) => record.type === "auto_retry_start")).toBe(true), {
			timeout: 20_000,
		});

		expect(await send({ type: "abort_retry" })).toMatchObject({ success: true, command: "abort_retry" });
		expect(await waitForResponse(prompt)).toMatchObject({ success: true, data: { disposition: "started" } });

		const emitted = records();
		// The turn ends as it does when retries run out: the backoff ends, then the run ends without a retried request.
		expect(emitted.some((record) => record.type === "auto_retry_end")).toBe(true);
		expect(emitted.some((record) => record.type === "agent_end" && record.willRetry === false)).toBe(true);
		expect((await state()).isStreaming).toBe(false);
		const entries = ((await send({ type: "get_entries" })).data as { entries: Record_[] }).entries;
		// The failed attempt is the last entry, and the answer the model would have given was never requested.
		expect((entries.at(-1)?.message as Record_).stopReason).toBe("error");
		expect(JSON.stringify(emitted)).not.toContain("never");

		// With no retry waiting the command still succeeds, as legacy's does.
		expect(await send({ type: "abort_retry" })).toMatchObject({ success: true, command: "abort_retry" });
	});

	test("fork starts a second conversation at a user message and moves the session to it", async () => {
		await start([answer("first answer"), answer("second answer")]);
		await send({ type: "prompt", message: "hello" });
		const before = await state();
		const entries = ((await send({ type: "get_entries" })).data as { entries: Record_[] }).entries;
		const userId = String(entries[0]?.id);

		expect(await send({ type: "get_fork_messages" })).toMatchObject({
			data: { messages: [{ entryId: userId, text: "hello" }] },
		});

		const forked = await send({ type: "fork", entryId: userId });
		expect(forked).toMatchObject({ success: true, data: { text: "hello", cancelled: false } });
		const after = await state();
		// A fork is a conversation in the same session, so the session id and file do not change.
		expect(after.sessionId).toBe(before.sessionId);
		expect(after.sessionFile).toBe(before.sessionFile);
		expect(after.messageCount).toBe(1);

		// The forked conversation is the one prompts now reach, and its events arrive on a new stream.
		const written = records().length;
		await send({ type: "prompt", message: "again" });
		const emitted = records().slice(written);
		expect(emitted.some((record) => record.type === "message_end")).toBe(true);
		const messages = ((await send({ type: "get_messages" })).data as { messages: Record_[] }).messages;
		// Positional prompt entries reach the model too, so only the conversation roles are compared.
		expect(messages.map((message) => message.role).filter((role) => role !== "system")).toEqual([
			"user",
			"user",
			"assistant",
		]);
		expect(JSON.stringify(messages)).toContain("second answer");

		// Only a user message can be forked from, and only an entry the session has.
		const assistantId = String(entries[1]?.id);
		expect(await send({ type: "fork", entryId: assistantId })).toMatchObject({
			success: false,
			command: "fork",
		});
		expect(await send({ type: "fork", entryId: "not-an-entry" })).toMatchObject({
			success: false,
			command: "fork",
		});
	});

	test("clone forks at the newest entry and keeps the whole conversation", async () => {
		await start([answer("clone answer")]);
		await send({ type: "prompt", message: "hello clone" });
		const before = await state();

		const cloned = await send({ type: "clone" });
		expect(cloned).toMatchObject({ success: true, data: { cancelled: false } });
		const after = await state();
		expect(after.sessionId).toBe(before.sessionId);
		expect(after.messageCount).toBe(before.messageCount);
		const messages = ((await send({ type: "get_messages" })).data as { messages: Record_[] }).messages;
		expect(JSON.stringify(messages)).toContain("clone answer");
	});

	test("bash records included output, excludes requested output from context, and streams updates", async () => {
		await start([]);
		const included = await send({ type: "bash", command: "printf 'included durable bash\\n'" });
		expect(included).toMatchObject({
			success: true,
			command: "bash",
			data: { output: "included durable bash\n", exitCode: 0, cancelled: false, truncated: false },
		});
		expect(
			records().some(
				(record) => record.type === "bash_execution_update" && record.delta === "included durable bash\n",
			),
		).toBe(true);

		const excluded = await send({
			type: "bash",
			command: "printf 'excluded durable bash\\n'",
			excludeFromContext: true,
		});
		expect(excluded).toMatchObject({ success: true, data: { output: "excluded durable bash\n" } });
		const messages = ((await send({ type: "get_messages" })).data as { messages: Record_[] }).messages;
		expect(JSON.stringify(messages)).toContain("included durable bash");
		expect(JSON.stringify(messages)).not.toContain("excluded durable bash");
	});

	test("abort_bash cancels the durable execution and returns its partial result", async () => {
		await start([]);
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 30000)")}`;
		const bashId = await sendLater({ type: "bash", command });
		await send({ type: "abort_bash" });
		const aborted = await waitForResponse(bashId);
		expect(aborted).toMatchObject({ success: true, command: "bash", data: { cancelled: true } });
	});

	test("get_tree returns the active chain, matching the entries and the leaf", async () => {
		await start([answer("tree answer")]);
		await send({ type: "prompt", message: "hello tree" });
		const entries = (await send({ type: "get_entries" })).data as { entries: Record_[]; leafId: string };
		const tree = (await send({ type: "get_tree" })).data as { tree: Record_[]; leafId: string };

		expect(tree.leafId).toBe(entries.leafId);
		// One linear chain of nodes, in append order.
		const chainIds: string[] = [];
		let nodes = tree.tree;
		while (nodes.length > 0) {
			expect(nodes).toHaveLength(1);
			const node = nodes[0] as { entry: Record_; children: Record_[] };
			chainIds.push(String(node.entry.id));
			nodes = node.children;
		}
		expect(chainIds).toEqual(entries.entries.map((entry) => entry.id));
	});

	test("switch_session opens the target directory, uses its cwd, and moves the event stream", async () => {
		const starts: Array<{ type: "session_start"; reason: string; previousSessionFile?: string; cwd: string }> = [];
		const observer: InlineExtension = (pi) => {
			const onStart: ExtensionHandler<SessionStartEvent> = (event, ctx) => {
				starts.push({ ...event, cwd: ctx.cwd });
			};
			pi.on("session_start", onStart);
		};
		await start([answer("after switch")], observer);
		const first = await state();
		const firstDirectory = dirname(String(first.sessionFile));
		await writeFile(join(firstDirectory, "session.json"), JSON.stringify({ cwd: tmpdir() }));
		await send({ type: "new_session" });
		const second = await state();
		const secondDirectory = dirname(String(second.sessionFile));
		expect(secondDirectory).not.toBe(firstDirectory);

		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: true, command: "switch_session", data: { cancelled: false } });
		const after = await state();
		expect(after.sessionFile).toBe(first.sessionFile);
		expect(after.sessionId).toBe(first.sessionId);
		expect(starts).toContainEqual({
			type: "session_start",
			reason: "resume",
			previousSessionFile: second.sessionFile,
			cwd: tmpdir(),
		});

		const written = records().length;
		await send({ type: "prompt", message: "prompt in switched session" });
		expect(
			records()
				.slice(written)
				.some((record) => record.type === "message_end"),
		).toBe(true);
	});

	test("switch_session cancellation leaves the current session open", async () => {
		const observer: InlineExtension = (pi) => {
			pi.on("session_before_switch", () => ({ cancel: true }));
		};
		await start([], observer);
		const first = await state();
		const firstDirectory = dirname(String(first.sessionFile));
		await send({ type: "new_session" });
		const current = await state();
		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: true, command: "switch_session", data: { cancelled: true } });
		expect((await state()).sessionFile).toBe(current.sessionFile);
	});

	test("switch_session reports a named lock failure and preserves the current session", async () => {
		await start([]);
		const first = await state();
		const firstDirectory = dirname(String(first.sessionFile));
		await send({ type: "new_session" });
		const current = await state();
		const release = await lockfile.lock(firstDirectory, { realpath: false, stale: 60_000, retries: 0 });
		try {
			const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
			expect(switched).toMatchObject({ success: false, command: "switch_session" });
			expect(String(switched.error)).toContain("[DURABLE_SESSION_LOCKED]");
			expect(String(switched.error)).toContain(firstDirectory);
		} finally {
			await release();
		}
		expect((await state()).sessionFile).toBe(current.sessionFile);
	});

	test("switch_session refuses a missing recorded cwd without guessing the current cwd", async () => {
		await start([]);
		const first = await state();
		const firstDirectory = dirname(String(first.sessionFile));
		await send({ type: "new_session" });
		const current = await state();
		await writeFile(join(firstDirectory, "session.json"), JSON.stringify({ cwd: join(cwd, "missing-cwd") }));

		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: false, command: "switch_session" });
		expect(String(switched.error)).toContain("[DURABLE_SESSION_CWD_NOT_FOUND]");
		expect((await state()).sessionFile).toBe(current.sessionFile);
	});

	test("switch_session refuses an old session without cwd metadata", async () => {
		await start([]);
		const first = await state();
		const firstDirectory = dirname(String(first.sessionFile));
		await send({ type: "new_session" });
		const current = await state();
		await writeFile(join(firstDirectory, "session.json"), JSON.stringify({ name: "old session" }));

		const switched = await send({ type: "switch_session", sessionPath: firstDirectory });
		expect(switched).toMatchObject({ success: false, command: "switch_session" });
		expect(String(switched.error)).toContain("[DURABLE_SESSION_CWD_MISSING]");
		expect((await state()).sessionFile).toBe(current.sessionFile);
	});

	test("switch_session rejects a legacy JSONL file with a named read-only error", async () => {
		await start([]);
		const current = await state();
		const legacy = join(cwd, "legacy.jsonl");
		await writeFile(legacy, "{}\n");

		const switched = await send({ type: "switch_session", sessionPath: legacy });
		expect(switched).toMatchObject({ success: false, command: "switch_session" });
		expect(String(switched.error)).toContain("[DURABLE_SESSION_DIRECTORY_REQUIRED]");
		expect(String(switched.error)).toContain("Legacy JSONL sessions are read-only");
		expect((await state()).sessionFile).toBe(current.sessionFile);
	});
});
