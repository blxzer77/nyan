import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readSessionMetadata } from "../../core/durable/sessions.ts";

/** One durable session of the directory the current session belongs to. */
export interface DurableSessionSummary {
	readonly directory: string;
	readonly name?: string;
	/** The session's creation time, taken from its directory name. */
	readonly created: Date;
	/** Whether this is the session the picker was opened from. */
	readonly current: boolean;
}

/** A session directory is named `<epoch milliseconds>-<uuid>`, as `core/durable/sessions.ts` creates it. */
const SESSION_DIRECTORY = /^(\d{13})-[0-9a-f-]{36}$/u;

/**
 * The sessions of the current session's own root, newest first.
 *
 * `selectSession` lays sessions out as `<agent dir>/sessions-durable/<hash of cwd>/<directory>`, so every session of the
 * same working directory is a sibling of the open one: the root is its parent, and no cwd hash is recomputed here. A
 * sibling without a `session.sqlite` was left before SQLite was created, or is not a session at all, and is skipped.
 */
export async function listSiblingSessions(currentDirectory: string): Promise<DurableSessionSummary[]> {
	const root = dirname(currentDirectory);
	const current = basename(currentDirectory);
	const sessions: DurableSessionSummary[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const match = SESSION_DIRECTORY.exec(entry.name);
		if (!entry.isDirectory() || match === null) continue;
		const directory = join(root, entry.name);
		try {
			if (!(await stat(join(directory, "session.sqlite"))).isFile()) continue;
		} catch {
			continue;
		}
		const metadata = await readSessionMetadata(directory);
		sessions.push({
			directory,
			...(metadata.name === undefined ? {} : { name: metadata.name }),
			created: new Date(Number(match[1])),
			current: entry.name === current,
		});
	}
	// Newest first: the directory name starts with its creation time, so ordering the names orders the sessions.
	return sessions.sort((left, right) => right.directory.localeCompare(left.directory));
}
