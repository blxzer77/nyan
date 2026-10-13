/**
 * Host-neutral ArtifactStore contract for immutable memory payloads.
 *
 * The port binds one artifact version to one immutable content hash plus its
 * scope and basis revision, and it never exposes a physical path: `storageRef`
 * is a logical `memory://<artifactId>/<version>/<contentHash>` reference that
 * only a host adapter can produce. Every adapter (the CLI file adapter, or an
 * in-memory adapter) resolves the same helpers in this module, so idempotency,
 * immutability and fail-closed reads cannot drift per host.
 *
 * This module performs no filesystem, SQLite, Pi or network I/O. It also never
 * stores prompts, transcripts, messages, WorkItem, Gate or settlement state;
 * those remain Kernel and Pi facts.
 */

import { createHash } from "node:crypto";

import {
  PACTILE_LOGICAL_ID_PATTERN,
  canonicalizePactileJsonV1,
  isPlainRecordV1,
} from "../../../shared/validation.js";

export const ARTIFACT_STORE_SCHEMA_VERSION = 1 as const;
export type ArtifactStoreSchemaVersion = typeof ARTIFACT_STORE_SCHEMA_VERSION;

export const ARTIFACT_SCOPES_V1 = ["run", "workItem", "project"] as const;
export type ArtifactScopeV1 = (typeof ARTIFACT_SCOPES_V1)[number];

export const ARTIFACT_STORAGE_SCHEME_V1 = "memory" as const;
export const ARTIFACT_CONTENT_HASH_PREFIX_V1 = "sha256:" as const;
export const ARTIFACT_ID_MAX_LENGTH_V1 = 96 as const;
export const ARTIFACT_SCOPE_KEY_MAX_LENGTH_V1 = 512 as const;
export const ARTIFACT_STORAGE_REF_MAX_LENGTH_V1 = 256 as const;

const ARTIFACT_CONTENT_HASH_PATTERN_V1 = /^sha256:[0-9a-f]{64}$/u;
const ARTIFACT_STORAGE_REF_PATTERN_V1 =
  /^memory:\/\/([a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*)\/([1-9]\d*)\/([0-9a-f]{64})$/u;
const ARTIFACT_CONTROL_CHARACTER_PATTERN_V1 = /\p{Cc}/u;

export type ArtifactStoreJsonValueV1 =
  | string
  | number
  | boolean
  | null
  | readonly ArtifactStoreJsonValueV1[]
  | { readonly [key: string]: ArtifactStoreJsonValueV1 };

/**
 * Structured, decidable failure codes. `read` never returns content for any of
 * these outcomes and callers must not degrade into a full-disk search.
 */
export type ArtifactStoreFailureCodeV1 =
  | "artifact_invalid_input"
  | "artifact_ref_invalid"
  | "artifact_path_escape"
  | "artifact_conflict"
  | "artifact_not_prepared"
  | "artifact_not_found"
  | "artifact_corrupt"
  | "artifact_hash_mismatch"
  | "artifact_size_mismatch"
  | "artifact_scope_mismatch"
  | "artifact_stale"
  | "artifact_io_failed";

export interface ArtifactStoreFailureV1 {
  readonly ok: false;
  readonly code: ArtifactStoreFailureCodeV1;
  readonly message: string;
  readonly artifactId: string | null;
  readonly details: Readonly<Record<string, ArtifactStoreJsonValueV1>> | null;
}

export function artifactStoreFailureV1(
  code: ArtifactStoreFailureCodeV1,
  message: string,
  artifactId: string | null = null,
  details: Readonly<Record<string, ArtifactStoreJsonValueV1>> | null = null,
): ArtifactStoreFailureV1 {
  return Object.freeze({ ok: false as const, code, message, artifactId, details });
}

/** Immutable binding of one artifact version; `storageRef` is logical only. */
export interface ArtifactStoreBindingV1 {
  readonly artifactId: string;
  readonly scope: ArtifactScopeV1;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly storageRef: string;
}

/** Persisted immutable object record: a binding plus its commit timestamp. */
export interface ArtifactStoreObjectV1 extends ArtifactStoreBindingV1 {
  readonly schemaVersion: ArtifactStoreSchemaVersion;
  readonly committedAt: string;
}

export interface ArtifactStoreBindingFieldsV1 {
  readonly artifactId: unknown;
  readonly scope: unknown;
  readonly scopeKey: unknown;
  readonly version: unknown;
  readonly basisRevision: unknown;
  readonly contentHash: unknown;
  readonly byteLength: unknown;
}

export interface ArtifactStoreIdentityFieldsV1 {
  readonly artifactId: unknown;
  readonly scope: unknown;
  readonly scopeKey: unknown;
  readonly version: unknown;
  readonly basisRevision: unknown;
}

export function isArtifactIdV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ARTIFACT_ID_MAX_LENGTH_V1 &&
    PACTILE_LOGICAL_ID_PATTERN.test(value)
  );
}

