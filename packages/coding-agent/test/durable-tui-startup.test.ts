import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, VERSION } from "../src/config.ts";
import { recordCrash } from "../src/core/crash-log.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	type DurableStartupChecks,
	type DurableStartupResources,
	type DurableStartupUi,
	newChangelog,
	packageUpdateCard,
	projectTrustWarning,
	type ResourceSection,
	resourceListing,
	runDurableStartup,
	terminalTitleFor,
	tmuxKeyboardWarning,
	versionUpdateCard,
} from "../src/modes/durable/startup.ts";

/**
 * The notices a durable TUI start shows, driven without a terminal: the checks that reach outside the process are
 * provided, and everything else is real — the settings manager, the crash log, the changelog file, the project trust
 * store. Assertions are on what the screens says, so a wrong label or a notice that should not appear fails.
 */

interface Recorded {
	readonly warnings: string[];
	readonly cards: Array<{ title: string; lines: readonly string[] }>;
	readonly changelogs: Array<{ markdown: string; latestVersion: string; collapsed: boolean }>;
	readonly listings: ResourceSection[][];
	readonly titles: string[];
}

function recorder(): { ui: DurableStartupUi; recorded: Recorded } {
	const recorded: Recorded = { warnings: [], cards: [], changelogs: [], listings: [], titles: [] };
	return {
		recorded,
		ui: {
			warn: (message) => recorded.warnings.push(message),
			card: (title, lines) => recorded.cards.push({ title, lines }),
			changelog: (markdown, latestVersion, collapsed) =>
				recorded.changelogs.push({ markdown, latestVersion, collapsed }),
			resources: (sections) => recorded.listings.push([...sections]),
			title: (text) => recorded.titles.push(text),
		},
	};
}

const quietChecks: DurableStartupChecks = {
	version: async () => undefined,
	packages: async () => [],
	crash: () => undefined,
	tmuxOption: async () => undefined,
};

