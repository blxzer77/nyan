/**
 * The slash commands the durable TUI answers itself. A name in this list never reaches the model, whatever follows it.
 * The reference is the legacy TUI: `BUILTIN_SLASH_COMMANDS`, plus `/tasks` and `/agents`, which only this path has.
 */
export const DURABLE_TUI_COMMANDS = [
	// Only the durable path has these.
	"tasks",
	"agents",
	// Built-ins the durable TUI runs today.
	"model",
	"compact",
	"new",
	"resume",
	"name",
	"session",
	"fork",
	"clone",
	"quit",
	// Built-ins the parity work adds, one batch at a time.
	"settings",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"resume",
	"reload",
	"quit",
] as const;

export type DurableTuiCommand = (typeof DURABLE_TUI_COMMANDS)[number];

const COMMAND_NAMES: readonly string[] = DURABLE_TUI_COMMANDS;

/**
 * Commands this build recognizes but does not implement yet. The TUI answers with `message` instead of submitting the
 * text as a prompt, so a command the durable path cannot run yet is never paid for. The batch that implements a
 * command deletes its entry; the list is empty when the parity work ends.
 */
const PENDING = {
	settings: pending("settings"),
	"scoped-models": pending("scoped-models"),
	thinking: pending("thinking"),
	export: pending("export"),
	import: pending("import"),
	share: pending("share"),
	bug: pending("bug"),
	copy: pending("copy"),
	changelog: pending("changelog"),
	hotkeys: pending("hotkeys"),
	trust: pending("trust"),
	login: pending("login"),
	logout: pending("logout"),
	reload: pending("reload"),
	// Durable conversations are linear, so there is no parent tree to navigate (Decision #24).
	tree: "durable sessions are linear, so /tree has no branch navigation (Decision #24).",
} satisfies Partial<Record<DurableTuiCommand, string>>;

/** The same entries, indexed by a command name: `PENDING`'s own keys are only the ones still pending. */
const PENDING_MESSAGES: Partial<Record<DurableTuiCommand, string>> = PENDING;

function pending(name: string): string {
	return `/${name} is not available on the durable session yet.`;
}

/**
 * The commands this build runs. It is derived from `PENDING`, so removing an entry there makes the TUI's dispatch
 * switch require a branch for it: an unimplemented command cannot be routed to a missing handler.
 */
export type DurableRunnableCommand = Exclude<DurableTuiCommand, keyof typeof PENDING>;

/** What the durable TUI does with one line of input. */
export type DurableInputRoute =
	/** A command the TUI runs; `args` is the text after the command name, trimmed. */
	| { readonly kind: "command"; readonly name: DurableRunnableCommand; readonly args: string }
	/** A recognized command this build does not run: show `message` and send nothing. */
	| { readonly kind: "unsupported"; readonly name: DurableTuiCommand; readonly message: string }
	/** Not a command of this TUI: an extension command, a prompt template, or text for the model. */
	| { readonly kind: "prompt" };

/**
 * Decide what one submitted line is. A command name is matched before anything else, as the legacy TUI matches it, so
 * its text is never submitted as a prompt: otherwise the command would be sent to the provider and paid for.
 */
export function routeDurableInput(text: string): DurableInputRoute {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "prompt" };
	const end = trimmed.search(/\s/u);
	const candidate = end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
	if (!COMMAND_NAMES.includes(candidate)) return { kind: "prompt" };
	// The list and the type are declared together, so membership makes the narrowing sound.
	const name = candidate as DurableTuiCommand;
	const message = PENDING_MESSAGES[name];
	if (message !== undefined) return { kind: "unsupported", name, message };
	return {
		kind: "command",
		name: name as DurableRunnableCommand,
		args: end < 0 ? "" : trimmed.slice(end + 1).trim(),
	};
}