export function isArtifactVersionV1(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1
  );
}

export function isArtifactBasisRevisionV1(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

export function isArtifactByteLengthV1(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

export function isArtifactContentHashV1(value: unknown): value is string {
  return (
    typeof value === "string" && ARTIFACT_CONTENT_HASH_PATTERN_V1.test(value)
  );
}

export function isArtifactScopeV1(value: unknown): value is ArtifactScopeV1 {
  return (
    typeof value === "string" &&
    (ARTIFACT_SCOPES_V1 as readonly string[]).includes(value)
  );
}

export function isArtifactScopeKeyV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ARTIFACT_SCOPE_KEY_MAX_LENGTH_V1 &&
    value === value.trim() &&
    !ARTIFACT_CONTROL_CHARACTER_PATTERN_V1.test(value)
  );
}

export function validateArtifactStoreIdentityFieldsV1(
  fields: ArtifactStoreIdentityFieldsV1,
): ArtifactStoreFailureV1 | null {
  if (!isArtifactIdV1(fields.artifactId)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      `artifactId must be a lowercase logical id of at most ${ARTIFACT_ID_MAX_LENGTH_V1} characters`,
    );
  }
  const artifactId = fields.artifactId;
  if (!isArtifactScopeV1(fields.scope)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      `scope must be one of: ${ARTIFACT_SCOPES_V1.join(", ")}`,
      artifactId,
    );
  }
  if (!isArtifactScopeKeyV1(fields.scopeKey)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      `scopeKey must be a non-empty stable key of at most ${ARTIFACT_SCOPE_KEY_MAX_LENGTH_V1} characters`,
      artifactId,
    );
  }
  if (!isArtifactVersionV1(fields.version)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "version must be a positive safe integer",
      artifactId,
    );
  }
  if (!isArtifactBasisRevisionV1(fields.basisRevision)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "basisRevision must be a non-negative safe integer",
      artifactId,
    );
  }
  return null;
}

export function validateArtifactStoreBindingFieldsV1(
  fields: ArtifactStoreBindingFieldsV1,
): ArtifactStoreFailureV1 | null {
  const identity = validateArtifactStoreIdentityFieldsV1(fields);
  if (identity !== null) return identity;
  if (!isArtifactContentHashV1(fields.contentHash)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "contentHash must be a sha256:<lowercase hex> fingerprint",
      fields.artifactId as string,
    );
  }
  if (!isArtifactByteLengthV1(fields.byteLength)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "byteLength must be a non-negative safe integer",
      fields.artifactId as string,
    );
  }
  return null;
}

export interface ArtifactStoreStorageRefV1 {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
}

export type ArtifactStoreStorageRefParseResultV1 =
  | { readonly ok: true; readonly reference: ArtifactStoreStorageRefV1 }
  | ArtifactStoreFailureV1;

