import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { DurableCommands, type DurableCommandUi } from "../src/modes/durable/commands.ts";
import { DurableSessionOwner, tuiof } from "../src/modes/durable/session-owner.ts";
import { settlement } from "./durable-submission.ts";

/**
 * `/share` and `/bug` on the durable TUI. The boundaries are the real ones: `gh` is a fake executable on `PATH` that
 * records what it was asked to upload, and the archive and export are real files in temporary directories. No gist is
 * created anywhere.
 */

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

type Record_ = Record<string, unknown>;

/** The TUI side of a flow, as far as a command can observe it. */
interface Screen extends DurableCommandUi {
	readonly notices: string[];
	readonly choices: string[][];
	readonly descriptions: Array<string | undefined>;
	/** What each dialog answers, in order; a missing answer cancels. */
	selectAnswers: Array<string | undefined>;
	inputAnswers: Array<string | undefined>;
}

function screen(): Screen {
	const state: Screen = {
		notices: [],
		choices: [],
		descriptions: [],
		selectAnswers: [],
		inputAnswers: [],
		select: async (_title, items, description) => {
			state.choices.push(items.map((item) => item.value));
			state.descriptions.push(description);
			return state.selectAnswers.shift();
		},
		input: async (_title, description) => {
			state.descriptions.push(description);
			return state.inputAnswers.shift();
		},
		notify: (message) => {
			state.notices.push(message);
		},
		showLines: () => {},
		setSessionName: () => {},
		showMarkdown: () => {},
		copy: async () => {},
		exit: () => {},
	};
	return state;
}

