import { spawn } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, getAgentDir, getChangelogPath, VERSION } from "../../config.ts";
import { type CrashRecord, takeUnnotifiedCrash } from "../../core/crash-log.ts";
import type { ResourceDiagnostic } from "../../core/diagnostics.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../../core/trust-manager.ts";
import { getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { checkForNewNyanVersion, type LatestNyanRelease } from "../../utils/version-check.ts";

/**
 * What the durable TUI says when it opens a session: the update notices, the changelog after an upgrade, the crash
 * notice that points at `/bug`, the project trust warning, the loaded resources, the tmux keyboard warning, and the
 * terminal title. Legacy `interactive-mode.ts` runs these while it starts; this path runs them from `runDurableTui`.
 *
 * The notices are plain strings and the TUI decides how to draw them, so what is said is testable without a terminal.
 * The checks that reach outside the process (npm, GitHub, tmux) are injectable for the same reason.
 */

/** The changelog URL the update notice carries. */
const CHANGELOG_URL = "https://github.com/blxzer77/nyan/blob/main/packages/coding-agent/CHANGELOG.md";

/** What the startup notices are drawn in. `DurableTui` implements it. */
export interface DurableStartupUi {
	/** A warning line in the transcript, as legacy `showWarning`. */
	warn(message: string): void;
	/** A bordered notice with a title and body lines, as legacy's update notices. */
	card(title: string, lines: readonly string[]): void;
	/** The changelog after an update: its markdown, or the one-line form when `collapsed`. */
	changelog(markdown: string, latestVersion: string, collapsed: boolean): void;
	/** The loaded resource sections, `[Name]` plus its list. */
	resources(sections: readonly ResourceSection[]): void;
	/** The terminal title. */
	title(text: string): void;
}

/** One line group of the loaded-resources listing, as legacy renders `[Skills] a, b`. */
export interface ResourceSection {
	readonly name: string;
	readonly items: readonly string[];
}

/** The resources a start lists, already reduced to what the listing shows. */
export interface DurableStartupResources {
	readonly contextFiles: readonly string[];
	readonly skills: readonly string[];
	readonly prompts: readonly string[];
	readonly extensions: readonly string[];
	readonly diagnostics: readonly { readonly level: "error" | "warning"; readonly message: string }[];
}

/** The checks that reach outside the process; each default is the call the product makes. */
export interface DurableStartupChecks {
	readonly version?: () => Promise<LatestNyanRelease | undefined>;
	readonly packages?: () => Promise<readonly string[]>;
	readonly tmuxOption?: (option: string) => Promise<string | undefined>;
	readonly crash?: () => CrashRecord | undefined;
}

export interface DurableStartupInput {
	readonly cwd: string;
	readonly sessionName?: string;
	/** A session that already has entries is resumed, so it gets no changelog popup, as legacy skips it. */
	readonly resumed: boolean;
	readonly settings: SettingsManager;
	readonly ui: DurableStartupUi;
	readonly resources?: DurableStartupResources;
	readonly checks?: DurableStartupChecks;
	/** The changelog the popup reads; the package's own file unless a test says otherwise. */
	readonly changelogPath?: string;
}

/** The terminal title: `nyan - session name - directory`, without the name when there is none. */
export function terminalTitleFor(cwd: string, sessionName: string | undefined): string {
	const directory = basename(cwd);
	return sessionName === undefined || sessionName.length === 0
		? `${APP_TITLE} - ${directory}`
		: `${APP_TITLE} - ${sessionName} - ${directory}`;
}

/** The line legacy prints when the project is untrusted but holds resources that would otherwise load. */
export function projectTrustWarning(cwd: string, trusted: boolean): string | undefined {
	if (trusted || !hasTrustRequiringProjectResources(cwd)) return undefined;
	return `This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`;
}

/** The line that points at `/bug` after a crash the last run recorded. */
export function crashWarning(crash: CrashRecord): string {
	const when = new Date(crash.timestamp).toLocaleString();
	return `${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`;
}

/** What tmux reports about modified keys, as the two settings legacy queries. */
export function tmuxKeyboardWarning(
	extendedKeys: string | undefined,
	extendedKeysFormat: string | undefined,
): string | undefined {
	// If tmux cannot be queried (timeout, no server, not tmux), there is nothing to warn about.
	if (extendedKeys === undefined) return undefined;
	if (extendedKeys !== "on" && extendedKeys !== "always") {
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	}
	if (extendedKeysFormat === "xterm") {
		return `tmux extended-keys-format is xterm. ${APP_NAME} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
	}
	return undefined;
}

/** The new-version notice: the command that updates, the release note, and where the changelog is. */
export function versionUpdateCard(release: LatestNyanRelease): { title: string; lines: readonly string[] } {
	const note = release.note?.trim();
	return {
		title: "Update Available",
		lines: [
			`New version ${release.version} is available. Run \`${APP_NAME} update\`.`,
			...(note === undefined || note.length === 0 ? [] : ["", note]),
			"",
			`Changelog: ${CHANGELOG_URL}`,
		],
	};
}

