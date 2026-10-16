import { afterEach, describe, expect, it } from "vitest";
import { isStdoutTakenOver, restoreStdout, takeOverStdout } from "../src/core/output-guard.ts";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

const CONSOLE_METHODS = ["log", "info", "debug", "dir", "table"] as const;

let restoreRuntimeMarker: (() => void) | undefined;

afterEach(() => {
	restoreStdout();
	restoreRuntimeMarker?.();
	restoreRuntimeMarker = undefined;
});

function snapshotConsole(): Record<(typeof CONSOLE_METHODS)[number], unknown> {
	return Object.fromEntries(CONSOLE_METHODS.map((method) => [method, console[method]])) as Record<
		(typeof CONSOLE_METHODS)[number],
		unknown
	>;
}

// Bun's console writes to file descriptor 1 itself, so takeOverStdout() must replace the console methods there and only
// there. The marker is the branch input, so each branch can be checked on either runtime.
describe("takeOverStdout runtime branch", () => {
	it("replaces the stdout console methods when the Bun marker is set and restores them", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("1.4.2");
		const before = snapshotConsole();

		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);
		for (const method of CONSOLE_METHODS) {
			expect(console[method]).not.toBe(before[method]);
		}

		restoreStdout();
		for (const method of CONSOLE_METHODS) {
			expect(console[method]).toBe(before[method]);
		}
	});

	it("leaves the console methods alone when the Bun marker is absent", () => {
		restoreRuntimeMarker = setBunRuntimeMarker(undefined);
		const before = snapshotConsole();

		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);
		for (const method of CONSOLE_METHODS) {
			expect(console[method]).toBe(before[method]);
		}
	});
});
