/**
 * The slash commands the durable TUI answers itself. A name in this list never reaches the model, whatever follows it.
 * The reference is the legacy TUI: `BUILTIN_SLASH_COMMANDS`, plus `/tasks` and `/agents`, which only this path has.
 */
export const DURABLE_TUI_COMMANDS = [
	// Only the durable path has these.
	"tasks",
	"agents",
	// Built-ins the durable TUI runs.
	"model",
	"compact",
	"new",
	"resume",
	"name",
	"session",
	"fork",
	"clone",
	"quit",
	"export",
	"copy",
	"changelog",
	// The parity work ported these onto this path; see the parity note for where each one went.
	"settings",
	"thinking",
	"scoped-models",
	"import",
	"share",
	"bug",
	"hotkeys",
	"trust",
	"login",
	"logout",
	"reload",
	"tree",
] as const;

export type DurableTuiCommand = (typeof DURABLE_TUI_COMMANDS)[number];

const COMMAND_NAMES: readonly string[] = DURABLE_TUI_COMMANDS;

/**
 * Commands this build recognizes but answers with a message instead of running. The TUI shows the message and sends
 * nothing, so a command the durable path cannot run is never paid for as a prompt. These are the reductions the parity
 * note records, not unfinished work: a durable conversation is linear (Decision #24) and a durable session is not a
 * JSONL file (Decision #34).
 */
const PENDING = {
	import:
		"durable sessions are not JSONL files, so /import cannot open one. Open it with `nyan --session <file>`, which reads legacy sessions read-only, or with `nyan --resume`.",
	// Durable conversations are linear, so there is no parent tree to navigate (Decision #24).
	tree: "durable sessions are linear, so /tree has no branch navigation (Decision #24).",
} satisfies Partial<Record<DurableTuiCommand, string>>;

/** The same entries, indexed by a command name: `PENDING`'s own keys are only the ones it answers. */
const PENDING_MESSAGES: Partial<Record<DurableTuiCommand, string>> = PENDING;

/**
 * The message this build answers a recognized command with instead of running it; undefined when it runs. Completion
 * reads this to describe the two commands it can only refuse.
 */
export function pendingCommandMessage(name: DurableTuiCommand): string | undefined {
	return PENDING_MESSAGES[name];
}

/**
 * The commands this build runs. It is derived from `PENDING`, so adding an entry there makes the TUI's dispatch switch
 * require a branch for it, and a command that moves out of `PENDING` cannot be routed to a missing handler.
 */
export type DurableRunnableCommand = Exclude<DurableTuiCommand, keyof typeof PENDING>;

/** What the durable TUI does with one line of input. */
export type DurableInputRoute =
	/** A command the TUI runs; `args` is the text after the command name, trimmed. */
	| { readonly kind: "command"; readonly name: DurableRunnableCommand; readonly args: string }
	/** A user bash command: `!` keeps its result in the model context, `!!` keeps it out. */
	| { readonly kind: "bash"; readonly command: string; readonly excludeFromContext: boolean }
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
	// A bare `!` is text, as legacy treats it: only a `!` with a command runs one.
	if (trimmed.startsWith("!")) {
		const excludeFromContext = trimmed.startsWith("!!");
		const command = (excludeFromContext ? trimmed.slice(2) : trimmed.slice(1)).trim();
		return command.length === 0 ? { kind: "prompt" } : { kind: "bash", command, excludeFromContext };
	}
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
