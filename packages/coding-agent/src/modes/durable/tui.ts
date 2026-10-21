import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@ny4n/ai";
import type {
	ConversationId,
	EntryRecord,
	InboxState,
	LiveState,
	TaskGraph,
	TaskGraphNode,
	UsageState,
} from "@ny4n/durable";
import {
	type AutocompleteProvider,
	Box,
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Markdown,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@ny4n/tui";
import { getAgentDir } from "../../config.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import { type DurableRunnableCommand, routeDurableInput } from "../../core/durable/commands.ts";
import { customMessageView } from "../../core/durable/custom-message.ts";
import { dispatchDurableExtensionCommand } from "../../core/durable/extension-commands.ts";
import type { ExtensionHost } from "../../core/durable/extension-host.ts";
import {
	agentOf,
	type DurableController,
	type DurableView,
	type DurableViewSource,
} from "../../core/durable/runtime.ts";
import type { DurableSessionOps } from "../../core/durable/session-ops.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { PromptTemplate } from "../../core/prompt-templates.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { createAllToolRenderers } from "../../core/tools/renderers/index.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { BashExecutionComponent } from "../../modes/interactive/components/bash-execution.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../../modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { InteractiveThemeController } from "../../modes/interactive/theme/theme-controller.ts";
import { DynamicBorder } from "../../ui/components/dynamic-border.ts";
import { keyText } from "../../ui/components/keybinding-hints.ts";
import {
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	SYSTEM_THEME_NAME,
	setRegisteredThemes,
	type TerminalTheme,
	type Theme,
	theme,
} from "../../ui/theme/theme.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { createDurableAutocompleteProvider, type DurableAutocompleteSources } from "./autocomplete.ts";
import { runUserBash } from "./bash.ts";
import type { DurableBugReportEnvironment } from "./bug-report.ts";
import { type DurableCommandProduct, DurableCommands, type DurableReopenRequest } from "./commands.ts";
import { type DurableFooterLabels, footerHintsLine, footerStatsLine } from "./footer.ts";
import { type DurableEditorPort, DurableInput, readClipboardPaste } from "./input.ts";
import { NoticeArea, type NoticeLevel } from "./notices.ts";
import { enabledModelIds } from "./scoped-models.ts";
import type { DurableSettingsUi } from "./settings.ts";
import { type DurableStartupResources, type ResourceSection, runDurableStartup, terminalTitleFor } from "./startup.ts";

const SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

/** A filterable list in place of the editor. */
class ListSelector extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #items: SelectItem[];
	readonly #onSelect: (value: string) => void;
	readonly #onCancel: () => void;
	#list: SelectList;
	#focused = false;

	constructor(
		title: string,
		items: SelectItem[],
		onSelect: (value: string) => void,
		onCancel: () => void,
		initialQuery?: string,
	) {
		super();
		this.#items = items;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		if (initialQuery !== undefined && initialQuery.length > 0) {
			this.#input.setValue(initialQuery);
			items = ListSelector.#filter(items, initialQuery);
		}
		this.#list = this.#build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => keybindings.matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		this.#list = this.#build(ListSelector.#filter(this.#items, this.#input.getValue()));
	}

	static #filter(items: readonly SelectItem[], query: string): SelectItem[] {
		return query.length === 0 ? [...items] : fuzzyFilter([...items], query, (item) => `${item.label} ${item.value}`);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, SELECT_THEME);
		list.onSelect = (item) => this.#onSelect(item.value);
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

class TextInputPrompt extends Container implements Focusable {
	readonly #input = new Input();
	readonly #onSubmit: (value: string) => void;
	readonly #onCancel: () => void;
	#focused = false;

