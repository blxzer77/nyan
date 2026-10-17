import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PackageManagerCliModule from "../src/package-manager-cli.ts";
import type * as RuntimeModule from "../src/runtime.ts";
import type * as BinaryUpdateModule from "../src/utils/binary-update.ts";
import type * as WindowsSelfUpdateModule from "../src/utils/windows-self-update.ts";

// main() removes the leftovers of an interrupted binary update only when it runs as a compiled Bun executable. The flag
// is a load-time snapshot, so the runtime module is replaced with a getter that this state drives. The cleanups are
// replaced too: with the flag on, config.ts would hand them the directory of the Node or Bun that runs the test.
const state = vi.hoisted(() => ({
	bunBinary: false,
	cleanupBinaryUpdateLeftovers: vi.fn(),
	cleanupWindowsSelfUpdateQuarantine: vi.fn(),
	cleanupManagedInstall: vi.fn(),
}));

vi.mock("../src/runtime.ts", async (importOriginal) => ({
	...(await importOriginal<typeof RuntimeModule>()),
	get isBunBinary() {
		return state.bunBinary;
	},
}));

vi.mock("../src/utils/binary-update.ts", async (importOriginal) => ({
	...(await importOriginal<typeof BinaryUpdateModule>()),
	cleanupBinaryUpdateLeftovers: state.cleanupBinaryUpdateLeftovers,
}));

vi.mock("../src/utils/windows-self-update.ts", async (importOriginal) => ({
	...(await importOriginal<typeof WindowsSelfUpdateModule>()),
	cleanupWindowsSelfUpdateQuarantine: state.cleanupWindowsSelfUpdateQuarantine,
}));

vi.mock("../src/package-manager-cli.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PackageManagerCliModule>()),
	cleanupManagedInstall: state.cleanupManagedInstall,
}));

const { main } = await import("../src/main.ts");

class ExitSignal extends Error {
	code: number | string | null | undefined;

	constructor(code: number | string | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

beforeEach(() => {
	state.bunBinary = false;
	state.cleanupBinaryUpdateLeftovers.mockReset();
	state.cleanupWindowsSelfUpdateQuarantine.mockReset();
	state.cleanupManagedInstall.mockReset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new ExitSignal(code);
	});
});

afterEach(() => {
	state.bunBinary = false;
	vi.restoreAllMocks();
});

// `--version` is the shortest path that runs the startup cleanups and then leaves main().
describe("main startup cleanup", () => {
	it("removes the leftovers of an interrupted binary update in a compiled Bun executable", async () => {
		state.bunBinary = true;

		await expect(main(["--version"])).rejects.toBeInstanceOf(ExitSignal);

		expect(state.cleanupBinaryUpdateLeftovers).toHaveBeenCalledTimes(1);
	});

	it("leaves binary update leftovers alone in every other runtime", async () => {
		state.bunBinary = false;

		await expect(main(["--version"])).rejects.toBeInstanceOf(ExitSignal);

		expect(state.cleanupBinaryUpdateLeftovers).not.toHaveBeenCalled();
		// The managed-install cleanup runs in every runtime, so the test did get past the branch under test.
		expect(state.cleanupManagedInstall).toHaveBeenCalledTimes(1);
	});
});