/** The package-update notice: the command that updates extensions and the packages that have one. */
export function packageUpdateCard(packages: readonly string[]): { title: string; lines: readonly string[] } {
	return {
		title: "Package Updates Available",
		lines: [
			`Package updates are available. Run \`${APP_NAME} update --extensions\`.`,
			"Packages:",
			...packages.map((name) => `- ${name}`),
		],
	};
}

/** A path as the listing shows it: `~` inside the home directory, absolute otherwise. */
export function displayPath(path: string, home: string | undefined): string {
	if (home === undefined) return path;
	const resolvedPath = resolve(path);
	const resolvedHome = resolve(home);
	const inside = relative(resolvedHome, resolvedPath);
	if (inside === "") return "~";
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return path;
	return `~${sep}${inside}`;
}

/**
 * The loaded-resources listing, as legacy renders it: one `[Name]` line per kind that loaded something, and the
 * diagnostics that the loader reported. Empty kinds are left out rather than shown as an empty line.
 */
export function resourceListing(resources: DurableStartupResources, home: string | undefined): ResourceSection[] {
	const section = (name: string, items: readonly string[]): ResourceSection[] =>
		items.length === 0 ? [] : [{ name, items }];
	return [
		...section(
			"Context",
			resources.contextFiles.map((path) => displayPath(path, home)),
		),
		...section(
			"Skills",
			[...resources.skills].sort((left, right) => left.localeCompare(right)),
		),
		...section(
			"Prompts",
			[...resources.prompts].sort((left, right) => left.localeCompare(right)),
		),
		...section(
			"Extensions",
			resources.extensions
				.map((path) => displayPath(path, home).replace(/[/\\]index\.ts$/, ""))
				.sort((left, right) => left.localeCompare(right)),
		),
	];
}

/** The diagnostics of the listing: what the loader could not read, as warning lines. */
export function resourceWarnings(resources: DurableStartupResources): string[] {
	return resources.diagnostics.map((diagnostic) => `[Resources] ${diagnostic.message}`);
}

/**
 * The changelog a start shows, or none. A fresh install records the version and shows nothing; a session that already
 * has entries is resumed and shows nothing; otherwise the entries newer than the last recorded version are returned and
 * the version is recorded, as legacy `getChangelogForDisplay` does.
 */
export function newChangelog(
	settings: SettingsManager,
	resumed: boolean,
	changelogPath: string = getChangelogPath(),
): { markdown: string; latestVersion: string } | undefined {
	if (resumed) return undefined;
	const lastVersion = settings.getLastChangelogVersion();
	const entries = parseChangelog(changelogPath);
	if (lastVersion === undefined) {
		settings.setLastChangelogVersion(VERSION);
		return undefined;
	}
	const fresh = getNewEntries(entries, lastVersion);
	if (fresh.length === 0) return undefined;
	settings.setLastChangelogVersion(VERSION);
	const newest = fresh[0];
	if (newest === undefined) return undefined;
	return {
		markdown: fresh.map((entry) => normalizeChangelogLinks(entry.content, entry)).join("\n\n"),
		latestVersion: `${newest.major}.${newest.minor}.${newest.patch}`,
	};
}

/** Ask tmux for one setting, as legacy `checkTmuxKeyboardSetup` does: undefined when tmux cannot answer. */
function readTmuxOption(option: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const proc = spawn("tmux", ["show", "-gv", option], { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		const timer = setTimeout(() => {
			proc.kill();
			resolve(undefined);
		}, 2000);
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim() : undefined);
		});
	});
}

/** The package updates npm reports, or none: a start never fails because this check failed. */
async function availablePackageUpdates(input: DurableStartupInput): Promise<readonly string[]> {
	try {
		const manager = new DefaultPackageManager({
			cwd: input.cwd,
			agentDir: getAgentDir(),
			settingsManager: input.settings,
		});
		return (await manager.checkForAvailableUpdates()).map((update) => update.displayName);
	} catch {
		return [];
	}
}

/**
 * Show the startup notices. The caller does not await it: the checks that reach the network answer when they answer,
 * exactly as legacy starts them. Resolves after every notice has been handed to the UI.
 */