/** Build the canonical logical reference; adapters validate before calling. */
export function formatArtifactStorageRefV1(
  artifactId: string,
  version: number,
  contentHash: string,
): string {
  if (!isArtifactIdV1(artifactId)) {
    throw new TypeError("artifactId must be a lowercase logical id");
  }
  if (!isArtifactVersionV1(version)) {
    throw new TypeError("version must be a positive safe integer");
  }
  if (!isArtifactContentHashV1(contentHash)) {
    throw new TypeError(
      "contentHash must be a sha256:<lowercase hex> fingerprint",
    );
  }
  const hex = contentHash.slice(ARTIFACT_CONTENT_HASH_PREFIX_V1.length);
  return `${ARTIFACT_STORAGE_SCHEME_V1}://${artifactId}/${version}/${hex}`;
}

/**
 * Parse a logical reference without touching storage. Absolute paths, drive
 * letters, backslashes, `..`, percent encoding, query/fragment parts and
 * non-canonical hashes all fail closed.
 */
export function parseArtifactStorageRefV1(
  storageRef: unknown,
): ArtifactStoreStorageRefParseResultV1 {
  if (
    typeof storageRef !== "string" ||
    storageRef.length === 0 ||
    storageRef.length > ARTIFACT_STORAGE_REF_MAX_LENGTH_V1 ||
    storageRef !== storageRef.trim()
  ) {
    return artifactStoreFailureV1(
      "artifact_ref_invalid",
      "storageRef must be a non-empty memory:// logical reference",
    );
  }
  if (
    storageRef.includes("\\") ||
    storageRef.includes("%") ||
    storageRef.includes("?") ||
    storageRef.includes("#") ||
    ARTIFACT_CONTROL_CHARACTER_PATTERN_V1.test(storageRef)
  ) {
    return artifactStoreFailureV1(
      "artifact_ref_invalid",
      "storageRef must not contain path separators, percent encoding, query or fragment parts",
    );
  }
  const match = ARTIFACT_STORAGE_REF_PATTERN_V1.exec(storageRef);
  if (match === null) {
    return artifactStoreFailureV1(
      "artifact_ref_invalid",
      "storageRef must be a memory://<artifactId>/<version>/<contentHash> logical reference",
    );
  }
  const artifactId = match[1] ?? "";
  const version = Number(match[2] ?? "");
  const hex = match[3] ?? "";
  const reference: ArtifactStoreStorageRefV1 = Object.freeze({
    artifactId,
    version,
    contentHash: `${ARTIFACT_CONTENT_HASH_PREFIX_V1}${hex}`,
  });
  return Object.freeze({ ok: true as const, reference });
}

/** Stable content hash used by every adapter and by read verification. */
export function hashArtifactContentV1(content: Uint8Array): string {
  if (!(content instanceof Uint8Array)) {
    throw new TypeError("content must be a Uint8Array");
  }
  return `${ARTIFACT_CONTENT_HASH_PREFIX_V1}${createHash("sha256")
    .update(content)
    .digest("hex")}`;
}

/**
 * Compare an existing binding with a candidate for the same artifact version.
 * Identical bindings replay idempotently; any difference is an immutable
 * conflict and must be rejected, never overwritten.
 */
export function compareArtifactStoreBindingsV1(
  existing: ArtifactStoreBindingV1,
  candidate: ArtifactStoreBindingV1,
): ArtifactStoreFailureV1 | null {
  const conflict = (
    field: string,
    existingValue: string | number,
    candidateValue: string | number,
  ): ArtifactStoreFailureV1 =>
    artifactStoreFailureV1(
      "artifact_conflict",
      `immutable artifact version ${candidate.artifactId}/${candidate.version} is already bound to a different ${field}`,
      candidate.artifactId,
      { field, existing: existingValue, candidate: candidateValue },
    );
  if (existing.artifactId !== candidate.artifactId) {
    return conflict("artifactId", existing.artifactId, candidate.artifactId);
  }
  if (existing.version !== candidate.version) {
    return conflict("version", existing.version, candidate.version);
  }
  if (existing.contentHash !== candidate.contentHash) {
    return conflict("contentHash", existing.contentHash, candidate.contentHash);
  }
  if (existing.byteLength !== candidate.byteLength) {
    return conflict("byteLength", existing.byteLength, candidate.byteLength);
  }
  if (existing.basisRevision !== candidate.basisRevision) {
    return conflict(
      "basisRevision",
      existing.basisRevision,
      candidate.basisRevision,
    );
  }
  if (existing.scope !== candidate.scope) {
    return conflict("scope", existing.scope, candidate.scope);
  }
  if (existing.scopeKey !== candidate.scopeKey) {
    return conflict("scopeKey", existing.scopeKey, candidate.scopeKey);
  }
  if (existing.storageRef !== candidate.storageRef) {
    return conflict("storageRef", existing.storageRef, candidate.storageRef);
  }
  return null;
}

