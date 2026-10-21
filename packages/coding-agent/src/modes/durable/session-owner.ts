import { join } from "node:path";
import type { OpenDurableOptions, OpenDurableResult } from "../../core/durable/runtime.ts";
import { openDurable } from "../../core/durable/runtime.ts";
import type { SessionStartEvent } from "../../core/extensions/types.ts";
import type { DurableReopenRequest } from "./commands.ts";
import { startupResources } from "./startup.ts";
import type { DurableTuiOpen } from "./tui.ts";

/** The members of an open that a TUI renders and operates on. */
export function tuiof(open: OpenDurableResult): DurableTuiOpen {
	const extensions = open.services.resourceLoader.getExtensions();
	return {
		view: open.view,
		controller: open.controller,
		extensionHost: open.extensionHost,
		sessionOps: open.sessionOps,
		modelRuntime: open.modelRuntime,
		themes: open.themes,
		promptTemplates: open.promptTemplates,
		// The listing a start shows: what loaded in this open, and what the loader could not read.
		resources: startupResources(open.services.resourceLoader),
		// `/bug` reports the model runtime, settings, and extensions of the process, which outlive every session.
		bugReport: {
			modelRuntime: open.modelRuntime,
			settings: open.settings,
			extensions: extensions.extensions,
			extensionErrors: extensions.errors,
		},
	};
}

/** The session file a reopen reports as the one it came from. */
function sessionFileOf(open: OpenDurableResult): string {
	return join(open.view.current().session.directory, "session.sqlite");
}

/**
 * The durable session an interactive run shows, and the one that replaces it.
 *
 * Opening another session keeps the process services: extensions load once per process, so `/new` and `/resume` reuse
 * them and only the session changes (S2). The extension lifecycle is the RPC path's — the session being left shuts
 * down and the next one starts with its reason and the previous file — and the same reopen the RPC adapter runs is the
 * one used here.
 */
export class DurableSessionOwner {
	readonly #options: OpenDurableOptions;
	#open: OpenDurableResult;

	private constructor(options: OpenDurableOptions, open: OpenDurableResult) {
		this.#options = options;
		this.#open = open;
	}

	static async open(options: OpenDurableOptions): Promise<DurableSessionOwner> {
		return new DurableSessionOwner(options, await openDurable(options));
	}

	/** The session shown now. A reopen replaces it. */
	get current(): OpenDurableResult {
		return this.#open;
	}

	get tui(): DurableTuiOpen {
		return tuiof(this.#open);
	}

	/** Close this session and open the requested one with the same services. */
	async reopen(request: DurableReopenRequest): Promise<DurableTuiOpen> {
		if (request.kind === "reload") return this.reload();
		const previous = this.#open;
		const previousSessionFile = sessionFileOf(previous);
		const nextOptions: OpenDurableOptions = { ...this.#options, services: previous.services };
		if (request.kind === "resume") {
			// Open and lock the target before closing this one, so a bad path or a lock leaves this session intact. Its
			// `session_start` waits until this one has shut down: an extension that tears its state down on shutdown must
			// not receive that after the new session's start.
			const sessionStartEvent: SessionStartEvent = { type: "session_start", reason: "resume", previousSessionFile };
			const next = await openDurable({
				...nextOptions,
				sessionDirectory: request.directory,
				sessionStartEvent,
				deferSessionStart: true,
			});
			try {
				await previous.close("resume");
			} catch (error) {
				await next.close().catch(() => {});
				throw error;
			}
			await next.startSession?.();
			this.#open = next;
			return this.tui;
		}
		// A new session gets its own directory, so nothing conflicts with the one being closed.
		await previous.close("new");
		this.#open = await openDurable({ ...nextOptions, continueSession: false });
		return this.tui;
	}

	/**
	 * Reopen this session's own directory without the cached services, which is what reloads extensions and the files
	 * they load. The session must be closed first because it holds its directory's lock; when the fresh open fails, the
	 * services that were already loaded put the same session back, so a failed reload leaves a working session behind.
	 */
	async reload(): Promise<DurableTuiOpen> {
		const previous = this.#open;
		const previousSessionFile = sessionFileOf(previous);
		const directory = previous.view.current().session.directory;
		await previous.close("reload");
		const sessionStartEvent: SessionStartEvent = { type: "session_start", reason: "reload", previousSessionFile };
		try {
			this.#open = await openDurable({
				...this.#options,
				sessionDirectory: directory,
				sessionStartEvent,
			});
		} catch (error) {
			this.#open = await openDurable({
				...this.#options,
				services: previous.services,
				sessionDirectory: directory,
			});
			throw error;
		}
		return this.tui;
	}

	async close(): Promise<void> {
		await this.#open.close();
	}
}
