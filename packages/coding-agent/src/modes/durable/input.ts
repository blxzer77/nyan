import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, clampThinkingLevel, type Model, type ModelThinkingLevel } from "@ny4n/ai";
import { type KeyId, matchesKey } from "@ny4n/tui";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import { agentOf, type DurableController, type DurableView, type Notice } from "../../core/durable/runtime.ts";
import type { DurableSessionOps } from "../../core/durable/session-ops.ts";
import type { ExtensionRunner, ExtensionShortcut } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { readClipboardFilePaths, readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { editInExternalEditor } from "../interactive/external-editor.ts";

/** What the system clipboard held, in the order a paste prefers: copied files, then an image, then text. */
export type ClipboardPaste =
	| { readonly kind: "files"; readonly paths: readonly string[] }
	| { readonly kind: "image"; readonly bytes: Uint8Array; readonly extension: string }
	| { readonly kind: "text"; readonly text: string };

/**
 * Read the system clipboard in the order a paste prefers: copied files, then an image, then text. Undefined when it
 * held none of them, so a paste changes nothing.
 */
export async function readClipboardPaste(): Promise<ClipboardPaste | undefined> {
	const paths = await readClipboardFilePaths();
	if (paths !== null) return { kind: "files", paths };
	const image = await readClipboardImage();
	if (image !== null) {
		return { kind: "image", bytes: image.bytes, extension: extensionForImageMimeType(image.mimeType) ?? "png" };
	}
	const text = await readClipboardText();
	return text === null ? undefined : { kind: "text", text };
}

/**
 * The editor buffer the input actions read and write, and the transcript they show or hide. It is a port rather than the
 * editor itself, so the actions run without a terminal.
 */
export interface DurableEditorPort {
	/** The text with any paste markers expanded, as a prompt would read it. */
	getText(): string;
	setText(text: string): void;
	/** Insert at the cursor. */
	insertText(text: string): void;
	/** Where `insertText` inserts, for the spaces a pasted path needs beside it. */
	cursor(): { readonly line: number; readonly col: number };
	/** Browse a submitted line with the history keys. */
	addToHistory(text: string): void;
	/** Show or hide thinking blocks, also for the messages rendered after this call. */
	setThinkingHidden(hidden: boolean): void;
}

/** The open session one input action runs against. A reopen replaces every member. */
export interface DurableInputSession {
	readonly view: DurableView;
	readonly controller: DurableController;
	readonly sessionOps?: DurableSessionOps;
}

export interface DurableInputHost {
	current(): DurableInputSession;
	readonly settings: SettingsManager;
	readonly modelRuntime?: ModelRuntime;
	/** The models `/model` lists; the cycle walks the same set. Null is every model the session can use. */
	getScopedModels(): readonly string[] | null;
	readonly editor: DurableEditorPort;
	readonly keybindings: KeybindingsManager;
	/** The extensions whose shortcuts the editor dispatches. Absent when none are loaded. */
	readonly extensionRunner?: ExtensionRunner;
	notify(message: string, type?: Notice["level"]): void;
	/** Answer a line as a command of this TUI; true when it was one, and nothing goes to the model. */
	runCommand(text: string): boolean;
	/** Offer a line to an extension command; true when one took it. */
	dispatchExtension(text: string): Promise<boolean>;
	/** Read the system clipboard. */
	readClipboard?(): Promise<ClipboardPaste | undefined>;
	/** Write text to the system clipboard. */
	copyText(text: string): Promise<void>;
	/** Leave the terminal for an external editor or a suspension. */
	stopTerminal(): void;
	startTerminal(): void;
	exit(): void;
	/** The clock the two-press exit measures; injectable so a test does not have to wait. */
	now?(): number;
}

/** Two ctrl+c presses within this window exit; the first one only clears the editor. */
const EXIT_WINDOW_MS = 500;

/**
 * The editor's input actions: what a submitted line does, what the input keybindings do, and what an extension shortcut
 * does. It holds no terminal objects, so a test drives it against a real session.
 */
export class DurableInput {
	readonly #host: DurableInputHost;
	#lastInterrupt = 0;
	/** The shortcuts of the runner they were resolved for; a reopen or a reload brings a new runner. */
	#shortcuts: { readonly runner: ExtensionRunner; readonly keys: Map<KeyId, ExtensionShortcut> } | undefined;

	constructor(host: DurableInputHost) {
		this.#host = host;
	}

	/**
	 * Submit one line: a command of this TUI, an extension command, or a prompt. The line enters the editor history
	 * before anything looks at it, as legacy adds it on every submit, so a command can be recalled too.
	 */
	async submit(text: string, whenBusy: "steer" | "followUp"): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		this.#host.editor.addToHistory(trimmed);
		if (this.#host.runCommand(trimmed)) return;
		if (await this.#host.dispatchExtension(trimmed)) return;
		try {
			await this.#host.current().controller.submit(trimmed, whenBusy);
		} catch (error) {
			this.#host.notify(`Failed to submit: ${messageOf(error)}`, "error");
		}
	}

	/** Cycle to the next model of the scoped set, as legacy `cycleModel`. */
	async cycleModel(direction: "forward" | "backward"): Promise<void> {
		const models = this.#host.modelRuntime?.getAvailableSnapshot() ?? [];
		const scoped = this.#host.getScopedModels();
		const current = agentOf(this.#host.current().view.conversation).model;
		const order = cycleOrder(
			models.map((model) => `${model.provider}/${model.id}`),
			scoped,
		);
		const nextId = nextModelInCycle(
			order,
			current === undefined ? undefined : `${current.provider}/${current.modelId}`,
			direction,
		);
		if (nextId === undefined) {
			this.#host.notify(
				scoped !== null && scoped.length > 0 ? "Only one model in scope" : "Only one model available",
			);
			return;
		}
		const next: Model<Api> | undefined = models.find((model) => `${model.provider}/${model.id}` === nextId);
		if (next === undefined) return;
		try {
			await this.#host.current().controller.setModel({ provider: next.provider, modelId: next.id }, "cycle");
			// The clamped level `setModel` left behind is only the current one when the model cannot express it; apply the
			// level this model is supposed to start at, as legacy `_getThinkingLevelForModelSwitch` does.
			const level = clampThinkingLevel(next, this.#thinkingLevelFor(next));
			const applied = agentOf(this.#host.current().view.conversation).thinkingLevel ?? "off";
			if (level !== applied) await this.#host.current().controller.setThinking(level);
		} catch (error) {
			this.#host.notify(`Could not switch model: ${messageOf(error)}`, "error");
		}
	}

	/** The thinking level switching to `model` starts at: its own default, then the global default, then the current. */
	#thinkingLevelFor(model: { readonly provider: string; readonly id: string }): ModelThinkingLevel {
		const settings = this.#host.settings;
		const current = agentOf(this.#host.current().view.conversation).thinkingLevel;
		return (
			settings.getModelThinkingLevel(model.provider, model.id) ??
			settings.getDefaultThinkingLevel() ??
			current ??
			DEFAULT_THINKING_LEVEL
		);
	}

	/**
	 * Restore every queued message to the editor, above what it holds, as legacy `app.message.dequeue`. The queue is
	 * withdrawn first: the texts come back from the session, not from a copy of the UI.
	 */
	async dequeue(): Promise<void> {
		const sessionOps = this.#host.current().sessionOps;
		if (sessionOps === undefined) {
			this.#host.notify("No queued messages to restore");
			return;
		}
		let cleared: Awaited<ReturnType<DurableSessionOps["clearQueue"]>>;
		try {
			cleared = await sessionOps.clearQueue();
		} catch (error) {
			this.#host.notify(`Could not restore queued messages: ${messageOf(error)}`, "error");
			return;
		}
		const texts = [...cleared.steering, ...cleared.followUp];
		if (texts.length === 0) {
			this.#host.notify("No queued messages to restore");
			return;
		}
		const editor = this.#host.editor;
		editor.setText([texts.join("\n\n"), editor.getText()].filter((part) => part.trim().length > 0).join("\n\n"));
		this.#host.notify(`Restored ${texts.length} queued message${texts.length > 1 ? "s" : ""} to editor`);
	}

	/**
	 * Paste from the system clipboard: copied files as their paths, an image as a temporary file, plain text as itself.
	 * Legacy's order, so a clipboard holding both files and text yields the files.
	 */
	async paste(): Promise<void> {
		try {
			const content = await this.#host.readClipboard?.();
			if (content === undefined) return;
			const editor = this.#host.editor;
			if (content.kind === "files") {
				for (const filePath of content.paths) {
					if (/\p{Cc}/u.test(filePath)) throw new Error("Clipboard file path contains control characters");
				}
				editor.insertText(spacedAtCursor(editor, content.paths.join("\n")));
			} else if (content.kind === "image") {
				// The prompt reads the image from its path, as legacy writes one beside the paste.
				const filePath = join(tmpdir(), `nyan-clipboard-${randomUUID()}.${content.extension}`);
				writeFileSync(filePath, Buffer.from(content.bytes));
				editor.insertText(filePath);
			} else editor.insertText(content.text);
		} catch (error) {
			this.#host.notify(`Failed to paste from clipboard: ${messageOf(error)}`, "error");
		}
	}

	/** Copy the newest answer, as `/copy` does; `app.message.copy` is the same text. */
	async copyAnswer(): Promise<void> {
		const text = lastAssistantText(this.#host.current().view);
		if (text === undefined) {
			this.#host.notify("No agent messages to copy yet.", "error");
			return;
		}
		try {
			await this.#host.copyText(text);
			this.#host.notify("Copied last agent message to clipboard");
		} catch (error) {
			this.#host.notify(messageOf(error), "error");
		}
	}

	/** Show or hide the transcript's thinking blocks, and store the choice for the next start. */
	toggleThinking(): void {
		const hidden = !this.#host.settings.getHideThinkingBlock();
		this.#host.settings.setHideThinkingBlock(hidden);
		this.#host.editor.setThinkingHidden(hidden);
		this.#host.notify(`Thinking blocks: ${hidden ? "hidden" : "visible"}`);
	}

	/** Edit the prompt in `externalEditor`, or the setting's command, with the terminal handed over while it runs. */
	async openExternalEditor(): Promise<void> {
		const editor = this.#host.editor;
		const content = editor.getText();
		this.#host.stopTerminal();
		try {
			const result = await editInExternalEditor({
				command: this.#host.settings.getExternalEditorCommand(),
				content,
			});
			if (result.status === "complete") editor.setText(result.content);
		} catch (error) {
			this.#host.notify(`External editor failed: ${messageOf(error)}`, "error");
		} finally {
			this.#host.startTerminal();
		}
	}

	/**
	 * ctrl+c: the first press clears the editor, and a second press within 500 ms exits, as legacy does. A cleared editor
	 * is not the end of the session, so a stray press never quits.
	 */
	interrupt(): void {
		const now = this.#host.now?.() ?? Date.now();
		if (now - this.#lastInterrupt < EXIT_WINDOW_MS) {
			this.#host.exit();
			return;
		}
		this.#lastInterrupt = now;
		this.#host.editor.setText("");
	}

	/** ctrl+z: hand the terminal back and stop this process in the background, then restore the screen on resume. */
	suspend(): void {
		if (process.platform === "win32") {
			this.#host.notify("Suspend to background is not supported on Windows");
			return;
		}
		// Keep the event loop alive while suspended: stopping the TUI can leave no referenced handle, and the process
		// would exit on `fg` before SIGCONT restores the terminal.
		const keepAlive = setInterval(() => {}, 2 ** 30);
		// Ctrl+C in the terminal reaches the backgrounded process group; it must not kill it while suspended.
		const ignoreSigint = (): void => {};
		process.on("SIGINT", ignoreSigint);
		process.once("SIGCONT", () => {
			clearInterval(keepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.#host.startTerminal();
		});
		try {
			this.#host.stopTerminal();
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(keepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.#host.notify(`Could not suspend: ${messageOf(error)}`, "error");
		}
	}

	/** Dispatch an extension shortcut; true when one took the key, so the editor does not see it. */
	extensionShortcut(data: string): boolean {
		const runner = this.#host.extensionRunner;
		if (runner === undefined) return false;
		for (const [shortcutKey, shortcut] of this.#extensionShortcuts(runner)) {
			if (!matchesKey(data, shortcutKey)) continue;
			// A handler runs beside the editor: its failure is reported, and the key is still consumed.
			Promise.resolve(shortcut.handler(runner.createContext())).catch((error: unknown) => {
				this.#host.notify(`Shortcut handler error: ${messageOf(error)}`, "error");
			});
			return true;
		}
		return false;
	}

	#extensionShortcuts(runner: ExtensionRunner): Map<KeyId, ExtensionShortcut> {
		// Resolved once per runner: extensions load once per process, and a reload opens a new one.
		const resolved = this.#shortcuts;
		if (resolved !== undefined && resolved.runner === runner) return resolved.keys;
		const keys = runner.getShortcuts(this.#host.keybindings.getEffectiveConfig());
		this.#shortcuts = { runner, keys };
		return keys;
	}
}

/** The newest assistant text of the shown conversation, as `/copy` and `app.message.copy` take it. */
export function lastAssistantText(view: DurableView): string | undefined {
	for (const entry of [...view.conversation.entries].reverse()) {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("")
			.trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/**
 * The models the cycle walks, as `provider/modelId`: the scoped set filtered to the ones available now, or every
 * available model when nothing is scoped. A pattern that resolved to nothing is not a model and is skipped.
 */
export function cycleOrder(available: readonly string[], scoped: readonly string[] | null): string[] {
	if (scoped === null) return [...available];
	return available.filter((id) => scoped.includes(id));
}

/** The model after `current` in `order`, as legacy cycles it: nothing to cycle with fewer than two. */
export function nextModelInCycle(
	order: readonly string[],
	current: string | undefined,
	direction: "forward" | "backward",
): string | undefined {
	if (order.length <= 1) return undefined;
	const found = current === undefined ? -1 : order.indexOf(current);
	const index = found === -1 ? 0 : found;
	const next = direction === "forward" ? (index + 1) % order.length : (index - 1 + order.length) % order.length;
	return order[next];
}

/** The paste text, with a space on each side that the neighbours do not already provide. */
function spacedAtCursor(editor: DurableEditorPort, text: string): string {
	const lines = editor.getText().split("\n");
	const { line, col } = editor.cursor();
	const currentLine = lines[line] ?? "";
	const before = col > 0 ? (currentLine[col - 1] ?? "") : "";
	const after = currentLine[col] ?? "";
	return `${before.length > 0 && !/\s/u.test(before) ? " " : ""}${text}${after.length > 0 && !/\s/u.test(after) ? " " : ""}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