export interface ArtifactStoreReadExpectationV1 {
  readonly scope?: ArtifactScopeV1;
  readonly scopeKey?: string;
  readonly basisRevision?: number;
  readonly contentHash?: string;
  readonly byteLength?: number;
}

/**
 * Verify the caller's read expectations against an immutable binding before
 * any blob is touched. Returns `null` only when every requested fact matches.
 */
export function verifyArtifactStoreExpectationsV1(
  binding: ArtifactStoreBindingV1,
  expectation: ArtifactStoreReadExpectationV1 = {},
): ArtifactStoreFailureV1 | null {
  if (expectation.scope !== undefined && expectation.scope !== binding.scope) {
    return artifactStoreFailureV1(
      "artifact_scope_mismatch",
      `stored artifact scope '${binding.scope}' does not match the requested scope '${expectation.scope}'`,
      binding.artifactId,
      { stored: binding.scope, requested: expectation.scope },
    );
  }
  if (
    expectation.scopeKey !== undefined &&
    expectation.scopeKey !== binding.scopeKey
  ) {
    return artifactStoreFailureV1(
      "artifact_scope_mismatch",
      "stored artifact scopeKey does not match the requested scopeKey",
      binding.artifactId,
      { requested: expectation.scopeKey },
    );
  }
  if (
    expectation.contentHash !== undefined &&
    expectation.contentHash !== binding.contentHash
  ) {
    return artifactStoreFailureV1(
      "artifact_hash_mismatch",
      "stored artifact content hash does not match the requested content hash",
      binding.artifactId,
      {
        stored: binding.contentHash,
        requested: expectation.contentHash,
      },
    );
  }
  if (
    expectation.byteLength !== undefined &&
    expectation.byteLength !== binding.byteLength
  ) {
    return artifactStoreFailureV1(
      "artifact_size_mismatch",
      "stored artifact byte length does not match the requested byte length",
      binding.artifactId,
      {
        stored: binding.byteLength,
        requested: expectation.byteLength,
      },
    );
  }
  if (
    expectation.basisRevision !== undefined &&
    expectation.basisRevision !== binding.basisRevision
  ) {
    return artifactStoreFailureV1(
      "artifact_stale",
      `stored artifact basis revision ${binding.basisRevision} is not the requested revision ${expectation.basisRevision}`,
      binding.artifactId,
      {
        stored: binding.basisRevision,
        requested: expectation.basisRevision,
      },
    );
  }
  return null;
}

/**
 * Recompute size and hash of stored bytes against the committed binding.
 * Tampering and truncation are detected here and never returned as content.
 */
export function verifyArtifactStoreContentV1(
  binding: ArtifactStoreBindingV1,
  content: Uint8Array,
): ArtifactStoreFailureV1 | null {
  if (content.byteLength !== binding.byteLength) {
    return artifactStoreFailureV1(
      "artifact_size_mismatch",
      `stored payload has ${content.byteLength} bytes but ${binding.byteLength} were committed`,
      binding.artifactId,
      { stored: binding.byteLength, actual: content.byteLength },
    );
  }
  const actualHash = hashArtifactContentV1(content);
  if (actualHash !== binding.contentHash) {
    return artifactStoreFailureV1(
      "artifact_hash_mismatch",
      "stored payload does not match the committed content hash",
      binding.artifactId,
      { committed: binding.contentHash, actual: actualHash },
    );
  }
  return null;
}

