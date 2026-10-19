import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

interface ProcessIds {
	readonly child: number;
	readonly grandchild: number;
}

const temporaryDirectories: string[] = [];

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Condition did not become true within ${timeoutMs} ms`);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs} ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

function createProcessTreeFixture(directory: string): { command: string; pidFile: string } {
	const scriptPath = join(directory, "process-tree.mjs");
	const pidFile = join(directory, "process-tree.json");
	writeFileSync(
		scriptPath,
		[
			'import { spawn } from "node:child_process";',
			'import { writeFileSync } from "node:fs";',
			"const pidFile = process.argv[2];",
			'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
			"writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
			"setInterval(() => {}, 1000);",
		].join("\n"),
	);
	return {
		command: `${shellArgument(process.execPath)} ${shellArgument(scriptPath)} ${shellArgument(pidFile)}`,
		pidFile,
	};
}

function readProcessIds(path: string): ProcessIds {
	return JSON.parse(readFileSync(path, "utf8")) as ProcessIds;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("Bun/Linux bash subprocess evidence", () => {
	it("aborting a command kills its child and grandchild", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nyan-bash-tree-"));
		temporaryDirectories.push(directory);
		const { command, pidFile } = createProcessTreeFixture(directory);
		const controller = new AbortController();
		const operations = createLocalBashOperations();
		const execution = operations.exec(command, directory, { onData: () => {}, signal: controller.signal });
		let processIds: ProcessIds | undefined;

		try {
			await waitFor(() => existsSync(pidFile));
			processIds = readProcessIds(pidFile);
			controller.abort();
			await expect(settleWithin(execution)).rejects.toThrow("aborted");
			await waitFor(() => !isAlive(processIds!.child) && !isAlive(processIds!.grandchild));
		} finally {
			controller.abort();
			if (processIds) {
				for (const pid of [processIds.child, processIds.grandchild]) {
					if (isAlive(pid)) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// The process may have exited between the liveness check and the kill.
						}
					}
				}
			}
		}
	});

	it("captures complete stdout and stderr in the full-output file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nyan-bash-output-"));
		temporaryDirectories.push(directory);
		const command = `i=1; while [ "$i" -le 3000 ]; do printf 'stdout-%s\\n' "$i"; printf 'stderr-%s\\n' "$i" >&2; i=$((i + 1)); done`;
		const result = await executeBashWithOperations(command, directory, createLocalBashOperations());

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const fullOutput = readFileSync(result.fullOutputPath!, "utf8");
		expect(fullOutput.split("\n").filter(Boolean)).toHaveLength(6_000);
		expect(fullOutput).toContain("stdout-1\n");
		expect(fullOutput).toContain("stderr-1\n");
		expect(fullOutput).toContain("stdout-3000\n");
		expect(fullOutput).toContain("stderr-3000\n");
	});
});
