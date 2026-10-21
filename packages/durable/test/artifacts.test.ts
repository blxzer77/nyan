import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactError,
	type ArtifactFailure,
	type ArtifactFailureDetail,
	type ArtifactFileSystem,
	type ArtifactKey,
	type ArtifactScope,
	artifactKey,
	artifactScope,
	openArtifactStore,
} from "../src/artifacts/index.ts";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import type { ConversationId } from "../src/types.ts";

const tempDirectories = new Set<string>();

afterEach(async () => {
	for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true });
	tempDirectories.clear();
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nyan-artifacts-"));
	tempDirectories.add(directory);
	return directory;
}

/** The same port `openArtifactStore` builds for Node, so a test can replace the one call it needs to interrupt. */
const nodeFileSystem: ArtifactFileSystem = {
	mkdir: (path, options) => mkdir(path, { recursive: options.recursive }),
	writeFile: (path, data, options) => writeFile(path, data, { flag: options.flag }),
	rename: (from, to) => rename(from, to),
	readFile: (path) => readFile(path),
	readdir: (path) => readdir(path),
};

/** Every file under `directory`, absolute and sorted; a missing directory is empty. */
async function filesUnder(directory: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as { readonly code?: string }).code === "ENOENT") return [];
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(path)));
		else files.push(path);
	}
	return files.sort();
}

/** Files a read could see, relative to `root`: a temporary staging file is skipped because no key ever names one. */
async function visibleFiles(root: string): Promise<string[]> {
	return (await filesUnder(root))
		.filter((path) => !basename(path).startsWith(".tmp-"))
		.map((path) => relative(root, path).split("\\").join("/"));
}