	constructor(
		title: string,
		placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		if (placeholder !== undefined && placeholder.length > 0) {
			this.addChild(new Text(theme.fg("dim", placeholder), 1, 0));
		}
		this.addChild(this.#input);
		this.addChild(new Text(theme.fg("dim", "Enter to submit · Escape to cancel"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.#onCancel();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.#onSubmit(this.#input.getValue());
			return;
		}
		this.#input.handleInput(data);
	}
}

/** The summary that replaced earlier context: collapsed to one line until expanded. */
class CompactionComponent extends Box {
	readonly #summary: string;

	constructor(summary: string, expanded: boolean) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.#summary = summary;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			expanded
				? new Markdown(this.#summary, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: new Text(
						theme.fg("customMessageText", "Earlier context summarized (") +
							theme.fg("dim", keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
		);
	}
}

interface Handlers {
	submit(text: string): void;
	followUp(text: string): void;
	abort(): void;
	exit(): void;
	/** ctrl+c: clear the editor, and exit only when it is the second press in the window. */
	interrupt(): void;
	selectModel(): void;
	cycleThinking(): void;
	cycleModel(direction: "forward" | "backward"): void;
	/** Restore the queued messages to the editor. */
	dequeue(): void;
	/** Paste the clipboard into the editor at the cursor. */
	paste(): void;
	/** Copy the newest answer, as `/copy` does. */
	copyAnswer(): void;
	toggleThinking(): void;
	openExternalEditor(): void;
	suspend(): void;
	/** One key press: true when an extension shortcut took it, so the editor does not see it. */
	extensionShortcut(data: string): boolean;
}

class DurableTui {
	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();
	readonly #ui: TuiAltScreen;
	readonly #chat = new Container();
	readonly #tasks = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #footer = new Container();
	readonly #footerStats = new Text("", 1, 0);
	readonly #footerHints = new Text("", 1, 0);
	readonly #editorContainer = new Container();
	readonly #editor: CustomEditor;
	readonly #keybindings: KeybindingsManager;
	readonly #cwd: string;
	/** Padding inside output blocks, from the `outputPad` setting. */
	#outputPad: number;
	/** The models `/model` lists: the scoped set, or every model when it is null. */
	#scopedModelIds: readonly string[] | null = null;
	/** The newest card per call ID; provider call IDs may repeat across turns. */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also older ones whose call ID a later turn reused. */
	readonly #cards: ToolExecutionComponent[] = [];
	/** Call IDs whose cards the streaming answer created; its entry takes them over. */
	readonly #streamingCalls = new Set<string>();
	readonly #summaries: CompactionComponent[] = [];
	/** Tool output and summaries shown in full; toggled like nyan. */
	#expanded = false;
	/** Thinking blocks hidden; toggled by ctrl+t, and stored in the settings for the next start. */
	#hideThinking: boolean;
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";
	readonly #extensionStatuses = new Map<string, string>();
	/** The lines below the transcript: each one expires, so a session's failures do not pile up for its whole length. */
	readonly #noticeArea = new NoticeArea();
	#noticeTimer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;
	/** The newest view applied, so a footer change that arrives outside an update can redraw it. */
	#lastView: DurableView | undefined = undefined;
	/** The card of the bash command running now, if any. */
	#bash: BashExecutionComponent | undefined = undefined;
	/** The command that card runs: its `bashExecution` entry is that card, not a second one. */
	#bashCommand: string | undefined = undefined;
	/** The stored display name, shown in the footer; read from the session beside the database. */
	#sessionName: string | undefined = undefined;
	/** What the footer reads from outside the view: auto-compaction, auth, and the model catalog. */
	readonly #footerLabels: (() => DurableFooterLabels) | undefined;
	/** Set when the transcript was rebuilt: the next render repaints the screen and shows the end. */
	#rebuilt = false;
	#transcript: ScrollView;

	constructor(
		cwd: string,
		handlers: Handlers,
		outputPad = 1,
		hideThinking = false,
		footerLabels?: () => DurableFooterLabels,
	) {
		this.#cwd = cwd;
		this.#outputPad = outputPad;
		this.#hideThinking = hideThinking;
		this.#footerLabels = footerLabels;
		this.#ui = new TuiAltScreen(new ProcessTerminal(), false, getAgentDir());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#keybindings = keybindings;
		this.#editor = new CustomEditor(this.#ui, getEditorTheme(), keybindings, {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		this.#editor.onSubmit = handlers.submit;
		this.#editor.onEscape = handlers.abort;
		this.#editor.onCtrlD = handlers.exit;
		this.#editor.onPasteImage = handlers.paste;
		this.#editor.onExtensionShortcut = (data) => handlers.extensionShortcut(data);
		this.#editor.onAction("app.clear", handlers.interrupt);
		this.#editor.onAction("app.suspend", handlers.suspend);
		this.#editor.onAction("app.model.select", handlers.selectModel);
		this.#editor.onAction("app.model.cycleForward", () => handlers.cycleModel("forward"));
		this.#editor.onAction("app.model.cycleBackward", () => handlers.cycleModel("backward"));
		this.#editor.onAction("app.thinking.cycle", handlers.cycleThinking);
		this.#editor.onAction("app.thinking.toggle", handlers.toggleThinking);
		this.#editor.onAction("app.message.dequeue", handlers.dequeue);
		this.#editor.onAction("app.editor.external", handlers.openExternalEditor);
		this.#editor.onAction("app.message.copy", handlers.copyAnswer);
		this.#editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const component of [...this.#cards, ...this.#summaries]) component.setExpanded(this.#expanded);
			this.#ui.requestRender();
		});
		this.#editor.onAction("app.message.followUp", () => {
			const text = this.#editor.getText().trim();
			if (!text) return;
			this.#editor.setText("");
			handlers.followUp(text);
		});

