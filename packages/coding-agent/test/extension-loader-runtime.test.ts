import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "../src/runtime.ts";

// loader.ts reads the compiled-binary and bundled-Node flags once, when it loads, so each case loads a fresh copy with
// the flags this state holds. config.ts is loaded first with both flags off: with the compiled-binary flag on, it
// would look for package.json next to the Node or Bun executable that runs the test.
const state = vi.hoisted(() => ({
	bunBinary: false,
	bundledNode: false,
	createEmbeddedJiti: vi.fn(),
	createUnbundledJiti: vi.fn(),
}));

vi.mock("../src/runtime.ts", async (importOriginal) => ({
	...(await importOriginal<typeof RuntimeModule>()),
	get isBunBinary() {
		return state.bunBinary;
	},
	get isBundledNode() {
		return state.bundledNode;
	},
}));

vi.mock("jiti/static", () => ({ createJiti: state.createEmbeddedJiti }));
vi.mock("jiti", () => ({ createJiti: state.createUnbundledJiti }));
vi.mock("../src/core/extensions/virtual-modules.ts", () => ({ VIRTUAL_MODULES: { typebox: {} } }));

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	tsconfigPaths?: boolean;
	virtualModules?: Record<string, unknown>;
}

async function loadExtensionWith(flags: { bunBinary: boolean; bundledNode: boolean }) {
	vi.resetModules();
	state.bunBinary = false;
	state.bundledNode = false;
	await import("../src/config.ts");
	state.bunBinary = flags.bunBinary;
	state.bundledNode = flags.bundledNode;
	const { loadExtensions } = await import("../src/core/extensions/loader.ts");
	state.bunBinary = false;
	state.bundledNode = false;

	const result = await loadExtensions(["/extension.ts"], "/");
	expect(result.errors).toEqual([]);
	expect(result.extensions).toHaveLength(1);
}

function optionsOf(create: typeof state.createEmbeddedJiti): JitiOptionsProbe {
	expect(create).toHaveBeenCalledOnce();
	return create.mock.calls[0][1] as JitiOptionsProbe;
}

beforeEach(() => {
	for (const create of [state.createEmbeddedJiti, state.createUnbundledJiti]) {
		create.mockReset();
		create.mockImplementation(() => ({ import: vi.fn(async () => () => {}) }));
	}
});

// The test file is TypeScript source, so without a binary or bundle flag the loader takes its source branch.
describe("extension loader runtime branches", () => {
	it("uses the embedded jiti and virtual modules in a compiled Bun executable", async () => {
		await loadExtensionWith({ bunBinary: true, bundledNode: false });

		expect(state.createUnbundledJiti).not.toHaveBeenCalled();
		const options = optionsOf(state.createEmbeddedJiti);
		expect(options.tryNative).toBe(false);
		expect(options.tsconfigPaths).toBeUndefined();
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
	});

	it("uses the embedded jiti and virtual modules in the bundled Node distribution", async () => {
		await loadExtensionWith({ bunBinary: false, bundledNode: true });

		expect(state.createUnbundledJiti).not.toHaveBeenCalled();
		const options = optionsOf(state.createEmbeddedJiti);
		expect(options.tryNative).toBe(false);
		expect(options.tsconfigPaths).toBeUndefined();
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
	});

	it("uses the unbundled jiti with the workspace tsconfig paths when running TypeScript sources", async () => {
		await loadExtensionWith({ bunBinary: false, bundledNode: false });

		expect(state.createEmbeddedJiti).not.toHaveBeenCalled();
		const options = optionsOf(state.createUnbundledJiti);
		expect(options.tsconfigPaths).toBe(true);
		expect(options.tryNative).toBe(false);
		expect(options.virtualModules?.typebox).toBeDefined();
	});
});
