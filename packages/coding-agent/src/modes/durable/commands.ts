import type { ThinkingLevel } from "@ny4n/agent-core";
import { getSupportedThinkingLevels } from "@ny4n/ai";
import type { LiveState, UsageState } from "@ny4n/durable";
import type { Component, SelectItem, TUI } from "@ny4n/tui";
import { getAgentDir, getChangelogPath } from "../../config.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import type { DurableRunnableCommand } from "../../core/durable/commands.ts";
import { agentOf, type DurableController, type DurableView, type Notice } from "../../core/durable/runtime.ts";
import type { DurableSessionOps } from "../../core/durable/session-ops.ts";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { formatTokens } from "../interactive/components/footer.ts";
import { ThinkingSelectorComponent } from "../interactive/components/thinking-selector.ts";
import { TrustSelectorComponent } from "../interactive/components/trust-selector.ts";
import { type DurableBugReportEnvironment, reportDurableBug, shareDurableSession } from "./bug-report.ts";
import { durableHotkeysMarkdown } from "./hotkeys.ts";
import { lastAssistantText } from "./input.ts";
import { runLogin, runLogout } from "./login.ts";
import { type ScopedModelIds, scopedModelsDialog } from "./scoped-models.ts";
import { listSiblingSessions } from "./session-list.ts";
import { type DurableSettingsUi, durableSettingsDialog } from "./settings.ts";

/** The open session a command runs against. A reopen replaces every member. */
export interface DurableCommandSession {
	readonly view: DurableView;
	readonly controller: DurableController;
	readonly sessionOps: DurableSessionOps;
	/** What `/bug` reads from the process; absent in an embedding that owns no model runtime. */
	readonly bugReport?: DurableBugReportEnvironment;
}

/** A reopened session: the same members, for the next session directory. */
export type DurableReopenRequest =
	/** Start a new session in the same working directory. */
	| { readonly kind: "new" }
	/** Open this existing session directory. */
	| { readonly kind: "resume"; readonly directory: string }
	/** Reopen this session's directory with freshly loaded services, which is how extensions reload. */
	| { readonly kind: "reload" };

/**
 * What the settings and account commands need beyond the session: nyan's settings, the model runtime that holds the
 * credentials, and the parts of the running TUI a settings change applies to. Absent in an embedding that has none of
 * them, where those commands answer that they are unavailable.
 */
export interface DurableCommandProduct {
	readonly settings: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	/** The terminal the login dialogs draw on and open their URLs from. */
	readonly tui: TUI;
	readonly settingsUi: DurableSettingsUi;
	readonly keybindings: KeybindingsManager;
	readonly extensionRunner?: ExtensionRunner;
	/** The models `/model` lists and cycles through; null is every model the session can use. */
	getScopedModels(): ScopedModelIds;
	setScopedModels(ids: ScopedModelIds): void;
}

/** Everything a command needs from the terminal: dialogs, the transcript, notices, and the exit. */
export interface DurableCommandUi {
	/** A filterable list; undefined when the user cancelled. */
	select(title: string, items: readonly SelectItem[], description?: string): Promise<string | undefined>;
	/** One line of text, with `description` above it; undefined when the user cancelled. */
	input(title: string, description: string): Promise<string | undefined>;
	/** Add lines to the transcript, as legacy's `/session` and `/name` do. */
	showLines(lines: readonly string[]): void;
	/** The display name changed: the footer shows the one stored beside the database. */
	setSessionName(name: string | undefined): void;
	/** Add rendered markdown to the transcript, as legacy's `/changelog` does. */
	showMarkdown(markdown: string): void;
	/** Copy text to the system clipboard. */
	copy(text: string): Promise<void>;
	/** Show a component in place of the editor, as a settings or login dialog, until `restore` is called. */
	present(component: Component, focus: Component): void;
	/** Put the editor back after `present`. */
	restore(): void;
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
	/** The settings and account surface; absent in an embedding that has no settings or model runtime. */
	readonly product?: DurableCommandProduct;
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
			case "export":
				return this.#export(args);
			case "copy":
				return this.#copy();
			case "changelog":
				return this.#changelog();
			case "share":
				return this.#share();
			case "bug":
				return this.#bug();
			case "settings":
				return this.#settings();
			case "thinking":
				return this.#thinking(args);
			case "scoped-models":
				return this.#scopedModels();
			case "trust":
				return this.#trust();
			case "login":
				return this.#login(args);
			case "logout":
				return this.#logout();
			case "reload":
				return this.#reload();
			case "hotkeys":
				return this.#hotkeys();
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

