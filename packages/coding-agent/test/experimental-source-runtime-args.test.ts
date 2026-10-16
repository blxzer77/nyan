import { afterEach, describe, expect, it } from "vitest";
import { sourceRuntimeArgs } from "../src/experimental/source-runtime-args.ts";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

let restoreRuntimeMarker: (() => void) | undefined;

afterEach(() => {
	restoreRuntimeMarker?.();
	restoreRuntimeMarker = undefined;
});

// The marker is the branch input, so each branch is checked on either runtime. The other tests that call
// sourceRuntimeArgs() spawn a child with the real runtime and cover the arguments end to end.
describe("sourceRuntimeArgs", () => {
	it("needs no runtime arguments when the Bun marker is set", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("1.4.2");
		expect(sourceRuntimeArgs()).toEqual([]);
	});

	it("preloads the source resolver by file URL when the Bun marker is absent", () => {
		restoreRuntimeMarker = setBunRuntimeMarker(undefined);
		expect(sourceRuntimeArgs()).toEqual([
			"--import",
			new URL("../src/experimental/source-resolver.ts", import.meta.url).href,
		]);
	});
});
