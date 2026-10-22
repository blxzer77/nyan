import { basename, dirname } from "node:path";
import { type DurableSessionPreview, sessionDetailOf, sessionLabelOf } from "../../core/durable/session-preview.ts";
import { type DurableSessionEntry, listSessionsIn } from "../../core/durable/sessions.ts";

/** One durable session of the directory the current session belongs to. */
export interface DurableSessionSummary {
	readonly directory: string;
	readonly name?: string;
	/** The session's creation time, taken from its directory name. */
	readonly created: Date;
	/** What its transcript says about it; absent when its database could not be read. */
	readonly preview?: DurableSessionPreview;
	/** What the picker calls it: the display name, else the first thing asked in it. */
	readonly label: string;
	/** How much it holds and when it was last used. */
	readonly detail: string;
	/** Whether this is the session the picker was opened from. */
	readonly current: boolean;
}

/**
 * The sessions of the current session's own root, newest first.
 *
 * `selectSession` lays sessions out as `<agent dir>/sessions-durable/<hash of cwd>/<directory>`, so every session of the
 * same working directory is a sibling of the open one: the root is its parent, and no cwd hash is recomputed here.
 */
export async function listSiblingSessions(currentDirectory: string): Promise<DurableSessionSummary[]> {
	const current = basename(currentDirectory);
	return (await listSessionsIn(dirname(currentDirectory))).map((session) => summarize(session, current));
}

/** One store entry as the picker shows it, marking the session the picker was opened from. */
export function summarize(session: DurableSessionEntry, currentId: string): DurableSessionSummary {
	return {
		directory: session.directory,
		...(session.name === undefined ? {} : { name: session.name }),
		created: session.created,
		...(session.preview === undefined ? {} : { preview: session.preview }),
		label: sessionLabelOf(session),
		detail: sessionDetailOf(session),
		current: session.id === currentId,
	};
}