function hexOf(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const conversation: ConversationId = idFromNumber(7);
const basis = (seq: number) => ({ conversationId: conversation, seq: seqFromNumber(seq) });
const scope = artifactScope("conversation:7");
const otherScope = artifactScope("conversation:8");
const thirdScope = artifactScope("conversation:9");
const payload = new TextEncoder().encode("tool output: 1f3c9a 4096 bytes of stdout that a masked entry points at\n");
/** The same length as `payload`, so only the digest can tell it apart from a verified read. */
const rewritten = new TextEncoder().encode("x".repeat(payload.length));
/** A digest no scope ever wrote, so the read has to answer from the absence of a record. */
const absentKey = artifactKey(sha256Hex(new TextEncoder().encode("absent artifact")));

type Refusal = {
	readonly name: string;
	/** Read in this scope; defaults to the scope that holds the write. */
	readonly readScope?: ArtifactScope;
	/** Read this key; defaults to the key the write returned. */
	readonly readKey?: ArtifactKey;
	/** Damage the store after the write, before the read. */
	readonly damage?: (blobPath: string) => Promise<void>;
	readonly reason: ArtifactFailure;
	readonly detail: (written: { readonly key: ArtifactKey; readonly length: number }) => ArtifactFailureDetail;
};

const refusals: readonly Refusal[] = [
	{
		// Same length, different content: only a read-time digest can tell, so this pins hash verification.
		name: "a blob rewritten at its recorded length",
		damage: async (blobPath) => {
			await writeFile(blobPath, rewritten);
		},
		reason: "corrupt",
		detail: (written) => ({ expectedKey: written.key, actualKey: sha256Hex(rewritten) }),
	},
	{
		// Pinned verdict: fewer bytes than the record recorded is truncation, reported as `length`.
		name: "a truncated blob",
		damage: async (blobPath) => {
			await writeFile(blobPath, payload.subarray(0, payload.length - 3));
		},
		reason: "length",
		detail: (written) => ({ expectedLength: written.length, actualLength: written.length - 3 }),
	},
	{
		name: "a key no scope ever wrote",
		readKey: absentKey,
		reason: "missing",
		detail: () => ({}),
	},
	{
		// The artifact exists but belongs elsewhere: `scope`, not `missing`, because the two are different facts.
		name: "an artifact another scope holds",
		readScope: otherScope,
		reason: "scope",
		detail: () => ({}),
	},
];

describe("content-addressed artifact store", () => {
	it.each(refusals)("refuses $name and returns no content", async ({ damage, detail, readKey, readScope, reason }) => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });
		const written = await store.put({ scope, basis: basis(10), bytes: payload });
		const blob = (await visibleFiles(root)).find((path) => path.startsWith("blobs/"));
		expect(blob).toBeDefined();
		await damage?.(join(root, blob!));

		const refusal: unknown = await store
			.read({ scope: readScope ?? scope, key: readKey ?? written.key })
			.catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ArtifactError);
		const error = refusal as ArtifactError;
		expect(error.kind).toBe("artifact");
		expect(error.reason).toBe(reason);
		expect(error.detail).toEqual(detail(written));
		expect("bytes" in error).toBe(false);
	});

	it("round-trips the exact bytes, their digest, the basis, and the length", async () => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });

		const record = await store.put({ scope, basis: basis(10), bytes: payload });
		const content = await store.read({ scope, key: record.key });

		expect(record.key).toBe(sha256Hex(payload));
		expect(record).toEqual({ scope, key: record.key, basis: basis(10), length: payload.length });
		expect(content.key).toBe(record.key);
		expect(content.scope).toBe(scope);
		expect(content.basis).toEqual(basis(10));
		expect(content.length).toBe(payload.length);
		// Compared as hex because a backend may hand back a Buffer, which is a Uint8Array of the same bytes.
		expect(hexOf(content.bytes)).toBe(hexOf(payload));
	});

	it("stores identical bytes once", async () => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });

		const first = await store.put({ scope, basis: basis(10), bytes: payload });
		const second = await store.put({ scope, basis: basis(10), bytes: payload });

		const visible = await visibleFiles(root);
		expect(visible.filter((path) => path.startsWith("blobs/"))).toEqual([
			`blobs/${first.key.slice(0, 2)}/${first.key}`,
		]);
		expect(visible.filter((path) => path.endsWith(`${first.key}.json`))).toHaveLength(1);
		expect(visible).toHaveLength(2);
		expect(second).toEqual(first);
	});

	it("keeps the first basis for a repeat write of the same bytes", async () => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });

		const first = await store.put({ scope, basis: basis(10), bytes: payload });
		const second = await store.put({ scope, basis: basis(20), bytes: payload });

		expect(first.basis.seq).toBe(10);
		expect(second.basis.seq).toBe(10);
		expect((await store.read({ scope, key: first.key })).basis.seq).toBe(10);
	});

	it("shares one blob between scopes and keeps each scope's record apart", async () => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });

		const mine = await store.put({ scope, basis: basis(10), bytes: payload });
		const theirs = await store.put({ scope: otherScope, basis: basis(20), bytes: payload });

		expect(theirs.key).toBe(mine.key);
		const visible = await visibleFiles(root);
		expect(visible.filter((path) => path.startsWith("blobs/"))).toHaveLength(1);
		expect(visible.filter((path) => path.endsWith(`${mine.key}.json`))).toHaveLength(2);
		expect((await store.read({ scope, key: mine.key })).basis.seq).toBe(10);
		expect((await store.read({ scope: otherScope, key: mine.key })).basis.seq).toBe(20);

		const refusal: unknown = await store.read({ scope: thirdScope, key: mine.key }).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(ArtifactError);
		expect((refusal as ArtifactError).reason).toBe("scope");
	});

	it("leaves no readable artifact when a write fails before its rename", async () => {
		const root = await tempRoot();
		const interrupted = new Error("rename refused by the test");
		let renames = 0;
		const store = await openArtifactStore({
			root,
			filesystem: {
				...nodeFileSystem,
				rename: async (from, to) => {
					renames += 1;
					if (renames === 1) throw interrupted;
					return rename(from, to);
				},
			},
		});

		await expect(store.put({ scope, basis: basis(10), bytes: payload })).rejects.toBe(interrupted);

		const files = await filesUnder(root);
		expect(files).toHaveLength(1);
		expect(basename(files[0]!)).toMatch(/^\.tmp-/);

		const refusal: unknown = await store
			.read({ scope, key: artifactKey(sha256Hex(payload)) })
			.catch((error) => error);
		expect(refusal).toBeInstanceOf(ArtifactError);
		expect((refusal as ArtifactError).reason).toBe("missing");
	});

	it("still reads what was written after closing and reopening the store", async () => {
		const root = await tempRoot();
		const store = await openArtifactStore({ root });
		const record = await store.put({ scope, basis: basis(10), bytes: payload });
		await store.close();

		const reopened = await openArtifactStore({ root });
		const content = await reopened.read({ scope, key: record.key });

		expect(content.key).toBe(record.key);
		expect(content.basis).toEqual(basis(10));
		expect(hexOf(content.bytes)).toBe(hexOf(payload));
	});
});
