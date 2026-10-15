import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** A new session for `cwd`, or its newest one with `continueSession`. */
export async function selectSession(cwdInput: string, continueSession: boolean): Promise<SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(getAgentDir(), "sessions-durable", createHash("sha256").update(cwd).digest("hex").slice(0, 24));
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const candidates = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.reverse();
		let newest: string | undefined;
		for (const candidate of candidates) {
			try {
				if ((await stat(join(root, candidate, "session.sqlite"))).isFile()) {
					newest = candidate;
					break;
				}
			} catch {
				// A directory left before SQLite was created is not a resumable session.
			}
		}
		if (!newest) throw new Error(`No durable session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		release = await lockfile.lock(directory, {
			realpath: false,
			stale: 10_000,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
