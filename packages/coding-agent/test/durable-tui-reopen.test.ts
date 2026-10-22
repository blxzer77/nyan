import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DurableView } from "../src/core/durable/runtime.ts";
import { setDurableSessionStore } from "../src/core/durable/sessions.ts";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type DurableEditorPort, DurableInput } from "../src/modes/durable/input.ts";
import type { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { type DurableTuiOpen, DurableTuiSession } from "../src/modes/durable/tui.ts";
import { settlement } from "./durable-submission.ts";
import { TuiHarness } from "./durable-tui-harness.ts";

/**
 * The reopen wiring of the durable TUI, driven without a terminal: `DurableTuiSession` is the object `runDurableTui`
 * reads the session, the settings, and the extension runner from, and `DurableInput` is what a key press reaches. The
 * ports the TUI renders through are replaced by what a test can read, so every assertion is on the session, the
 * followed view, or the shortcut a key press resolves.
 */

/** F5, the key an extension shortcut below registers. */
const F5 = "\x1b[15~";

/** The editor as an input action reads it: a buffer no test here types into. */
const idleEditor: DurableEditorPort = {
	getText: () => "",
	setText: () => {},
	insertText: () => {},
	cursor: () => ({ line: 0, col: 0 }),
	addToHistory: () => {},
	setThinkingHidden: () => {},
};

/** The prompts the followed view holds, newest last. */
function prompts(view: DurableView): string[] {
	return view.conversation.entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (entry.kind !== "nyan.user" || message?.role !== "user") return [];
		return typeof message.content === "string"
			? [message.content]
			: [message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")];
	});
}

/**
 * The TUI's session over a real owner, with the ports `runDurableTui` renders through replaced by records: every view
 * the TUI would show, and every open it was told to bind.
 */
function tuiSession(owner: DurableSessionOwner) {
	const shown: DurableView[] = [];
	const bound: DurableTuiOpen[] = [];
	const session = new DurableTuiSession({
		open: owner.tui,
		settings: owner.current.settings,
		sessions: { open: owner.tui, reopen: (request) => owner.reopen(request), current: () => owner.tui },
		follow: (source) => {
			shown.push(source.current());
			return source.subscribe(() => shown.push(source.current()));
		},
		bind: async (next) => {
			bound.push(next);
		},
	});
	session.listen();
	/** The view the screen last rendered. */
	const screen = (): DurableView => shown.at(-1) ?? session.current.view.current();
	return { session, shown, bound, screen };
}

/** The editor's actions over the session shown now, wired as the TUI wires them: the runner is read per key press. */
function tuiInput(session: DurableTuiSession): DurableInput {
	return new DurableInput({
		current: () => ({
			view: session.current.view.current(),
			controller: session.current.controller,
			sessionOps: session.current.sessionOps,
		}),
		settings: session.settings,
		modelRuntime: session.current.modelRuntime,
		getScopedModels: () => null,
		editor: idleEditor,
		keybindings: KeybindingsManager.create(),
		get extensionRunner() {
			return session.extensionRunner;
		},
		notify: () => {},
		runCommand: () => false,
		dispatchExtension: async () => false,
		copyText: async () => {},
		stopTerminal: () => {},
		startTerminal: () => {},
		exit: () => {},
	});
}

describe("durable TUI reopen", () => {
	const harness = new TuiHarness();

	beforeEach(async () => {
		await harness.start();
	});

	afterEach(async () => {
		await harness.stop();
	});

	test("a successful /reload shows the open it made: its settings, its themes, and its extension runner", async () => {
		const pressed: string[] = [];
		let loads = 0;
		const shortcuts: InlineExtension = (pi: ExtensionAPI) => {
			loads += 1;
			const load = loads;
			pi.registerShortcut("f5", {
				description: `Registered by load ${load}`,
				handler: async () => {
					pressed.push(`f5:${load}`);
				},
			});
		};
		const owner = await harness.open(undefined, { extraFactories: [shortcuts] });
		const { session, bound } = tuiSession(owner);
		const input = tuiInput(session);
		const replaced = session.current;

		expect(input.extensionShortcut(F5)).toBe(true);
		await vi.waitFor(() => expect(pressed).toEqual(["f5:1"]));

		await session.reopen({ kind: "reload" });

		expect(bound).toEqual([session.current]);
		expect(session.current).not.toBe(replaced);
		// The settings the TUI reads are the ones the new open loaded, not the ones the start was handed.
		expect(session.settings).toBe(session.current.settings);
		expect(session.current.settings).not.toBe(replaced.settings);
		expect(session.current.themes?.map((theme) => theme.name)).toEqual(replaced.themes?.map((theme) => theme.name));
		expect(session.current.themes).not.toBe(replaced.themes);
		// The reloaded extension instance is the one a key press reaches, and the one the replaced open left is not.
		expect(loads).toBe(2);
		expect(input.extensionShortcut(F5)).toBe(true);
		await vi.waitFor(() => expect(pressed).toEqual(["f5:1", "f5:2"]));
		expect(harness.events).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});

	test("a /reload that fails follows the session the owner recovered, and it still takes a prompt", async () => {
		let broken = false;
		const bomb: InlineExtension = () => {
			if (broken) throw new Error("this extension refuses to load");
		};
		const owner = await harness.open(undefined, { extraFactories: [bomb] });
		const { session, screen } = tuiSession(owner);
		const directory = session.current.view.current().session.directory;

		broken = true;
		const failure: unknown = await session.reopen({ kind: "reload" }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("this extension refuses to load");
		// The session the TUI shows is the live one the owner reopened, in the directory the reload was for.
		expect(session.current.view.current().session.directory).toBe(directory);
		expect(session.current.sessionOps).toBe(owner.current.sessionOps);
		expect(harness.events).toEqual(["start:startup", "shutdown:reload", "start:resume"]);

		// It still takes a prompt, and the subscription the TUI moved to the recovered session delivers the answer.
		expect((await settlement(session.current.controller.submitAndWait("still here", "followUp"))).status).toBe(
			"done",
		);
		await vi.waitFor(() => expect(prompts(screen())).toEqual(["still here"]));
		expect(screen().conversation.conversation.id).toBe(session.current.view.current().conversation.conversation.id);
	});

	test("a /new that cannot open leaves the TUI on the live session it came from", async () => {
		const owner = await harness.open();
		const { session, screen } = tuiSession(owner);
		const directory = session.current.view.current().session.directory;
		// A store that cannot hold a session directory: `/new` creates one, and creating it fails.
		const blocked = join(harness.agentDir, "not-a-store");
		await writeFile(blocked, "");
		setDurableSessionStore({ root: join(blocked, "sessions") });
		let failure: unknown;
		try {
			failure = await session.reopen({ kind: "new" }).catch((error: unknown) => error);
		} finally {
			setDurableSessionStore({});
		}

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("not-a-store");
		// The owner put the session it came from back, and the TUI follows that one rather than the closed one.
		expect(session.current.view.current().session.directory).toBe(directory);
		expect(harness.events).toEqual(["start:startup", "shutdown:new", "start:resume"]);

		expect((await settlement(session.current.controller.submitAndWait("after the failure", "followUp"))).status).toBe(
			"done",
		);
		await vi.waitFor(() => expect(prompts(screen())).toEqual(["after the failure"]));
	});
});
