import type { UsageState } from "@ny4n/durable";
import type { SelectItem } from "@ny4n/tui";
import type { DurableRunnableCommand } from "../../core/durable/commands.ts";
import type { DurableController, DurableView, Notice } from "../../core/durable/runtime.ts";
import type { DurableSessionOps } from "../../core/durable/session-ops.ts";
import { formatTokens } from "../interactive/components/footer.ts";
import { listSiblingSessions } from "./session-list.ts";

/** The open session a command runs against. A reopen replaces every member. */
export interface DurableCommandSession {
	readonly view: DurableView;
	readonly controller: DurableController;
	readonly sessionOps: DurableSessionOps;
}

/** A reopened session: the same members, for the next session directory. */
export type DurableReopenRequest =
	/** Start a new session in the same working directory. */
	| { readonly kind: "new" }
	/** Open this existing session directory. */
	| { readonly kind: "resume"; readonly directory: string };

/** Everything a command needs from the terminal: dialogs, the transcript, notices, and the exit. */
export interface DurableCommandUi {
	/** A filterable list; undefined when the user cancelled. */
	select(title: string, items: readonly SelectItem[]): Promise<string | undefined>;
	/** Add lines to the transcript, as legacy's `/session` and `/name` do. */
	showLines(lines: readonly string[]): void;
	/** The display name changed: the footer shows the one stored beside the database. */
	setSessionName(name: string | undefined): void;
	notify(message: string, type?: Notice["level"]): void;
	exit(): void;
}

export interface DurableCommandsHost {
	current(): DurableCommandSession;
	/**
	 * Open another session and close this one, as RPC `new_session` and `switch_session` do. Absent in an embedding that
	 * owns a single session (the experimental modes), where the session commands answer that they are unavailable.
	 */
	reopen?(request: DurableReopenRequest): Promise<void>;
	/** The display name is stored beside the database, so it is read again after every reopen. */
	readSessionName(): Promise<string | undefined>;
}

/**
 * The commands the durable TUI answers itself. They carry no terminal code: each one asks `DurableCommandUi` for a
 * dialog or a line of text and changes the session through the controller and the session operations, so the same code
 * runs against a real session in a test.
 */
export class DurableCommands {
	readonly #host: DurableCommandsHost;
	readonly #ui: DurableCommandUi;
	#sessionName: string | undefined = undefined;

	constructor(host: DurableCommandsHost, ui: DurableCommandUi) {
		this.#host = host;
		this.#ui = ui;
	}

	/** Read the session name of the open session; the TUI shows it in its footer. */
	static async create(host: DurableCommandsHost, ui: DurableCommandUi): Promise<DurableCommands> {
		const commands = new DurableCommands(host, ui);
		await commands.refreshSessionName();
		return commands;
	}

	get sessionName(): string | undefined {
		return this.#sessionName;
	}

	/** Re-read the display name after a reopen. */
	async refreshSessionName(): Promise<void> {
		this.#sessionName = await this.#host.readSessionName();
	}

	async run(name: DurableRunnableCommand, args: string): Promise<void> {
		switch (name) {
			case "new":
				return this.#newSession();
			case "resume":
				return this.#resume();
			case "name":
				return this.#setName(args);
			case "session":
				return this.#showSession();
			case "fork":
				return this.#fork();
			case "clone":
				return this.#clone();
			case "quit":
				this.#ui.exit();
				return;
			case "model":
			case "compact":
			case "tasks":
			case "agents":
				// Rendered and dispatched by the TUI itself, which owns the model picker, compaction, and the panels.
				throw new Error(`/${name} is dispatched by the TUI, not by the command layer`);
			default: {
				const unhandled: never = name;
				throw new Error(`Unhandled durable command: ${JSON.stringify(unhandled)}`);
			}
		}
	}

