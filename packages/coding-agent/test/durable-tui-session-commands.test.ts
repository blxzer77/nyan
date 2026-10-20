import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openSessionDirectory } from "../src/core/durable/sessions.ts";
import { DurableCommands } from "../src/modes/durable/commands.ts";
import { listSiblingSessions } from "../src/modes/durable/session-list.ts";
import type { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { commandsOf as commandsFor, type Screen, screen, TuiHarness } from "./durable-tui-harness.ts";

/**
 * The session commands of the durable TUI, driven without a terminal: `DurableCommands` asks a `DurableCommandUi` port
 * for dialogs and lines, and the session owner it runs against is the one the interactive mode uses. Every assertion is
 * on what the session or the screen became, not on a recorded call into a stub.
 */

type Record_ = Record<string, unknown>;

describe("durable TUI session commands", () => {
	const harness = new TuiHarness();
	let cwd: string;

	beforeEach(async () => {
		await harness.start();
		cwd = harness.cwd;
	});

	afterEach(async () => {
		await harness.stop();
	});

	const open = async (responses?: string[]) => await harness.open(responses);
	const commandsOf = async (current: DurableSessionOwner, ui: Screen): Promise<DurableCommands> =>
		await commandsFor(current, ui);
	const say = async (current: DurableSessionOwner, text: string): Promise<void> => await harness.say(current, text);
	const events = harness.events;

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

	test("/export writes the session as HTML and as JSONL where asked", async () => {
		const current = await open();
		await say(current, "export me");
		const ui = screen();
		const commands = await commandsOf(current, ui);
		// The exporter writes into an existing directory, as legacy's does.
		const html = join(cwd, "session.html");
		const jsonl = join(cwd, "session.jsonl");

		await commands.run("export", html);
		await commands.run("export", jsonl);

		expect(ui.notices).toEqual([`Session exported to: ${html}`, `Session exported to: ${jsonl}`]);
		expect((await stat(html)).size).toBeGreaterThan(0);
		const lines = (await readFile(jsonl, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record_);
		expect(lines[0]).toMatchObject({ type: "session", cwd });
		expect(lines.filter((line) => line.type === "message").map((line) => (line.message as Record_).role)).toEqual([
			"user",
			"assistant",
		]);
	});

	test("/export reports a path it cannot write", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		// A directory where the file should go: the write itself fails, and the command reports it.
		await commands.run("export", cwd);

		expect(ui.notices.length).toBe(1);
		expect(ui.notices[0]).toMatch(/^Failed to export session: /u);
	});

	test("/copy hands the newest assistant text to the clipboard port", async () => {
		const current = await open();
		await say(current, "copy this");
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("copy", "");

		expect(ui.copied).toBe("first");
		expect(ui.notices).toEqual(["Copied last agent message to clipboard"]);
	});

	test("/copy without an answer reports that there is nothing to copy", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("copy", "");

		expect(ui.copied).toBeUndefined();
		expect(ui.notices).toEqual(["No agent messages to copy yet."]);
	});

	test("/changelog renders the package changelog as markdown", async () => {
		const current = await open();
		const ui = screen();
		const commands = await commandsOf(current, ui);

		await commands.run("changelog", "");

		// `parseChangelog` keeps the released sections only, and `/changelog` lists them oldest first, as legacy does.
		expect(ui.markdown).toContain("## [1.0.0]");
		expect(ui.markdown).toContain("## [1.3.0]");
		expect(ui.markdown?.startsWith("## [1.0.0]")).toBe(true);
		expect(ui.notices).toEqual([]);
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