	async #export(args: string): Promise<void> {
		const { sessionOps } = this.#host.current();
		const path = args.length === 0 ? undefined : args;
		try {
			const file =
				path?.endsWith(".jsonl") === true ? await sessionOps.exportJsonl(path) : await sessionOps.exportHtml(path);
			this.#ui.notify(`Session exported to: ${file}`);
		} catch (error) {
			this.#ui.notify(`Failed to export session: ${messageOf(error)}`, "error");
		}
	}

	async #share(): Promise<void> {
		await shareDurableSession(this.#ui, this.#host.current().sessionOps);
	}

	async #bug(): Promise<void> {
		const session = this.#host.current();
		const environment = session.bugReport;
		if (environment === undefined) return this.#unavailable("bug");
		await reportDurableBug(this.#ui, session, environment);
	}

	async #copy(): Promise<void> {
		const text = lastAssistantText(this.#host.current().view);
		if (text === undefined) {
			this.#ui.notify("No agent messages to copy yet.", "error");
			return;
		}
		try {
			await this.#ui.copy(text);
			this.#ui.notify("Copied last agent message to clipboard");
		} catch (error) {
			this.#ui.notify(messageOf(error), "error");
		}
	}

	#changelog(): void {
		const entries = parseChangelog(getChangelogPath());
		if (entries.length === 0) {
			this.#ui.notify("No changelog entries found.");
			return;
		}
		this.#ui.showMarkdown(
			entries
				.toReversed()
				.map((entry) => normalizeChangelogLinks(entry.content, entry))
				.join("\n\n"),
		);
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

	/** The settings and account surface, or a message that this embedding has none. */
	#product(name: string): DurableCommandProduct | undefined {
		const product = this.#host.product;
		if (product === undefined) this.#unavailable(name);
		return product;
	}

	/** `/settings`: the same items the legacy TUI shows, over this session's state and nyan's settings. */
	#settings(): void {
		const product = this.#product("settings");
		if (product === undefined) return;
		const dialog = durableSettingsDialog(
			{
				settings: product.settings,
				modelRuntime: product.modelRuntime,
				view: () => this.#host.current().view,
				controller: this.#host.current().controller,
				ui: product.settingsUi,
			},
			() => this.#ui.restore(),
		);
		this.#ui.present(dialog.component, dialog.focus);
	}

	/** `/thinking [level]`: a level from the argument, or the selector when there is none. */
	async #thinking(args: string): Promise<void> {
		const product = this.#product("thinking");
		if (product === undefined) return;
		const ref = agentOf(this.#host.current().view.conversation).model;
		const model = ref === undefined ? undefined : product.modelRuntime.getModel(ref.provider, ref.modelId);
		if (model === undefined) {
			this.#ui.notify("No model is selected, so there is no thinking level to set.", "error");
			return;
		}
		const levels = model.reasoning ? getSupportedThinkingLevels(model) : (["off"] as ThinkingLevel[]);
		const wanted = args.trim();
		if (wanted.length > 0) {
			const level = levels.find((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
			if (level === undefined) {
				this.#ui.notify(`Unknown thinking level "${wanted}". Available levels: ${levels.join(", ")}.`, "error");
				return;
			}
			await this.#setThinking(level, false);
			return;
		}
		const current = agentOf(this.#host.current().view.conversation).thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		const selector = new ThinkingSelectorComponent(
			current,
			levels,
			(level) => {
				this.#ui.restore();
				void this.#setThinking(level, false);
			},
			() => this.#ui.restore(),
			(level) => {
				this.#ui.restore();
				void this.#setThinking(level, true);
			},
			product.settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
		);
		this.#ui.present(selector, selector);
	}

	/** Set the thinking level of this session, and store it as the default when asked to. */
	async #setThinking(level: ThinkingLevel, asDefault: boolean): Promise<void> {
		const product = this.#host.product;
		try {
			await this.#host.current().controller.setThinking(level);
		} catch (error) {
			this.#ui.notify(messageOf(error), "error");
			return;
		}
		if (asDefault) product?.settings.setDefaultThinkingLevel(level);
		this.#ui.notify(asDefault ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
	}

	/** `/scoped-models`: which models `/model` lists and the model cycle walks. */
	#scopedModels(): void {
		const product = this.#product("scoped-models");
		if (product === undefined) return;
		const dialog = scopedModelsDialog(
			{
				settings: product.settings,
				models: () => product.modelRuntime.getAvailableSnapshot(),
				apply: (ids) => product.setScopedModels(ids),
			},
			() => this.#ui.restore(),
		);
		this.#ui.present(dialog.component, dialog.focus);
	}

	/** `/trust`: the project trust decision, stored in the trust store the next start reads. */
	#trust(): void {
		const product = this.#product("trust");
		if (product === undefined) return;
		const cwd = this.#host.current().view.session.cwd;
		const store = new ProjectTrustStore(getAgentDir());
		const selector = new TrustSelectorComponent({
			cwd,
			savedDecision: store.getEntry(cwd),
			projectTrusted: product.settings.isProjectTrusted(),
			onSelect: (selection) => {
				store.setMany(selection.updates);
				this.#ui.restore();
				this.#ui.notify(
					`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart nyan for this to take effect.`,
				);
			},
			onCancel: () => this.#ui.restore(),
		});
		this.#ui.present(selector, selector);
	}

	async #login(args: string): Promise<void> {
		const product = this.#product("login");
		if (product === undefined) return;
		const ref = args.trim();
		await runLogin(
			{
				settings: product.settings,
				modelRuntime: product.modelRuntime,
				tui: product.tui,
				ui: {
					present: (component, focus) => this.#ui.present(component, focus),
					restore: () => this.#ui.restore(),
					select: (title, items) => this.#ui.select(title, items),
					notify: (message, type) => this.#ui.notify(message, type),
				},
			},
			ref.length === 0 ? undefined : ref,
		);
	}

	async #logout(): Promise<void> {
		const product = this.#product("logout");
		if (product === undefined) return;
		await runLogout({
			settings: product.settings,
			modelRuntime: product.modelRuntime,
			tui: product.tui,
			ui: {
				present: (component, focus) => this.#ui.present(component, focus),
				restore: () => this.#ui.restore(),
				select: (title, items) => this.#ui.select(title, items),
				notify: (message, type) => this.#ui.notify(message, type),
			},
		});
	}

	/** `/reload`: reopen this session's directory with freshly loaded services, which is what reloads extensions. */
	async #reload(): Promise<void> {
		const reopen = this.#host.reopen;
		if (reopen === undefined) return this.#unavailable("reload");
		const live = (this.#host.current().view.conversation.docs["nyan.live"] ?? {}) as LiveState;
		if (live.run !== undefined) {
			this.#ui.notify("Wait for the current response to finish before reloading.", "warning");
			return;
		}
		if ((live.compactions ?? []).length > 0) {
			this.#ui.notify("Wait for compaction to finish before reloading.", "warning");
			return;
		}
		try {
			await reopen({ kind: "reload" });
		} catch (error) {
			this.#ui.notify(`Reload failed: ${messageOf(error)}`, "error");
			return;
		}
		await this.refreshSessionName();
		this.#ui.setSessionName(this.#sessionName);
		this.#ui.notify("Reloaded keybindings, extensions, skills, prompts, themes, and context files");
	}

	/** `/hotkeys`: the keys this TUI binds, plus the shortcuts extensions registered. */
	#hotkeys(): void {
		const product = this.#product("hotkeys");
		if (product === undefined) return;
		this.#ui.showMarkdown(
			`# Keyboard Shortcuts\n\n${durableHotkeysMarkdown(product.keybindings, product.extensionRunner)}`,
		);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
