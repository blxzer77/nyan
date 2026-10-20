import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { agentOf, type DurableView } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type ClipboardPaste,
	type DurableEditorPort,
	DurableInput,
	nextModelInCycle,
} from "../src/modes/durable/input.ts";
import type { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { TuiHarness } from "./durable-tui-harness.ts";

/**
 * The durable TUI's input actions, driven against a real durable session. The editor is the boundary these tests fake:
 * a prompt buffer, its history, and the transcript's thinking visibility are what an action touches. The clipboard, the
 * external editor, and the queue are real.
 */

/** The editor as an input action sees it: a buffer, a cursor, and the history keys browse. */
class PromptEditor implements DurableEditorPort {
	text = "";
	cursorLine = 0;
	cursorCol = 0;
	readonly history: string[] = [];
	readonly inserted: string[] = [];
	hidden = false;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.#cursorToEnd();
	}

	insertText(text: string): void {
		const offset = this.#offset();
		this.text = this.text.slice(0, offset) + text + this.text.slice(offset);
		this.inserted.push(text);
		const after = this.text.slice(0, offset + text.length).split("\n");
		this.cursorLine = after.length - 1;
		this.cursorCol = (after.at(-1) ?? "").length;
	}

	cursor(): { line: number; col: number } {
		return { line: this.cursorLine, col: this.cursorCol };
	}

	addToHistory(text: string): void {
		this.history.push(text);
	}

	setThinkingHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	#offset(): number {
		const lines = this.text.split("\n");
		let offset = 0;
		for (let index = 0; index < this.cursorLine; index++) offset += (lines[index] ?? "").length + 1;
		return offset + this.cursorCol;
	}

	#cursorToEnd(): void {
		const lines = this.text.split("\n");
		this.cursorLine = lines.length - 1;
		this.cursorCol = (lines.at(-1) ?? "").length;
	}
}

/** One durable session, its input actions, and what they asked the terminal and the notice area to do. */
function testInput(owner: DurableSessionOwner, editor = new PromptEditor()) {
	const state = {
		exited: false,
		clock: 1_000,
		scoped: null as readonly string[] | null,
		runCommand: (_text: string) => false,
		dispatchExtension: async (_text: string) => false,
		readClipboard: async (): Promise<ClipboardPaste | undefined> => undefined,
		notices: [] as string[],
		terminal: [] as string[],
		copied: [] as string[],
	};
	const input = new DurableInput({
		current: () => ({
			view: owner.current.view.current(),
			controller: owner.current.controller,
			sessionOps: owner.current.sessionOps,
		}),
		settings: owner.current.settings,
		modelRuntime: owner.current.modelRuntime,
		getScopedModels: () => state.scoped,
		editor,
		keybindings: KeybindingsManager.create(),
		extensionRunner: owner.current.extensionHost?.runner,
		notify: (message, type) => state.notices.push(`${type ?? "info"}: ${message}`),
		runCommand: (text) => state.runCommand(text),
		dispatchExtension: (text) => state.dispatchExtension(text),
		readClipboard: () => state.readClipboard(),
		copyText: async (text) => {
			state.copied.push(text);
		},
		stopTerminal: () => state.terminal.push("stop"),
		startTerminal: () => state.terminal.push("start"),
		exit: () => {
			state.exited = true;
		},
		now: () => state.clock,
	});
	return { input, editor, state };
}

