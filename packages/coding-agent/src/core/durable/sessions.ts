import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";

export const DURABLE_SESSION_METADATA_FILE = "session.json";

export interface DurableSessionMetadata {
	readonly cwd?: string;
	readonly name?: string;
}

export type DurableSessionErrorCode =
	| "DURABLE_SESSION_DIRECTORY_REQUIRED"
	| "DURABLE_SESSION_NOT_FOUND"
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
	await writeFile(join(directory, DURABLE_SESSION_METADATA_FILE), `${JSON.stringify(metadata)}\n`, "utf8");
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
