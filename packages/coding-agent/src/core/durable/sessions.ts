import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.ts";

export const DURABLE_SESSION_METADATA_FILE = "session.json";

export interface DurableSessionMetadata {
	readonly cwd?: string;
	readonly name?: string;
}

export type DurableSessionErrorCode =
	| "DURABLE_SESSION_DIRECTORY_REQUIRED"
	| "DURABLE_SESSION_NOT_FOUND"
	| "DURABLE_SESSION_AMBIGUOUS"
	| "DURABLE_SESSION_LOCKED"
	| "DURABLE_SESSION_CWD_MISSING"
	| "DURABLE_SESSION_CWD_NOT_FOUND";

/** A named failure that can be carried through the RPC error string without losing its stable code. */
export class DurableSessionError extends Error {
	readonly code: DurableSessionErrorCode;

	constructor(code: DurableSessionErrorCode, message: string, cause?: unknown) {
		super(`[${code}] ${message}`, cause === undefined ? undefined : { cause });
		this.name = "DurableSessionError";
		this.code = code;
	}
}

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/**
 * Where this process keeps its durable sessions. `main` resolves it from `--session-dir` and `--no-session` before any
 * session is opened, because those flags decide where a session is created and what its database is.
 */
export interface DurableSessionStore {
	/** The directory the per-working-directory stores live under; the agent directory's `sessions-durable` by default. */
	readonly root?: string;
	/** Keep the session in memory: no session directory and no `session.sqlite` is written. */
	readonly memory?: boolean;
}

/** The database a memory-backed session opens: SQLite's own in-memory database, which the adapter does not create. */
export const MEMORY_SESSION_DATABASE = ":memory:";

/** A session directory is named `<epoch milliseconds>-<uuid>`, as `selectSession` creates it. */
const SESSION_DIRECTORY_NAME = /^(\d{13})-[0-9a-f-]{36}$/u;

let processStore: DurableSessionStore = {};

/**
 * Set the store every later open in this process uses. A reopen (`/new`, `/resume`) is the same run, so it must write
 * where the command line said; a caller that knows its own store passes it to `selectSession` instead.
 */
export function setDurableSessionStore(store: DurableSessionStore): void {
	processStore = store;
}

/** The store this process opens sessions in. */
export function getDurableSessionStore(): DurableSessionStore {
	return processStore;
}

/** The directory the stores of every working directory live under. */
export function durableSessionStoreRoot(store: DurableSessionStore = processStore): string {
	return store.root === undefined ? join(getAgentDir(), "sessions-durable") : resolve(store.root);
}

/** One durable session a store holds. */
export interface DurableSessionEntry {
	readonly id: string;
	readonly directory: string;
	readonly name?: string;
	/** The session's creation time, taken from its directory name. */
	readonly created: Date;
}

export async function readSessionMetadata(directory: string): Promise<DurableSessionMetadata> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(directory, DURABLE_SESSION_METADATA_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const metadata = parsed as Record<string, unknown>;
		return {
			...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
			...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
		};
	} catch {
		return {};
	}
}

export async function writeSessionMetadata(directory: string, metadata: DurableSessionMetadata): Promise<void> {
	// A memory-backed session keeps this one file and nothing else, so its directory appears only when a name is stored.
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, DURABLE_SESSION_METADATA_FILE), `${JSON.stringify(metadata)}\n`, "utf8");
}

/**
 * The directory holding a working directory's durable sessions. Only a hash of the canonical cwd, so a moved or
 * symlinked checkout keeps its own store instead of reading another one's.
 */
async function sessionRoot(cwdInput: string, store: DurableSessionStore): Promise<{ cwd: string; root: string }> {
	const cwd = await realpath(resolve(cwdInput));
	return {
		cwd,
		root: join(durableSessionStoreRoot(store), createHash("sha256").update(cwd).digest("hex").slice(0, 24)),
	};
}

