import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import { readSessionMetadata } from "../src/core/durable/sessions.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { sourceRuntimeArgs } from "../src/experimental/source-runtime-args.ts";
import { settlement } from "./durable-submission.ts";

/**
 * Decision #25 through the real entry point: each session-selection flag, spawned as a child with a temporary home, and
 * observed through `--mode rpc`. `get_state` reports the session the run actually opened (`sessionFile`, `sessionId`,
 * `sessionName`, `messageCount`), so a flag that opens the wrong session, or none, fails here; no provider is needed and
 * nothing reaches the network.
 */

const cliPath = resolve(__dirname, "../src/cli.ts");
const SESSION_DIRECTORY = /^\d{13}-[0-9a-f-]{36}$/u;

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

let root: string;
let agentDir: string;
let projectDir: string;
let storeRoot: string;
let session: OpenDurableResult | undefined;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "nyan-selection-cli-")));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	storeRoot = join(root, "store");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("USERPROFILE", root);
	vi.stubEnv("NYAN_OFFLINE", "1");
});

afterEach(async () => {
	await session?.close();
	session = undefined;
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface CliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** The `get_state` the durable RPC mode answers, as the run's own report of the session it opened. */
interface RpcState {
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly sessionName?: string;
	readonly messageCount: number;
}

function spawnCli(args: readonly string[], stdin: string): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [...sourceRuntimeArgs(), cliPath, ...args], {
			cwd: projectDir,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, NYAN_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

/** Run the CLI and read the state of the session it opened. */
async function runRpc(args: readonly string[]): Promise<CliResult & { state?: RpcState }> {
	const result = await spawnCli(["--mode", "rpc", ...args], `${JSON.stringify({ id: "1", type: "get_state" })}\n`);
	const line = result.stdout
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith("{"));
	if (line === undefined) return { ...result, state: undefined };
	const parsed = JSON.parse(line) as { command?: string; success?: boolean; data?: RpcState };
	if (parsed.command !== "get_state" || parsed.success !== true) return { ...result, state: undefined };
	return { ...result, state: parsed.data };
}

/** Every path below `directory`, so a run that left a session behind is visible. */
function pathsBelow(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const paths: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		paths.push(path, ...(entry.isDirectory() ? pathsBelow(path) : []));
	}
	return paths.sort();
}

/** Every session directory below the store, so a run that started a session is visible whatever files it wrote. */
function sessionDirectories(directory: string): string[] {
	const directories: string[] = [];
	const walk = (path: string): void => {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = join(path, entry.name);
			if (SESSION_DIRECTORY.test(entry.name)) directories.push(child);
			else walk(child);
		}
	};
	walk(directory);
	return directories.sort();
}

/** A real durable session with one answered turn: something to open, to name, and to fork from. */
async function seedAnsweredSession(): Promise<{ directory: string; entryId: string; messages: number }> {
	const faux = fauxProvider();
	faux.setResponses([() => fauxAssistantMessage([fauxText("first answer")])]);
	const model = faux.getModel();
	const provider: InlineExtension = (api: ExtensionAPI) => {
		api.registerProvider(faux.provider);
	};
	session = await openDurable({
		cwd: projectDir,
		extensionFactories: [provider],
		model: { provider: model.provider, modelId: model.id },
		projectTrustContext: { ...headless, cwd: projectDir },
	});
	expect((await settlement(session.controller.submitAndWait("go", "followUp"))).status).toBe("done");
	const entries = await session.sessionOps.entries(undefined);
	const user = entries.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (user === undefined) throw new Error("the session has no user entry");
	const directory = session.view.current().session.directory;
	const messages = session.view
		.current()
		.conversation.entries.reduce((count, entry) => count + (entry.model?.length ?? 0), 0);
	await session.close();
	session = undefined;
	return { directory, entryId: user.id, messages };
}

/** A durable session directory holding only metadata: it started, and never reached SQLite. */
function seedUnstartedSession(): string {
	const directory = join(storeRoot, "9000000000000-11111111-1111-4111-8111-111111111111");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "session.json"), `${JSON.stringify({ cwd: projectDir })}\n`);
	return directory;
}

