import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { canRunDurableProductPath, durableOptions } from "../src/main.ts";

/**
 * Resource flags and their disabling variants are handled by the durable ResourceLoader; session-selection and tool
 * compatibility flags remain on the legacy path until their queued N2 work lands.
 */
describe("durable product path routing", () => {
	test.each([
		["--extension", "ext.ts"],
		["--theme", "dark.json"],
		["--prompt-template", "templates"],
	])("%s runs on the durable path", (flag, value) => {
		expect(canRunDurableProductPath(parseArgs([flag, value, "hi"]))).toBe(true);
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
		const selection = { continueSession: false, store: {} };
		const interactive = durableOptions(
			parseArgs(["--use-theme", "dark", "hi"]),
			cwd,
			"interactive",
			settings,
			[],
			selection,
		);
		expect(interactive.settingsOverrides).toEqual({ theme: "dark" });
		const print = durableOptions(parseArgs(["--use-theme", "dark", "hi"]), cwd, "print", settings, [], selection);
		expect(print.settingsOverrides).toBeUndefined();
	});
});