/** The entries of a zip archive this repository writes, by name. */
function readZip(file: string): Record<string, string> {
	const buffer = readFileSync(file);
	const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	expect(end).toBeGreaterThanOrEqual(0);
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	const files: Record<string, string> = {};
	for (let index = 0; index < count; index++) {
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const start = localOffset + 30 + localNameLength + localExtraLength;
		files[name] = inflateRawSync(buffer.subarray(start, start + compressedSize)).toString("utf8");
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}

describe("durable TUI /share and /bug", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let bin: string;
	let uploadLog: string;
	let owner: DurableSessionOwner | undefined;
	let cwdSpy: MockInstance;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-share-bug-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-share-bug-cwd-"));
		bin = join(home, "bin");
		uploadLog = join(home, "uploaded");
		await mkdir(agentDir, { recursive: true });
		await mkdir(bin, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
		vi.stubEnv("FAKE_GH_UPLOAD", uploadLog);
		vi.stubEnv("FAKE_GH_URL", "https://gist.github.com/tester/abc123");
		vi.stubEnv("NYAN_SHARE_VIEWER_URL", "https://viewer.test/share");
		// `/bug` writes the archive into the working directory, so a test run never leaves one in the repository.
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		owner = undefined;
	});

	afterEach(async () => {
		await owner?.close().catch(() => {});
		owner = undefined;
		cwdSpy.mockRestore();
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	/** A `gh` that answers `auth status` and records the file it was asked to upload. */
	async function fakeGh(body = ""): Promise<void> {
		const script = `#!/usr/bin/env bash\n${body}if [ "$1" = "auth" ]; then exit 0; fi\nif [ "$1" = "gist" ]; then\n\tfor arg in "$@"; do\n\t\tif [ -f "$arg" ]; then cp "$arg" "$FAKE_GH_UPLOAD"; fi\n\tdone\n\tprintf '%s\\n' "$FAKE_GH_URL"\n\texit 0\nfi\nexit 1\n`;
		const file = join(bin, "gh");
		await writeFile(file, script);
		chmodSync(file, 0o755);
	}

	/** Open a durable session with a faux provider, as an interactive run does. */
	async function open(responses: string[] = ["first answer"]): Promise<DurableSessionOwner> {
		const faux = fauxProvider();
		faux.setResponses(responses.map((text) => () => fauxAssistantMessage([fauxText(text)])));
		const model = faux.getModel();
		const provider: InlineExtension = (pi) => {
			pi.registerProvider(faux.provider);
		};
		owner = await DurableSessionOwner.open({
			cwd,
			extensionFactories: [provider],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return owner;
	}

	/** The commands of the open session, with the members the TUI hands them. */
	async function commandsOf(current: DurableSessionOwner, ui: Screen): Promise<DurableCommands> {
		return DurableCommands.create(
			{
				current: () => {
					const tui = tuiof(current.current);
					return {
						view: tui.view.current(),
						controller: tui.controller,
						sessionOps: tui.sessionOps!,
						...(tui.bugReport === undefined ? {} : { bugReport: tui.bugReport }),
					};
				},
				readSessionName: () => current.current.sessionOps.getSessionName(),
			},
			ui,
		);
	}

	async function say(current: DurableSessionOwner, text: string): Promise<void> {
		expect((await settlement(current.current.controller.submitAndWait(text, "followUp"))).status).toBe("done");
	}

	test.skipIf(process.platform === "win32")(
		"/share uploads the HTML export as a secret gist and reports both links",
		async () => {
			const current = await open();
			await say(current, "share me");
			await fakeGh();
			const ui = screen();

			await (await commandsOf(current, ui)).run("share", "");

			expect(ui.notices).toEqual([
				"Creating gist...",
				"Share URL: https://viewer.test/share#abc123",
				"Gist: https://gist.github.com/tester/abc123",
			]);
			// The upload is the standalone HTML page of this session, not the JSONL the durable store keeps.
			const uploaded = readFileSync(uploadLog, "utf8");
			expect(uploaded.startsWith("<!DOCTYPE html>")).toBe(true);
			// The page carries the session base64-encoded, as every exported page does.
			const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/u.exec(uploaded);
			expect(match).not.toBeNull();
			const embedded = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");
			expect(embedded).toContain("share me");
		},
	);

	test.skipIf(process.platform === "win32")("/share without a viewer reports only the gist", async () => {
		const current = await open();
		vi.stubEnv("NYAN_SHARE_VIEWER_URL", "");
		await fakeGh();
		const ui = screen();

		await (await commandsOf(current, ui)).run("share", "");

		expect(ui.notices).toEqual(["Creating gist...", "Gist: https://gist.github.com/tester/abc123"]);
	});

	test.skipIf(process.platform === "win32")("/share reports a logged-out GitHub CLI and uploads nothing", async () => {
		const current = await open();
		await fakeGh('if [ "$1" = "auth" ]; then exit 1; fi\n');
		const ui = screen();

		await (await commandsOf(current, ui)).run("share", "");

		expect(ui.notices).toEqual(["GitHub CLI is not logged in. Run 'gh auth login' first."]);
		expect(existsSync(uploadLog)).toBe(false);
	});

	test.skipIf(process.platform === "win32")("/share reports a missing GitHub CLI", async () => {
		const current = await open();
		vi.stubEnv("PATH", bin);
		const ui = screen();

		await (await commandsOf(current, ui)).run("share", "");

		expect(ui.notices).toEqual(["GitHub CLI (gh) is not installed. Install it from https://cli.github.com/"]);
		expect(existsSync(uploadLog)).toBe(false);
	});

	test("/bug writes a zip with the transcript when the user keeps it", async () => {
		const current = await open();
		await say(current, "report me");
		const ui = screen();
		ui.inputAnswers.push("it broke");
		ui.selectAnswers.push("Yes, include the transcript", "Export as Zip");

		await (await commandsOf(current, ui)).run("bug", "");

		// The dialogs ask for the description first, then for the transcript, then for delivery.
		expect(ui.choices).toEqual([
			["Yes, include the transcript", "No"],
			["Export as Zip", "Cancel"],
		]);
		expect(ui.descriptions[0]).toContain("What went wrong? (optional)");
		const exported = ui.notices[0];
		expect(exported).toMatch(/^Bug report exported to: /u);
		const archive = exported!.slice("Bug report exported to: ".length);
		expect(archive.startsWith(`${cwd}/`)).toBe(true);
		expect(ui.notices[1]).toMatch(/^Report ID: /u);

		const files = readZip(archive);
		expect(Object.keys(files).sort()).toEqual(["diagnostics.json", "report.json", "session.jsonl"]);
		const report = JSON.parse(files["report.json"] ?? "") as Record_;
		expect(report).toMatchObject({ hint: "it broke", session: { included: true, summaryIncluded: false } });
		expect((report.session as Record_).messageCount).toBe(2);
		// The transcript is the durable session's JSONL mapping: its header names this working directory.
		expect(files["session.jsonl"]?.split("\n")[0]).toContain(JSON.stringify(cwd));
		rmSync(archive, { force: true });
	});

	test("/bug writes a model-written summary instead of the transcript", async () => {
		const current = await open(["what broke", "## What went wrong\nThe command failed."]);
		await say(current, "report me");
		const ui = screen();
		ui.inputAnswers.push("");
		ui.selectAnswers.push("No", "Yes, generate a summary", "Export as Zip");

		await (await commandsOf(current, ui)).run("bug", "");

		expect(ui.choices).toEqual([
			["Yes, include the transcript", "No"],
			["Yes, generate a summary", "No"],
			["Export as Zip", "Cancel"],
		]);
		expect(ui.notices[0]).toMatch(/^Writing summary with /u);
		expect(ui.notices[1]).toMatch(/^Bug report exported to: /u);
		const archive = ui.notices[1]!.slice("Bug report exported to: ".length);
		expect(archive.startsWith(`${cwd}/`)).toBe(true);
		const files = readZip(archive);
		expect(Object.keys(files).sort()).toEqual(["diagnostics.json", "report.json", "summary.md"]);
		expect(files["summary.md"]).toBe("## What went wrong\nThe command failed.\n");
		const report = JSON.parse(files["report.json"] ?? "") as Record_;
		expect(report).toMatchObject({ hint: null, session: { included: false, summaryIncluded: true } });
		rmSync(archive, { force: true });
	});

	test("/bug writes no archive when the first dialog is cancelled", async () => {
		const current = await open();
		const before = new Set(await readdir(cwd));
		const ui = screen();

		await (await commandsOf(current, ui)).run("bug", "");

		expect(ui.notices).toEqual(["Bug report cancelled"]);
		expect(ui.choices).toEqual([]);
		expect(new Set(await readdir(cwd))).toEqual(before);
	});

	test("/bug writes no archive when the delivery dialog is cancelled", async () => {
		const current = await open();
		const before = new Set(await readdir(cwd));
		const ui = screen();
		ui.inputAnswers.push("it broke");
		ui.selectAnswers.push("Yes, include the transcript", "Cancel");

		await (await commandsOf(current, ui)).run("bug", "");

		expect(ui.notices).toEqual(["Bug report cancelled"]);
		expect(new Set(await readdir(cwd))).toEqual(before);
	});

	test("/bug reports the commands it cannot run without a bug report environment", async () => {
		const current = await open();
		const ui = screen();
		// An embedding that owns no model runtime: the session members are there, the process facts are not.
		const commands = await DurableCommands.create(
			{
				current: () => ({
					view: current.current.view.current(),
					controller: current.current.controller,
					sessionOps: current.current.sessionOps,
				}),
				readSessionName: () => current.current.sessionOps.getSessionName(),
			},
			ui,
		);

		await commands.run("bug", "");

		expect(ui.notices).toEqual(["/bug is not available in this mode."]);
		expect(ui.inputAnswers).toEqual([]);
	});
});
