import { afterEach, describe, expect, it, vi } from "vitest";
import { isNodeLikeRuntime, runningUnderBun } from "../src/utils/runtime.ts";

const originalBun = Object.getOwnPropertyDescriptor(process.versions, "bun");

function setBunMarker(version: string | undefined): void {
	Object.defineProperty(process.versions, "bun", {
		value: version,
		configurable: true,
		writable: true,
		enumerable: true,
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalBun) Object.defineProperty(process.versions, "bun", originalBun);
	else delete (process.versions as Record<string, unknown>).bun;
});

describe("ai runtime detection", () => {
	it("reports Node-like under the test runtime", () => {
		expect(isNodeLikeRuntime()).toBe(true);
	});

	it("re-reads the Bun marker on each call", () => {
		setBunMarker("1.4.2");
		expect(runningUnderBun()).toBe(true);
		expect(isNodeLikeRuntime()).toBe(true);

		setBunMarker(undefined);
		expect(runningUnderBun()).toBe(false);
	});

	it("treats an empty Bun marker as not Bun, like the truthiness checks it replaces", () => {
		setBunMarker("");
		expect(runningUnderBun()).toBe(false);
	});

	it("reports neither runtime when process is absent, as in a browser", () => {
		vi.stubGlobal("process", undefined);
		expect(isNodeLikeRuntime()).toBe(false);
		expect(runningUnderBun()).toBe(false);
	});
});
