import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { hasDurableSession, selectSession } from "../src/core/durable/sessions.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { sourceRuntimeArgs } from "../src/experimental/source-runtime-args.ts";
import { resolveContinueRoute } from "../src/main.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const temporaryRoots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A physical temp root: the session stores compare real paths, and tmpdir() is a symlink on macOS. */
function createTempRoot(): { root: string; agentDir: string; cwd: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "nyan-continue-route-")));
	temporaryRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd };
}

/** Write one legacy JSONL session the way the compatibility route writes it, and return its path. */
function seedLegacySession(cwd: string, sessionDir?: string, id?: string): string {
	const session = SessionManager.create(cwd, sessionDir, id === undefined ? undefined : { id });
	session.appendMessage({ role: "user", content: "from the legacy session", timestamp: Date.now() });
	const path = session.getSessionFile();
	if (path === undefined) throw new Error("the legacy session wrote no file");
	return path;
}

/** Create a durable session directory with its database, as a previous durable run leaves it. */
async function seedDurableSession(cwd: string): Promise<string> {
	const location = await selectSession(cwd, false);
	try {
		writeFileSync(location.database, "placeholder");
	} finally {
		await location.release();
	}
	return location.directory;
}

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCli(agentDir: string, cwd: string, args: readonly string[]): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [...sourceRuntimeArgs(), cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				HOME: join(agentDir, ".."),
				USERPROFILE: join(agentDir, ".."),
				[ENV_AGENT_DIR]: agentDir,
				NYAN_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
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
	});
}

function durableSessionDirectories(agentDir: string): string[] {
	const store = join(agentDir, "sessions-durable");
	if (!existsSync(store)) return [];
	// A session directory is `<timestamp>-<uuid>`; proper-lockfile keeps a sibling `<...>.lock` directory beside it.
	return readdirSync(store).flatMap((project) =>
		readdirSync(join(store, project), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => join(store, project, entry.name)),
	);
}

/** Poll `predicate` until it holds, so a test waits for the child instead of a fixed delay. */
async function waitFor(
	predicate: () => boolean,
	child: { exitCode: number | null },
	detail: () => string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (child.exitCode !== null) throw new Error(`the holder exited early: ${detail()}`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(`the holder did not open the session: ${detail()}`);
}

describe("--continue routing (Decision #32)", () => {
	it("continues the durable session the directory already has", async () => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const directory = await seedDurableSession(cwd);

		expect(await resolveContinueRoute(parseArgs(["--continue"]), cwd, undefined)).toBe("durable");
		const continued = await selectSession(cwd, true);
		try {
			expect(continued.directory).toBe(directory);
			expect(continued.created).toBe(false);
		} finally {
			await continued.release();
		}
	});

	it("reopens the legacy JSONL session read-only when there is no durable session", async () => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const legacyPath = seedLegacySession(cwd);

		expect(await resolveContinueRoute(parseArgs(["--continue"]), cwd, undefined)).toBe("legacy");
		// What the compatibility route opens for that decision: the same file, read-only, with its transcript loaded.
		const opened = SessionManager.continueRecent(cwd, undefined, { readOnly: true });
		expect(opened.getSessionFile()).toBe(legacyPath);
		expect(opened.isReadOnly()).toBe(true);
		expect(opened.getEntries().map((entry) => entry.type)).toContain("message");
		expect(await hasDurableSession(cwd)).toBe(false);
	});

	it("starts a new durable session when the directory has neither, and creates nothing to find out", async () => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);

		expect(await resolveContinueRoute(parseArgs(["--continue"]), cwd, undefined)).toBe("new");
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);

		const started = await selectSession(cwd, false);
		try {
			expect(started.created).toBe(true);
			expect(started.database).toBe(join(started.directory, "session.sqlite"));
		} finally {
			await started.release();
		}
	});

	it("prefers the durable session when the directory has both stores", async () => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		seedLegacySession(cwd);
		await seedDurableSession(cwd);

		expect(await resolveContinueRoute(parseArgs(["--continue"]), cwd, undefined)).toBe("durable");
	});

	it("scopes a custom session directory to the current directory, as the legacy route does", async () => {
		const { root, agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const sessionDir = join(root, "shared-sessions");
		mkdirSync(sessionDir, { recursive: true });
		const elsewhere = join(root, "other-project");
		mkdirSync(elsewhere, { recursive: true });
		seedLegacySession(elsewhere, sessionDir);

		expect(await resolveContinueRoute(parseArgs(["--continue"]), cwd, sessionDir)).toBe("new");
		expect(await resolveContinueRoute(parseArgs(["--continue"]), elsewhere, sessionDir)).toBe("legacy");
	});

	it("starts a new session without the flag, whatever the directory holds", async () => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		await seedDurableSession(cwd);

		expect(await resolveContinueRoute(parseArgs(["hi"]), cwd, undefined)).toBe("new");
	});
});

