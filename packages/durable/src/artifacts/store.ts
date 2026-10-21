import { idFromNumber, seqFromNumber } from "../ids.ts";
import { ArtifactError } from "./errors.ts";
import {
	type ArtifactContent,
	type ArtifactFileSystem,
	type ArtifactKey,
	type ArtifactPut,
	type ArtifactRead,
	type ArtifactRecord,
	type ArtifactScope,
	type ArtifactStore,
	type ArtifactStoreOptions,
	artifactKey,
	isArtifactDigest,
} from "./types.ts";

/**
 * On-disk form of one artifact record. It is JSON so a store can be inspected and repaired with the tools a host
 * already has, and it carries `format` so a record written by an incompatible version is refused rather than guessed at.
 */
type StoredArtifact = {
	readonly format: number;
	readonly scope: string;
	readonly key: string;
	readonly basis: { readonly conversationId: number; readonly seq: number };
	readonly length: number;
};

const RECORD_FORMAT = 1;
const BLOB_DIRECTORY = "blobs";
const META_DIRECTORY = "meta";
const TEMPORARY_PREFIX = ".tmp-";

function encodeText(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function hexOf(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** The digest the store keys on, computed with WebCrypto so this module imports no Node built-in. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return hexOf(new Uint8Array(digest));
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function readOptional(filesystem: ArtifactFileSystem, path: string): Promise<Uint8Array | undefined> {
	try {
		return await filesystem.readFile(path);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

/**
 * Make `data` visible at `directory/name` in one step, so a crash leaves either the finished file or nothing under that
 * name. The bytes go to a temporary sibling first and are renamed over the target; a crash can leave that temporary
 * file behind, which no read ever looks at and no key can name.
 *
 * Paths are joined with "/" because `node:path` would tie this module to Node; the file APIs of Node, Bun and the
 * runtimes that inject `filesystem` accept it on every platform.
 */
async function writeAtomic(
	filesystem: ArtifactFileSystem,
	directory: string,
	name: string,
	data: Uint8Array,
): Promise<void> {
	await filesystem.mkdir(directory, { recursive: true });
	const temporary = `${directory}/${TEMPORARY_PREFIX}${name}-${globalThis.crypto.randomUUID()}`;
	await filesystem.writeFile(temporary, data, { flag: "wx" });
	await filesystem.rename(temporary, `${directory}/${name}`);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Read a stored record back, refusing one this version did not write or one that names a different artifact. */
function decodeRecord(stored: Uint8Array, scope: ArtifactScope, key: ArtifactKey): ArtifactRecord {
	const corrupt = (detail?: { readonly actualKey?: string }): ArtifactError =>
		new ArtifactError("corrupt", { scope, key, detail });
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(stored));
	} catch {
		throw corrupt();
	}
	if (typeof parsed !== "object" || parsed === null) throw corrupt();
	const record = parsed as Partial<StoredArtifact>;
	if (
		record.format !== RECORD_FORMAT ||
		record.scope !== scope ||
		record.key !== key ||
		typeof record.length !== "number" ||
		typeof record.basis !== "object" ||
		record.basis === null ||
		!isPositiveInteger(record.basis.conversationId) ||
		!isPositiveInteger(record.basis.seq)
	) {
		throw corrupt();
	}
	return {
		scope,
		key,
		basis: {
			conversationId: idFromNumber(record.basis.conversationId),
			seq: seqFromNumber(record.basis.seq),
		},
		length: record.length,
	};
}

/**
 * The default file system, loaded lazily. The specifier is assembled at run time and imported dynamically because a
 * statically resolvable `node:fs/promises` import fails the package's browser bundle check
 * (`scripts/check-browser-smoke.mjs`); a runtime without Node built-ins injects one instead.
 */
async function nodeFileSystem(): Promise<ArtifactFileSystem> {
	const load = (specifier: string): Promise<unknown> => import(specifier);
	const loaded = (await load(`node:${"fs"}/promises`)) as Partial<ArtifactFileSystem>;
	const { mkdir, writeFile, rename, readFile, readdir } = loaded;
	if (!mkdir || !writeFile || !rename || !readFile || !readdir) {
		throw new Error("@ny4n/durable artifacts: this runtime has no node:fs/promises; pass options.filesystem");
	}
	return {
		mkdir: (path, options) => mkdir(path, { recursive: options.recursive }),
		writeFile: (path, data, options) => writeFile(path, data, { flag: options.flag }),
		rename: (from, to) => rename(from, to),
		readFile: (path) => readFile(path),
		readdir: (path) => readdir(path),
	};
}

/**
 * Open the content-addressed artifact store rooted at `options.root`.
 *
 * Layout under the root: `blobs/<first two hex digits>/<key>` holds bytes once per digest across every scope, and
 * `meta/<scope digest>/<key>.json` holds one record per scope. Deduplication is therefore global while visibility stays
 * per scope: the same bytes stored in two scopes is one blob and two records, and a scope that never stored a key reads
 * `scope` rather than content.
 */
export async function openArtifactStore(options: ArtifactStoreOptions): Promise<ArtifactStore> {
	if (typeof globalThis.crypto?.subtle?.digest !== "function") {
		throw new Error(
			"@ny4n/durable artifacts: SHA-256 needs globalThis.crypto.subtle, which this runtime does not have",
		);
	}
	const root = options.root.replace(/[\\/]+$/, "");
	if (root.length === 0) throw new Error("@ny4n/durable artifacts: options.root must name a directory");
	const filesystem = options.filesystem ?? (await nodeFileSystem());
	const blobRoot = `${root}/${BLOB_DIRECTORY}`;
	const metaRoot = `${root}/${META_DIRECTORY}`;
	await filesystem.mkdir(blobRoot, { recursive: true });
	await filesystem.mkdir(metaRoot, { recursive: true });

	const scopeDirectory = async (scope: ArtifactScope): Promise<string> =>
		`${metaRoot}/${await sha256Hex(encodeText(scope))}`;
	const blobDirectory = (key: ArtifactKey): string => `${blobRoot}/${key.slice(0, 2)}`;

	/** Whether another scope holds this key, which separates `scope` from `missing`. */
	async function heldByOtherScope(own: string, key: ArtifactKey): Promise<boolean> {
		let names: readonly string[];
		try {
			names = await filesystem.readdir(metaRoot);
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
		for (const name of names) {
			const directory = `${metaRoot}/${name}`;
			if (directory === own) continue;
			if ((await readOptional(filesystem, `${directory}/${key}.json`)) !== undefined) return true;
		}
		return false;
	}

	return {
		async put(input: ArtifactPut): Promise<ArtifactRecord> {
			const { scope, basis, bytes } = input;
			const key = artifactKey(await sha256Hex(bytes));
			const directory = await scopeDirectory(scope);
			const existing = await readOptional(filesystem, `${directory}/${key}.json`);
			if (existing !== undefined) {
				// Content addressing makes a repeat write a no-op: the first write's basis stays authoritative, because the
				// bytes it describes are the bytes this key already names.
				return decodeRecord(existing, scope, key);
			}
			const record: StoredArtifact = {
				format: RECORD_FORMAT,
				scope,
				key,
				basis: { conversationId: basis.conversationId, seq: basis.seq },
				length: bytes.length,
			};
			// The blob becomes visible before its record: an orphaned blob is invisible, while a record whose blob never
			// arrived would report `missing` for a write that had already returned.
			await writeAtomic(filesystem, blobDirectory(key), key, bytes);
			await writeAtomic(filesystem, directory, `${key}.json`, encodeText(JSON.stringify(record)));
			return { scope, key, basis, length: bytes.length };
		},

		async read(input: ArtifactRead): Promise<ArtifactContent> {
			const { scope, key } = input;
			// A key that is not a digest cannot name a blob this store wrote, and it is never joined into a path.
			if (!isArtifactDigest(key)) throw new ArtifactError("missing", { scope, key });
			const directory = await scopeDirectory(scope);
			const stored = await readOptional(filesystem, `${directory}/${key}.json`);
			if (stored === undefined) {
				const reason = (await heldByOtherScope(directory, key)) ? "scope" : "missing";
				throw new ArtifactError(reason, { scope, key });
			}
			const record = decodeRecord(stored, scope, key);
			const bytes = await readOptional(filesystem, `${blobDirectory(key)}/${key}`);
			if (bytes === undefined) throw new ArtifactError("missing", { scope, key });
			// Length first, so a truncated file reports `length` and a rewritten one of the recorded size reports `corrupt`.
			if (bytes.length !== record.length) {
				throw new ArtifactError("length", {
					scope,
					key,
					detail: { expectedLength: record.length, actualLength: bytes.length },
				});
			}
			const actual = await sha256Hex(bytes);
			if (actual !== key)
				throw new ArtifactError("corrupt", { scope, key, detail: { expectedKey: key, actualKey: actual } });
			return { scope, key, basis: record.basis, length: bytes.length, bytes };
		},

		async close(): Promise<void> {
			// Nothing is held open: every read and write opens and closes its own files.
		},
	};
}
