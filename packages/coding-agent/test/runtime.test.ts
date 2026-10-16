import { afterEach, describe, expect, test } from "vitest";
import {
	isBunBinary as configIsBunBinary,
	isBundledNode as configIsBundledNode,
	isBunRuntime as configIsBunRuntime,
} from "../src/config.ts";
import {
	getRuntimeKind,
	getRuntimeLabel,
	isBunBinary,
	isBundledNode,
	isBunRuntime,
	resolveRuntimeKind,
	runningUnderBun,
} from "../src/runtime.ts";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

const initialRuntimeKind = isBunBinary ? "bun-binary" : isBundledNode ? "bundled-node" : isBunRuntime ? "bun" : "node";
let restoreRuntimeMarker: (() => void) | undefined;

afterEach(() => {
	restoreRuntimeMarker?.();
	restoreRuntimeMarker = undefined;
});

describe("runtime identity", () => {
	test("keeps the module-load identity stable and preserves config exports", () => {
		// Bun defines a global `Bun`; the snapshot must agree with that independent signal.
		expect(isBunRuntime).toBe("Bun" in globalThis);
		expect(getRuntimeKind()).toBe(initialRuntimeKind);
		expect(configIsBunBinary).toBe(isBunBinary);
		expect(configIsBundledNode).toBe(isBundledNode);
		expect(configIsBunRuntime).toBe(isBunRuntime);
	});

	test("uses the documented precedence when flags overlap", () => {
		expect(resolveRuntimeKind({ bunBinary: true, bundledNode: true, bunRuntime: true })).toBe("bun-binary");
		expect(resolveRuntimeKind({ bunBinary: false, bundledNode: true, bunRuntime: true })).toBe("bundled-node");
		expect(resolveRuntimeKind({ bunBinary: false, bundledNode: false, bunRuntime: true })).toBe("bun");
		expect(resolveRuntimeKind({ bunBinary: false, bundledNode: false, bunRuntime: false })).toBe("node");
	});

	test("re-reads the Bun marker for branch tests", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("1.4.2");
		expect(getRuntimeLabel()).toBe("bun/1.4.2");
		expect(runningUnderBun()).toBe(true);
		// The marker is re-read, the binary and bundle flags are load-time snapshots; this holds in every build.
		expect(getRuntimeKind()).toBe(
			resolveRuntimeKind({ bunBinary: isBunBinary, bundledNode: isBundledNode, bunRuntime: true }),
		);

		restoreRuntimeMarker();
		restoreRuntimeMarker = undefined;
		expect(runningUnderBun()).toBe(initialRuntimeKind === "bun-binary" || initialRuntimeKind === "bun");
		expect(getRuntimeLabel()).toBe(
			initialRuntimeKind === "bun-binary" || initialRuntimeKind === "bun"
				? `bun/${process.versions.bun}`
				: `node/${process.version}`,
		);
		expect(getRuntimeKind()).toBe(initialRuntimeKind);
	});

	test("hides the Bun marker when it is absent", () => {
		restoreRuntimeMarker = setBunRuntimeMarker(undefined);
		expect(runningUnderBun()).toBe(false);
		expect(getRuntimeLabel()).toBe(`node/${process.version}`);
		expect(getRuntimeKind()).toBe(
			resolveRuntimeKind({ bunBinary: isBunBinary, bundledNode: isBundledNode, bunRuntime: false }),
		);
	});

	// Inherited from the inline checks this module replaced: the label tests truthiness, runningUnderBun() tests typeof.
	// Pinned so a later change to either one is a deliberate decision. Bun does not report an empty marker.
	test("keeps the label and the Bun predicate apart for an empty marker", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("");
		expect(getRuntimeLabel()).toBe(`node/${process.version}`);
		expect(runningUnderBun()).toBe(true);
	});
});