describe("--continue in the CLI", () => {
	it("starts a durable session in a directory without one, without a stack trace", async () => {
		const { agentDir, cwd } = createTempRoot();

		const result = await runCli(agentDir, cwd, ["--continue", "-p", "hi"]);

		// The run needs a provider this temporary home does not have, so it stops there; what matters is that it got
		// past session selection and reported a plain message.
		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No durable session exists");
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		expect(durableSessionDirectories(agentDir)).toHaveLength(1);
	});

	it.each([
		["print", ["--continue", "-p", "hi"]],
		["json", ["--mode", "json", "--continue", "-p", "hi"]],
		["rpc", ["--mode", "rpc", "--continue"]],
	])("%s mode reopens the legacy session read-only and starts no durable session", async (_mode, args) => {
		const { agentDir, cwd } = createTempRoot();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		seedLegacySession(cwd);
		vi.unstubAllEnvs();

		const result = await runCli(agentDir, cwd, args);

		expect(result.stderr).toContain(
			"Legacy JSONL session opened read-only; changes will not be written to that file.",
		);
		expect(result.stderr).not.toMatch(/\n\s+at /u);
		expect(durableSessionDirectories(agentDir)).toHaveLength(0);
	});

	it.each([
		[
			"--model",
			["--model", "nope-xyz", "-p", "hi"],
			'Error: Model "nope-xyz" not found. Use --list-models to see available models.',
		],
		["--api-key", ["--api-key", "sk-test", "-p", "hi"], "Error: --api-key requires a selected model"],
	])("%s startup failures are reported without a stack trace", async (_flag, args, message) => {
		const { agentDir, cwd } = createTempRoot();

		const result = await runCli(agentDir, cwd, args);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
		expect(result.stderr).not.toMatch(/\n\s+at /u);
	});

	it("reports a durable session that another process holds without a stack trace", async () => {
		const { agentDir, cwd } = createTempRoot();
		const holder = spawn(process.execPath, [...sourceRuntimeArgs(), cliPath, "--mode", "rpc", "--continue"], {
			cwd,
			env: {
				...process.env,
				HOME: join(agentDir, ".."),
				USERPROFILE: join(agentDir, ".."),
				[ENV_AGENT_DIR]: agentDir,
				NYAN_OFFLINE: "1",
			},
			// An open stdin keeps the RPC session alive, so the session stays locked.
			stdio: ["pipe", "ignore", "pipe"],
		});
		let holderStderr = "";
		holder.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			holderStderr += chunk;
		});
		try {
			// The database appears only once the holder has opened the session and taken the lock.
			await waitFor(
				() => {
					const [directory] = durableSessionDirectories(agentDir);
					return directory !== undefined && existsSync(join(directory, "session.sqlite"));
				},
				holder,
				() => `exit ${holder.exitCode}, stderr ${JSON.stringify(holderStderr.slice(-400))}`,
			);

			const result = await runCli(agentDir, cwd, ["--continue", "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Error: [DURABLE_SESSION_LOCKED] Session is already open in another process");
			expect(result.stderr).not.toMatch(/\n\s+at /u);
		} finally {
			holder.kill();
		}
	}, 60_000);
});
