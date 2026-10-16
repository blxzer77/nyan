import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The compiled-binary and bundled-Node flags are load-time snapshots that no test can change in place, so the runtime
// module is replaced and its getters read this state. Spawning is replaced too: these tests check which command line
// the launcher chooses, and the tests that start a real process live in experimental-internal-process.test.ts.
const state = vi.hoisted(() => ({
	bunBinary: false,
	bundledNode: false,
	packageDir: "",
	spawned: [] as { command: string; args: readonly string[] }[],
}));

vi.mock("../src/runtime.ts", () => ({
	get isBunBinary() {
		return state.bunBinary;
	},
	get isBundledNode() {
		return state.bundledNode;
	},
	runningUnderBun: () => false,
}));

vi.mock("../src/config.ts", () => ({
	getPackageDir: () => state.packageDir,
}));

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: readonly string[]) => {
		state.spawned.push({ command, args });
		return { unref() {} };
	},
}));

const { isDirectInternalProcessEntry, spawnInternalProcess } = await import("../src/experimental/process.ts");

const originalArgv1 = process.argv[1];
const entryPath = resolve("virtual", "internal-entry.ts");
const entryUrl = pathToFileURL(entryPath).href;
const packageDir = resolve("virtual", "package");

beforeEach(() => {
	state.bunBinary = false;
	state.bundledNode = false;
	state.packageDir = packageDir;
	state.spawned.length = 0;
	process.argv[1] = entryPath;
});

afterEach(() => {
	process.argv[1] = originalArgv1;
});

function lastSpawn() {
	const spawned = state.spawned.at(-1);
	if (!spawned) throw new Error("spawn was not called");
	return spawned;
}

describe("isDirectInternalProcessEntry", () => {
	it("is true for the script the runtime was started with", () => {
		expect(isDirectInternalProcessEntry(entryUrl)).toBe(true);
	});

	it("is false in a compiled Bun executable, which has no entry script on disk", () => {
		state.bunBinary = true;
		expect(isDirectInternalProcessEntry(entryUrl)).toBe(false);
	});

	it("is false in the bundled Node distribution, where the module is a chunk of the bundle", () => {
		state.bundledNode = true;
		expect(isDirectInternalProcessEntry(entryUrl)).toBe(false);
	});
});

describe("spawnInternalProcess", () => {
	it("starts the source module next to the launcher when running unbundled", () => {
		spawnInternalProcess("server", ["arg"]);

		const { command, args } = lastSpawn();
		expect(command).toBe(process.execPath);
		expect(args.slice(-2)).toEqual([fileURLToPath(new URL("../src/experimental/server.ts", import.meta.url)), "arg"]);
	});

	it("starts the bundle entry in the bundled Node distribution", () => {
		state.bundledNode = true;

		spawnInternalProcess("server", ["arg"]);
		expect(lastSpawn().args.slice(-2)).toEqual([join(packageDir, "dist", "bundle", "cli.js"), "arg"]);

		spawnInternalProcess("coordinator", ["arg"]);
		expect(lastSpawn().args.slice(-2)).toEqual([join(packageDir, "dist", "bundle", "coordinator.js"), "arg"]);
	});

	it("re-runs the compiled executable with only the role arguments", () => {
		state.bunBinary = true;

		spawnInternalProcess("server", ["arg-1", "arg-2"]);

		expect(lastSpawn()).toEqual({ command: process.execPath, args: ["arg-1", "arg-2"] });
	});

	it("refuses an external entry point from a compiled executable and starts nothing", () => {
		state.bunBinary = true;

		expect(() => spawnInternalProcess("server", [], { entryUrl: new URL(entryUrl) })).toThrow(
			"A compiled Bun executable cannot launch an external internal-process entrypoint",
		);
		expect(state.spawned).toEqual([]);
	});
});