/** The sessions a store directory holds, newest first. A directory without `session.sqlite` never started a session. */
async function sessionsIn(root: string): Promise<DurableSessionEntry[]> {
	const sessions: DurableSessionEntry[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const match = SESSION_DIRECTORY_NAME.exec(entry.name);
		if (!entry.isDirectory() || match === null) continue;
		const directory = join(root, entry.name);
		try {
			if (!(await stat(join(directory, "session.sqlite"))).isFile()) continue;
		} catch {
			continue;
		}
		const metadata = await readSessionMetadata(directory);
		sessions.push({
			id: entry.name,
			directory,
			...(metadata.name === undefined ? {} : { name: metadata.name }),
			created: new Date(Number(match[1])),
		});
	}
	// Newest first: the directory name starts with its creation time, so ordering the names orders the sessions.
	return sessions.sort((left, right) => right.id.localeCompare(left.id));
}

/** The sessions of `cwd`'s own store, newest first. */
export async function listSessionDirectory(
	cwdInput: string,
	store: DurableSessionStore = processStore,
): Promise<DurableSessionEntry[]> {
	if (store.memory === true) return [];
	const { root } = await sessionRoot(cwdInput, store);
	try {
		return await sessionsIn(root);
	} catch {
		// No store for this directory yet is the ordinary case for a first run, not a failure.
		return [];
	}
}

/** Every session below the store's root, whichever working directory it belongs to, newest first. */
async function sessionsBelowRoot(store: DurableSessionStore): Promise<DurableSessionEntry[]> {
	const sessions: DurableSessionEntry[] = [];
	for (const entry of await readdir(durableSessionStoreRoot(store), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			sessions.push(...(await sessionsIn(join(durableSessionStoreRoot(store), entry.name))));
		} catch {
			// A store directory that went away while it was being read holds no session to find.
		}
	}
	return sessions.sort((left, right) => right.id.localeCompare(left.id));
}

/**
 * The durable session `value` names: the working directory's own store first, then any store below the root, by exact
 * id or by a prefix only one session carries. Not found is `undefined`; a prefix several sessions carry is an error,
 * because opening either of them would be a guess.
 */
export async function findSessionDirectory(
	value: string,
	cwdInput: string,
	store: DurableSessionStore = processStore,
): Promise<DurableSessionEntry | undefined> {
	const scopes = async (): Promise<DurableSessionEntry[][]> => [
		await listSessionDirectory(cwdInput, store),
		await sessionsBelowRoot(store).catch(() => []),
	];
	for (const sessions of await scopes()) {
		const exact = sessions.find((session) => session.id === value);
		if (exact !== undefined) return exact;
		const prefixed = sessions.filter((session) => session.id.startsWith(value));
		if (prefixed.length === 1) return prefixed[0];
		if (prefixed.length > 1) {
			throw new DurableSessionError(
				"DURABLE_SESSION_AMBIGUOUS",
				`More than one durable session starts with ${value}: ${prefixed.map((session) => session.id).join(", ")}`,
			);
		}
	}
	return undefined;
}

/** The newest resumable session directory under `root`, or undefined. */
async function newestSessionIn(root: string): Promise<string | undefined> {
	const candidates: string[] = [];
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (entry.isDirectory() && SESSION_DIRECTORY_NAME.test(entry.name)) candidates.push(entry.name);
		}
	} catch {
		// No store for this directory yet is the ordinary case for a first run, not a failure.
		return undefined;
	}
	candidates.sort().reverse();
	for (const candidate of candidates) {
		try {
			if ((await stat(join(root, candidate, "session.sqlite"))).isFile()) return join(root, candidate);
		} catch {
			// A directory left before SQLite was created is not a resumable session.
		}
	}
	return undefined;
}

/**
 * Whether `cwd` has a resumable durable session, without creating, locking, or writing anything. The `--continue`
 * routing asks this before it decides which runtime to start, so a missing store must not leave a directory behind.
 */
