import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

const readFileSync = vi.fn();

vi.mock("node:fs", () => ({
	readFileSync,
}));

const { restoreSandboxEnv } = await import("../src/bun/restore-sandbox-env.ts");

/** Empty process.env, as Bun does inside a sandbox, and return a function that puts the previous entries back. */
function emptyProcessEnv(): () => void {
	const backup = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	return () => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, backup);
	};
}

describe("restoreSandboxEnv", () => {
	beforeEach(() => {
		readFileSync.mockReset();
	});

	it("does nothing when not running under bun", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { node: "20.0.0" },
		});
		const envBefore = { ...process.env };

		restoreSandboxEnv();

		expect(process.env).toEqual(envBefore);

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	it("does nothing when process.env already has entries", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { bun: "1.2.0", node: "20.0.0" },
		});
		process.env.RESTORE_SANDBOX_ENV_TEST = "1";
		const envBefore = { ...process.env };

		restoreSandboxEnv();

		expect(process.env).toEqual(envBefore);
		delete process.env.RESTORE_SANDBOX_ENV_TEST;

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
	});

	it("restores environment from /proc/self/environ when bun env is empty", () => {
		const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
		Object.defineProperty(process, "versions", {
			value: { bun: "1.2.0", node: "20.0.0" },
		});

		// Clear env to simulate the bun sandbox bug.
		const envBackup = { ...process.env };
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}

		readFileSync.mockReturnValue("FOO=bar\0BAZ=qux\0");

		restoreSandboxEnv();

		expect(readFileSync).toHaveBeenCalledWith("/proc/self/environ", "utf-8");
		expect(process.env.FOO).toBe("bar");
		expect(process.env.BAZ).toBe("qux");

		// Restore.
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}
		Object.assign(process.env, envBackup);

		if (originalVersions) {
			Object.defineProperty(process, "versions", originalVersions);
		}
		readFileSync.mockReset();
	});

	// The Bun guard is all that keeps a Node process with an empty environment from reading /proc/self/environ: the
	// first case above has entries in process.env, so the second guard would return before it matters.
	it("does not read /proc/self/environ outside Bun even when process.env is empty", () => {
		const restoreMarker = setBunRuntimeMarker(undefined);
		const restoreEnv = emptyProcessEnv();
		try {
			readFileSync.mockReturnValue("FOO=bar\0");

			restoreSandboxEnv();

			expect(readFileSync).not.toHaveBeenCalled();
			expect(Object.keys(process.env)).toEqual([]);
		} finally {
			restoreEnv();
			restoreMarker();
		}
	});

	// The inline check this replaced tested truthiness. runningUnderBun() tests typeof, and the fallback in
	// packages/ai/src/utils/provider-env.ts still tests truthiness. Bun never reports an empty marker, so only an injected
	// one shows the difference; pinned so that changing either side is a deliberate decision.
	it("takes an empty Bun marker as Bun", () => {
		const restoreMarker = setBunRuntimeMarker("");
		const restoreEnv = emptyProcessEnv();
		try {
			readFileSync.mockReturnValue("FOO=bar\0");

			restoreSandboxEnv();

			expect(readFileSync).toHaveBeenCalledWith("/proc/self/environ", "utf-8");
			expect(process.env.FOO).toBe("bar");
		} finally {
			restoreEnv();
			restoreMarker();
		}
	});
});