describe("durable TUI startup notices", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "nyan-durable-startup-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		// Tests that want a tmux answer set this; every other case runs as if nyan were not inside tmux.
		vi.stubEnv("TMUX", "");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const settingsFor = (trusted = false): SettingsManager =>
		SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });

	test("the terminal title names the session and the directory", () => {
		expect(terminalTitleFor("/home/user/project", undefined)).toBe("Nyan - project");
		expect(terminalTitleFor("/home/user/project", "")).toBe("Nyan - project");
		expect(terminalTitleFor("/home/user/project", "release line")).toBe("Nyan - release line - project");
	});

	test("the tmux warning names the setting that is wrong", () => {
		expect(tmuxKeyboardWarning(undefined, undefined)).toBeUndefined();
		expect(tmuxKeyboardWarning("on", "csi-u")).toBeUndefined();
		expect(tmuxKeyboardWarning("always", "csi-u")).toBeUndefined();
		expect(tmuxKeyboardWarning("off", "csi-u")).toBe(
			"tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.",
		);
		expect(tmuxKeyboardWarning("on", "xterm")).toBe(
			"tmux extended-keys-format is xterm. nyan works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.",
		);
	});

	test("a quiet start says nothing but its title", async () => {
		const { ui, recorded } = recorder();

		await runDurableStartup({ cwd, resumed: false, settings: settingsFor(), ui, checks: quietChecks });

		expect(recorded.titles).toEqual([terminalTitleFor(cwd, undefined)]);
		expect(recorded.warnings).toEqual([]);
		expect(recorded.cards).toEqual([]);
		expect(recorded.changelogs).toEqual([]);
		expect(recorded.listings).toEqual([]);
	});

	test("a new version is reported with the command that updates and where the changelog is", async () => {
		const { ui, recorded } = recorder();

		await runDurableStartup({
			cwd,
			resumed: false,
			settings: settingsFor(),
			ui,
			checks: { ...quietChecks, version: async () => ({ version: "9.9.9", note: "Fixes the thing." }) },
		});

		expect(recorded.cards).toEqual([
			{
				title: "Update Available",
				lines: [
					"New version 9.9.9 is available. Run `nyan update`.",
					"",
					"Fixes the thing.",
					"",
					"Changelog: https://github.com/blxzer77/nyan/blob/main/packages/coding-agent/CHANGELOG.md",
				],
			},
		]);
	});

	test("package updates are listed by name, and none means no notice", async () => {
		const updated = recorder();
		await runDurableStartup({
			cwd,
			resumed: false,
			settings: settingsFor(),
			ui: updated.ui,
			checks: { ...quietChecks, packages: async () => ["@scope/one", "two"] },
		});
		expect(updated.recorded.cards).toEqual([packageUpdateCard(["@scope/one", "two"])]);
		expect(updated.recorded.cards[0]?.lines).toEqual([
			"Package updates are available. Run `nyan update --extensions`.",
			"Packages:",
			"- @scope/one",
			"- two",
		]);

		const clean = recorder();
		await runDurableStartup({ cwd, resumed: false, settings: settingsFor(), ui: clean.ui, checks: quietChecks });
		expect(clean.recorded.cards).toEqual([]);
	});

	test("a tmux that cannot handle modified keys warns once", async () => {
		vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
		const { ui, recorded } = recorder();

		await runDurableStartup({
			cwd,
			resumed: false,
			settings: settingsFor(),
			ui,
			checks: {
				...quietChecks,
				tmuxOption: async (option) => (option === "extended-keys" ? "off" : "csi-u"),
			},
		});

		expect(recorded.warnings).toEqual([
			"tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.",
		]);
	});

	test("an untrusted project with project resources warns and names /trust", async () => {
		await mkdir(join(cwd, ".nyan"), { recursive: true });
		await writeFile(join(cwd, ".nyan", "settings.json"), "{}\n");

		expect(projectTrustWarning(cwd, false)).toBe(
			"This project is not trusted. Project .nyan resources and packages are ignored. Use /trust to save a trust decision, then restart nyan.",
		);
		const { ui, recorded } = recorder();
		await runDurableStartup({ cwd, resumed: false, settings: settingsFor(), ui, checks: quietChecks });
		expect(recorded.warnings).toEqual([projectTrustWarning(cwd, false)]);

		// A trusted project, and a project without trust-requiring resources, say nothing.
		expect(projectTrustWarning(cwd, true)).toBeUndefined();
		expect(projectTrustWarning(join(root, "empty"), false)).toBeUndefined();
	});

	test("a recorded crash points at /bug once", async () => {
		recordCrash({ kind: "uncaught_exception", error: new Error("kaboom"), cwd });
		// No crash check: the default one reads the crash log this test just wrote.
		const { crash: _crash, ...withoutCrash } = quietChecks;

		const first = recorder();
		await runDurableStartup({ cwd, resumed: false, settings: settingsFor(), ui: first.ui, checks: withoutCrash });
		expect(first.recorded.warnings).toHaveLength(1);
		expect(first.recorded.warnings[0]).toContain("nyan crashed on ");
		expect(first.recorded.warnings[0]).toContain("(kaboom)");
		expect(first.recorded.warnings[0]).toContain("Run /bug to report it");

		// Taking the crash marks it, so the next start does not warn about it again.
		const second = recorder();
		await runDurableStartup({ cwd, resumed: false, settings: settingsFor(), ui: second.ui, checks: withoutCrash });
		expect(second.recorded.warnings).toEqual([]);
	});

	describe("the changelog popup", () => {
		let changelogPath: string;

		beforeEach(async () => {
			changelogPath = join(root, "CHANGELOG.md");
			await writeFile(
				changelogPath,
				[
					"# Changelog",
					"",
					"## [1.1.0] - 2026-01-02",
					"",
					"### Added",
					"",
					"- A new thing.",
					"",
					"## [1.0.0] - 2026-01-01",
					"",
					"- The first release.",
					"",
				].join("\n"),
			);
		});

		test("a fresh install records the version and shows nothing", async () => {
			const settings = settingsFor();

			expect(newChangelog(settings, false, changelogPath)).toBeUndefined();
			expect(settings.getLastChangelogVersion()).toBe(VERSION);
		});

		test("the sections newer than the recorded version are shown, and the version is recorded", async () => {
			const settings = settingsFor();
			settings.setLastChangelogVersion("1.0.0");

			const notice = newChangelog(settings, false, changelogPath);

			expect(notice?.latestVersion).toBe("1.1.0");
			expect(notice?.markdown).toContain("## [1.1.0] - 2026-01-02");
			expect(notice?.markdown).toContain("- A new thing.");
			expect(notice?.markdown).not.toContain("The first release.");
			expect(settings.getLastChangelogVersion()).toBe(VERSION);
		});

		test("a resumed session gets no popup and keeps the version it recorded", async () => {
			const settings = settingsFor();
			settings.setLastChangelogVersion("1.0.0");

			expect(newChangelog(settings, true, changelogPath)).toBeUndefined();
			expect(settings.getLastChangelogVersion()).toBe("1.0.0");
		});

		test("a start hands the sections and the collapse setting to the screen", async () => {
			const settings = settingsFor();
			settings.setLastChangelogVersion("1.0.0");
			settings.setCollapseChangelog(true);
			const { ui, recorded } = recorder();

			await runDurableStartup({
				cwd,
				resumed: false,
				settings,
				ui,
				changelogPath,
				checks: quietChecks,
			});

			expect(recorded.changelogs).toHaveLength(1);
			expect(recorded.changelogs[0]?.latestVersion).toBe("1.1.0");
			expect(recorded.changelogs[0]?.collapsed).toBe(true);
		});
	});

	describe("the loaded-resources listing", () => {
		const resources: DurableStartupResources = {
			contextFiles: [join("/home/user", "project", "AGENTS.md")],
			skills: ["beta", "alpha"],
			prompts: ["/review"],
			extensions: [join("/home/user", ".nyan", "agent", "extensions", "one", "index.ts")],
			diagnostics: [{ level: "warning", message: "Skill alpha is shadowed" }],
		};

		test("lists each kind that loaded something, in legacy's order", () => {
			expect(resourceListing(resources, "/home/user")).toEqual([
				{ name: "Context", items: [`~${sep}project${sep}AGENTS.md`] },
				{ name: "Skills", items: ["alpha", "beta"] },
				{ name: "Prompts", items: ["/review"] },
				{ name: "Extensions", items: [`~${sep}.nyan${sep}agent${sep}extensions${sep}one`] },
			]);
			// A kind that loaded nothing is left out rather than shown as an empty section.
			expect(resourceListing({ ...resources, skills: [], prompts: [], extensions: [] }, "/home/user")).toEqual([
				{ name: "Context", items: [`~${sep}project${sep}AGENTS.md`] },
			]);
		});

		test("is shown unless quietStartup hides it, while a loader warning always is", async () => {
			const shown = recorder();
			await runDurableStartup({
				cwd,
				resumed: false,
				settings: settingsFor(),
				ui: shown.ui,
				resources,
				checks: quietChecks,
			});
			expect(shown.recorded.listings).toHaveLength(1);
			expect(shown.recorded.warnings).toEqual(["[Resources] Skill alpha is shadowed"]);

			const hiddenSettings = settingsFor();
			hiddenSettings.setQuietStartup(true);
			const hidden = recorder();
			await runDurableStartup({
				cwd,
				resumed: false,
				settings: hiddenSettings,
				ui: hidden.ui,
				resources,
				checks: quietChecks,
			});
			expect(hidden.recorded.listings).toEqual([]);
			expect(hidden.recorded.warnings).toEqual(["[Resources] Skill alpha is shadowed"]);
		});
	});

	test("the cards carry the text the screen shows, not the release object", () => {
		expect(versionUpdateCard({ version: "2.0.0" }).lines).toEqual([
			"New version 2.0.0 is available. Run `nyan update`.",
			"",
			"Changelog: https://github.com/blxzer77/nyan/blob/main/packages/coding-agent/CHANGELOG.md",
		]);
	});
});
