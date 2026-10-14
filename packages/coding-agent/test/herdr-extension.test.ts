import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHerdrExtension, isHerdrPane, resumeArgv, resumeTarget } from "../src/extensions/herdr/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nyan-herdr-test-"));
	created.push(dir);
	return dir;
}

function tempSessionFile(): string {
	const file = join(tempDir(), "session.jsonl");
	writeFileSync(file, "{}\n");
	return file;
}

function loadHerdrExtension() {
	return loadExtensionFromFactory(
		createHerdrExtension(),
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"builtin:herdr",
	);
}

describe("herdr integration", () => {
	describe("pane detection", () => {
		it("requires HERDR_ENV=1 and both identifiers", () => {
			expect(isHerdrPane({})).toBe(false);
			expect(isHerdrPane({ HERDR_ENV: "1" })).toBe(false);
			expect(isHerdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })).toBe(false);
			expect(isHerdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/usr/bin/herdr" })).toBe(true);
		});

		it("registers nothing outside a Herdr pane", async () => {
			// The test process is not inside Herdr, so the factory must be a no-op rather than
			// scheduling reports in a Nyan that no Herdr pane owns.
			const extension = await loadHerdrExtension();
			expect(extension.handlers.size).toBe(0);
		});
	});

	describe("registration", () => {
		it("ships as a built-in extension", () => {
			expect(builtInExtensions).toContainEqual(expect.objectContaining({ name: "herdr", builtin: true }));
		});

		it("loads through the builtin: path that settings and -e use", async () => {
			const cwd = tempDir();
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: join(cwd, "agent"),
				settingsManager: SettingsManager.inMemory(),
				extensionFactories: builtInExtensions,
				additionalExtensionPaths: ["builtin:herdr"],
			});
			await loader.reload();

			const { extensions, errors } = loader.getExtensions();
			expect(errors).toEqual([]);
			expect(extensions.map((extension) => extension.path)).toContain("builtin:herdr");
		});
	});

	describe("resume target", () => {
		it("needs both an id and a path", () => {
			expect(resumeTarget({})).toBeUndefined();
			expect(resumeTarget({ id: "abc" })).toBeUndefined();
			expect(resumeTarget({ path: tempSessionFile() })).toBeUndefined();
		});

		it("ignores a session whose file is not on disk yet", () => {
			// Nyan returns the path it will write to before the first message creates the file.
			// Reporting that as a resume target makes Herdr run a command that then fails with
			// "No session found matching '<id>'" after a server restart.
			expect(resumeTarget({ id: "abc", path: join(tempDir(), "not-written-yet.jsonl") })).toBeUndefined();
		});

		it("accepts a session once the file exists", () => {
			const file = tempSessionFile();
			expect(resumeTarget({ id: "abc", path: file })).toEqual({ id: "abc", path: file });
		});
	});

	describe("resume command", () => {
		it("resumes the exact session by id", () => {
			expect(resumeArgv({ id: "01a13acc-ff11", path: "unused" })).toEqual(["nyan", "--session", "01a13acc-ff11"]);
		});

		it("refuses an id Herdr would reject", () => {
			// Herdr rejects a resume command whose argument holds an apostrophe or a control character.
			expect(resumeArgv({ id: "bad'id", path: "unused" })).toBeUndefined();
			expect(resumeArgv({ id: "bad\u0007id", path: "unused" })).toBeUndefined();
		});
	});
});