export async function hasDurableSession(cwdInput: string, store: DurableSessionStore = processStore): Promise<boolean> {
	// An ephemeral session is never stored, so there is never one to continue.
	if (store.memory === true) return false;
	const { root } = await sessionRoot(cwdInput, store);
	return (await newestSessionIn(root)) !== undefined;
}

/**
 * A session that is written nowhere: its database is SQLite's in-memory one, and its directory holds only a display
 * name. Releasing it removes that directory, so nothing a `--no-session` run wrote outlives it.
 */
function memorySession(cwd: string): SessionLocation {
	const id = `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`;
	const directory = join(tmpdir(), `${APP_NAME}-nosession`, id);
	return {
		id,
		directory,
		database: MEMORY_SESSION_DATABASE,
		cwd,
		created: true,
		release: async () => {
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** A new session for `cwd`, or its newest one with `continueSession`. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	store: DurableSessionStore = processStore,
): Promise<SessionLocation> {
	const { cwd, root } = await sessionRoot(cwdInput, store);
	if (store.memory === true) return memorySession(cwd);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const newest = await newestSessionIn(root);
		if (newest === undefined) {
			throw new DurableSessionError("DURABLE_SESSION_NOT_FOUND", `No durable session exists for ${cwd}`);
		}
		directory = newest;
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
		throw new DurableSessionError(
			"DURABLE_SESSION_LOCKED",
			`Session is already open in another process: ${directory}`,
			error,
		);
	}
	if (created) {
		try {
			await writeSessionMetadata(directory, { cwd });
		} catch (error) {
			await release().catch(() => {});
			throw error;
		}
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}

/** Open and lock exactly one existing durable session directory without changing selection semantics. */
export async function openSessionDirectory(directoryInput: string): Promise<SessionLocation> {
	const input = resolve(directoryInput);
	let directory: string;
	try {
		directory = await realpath(input);
	} catch (error) {
		throw new DurableSessionError("DURABLE_SESSION_NOT_FOUND", `Durable session does not exist: ${input}`, error);
	}
	let directoryStats: Awaited<ReturnType<typeof stat>>;
	try {
		directoryStats = await stat(directory);
	} catch (error) {
		throw new DurableSessionError("DURABLE_SESSION_NOT_FOUND", `Durable session does not exist: ${directory}`, error);
	}
	if (!directoryStats.isDirectory()) {
		throw new DurableSessionError(
			"DURABLE_SESSION_DIRECTORY_REQUIRED",
			`Durable session switching accepts a session directory, not a file: ${directory}. Legacy JSONL sessions are read-only; use --resume or --session to open them.`,
		);
	}
	const database = join(directory, "session.sqlite");
	try {
		if (!(await stat(database)).isFile()) throw new Error("not a regular file");
	} catch (error) {
		throw new DurableSessionError(
			"DURABLE_SESSION_NOT_FOUND",
			`Not a durable session directory: ${directory}`,
			error,
		);
	}

	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(directory, {
			realpath: false,
			stale: 10_000,
			retries: 0,
		});
	} catch (error) {
		throw new DurableSessionError("DURABLE_SESSION_LOCKED", `Durable session is already open: ${directory}`, error);
	}

	try {
		const metadata = await readSessionMetadata(directory);
		if (metadata.cwd === undefined || metadata.cwd.length === 0) {
			throw new DurableSessionError(
				"DURABLE_SESSION_CWD_MISSING",
				`Durable session has no recorded working directory: ${directory}`,
			);
		}
		let cwd: string;
		try {
			cwd = await realpath(resolve(metadata.cwd));
			if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
		} catch (error) {
			throw new DurableSessionError(
				"DURABLE_SESSION_CWD_NOT_FOUND",
				`Recorded durable session working directory does not exist: ${metadata.cwd} (${directory})`,
				error,
			);
		}
		return { id: basename(directory), directory, database, cwd, created: false, release };
	} catch (error) {
		await release().catch(() => {});
		throw error;
	}
}