/**
 * Verify a stored payload against its immutable binding and the caller's read
 * expectations. Returns `null` only when the exact bytes are proven; otherwise
 * a structured failure and no content.
 */
export function verifyArtifactStoreReadV1(
  binding: ArtifactStoreBindingV1,
  content: Uint8Array,
  expectation: ArtifactStoreReadExpectationV1 = {},
): ArtifactStoreFailureV1 | null {
  const expectationFailure = verifyArtifactStoreExpectationsV1(
    binding,
    expectation,
  );
  if (expectationFailure !== null) return expectationFailure;
  return verifyArtifactStoreContentV1(binding, content);
}

/** Decode a validated binding, including storageRef consistency. */
export function decodeArtifactStoreBindingV1(
  value: unknown,
): ArtifactStoreBindingV1 | null {
  if (!isPlainRecordV1(value)) return null;
  if (
    validateArtifactStoreBindingFieldsV1({
      artifactId: value.artifactId,
      scope: value.scope,
      scopeKey: value.scopeKey,
      version: value.version,
      basisRevision: value.basisRevision,
      contentHash: value.contentHash,
      byteLength: value.byteLength,
    }) !== null
  ) {
    return null;
  }
  const parsed = parseArtifactStorageRefV1(value.storageRef);
  if (!parsed.ok) return null;
  const reference = parsed.reference;
  if (
    reference.artifactId !== value.artifactId ||
    reference.version !== value.version ||
    reference.contentHash !== value.contentHash
  ) {
    return null;
  }
  return Object.freeze({
    artifactId: value.artifactId as string,
    scope: value.scope as ArtifactScopeV1,
    scopeKey: value.scopeKey as string,
    version: value.version as number,
    basisRevision: value.basisRevision as number,
    contentHash: value.contentHash as string,
    byteLength: value.byteLength as number,
    storageRef: value.storageRef as string,
  });
}

/** Decode a persisted immutable object record. Returns `null` when damaged. */
export function decodeArtifactStoreObjectV1(
  value: unknown,
): ArtifactStoreObjectV1 | null {
  if (!isPlainRecordV1(value)) return null;
  if (value.schemaVersion !== ARTIFACT_STORE_SCHEMA_VERSION) return null;
  const binding = decodeArtifactStoreBindingV1(value);
  if (binding === null) return null;
  const committedAt = value.committedAt;
  if (
    typeof committedAt !== "string" ||
    committedAt.length === 0 ||
    Number.isNaN(Date.parse(committedAt))
  ) {
    return null;
  }
  return Object.freeze({
    ...binding,
    schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
    committedAt,
  });
}

/** Canonical JSON encoding of an immutable object record. */
export function encodeArtifactStoreObjectV1(
  object: ArtifactStoreObjectV1,
): string {
  return canonicalizePactileJsonV1(object);
}

export interface ArtifactStorePrepareInputV1 {
  readonly artifactId: string;
  readonly scope: ArtifactScopeV1;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly content: Uint8Array;
  /** Optional caller integrity claim; a mismatch fails closed. */
  readonly expectedContentHash?: string;
}

