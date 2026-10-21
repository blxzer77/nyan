import type { ConversationId, Seq } from "../types.ts";

declare const artifactKeyBrand: unique symbol;
declare const artifactScopeBrand: unique symbol;

/**
 * The lowercase hex SHA-256 of an artifact's bytes, which is also its only key: identical bytes are one artifact, and a
 * read recomputes the digest and compares it with this value.
 */
export type ArtifactKey = string & { readonly [artifactKeyBrand]: "sha256" };

/**
 * The opaque owner label an artifact belongs to, so one scope cannot read another's artifacts. The store never parses
 * it; conventionally a conversation is written `conversation:<id>`.
 */
export type ArtifactScope = string & { readonly [artifactScopeBrand]: "artifact-scope" };

const DIGEST = /^[0-9a-f]{64}$/;

/** True when `value` is a lowercase hex SHA-256 digest. */
export function isArtifactDigest(value: string): boolean {
	return DIGEST.test(value);
}

/** Apply the key brand at a boundary that has already validated `digest`. */
export function artifactKey(digest: string): ArtifactKey {
	if (!isArtifactDigest(digest)) throw new TypeError(`Not a SHA-256 digest: ${digest}`);
	return digest as ArtifactKey;
}

/** Apply the scope brand to a non-empty owner label. */
export function artifactScope(label: string): ArtifactScope {
	if (label.length === 0) throw new TypeError("An artifact scope label must not be empty");
	return label as ArtifactScope;
}

/**
 * The committed state an artifact was externalized against: the conversation it belongs to and the commit sequence that
 * was current when it was written. A read returns it so the caller can decide whether the artifact still matches the
 * basis it is about to use it for.
 */
export type ArtifactBasis = {
	readonly conversationId: ConversationId;
	readonly seq: Seq;
};

/** What a read returns about a stored artifact, apart from its bytes. */
export type ArtifactRecord = {
	readonly scope: ArtifactScope;
	readonly key: ArtifactKey;
	readonly basis: ArtifactBasis;
	/** Byte length recorded at write time; a stored file of another length is refused, not returned. */
	readonly length: number;
};

/** A verified artifact: `bytes` hash to `key`, so the caller may rely on both. */
export type ArtifactContent = ArtifactRecord & {
	readonly bytes: Uint8Array;
};

export type ArtifactPut = {
	readonly scope: ArtifactScope;
	readonly bytes: Uint8Array;
	readonly basis: ArtifactBasis;
};

export type ArtifactRead = {
	readonly scope: ArtifactScope;
	readonly key: ArtifactKey;
};

/**
 * The file operations the store needs. Every path is built by the store, so an implementation never has to resolve one.
 * A runtime without a file system passes its own; Node and Bun get the built-in one.
 */
export type ArtifactFileSystem = {
	mkdir(path: string, options: { readonly recursive: true }): Promise<unknown>;
	/** `flag: "wx"` fails when the path exists, so a temporary name is never shared. */
	writeFile(path: string, data: Uint8Array, options: { readonly flag: "wx" }): Promise<unknown>;
	/** Replaces the destination in one step, and does not follow a partially written source. */
	rename(from: string, to: string): Promise<unknown>;
	readFile(path: string): Promise<Uint8Array>;
	readdir(path: string): Promise<readonly string[]>;
};

export type ArtifactStoreOptions = {
	/** Directory that holds the store; created when missing. Two stores over one root see the same artifacts. */
	readonly root: string;
	/** Defaults to `node:fs/promises`, loaded at open time. A runtime without Node built-ins must pass one. */
	readonly filesystem?: ArtifactFileSystem;
};

/**
 * A content-addressed artifact store over one root directory. Reads verify the stored bytes against their key every
 * time and either return a complete, verified artifact or refuse with an `ArtifactError`; there is no partial result.
 */
export type ArtifactStore = {
	/** Stores `bytes` under their digest, visible only to `scope`. Writing the same bytes again changes nothing. */
	put(input: ArtifactPut): Promise<ArtifactRecord>;
	read(input: ArtifactRead): Promise<ArtifactContent>;
	/** Releases nothing: the store holds no open handle. It exists so a host has one shutdown point. */
	close(): Promise<void>;
};
