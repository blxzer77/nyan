import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { canRunDurableProductPath, durableOptions } from "../src/main.ts";

/**
 * Which flags the durable path takes. A flag whose feature the durable path does not connect yet stays on the legacy
 * path, so it is never silently ignored; a flag that only disables something the durable path does not load stays here.
 */
describe("durable product path routing", () => {
	test.each([
		["--extension", "ext.ts"],
		["--theme", "dark.json"],
		["--prompt-template", "templates"],
	])("%s stays on the legacy path until task C", (flag, value) => {
		expect(canRunDurableProductPath(parseArgs([flag, value, "hi"]))).toBe(false);
	});

	test.each([
		["--no-mcp"],
		["--no-extensions"],
		["--no-themes"],
		["--no-prompt-templates"],
		["--skill", "skills"],
		["--system-prompt", "custom"],
		["--append-system-prompt", "appended"],
	])("%s runs on the durable path", (...args) => {
		expect(canRunDurableProductPath(parseArgs([...args, "hi"]))).toBe(true);
	});

	test("--use-theme reaches the durable settings only in the interactive mode", () => {
		const settings = SettingsManager.inMemory();
		const cwd = tmpdir();
		const interactive = durableOptions(parseArgs(["--use-theme", "dark", "hi"]), cwd, "interactive", settings, []);
		expect(interactive.settingsOverrides).toEqual({ theme: "dark" });
		const print = durableOptions(parseArgs(["--use-theme", "dark", "hi"]), cwd, "print", settings, []);
		expect(print.settingsOverrides).toBeUndefined();
	});
});