export interface ArtifactStoreCommitInputV1 {
  readonly artifactId: string;
  readonly scope: ArtifactScopeV1;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface ArtifactStoreReadInputV1 {
  readonly artifactId: string;
  readonly version: number;
  readonly storageRef: string;
  readonly scope?: ArtifactScopeV1;
  readonly scopeKey?: string;
  readonly basisRevision?: number;
  readonly contentHash?: string;
  readonly byteLength?: number;
}

export interface ArtifactStorePrepareSuccessV1 {
  readonly ok: true;
  readonly replay: boolean;
  readonly identity: ArtifactStoreBindingV1;
  readonly preparedAt: string;
}

export interface ArtifactStoreCommitSuccessV1 {
  readonly ok: true;
  readonly replay: boolean;
  readonly identity: ArtifactStoreBindingV1;
  readonly committedAt: string;
}

export interface ArtifactStoreReadSuccessV1 {
  readonly ok: true;
  readonly identity: ArtifactStoreBindingV1;
  readonly content: Uint8Array;
}

export type ArtifactStorePrepareResultV1 =
  | ArtifactStorePrepareSuccessV1
  | ArtifactStoreFailureV1;

export type ArtifactStoreCommitResultV1 =
  | ArtifactStoreCommitSuccessV1
  | ArtifactStoreFailureV1;

export type ArtifactStoreReadResultV1 =
  | ArtifactStoreReadSuccessV1
  | ArtifactStoreFailureV1;

export function validateArtifactStorePrepareInputV1(
  input: unknown,
): ArtifactStoreFailureV1 | null {
  if (!isPlainRecordV1(input)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "prepare input must be an object",
    );
  }
  const identity = validateArtifactStoreIdentityFieldsV1({
    artifactId: input.artifactId,
    scope: input.scope,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
  });
  if (identity !== null) return identity;
  if (!(input.content instanceof Uint8Array)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "content must be a Uint8Array",
      input.artifactId as string,
    );
  }
  if (
    input.expectedContentHash !== undefined &&
    !isArtifactContentHashV1(input.expectedContentHash)
  ) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "expectedContentHash must be a sha256:<lowercase hex> fingerprint",
      input.artifactId as string,
    );
  }
  return null;
}

export function validateArtifactStoreCommitInputV1(
  input: unknown,
): ArtifactStoreFailureV1 | null {
  if (!isPlainRecordV1(input)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "commit input must be an object",
    );
  }
  const binding = validateArtifactStoreBindingFieldsV1({
    artifactId: input.artifactId,
    scope: input.scope,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    contentHash: input.contentHash,
    byteLength: input.byteLength,
  });
  if (binding !== null) return binding;
  return null;
}

export function validateArtifactStoreReadInputV1(
  input: unknown,
): ArtifactStoreFailureV1 | null {
  if (!isPlainRecordV1(input)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "read input must be an object",
    );
  }
  if (!isArtifactIdV1(input.artifactId)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      `artifactId must be a lowercase logical id of at most ${ARTIFACT_ID_MAX_LENGTH_V1} characters`,
    );
  }
  const artifactId = input.artifactId;
  if (!isArtifactVersionV1(input.version)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "version must be a positive safe integer",
      artifactId,
    );
  }
  if (typeof input.storageRef !== "string" || input.storageRef.length === 0) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "storageRef must be a non-empty string",
      artifactId,
    );
  }
  if (input.scope !== undefined && !isArtifactScopeV1(input.scope)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      `scope must be one of: ${ARTIFACT_SCOPES_V1.join(", ")}`,
      artifactId,
    );
  }
  if (input.scopeKey !== undefined && !isArtifactScopeKeyV1(input.scopeKey)) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "scopeKey must be a non-empty stable key",
      artifactId,
    );
  }
  if (
    input.basisRevision !== undefined &&
    !isArtifactBasisRevisionV1(input.basisRevision)
  ) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "basisRevision must be a non-negative safe integer",
      artifactId,
    );
  }
  if (
    input.contentHash !== undefined &&
    !isArtifactContentHashV1(input.contentHash)
  ) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "contentHash must be a sha256:<lowercase hex> fingerprint",
      artifactId,
    );
  }
  if (
    input.byteLength !== undefined &&
    !isArtifactByteLengthV1(input.byteLength)
  ) {
    return artifactStoreFailureV1(
      "artifact_invalid_input",
      "byteLength must be a non-negative safe integer",
      artifactId,
    );
  }
  return null;
}

/** Never returns content on failure; callers cannot fall back to a search. */
export interface ArtifactStorePort {
  prepare(input: ArtifactStorePrepareInputV1): Promise<ArtifactStorePrepareResultV1>;
  commitImmutable(
    input: ArtifactStoreCommitInputV1,
  ): Promise<ArtifactStoreCommitResultV1>;
  read(input: ArtifactStoreReadInputV1): Promise<ArtifactStoreReadResultV1>;
}
