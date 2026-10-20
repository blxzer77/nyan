import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxModelDefinition, fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import type { Component } from "@ny4n/tui";
import { vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { type DurableCommandProduct, DurableCommands, type DurableCommandUi } from "../src/modes/durable/commands.ts";
import { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { settlement } from "./durable-submission.ts";

/**
 * The durable TUI's commands driven without a terminal. `DurableCommands` asks a `DurableCommandUi` port for dialogs and
 * lines, and the session it runs against is the one the interactive mode opens, so every assertion is on what the
 * session, the settings, or the screen became.
 */

export const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

/** The TUI side of a command, as far as a command can observe it. */
export interface Screen extends DurableCommandUi {
	readonly notices: string[];
	readonly lines: string[];
	readonly choices: string[][];
	/** The components a command put in place of the editor; `restore` removes the newest. */
	readonly presented: Component[];
	/** Called with each component a command presented, so a test can drive it. */
	onPresent?: (component: Component) => void;
	/** The display name the footer was given, last. */
	sessionName?: string;
	/** The markdown a command rendered, if any. */
	markdown?: string;
	/** The text a command asked to copy, if any. */
	copied?: string;
	exited: boolean;
	/** What the next `select` answers; a choice not offered makes the command fail, as a missing entry would. */
	answer?: string;
}

export function screen(): Screen {
	const state: Screen = {
		notices: [],
		lines: [],
		choices: [],
		presented: [],
		exited: false,
		answer: undefined,
		select: async (_title, items) => {
			state.choices.push(items.map((item) => item.value));
			return state.answer;
		},
		showLines: (lines) => {
			state.lines.push(...lines);
		},
		setSessionName: (name) => {
			state.sessionName = name;
		},
		showMarkdown: (markdown) => {
			state.markdown = markdown;
		},
		copy: async (text) => {
			state.copied = text;
		},
		present: (component) => {
			state.presented.push(component);
			state.onPresent?.(component);
		},
		restore: () => {
			state.presented.pop();
		},
		notify: (message) => {
			state.notices.push(message);
		},
		exit: () => {
			state.exited = true;
		},
	};
	return state;
}

/** A session under a temporary HOME, opened the way the interactive mode opens one. */
export class TuiHarness {
	readonly events: string[] = [];
	home = "";
	agentDir = "";
	cwd = "";
	owner: DurableSessionOwner | undefined;
	/** Response texts the faux provider answers with, in order. */
	responses: string[] = ["first", "second", "third"];

	async start(): Promise<void> {
		this.events.length = 0;
		this.owner = undefined;
		this.home = await mkdtemp(join(tmpdir(), "nyan-tui-commands-home-"));
		this.agentDir = join(this.home, ".nyan", "agent");
		this.cwd = await mkdtemp(join(tmpdir(), "nyan-tui-commands-cwd-"));
		await mkdir(this.agentDir, { recursive: true });
		vi.stubEnv("HOME", this.home);
		vi.stubEnv("USERPROFILE", this.home);
		vi.stubEnv(ENV_AGENT_DIR, this.agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
	}

	async stop(): Promise<void> {
		await this.owner?.close().catch(() => {});
		this.owner = undefined;
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(this.home, options), rm(this.cwd, options)]);
	}

	/**
	 * Open a session with a faux provider; `probe` records the extension lifecycle of every reopen. `models` selects the
	 * faux models, such as one that supports thinking, and `extraFactories` adds extensions after the probe.
	 */
	async open(
		responses: string[] = this.responses,
		options: {
			readonly models?: FauxModelDefinition[];
			readonly extraFactories?: readonly InlineExtension[];
		} = {},
	): Promise<DurableSessionOwner> {
		this.responses = responses;
		const faux = fauxProvider(options.models === undefined ? {} : { models: options.models });
		faux.setResponses(responses.map((text) => () => fauxAssistantMessage([fauxText(text)])));
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		const events = this.events;
		const probe: InlineExtension = (pi) => {
			pi.on("session_start", (event) => {
				events.push(`start:${event.reason}`);
			});
			pi.on("session_shutdown", (event) => {
				events.push(`shutdown:${event.reason}`);
			});
		};
		this.owner = await DurableSessionOwner.open({
			cwd: this.cwd,
			extensionFactories: [provider, probe, ...(options.extraFactories ?? [])],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd: this.cwd },
		});
		return this.owner;
	}

	async say(current: DurableSessionOwner, text: string): Promise<void> {
		const outcome = await settlement(current.current.controller.submitAndWait(text, "followUp"));
		if (outcome.status !== "done") throw new Error(`submission did not settle: ${outcome.status}`);
	}
}

/** The commands of `current`, as the TUI builds them, with the owner's reopen behind them. */
export async function commandsOf(
	current: DurableSessionOwner,
	ui: Screen,
	product?: DurableCommandProduct,
): Promise<DurableCommands> {
	return DurableCommands.create(
		{
			current: () => ({
				view: current.current.view.current(),
				controller: current.current.controller,
				sessionOps: current.current.sessionOps,
			}),
			readSessionName: () => current.current.sessionOps.getSessionName(),
			...(product === undefined ? {} : { product }),
			reopen: async (request) => {
				await current.reopen(request);
			},
		},
		ui,
	);
}
