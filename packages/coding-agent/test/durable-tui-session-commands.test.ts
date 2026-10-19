import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { openSessionDirectory } from "../src/core/durable/sessions.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { DurableCommands, type DurableCommandUi } from "../src/modes/durable/commands.ts";
import { listSiblingSessions } from "../src/modes/durable/session-list.ts";
import { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { settlement } from "./durable-submission.ts";

/**
 * The session commands of the durable TUI, driven without a terminal: `DurableCommands` asks a `DurableCommandUi` port
 * for dialogs and lines, and the session owner it runs against is the one the interactive mode uses. Every assertion is
 * on what the session or the screen became, not on a recorded call into a stub.
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

/** The TUI side of a command, as far as a command can observe it. */
interface Screen extends DurableCommandUi {
	readonly notices: string[];
	readonly lines: string[];
	readonly choices: string[][];
	/** The display name the footer was given, last. */
	sessionName?: string;
	exited: boolean;
	/** What the next `select` answers; a choice not offered makes the command fail, as a missing entry would. */
	answer?: string;
}

function screen(): Screen {
	const state: Screen = {
		notices: [],
		lines: [],
		choices: [],
		exited: false,
		answer: undefined,
		select: async (_title, items) => {
			state.choices.push(items.map((item) => item.value));
			return state.answer;
		},
		showLines: (lines) => {
			state.lines.push(...lines);
		},
		setSessionName: (name) => {
			state.sessionName = name;
		},
		notify: (message) => {
			state.notices.push(message);
		},
		exit: () => {
			state.exited = true;
		},
	};
	return state;
}

describe("durable TUI session commands", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let owner: DurableSessionOwner | undefined;
	let events: string[];

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-tui-commands-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-tui-commands-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		events = [];
		owner = undefined;
	});

	afterEach(async () => {
		await owner?.close().catch(() => {});
		owner = undefined;
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	/** Open a session with a faux provider; `probe` records the extension lifecycle of every reopen. */
	async function open(responses: string[] = ["first", "second", "third"]): Promise<DurableSessionOwner> {
		const faux = fauxProvider();
		faux.setResponses(responses.map((text) => () => fauxAssistantMessage([fauxText(text)])));
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		const probe: InlineExtension = (pi) => {
			pi.on("session_start", (event) => {
				events.push(`start:${event.reason}`);
			});
			pi.on("session_shutdown", (event) => {
				events.push(`shutdown:${event.reason}`);
			});
		};
		owner = await DurableSessionOwner.open({
			cwd,
			extensionFactories: [provider, probe],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return owner;
	}

	/** The commands of the open session, with the owner's real reopen behind them. */
	async function commandsOf(current: DurableSessionOwner, ui: Screen): Promise<DurableCommands> {
		return DurableCommands.create(
			{
				current: () => ({
					view: current.current.view.current(),
					controller: current.current.controller,
					sessionOps: current.current.sessionOps,
				}),
				readSessionName: () => current.current.sessionOps.getSessionName(),
				reopen: async (request) => {
					const next = await current.reopen(request);
					void next;
				},
			},
			ui,
		);
	}

	async function say(current: DurableSessionOwner, text: string): Promise<void> {
		expect((await settlement(current.current.controller.submitAndWait(text, "followUp"))).status).toBe("done");
	}

	test("/name stores the display name beside the database and shows it afterwards", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("name", "release line");
		expect(await current.current.sessionOps.getSessionName()).toBe("release line");
		expect(commands.sessionName).toBe("release line");
		expect(ui.lines).toEqual(["Session name set: release line"]);
		expect(ui.sessionName).toBe("release line");

		const stored = JSON.parse(
			await readFile(join(current.current.view.current().session.directory, "session.json"), "utf8"),
		) as { name?: string };
		expect(stored.name).toBe("release line");

		await commands.run("name", "");
		expect(ui.lines).toEqual(["Session name set: release line", "Session name: release line"]);
	});

	test("/name without a name and without one stored reports the usage", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("name", "   ");

		expect(ui.notices).toEqual(["Usage: /name <name>"]);
		expect(ui.lines).toEqual([]);
	});

	test("/session reports the session and what the conversation holds", async () => {
		const current = await open();
		await say(current, "hello");
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("session", "");

		const view = current.current.view.current();
		expect(ui.lines).toEqual(
			expect.arrayContaining([
				`  Directory: ${view.session.directory}`,
				`  ID: ${view.session.id}`,
				"  Total: 2",
				"  User: 1",
				"  Assistant: 1",
				"  Tool results: 0",
				"  Compactions: 0",
			]),
		);
		expect(ui.lines[0]).toBe("Session");
	});

	test("/fork switches the conversation to the branch at the chosen message", async () => {
		const current = await open();
		await say(current, "first question");
		await say(current, "second question");
		const before = current.current.view.current().conversation.conversation.id;
		const messages = await current.current.sessionOps.forkMessages();
		const ui = screen();
		ui.answer = messages[0]?.entryId;
		const commands = await commandsOf(current, ui);

		await commands.run("fork", "");

		// The picker offers every user message of the session, in append order.
		expect(ui.choices[0]).toEqual(messages.map((message) => message.entryId));
		expect(messages.map((message) => message.text)).toEqual(["first question", "second question"]);
		expect(current.current.view.current().conversation.conversation.id).not.toBe(before);
		expect(ui.notices).toEqual(["Forked: first question"]);
	});

	test("/fork cancelled at the picker keeps the conversation", async () => {
		const current = await open();
		await say(current, "first question");
		const before = current.current.view.current().conversation.conversation.id;
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("fork", "");

		expect(current.current.view.current().conversation.conversation.id).toBe(before);
		expect(ui.notices).toEqual(["Fork cancelled"]);
	});

	test("/clone copies the conversation and moves to the copy", async () => {
		const current = await open();
		await say(current, "copy me");
		const before = current.current.view.current().conversation.conversation.id;
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("clone", "");

		const cloned = current.current.view.current().conversation;
		expect(cloned.conversation.id).not.toBe(before);
		// The copy carries the same messages as the conversation it was cloned from.
		expect(
			cloned.entries
				.flatMap((entry) => entry.model ?? [])
				.filter((message) => message.role === "user")
				.map((message) => message.content),
		).toEqual(["copy me"]);
		expect(ui.notices).toEqual(["Session cloned"]);
	});

	test("/quit asks the TUI to exit", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("quit", "");

		expect(ui.exited).toBe(true);
	});

	test("/new opens a new session and shuts the previous one down", async () => {
		const current = await open();
		await say(current, "old session");
		const previous = current.current.view.current().session.directory;
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("new", "");

		const opened = current.current.view.current().session;
		expect(opened.directory).not.toBe(previous);
		expect(opened.cwd).toBe(current.current.view.current().session.cwd);
		expect(events).toEqual(["start:startup", "shutdown:new", "start:startup"]);
		expect(ui.notices).toEqual(["New session started"]);
		// The previous session is closed: its lock is released, so another process could open it.
		const reopened = await openSessionDirectory(previous);
		await reopened.release();
	});

	test("/resume reopens the chosen session and reports the same working directory", async () => {
		const first = await open();
		await say(first, "session one");
		const firstDirectory = first.current.view.current().session.directory;
		await first.close();
		owner = undefined;

		// A second session of the same working directory, which is the one open when /resume runs.
		const second = await open();
		expect(second.current.view.current().session.directory).not.toBe(firstDirectory);
		const ui = screen();
		ui.answer = firstDirectory;
		const commands = await commandsOf(second, ui);

		await commands.run("resume", "");

		expect(openSession(second).directory).toBe(firstDirectory);
		expect(openSession(second).cwd).toBe(cwd);
		expect(events).toEqual(["start:startup", "shutdown:quit", "start:startup", "shutdown:resume", "start:resume"]);
		expect(ui.notices).toEqual(["Session resumed"]);
	});

	test("/resume offers only the other sessions of this directory", async () => {
		const first = await open();
		await say(first, "session one");
		await first.close();
		owner = undefined;

		const second = await open();
		const currentDirectory = second.current.view.current().session.directory;
		const listed = await listSiblingSessions(currentDirectory);

		expect(listed.map((session) => session.current)).toEqual([true, false]);
		expect(listed.filter((session) => !session.current).length).toBe(1);

		const ui = screen();
		const commands = await commandsOf(second, ui);
		await commands.run("resume", "");
		expect(ui.choices[0]).toEqual(listed.filter((session) => !session.current).map((session) => session.directory));
		expect(ui.notices).toEqual(["Resume cancelled"]);
	});

	test("a caller without session operations reports the commands it cannot run", async () => {
		// The experimental modes pass no session operations; the TUI answers instead of submitting the command.
		const ui = screen();
		const commands = new DurableCommands(
			{
				current: () => {
					throw new Error("no session operations");
				},
				readSessionName: async () => undefined,
			},
			ui,
		);
		await commands.run("new", "");
		expect(ui.notices).toEqual(["/new is not available in this mode."]);
	});
});

/** The directory and working directory of the session an owner shows now. */
function openSession(owner: DurableSessionOwner): { directory: string; cwd: string } {
	const session = owner.current.view.current().session;
	return { directory: session.directory, cwd: session.cwd };
}