	async #newSession(): Promise<void> {
		const reopen = this.#host.reopen;
		if (reopen === undefined) return this.#unavailable("new");
		await reopen({ kind: "new" });
		this.#ui.notify("New session started");
	}

	async #resume(): Promise<void> {
		const reopen = this.#host.reopen;
		if (reopen === undefined) return this.#unavailable("resume");
		const current = this.#host.current().view.session;
		let sessions: Awaited<ReturnType<typeof listSiblingSessions>>;
		try {
			sessions = await listSiblingSessions(current.directory);
		} catch (error) {
			this.#ui.notify(`Could not list sessions: ${messageOf(error)}`, "error");
			return;
		}
		const other = sessions.filter((session) => !session.current);
		if (other.length === 0) {
			this.#ui.notify("No other session for this directory");
			return;
		}
		const chosen = await this.#ui.select(
			"Resume session:",
			other.map((session) => ({
				value: session.directory,
				label: session.name ?? session.directory.split("/").at(-1) ?? session.directory,
				description: `${session.created.toLocaleString()} · ${session.directory}`,
			})),
		);
		if (chosen === undefined) {
			this.#ui.notify("Resume cancelled");
			return;
		}
		try {
			await reopen({ kind: "resume", directory: chosen });
		} catch (error) {
			this.#ui.notify(`Could not resume session: ${messageOf(error)}`, "error");
			return;
		}
		await this.refreshSessionName();
		this.#ui.notify("Session resumed");
	}

	async #setName(args: string): Promise<void> {
		const name = args.trim();
		if (name.length === 0) {
			if (this.#sessionName === undefined) {
				this.#ui.notify("Usage: /name <name>", "warning");
				return;
			}
			this.#ui.showLines([`Session name: ${this.#sessionName}`]);
			return;
		}
		const stored = await this.#host.current().sessionOps.setSessionName(name);
		this.#sessionName = stored;
		this.#ui.setSessionName(stored);
		this.#ui.showLines([`Session name set: ${stored ?? name}`]);
	}

	async #showSession(): Promise<void> {
		const view = this.#host.current().view;
		const entries = await this.#host.current().sessionOps.entries(undefined);
		const messages = entries.entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const usage = (view.conversation.docs["nyan.usage"] ?? { models: {}, tools: {} }) as UsageState;
		const models = Object.entries(usage.models);
		const totals = models.reduce(
			(total, [, entry]) => ({
				input: total.input + entry.input,
				cacheRead: total.cacheRead + entry.cacheRead,
				cacheWrite: total.cacheWrite + entry.cacheWrite,
				output: total.output + entry.output,
				cost: total.cost + entry.cost.total,
			}),
			{ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 },
		);
		const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
		const compactions = view.conversation.entries.filter((entry) => entry.kind === "nyan.compaction").length;
		const lines = [
			"Session",
			`  Directory: ${view.session.directory}`,
			`  ID: ${view.session.id}`,
			`  Working directory: ${view.session.cwd}`,
			...(this.#sessionName === undefined ? [] : [`  Name: ${this.#sessionName}`]),
			"",
			"Messages",
			`  Total: ${messages.length}`,
			`  User: ${messages.filter((message) => message.role === "user").length}`,
			`  Assistant: ${messages.filter((message) => message.role === "assistant").length}`,
			`  Tool results: ${messages.filter((message) => message.role === "toolResult").length}`,
			`  Compactions: ${compactions}`,
			"",
			"Tokens",
			`  Input: ${prompt.toLocaleString()}`,
			`  Cached: ${totals.cacheRead.toLocaleString()}`,
			`  Uncached: ${(totals.input + totals.cacheWrite).toLocaleString()}`,
			`  Output: ${totals.output.toLocaleString()}`,
			`  Total: ${formatTokens(prompt + totals.output)}`,
			"",
			"Cost",
			`  Total: $${totals.cost.toFixed(3)}`,
			...models.map(([key, entry]) => `  ${key}: $${entry.cost.total.toFixed(3)}`),
		];
		this.#ui.showLines(lines);
	}

	async #fork(): Promise<void> {
		const { sessionOps, controller } = this.#host.current();
		const messages = await sessionOps.forkMessages();
		if (messages.length === 0) {
			this.#ui.notify("Nothing to fork from: this session has no user message", "warning");
			return;
		}
		const chosen = await this.#ui.select(
			"Fork from:",
			messages.map((message) => ({
				value: message.entryId,
				label: message.text,
			})),
		);
		if (chosen === undefined) {
			this.#ui.notify("Fork cancelled");
			return;
		}
		const forked = await sessionOps.fork(chosen);
		if (forked.cancelled) {
			this.#ui.notify("Fork cancelled by an extension");
			return;
		}
		await controller.switchConversation(forked.conversationId);
		this.#ui.notify(`Forked: ${forked.text}`);
	}

	async #clone(): Promise<void> {
		const { sessionOps, controller } = this.#host.current();
		const cloned = await sessionOps.clone();
		if (cloned.cancelled) {
			this.#ui.notify("Clone cancelled by an extension");
			return;
		}
		await controller.switchConversation(cloned.conversationId);
		this.#ui.notify("Session cloned");
	}

	#unavailable(name: string): void {
		this.#ui.notify(`/${name} is not available in this mode.`, "warning");
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