/** The user prompts the transcript holds, newest last. */
function userPrompts(view: DurableView): string[] {
	return view.conversation.entries.flatMap((entry) => {
		const message = entry.model?.[0];
		if (entry.kind !== "nyan.user" || message?.role !== "user") return [];
		return typeof message.content === "string"
			? [message.content]
			: [message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")];
	});
}

/** A faux answer the test holds back, so the conversation stays busy while it queues input. */
function gate(): { readonly step: () => Promise<AssistantMessage>; release(): void } {
	let release = (): void => {};
	const step = () =>
		new Promise<AssistantMessage>((resolve) => {
			release = () => resolve(fauxAssistantMessage([fauxText("released")]));
		});
	return { step, release: () => release() };
}

describe("durable TUI input actions", () => {
	const harness = new TuiHarness();

	beforeEach(async () => {
		await harness.start();
	});

	afterEach(async () => {
		await harness.stop();
		vi.unstubAllEnvs();
	});

	test("a submitted prompt reaches the session and the editor history", async () => {
		const owner = await harness.open(["first"]);
		const { input, editor, state } = testInput(owner);

		await input.submit("  hello  ", "steer");

		await vi.waitFor(() => expect(userPrompts(owner.current.view.current())).toEqual(["hello"]));
		expect(editor.history).toEqual(["hello"]);
		expect(state.notices).toEqual([]);
	});

	test("a line the TUI answers as a command is never sent to the model", async () => {
		const owner = await harness.open(["first"]);
		const { input, editor, state } = testInput(owner);
		const answered: string[] = [];
		state.runCommand = (text) => {
			answered.push(text);
			return true;
		};

		await input.submit("/settings", "steer");

		expect(answered).toEqual(["/settings"]);
		expect(editor.history).toEqual(["/settings"]);
		expect(userPrompts(owner.current.view.current())).toEqual([]);
	});

	test("an empty line is neither submitted nor remembered", async () => {
		const owner = await harness.open(["first"]);
		const { input, editor } = testInput(owner);

		await input.submit("   \n ", "followUp");

		expect(editor.history).toEqual([]);
		expect(userPrompts(owner.current.view.current())).toEqual([]);
	});

	test("an extension command takes the line before the model sees it", async () => {
		const owner = await harness.open(["first"]);
		const { input, editor, state } = testInput(owner);
		const asked: string[] = [];
		state.dispatchExtension = async (text) => {
			asked.push(text);
			return true;
		};

		await input.submit("/deploy staging", "steer");

		expect(asked).toEqual(["/deploy staging"]);
		expect(editor.history).toEqual(["/deploy staging"]);
		expect(userPrompts(owner.current.view.current())).toEqual([]);
	});

	test("the model cycle walks the scoped set forward and wraps backward", async () => {
		const owner = await harness.open(undefined, {
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		});
		const { input, state } = testInput(owner);
		state.scoped = ["faux/faux-1", "faux/faux-2", "faux/faux-3"];

		await input.cycleModel("forward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-2");

		await input.cycleModel("forward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-3");

		await input.cycleModel("forward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-1");

		await input.cycleModel("backward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-3");
		expect(state.notices).toEqual([]);
	});

	test("a cycle skips a scoped model that is not available and works without a scope", async () => {
		const owner = await harness.open(undefined, {
			models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		});
		const { input, state } = testInput(owner);
		// The pattern resolved to nothing, so it holds no model to cycle to.
		state.scoped = ["other/missing", "faux/faux-1", "faux/faux-3"];

		await input.cycleModel("forward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-3");

		state.scoped = null;
		await input.cycleModel("forward");
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-1");
		expect(state.notices).toEqual([]);
	});

	test("a cycle of one model reports it and stays", async () => {
		const owner = await harness.open(undefined, { models: [{ id: "faux-1" }, { id: "faux-2" }] });
		const { input, state } = testInput(owner);
		state.scoped = ["faux/faux-1"];

		await input.cycleModel("forward");

		expect(state.notices).toEqual(["info: Only one model in scope"]);
		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-1");
	});

	test("a cycle applies the level the next model starts at, and reports the source to extensions", async () => {
		const selections: string[] = [];
		const recorder: InlineExtension = (pi: ExtensionAPI) => {
			pi.on("model_select", (event) => {
				selections.push(`${event.source}:${event.model.id}`);
			});
		};
		const owner = await harness.open(undefined, {
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: true },
			],
			extraFactories: [recorder],
		});
		const settings = owner.current.settings;
		settings.setModelThinkingLevel("faux", "faux-2", "high");
		const { input, state } = testInput(owner);
		state.scoped = ["faux/faux-1", "faux/faux-2"];

		await input.cycleModel("forward");

		expect(agentOf(owner.current.view.current().conversation).model?.modelId).toBe("faux-2");
		expect(agentOf(owner.current.view.current().conversation).thinkingLevel).toBe("high");
		await vi.waitFor(() => expect(selections).toEqual(["cycle:faux-2"]));
	});

	test("choosing a model from the picker reports a set, as legacy distinguishes it", async () => {
		const selections: string[] = [];
		const recorder: InlineExtension = (pi: ExtensionAPI) => {
			pi.on("model_select", (event) => {
				selections.push(`${event.source}:${event.model.id}`);
			});
		};
		const owner = await harness.open(undefined, {
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			extraFactories: [recorder],
		});

		await owner.current.controller.setModel({ provider: "faux", modelId: "faux-2" });

		await vi.waitFor(() => expect(selections).toEqual(["set:faux-2"]));
	});

	test("dequeue withdraws the queue and puts it above the editor's draft", async () => {
		const held = gate();
		const owner = await harness.open([], { steps: [held.step] });
		const { input, editor, state } = testInput(owner);
		// The run holds the conversation, so the two lines below wait for a boundary.
		void input.submit("change direction", "steer");
		await vi.waitFor(async () =>
			expect(await owner.current.sessionOps.queueTexts()).toEqual({ steering: [], followUp: [] }),
		);
		void input.submit("look left", "steer");
		void input.submit("summarize", "followUp");
		await vi.waitFor(async () =>
			expect(await owner.current.sessionOps.queueTexts()).toEqual({
				steering: ["look left"],
				followUp: ["summarize"],
			}),
		);
		editor.setText("draft");

		await input.dequeue();

		expect(editor.text).toBe("look left\n\nsummarize\n\ndraft");
		expect(await owner.current.sessionOps.queueTexts()).toEqual({ steering: [], followUp: [] });
		expect(state.notices).toEqual(["info: Restored 2 queued messages to editor"]);
		held.release();
	});

	test("dequeue with nothing queued says so and keeps the draft", async () => {
		const owner = await harness.open(["first"]);
		const { input, editor, state } = testInput(owner);
		editor.setText("draft");

		await input.dequeue();

		expect(editor.text).toBe("draft");
		expect(state.notices).toEqual(["info: No queued messages to restore"]);
	});

	test("a pasted file list becomes paths, spaced from the text around them", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		editor.setText("look at");
		state.readClipboard = async () => ({ kind: "files", paths: ["/tmp/a b.png", "/tmp/c.png"] });

		await input.paste();

		expect(editor.text).toBe("look at /tmp/a b.png\n/tmp/c.png");
		expect(state.notices).toEqual([]);
	});

	test("a pasted image is written beside the paste and inserted as its path", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		state.readClipboard = async () => ({ kind: "image", bytes, extension: "png" });

		await input.paste();

		expect(editor.inserted).toHaveLength(1);
		const path = editor.inserted[0] ?? "";
		expect(path.endsWith(".png")).toBe(true);
		expect([...readFileSync(path)]).toEqual([...bytes]);
		rmSync(path, { force: true });
	});

	test("a pasted file path with a control character is refused", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		state.readClipboard = async () => ({ kind: "files", paths: ["/tmp/evil\u0007.png"] });

		await input.paste();

		expect(editor.inserted).toEqual([]);
		expect(state.notices).toEqual([
			"error: Failed to paste from clipboard: Clipboard file path contains control characters",
		]);
	});

	test("an empty clipboard changes nothing", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);

		await input.paste();

		expect(editor.inserted).toEqual([]);
		expect(state.notices).toEqual([]);
	});

	test("the copy key copies the newest answer, and says so when there is none", async () => {
		const owner = await harness.open(["the answer"]);
		const { input, state } = testInput(owner);

		await input.copyAnswer();
		expect(state.copied).toEqual([]);
		expect(state.notices).toEqual(["error: No agent messages to copy yet."]);

		await owner.current.controller.submit("hi", "steer");
		await vi.waitFor(() =>
			expect(
				owner.current.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.assistant").length,
			).toBe(1),
		);
		await input.copyAnswer();
		expect(state.copied).toEqual(["the answer"]);
		expect(state.notices).toEqual([
			"error: No agent messages to copy yet.",
			"info: Copied last agent message to clipboard",
		]);
	});

	test("the thinking toggle hides the blocks and stores the choice", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);

		input.toggleThinking();
		expect(editor.hidden).toBe(true);
		expect(owner.current.settings.getHideThinkingBlock()).toBe(true);
		expect(state.notices).toEqual(["info: Thinking blocks: hidden"]);

		input.toggleThinking();
		expect(editor.hidden).toBe(false);
		expect(owner.current.settings.getHideThinkingBlock()).toBe(false);
		expect(state.notices).toEqual(["info: Thinking blocks: hidden", "info: Thinking blocks: visible"]);
	});

	test("the external editor replaces the prompt with its file and hands the terminal back", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nyan-external-editor-"));
		const script = join(directory, "edit.mjs");
		writeFileSync(script, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "edited\\n");\n');
		vi.stubEnv("VISUAL", `node ${script}`);
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		editor.setText("draft");

		try {
			await input.openExternalEditor();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}

		expect(editor.text).toBe("edited");
		expect(state.terminal).toEqual(["stop", "start"]);
	});

	test("the first interrupt clears the editor and the second one exits", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		editor.setText("a half-written prompt");

		input.interrupt();
		expect(editor.text).toBe("");
		expect(state.exited).toBe(false);

		state.clock += 499;
		input.interrupt();
		expect(state.exited).toBe(true);
	});

	test("two interrupts further apart than the window only clear the editor", async () => {
		const owner = await harness.open();
		const { input, editor, state } = testInput(owner);
		editor.setText("a half-written prompt");

		input.interrupt();
		state.clock += 500;
		editor.setText("a half-written prompt");
		input.interrupt();

		expect(editor.text).toBe("");
		expect(state.exited).toBe(false);
	});

	test("an extension shortcut reaches its handler, and a free key is left to the editor", async () => {
		const seen: string[] = [];
		const extensions: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerShortcut("f5", {
				description: "Record the session's directory",
				handler: async (ctx) => {
					seen.push(ctx.cwd);
				},
			});
			pi.registerShortcut("f6", {
				description: "Fail on purpose",
				handler: async () => {
					throw new Error("boom");
				},
			});
		};
		const owner = await harness.open(undefined, { extraFactories: [extensions] });
		const { input, state } = testInput(owner);

		expect(input.extensionShortcut("x")).toBe(false);
		expect(input.extensionShortcut("\x1b[15~")).toBe(true);
		await vi.waitFor(() => expect(seen).toEqual([harness.cwd]));

		expect(input.extensionShortcut("\x1b[17~")).toBe(true);
		await vi.waitFor(() => expect(state.notices).toEqual(["error: Shortcut handler error: boom"]));
	});
});

describe("nextModelInCycle", () => {
	test.each([
		{ order: [], current: undefined, direction: "forward", expected: undefined },
		{ order: ["faux/a"], current: "faux/a", direction: "forward", expected: undefined },
		{ order: ["faux/a", "faux/b"], current: "faux/a", direction: "forward", expected: "faux/b" },
		{ order: ["faux/a", "faux/b"], current: "faux/a", direction: "backward", expected: "faux/b" },
		{ order: ["faux/a", "faux/b", "faux/c"], current: "faux/c", direction: "forward", expected: "faux/a" },
		{ order: ["faux/a", "faux/b", "faux/c"], current: "faux/b", direction: "backward", expected: "faux/a" },
		{ order: ["faux/a", "faux/b", "faux/c"], current: "other/x", direction: "forward", expected: "faux/b" },
	] as const)("$direction from $current in $order is $expected", ({ order, current, direction, expected }) => {
		expect(nextModelInCycle(order, current, direction)).toBe(expected);
	});
});