export async function runDurableStartup(input: DurableStartupInput): Promise<void> {
	const { ui, resources, settings } = input;
	ui.title(terminalTitleFor(input.cwd, input.sessionName));

	const changelog = newChangelog(settings, input.resumed, input.changelogPath);
	if (changelog !== undefined)
		ui.changelog(changelog.markdown, changelog.latestVersion, settings.getCollapseChangelog());

	// The listing follows `quietStartup`; a loader's diagnostics are reported whatever it says, as legacy does.
	const showListing = settings.getQuietStartup() === false;
	if (resources !== undefined && showListing) {
		const sections = resourceListing(resources, process.env.HOME || process.env.USERPROFILE);
		if (sections.length > 0) ui.resources(sections);
	}
	for (const message of resources === undefined ? [] : resourceWarnings(resources)) ui.warn(message);

	const trust = projectTrustWarning(input.cwd, settings.isProjectTrusted());
	if (trust !== undefined) ui.warn(trust);

	const crash = (input.checks?.crash ?? (() => takeUnnotifiedCrash()))();
	if (crash !== undefined) ui.warn(crashWarning(crash));

	const checkVersion = input.checks?.version ?? (() => checkForNewNyanVersion(VERSION));
	const checkPackages = input.checks?.packages ?? (() => availablePackageUpdates(input));
	const readOption = input.checks?.tmuxOption ?? readTmuxOption;
	await Promise.all([
		checkVersion()
			.then((release) => {
				if (release === undefined) return;
				const card = versionUpdateCard(release);
				ui.card(card.title, card.lines);
			})
			.catch(() => {}),
		checkPackages()
			.then((packages) => {
				if (packages.length === 0) return;
				const card = packageUpdateCard(packages);
				ui.card(card.title, card.lines);
			})
			.catch(() => {}),
		(async () => {
			if (!process.env.TMUX) return;
			const [extendedKeys, extendedKeysFormat] = await Promise.all([
				readOption("extended-keys"),
				readOption("extended-keys-format"),
			]);
			const warning = tmuxKeyboardWarning(extendedKeys, extendedKeysFormat);
			if (warning !== undefined) ui.warn(warning);
		})().catch(() => {}),
	]);
}

/** The loaded resources of one open, as the start lists them. */
export interface StartupResourceLoader {
	getSystemPromptSource(): { readonly path: string } | undefined;
	getAppendSystemPromptSources(): ReadonlyArray<{ readonly path: string }>;
	getAgentsFiles(): { readonly agentsFiles: ReadonlyArray<{ readonly path: string }> };
	getSkills(): {
		readonly skills: ReadonlyArray<{ readonly name: string }>;
		readonly diagnostics: ResourceDiagnostic[];
	};
	getPrompts(): {
		readonly prompts: ReadonlyArray<{ readonly name: string }>;
		readonly diagnostics: ResourceDiagnostic[];
	};
	getThemes(): { readonly themes: readonly unknown[]; readonly diagnostics: ResourceDiagnostic[] };
	getExtensions(): {
		readonly extensions: ReadonlyArray<{ readonly path: string; readonly hidden?: boolean }>;
		readonly errors: ReadonlyArray<{ readonly path: string; readonly error: string }>;
		readonly warnings?: ReadonlyArray<{ readonly path: string; readonly warning: string }>;
	};
}

/** Reduce a loaded resource set to the listing: names, paths, and the diagnostics the loader reported. */
export function startupResources(loader: StartupResourceLoader): DurableStartupResources {
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const themes = loader.getThemes();
	const extensions = loader.getExtensions();
	const systemPrompt = loader.getSystemPromptSource();
	const diagnostics: ResourceDiagnostic[] = [
		...skills.diagnostics,
		...prompts.diagnostics,
		...themes.diagnostics,
		...extensions.errors.map((error) => ({ type: "error" as const, message: error.error, path: error.path })),
		...(extensions.warnings ?? []).map((warning) => ({
			type: "warning" as const,
			message: warning.warning,
			path: warning.path,
		})),
	];
	return {
		contextFiles: [
			...(systemPrompt === undefined ? [] : [systemPrompt.path]),
			...loader.getAppendSystemPromptSources().map((source) => source.path),
			...loader.getAgentsFiles().agentsFiles.map((file) => file.path),
		],
		skills: skills.skills.map((skill) => skill.name),
		prompts: prompts.prompts.map((prompt) => `/${prompt.name}`),
		extensions: extensions.extensions.filter((extension) => extension.hidden !== true).map((ext) => ext.path),
		diagnostics: diagnostics.map((diagnostic) => ({
			level: diagnostic.type === "error" ? ("error" as const) : ("warning" as const),
			message: diagnostic.message,
		})),
	};
}
