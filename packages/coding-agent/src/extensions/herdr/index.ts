/**
 * Herdr agent-state integration.
 *
 * Herdr is a terminal workspace manager for coding agents. It supports two kinds of agents:
 * the ones it recognizes itself, and the ones that report their own state. Nyan is the second
 * kind: it has no Herdr process detection or screen manifest, so this extension reports Nyan's
 * lifecycle through `herdr pane report-agent`.
 *
 * Reports are the only thing this extension does, and they are driven by events, not by reading
 * the screen:
 *   - `agent_start` / `agent_settled` -> `working` / `idle`
 *   - `ui_prompt_start` / `ui_prompt_end` -> `blocked` and back (every extension UI dialog goes
 *     through the runner's prompt wrapper, so these two cover select, confirm, input, editor and
 *     custom)
 *   - `session_shutdown` (quit) -> `release-agent`, so the pane stops showing an agent at once
 *
 * The extension is a no-op outside a Herdr pane: it requires `HERDR_ENV=1` plus `HERDR_PANE_ID`
 * and `HERDR_BIN_PATH`. Herdr injects all three into every process it starts.
 *
 * See https://herdr.dev/docs/add-herdr-support/ for the reporting contract.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { APP_NAME } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";

/**
 * Integration id. Herdr requires a stable, unique source that does not start with `herdr:`,
 * which is reserved for its own integrations.
 */
const SOURCE = APP_NAME;
/** The name the user sees in the sidebar and in `herdr agent list`. */
const AGENT_LABEL = APP_NAME;

/** Report budget. Reports go to a local socket; a slow Herdr must not slow Nyan down. */
const REPORT_TIMEOUT_MS = 1500;
/** The release on quit gets a shorter budget so it cannot hold up process exit. */
const RELEASE_TIMEOUT_MS = 800;

/** Herdr rejects a resume command longer than this many arguments. */
const MAX_RESUME_ARGS = 64;

type AgentState = "working" | "blocked" | "idle";

/** A session Herdr can ask Nyan to reopen after a Herdr server restart. */
type ResumeTarget = { id: string; path: string };

type SessionRef = { id?: string; path?: string };

/**
 * Herdr runs the reported command in the pane's directory after a server restart, so resuming
 * needs a session that is already on disk.
 *
 * Nyan creates the session file only once the session holds a user or assistant message, while
 * `getSessionFile()` returns the path it will write to. Reporting the resume command before that
 * point stores a command that fails with "No session found matching '<id>'", so the file decides.
 */
export function resumeTarget(ref: SessionRef): ResumeTarget | undefined {
	if (!ref.id || !ref.path) return undefined;
	if (!existsSync(ref.path)) return undefined;
	return { id: ref.id, path: ref.path };
}

/**
 * The command Herdr reopens the pane with. Herdr validates it: the first word must be a plain
 * command on `PATH`, no argument may contain an apostrophe or a control character, and the whole
 * thing is capped at 64 arguments and 8 KiB.
 */
