import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { main } from "../src/main.ts";

/**
 * A durable start that fails is a user-facing condition: `main` prints the reason and returns with an exit code, so a
 * host that embeds `main` keeps running. `process.exit` would end the embedding host too.
 */
describe("a durable start that fails", () => {
	let home: string;
	let agentDir: string;
	let exit: MockInstance;
	let errorSpy: MockInstance;
	let exitCodeBefore: typeof process.exitCode;
	let isTTYBefore: PropertyDescriptor | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-startup-exit-home-"));
		agentDir = join(home, ".nyan", "agent");
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		exitCodeBefore = process.exitCode;
		process.exitCode = 0;
		// JSON and text read piped stdin before they start; a test worker's stdin never ends, so claim a terminal.
		isTTYBefore = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		exit.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = exitCodeBefore;
		if (isTTYBefore) Object.defineProperty(process.stdin, "isTTY", isTTYBefore);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	// The RPC mode returns the failure through its start, and print and JSON set the code their start returned; each
	// mode has to leave with the code a `process.exit(1)` used to give it.
	for (const mode of ["rpc", "json", "text"] as const) {
		test(`${mode} mode sets the exit code and returns instead of ending the process`, async () => {
			await main(["--mode", mode, "--provider", "anthropic"]);

			expect(exit).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
			// The legacy path's wording and its `Error:` prefix, printed once, without a stack trace.
			expect(errorSpy.mock.calls.map((call) => String(call[0]))).toEqual([
				"Error: --provider requires --model (for example: --provider anthropic --model <pattern>)",
			]);
		});
	}
});
