import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions, loadExtensions } from "../src/core/extensions/loader.ts";
import { piSpecifiersFor, withPiAliases } from "../src/core/extensions/pi-compat.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";
import { readNyanManifest } from "../src/core/nyan-manifest.ts";

describe("piSpecifiersFor", () => {
	it("names each host package under both Pi scopes, keeping the subpath", () => {
		expect(piSpecifiersFor("@ny4n/coding-agent")).toEqual([
			"@earendil-works/pi-coding-agent",
			"@mariozechner/pi-coding-agent",
		]);
		expect(piSpecifiersFor("@ny4n/tui")).toEqual(["@earendil-works/pi-tui", "@mariozechner/pi-tui"]);
		expect(piSpecifiersFor("@ny4n/agent-core")).toEqual([
			"@earendil-works/pi-agent-core",
			"@mariozechner/pi-agent-core",
		]);
		expect(piSpecifiersFor("@ny4n/ai/providers/all")).toEqual([
			"@earendil-works/pi-ai/providers/all",
			"@mariozechner/pi-ai/providers/all",
		]);
	});

	it("gives nothing for specifiers that are not Nyan host packages", () => {
		expect(piSpecifiersFor("typebox")).toEqual([]);
		expect(piSpecifiersFor("@sinclair/typebox/compile")).toEqual([]);
		expect(piSpecifiersFor("@ny4n/chord")).toEqual([]);
		expect(piSpecifiersFor("@earendil-works/pi-ai")).toEqual([]);
	});
});

describe("withPiAliases", () => {
	it("adds the Pi names right after the Nyan name and points them at the same value", () => {
		const ai = {};
		const aiOauth = {};
		const result = withPiAliases({ "@ny4n/ai/oauth": aiOauth, "@ny4n/ai": ai, typebox: {} });

		expect(Object.keys(result)).toEqual([
			"@ny4n/ai/oauth",
			"@earendil-works/pi-ai/oauth",
			"@mariozechner/pi-ai/oauth",
			"@ny4n/ai",
			"@earendil-works/pi-ai",
			"@mariozechner/pi-ai",
			"typebox",
		]);
		expect(result["@earendil-works/pi-ai"]).toBe(ai);
		expect(result["@mariozechner/pi-ai/oauth"]).toBe(aiOauth);
	});

	it("does not change the input", () => {
		const input = { "@ny4n/tui": {} };
		withPiAliases(input);
		expect(Object.keys(input)).toEqual(["@ny4n/tui"]);
	});
});

describe("host modules offered to extensions", () => {
	it("every Nyan host module is also reachable under both Pi names, as the identical module", () => {
		const nyanNames = Object.keys(VIRTUAL_MODULES).filter((name) => piSpecifiersFor(name).length > 0);
		expect(nyanNames).toEqual(
			expect.arrayContaining([
				"@ny4n/coding-agent",
				"@ny4n/tui",
				"@ny4n/agent-core",
				"@ny4n/ai",
				"@ny4n/ai/oauth",
				"@ny4n/ai/providers/all",
			]),
		);
		for (const name of nyanNames) {
			for (const piName of piSpecifiersFor(name)) {
				expect(VIRTUAL_MODULES[piName], `${piName} should be ${name}`).toBe(VIRTUAL_MODULES[name]);
			}
		}
	});
});

describe("readNyanManifest with a Pi package", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nyan-pi-manifest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (manifest: unknown) => {
		const path = join(dir, "package.json");
		writeFileSync(path, JSON.stringify(manifest));
		return path;
	};

	it("reads the resources from a pi field when there is no nyan field", () => {
		const path = write({ name: "pi-thing", pi: { extensions: ["./a.ts"], themes: ["./themes"] } });
		expect(readNyanManifest(path)).toEqual({ extensions: ["./a.ts"], themes: ["./themes"] });
	});

	it("prefers the nyan field when a package has both", () => {
		const path = write({ nyan: { extensions: ["./nyan.ts"] }, pi: { extensions: ["./pi.ts"] } });
		expect(readNyanManifest(path)).toEqual({ extensions: ["./nyan.ts"] });
	});

	it("returns null when neither field is an object", () => {
		expect(readNyanManifest(write({ name: "x" }))).toBeNull();
		expect(readNyanManifest(write({ pi: "extensions" }))).toBeNull();
	});

	it("ignores resource entries that are not lists of strings, as for a nyan field", () => {
		const path = write({ pi: { extensions: [1, 2], skills: ["./skills"] } });
		expect(readNyanManifest(path)).toEqual({ skills: ["./skills"] });
	});
});

describe("loading an extension written for Pi", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nyan-pi-extension-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// Uses a value from three host packages under three Pi names, so a missing alias fails the import.
	const piExtension = `
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import * as ai from "@earendil-works/pi-ai";

export default function (pi: any) {
	const loaded = [typeof getAgentDir, typeof Text, typeof Type.String, typeof ai.getModel].join(",");
	pi.registerCommand("pi-compat-probe", { description: loaded, handler: async () => {} });
}
`;

	it("resolves the Pi host imports of a single extension file", async () => {
		const file = join(root, "pi-extension.ts");
		writeFileSync(file, piExtension);

		const result = await loadExtensions([file], root);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.get("pi-compat-probe")?.description).toBe(
			"function,function,function,function",
		);
	});

	it("loads a package that declares its extension in a pi field", async () => {
		const pkg = join(root, "pi-package");
		mkdirSync(join(pkg, "src"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "pi-package", pi: { extensions: ["./src/entry.ts"] } }),
		);
		writeFileSync(join(pkg, "src", "entry.ts"), piExtension);

		const result = await discoverAndLoadExtensions([pkg], root, join(root, "agent"));

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => [...extension.commands.keys()])).toEqual([["pi-compat-probe"]]);
	});

	it("still fails on a module that no host package provides", async () => {
		const file = join(root, "broken.ts");
		writeFileSync(file, 'import { x } from "@earendil-works/pi-unknown"; export default function () { x(); }');

		const result = await loadExtensions([file], root);

		expect(result.extensions).toEqual([]);
		expect(result.errors[0]?.error).toMatch(/Cannot find module '@earendil-works\/pi-unknown'/);
	});
});
