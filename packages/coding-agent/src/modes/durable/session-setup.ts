import type { OpenDurableResult } from "../../core/durable/runtime.ts";
import { DurableStartupError } from "../../core/durable/startup-error.ts";

/**
 * What the session-selection flags ask of the session this run opens, beyond which session it is: a display name, or a
 * fork. Both come from the command line and are applied before the run shows or submits anything, so the first thing a
 * user sees is the named, forked session they asked for.
 */
export interface DurableSessionSetup {
	/** `--name`: the trimmed name to store; an empty string clears the stored name. */
	readonly name?: string;
	/** `--fork`: the user-message entry to fork from, inside the session this run opened. */
	readonly forkAt?: string;
}

/**
 * Store the name, then fork and show the fork.
 *
 * The fork stays inside the session this run opened. Durable keeps one conversation tree per session directory, and
 * copying a conversation into a different session directory is not a durable operation, so `--fork <entry>` forks from a
 * user message of the selected session rather than from another session file. The forked conversation's label is
 * `fork <id>`, so it is not mistaken for the session it came from or for a subagent's conversation.
 *
 * A fork the user asked for that cannot happen — an entry that does not exist, one that is not a user message, or an
 * extension that refused it — is a startup condition with one message, not a crash.
 */
export async function applySessionSetup(
	open: OpenDurableResult,
	setup: DurableSessionSetup | undefined,
): Promise<void> {
	if (setup === undefined) return;
	try {
		if (setup.name !== undefined) await open.sessionOps.setSessionName(setup.name);
		if (setup.forkAt === undefined) return;
		const forked = await open.sessionOps.fork(setup.forkAt);
		if (forked.cancelled) throw new Error("Fork cancelled by an extension");
		await open.controller.switchConversation(forked.conversationId);
	} catch (error) {
		throw new DurableStartupError([
			{ type: "error", message: error instanceof Error ? error.message : String(error) },
		]);
	}
}
