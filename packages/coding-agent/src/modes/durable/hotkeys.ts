import type { Keybinding } from "@ny4n/tui";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { formatKeyText, keyDisplayText } from "../../ui/components/keybinding-hints.ts";

/**
 * `/hotkeys` for the durable TUI: the keys this TUI actually binds, plus the extension shortcuts it dispatches, as the
 * markdown the transcript renders. Keys only the legacy TUI binds are left out rather than listed as working here.
 */
export function durableHotkeysMarkdown(keybindings: KeybindingsManager, runner?: ExtensionRunner): string {
	const key = (action: Keybinding): string => keyDisplayText(action);
	const row = (keys: string, action: string): string => `| \`${keys}\` | ${action} |`;
	const table = (rows: string[]): string => ["| Key | Action |", "|-----|--------|", ...rows].join("\n");

	const editing = table([
		row(key("tui.input.submit"), "Send message"),
		row(key("tui.input.newLine"), "New line"),
		row(key("tui.editor.deleteWordBackward"), "Delete word backwards"),
		row(key("tui.editor.deleteWordForward"), "Delete word forwards"),
		row(key("tui.editor.yank"), "Paste the most recently deleted text"),
		row(key("tui.editor.yankPop"), "Cycle the deleted text after pasting"),
		row(key("tui.editor.undo"), "Undo"),
	]);
	const navigation = table([
		row(
			`${key("tui.editor.cursorUp")} / ${key("tui.editor.cursorDown")}`,
			"Move the cursor / browse submitted prompts",
		),
		row(`${key("tui.editor.cursorWordLeft")} / ${key("tui.editor.cursorWordRight")}`, "Move by word"),
		row(`${key("tui.editor.jumpForward")} / ${key("tui.editor.jumpBackward")}`, "Jump to a character"),
		row(`${key("tui.altScreen.pageUp")} / ${key("tui.altScreen.pageDown")}`, "Scroll the transcript by a page"),
		row(
			`${key("tui.altScreen.halfPageUp")} / ${key("tui.altScreen.halfPageDown")}`,
			"Scroll the transcript by half a page",
		),
		row(
			`${key("tui.altScreen.previousPrompt")} / ${key("tui.altScreen.nextPrompt")}`,
			"Go to the previous or next prompt",
		),
		row(key("tui.altScreen.search"), "Search the transcript"),
		row(`${key("tui.altScreen.top")} / ${key("tui.altScreen.bottom")}`, "Go to the top or bottom"),
	]);
	const application = table([
		row(key("app.interrupt"), "Abort the answer, or cancel a running bash command"),
		row(key("app.clear"), "Exit"),
		row(key("app.exit"), "Exit when the editor is empty"),
		row(key("app.model.select"), "Open the model picker"),
		row(key("app.thinking.cycle"), "Cycle the thinking level"),
		row(key("app.tools.expand"), "Expand or collapse tool output"),
		row(key("app.message.followUp"), "Queue a follow-up message"),
		row("/", "Slash commands"),
		row("!", "Run a bash command"),
		row("!!", "Run a bash command, kept out of the model's context"),
	]);

	const sections = [`**Editing**\n${editing}`, `**Navigation**\n${navigation}`, `**Application**\n${application}`];
	const shortcuts = runner?.getShortcuts(keybindings.getEffectiveConfig());
	if (shortcuts !== undefined && shortcuts.size > 0) {
		sections.push(
			`**Extensions**\n${table(
				[...shortcuts].map(([shortcutKey, shortcut]) =>
					row(formatKeyText(shortcutKey, { capitalize: true }), shortcut.description ?? shortcut.extensionPath),
				),
			)}`,
		);
	}
	return sections.join("\n\n");
}
