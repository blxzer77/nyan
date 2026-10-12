import { describe, expect, test } from "vitest";
import { resolveCodemodeWorkerSpecifier } from "../src/config.ts";

describe("resolveCodemodeWorkerSpecifier", () => {
	test("uses the emitted worker beside the bundled Node module", () => {
		expect(resolveCodemodeWorkerSpecifier("bundled-node", "file:///app/chunks/config.js")).toEqual(
			new URL("file:///app/chunks/codemode-worker.js"),
		);
	});

	test("uses the nyan-codemode worker when unbundled", () => {
		expect(resolveCodemodeWorkerSpecifier("unbundled", import.meta.url)).toBeUndefined();
	});
});