describe("--session", () => {
	test("opens the durable session directory it names", async () => {
		const { directory, messages } = await seedAnsweredSession();

		const result = await runRpc(["--session", directory]);

		expect(result.code).toBe(0);
		expect(result.state?.sessionId).toBe(basename(directory));
		expect(result.state?.sessionFile).toBe(join(directory, "session.sqlite"));
		expect(result.state?.messageCount).toBe(messages);
	}, 120_000);

	test("reports a directory that does not exist without a stack trace and leaves no session", async () => {
		const missing = join(storeRoot, "1700000000000-11111111-1111-4111-8111-111111111111");
		const before = pathsBelow(agentDir);

		const result = await spawnCli(["--session", missing, "-p", "hi"], "");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Error: [DURABLE_SESSION_NOT_FOUND] Durable session does not exist: ${missing}`);
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		// Nothing was started instead: the run left the agent directory exactly as it was.
		expect(pathsBelow(agentDir)).toEqual(before);
	}, 120_000);

	test("reports a directory with no session.sqlite as not a durable session", async () => {
		const unstarted = seedUnstartedSession();

		const result = await spawnCli(["--session", unstarted, "-p", "hi"], "");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`Error: [DURABLE_SESSION_NOT_FOUND] Not a durable session directory: ${unstarted}`,
		);
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		expect(pathsBelow(agentDir)).toEqual([]);
	}, 120_000);

	test("reports a session another process holds", async () => {
		const { directory } = await seedAnsweredSession();
		const release = await lockfile.lock(directory, { realpath: false, retries: 0 });
		try {
			const result = await spawnCli(["--session", directory, "-p", "hi"], "");

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				`Error: [DURABLE_SESSION_LOCKED] Durable session is already open: ${directory}`,
			);
			expect(result.stderr).not.toMatch(/\n\s+at /u);
		} finally {
			await release();
		}
	}, 120_000);
});

describe("--session-id", () => {
	test("opens the durable session with that id", async () => {
		const { directory } = await seedAnsweredSession();

		const result = await runRpc(["--session-id", basename(directory)]);

		expect(result.code).toBe(0);
		expect(result.state?.sessionFile).toBe(join(directory, "session.sqlite"));
	}, 120_000);

	test("names an id no store holds, and starts nothing", async () => {
		const result = await spawnCli(["--session-id", "no-such-id", "-p", "hi"], "");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Error: [DURABLE_SESSION_NOT_FOUND] No durable session has the id no-such-id");
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		// No session was started instead of the one it named. The legacy lookup probe may create its own store directory
		// (Decision #32 records the same for `--continue`), but it writes no session and the durable store stays absent.
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
		expect(pathsBelow(agentDir).filter((path) => path.endsWith(".jsonl"))).toEqual([]);
	}, 120_000);
});

describe("--session-dir", () => {
	test("writes the new session below the given root and nothing to the agent directory's store", async () => {
		const result = await runRpc(["--session-dir", storeRoot]);

		expect(result.code).toBe(0);
		const sessionFile = result.state?.sessionFile ?? "";
		// The documented layout holds below the root: a hash of the working directory, then the session directory.
		const [hash, id, database] = relative(storeRoot, sessionFile).split("/");
		expect(hash).toMatch(/^[0-9a-f]{24}$/u);
		expect(id).toMatch(SESSION_DIRECTORY);
		expect(database).toBe("session.sqlite");
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
		expect(readFileSync(join(storeRoot, hash!, id!, "session.json"), "utf8")).toBe(
			`${JSON.stringify({ cwd: projectDir })}\n`,
		);
	}, 120_000);
});

describe("--no-session", () => {
	test("writes no session directory and no database", async () => {
		const result = await runRpc(["--no-session"]);

		expect(result.code).toBe(0);
		// The session it reports is the ephemeral one: not a file below the agent directory.
		expect(result.state?.sessionFile).not.toContain(join(agentDir, "sessions-durable"));
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
		expect(existsSync(join(agentDir, "sessions"))).toBe(false);
		expect(pathsBelow(projectDir)).toEqual([]);
	}, 120_000);

	test("refuses a selector it cannot honour", async () => {
		const result = await spawnCli(["--no-session", "--continue", "-p", "hi"], "");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Error: --no-session cannot be combined with --continue");
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
	}, 120_000);
});

describe("--name", () => {
	test("stores the name beside the database and reports it, and an empty name clears it", async () => {
		const named = await runRpc(["--name", "  named by the command line  "]);
		expect(named.code).toBe(0);
		expect(named.state?.sessionName).toBe("named by the command line");
		const directory = dirname(named.state!.sessionFile);
		expect(await readSessionMetadata(directory)).toEqual({
			cwd: projectDir,
			name: "named by the command line",
		});

		const cleared = await runRpc(["--session", directory, "--name", ""]);

		expect(cleared.code).toBe(0);
		expect(cleared.state?.sessionName).toBeUndefined();
		expect(await readSessionMetadata(directory)).toEqual({ cwd: projectDir });
	}, 120_000);
});

describe("--fork", () => {
	test("forks at the user message it names and talks to the fork", async () => {
		const { directory, entryId, messages } = await seedAnsweredSession();

		const result = await runRpc(["--session", directory, "--fork", entryId]);

		expect(result.code).toBe(0);
		expect(result.state?.sessionFile).toBe(join(directory, "session.sqlite"));
		// The fork stops at that message, so the run it reports is shorter than the session it came from.
		expect(result.state?.messageCount).toBeGreaterThan(0);
		expect(result.state?.messageCount).toBeLessThan(messages);
	}, 120_000);

	test("reports an entry that does not exist", async () => {
		const { directory, messages } = await seedAnsweredSession();
		const before = sessionDirectories(agentDir);

		const result = await runRpc(["--session", directory, "--fork", String(messages + 1)]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Entry not found: ${messages + 1}`);
		// A fork inside a session makes no new session directory, and this one forked nothing.
		expect(sessionDirectories(agentDir)).toEqual(before);
	}, 120_000);

	test("refuses a value it was not given", async () => {
		const result = await spawnCli(["--fork", "-p", "hi"], "");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Error: --fork requires the id of a user message to fork from");
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
	}, 120_000);
});

describe("legacy JSONL sessions stay readable", () => {
	test("--session opens a JSONL file read-only and starts no durable session", async () => {
		const legacy = SessionManager.create(projectDir, undefined, { id: "legacy-file" });
		legacy.appendMessage({ role: "user", content: "from the legacy session", timestamp: Date.now() });
		const file = legacy.getSessionFile();
		if (file === undefined) throw new Error("the legacy session wrote no file");

		const result = await spawnCli(["--session", file, "-p", "hi"], "");

		expect(result.stderr).toContain(
			"Legacy JSONL session opened read-only; changes will not be written to that file.",
		);
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
	}, 120_000);
});