		this.#editorContainer.addChild(this.#editor);
		this.#footer.addChild(this.#footerStats);
		this.#footer.addChild(this.#footerHints);
		// One empty line between the transcript and everything below it.
		const content = new Container();
		content.addChild(this.#chat);
		content.addChild(new Spacer(1));
		const transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		this.#transcript = transcript;
		const dock = new VStack([
			{ component: this.#tasks, shrink: 1, minSize: 0 },
			{ component: this.#queue, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#editorContainer, shrink: 1, minSize: 3 },
			{ component: this.#footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [
			this.#chat,
			this.#tasks,
			this.#queue,
			this.#notices,
			this.#editorContainer,
			this.#footer,
		]) {
			this.#ui.addChild(component);
		}
		this.#ui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.#ui.setFocus(this.#editor);
	}

	get ui(): TuiAltScreen {
		return this.#ui;
	}

	start(): void {
		this.#ui.start();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
		this.#noticeTimer = undefined;
		this.#discardTools();
		this.#indicator?.dispose();
		this.#ui.stop();
	}

	createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.#select(title, options, opts),
			confirm: (title, message, opts) =>
				this.#select(`${title}\n${message}`, ["Yes", "No"], opts).then((value) => value === "Yes"),
			input: (title, placeholder, opts) => this.#inputPrompt(title, placeholder, opts),
			notify: (message, type = "info") => this.notify(message, type),
			onTerminalInput: () => () => {},
			setStatus: (key, text) => {
				if (text === undefined) this.#extensionStatuses.delete(key);
				else this.#extensionStatuses.set(key, text);
				this.#ui.requestRender();
			},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (_key: string, _content: unknown, _options?: ExtensionWidgetOptions) => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => this.#ui.terminal.setTitle(title),
			custom: async () => {
				throw new Error("Extension custom UI components are not available on the durable TUI yet");
			},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not available on the durable TUI yet" }),
			getToolsExpanded: () => this.#expanded,
			setToolsExpanded: (expanded) => {
				this.#expanded = expanded;
				for (const component of [...this.#cards, ...this.#summaries]) component.setExpanded(expanded);
				this.#ui.requestRender();
			},
		};
	}

	#select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: string | undefined): void => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.restoreEditor();
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			if (opts?.signal?.aborted) return finish(undefined);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) timeout = setTimeout(() => finish(undefined), opts.timeout);
			this.mount(
				new ListSelector(
					title,
					options.map((value) => ({ value, label: value })),
					finish,
					() => finish(undefined),
				),
			);
		});
	}

	#inputPrompt(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: string | undefined): void => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.restoreEditor();
				resolve(value);
			};
			const onAbort = () => finish(undefined);
			if (opts?.signal?.aborted) return finish(undefined);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) timeout = setTimeout(() => finish(undefined), opts.timeout);
			this.mount(new TextInputPrompt(title, placeholder, finish, () => finish(undefined)));
		});
	}

	/** The display name the footer shows, from the session beside the database; the terminal title follows it. */
	setSessionName(name: string | undefined): void {
		this.#sessionName = name;
		this.setTitle(terminalTitleFor(this.#cwd, name));
		this.refreshFooter();
	}

	/** Redraw the footer, after something outside the view changed what it shows, such as auto-compaction. */
	refreshFooter(): void {
		if (this.#lastView !== undefined) this.#syncFooter(this.#lastView);
		this.#ui.requestRender();
	}

	/** The terminal title, as legacy sets it from the session name and the directory. */
	setTitle(title: string): void {
		this.#ui.terminal.setTitle(title);
	}

	/** A warning line in the transcript, as legacy `showWarning`. */
	showWarning(message: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("warning", `Warning: ${message}`), 1, 0));
		this.#showEnd();
	}

	/** A bordered notice with a title and body lines, as legacy's update notices. */
	showNoticeCard(title: string, lines: readonly string[]): void {
		const border = (text: string) => theme.fg("warning", text);
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new DynamicBorder(border));
		this.#chat.addChild(new Text(theme.bold(theme.fg("warning", title)), 1, 0));
		for (const line of lines) this.#chat.addChild(new Text(theme.fg("muted", line), 1, 0));
		this.#chat.addChild(new DynamicBorder(border));
		this.#showEnd();
	}

	/** The changelog after an update: the new sections, or the condensed line when `collapsed`. */
	showChangelog(markdown: string, latestVersion: string, collapsed: boolean): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new DynamicBorder());
		if (collapsed) {
			this.#chat.addChild(
				new Text(`Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`, 1, 0),
			);
		} else {
			this.#chat.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new Markdown(markdown.trim(), 1, 0, getMarkdownTheme()));
		}
		this.#chat.addChild(new DynamicBorder());
		this.#showEnd();
	}

	/** The loaded-resources listing: a `[Name]` line per kind, then its items. */
	showResources(sections: readonly ResourceSection[]): void {
		this.#chat.addChild(new Spacer(1));
		for (const section of sections) {
			this.#chat.addChild(new Text(theme.fg("accent", `[${section.name}]`), 1, 0));
			this.#chat.addChild(new TruncatedText(theme.fg("dim", `  ${section.items.join(", ")}`), 1, 0));
		}
		this.#showEnd();
	}

	/** Show what was just added to the transcript: repaint and follow its end. */
	#showEnd(): void {
		this.#transcript.scrollToEnd();
		this.#ui.requestRender(true);
	}

	/** A filterable list in place of the editor; undefined when the user cancelled. */
	choose(title: string, items: readonly SelectItem[], description?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: string | undefined): void => {
				if (settled) return;
				settled = true;
				this.restoreEditor();
				resolve(value);
			};
			const heading = description === undefined ? title : `${title}\n${theme.fg("dim", description)}`;
			this.mount(new ListSelector(heading, [...items], finish, () => finish(undefined)));
		});
	}

	/** One line of text in place of the editor, with `description` above it; undefined when cancelled. */
	askText(title: string, description: string): Promise<string | undefined> {
		return this.#inputPrompt(title, description);
	}

	/** Add lines to the transcript, after the messages a command answers with. */
	showLines(lines: readonly string[]): void {
		this.#chat.addChild(new Spacer(1));
		for (const line of lines) this.#chat.addChild(new Text(theme.fg("muted", line), 1, 0));
		this.#rebuilt = true;
		this.#ui.requestRender(true);
	}

	/** Start a bash card for a command that is about to run. */
	startBash(command: string, excludeFromContext: boolean): void {
		this.#bash?.setComplete(undefined, true);
		const component = new BashExecutionComponent(command, this.#ui, excludeFromContext, this.#outputPad);
		this.#bash = component;
		this.#bashCommand = command;
		this.#chat.addChild(component);
		this.#ui.requestRender();
	}

	/** Finish the running card with the command's result, as legacy's card does. */
	finishBash(result: BashResult): void {
		this.#bash?.setComplete(
			result.exitCode,
			result.cancelled,
			result.truncated ? { truncated: true } : undefined,
			result.fullOutputPath,
		);
		// The card stays until its `bashExecution` entry arrives: the entry is drawn as this card, not beside it.
		this.#ui.requestRender();
	}

	/** Append streamed output to the running card and redraw. */
	appendBash(chunk: string): void {
		this.#bash?.appendOutput(chunk);
		this.#ui.requestRender();
	}

	/** Drop the running card without a result: the command never ran, so nothing stays on screen claiming it does. */
	abandonBash(): void {
		const component = this.#bash;
		this.#bash = undefined;
		this.#bashCommand = undefined;
		if (component !== undefined) {
			// The loader ticks on its own timer until a result stops it, and a card left behind keeps spinning.
			component.setComplete(undefined, true);
			this.#chat.removeChild(component);
		}
		this.#ui.requestRender();
	}

	/** Add rendered markdown to the transcript, as `/changelog` does. */
	showMarkdown(markdown: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
		this.#rebuilt = true;
		this.#ui.requestRender(true);
	}

	/** The models `/model` lists and cycles through; null is every model the session can use. */
	get scopedModelIds(): readonly string[] | null {
		return this.#scopedModelIds;
	}

	setScopedModelIds(ids: readonly string[] | null): void {
		this.#scopedModelIds = ids;
	}

	get keybindings(): KeybindingsManager {
		return this.#keybindings;
	}

	/** The settings a running TUI can apply at once; the rest of a setting takes effect where it applies. */
	createSettingsUi(hooks: {
		readonly themeSelection: () => string;
		readonly terminalTheme: () => TerminalTheme;
		readonly setTheme: (setting: string) => void;
		readonly previewTheme: (setting: string) => void;
	}): DurableSettingsUi {
		return {
			themeSelection: hooks.themeSelection,
			terminalTheme: hooks.terminalTheme,
			setTheme: hooks.setTheme,
			previewTheme: hooks.previewTheme,
			setOutputPad: (padding) => {
				this.#outputPad = padding;
				for (const card of this.#cards) card.setOutputPad(padding);
				this.#bash?.setOutputPad(padding);
				this.#ui.requestRender();
			},
			setEditorPaddingX: (padding) => this.#editor.setPaddingX(padding),
			setAutocompleteMaxVisible: (maxVisible) => this.#editor.setAutocompleteMaxVisible(maxVisible),
			setShowImages: (show) => {
				for (const card of this.#cards) card.setShowImages(show);
				this.#ui.requestRender();
			},
			setImageWidthCells: (width) => {
				for (const card of this.#cards) card.setImageWidthCells(width);
				this.#ui.requestRender();
			},
			setHardwareCursor: (enabled) => this.#ui.setShowHardwareCursor(enabled),
			setClearOnShrink: (enabled) => this.#ui.setClearOnShrink(enabled),
			setScrollbar: (mode) => {
				this.#transcript.setScrollbar(mode);
				this.#ui.requestRender();
			},
			setCopyOnSelect: (enabled) => this.#ui.setCopyOnSelect(enabled),
			setWheelScrollLines: (lines) => this.#ui.setWheelScrollLines(lines),
		};
	}

	/** Show or hide the thinking blocks of every message, and of the ones rendered later. */
	setThinkingHidden(hidden: boolean): void {
		this.#hideThinking = hidden;
		for (const child of this.#chat.children) {
			if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(hidden);
		}
		this.#ui.requestRender();
	}

	/** The editor as the input actions read and write it: their only view of the terminal. */
	createEditorPort(): DurableEditorPort {
		return {
			getText: () => this.#editor.getExpandedText(),
			setText: (text) => {
				this.#editor.setText(text);
				this.#ui.requestRender();
			},
			insertText: (text) => {
				this.#editor.insertTextAtCursor(text);
				this.#ui.requestRender();
			},
			cursor: () => this.#editor.getCursor(),
			addToHistory: (text) => this.#editor.addToHistory(text),
			setThinkingHidden: (hidden) => this.setThinkingHidden(hidden),
		};
	}

	/** The editor's `/` commands and `@` paths; a reopen or a reload replaces the commands they come from. */
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#editor.setAutocompleteProvider(provider);
	}

	/** How many completion rows the editor shows at once; the `autocompleteMaxVisible` setting. */
	setAutocompleteMaxVisible(maxVisible: number): void {
		this.#editor.setAutocompleteMaxVisible(maxVisible);
	}

	/** Reload keybindings and repaint, after a `/reload` replaced the files they come from. */
	reloadBindings(): void {
		this.#keybindings.reload();
		setKeybindings(this.#keybindings);
		this.#ui.requestRender(true);
	}

	/** Start again in another session: its entries, names, and notices are not the ones shown before. */
	resetSessionView(): void {
		this.#noticeArea.reset();
		this.#extensionStatuses.clear();
		this.#sessionName = undefined;
		this.#statusText = "";
		this.#rebuild([]);
		this.#renderNotices();
	}

	/** Show a line in the notice area: an answer the TUI gives itself, such as a command it cannot run. */
	notify(message: string, type: NoticeLevel = "info"): void {
		this.#noticeArea.push(type, message, Date.now());
		this.#scheduleNoticeExpiry();
		this.#renderNotices();
		this.#ui.requestRender();
	}

	/** Finish every card: a running bash card keeps a timer until it gets a final result. */
	#discardTools(): void {
		for (const component of this.#cards) component.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
	}

	mount(component: Component, focus: Component = component): void {
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(focus);
		this.#ui.requestRender();
	}

	restoreEditor(): void {
		this.mount(this.#editor);
	}

	apply(view: DurableView): void {
		this.#lastView = view;
		const live = (view.conversation.docs["nyan.live"] ?? {}) as LiveState;
		this.#syncTranscript(view.conversation.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		// A partial without its entry was dropped, for example by a retry: render the transcript again.
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(view.conversation.entries);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.#tool(slot.name, slot.callId);
			component.setArgsComplete();
			if (slot.status !== "running") continue;
			component.markExecutionStarted();
			const child = (slot.details as { conversationId?: number } | undefined)?.conversationId;
			if (slot.output === undefined && child !== undefined) {
				const text = `Subagent ${child} is working. /agents switches to it.`;
				component.updateResult({ content: [{ type: "text", text }], details: slot.details, isError: false }, true);
			} else if (slot.output !== undefined) {
				component.updateResult(
					{ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false },
					true,
				);
			}
		}
		this.#syncTasks(view.tasks);
		this.#syncQueue((view.conversation.docs["nyan.inbox"] ?? { items: [] }) as InboxState);
		this.#syncNotices(view);
		this.#editor.borderColor = theme.getThinkingBorderColor(agentOf(view.conversation).thinkingLevel ?? "off");
		this.#syncStatus(live);
		this.#syncFooter(view);
		if (this.#rebuilt) this.#transcript.scrollToEnd();
		this.#ui.requestRender(this.#rebuilt);
		this.#rebuilt = false;
	}

	#syncTasks(graph: TaskGraph | undefined): void {
		this.#tasks.clear();
		if (graph === undefined) return;
		const nodes = Object.values(graph.tasks);
		const lines: string[] = [theme.fg("accent", `Tasks (${nodes.length} live, /tasks to hide)`)];
		// A conversation-owned task sits under the task that owns its conversation, when that task is live.
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const children = (node: TaskGraphNode) =>
			nodes.filter(
				(candidate) =>
					candidate.owner === node.id ||
					(candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
			);
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) {
			if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		}
		for (const line of lines) this.#tasks.addChild(new TruncatedText(theme.fg("muted", line), 1, 0));
	}

	#syncQueue(inbox: InboxState): void {
		this.#queue.clear();
		for (const item of inbox.items) {
			const text =
				item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${item.mode}] ${text}`), 1, 0));
		}
	}

	#syncNotices(view: DurableView): void {
		this.#noticeArea.adopt(view.notices, Date.now());
		this.#scheduleNoticeExpiry();
		this.#renderNotices();
	}

	#renderNotices(): void {
		this.#notices.clear();
		for (const item of this.#noticeArea.visible(Date.now())) {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			this.#notices.addChild(new TruncatedText(theme.fg(color, item.message), 1, 0));
		}
	}

	/**
	 * One redraw when the oldest shown line expires. A redraw of the transcript does not restart the countdown, and a
	 * stopped TUI schedules nothing; the timer is unref'd so a notice cannot keep the process alive after the exit.
	 */
	#scheduleNoticeExpiry(): void {
		if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
		this.#noticeTimer = undefined;
		if (this.#stopped) return;
		const next = this.#noticeArea.nextExpiry(Date.now());
		if (next === undefined) return;
		const timer = setTimeout(
			() => {
				this.#noticeTimer = undefined;
				this.#scheduleNoticeExpiry();
				this.#renderNotices();
				this.#ui.requestRender();
			},
			Math.max(0, next - Date.now()),
		);
		(timer as { unref?: () => void }).unref?.();
		this.#noticeTimer = timer;
	}

	#syncStatus(live: LiveState): void {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) {
			text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		} else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry
				? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
				: `Compacting (${compaction.reason})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = text
			? new WorkingStatusIndicator(this.#ui, text, undefined, (part) => this.#editor.borderColor(part))
			: undefined;
		this.#editor.setWorkingStatusIndicator(this.#indicator);
	}

	#syncFooter(view: DurableView): void {
		const agent = agentOf(view.conversation);
		const usage = totalUsage((view.conversation.docs["nyan.usage"] ?? { models: {}, tools: {} }) as UsageState);
		const contextWindow =
			view.models.find((model) => model.provider === agent.model?.provider && model.modelId === agent.model.modelId)
				?.contextWindow ?? 0;
		const tokens = contextWindow > 0 ? contextTokens(view.conversation.entries) : undefined;
		const labels = this.#footerLabels?.();
		const shown = view.conversations.find((candidate) => candidate.id === view.conversation.conversation.id);
		const input = {
			cwd: view.session.cwd,
			home: process.env.HOME || process.env.USERPROFILE,
			sessionName: this.#sessionName,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost.total,
			},
			provider: agent.model?.provider,
			modelId: agent.model?.modelId,
			reasoning: labels?.reasoning === true,
			thinkingLevel: agent.thinkingLevel ?? "off",
			routedModel: labels?.routedModel,
			subscription: labels?.subscription === true,
			providerCount: labels?.providerCount ?? 1,
			contextWindow,
			contextPercent: tokens === undefined ? undefined : (tokens / contextWindow) * 100,
			autoCompaction: labels?.autoCompaction === true,
			conversationLabel: shown?.label ?? `conversation ${view.conversation.conversation.id}`,
			extensionStatuses: [...this.#extensionStatuses.values()],
		};
		this.#footerStats.setText(footerStatsLine(input));
		this.#footerHints.setText(footerHintsLine(input));
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		// Compaction and resets replace the head of the active transcript.
		if (this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.#chat.clear();
		// The transcript is rebuilt from entries, so the live bash card is no longer part of it.
		this.#bash = undefined;
		this.#bashCommand = undefined;
		this.#discardTools();
		this.#summaries.length = 0;
		this.#rebuilt = true;
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "nyan.user" && message?.role === "user") {
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new UserMessageComponent(userText(message.content)));
		} else if (entry.kind === "nyan.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent(undefined, this.#hideThinking);
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				// Only cards the stream already showed are kept for calls that never run.
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "nyan.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "nyan.compaction") {
			const summary = new CompactionComponent(
				message?.role === "user" ? userText(message.content) : "",
				this.#expanded,
			);
			this.#summaries.push(summary);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(summary);
		} else if (entry.kind === "bashExecution") {
			// The card of the command that just ran is already in the transcript; its entry is not a second card.
			if (this.#bash !== undefined && this.#bashCommand === bashCommandOf(entry)) {
				// This card already shows the command and its result: clear the marker so the entry is not drawn again.
				this.#bash = undefined;
				this.#bashCommand = undefined;
				return;
			}
			const data = (entry.data ?? {}) as {
				readonly command?: string;
				readonly output?: string;
				readonly exitCode?: number | null;
				readonly cancelled?: boolean;
				readonly truncated?: boolean;
				readonly excludeFromContext?: boolean;
				readonly fullOutputPath?: string;
			};
			const card = new BashExecutionComponent(
				data.command ?? "",
				this.#ui,
				data.excludeFromContext === true,
				this.#outputPad,
			);
			card.setExpanded(this.#expanded);
			if (data.output !== undefined) card.appendOutput(data.output);
			card.setComplete(
				data.exitCode ?? undefined,
				data.cancelled === true,
				data.truncated === true ? { truncated: true } : undefined,
				data.fullOutputPath,
			);
			this.#chat.addChild(card);
		} else if (entry.kind === "nyan.reset") this.#addText("[new context]");
		else if (entry.kind === "custom_message") {
			const view = customMessageView(entry);
			if (view !== undefined)
				this.#addText(view.text === "" ? `[${view.customType}]` : `[${view.customType}] ${view.text}`);
		}
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent(undefined, this.#hideThinking);
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	#addText(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("muted", text), 1, 0));
	}

	/** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
	#tool(name: string, callId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(callId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			name,
			callId,
			args ?? {},
			{},
			DurableTui.#renderers[name],
			this.#ui,
			this.#cwd,
		);
		component.setExpanded(this.#expanded);
		this.#chat.addChild(component);
		this.#cards.push(component);
		this.#tools.set(callId, component);
		return component;
	}
}

/** The command a `bashExecution` entry recorded. */
function bashCommandOf(entry: EntryRecord): string | undefined {
	const data = entry.data as { readonly command?: unknown } | undefined;
	return typeof data?.command === "string" ? data.command : undefined;
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		state.status === "waiting"
			? `waiting on ${state.on.join(", ")}`
			: state.status === "completing"
				? `completing (${state.outcome})`
				: `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** Context size from the newest successful answer after the newest compaction; unknown before one. */
function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	// Kept entries follow the summary in the view but are older than it; only later answers measure the new context.
	const compacted = Math.max(
		0,
		...entries.filter((entry) => entry.kind === "nyan.compaction").map((entry) => entry.id),
	);
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "nyan.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return undefined;
}

/** The physical model and level of the newest successful answer: where a virtual model's request went. */
function routedAnswer(
	entries: readonly EntryRecord[],
	modelRuntime: ModelRuntime,
): { readonly modelId: string; readonly thinkingLevel?: string } | undefined {
	const messages = entries.flatMap((entry) => entry.model ?? []);
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message === undefined || message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const physical = modelRuntime.getPhysicalModel(message.provider, message.model);
		if (physical === undefined) return undefined;
		return {
			modelId: physical.id,
			...(message.thinkingLevel === undefined ? {} : { thinkingLevel: message.thinkingLevel }),
		};
	}
	return undefined;
}

/** One open durable session, as the TUI renders it. A reopen replaces every member. */
export interface DurableTuiOpen {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	readonly extensionHost?: ExtensionHost;
	/** Session-wide product operations: the display name, the entry list, the picker, and forks. */
	readonly sessionOps?: DurableSessionOps;
	/** The models and credentials `/settings`, `/model`, `/login`, and `/logout` work with. */
	readonly modelRuntime?: ModelRuntime;
	/** The themes this open loaded, which a `/reload` replaces. */
	readonly themes?: readonly Theme[];
	/** The prompt templates `/name args` expands, completed as `/` commands. Absent in an embedding that has none. */
	readonly promptTemplates?: readonly PromptTemplate[];
	/** What `/bug` reads from the process: the model runtime, the settings, and the loaded extensions. */
	readonly bugReport?: DurableBugReportEnvironment;
	/** What a start lists as loaded: the skills, prompts, extensions, and the loader's diagnostics. */
	readonly resources?: DurableStartupResources;
}

/** What the TUI needs from the caller that owns opening sessions. */
export interface DurableTuiSessions {
	readonly open: DurableTuiOpen;
	/**
	 * Close the open session and open the next one with the same services, as RPC `new_session` and `switch_session` do.
	 * A caller that owns a single session (the experimental modes) leaves it out, and the session commands answer that
	 * they are unavailable.
	 */
	reopen?(request: DurableReopenRequest): Promise<DurableTuiOpen>;
}

/**
 * What the editor completes for one open. `open` is read through a function because a reopen replaces the session, and
 * `scopedModelIds` because `/scoped-models` changes what `/model` offers without reopening anything.
 */
export function durableAutocompleteSourcesOf(
	open: () => DurableTuiOpen,
	scopedModelIds: () => readonly string[] | null,
): DurableAutocompleteSources {
	const current = open();
	return {
		cwd: current.view.current().session.cwd,
		...(current.modelRuntime === undefined ? {} : { modelRuntime: current.modelRuntime }),
		scopedModelIds,
		currentModel: () => agentOf(open().view.current().conversation).model,
		promptTemplates: current.promptTemplates ?? [],
		...(current.extensionHost === undefined
			? {}
			: { extensionCommands: current.extensionHost.runner.getRegisteredCommands() }),
	};
}

export async function runDurableTui(
	source: DurableViewSource,
	controller: DurableController,
	settings: SettingsManager,
	host?: ExtensionHost,
	availableThemes: readonly Theme[] = [],
	sessions?: DurableTuiSessions,
): Promise<void> {
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	// The system theme until the controller resolves the user's theme against the terminal's colors.
	initTheme();
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	let view!: DurableTui;
	/** The open session the TUI shows; a reopen replaces it, so every reader goes through this. */
	let shown: DurableTuiOpen = sessions?.open ?? { view: source, controller, extensionHost: host };
	let commands: DurableCommands | undefined;

	const selectModel = (search?: string): void => {
		const snapshot = shown.view.current();
		const current = agentOf(snapshot.conversation).model;
		const isCurrent = (model: { provider: string; modelId: string }) =>
			model.provider === current?.provider && model.modelId === current.modelId;
		// The runtime holds the newest catalog, which a login or a catalog refresh replaces; the view's list is the one
		// the session opened with.
		const available =
			shown.modelRuntime?.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
			})) ?? snapshot.models;
		const scoped = view.scopedModelIds;
		const items: SelectItem[] = available
			.filter((model) => scoped === null || scoped.includes(`${model.provider}/${model.modelId}`))
			.sort((left, right) => Number(isCurrent(right)) - Number(isCurrent(left)))
			.map((model) => ({
				value: `${model.provider}/${model.modelId}`,
				label: model.modelId,
				description: model.provider,
			}));
		if (items.length === 0) {
			view.notify("No model is enabled. /scoped-models enables one.", "warning");
			return;
		}
		const selector = new ListSelector(
			"Select model:",
			items,
			(value) => {
				view.restoreEditor();
				const separator = value.indexOf("/");
				void shown.controller.setModel({
					provider: value.slice(0, separator),
					modelId: value.slice(separator + 1),
				});
			},
			() => view.restoreEditor(),
			search,
		);
		view.mount(selector);
	};

	const selectConversation = (): void => {
		const snapshot = shown.view.current();
		const items: SelectItem[] = [...snapshot.conversations].reverse().map((candidate) => ({
			value: String(candidate.id),
			label: candidate.label,
			description: `${candidate.id === snapshot.conversation.conversation.id ? "(shown) " : ""}${candidate.title ?? ""}`,
		}));
		const selector = new ListSelector(
			"Switch to:",
			items,
			(value) => {
				view.restoreEditor();
				void shown.controller.switchConversation(Number(value) as ConversationId);
			},
			() => view.restoreEditor(),
		);
		view.mount(selector);
	};

	/**
	 * Run a session command. The layer is absent when the caller owns no session operations (the experimental modes),
	 * where the command answers that it is unavailable rather than being submitted.
	 */
	const runSessionCommand = (name: DurableRunnableCommand, args: string): void => {
		if (commands === undefined) {
			view.notify(`/${name} is not available in this mode.`, "warning");
			return;
		}
		void commands
			.run(name, args)
			.catch((error: unknown) => {
				view.notify(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			})
			// A command can change what the footer shows without changing the view: `/settings` turns auto-compaction on
			// or off, and `/login` adds a provider.
			.finally(() => view.refreshFooter());
	};

	/**
	 * Run a command this TUI answers itself. False when the line is not one of its commands, so the caller offers it to
	 * an extension command and then to the model.
	 */
	const runCommand = (text: string): boolean => {
		const route = routeDurableInput(text);
		if (route.kind === "prompt") return false;
		if (route.kind === "unsupported") {
			// Never submit it: the text of a command is not a prompt, and a request for it is paid for.
			view.notify(route.message, "warning");
			return true;
		}
		if (route.kind === "bash") {
			void runBash(route.command, route.excludeFromContext);
			return true;
		}
		switch (route.name) {
			case "model":
				selectModel(route.args.length === 0 ? undefined : route.args);
				return true;
			case "tasks":
				void shown.controller.toggleTasks();
				return true;
			case "agents":
				selectConversation();
				return true;
			case "compact":
				void shown.controller.compact(route.args.length === 0 ? undefined : route.args);
				return true;
			default:
				// The session commands are the command layer's; it reports a name it does not handle at compile time.
				runSessionCommand(route.name, route.args);
				return true;
		}
	};

	/** Whether a bash command is running now: legacy refuses a second one. */
	let bashRunning = false;

	/**
	 * Run a user bash command: the shared `!` flow, with the card this TUI draws and the durable executor.
	 */
	const runBash = async (command: string, excludeFromContext: boolean): Promise<void> => {
		if (bashRunning) {
			view.notify("A bash command is already running. Press Escape to cancel it first.", "warning");
			return;
		}
		bashRunning = true;
		try {
			// The card exists before the first chunk: the `user_bash` handlers may answer synchronously.
			view.startBash(command, excludeFromContext);
			const outcome = await runUserBash({
				command,
				excludeFromContext,
				cwd: shown.view.current().session.cwd,
				...(shown.extensionHost === undefined ? {} : { extensionHost: shown.extensionHost }),
				execute: (text, excluded, onChunk, operations) =>
					shown.controller.executeBash(text, excluded, onChunk, operations),
				record: (text, result, excluded) => shown.controller.recordBashResult(text, result, excluded),
				view: {
					append: (chunk) => view.appendBash(chunk),
					finish: (result) => view.finishBash(result),
				},
			});
			if (outcome.status === "extension-failed") view.abandonBash();
		} catch (error) {
			view.notify(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
			view.abandonBash();
		} finally {
			bashRunning = false;
		}
	};

	// The input actions are what the editor's keys and submits do; they hold no terminal objects themselves.
	let input!: DurableInput;

	/** What the footer reads that the view does not carry: auto-compaction, auth, the catalog, and the route. */
	const footerLabels = (): DurableFooterLabels => {
		const snapshot = shown.view.current();
		const agent = agentOf(snapshot.conversation);
		const modelRuntime = shown.modelRuntime;
		const model =
			modelRuntime === undefined || agent.model === undefined
				? undefined
				: modelRuntime.getModel(agent.model.provider, agent.model.modelId);
		const available = modelRuntime?.getAvailableSnapshot() ?? [];
		const scoped = view.scopedModelIds;
		const considered =
			scoped === null
				? available
				: available.filter((candidate) => scoped.includes(`${candidate.provider}/${candidate.id}`));
		const routed =
			model === undefined || modelRuntime === undefined || !isVirtualModel(model)
				? undefined
				: routedAnswer(snapshot.conversation.entries, modelRuntime);
		return {
			autoCompaction: shown.controller.getAutoCompaction(),
			subscription:
				agent.model !== undefined &&
				(agent.model.provider === "kimi-coding" ||
					modelRuntime?.isUsingSubscription(agent.model.provider) === true),
			providerCount: new Set(considered.map((candidate) => candidate.provider)).size,
			reasoning: model?.reasoning === true,
			...(routed === undefined ? {} : { routedModel: routed }),
		};
	};

	view = new DurableTui(
		shown.view.current().session.cwd,
		{
			submit: (text) => void input.submit(text, "steer"),
			followUp: (text) => void input.submit(text, "followUp"),
			// Escape cancels the running bash command first, as it does in legacy.
			abort: () => {
				if (bashRunning) shown.controller.abortBash();
				else void shown.controller.abort();
			},
			exit,
			interrupt: () => input.interrupt(),
			selectModel: () => selectModel(),
			cycleThinking: () => void shown.controller.cycleThinking(),
			cycleModel: (direction) => void input.cycleModel(direction),
			dequeue: () => void input.dequeue(),
			paste: () => void input.paste(),
			copyAnswer: () => void input.copyAnswer(),
			toggleThinking: () => input.toggleThinking(),
			openExternalEditor: () => void input.openExternalEditor(),
			suspend: () => input.suspend(),
			extensionShortcut: (data) => input.extensionShortcut(data),
		},
		settings.getOutputPad(),
		settings.getHideThinkingBlock(),
		footerLabels,
	);
	/**
	 * The editor's completions: the commands this TUI answers, the prompt templates and extension commands beside them,
	 * and `@` paths once `fd` answers. A reopen or a reload replaces what they are built from, so the sources read the
	 * session that is open now rather than the one the start opened.
	 */
	let fdPath: string | null = null;
	let stopped = false;
	const refreshAutocomplete = (): void => {
		view.setAutocompleteProvider(
			createDurableAutocompleteProvider(
				durableAutocompleteSourcesOf(
					() => shown,
					() => view.scopedModelIds,
				),
				fdPath,
			),
		);
	};
	refreshAutocomplete();
	view.setAutocompleteMaxVisible(settings.getAutocompleteMaxVisible());
	// `@` paths need `fd`, the same binary the find tool uses. The check outlives the start, so it paints nothing once
	// the TUI has stopped, and a failure costs file completion rather than the session.
	void ensureTool("fd", (status) => {
		if (!stopped && status.type === "warning") view.notify(status.message, "warning");
	}).then(
		(path) => {
			if (stopped || path === undefined || path === fdPath) return;
			fdPath = path;
			refreshAutocomplete();
		},
		(error: unknown) => {
			if (!stopped)
				view.notify(`Could not check for fd: ${error instanceof Error ? error.message : String(error)}`, "error");
		},
	);
	input = new DurableInput({
		current: () => ({
			view: shown.view.current(),
			controller: shown.controller,
			sessionOps: shown.sessionOps,
		}),
		settings,
		modelRuntime: shown.modelRuntime,
		getScopedModels: () => view.scopedModelIds,
		editor: view.createEditorPort(),
		keybindings: view.keybindings,
		extensionRunner: shown.extensionHost?.runner,
		notify: (message, type) => view.notify(message, type),
		runCommand,
		dispatchExtension: async (text) => {
			const extensionHost = shown.extensionHost;
			if (extensionHost === undefined) return false;
			// An extension command runs as soon as it is submitted, whether the agent is idle or streaming.
			return await dispatchDurableExtensionCommand(extensionHost.runner, text);
		},
		readClipboard: readClipboardPaste,
		copyText: (text) => copyToClipboard(text),
		stopTerminal: () => view.ui.stop(),
		startTerminal: () => {
			view.ui.start();
			view.ui.requestRender(true);
		},
		exit,
	});
	// The models a start shows in `/model`: the ones nyan's settings enable, which `/scoped-models` changes.
	if (shown.modelRuntime !== undefined) {
		view.setScopedModelIds(enabledModelIds(settings.getEnabledModels(), shown.modelRuntime.getAvailableSnapshot()));
	}

	/** Render the open session the TUI holds now, and follow it. */
	const follow = (): void => view.apply(shown.view.current());
	let unsubscribe = (): void => {};

	// nyan's theme handling: the theme setting (also light/dark pairs) resolved against the terminal's reported colors.
	// It exists before the commands, because `/settings` reads and applies the theme through it.
	const themes = new InteractiveThemeController(view.ui, {
		getSettingsManager: () => settings,
		showError: (message) => console.error(message),
		onChanged: () => view.ui.requestRender(),
	});

	/**
	 * The settings and account surface. It is absent when the caller opened a session without a model runtime (the
	 * experimental modes), where those commands answer that they are unavailable.
	 */
	const product = (): DurableCommandProduct | undefined => {
		const modelRuntime = shown.modelRuntime;
		if (modelRuntime === undefined) return undefined;
		return {
			settings,
			modelRuntime,
			tui: view.ui,
			settingsUi: view.createSettingsUi({
				themeSelection: () => themes.getThemeSelection() ?? SYSTEM_THEME_NAME,
				terminalTheme: () => themes.getTerminalTheme(),
				setTheme: (setting) => themes.setThemeSetting(setting),
				previewTheme: (setting) => themes.preview(setting),
			}),
			keybindings: view.keybindings,
			...(shown.extensionHost === undefined ? {} : { extensionRunner: shown.extensionHost.runner }),
			getScopedModels: () => view.scopedModelIds,
			setScopedModels: (ids) => view.setScopedModelIds(ids),
		};
	};

	if (shown.sessionOps !== undefined) {
		commands = await DurableCommands.create(
			{
				current: () => {
					const sessionOps = shown.sessionOps;
					if (sessionOps === undefined) throw new Error("This session has no session operations");
					return {
						view: shown.view.current(),
						controller: shown.controller,
						sessionOps,
						...(shown.bugReport === undefined ? {} : { bugReport: shown.bugReport }),
					};
				},
				readSessionName: async () => await shown.sessionOps?.getSessionName(),
				get product() {
					return product();
				},
				...(sessions?.reopen === undefined
					? {}
					: {
							reopen: async (request: DurableReopenRequest): Promise<void> => {
								const next = await sessions.reopen?.(request);
								if (next === undefined) return;
								// The session this TUI showed is closed by the caller; follow the one it opened.
								unsubscribe();
								shown = next;
								unsubscribe = shown.view.subscribe(follow);
								shown.extensionHost?.runner.setUIContext(view.createExtensionUIContext(), "tui");
								if (shown.themes !== undefined) setRegisteredThemes([...shown.themes]);
								if (request.kind === "reload") {
									setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
									view.reloadBindings();
									themes.applyFromSettings();
								}
								// The commands and templates of the session now open are not the ones the provider was built from.
								refreshAutocomplete();
								await commands?.refreshSessionName();
								view.setSessionName(commands?.sessionName);
								view.resetSessionView();
								follow();
							},
						}),
			},
			{
				select: (title, items, description) => view.choose(title, items, description),
				input: (title, description) => view.askText(title, description),
				showLines: (lines) => view.showLines(lines),
				showMarkdown: (markdown) => view.showMarkdown(markdown),
				copy: (text) => copyToClipboard(text),
				setSessionName: (name) => view.setSessionName(name),
				present: (component, focus) => view.mount(component, focus),
				restore: () => view.restoreEditor(),
				notify: (message, type) => view.notify(message, type),
				exit,
			},
		);
		view.setSessionName(commands.sessionName);
	}

	shown.extensionHost?.runner.setUIContext(view.createExtensionUIContext(), "tui");
	setRegisteredThemes([...availableThemes]);
	unsubscribe = shown.view.subscribe(follow);
	view.start();
	themes.applyFromSettings();
	follow();
	// The notices a start shows, in the order legacy shows them; the checks that reach the network answer later.
	const startup: DurableTuiOpen = shown;
	void runDurableStartup({
		cwd: startup.view.current().session.cwd,
		...(commands?.sessionName === undefined ? {} : { sessionName: commands.sessionName }),
		resumed: startup.view.current().conversation.entries.length > 0,
		settings,
		ui: {
			warn: (message) => view.showWarning(message),
			card: (title, lines) => view.showNoticeCard(title, lines),
			changelog: (markdown, latestVersion, collapsed) => view.showChangelog(markdown, latestVersion, collapsed),
			resources: (sections) => view.showResources(sections),
			title: (text) => view.setTitle(text),
		},
		...(startup.resources === undefined ? {} : { resources: startup.resources }),
	});
	await exited;
	stopped = true;
	unsubscribe();
	themes.dispose();
	view.stop();
}