export function resumeArgv(target: ResumeTarget): string[] | undefined {
	const argv = [APP_NAME, "--session", target.id];
	if (argv.some((arg) => /['\u0000-\u001f\u007f]/.test(arg))) return undefined;
	if (argv.length > MAX_RESUME_ARGS) return undefined;
	return argv;
}

/** True only inside a Herdr pane, where Herdr provides the three variables this needs. */
export function isHerdrPane(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_BIN_PATH;
}

export function createHerdrExtension(): ExtensionFactory {
	return (nyan) => {
		if (!isHerdrPane()) return;

		const herdrBin = process.env.HERDR_BIN_PATH as string;
		const paneId = process.env.HERDR_PANE_ID as string;

		/** Only the interactive UI runs in a real PTY that Herdr can display. */
		let rootSession = false;
		let agentActive = false;
		let blockedCount = 0;
		let blockedMessage: string | undefined;
		let sessionRef: SessionRef = {};
		let lastState: AgentState | undefined;
		let lastMessage: string | undefined;
		/** Reported resume id, so a session that lands on disk is reported even when state is unchanged. */
		let lastResumeId: string | undefined;

		/**
		 * Herdr drops a report whose sequence is not higher than the last one it accepted, so the
		 * counter must keep increasing across sessions and restarts: a timestamp base does that.
		 */
		let seq = Date.now() * 1000;
		const nextSeq = (): number => ++seq;

		/** Run one Herdr CLI command. Failures are ignored: Herdr being unavailable must not affect Nyan. */
		const runHerdr = (args: string[], timeoutMs: number): Promise<void> =>
			new Promise((resolve) => {
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					resolve();
				};

				let child: ReturnType<typeof spawn>;
				try {
					child = spawn(herdrBin, args, { stdio: "ignore", windowsHide: true });
				} catch {
					finish();
					return;
				}

				timer = setTimeout(() => {
					child.kill();
					finish();
				}, timeoutMs);

				child.on("error", finish);
				child.on("close", finish);
			});

		const desiredState = (): { state: AgentState; message?: string } => {
			if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
			if (agentActive) return { state: "working" };
			return { state: "idle" };
		};

		const sendState = async (state: AgentState, message?: string): Promise<void> => {
			const args = [
				"pane",
				"report-agent",
				paneId,
				"--source",
				SOURCE,
				"--agent",
				AGENT_LABEL,
				"--state",
				state,
				"--seq",
				String(nextSeq()),
			];
			if (message) args.push("--message", message);

			const target = resumeTarget(sessionRef);
			if (target) {
				args.push("--agent-session-id", target.id, "--agent-session-path", target.path);
				const argv = resumeArgv(target);
				if (argv) args.push("--", ...argv);
			}

			await runHerdr(args, REPORT_TIMEOUT_MS);
		};

		/**
		 * Reports are serialized and only the latest state is kept. Herdr needs the newest state,
		 * not every intermediate one, and a report in flight must not be overtaken.
		 */
		let inFlight = false;
		let queued: { state: AgentState; message?: string } | undefined;

		const drain = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				while (queued) {
					const next = queued;
					queued = undefined;
					await sendState(next.state, next.message);
				}
			} finally {
				inFlight = false;
				if (queued) void drain();
			}
		};

		const publish = (force = false): void => {
			const next = desiredState();
			const resumeId = resumeTarget(sessionRef)?.id;
			if (!force && next.state === lastState && next.message === lastMessage && resumeId === lastResumeId) return;
			lastState = next.state;
			lastMessage = next.message;
			lastResumeId = resumeId;
			queued = next;
			void drain();
		};

		const updateSessionRef = (ctx: unknown): void => {
			const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } })
				?.sessionManager;
			try {
				const id = manager?.getSessionId?.();
				if (typeof id === "string" && id.length > 0) sessionRef = { ...sessionRef, id };
			} catch {
				// Session identity is optional report data; a failure here must not break the session.
			}
			try {
				const file = manager?.getSessionFile?.();
				if (typeof file === "string" && file.length > 0) sessionRef = { ...sessionRef, path: file };
			} catch {
				// See above.
			}
		};

		nyan.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			rootSession = true;
			updateSessionRef(ctx);
			// A reload can replace the extension without a new agent_start, so realign with the
			// session's current idle state.
			agentActive = !ctx.isIdle();
			publish(true);
		});

		nyan.on("agent_start", (_event, ctx) => {
			if (!rootSession) return;
			updateSessionRef(ctx);
			agentActive = true;
			publish();
		});

		nyan.on("agent_settled", (_event, ctx) => {
			if (!rootSession || !ctx.isIdle()) return;
			agentActive = false;
			publish();
		});

		nyan.on("ui_prompt_start", (event) => {
			if (!rootSession) return;
			blockedCount += 1;
			blockedMessage = event.title ?? event.kind;
			publish();
		});

		nyan.on("ui_prompt_end", () => {
			if (!rootSession) return;
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) blockedMessage = undefined;
			publish();
		});

		nyan.on("session_shutdown", (event) => {
			if (!rootSession || event.reason !== "quit") return;
			rootSession = false;
			// Awaited: the runtime tears the extension down after shutdown handlers settle, and a
			// release that is still in flight would otherwise be cut off with the agent left in the pane.
			return runHerdr(
				["pane", "release-agent", paneId, "--source", SOURCE, "--agent", AGENT_LABEL, "--seq", String(nextSeq())],
				RELEASE_TIMEOUT_MS,
			);
		});
	};
}

export default createHerdrExtension();
