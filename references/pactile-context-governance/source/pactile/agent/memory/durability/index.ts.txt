/**
 * Host-neutral Context Memory durability port.
 *
 * This module owns the *order* and the *verification* of a durable memory
 * commit: the immutable `ArtifactStore` payload is committed first, a Durable
 * Memory Receipt second, and a CAS-protected Current Manifest last. Every
 * preflight, read and compaction authorization re-verifies that whole chain,
 * so a partially written or lying store can never make a missing, corrupt or
 * hash-inconsistent receipt look durable.
 *
 * Boundaries kept deliberately:
 * - Storage is injected. `ArtifactStorePort` plus the receipt, manifest, audit
 *   and lease ports are implemented by a host adapter. This module adds no
 *   second store, no second SQLite database, no Kernel writer and no
 *   coordinator.
 * - Only structured fact documents are durable. Prompts, transcripts,
 *   messages, credentials and absolute host paths are rejected before any
 *   write, and disclosure exposes the logical `memory://` reference only.
 * - An unknown effect is never replayed: every failure carries
 *   `reexecute: false` and `replayPolicy: "no_automatic_replay"`.
 * - Provider errors and memory errors stay separated; a provider outage is
 *   never reported as a memory fault and vice versa.
 */

import {
  ARTIFACT_SCOPES_V1,
  formatArtifactStorageRefV1,
  hashArtifactContentV1,
  isArtifactBasisRevisionV1,
  isArtifactByteLengthV1,
  isArtifactContentHashV1,
  isArtifactIdV1,
  isArtifactScopeKeyV1,
  isArtifactScopeV1,
  isArtifactVersionV1,
  parseArtifactStorageRefV1,
  verifyArtifactStoreReadV1,
  type ArtifactScopeV1,
  type ArtifactStorePort,
} from "../artifact-store.js";
import {
  PACTILE_LOGICAL_ID_PATTERN,
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  isPlainRecordV1,
} from "../../../shared/validation.js";
import {
  decideContextSurgeryV1,
  type ContextMemoryPolicyConfigV1,
  type ContextSurgeryActionV1,
  type ContextSurgeryAssuranceV1,
  type ContextSurgeryDecisionV1,
  type DurableExternalizationStatusV1,
  type DurableExternalizationV1,
} from "../../context/policy.js";
import type { ContextCutPointV1 } from "../../context/compaction.js";
import {
  MEMORY_SCOPE_KEY_PREFIX_V1,
  decodeMemoryScopeKeyV1,
} from "../scope.js";

// ── schema identity ─────────────────────────────────────────────────────────

export const MEMORY_DURABILITY_SCHEMA_VERSION = 1 as const;
export type MemoryDurabilitySchemaVersionV1 =
  typeof MEMORY_DURABILITY_SCHEMA_VERSION;

export const MEMORY_FACT_DOCUMENT_KIND_V1 = "memory_fact_document_v1" as const;
export const MEMORY_DURABLE_RECEIPT_KIND_V1 =
  "memory_durable_receipt_v1" as const;
export const MEMORY_CURRENT_MANIFEST_KIND_V1 =
  "memory_current_manifest_v1" as const;
export const MEMORY_READ_RECEIPT_KIND_V1 = "memory_read_receipt_v1" as const;
export const MEMORY_COMPACTION_RECEIPT_KIND_V1 =
  "memory_compaction_receipt_v1" as const;
export const MEMORY_CONTEXT_COMPACTION_RECEIPT_KIND_V1 =
  "context_compaction_receipt_v1" as const;

/** The only supported commit order; exported so hosts and tests can assert it. */
export const MEMORY_COMMIT_ORDER_V1 = [
  "artifact",
  "receipt",
  "manifest",
] as const;
export type MemoryCommitStageV1 = (typeof MEMORY_COMMIT_ORDER_V1)[number];

export const MEMORY_REPLAY_POLICY_V1 = "no_automatic_replay" as const;

/** Scope kinds are exactly the ArtifactStore scope kinds; no new vocabulary. */
export const MEMORY_SCOPES_V1 = ARTIFACT_SCOPES_V1;
export type MemoryScopeV1 = ArtifactScopeV1;

export const MEMORY_MAX_FACTS_V1 = 512 as const;
export const MEMORY_MAX_SUMMARIES_V1 = 256 as const;
export const MEMORY_MAX_STATEMENT_CHARS_V1 = 2_000 as const;
export const MEMORY_MAX_WHEN_TO_READ_CHARS_V1 = 512 as const;
export const MEMORY_MAX_DOCUMENT_BYTES_V1 = 4 * 1024 * 1024;
export const MEMORY_RECEIPT_LIST_LIMIT_V1 = 64 as const;
export const MEMORY_MAX_MESSAGE_CHARS_V1 = 512 as const;

const LOGICAL_ID_MAX_LENGTH_V1 = 96;
const TAG_MAX_CHARS_V1 = 64;
const MAX_TAGS_PER_RECORD_V1 = 16;
const CONTROL_CHARACTER_PATTERN_V1 = /\p{Cc}/u;
const RFC3339_PATTERN_V1 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Fields that may never enter durable memory: Pi prompts, transcripts and
 * messages, plus credential material. The structural key allowlists already
 * make them unrepresentable; this list is the second, explicit line of
 * defence, and it is also applied to the raw payload before decoding.
 */
const FORBIDDEN_KEYS_V1: readonly string[] = [
  "apiKey",
  "api_key",
  // `authorization` is a bounded enum field on the compaction receipt;
  // credential-bearing authorization values remain rejected by the text scan.
  "cookie",
  "credential",
  "credentials",
  "message",
  "messages",
  "password",
  "piSession",
  "prompt",
  "prompts",
  "secret",
  "sessionFile",
  "systemPrompt",
  "token",
  "transcript",
  "transcriptPath",
  "transcripts",
];

/**
 * Heuristic text guards. They are intentionally conservative: durable memory
 * refuses anything that looks like a host path or a credential rather than
 * risk persisting one.
 */
const FORBIDDEN_TEXT_PATTERNS_V1: readonly {
  readonly id: string;
  readonly pattern: RegExp;
}[] = [
  {
    id: "absolute_posix_path",
    pattern: /(?:^|[\s"'(=,:])\/(?:[A-Za-z0-9._-]+\/)+/u,
  },
  { id: "absolute_windows_path", pattern: /(?:^|[\s"'(=,:])[A-Za-z]:[\\/]/u },
  { id: "unc_path", pattern: /\\\\[A-Za-z0-9._$-]+\\/u },
  { id: "file_url", pattern: /file:\/\//iu },
  { id: "authorization_header", pattern: /\bauthorization\s*[:=]/iu },
  { id: "bearer_token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu },
  { id: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    id: "credential_assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S/iu,
  },
];

const DOCUMENT_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "source",
  "scope",
  "scopeKey",
  "basisRevision",
  "facts",
  "summaries",
];
const FACT_RECORD_KEYS_V1: readonly string[] = [
  "factId",
  "statement",
  "basisRevision",
  "tags",
];
const SUMMARY_RECORD_KEYS_V1: readonly string[] = [
  "summaryId",
  "statement",
  "derivedFrom",
];
const RECEIPT_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "receiptId",
  "requestId",
  "requestHash",
  "scope",
  "scopeKey",
  "artifactId",
  "version",
  "basisRevision",
  "contentHash",
  "byteLength",
  "storageRef",
  "factCount",
  "summaryCount",
  "whenToRead",
  "committedAt",
  "receiptHash",
];
const MANIFEST_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "manifestId",
  "scope",
  "scopeKey",
  "revision",
  "previousRevision",
  "entries",
  "committedAt",
  "manifestHash",
];
const MANIFEST_ENTRY_KEYS_V1: readonly string[] = [
  "receiptId",
  "artifactId",
  "version",
  "basisRevision",
  "contentHash",
  "byteLength",
  "storageRef",
  "receiptHash",
  "factCount",
  "summaryCount",
  "whenToRead",
];
const READ_RECEIPT_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "readReceiptId",
  "requestId",
  "requestHash",
  "scope",
  "scopeKey",
  "basisRevision",
  "contentHash",
  "storageRef",
  "manifestRevision",
  "receiptId",
  "factIds",
  "exactFactCount",
  "summaryCount",
  "disclosure",
  "acknowledgedDisclosure",
  "recordedAt",
  "receiptHash",
];
const COMPACTION_RECEIPT_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "compactionReceiptId",
  "requestId",
  "requestHash",
  "scope",
  "scopeKey",
  "basisRevision",
  "action",
  "assurance",
  "reason",
  "authorization",
  "preflightStatus",
  "preflightReason",
  "maskThreshold",
  "compressionThreshold",
  "keep",
  "clearAtLeastPercent",
  "disclosurePath",
  "disclosureFingerprint",
  "whenToRead",
  "errorDomain",
  "errorCode",
  "providerErrorCode",
  "memoryErrorCode",
  "recordedAt",
  "reexecute",
  "replayPolicy",
  "receiptHash",
];
const CONTEXT_COMPACTION_RECEIPT_KEYS_V1: readonly string[] = [
  "schemaVersion",
  "kind",
  "compactionReceiptId",
  "requestId",
  "requestHash",
  "scope",
  "scopeKey",
  "basisRevision",
  "contextOperationId",
  "sourceCursor",
  "committedSourceRevision",
  "contextBasisHash",
  "leaseEpoch",
  "fencingToken",
  "commandId",
  "disclosurePayloadHash",
  "promptAssemblyHash",
  "piCompactionId",
  "piSessionRef",
  "result",
  "summarySource",
  "derivedFrom",
  "cutPoint",
  "oldSnapshotHash",
  "newSnapshotHash",
  "artifactId",
  "artifactVersion",
  "artifactHash",
  "artifactStorageRef",
  "memoryReceiptId",
  "memoryReceiptHash",
  "manifestId",
  "manifestRevision",
  "manifestHash",
  "resultHash",
  "checkpointId",
  "recordedAt",
  "reexecute",
  "replayPolicy",
  "receiptHash",
];

// ── failure model ───────────────────────────────────────────────────────────

export type MemoryDurabilityFailureCodeV1 =
  | "memory_invalid_input"
  | "memory_content_rejected"
  | "memory_request_conflict"
  | "memory_scope_mismatch"
  | "memory_basis_conflict"
  | "memory_receipt_absent"
  | "memory_receipt_pending"
  | "memory_receipt_corrupt"
  | "memory_receipt_hash_mismatch"
  | "memory_receipt_conflict"
  | "memory_manifest_absent"
  | "memory_manifest_corrupt"
  | "memory_manifest_stale"
  | "memory_cas_conflict"
  | "memory_artifact_missing"
  | "memory_artifact_corrupt"
  | "memory_artifact_hash_mismatch"
  | "memory_artifact_scope_mismatch"
  | "memory_artifact_stale"
  | "memory_artifact_conflict"
  | "memory_not_durable"
  | "memory_disclosure_missing"
  | "memory_lease_missing"
  | "memory_lease_fenced"
  | "memory_lease_expired"
  | "memory_audit_write_failed"
  | "memory_store_denied"
  | "memory_store_unavailable";

export type MemoryDurabilityNoteValueV1 = string | number | boolean | null;
export type MemoryDurabilityDetailsV1 = Readonly<
  Record<string, MemoryDurabilityNoteValueV1>
>;

export interface MemoryCommitProgressV1 {
  readonly artifact: boolean;
  readonly receipt: boolean;
  readonly manifest: boolean;
}

export interface MemoryDurabilityFailureV1 {
  readonly ok: false;
  /** Memory-domain failures are never reported as provider failures. */
  readonly domain: "memory";
  readonly code: MemoryDurabilityFailureCodeV1;
  /** Authored message with any host path span redacted. */
  readonly message: string;
  readonly scope: MemoryScopeV1 | null;
  readonly scopeKey: string | null;
  readonly stage: MemoryCommitStageV1 | null;
  readonly progress: MemoryCommitProgressV1 | null;
  readonly details: MemoryDurabilityDetailsV1 | null;
  /** An unproven effect is never replayed automatically. */
  readonly reexecute: false;
  readonly replayPolicy: typeof MEMORY_REPLAY_POLICY_V1;
}

export interface MemoryDurabilityFailureOptionsV1 {
  readonly scope?: MemoryScopeV1 | null;
  readonly scopeKey?: string | null;
  readonly stage?: MemoryCommitStageV1 | null;
  readonly progress?: MemoryCommitProgressV1 | null;
  readonly details?: MemoryDurabilityDetailsV1 | null;
}

/** Strip absolute path spans so an error surface never leaks a host path. */
export function sanitizeMemoryMessageV1(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\s"']*/gu, "<redacted-path>")
    .replace(/\\\\[^\s"']*/gu, "<redacted-path>")
    .replace(
      /(\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*/gu,
      "$1<redacted-path>",
    )
    .replace(/^\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*/u, "<redacted-path>")
    .slice(0, MEMORY_MAX_MESSAGE_CHARS_V1);
}

export function memoryDurabilityFailureV1(
  code: MemoryDurabilityFailureCodeV1,
  message: string,
  options: MemoryDurabilityFailureOptionsV1 = {},
): MemoryDurabilityFailureV1 {
  return Object.freeze({
    ok: false as const,
    domain: "memory" as const,
    code,
    message: sanitizeMemoryMessageV1(message),
    scope: options.scope ?? null,
    scopeKey: options.scopeKey ?? null,
    stage: options.stage ?? null,
    progress: options.progress ?? null,
    details: options.details ?? null,
    reexecute: false as const,
    replayPolicy: MEMORY_REPLAY_POLICY_V1,
  });
}

// ── fact documents ─────────────────────────────────────────────────────────

export interface MemoryFactRecordV1 {
  readonly factId: string;
  readonly statement: string;
  readonly basisRevision: number;
  readonly tags: readonly string[];
}

/**
 * A summary is a different record shape without `factId`, `tags` or canonical
 * evidence, so a summary is structurally incapable of acting as exact fact.
 */
export interface MemorySummaryRecordV1 {
  readonly summaryId: string;
  readonly statement: string;
  readonly derivedFrom: readonly string[];
}

/** The only payload shape that may become durable memory. */
export interface MemoryFactDocumentV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_FACT_DOCUMENT_KIND_V1;
  readonly source: "artifact";
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly facts: readonly MemoryFactRecordV1[];
  readonly summaries: readonly MemorySummaryRecordV1[];
}

function isLogicalIdV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LOGICAL_ID_MAX_LENGTH_V1 &&
    PACTILE_LOGICAL_ID_PATTERN.test(value)
  );
}

function asSafeIntegerV1(value: unknown, minimum: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function asStringV1(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isTextV1(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN_V1.test(value)
  );
}

function scanTextSafetyV1(text: string): string | null {
  for (const rule of FORBIDDEN_TEXT_PATTERNS_V1) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return null;
}

/**
 * The id of the first durable-memory text rule the text breaks (a host path, a
 * credential, an authorization header), or null. A producer of memory text
 * uses this to withhold what the store would refuse, instead of redacting a
 * span and leaking the rest of a secret.
 */
export function scanMemoryTextSafetyV1(text: string): string | null {
  return scanTextSafetyV1(text);
}

function scanPayloadSafetyV1(value: unknown, depth: number): string | null {
  if (depth > 6) return "document_nested_too_deep";
  if (typeof value === "string") return scanTextSafetyV1(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = scanPayloadSafetyV1(item, depth + 1);
      if (violation !== null) return violation;
    }
    return null;
  }
  if (!isPlainRecordV1(value)) return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS_V1.includes(key)) return `forbidden_field:${key}`;
    const violation = scanPayloadSafetyV1(value[key], depth + 1);
    if (violation !== null) return violation;
  }
  return null;
}

/** Audit allowlists permit the enum field `authorization`; values remain scanned. */
function scanAuditPayloadSafetyV1(
  value: unknown,
  depth: number,
): string | null {
  if (depth > 6) return "audit_nested_too_deep";
  if (typeof value === "string") return scanTextSafetyV1(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = scanAuditPayloadSafetyV1(item, depth + 1);
      if (violation !== null) return violation;
    }
    return null;
  }
  if (!isPlainRecordV1(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "authorization" && FORBIDDEN_KEYS_V1.includes(key)) {
      return `forbidden_field:${key}`;
    }
    const violation = scanAuditPayloadSafetyV1(child, depth + 1);
    if (violation !== null) return violation;
  }
  return null;
}

type DecodeResultV1<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | MemoryDurabilityFailureV1;

function decodeTagsV1(value: unknown): DecodeResultV1<readonly string[]> {
  if (value === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_RECORD_V1) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `tags must be an array of at most ${MAX_TAGS_PER_RECORD_V1} entries`,
      { details: { violation: "invalid_tags" } },
    );
  }
  const tags: string[] = [];
  for (const tag of value) {
    if (!isTextV1(tag, TAG_MAX_CHARS_V1)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        "each tag must be a trimmed non-empty string without control characters",
        { details: { violation: "invalid_tag" } },
      );
    }
    tags.push(tag);
  }
  return { ok: true, value: Object.freeze(tags) };
}

function decodeFactRecordV1(
  value: unknown,
  index: number,
  basisRevision: number,
): DecodeResultV1<MemoryFactRecordV1> {
  if (!isPlainRecordV1(value)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `facts[${index}] must be an object`,
      { details: { violation: "invalid_fact_record" } },
    );
  }
  for (const key of Object.keys(value)) {
    if (!FACT_RECORD_KEYS_V1.includes(key)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `facts[${index}] has an unsupported field`,
        { details: { violation: `unknown_fact_field:${key}` } },
      );
    }
  }
  if (!isLogicalIdV1(value.factId)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `facts[${index}].factId must be a logical id`,
      { details: { violation: "invalid_fact_id" } },
    );
  }
  if (!isTextV1(value.statement, MEMORY_MAX_STATEMENT_CHARS_V1)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `facts[${index}].statement must be a trimmed non-empty string`,
      { details: { violation: "invalid_fact_statement" } },
    );
  }
  if (value.basisRevision !== basisRevision) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `facts[${index}].basisRevision must equal the document basisRevision`,
      { details: { violation: "fact_basis_revision_mismatch" } },
    );
  }
  const tags = decodeTagsV1(value.tags);
  if (!tags.ok) return tags;
  return {
    ok: true,
    value: Object.freeze({
      factId: value.factId,
      statement: value.statement,
      basisRevision,
      tags: tags.value,
    }),
  };
}

function decodeSummaryRecordV1(
  value: unknown,
  index: number,
  factIds: ReadonlySet<string>,
): DecodeResultV1<MemorySummaryRecordV1> {
  if (!isPlainRecordV1(value)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `summaries[${index}] must be an object`,
      { details: { violation: "invalid_summary_record" } },
    );
  }
  for (const key of Object.keys(value)) {
    if (!SUMMARY_RECORD_KEYS_V1.includes(key)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `summaries[${index}] has an unsupported field: a summary may never carry exact-fact evidence`,
        { details: { violation: `unknown_summary_field:${key}` } },
      );
    }
  }
  if (!isLogicalIdV1(value.summaryId)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `summaries[${index}].summaryId must be a logical id`,
      { details: { violation: "invalid_summary_id" } },
    );
  }
  if (!isTextV1(value.statement, MEMORY_MAX_STATEMENT_CHARS_V1)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `summaries[${index}].statement must be a trimmed non-empty string`,
      { details: { violation: "invalid_summary_statement" } },
    );
  }
  if (!Array.isArray(value.derivedFrom) || value.derivedFrom.length === 0) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `summaries[${index}].derivedFrom must list at least one exact fact id`,
      { details: { violation: "invalid_summary_source" } },
    );
  }
  const derivedFrom: string[] = [];
  for (const factId of value.derivedFrom) {
    if (!isLogicalIdV1(factId) || !factIds.has(factId)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `summaries[${index}].derivedFrom must reference exact facts of this document`,
        { details: { violation: "summary_derives_from_unknown_fact" } },
      );
    }
    if (derivedFrom.includes(factId)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `summaries[${index}].derivedFrom contains a duplicate fact id`,
        { details: { violation: "duplicate_summary_source" } },
      );
    }
    derivedFrom.push(factId);
  }
  return {
    ok: true,
    value: Object.freeze({
      summaryId: value.summaryId,
      statement: value.statement,
      derivedFrom: Object.freeze(derivedFrom),
    }),
  };
}

export type MemoryFactDocumentDecodeResultV1 =
  | { readonly ok: true; readonly document: MemoryFactDocumentV1 }
  | MemoryDurabilityFailureV1;

/** Strict decode; any doubt about the payload fails closed before any write. */
export function decodeMemoryFactDocumentV1(
  value: unknown,
): MemoryFactDocumentDecodeResultV1 {
  if (!isPlainRecordV1(value)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document must be a plain object",
      { details: { violation: "document_not_object" } },
    );
  }
  for (const key of Object.keys(value)) {
    if (!DOCUMENT_KEYS_V1.includes(key)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `memory fact document has an unsupported field '${key}'`,
        { details: { violation: `unknown_document_field:${key}` } },
      );
    }
  }
  const safety = scanPayloadSafetyV1(value, 0);
  if (safety !== null) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document may not persist prompts, transcripts, credentials or host paths",
      { details: { violation: safety } },
    );
  }
  if (value.schemaVersion !== MEMORY_DURABILITY_SCHEMA_VERSION) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document schemaVersion must be 1",
      { details: { violation: "invalid_schema_version" } },
    );
  }
  if (value.kind !== MEMORY_FACT_DOCUMENT_KIND_V1) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document kind is invalid",
      { details: { violation: "invalid_kind" } },
    );
  }
  if (value.source !== "artifact") {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document source must be 'artifact'",
      { details: { violation: "invalid_source" } },
    );
  }
  if (!isArtifactScopeV1(value.scope)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `memory fact document scope must be one of: ${ARTIFACT_SCOPES_V1.join(", ")}`,
      { details: { violation: "invalid_scope" } },
    );
  }
  if (!isArtifactScopeKeyV1(value.scopeKey)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document scopeKey must be a stable non-empty key",
      { details: { violation: "invalid_scope_key" } },
    );
  }
  if (!isArtifactBasisRevisionV1(value.basisRevision)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document basisRevision must be a non-negative safe integer",
      { details: { violation: "invalid_basis_revision" } },
    );
  }
  if (!Array.isArray(value.facts) || value.facts.length > MEMORY_MAX_FACTS_V1) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `memory fact document facts must be an array of at most ${MEMORY_MAX_FACTS_V1} entries`,
      { details: { violation: "invalid_facts" } },
    );
  }
  if (value.summaries !== undefined && !Array.isArray(value.summaries)) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "memory fact document summaries must be an array",
      { details: { violation: "invalid_summaries" } },
    );
  }
  const summaryInputs = value.summaries ?? [];
  if (summaryInputs.length > MEMORY_MAX_SUMMARIES_V1) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      `memory fact document summaries must hold at most ${MEMORY_MAX_SUMMARIES_V1} entries`,
      { details: { violation: "invalid_summaries" } },
    );
  }
  const facts: MemoryFactRecordV1[] = [];
  const factIds = new Set<string>();
  for (const [index, record] of value.facts.entries()) {
    const decoded = decodeFactRecordV1(record, index, value.basisRevision);
    if (!decoded.ok) return decoded;
    if (factIds.has(decoded.value.factId)) {
      return memoryDurabilityFailureV1(
        "memory_content_rejected",
        `facts[${index}].factId is duplicated`,
        { details: { violation: "duplicate_fact_id" } },
      );
    }
    factIds.add(decoded.value.factId);
    facts.push(decoded.value);
  }
  const summaries: MemorySummaryRecordV1[] = [];
  for (const [index, record] of summaryInputs.entries()) {
    const decoded = decodeSummaryRecordV1(record, index, factIds);
    if (!decoded.ok) return decoded;
    summaries.push(decoded.value);
  }
  return {
    ok: true,
    document: Object.freeze({
      schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
      kind: MEMORY_FACT_DOCUMENT_KIND_V1,
      source: "artifact" as const,
      scope: value.scope,
      scopeKey: value.scopeKey,
      basisRevision: value.basisRevision,
      facts: Object.freeze(facts),
      summaries: Object.freeze(summaries),
    }),
  };
}

/** Canonical bytes; the same document always hashes to the same content hash. */
export function encodeMemoryFactDocumentV1(
  document: MemoryFactDocumentV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalizePactileJsonV1(document));
}

/** Per-fact fingerprint bound to its artifact content hash and basis. */
export function memoryFactHashV1(
  fact: MemoryFactRecordV1,
  contentHash: string,
): string {
  return fingerprintPactileContractV1({
    domain: "memory-fact-v1",
    contentHash,
    factId: fact.factId,
    basisRevision: fact.basisRevision,
    statement: fact.statement,
    tags: fact.tags,
  });
}

// ── identity helpers ────────────────────────────────────────────────────────

export function memoryPartitionV1(
  scope: MemoryScopeV1,
  scopeKey: string,
): string {
  const digest = fingerprintPactileContractV1({
    domain: "memory-partition-v1",
    scope,
    scopeKey,
  }).slice("sha256:".length, "sha256:".length + 12);
  return `memory_${scope}_${digest}`;
}

export interface MemoryArtifactIdentityV1 {
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
}

export function memoryReceiptIdV1(identity: MemoryArtifactIdentityV1): string {
  const digest = fingerprintPactileContractV1({
    domain: "memory-durable-receipt-v1",
    ...identity,
  }).slice("sha256:".length, "sha256:".length + 32);
  return `memory_receipt_v1_${digest}`;
}

export function memoryManifestIdV1(
  scope: MemoryScopeV1,
  scopeKey: string,
  revision: number,
): string {
  const digest = fingerprintPactileContractV1({
    domain: "memory-current-manifest-v1",
    scope,
    scopeKey,
    revision,
  }).slice("sha256:".length, "sha256:".length + 32);
  return `memory_manifest_v1_${digest}`;
}

export function memoryCommitRequestHashV1(input: {
  readonly requestId: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly whenToRead: string;
}): string {
  return fingerprintPactileContractV1({
    domain: "memory-commit-request-v1",
    ...input,
  });
}

// ── durable receipt ────────────────────────────────────────────────────────

export interface MemoryDurableReceiptV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_DURABLE_RECEIPT_KIND_V1;
  readonly receiptId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  /** Logical reference only: a receipt never carries a host path. */
  readonly storageRef: string;
  readonly factCount: number;
  readonly summaryCount: number;
  readonly whenToRead: string;
  readonly committedAt: string;
  readonly receiptHash: string;
}

type MemoryDurableReceiptBodyV1 = Omit<MemoryDurableReceiptV1, "receiptHash">;

function receiptHashV1(body: MemoryDurableReceiptBodyV1): string {
  return fingerprintPactileContractV1({
    domain: "memory-durable-receipt-hash-v1",
    ...body,
  });
}

/** Decode and re-verify a receipt; `null` means damaged beyond trust. */
export function decodeMemoryDurableReceiptV1(
  value: unknown,
): MemoryDurableReceiptV1 | null {
  if (!isPlainRecordV1(value)) return null;
  for (const key of Object.keys(value)) {
    if (!RECEIPT_KEYS_V1.includes(key)) return null;
  }
  if (value.schemaVersion !== MEMORY_DURABILITY_SCHEMA_VERSION) return null;
  if (value.kind !== MEMORY_DURABLE_RECEIPT_KIND_V1) return null;
  if (!isLogicalIdV1(value.receiptId)) return null;
  if (!isLogicalIdV1(value.requestId)) return null;
  if (!isArtifactContentHashV1(value.requestHash)) return null;
  if (!isArtifactScopeV1(value.scope)) return null;
  if (!isArtifactScopeKeyV1(value.scopeKey)) return null;
  if (!isArtifactIdV1(value.artifactId)) return null;
  if (!isArtifactVersionV1(value.version)) return null;
  if (!isArtifactBasisRevisionV1(value.basisRevision)) return null;
  if (!isArtifactContentHashV1(value.contentHash)) return null;
  if (!isArtifactByteLengthV1(value.byteLength)) return null;
  const storageRef = asStringV1(value.storageRef);
  if (storageRef === null) return null;
  const parsed = parseArtifactStorageRefV1(storageRef);
  if (!parsed.ok) return null;
  if (
    parsed.reference.artifactId !== value.artifactId ||
    parsed.reference.version !== value.version ||
    parsed.reference.contentHash !== value.contentHash
  ) {
    return null;
  }
  const factCount = asSafeIntegerV1(value.factCount, 0);
  if (factCount === null || factCount > MEMORY_MAX_FACTS_V1) return null;
  const summaryCount = asSafeIntegerV1(value.summaryCount, 0);
  if (summaryCount === null || summaryCount > MEMORY_MAX_SUMMARIES_V1) {
    return null;
  }
  if (!isTextV1(value.whenToRead, MEMORY_MAX_WHEN_TO_READ_CHARS_V1))
    return null;
  if (scanTextSafetyV1(value.whenToRead) !== null) return null;
  if (
    typeof value.committedAt !== "string" ||
    !RFC3339_PATTERN_V1.test(value.committedAt) ||
    Number.isNaN(Date.parse(value.committedAt))
  ) {
    return null;
  }
  if (!isArtifactContentHashV1(value.receiptHash)) return null;
  const body: MemoryDurableReceiptBodyV1 = Object.freeze({
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_DURABLE_RECEIPT_KIND_V1,
    receiptId: value.receiptId,
    requestId: value.requestId,
    requestHash: value.requestHash,
    scope: value.scope,
    scopeKey: value.scopeKey,
    artifactId: value.artifactId,
    version: value.version,
    basisRevision: value.basisRevision,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    storageRef,
    factCount,
    summaryCount,
    whenToRead: value.whenToRead,
    committedAt: value.committedAt,
  });
  if (receiptHashV1(body) !== value.receiptHash) return null;
  return Object.freeze({ ...body, receiptHash: value.receiptHash });
}

// ── current manifest ───────────────────────────────────────────────────────

export interface MemoryManifestEntryV1 {
  readonly receiptId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly storageRef: string;
  readonly receiptHash: string;
  readonly factCount: number;
  readonly summaryCount: number;
  readonly whenToRead: string;
}

export interface MemoryCurrentManifestV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_CURRENT_MANIFEST_KIND_V1;
  readonly manifestId: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  /** CAS revision; 0 means "no manifest yet". */
  readonly revision: number;
  readonly previousRevision: number | null;
  readonly entries: readonly MemoryManifestEntryV1[];
  readonly committedAt: string;
  readonly manifestHash: string;
}

type MemoryCurrentManifestBodyV1 = Omit<
  MemoryCurrentManifestV1,
  "manifestHash"
>;

function manifestHashV1(body: MemoryCurrentManifestBodyV1): string {
  return fingerprintPactileContractV1({
    domain: "memory-current-manifest-hash-v1",
    ...body,
  });
}

function decodeManifestEntryV1(value: unknown): MemoryManifestEntryV1 | null {
  if (!isPlainRecordV1(value)) return null;
  for (const key of Object.keys(value)) {
    if (!MANIFEST_ENTRY_KEYS_V1.includes(key)) return null;
  }
  if (!isLogicalIdV1(value.receiptId)) return null;
  if (!isArtifactIdV1(value.artifactId)) return null;
  if (!isArtifactVersionV1(value.version)) return null;
  if (!isArtifactBasisRevisionV1(value.basisRevision)) return null;
  if (!isArtifactContentHashV1(value.contentHash)) return null;
  if (!isArtifactByteLengthV1(value.byteLength)) return null;
  const storageRef = asStringV1(value.storageRef);
  if (storageRef === null) return null;
  const parsed = parseArtifactStorageRefV1(storageRef);
  if (!parsed.ok) return null;
  if (
    parsed.reference.artifactId !== value.artifactId ||
    parsed.reference.version !== value.version ||
    parsed.reference.contentHash !== value.contentHash
  ) {
    return null;
  }
  if (!isArtifactContentHashV1(value.receiptHash)) return null;
  const factCount = asSafeIntegerV1(value.factCount, 0);
  if (factCount === null || factCount > MEMORY_MAX_FACTS_V1) return null;
  const summaryCount = asSafeIntegerV1(value.summaryCount, 0);
  if (summaryCount === null || summaryCount > MEMORY_MAX_SUMMARIES_V1) {
    return null;
  }
  if (!isTextV1(value.whenToRead, MEMORY_MAX_WHEN_TO_READ_CHARS_V1))
    return null;
  if (scanTextSafetyV1(value.whenToRead) !== null) return null;
  return Object.freeze({
    receiptId: value.receiptId,
    artifactId: value.artifactId,
    version: value.version,
    basisRevision: value.basisRevision,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    storageRef,
    receiptHash: value.receiptHash,
    factCount,
    summaryCount,
    whenToRead: value.whenToRead,
  });
}

export function memoryManifestEntryFromReceiptV1(
  receipt: MemoryDurableReceiptV1,
): MemoryManifestEntryV1 {
  return Object.freeze({
    receiptId: receipt.receiptId,
    artifactId: receipt.artifactId,
    version: receipt.version,
    basisRevision: receipt.basisRevision,
    contentHash: receipt.contentHash,
    byteLength: receipt.byteLength,
    storageRef: receipt.storageRef,
    receiptHash: receipt.receiptHash,
    factCount: receipt.factCount,
    summaryCount: receipt.summaryCount,
    whenToRead: receipt.whenToRead,
  });
}

/** Decode and re-verify a manifest; `null` means damaged beyond trust. */
export function decodeMemoryCurrentManifestV1(
  value: unknown,
): MemoryCurrentManifestV1 | null {
  if (!isPlainRecordV1(value)) return null;
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS_V1.includes(key)) return null;
  }
  if (value.schemaVersion !== MEMORY_DURABILITY_SCHEMA_VERSION) return null;
  if (value.kind !== MEMORY_CURRENT_MANIFEST_KIND_V1) return null;
  if (!isLogicalIdV1(value.manifestId)) return null;
  if (!isArtifactScopeV1(value.scope)) return null;
  if (!isArtifactScopeKeyV1(value.scopeKey)) return null;
  const revision = asSafeIntegerV1(value.revision, 1);
  if (revision === null) return null;
  let previousRevision: number | null = null;
  if (value.previousRevision !== null) {
    previousRevision = asSafeIntegerV1(value.previousRevision, 1);
    if (previousRevision === null) return null;
  }
  if (!Array.isArray(value.entries)) return null;
  const entries: MemoryManifestEntryV1[] = [];
  const seenBasis = new Set<number>();
  for (const entryValue of value.entries) {
    const entry = decodeManifestEntryV1(entryValue);
    if (entry === null) return null;
    if (seenBasis.has(entry.basisRevision)) return null;
    seenBasis.add(entry.basisRevision);
    entries.push(entry);
  }
  if (
    typeof value.committedAt !== "string" ||
    !RFC3339_PATTERN_V1.test(value.committedAt) ||
    Number.isNaN(Date.parse(value.committedAt))
  ) {
    return null;
  }
  if (!isArtifactContentHashV1(value.manifestHash)) return null;
  const body: MemoryCurrentManifestBodyV1 = Object.freeze({
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_CURRENT_MANIFEST_KIND_V1,
    manifestId: value.manifestId,
    scope: value.scope,
    scopeKey: value.scopeKey,
    revision,
    previousRevision,
    entries: Object.freeze(entries),
    committedAt: value.committedAt,
  });
  if (manifestHashV1(body) !== value.manifestHash) return null;
  return Object.freeze({ ...body, manifestHash: value.manifestHash });
}

/** Highest basis revision in the manifest, or `null` when empty. */
export function newestManifestBasisRevisionV1(
  manifest: MemoryCurrentManifestV1,
): number | null {
  let newest: number | null = null;
  for (const entry of manifest.entries) {
    if (newest === null || entry.basisRevision > newest) {
      newest = entry.basisRevision;
    }
  }
  return newest;
}

// ── audit receipts ─────────────────────────────────────────────────────────

export interface MemoryReadDisclosureV1 {
  /** Logical `memory://` reference: never an absolute host path. */
  readonly path: string;
  readonly fingerprint: string;
  readonly whenToRead: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly readVia: "artifact_store";
}

export interface MemoryReadReceiptV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_READ_RECEIPT_KIND_V1;
  readonly readReceiptId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly storageRef: string;
  readonly manifestRevision: number;
  readonly receiptId: string;
  readonly factIds: readonly string[];
  readonly exactFactCount: number;
  readonly summaryCount: number;
  readonly disclosure: {
    readonly path: string;
    readonly fingerprint: string;
    readonly whenToRead: string;
  };
  readonly acknowledgedDisclosure: true;
  readonly recordedAt: string;
  readonly receiptHash: string;
}

export type MemoryCompactionAuthorizationV1 =
  | "compact_authorized"
  | "mask_authorized"
  | "continue_authorized"
  | "blocked_policy"
  | "blocked_memory_error"
  | "blocked_provider_error";

export interface MemoryCompactionReceiptV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_COMPACTION_RECEIPT_KIND_V1;
  readonly compactionReceiptId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly action: ContextSurgeryActionV1;
  readonly assurance: ContextSurgeryAssuranceV1;
  readonly reason: ContextSurgeryDecisionV1["reason"];
  readonly authorization: MemoryCompactionAuthorizationV1;
  readonly preflightStatus: DurableExternalizationStatusV1;
  readonly preflightReason: string;
  readonly maskThreshold: number;
  readonly compressionThreshold: number;
  readonly keep: number;
  readonly clearAtLeastPercent: number;
  readonly disclosurePath: string | null;
  readonly disclosureFingerprint: string | null;
  readonly whenToRead: string | null;
  /** `null` means no blocker; otherwise it names the failing domain. */
  readonly errorDomain: "provider" | "memory" | null;
  readonly errorCode: string | null;
  readonly providerErrorCode: string | null;
  readonly memoryErrorCode: string | null;
  /** Unknown effects are never replayed automatically. */
  readonly reexecute: false;
  readonly replayPolicy: typeof MEMORY_REPLAY_POLICY_V1;
  readonly recordedAt: string;
  readonly receiptHash: string;
}

export interface MemoryContextCompactionReceiptV1 {
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly kind: typeof MEMORY_CONTEXT_COMPACTION_RECEIPT_KIND_V1;
  readonly compactionReceiptId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly contextOperationId: string;
  readonly sourceCursor: string;
  readonly committedSourceRevision: number | null;
  readonly contextBasisHash: string;
  readonly leaseEpoch: number;
  readonly fencingToken: string;
  readonly commandId: string;
  readonly disclosurePayloadHash: string;
  readonly promptAssemblyHash: string;
  readonly piCompactionId: string;
  readonly piSessionRef: string;
  readonly result: "committed" | "blocked" | "unknown";
  readonly summarySource: "pi-transcript";
  readonly derivedFrom: readonly string[];
  readonly cutPoint: ContextCutPointV1;
  readonly oldSnapshotHash: string;
  readonly newSnapshotHash: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly artifactHash: string;
  readonly artifactStorageRef: string;
  readonly memoryReceiptId: string;
  readonly memoryReceiptHash: string;
  readonly manifestId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
  readonly resultHash: string;
  readonly checkpointId: string;
  readonly recordedAt: string;
  readonly reexecute: false;
  readonly replayPolicy: typeof MEMORY_REPLAY_POLICY_V1;
  readonly receiptHash: string;
}

export type CompactionReceiptV1 = MemoryContextCompactionReceiptV1;

export type MemoryAuditReceiptV1 =
  | MemoryReadReceiptV1
  | MemoryCompactionReceiptV1
  | MemoryContextCompactionReceiptV1;

export function memoryContextCompactionReceiptHashV1(
  value: Omit<MemoryContextCompactionReceiptV1, "receiptHash">,
): string {
  return fingerprintPactileContractV1({
    domain: "context-compaction-receipt-hash-v1",
    ...value,
  });
}

function auditReceiptHashV1(value: unknown): string {
  return fingerprintPactileContractV1({
    domain: "memory-audit-receipt-hash-v1",
    ...(value as Record<string, unknown>),
  });
}

/**
 * Decode audit records at the host boundary before they enter or leave
 * SQLite. Hash verification alone is not enough: the allowlists and payload
 * safety scan also prevent a caller from smuggling transcript/path material
 * through a newly added field while recomputing a valid receipt hash.
 */
export function decodeMemoryAuditReceiptV1(
  value: unknown,
): MemoryAuditReceiptV1 | null {
  if (!isPlainRecordV1(value)) return null;
  const kind = value.kind;
  const keys =
    kind === MEMORY_READ_RECEIPT_KIND_V1
      ? READ_RECEIPT_KEYS_V1
      : kind === MEMORY_COMPACTION_RECEIPT_KIND_V1
        ? COMPACTION_RECEIPT_KEYS_V1
        : kind === MEMORY_CONTEXT_COMPACTION_RECEIPT_KIND_V1
          ? CONTEXT_COMPACTION_RECEIPT_KEYS_V1
          : null;
  if (keys === null || Object.keys(value).some((key) => !keys.includes(key))) {
    return null;
  }
  if (value.schemaVersion !== MEMORY_DURABILITY_SCHEMA_VERSION) return null;
  if (!isArtifactContentHashV1(value.receiptHash)) return null;
  if (!isArtifactScopeV1(value.scope) || !isArtifactScopeKeyV1(value.scopeKey))
    return null;
  if (
    !isLogicalIdV1(value.requestId) ||
    !isArtifactContentHashV1(value.requestHash)
  )
    return null;
  if (
    typeof value.recordedAt !== "string" ||
    !RFC3339_PATTERN_V1.test(value.recordedAt) ||
    Number.isNaN(Date.parse(value.recordedAt))
  ) {
    return null;
  }
  const identifier =
    kind === MEMORY_READ_RECEIPT_KIND_V1
      ? value.readReceiptId
      : value.compactionReceiptId;
  if (!isLogicalIdV1(identifier)) return null;
  const safety = scanAuditPayloadSafetyV1(value, 0);
  if (safety !== null) return null;
  if (kind === MEMORY_READ_RECEIPT_KIND_V1) {
    const parsed = parseArtifactStorageRefV1(value.storageRef);
    if (!parsed.ok || parsed.reference.contentHash !== value.contentHash) return null;
  } else if (kind === MEMORY_COMPACTION_RECEIPT_KIND_V1) {
    if (
      value.disclosurePath !== null &&
      (typeof value.disclosurePath !== "string" ||
        !parseArtifactStorageRefV1(value.disclosurePath).ok)
    ) {
      return null;
    }
    if (
      value.disclosureFingerprint !== null &&
      !isArtifactContentHashV1(value.disclosureFingerprint)
    ) {
      return null;
    }
  } else {
    const contextFingerprintFields = [
      "contextBasisHash",
      "disclosurePayloadHash",
      "promptAssemblyHash",
      "oldSnapshotHash",
      "newSnapshotHash",
      "artifactHash",
      "memoryReceiptHash",
      "manifestHash",
      "resultHash",
    ] as const;
    if (contextFingerprintFields.some((field) => !isArtifactContentHashV1(value[field]))) {
      return null;
    }
    const parsed = parseArtifactStorageRefV1(value.artifactStorageRef);
    if (
      !parsed.ok ||
      parsed.reference.artifactId !== value.artifactId ||
      parsed.reference.version !== value.artifactVersion ||
      parsed.reference.contentHash !== value.artifactHash
    ) {
      return null;
    }
    if (
      !isArtifactIdV1(value.artifactId) ||
      !isLogicalIdV1(value.memoryReceiptId) ||
      !isLogicalIdV1(value.manifestId) ||
      !isLogicalIdV1(value.checkpointId) ||
      !isLogicalIdV1(value.commandId) ||
      !isLogicalIdV1(value.contextOperationId) ||
      (value.committedSourceRevision !== null &&
        !isArtifactBasisRevisionV1(value.committedSourceRevision)) ||
      !isArtifactVersionV1(value.artifactVersion) ||
      !isArtifactBasisRevisionV1(value.basisRevision) ||
      typeof value.leaseEpoch !== "number" ||
      !Number.isSafeInteger(value.leaseEpoch) ||
      value.leaseEpoch < 1 ||
      typeof value.manifestRevision !== "number" ||
      !Number.isSafeInteger(value.manifestRevision) ||
      value.manifestRevision < 1
    ) {
      return null;
    }
  }
  const { receiptHash, ...body } = value;
  try {
    const expected =
      kind === MEMORY_CONTEXT_COMPACTION_RECEIPT_KIND_V1
        ? memoryContextCompactionReceiptHashV1(
            body as unknown as Omit<
              MemoryContextCompactionReceiptV1,
              "receiptHash"
            >,
          )
        : auditReceiptHashV1(body);
    if (expected !== receiptHash) return null;
  } catch {
    return null;
  }
  return Object.freeze({ ...value }) as unknown as MemoryAuditReceiptV1;
}

// ── lease ──────────────────────────────────────────────────────────────────

export interface MemoryLeaseProofV1 {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAt: string;
  readonly partition: string;
}

export type MemoryLeaseValidationResultV1 =
  | { readonly ok: true }
  | MemoryDurabilityFailureV1;

/**
 * Host-side lease fence. A host adapter must re-validate the lease inside the
 * same transaction as the durable write; this port is the seam for that check.
 */
export interface MemoryLeasePort {
  validateLease(input: {
    readonly proof: MemoryLeaseProofV1;
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly requestHash: string;
    readonly now: string;
  }): Promise<MemoryLeaseValidationResultV1>;
}

// ── storage ports ──────────────────────────────────────────────────────────

export type MemoryReceiptLookupV1 =
  | {
      readonly ok: true;
      readonly status: "found";
      readonly receipt: MemoryDurableReceiptV1;
    }
  | { readonly ok: true; readonly status: "absent" }
  | { readonly ok: true; readonly status: "pending" }
  | { readonly ok: true; readonly status: "corrupt"; readonly detail: string }
  | MemoryDurabilityFailureV1;

export type MemoryReceiptPutResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly receipt: MemoryDurableReceiptV1;
    }
  | MemoryDurabilityFailureV1;

/** Secret-safe projection used by recovery; no statements and no paths. */
export interface MemoryReceiptSummaryV1 {
  readonly receiptId: string;
  readonly requestId: string;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly receiptHash: string;
  readonly committedAt: string;
}

export type MemoryReceiptListResultV1 =
  | {
      readonly ok: true;
      readonly receipts: readonly MemoryReceiptSummaryV1[];
      readonly truncated: boolean;
    }
  | MemoryDurabilityFailureV1;

export interface MemoryReceiptStorePort {
  putReceipt(input: {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly receipt: MemoryDurableReceiptV1;
    /** The host must revalidate this proof in the same transaction as the write. */
    readonly lease?: MemoryLeaseProofV1;
  }): Promise<MemoryReceiptPutResultV1>;
  getReceipt(input: {
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly receiptId: string;
  }): Promise<MemoryReceiptLookupV1>;
  listReceipts(input: {
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly limit?: number;
  }): Promise<MemoryReceiptListResultV1>;
}

export type MemoryManifestLookupV1 =
  | { readonly ok: true; readonly status: "found"; readonly manifest: unknown }
  | { readonly ok: true; readonly status: "absent" }
  | MemoryDurabilityFailureV1;

export type MemoryManifestCasResultV1 =
  | { readonly ok: true; readonly applied: boolean; readonly manifest: unknown }
  | MemoryDurabilityFailureV1;

export interface MemoryManifestStorePort {
  readCurrent(input: {
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
  }): Promise<MemoryManifestLookupV1>;
  /**
   * Optimistic write. `expectedRevision` 0 means "no manifest exists yet"; a
   * mismatch must be reported as `memory_manifest_stale` and must not write.
   */
  compareAndSwap(input: {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly expectedRevision: number;
    readonly manifest: MemoryCurrentManifestV1;
    /** The host must revalidate this proof in the same transaction as the CAS. */
    readonly lease?: MemoryLeaseProofV1;
  }): Promise<MemoryManifestCasResultV1>;
}

export type MemoryAuditAppendResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      /**
       * The receipt the audit store holds for this append. On an idempotent
       * replay that is the first append's receipt, not the one just offered.
       * A store that cannot return it omits the field.
       */
      readonly receipt?: MemoryAuditReceiptV1;
    }
  | MemoryDurabilityFailureV1;

export interface MemoryAuditReceiptStorePort {
  append(input: {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly receipt: MemoryAuditReceiptV1;
  }): Promise<MemoryAuditAppendResultV1>;
}

export interface ContextMemoryDurabilityDepsV1 {
  readonly artifacts: ArtifactStorePort;
  readonly receipts: MemoryReceiptStorePort;
  readonly manifests: MemoryManifestStorePort;
  readonly audits: MemoryAuditReceiptStorePort;
  /** Required when `requireLease` is set or when a request carries a lease. */
  readonly leases?: MemoryLeasePort;
  readonly now?: () => Date;
  readonly requireLease?: boolean;
  /** Native hosts may require the versioned workspace/project scope key. */
  readonly requireCanonicalScopeKey?: boolean;
  readonly policy?: ContextMemoryPolicyConfigV1;
}

// ── commit ─────────────────────────────────────────────────────────────────

export interface MemoryCommitRequestV1 {
  /** Caller-owned idempotency key; the same key plus payload replays. */
  readonly requestId: string;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly document: MemoryFactDocumentV1;
  readonly whenToRead: string;
  /** Omit to compare-and-swap against the revision read inside the commit. */
  readonly expectedManifestRevision?: number;
  readonly lease?: MemoryLeaseProofV1;
}

export interface MemoryCommitSuccessV1 {
  readonly ok: true;
  /** `true` when no write was needed because the request was already durable. */
  readonly replay: boolean;
  readonly durable: true;
  readonly order: typeof MEMORY_COMMIT_ORDER_V1;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly storageRef: string;
  readonly factCount: number;
  readonly summaryCount: number;
  readonly whenToRead: string;
  readonly receiptId: string;
  readonly receiptHash: string;
  readonly manifestId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
}

export type MemoryCommitResultV1 =
  | MemoryCommitSuccessV1
  | MemoryDurabilityFailureV1;

// ── preflight ──────────────────────────────────────────────────────────────

export type MemoryPreflightReasonV1 =
  | "verified_durable"
  | "manifest_absent"
  | "manifest_corrupt"
  | "manifest_stale_revision"
  | "manifest_entry_missing"
  | "receipt_absent"
  | "receipt_pending"
  | "receipt_denied"
  | "receipt_corrupt"
  | "receipt_hash_mismatch"
  | "receipt_conflict"
  | "artifact_missing"
  | "artifact_corrupt"
  | "artifact_hash_mismatch"
  | "artifact_scope_mismatch"
  | "artifact_stale"
  | "scope_key_mismatch"
  | "store_unavailable"
  | "unknown";

/**
 * Preflight reasons that prove a *fault* rather than "nothing recorded yet".
 * These always block compaction with `assurance_unknown`; absent/pending
 * records leave the decision to the frozen policy, which already refuses
 * compression without a verified durable copy.
 */
export const MEMORY_FAULT_PREFLIGHT_REASONS_V1: readonly MemoryPreflightReasonV1[] =
  [
    "manifest_corrupt",
    "manifest_stale_revision",
    "receipt_corrupt",
    "receipt_hash_mismatch",
    "receipt_conflict",
    "receipt_denied",
    "artifact_corrupt",
    "artifact_hash_mismatch",
    "artifact_scope_mismatch",
    "artifact_stale",
    "scope_key_mismatch",
    "store_unavailable",
    "unknown",
  ];

export interface MemoryPreflightCheckV1 {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface MemoryPreflightV1 {
  readonly ok: true;
  readonly status: DurableExternalizationStatusV1;
  readonly reason: MemoryPreflightReasonV1;
  readonly assurance: ContextSurgeryAssuranceV1;
  /** `true` only when the artifact, receipt and manifest all verified. */
  readonly verified: boolean;
  /** `true` only when path, fingerprint and whenToRead were disclosed. */
  readonly disclosed: boolean;
  readonly scope: MemoryScopeV1 | null;
  readonly scopeKey: string | null;
  readonly basisRevision: number | null;
  readonly contentHash: string | null;
  readonly receiptId: string | null;
  readonly manifestRevision: number | null;
  readonly disclosure: MemoryReadDisclosureV1 | null;
  /** Ready to feed into `decideContextSurgeryV1`. */
  readonly externalization: DurableExternalizationV1;
  /** Structured code of the underlying fault, or `null` when none. */
  readonly failureCode: MemoryDurabilityFailureCodeV1 | null;
  readonly checks: readonly MemoryPreflightCheckV1[];
}

export interface MemoryPreflightRequestV1 {
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly disclose: boolean;
}

export type MemoryPreflightResultV1 =
  | MemoryPreflightV1
  | MemoryDurabilityFailureV1;

// ── read ───────────────────────────────────────────────────────────────────

export interface MemoryVerifiedFactV1 {
  readonly factId: string;
  readonly statement: string;
  readonly source: "artifact";
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly factHash: string;
  readonly tags: readonly string[];
  readonly exact: true;
}

export interface MemoryNonExactSummaryV1 {
  readonly summaryId: string;
  readonly statement: string;
  readonly derivedFrom: readonly string[];
  readonly exact: false;
  readonly authoritative: false;
}

export interface MemoryReadRequestV1 {
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  /** Without an explicit disclosure acknowledgement no fact is returned. */
  readonly acknowledgeDisclosure: boolean;
  readonly requestId?: string;
  readonly lease?: MemoryLeaseProofV1;
}

export interface MemoryReadSuccessV1 {
  readonly ok: true;
  readonly assurance: "assurance_exact";
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly manifestRevision: number;
  readonly receiptId: string;
  readonly facts: readonly MemoryVerifiedFactV1[];
  readonly summaries: readonly MemoryNonExactSummaryV1[];
  readonly exactFactCount: number;
  readonly summaryCount: number;
  /** Structural invariant: a summary is never an exact fact source. */
  readonly summaryIsExactFactSource: false;
  readonly disclosure: MemoryReadDisclosureV1;
  readonly readReceipt: MemoryReadReceiptV1;
}

export type MemoryReadResultV1 =
  | MemoryReadSuccessV1
  | MemoryDurabilityFailureV1;

// ── compaction ─────────────────────────────────────────────────────────────

export interface MemoryProviderFailureV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface MemoryCompactionRequestV1 {
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly reserveTokens: number;
  readonly maskableToolResultTokens: number;
  readonly disclose: boolean;
  readonly requestId?: string;
  readonly lease?: MemoryLeaseProofV1;
  /** Provider-side outage; recorded in the provider domain, never as memory. */
  readonly providerFailure?: MemoryProviderFailureV1 | null;
}

export interface MemoryCompactionErrorV1 {
  readonly domain: "provider" | "memory";
  readonly code: string;
  readonly retryable: boolean | null;
}

export interface MemoryCompactionOutcomeV1 {
  readonly ok: true;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly basisRevision: number;
  /** Unmodified policy decision from `decideContextSurgeryV1`. */
  readonly decision: ContextSurgeryDecisionV1;
  readonly authorization: MemoryCompactionAuthorizationV1;
  /** Effective action after provider/memory error gating. */
  readonly action: ContextSurgeryActionV1;
  readonly assurance: ContextSurgeryAssuranceV1;
  readonly reason: ContextSurgeryDecisionV1["reason"];
  readonly preflight: MemoryPreflightV1;
  readonly error: MemoryCompactionErrorV1 | null;
  readonly recorded: boolean;
  readonly receipt: MemoryCompactionReceiptV1;
  readonly reexecute: false;
  readonly replayPolicy: typeof MEMORY_REPLAY_POLICY_V1;
}

// ── recovery ───────────────────────────────────────────────────────────────

export interface MemoryRecoveredEffectV1 {
  readonly receiptId: string | null;
  readonly basisRevision: number;
  readonly status: "waiting";
  readonly assurance: "assurance_unknown";
  readonly reexecute: false;
  readonly reason: "effect_pending" | "effect_unknown";
}

export interface MemoryRecoveryV1 {
  readonly ok: true;
  readonly schemaVersion: MemoryDurabilitySchemaVersionV1;
  readonly recoveredAt: string;
  readonly replayPolicy: typeof MEMORY_REPLAY_POLICY_V1;
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
  readonly manifestRevision: number | null;
  /** `false` when any manifest entry lacks a verified receipt. */
  readonly manifestTrusted: boolean;
  readonly verifiedEntries: number;
  readonly effects: readonly MemoryRecoveredEffectV1[];
  readonly truncated: boolean;
}

export interface MemoryRecoveryRequestV1 {
  readonly scope: MemoryScopeV1;
  readonly scopeKey: string;
}

export type MemoryRecoveryResultV1 =
  | MemoryRecoveryV1
  | MemoryDurabilityFailureV1;

// ── port ───────────────────────────────────────────────────────────────────

export interface ContextMemoryDurabilityPort {
  commit(input: MemoryCommitRequestV1): Promise<MemoryCommitResultV1>;
  preflight(input: MemoryPreflightRequestV1): Promise<MemoryPreflightResultV1>;
  read(input: MemoryReadRequestV1): Promise<MemoryReadResultV1>;
  authorizeCompaction(
    input: MemoryCompactionRequestV1,
  ): Promise<MemoryCompactionOutcomeV1 | MemoryDurabilityFailureV1>;
  recover(input: MemoryRecoveryRequestV1): Promise<MemoryRecoveryResultV1>;
}

type ResolvedMemoryStateV1 =
  | {
      readonly ok: true;
      readonly manifest: MemoryCurrentManifestV1;
      readonly entry: MemoryManifestEntryV1;
      readonly receipt: MemoryDurableReceiptV1;
      readonly document: MemoryFactDocumentV1;
      readonly checks: readonly MemoryPreflightCheckV1[];
    }
  | {
      readonly ok: false;
      readonly status: DurableExternalizationStatusV1;
      readonly reason: MemoryPreflightReasonV1;
      readonly failureCode: MemoryDurabilityFailureCodeV1;
      readonly failure: MemoryDurabilityFailureV1 | null;
      readonly checks: readonly MemoryPreflightCheckV1[];
    };

interface ArtifactFailureMappingV1 {
  readonly code: MemoryDurabilityFailureCodeV1;
  readonly reason: MemoryPreflightReasonV1;
}

const ARTIFACT_FAILURE_MAP_V1: Readonly<
  Record<string, ArtifactFailureMappingV1>
> = Object.freeze({
  artifact_not_found: {
    code: "memory_artifact_missing",
    reason: "artifact_missing",
  },
  artifact_not_prepared: {
    code: "memory_artifact_missing",
    reason: "artifact_missing",
  },
  artifact_corrupt: {
    code: "memory_artifact_corrupt",
    reason: "artifact_corrupt",
  },
  artifact_hash_mismatch: {
    code: "memory_artifact_hash_mismatch",
    reason: "artifact_hash_mismatch",
  },
  artifact_size_mismatch: {
    code: "memory_artifact_corrupt",
    reason: "artifact_corrupt",
  },
  artifact_scope_mismatch: {
    code: "memory_artifact_scope_mismatch",
    reason: "artifact_scope_mismatch",
  },
  artifact_stale: { code: "memory_artifact_stale", reason: "artifact_stale" },
  artifact_conflict: {
    code: "memory_artifact_conflict",
    reason: "artifact_corrupt",
  },
  artifact_ref_invalid: {
    code: "memory_artifact_corrupt",
    reason: "artifact_corrupt",
  },
  artifact_path_escape: {
    code: "memory_artifact_corrupt",
    reason: "artifact_corrupt",
  },
  artifact_invalid_input: {
    code: "memory_invalid_input",
    reason: "artifact_corrupt",
  },
});

const MEMORY_FAILURE_CODES_V1: ReadonlySet<string> = new Set([
  "memory_invalid_input",
  "memory_content_rejected",
  "memory_request_conflict",
  "memory_scope_mismatch",
  "memory_basis_conflict",
  "memory_receipt_absent",
  "memory_receipt_pending",
  "memory_receipt_corrupt",
  "memory_receipt_hash_mismatch",
  "memory_receipt_conflict",
  "memory_manifest_absent",
  "memory_manifest_corrupt",
  "memory_manifest_stale",
  "memory_cas_conflict",
  "memory_artifact_missing",
  "memory_artifact_corrupt",
  "memory_artifact_hash_mismatch",
  "memory_artifact_scope_mismatch",
  "memory_artifact_stale",
  "memory_artifact_conflict",
  "memory_not_durable",
  "memory_disclosure_missing",
  "memory_lease_missing",
  "memory_lease_fenced",
  "memory_lease_expired",
  "memory_audit_write_failed",
  "memory_store_denied",
  "memory_store_unavailable",
]);

function isMemoryFailureCodeV1(code: string): boolean {
  return MEMORY_FAILURE_CODES_V1.has(code);
}

const PREFLIGHT_REASON_CODES_V1: Readonly<
  Record<MemoryPreflightReasonV1, MemoryDurabilityFailureCodeV1>
> = Object.freeze({
  verified_durable: "memory_not_durable",
  manifest_absent: "memory_manifest_absent",
  manifest_corrupt: "memory_manifest_corrupt",
  manifest_stale_revision: "memory_manifest_stale",
  manifest_entry_missing: "memory_receipt_absent",
  receipt_absent: "memory_receipt_absent",
  receipt_pending: "memory_receipt_pending",
  receipt_denied: "memory_store_denied",
  receipt_corrupt: "memory_receipt_corrupt",
  receipt_hash_mismatch: "memory_receipt_hash_mismatch",
  receipt_conflict: "memory_receipt_conflict",
  artifact_missing: "memory_artifact_missing",
  artifact_corrupt: "memory_artifact_corrupt",
  artifact_hash_mismatch: "memory_artifact_hash_mismatch",
  artifact_scope_mismatch: "memory_artifact_scope_mismatch",
  artifact_stale: "memory_artifact_stale",
  scope_key_mismatch: "memory_scope_mismatch",
  store_unavailable: "memory_store_unavailable",
  unknown: "memory_not_durable",
});

// ── pure helpers ───────────────────────────────────────────────────────────

function emptyProgressV1(): MemoryCommitProgressV1 {
  return Object.freeze({ artifact: false, receipt: false, manifest: false });
}

function progressV1(
  artifact: boolean,
  receipt: boolean,
  manifest: boolean,
): MemoryCommitProgressV1 {
  return Object.freeze({ artifact, receipt, manifest });
}

/** Structured code for a failed resolution: prefer an explicit memory code. */
function resolveFailureCodeV1(
  failure: { readonly code: string; readonly domain?: unknown } | null,
  reason: MemoryPreflightReasonV1,
): MemoryDurabilityFailureCodeV1 {
  if (
    failure !== null &&
    failure.domain === "memory" &&
    isMemoryFailureCodeV1(failure.code)
  ) {
    return failure.code as MemoryDurabilityFailureCodeV1;
  }
  return PREFLIGHT_REASON_CODES_V1[reason];
}

function checkV1(
  name: string,
  ok: boolean,
  detail: string | null,
): MemoryPreflightCheckV1 {
  return Object.freeze({ name, ok, detail });
}

function disclosureV1(receipt: MemoryDurableReceiptV1): MemoryReadDisclosureV1 {
  return Object.freeze({
    path: receipt.storageRef,
    fingerprint: receipt.contentHash,
    whenToRead: receipt.whenToRead,
    scope: receipt.scope,
    scopeKey: receipt.scopeKey,
    basisRevision: receipt.basisRevision,
    readVia: "artifact_store" as const,
  });
}

function externalizationV1(
  status: DurableExternalizationStatusV1,
  disclosure: MemoryReadDisclosureV1 | null,
  disclosed: boolean,
): DurableExternalizationV1 {
  if (status !== "durable" || disclosure === null) {
    return Object.freeze({
      status,
      path: null,
      fingerprint: null,
      disclosed: false,
      whenToRead: null,
    });
  }
  return Object.freeze({
    status,
    path: disclosure.path,
    fingerprint: disclosure.fingerprint,
    disclosed,
    whenToRead: disclosure.whenToRead,
  });
}

function manifestEntryMatchesReceiptV1(
  entry: MemoryManifestEntryV1,
  receipt: MemoryDurableReceiptV1,
): boolean {
  return (
    entry.receiptId === receipt.receiptId &&
    entry.artifactId === receipt.artifactId &&
    entry.version === receipt.version &&
    entry.basisRevision === receipt.basisRevision &&
    entry.contentHash === receipt.contentHash &&
    entry.byteLength === receipt.byteLength &&
    entry.storageRef === receipt.storageRef &&
    entry.receiptHash === receipt.receiptHash &&
    entry.factCount === receipt.factCount &&
    entry.summaryCount === receipt.summaryCount &&
    entry.whenToRead === receipt.whenToRead
  );
}

function buildReceiptV1(
  input: Omit<MemoryDurableReceiptV1, "schemaVersion" | "kind" | "receiptHash">,
): MemoryDurableReceiptV1 {
  const body: MemoryDurableReceiptBodyV1 = {
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_DURABLE_RECEIPT_KIND_V1,
    ...input,
  };
  return Object.freeze({ ...body, receiptHash: receiptHashV1(body) });
}

function buildManifestV1(
  input: Omit<
    MemoryCurrentManifestV1,
    "schemaVersion" | "kind" | "manifestId" | "manifestHash"
  >,
): MemoryCurrentManifestV1 {
  const body: MemoryCurrentManifestBodyV1 = {
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_CURRENT_MANIFEST_KIND_V1,
    manifestId: memoryManifestIdV1(input.scope, input.scopeKey, input.revision),
    ...input,
  };
  return Object.freeze({ ...body, manifestHash: manifestHashV1(body) });
}

function buildReadReceiptV1(
  input: Omit<
    MemoryReadReceiptV1,
    "schemaVersion" | "kind" | "readReceiptId" | "receiptHash"
  >,
): MemoryReadReceiptV1 {
  const body = {
    ...input,
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_READ_RECEIPT_KIND_V1,
    readReceiptId: `memory_read_receipt_v1_${input.requestHash.slice(
      "sha256:".length,
      "sha256:".length + 32,
    )}`,
  };
  return Object.freeze({
    ...body,
    receiptHash: auditReceiptHashV1(body),
  }) as MemoryReadReceiptV1;
}

function buildCompactionReceiptV1(
  input: Omit<
    MemoryCompactionReceiptV1,
    | "schemaVersion"
    | "kind"
    | "compactionReceiptId"
    | "receiptHash"
    | "maskThreshold"
    | "compressionThreshold"
    | "keep"
    | "clearAtLeastPercent"
    | "reexecute"
    | "replayPolicy"
  > & { readonly decision: ContextSurgeryDecisionV1 },
): MemoryCompactionReceiptV1 {
  const { decision, ...rest } = input;
  const body = {
    ...rest,
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: MEMORY_COMPACTION_RECEIPT_KIND_V1,
    compactionReceiptId: `memory_compaction_receipt_v1_${input.requestHash.slice(
      "sha256:".length,
      "sha256:".length + 32,
    )}`,
    maskThreshold: decision.maskThreshold,
    compressionThreshold: decision.compressionThreshold,
    keep: decision.keep,
    clearAtLeastPercent: decision.clearAtLeastPercent,
    reexecute: false as const,
    replayPolicy: MEMORY_REPLAY_POLICY_V1,
  };
  return Object.freeze({
    ...body,
    receiptHash: auditReceiptHashV1(body),
  }) as MemoryCompactionReceiptV1;
}

// ── request validation ─────────────────────────────────────────────────────

function validateScopeInputV1(
  input: unknown,
  requireCanonicalScopeKey = false,
): MemoryDurabilityFailureV1 | null {
  if (!isPlainRecordV1(input)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "memory durability input must be an object",
    );
  }
  if (!isArtifactScopeV1(input.scope)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      `scope must be one of: ${ARTIFACT_SCOPES_V1.join(", ")}`,
    );
  }
  if (!isArtifactScopeKeyV1(input.scopeKey)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "scopeKey must be a stable non-empty key",
      { scope: input.scope },
    );
  }
  const scopeKeySafety = scanTextSafetyV1(input.scopeKey);
  if (scopeKeySafety !== null) {
    return memoryDurabilityFailureV1(
      "memory_content_rejected",
      "scopeKey may not contain a host path or credential-like value",
      { scope: input.scope, details: { violation: scopeKeySafety } },
    );
  }
  // Preserve legacy free-form keys for compatibility unless a Native Host
  // explicitly opts into the versioned workspace/project identity contract.
  if (
    requireCanonicalScopeKey &&
    !input.scopeKey.startsWith(MEMORY_SCOPE_KEY_PREFIX_V1)
  ) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "this host requires a canonical scope-v1 key",
      { scope: input.scope },
    );
  }
  if (input.scopeKey.startsWith(MEMORY_SCOPE_KEY_PREFIX_V1)) {
    const decoded = decodeMemoryScopeKeyV1(input.scopeKey);
    if (!decoded.ok) {
      return memoryDurabilityFailureV1(
        "memory_invalid_input",
        decoded.issue.message,
        { scope: input.scope, scopeKey: input.scopeKey },
      );
    }
    if (decoded.descriptor.scope !== input.scope) {
      return memoryDurabilityFailureV1(
        "memory_scope_mismatch",
        "canonical scopeKey scope does not match the request scope",
        {
          scope: input.scope,
          scopeKey: input.scopeKey,
          details: { descriptorScope: decoded.descriptor.scope },
        },
      );
    }
  }
  return null;
}

function validateCommitRequestV1(
  input: MemoryCommitRequestV1,
  requireCanonicalScopeKey = false,
): MemoryDurabilityFailureV1 | null {
  const scopeFailure = validateScopeInputV1(input, requireCanonicalScopeKey);
  if (scopeFailure !== null) return scopeFailure;
  const scope = input.scope;
  const scopeKey = input.scopeKey;
  if (!isLogicalIdV1(input.requestId)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "requestId must be a logical id",
      { scope, scopeKey },
    );
  }
  if (!isArtifactIdV1(input.artifactId)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "artifactId must be a lowercase logical id",
      { scope, scopeKey },
    );
  }
  if (!isArtifactVersionV1(input.version)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "version must be a positive safe integer",
      { scope, scopeKey },
    );
  }
  if (!isArtifactBasisRevisionV1(input.basisRevision)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "basisRevision must be a non-negative safe integer",
      { scope, scopeKey },
    );
  }
  if (
    input.expectedManifestRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedManifestRevision) ||
      input.expectedManifestRevision < 0)
  ) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "expectedManifestRevision must be a non-negative safe integer",
      { scope, scopeKey },
    );
  }
  return null;
}

function validatePreflightRequestV1(
  input: MemoryPreflightRequestV1,
  requireCanonicalScopeKey = false,
): MemoryDurabilityFailureV1 | null {
  const scopeFailure = validateScopeInputV1(input, requireCanonicalScopeKey);
  if (scopeFailure !== null) return scopeFailure;
  if (!isArtifactBasisRevisionV1(input.basisRevision)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "basisRevision must be a non-negative safe integer",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (typeof input.disclose !== "boolean") {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "disclose must be boolean",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  return null;
}

function validateReadRequestV1(
  input: MemoryReadRequestV1,
  requireCanonicalScopeKey = false,
): MemoryDurabilityFailureV1 | null {
  const scopeFailure = validateScopeInputV1(input, requireCanonicalScopeKey);
  if (scopeFailure !== null) return scopeFailure;
  if (!isArtifactBasisRevisionV1(input.basisRevision)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "basisRevision must be a non-negative safe integer",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (typeof input.acknowledgeDisclosure !== "boolean") {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "acknowledgeDisclosure must be boolean",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (input.acknowledgeDisclosure !== true) {
    return memoryDurabilityFailureV1(
      "memory_disclosure_missing",
      "memory.read requires an explicit disclosure acknowledgement before returning facts",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (input.requestId !== undefined && !isLogicalIdV1(input.requestId)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "requestId must be a logical id",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  return null;
}

function validateCompactionRequestV1(
  input: MemoryCompactionRequestV1,
  requireCanonicalScopeKey = false,
): MemoryDurabilityFailureV1 | null {
  const scopeFailure = validateScopeInputV1(input, requireCanonicalScopeKey);
  if (scopeFailure !== null) return scopeFailure;
  if (!isArtifactBasisRevisionV1(input.basisRevision)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "basisRevision must be a non-negative safe integer",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (typeof input.disclose !== "boolean") {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "disclose must be boolean",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (
    input.providerFailure !== undefined &&
    input.providerFailure !== null &&
    (!isPlainRecordV1(input.providerFailure) ||
      !isLogicalIdV1(input.providerFailure.code))
  ) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "providerFailure.code must be a logical id",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  if (input.requestId !== undefined && !isLogicalIdV1(input.requestId)) {
    return memoryDurabilityFailureV1(
      "memory_invalid_input",
      "requestId must be a logical id",
      { scope: input.scope, scopeKey: input.scopeKey },
    );
  }
  return null;
}

// ── port ───────────────────────────────────────────────────────────────────

class ContextMemoryDurability implements ContextMemoryDurabilityPort {
  readonly #artifacts: ArtifactStorePort;
  readonly #receipts: MemoryReceiptStorePort;
  readonly #manifests: MemoryManifestStorePort;
  readonly #audits: MemoryAuditReceiptStorePort;
  readonly #leases: MemoryLeasePort | undefined;
  readonly #now: () => Date;
  readonly #requireLease: boolean;
  readonly #requireCanonicalScopeKey: boolean;
  readonly #policy: ContextMemoryPolicyConfigV1;

  constructor(deps: ContextMemoryDurabilityDepsV1) {
    this.#artifacts = deps.artifacts;
    this.#receipts = deps.receipts;
    this.#manifests = deps.manifests;
    this.#audits = deps.audits;
    this.#leases = deps.leases;
    this.#now = deps.now ?? ((): Date => new Date());
    this.#requireLease = deps.requireLease ?? false;
    this.#requireCanonicalScopeKey = deps.requireCanonicalScopeKey ?? false;
    this.#policy = deps.policy ?? {};
  }

  // ── commit ───────────────────────────────────────────────────────────────

  async commit(input: MemoryCommitRequestV1): Promise<MemoryCommitResultV1> {
    const invalid = validateCommitRequestV1(
      input,
      this.#requireCanonicalScopeKey,
    );
    if (invalid !== null) return invalid;
    const scope = input.scope;
    const scopeKey = input.scopeKey;
    const progress = emptyProgressV1();
    const decode = decodeMemoryFactDocumentV1(input.document);
    if (!decode.ok) {
      return {
        ...decode,
        scope,
        scopeKey,
        stage: "artifact",
        progress,
      };
    }
    const document = decode.document;
    if (document.scope !== scope || document.scopeKey !== scopeKey) {
      return this.#fail(
        "memory_scope_mismatch",
        "memory fact document scope does not match the commit request",
        {
          scope,
          scopeKey,
          stage: "artifact",
          progress,
          details: { documentScope: document.scope },
        },
      );
    }
    if (document.basisRevision !== input.basisRevision) {
      return this.#fail(
        "memory_invalid_input",
        "memory fact document basisRevision must equal the commit request basisRevision",
        { scope, scopeKey, stage: "artifact", progress },
      );
    }
    const whenToRead = input.whenToRead;
    if (!isTextV1(whenToRead, MEMORY_MAX_WHEN_TO_READ_CHARS_V1)) {
      return this.#fail(
        "memory_invalid_input",
        "whenToRead must be a trimmed non-empty string without control characters",
        { scope, scopeKey, stage: "artifact", progress },
      );
    }
    const whenToReadViolation = scanTextSafetyV1(whenToRead);
    if (whenToReadViolation !== null) {
      return this.#fail(
        "memory_content_rejected",
        "whenToRead may not disclose host paths or credential material",
        {
          scope,
          scopeKey,
          stage: "artifact",
          progress,
          details: { violation: whenToReadViolation },
        },
      );
    }

    const content = encodeMemoryFactDocumentV1(document);
    if (content.byteLength > MEMORY_MAX_DOCUMENT_BYTES_V1) {
      return this.#fail(
        "memory_content_rejected",
        `memory fact document exceeds ${MEMORY_MAX_DOCUMENT_BYTES_V1} bytes`,
        { scope, scopeKey, stage: "artifact", progress },
      );
    }
    const contentHash = hashArtifactContentV1(content);
    const storageRef = formatArtifactStorageRefV1(
      input.artifactId,
      input.version,
      contentHash,
    );
    const requestHash = memoryCommitRequestHashV1({
      requestId: input.requestId,
      scope,
      scopeKey,
      artifactId: input.artifactId,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash,
      byteLength: content.byteLength,
      whenToRead,
    });
    const receiptId = memoryReceiptIdV1({
      scope,
      scopeKey,
      artifactId: input.artifactId,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash,
    });

    const leaseFailure = await this.#leaseGate({
      lease: input.lease,
      scope,
      scopeKey,
      requestHash,
      stage: "artifact",
      progress,
    });
    if (leaseFailure !== null) return leaseFailure;

    // Idempotent replay: an existing verified receipt for this exact request is
    // reused and only a missing manifest entry is completed.
    const existing = await this.#receipts.getReceipt({
      scope,
      scopeKey,
      receiptId,
    });
    if (!existing.ok) {
      return this.#adoptStore(
        existing,
        { scope, scopeKey, stage: "receipt", progress },
        "receipt_read",
      );
    }
    if (existing.status === "found") {
      const verifiedReceipt = decodeMemoryDurableReceiptV1(existing.receipt);
      if (verifiedReceipt === null) {
        return this.#fail(
          "memory_receipt_corrupt",
          "an existing receipt for this request is damaged and cannot be replayed",
          { scope, scopeKey, stage: "receipt", progress },
        );
      }
      if (verifiedReceipt.requestHash !== requestHash) {
        return this.#fail(
          "memory_request_conflict",
          "this request id is already bound to a different memory payload",
          {
            scope,
            scopeKey,
            stage: "receipt",
            progress,
            details: {
              existing: verifiedReceipt.requestHash,
              requested: requestHash,
            },
          },
        );
      }
      return this.#completeManifest({
        requestId: input.requestId,
        scope,
        scopeKey,
        basisRevision: input.basisRevision,
        receipt: verifiedReceipt,
        expectedManifestRevision: input.expectedManifestRevision,
        lease: input.lease,
        replay: true,
      });
    }
    if (existing.status === "pending") {
      return this.#fail(
        "memory_receipt_pending",
        "a receipt for this request is still pending and is never assumed durable",
        { scope, scopeKey, stage: "receipt", progress },
      );
    }
    if (existing.status === "corrupt") {
      return this.#fail(
        "memory_receipt_corrupt",
        `an existing receipt for this request is damaged: ${existing.detail}`,
        { scope, scopeKey, stage: "receipt", progress },
      );
    }

    // The request id is the caller's idempotency key, so it must stay bound to
    // exactly one payload even when the payload change also changes the
    // receipt id derived from the content hash.
    const boundToRequest = await this.#findReceiptByRequestId({
      scope,
      scopeKey,
      requestId: input.requestId,
    });
    if (!boundToRequest.ok) {
      return this.#adoptStore(
        boundToRequest.failure,
        { scope, scopeKey, stage: "receipt", progress },
        "receipt_read",
      );
    }
    if (boundToRequest.receipt !== null) {
      if (boundToRequest.receipt.contentHash !== contentHash) {
        return this.#fail(
          "memory_request_conflict",
          "this request id is already bound to a different memory payload",
          {
            scope,
            scopeKey,
            stage: "receipt",
            progress,
            details: {
              existing: boundToRequest.receipt.contentHash,
              requested: contentHash,
            },
          },
        );
      }
    }

    // Step 1 — immutable artifact.
    const prepared = await this.#artifacts.prepare({
      artifactId: input.artifactId,
      scope,
      scopeKey,
      version: input.version,
      basisRevision: input.basisRevision,
      content,
      expectedContentHash: contentHash,
    });
    if (!prepared.ok) {
      return this.#mapArtifactFailure(prepared, {
        scope,
        scopeKey,
        stage: "artifact",
        progress,
      });
    }
    const committed = await this.#artifacts.commitImmutable({
      artifactId: input.artifactId,
      scope,
      scopeKey,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash,
      byteLength: content.byteLength,
    });
    if (!committed.ok) {
      return this.#mapArtifactFailure(committed, {
        scope,
        scopeKey,
        stage: "artifact",
        progress,
      });
    }
    const artifactProgress = progressV1(true, false, false);

    // Step 2 — durable receipt, verified by an immediate read-back.
    const receipt = buildReceiptV1({
      receiptId,
      requestId: input.requestId,
      requestHash,
      scope,
      scopeKey,
      artifactId: input.artifactId,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash,
      byteLength: content.byteLength,
      storageRef,
      factCount: document.facts.length,
      summaryCount: document.summaries.length,
      whenToRead,
      committedAt: this.#timestamp(),
    });
    const put = await this.#receipts.putReceipt({
      idempotencyKey: input.requestId,
      requestHash,
      receipt,
      lease: input.lease,
    });
    if (!put.ok) {
      return this.#adoptStore(
        put,
        { scope, scopeKey, stage: "receipt", progress: artifactProgress },
        "receipt_put",
      );
    }
    const stored = await this.#receipts.getReceipt({
      scope,
      scopeKey,
      receiptId,
    });
    if (!stored.ok) {
      return this.#adoptStore(
        stored,
        { scope, scopeKey, stage: "receipt", progress: artifactProgress },
        "receipt_read",
      );
    }
    if (stored.status !== "found") {
      return this.#fail(
        "memory_receipt_absent",
        `the receipt write did not read back (store status: ${stored.status})`,
        { scope, scopeKey, stage: "receipt", progress: artifactProgress },
      );
    }
    const readBack = decodeMemoryDurableReceiptV1(stored.receipt);
    if (readBack === null) {
      return this.#fail(
        "memory_receipt_hash_mismatch",
        "the stored receipt does not verify against its own hash and fields",
        { scope, scopeKey, stage: "receipt", progress: artifactProgress },
      );
    }
    if (readBack.requestHash !== requestHash) {
      return this.#fail(
        "memory_receipt_conflict",
        "the stored receipt belongs to a different request payload",
        { scope, scopeKey, stage: "receipt", progress: artifactProgress },
      );
    }

    // Step 3 — CAS-protected current manifest.
    return this.#completeManifest({
      requestId: input.requestId,
      scope,
      scopeKey,
      basisRevision: input.basisRevision,
      receipt: readBack,
      expectedManifestRevision: input.expectedManifestRevision,
      lease: input.lease,
      replay: false,
    });
  }

  async #completeManifest(input: {
    readonly requestId: string;
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly basisRevision: number;
    readonly receipt: MemoryDurableReceiptV1;
    readonly expectedManifestRevision: number | undefined;
    readonly lease: MemoryLeaseProofV1 | undefined;
    readonly replay: boolean;
  }): Promise<MemoryCommitResultV1> {
    const { receipt, scope, scopeKey, basisRevision } = input;
    const stage = progressV1(true, true, false);
    const leaseFailure = await this.#leaseGate({
      lease: input.lease,
      scope,
      scopeKey,
      requestHash: receipt.requestHash,
      stage: "manifest",
      progress: stage,
    });
    if (leaseFailure !== null) return leaseFailure;

    // The artifact must still read back before any manifest may claim durable.
    const artifactCheck = await this.#readVerifiedArtifact(receipt);
    if (!artifactCheck.ok) {
      return this.#fail(
        artifactCheck.code,
        "the durable artifact behind this receipt cannot be verified, so no manifest is written",
        { scope, scopeKey, stage: "manifest", progress: stage },
      );
    }

    const currentLookup = await this.#manifests.readCurrent({
      scope,
      scopeKey,
    });
    if (!currentLookup.ok) {
      return this.#adoptStore(
        currentLookup,
        { scope, scopeKey, stage: "manifest", progress: stage },
        "manifest_read",
      );
    }
    let current: MemoryCurrentManifestV1 | null = null;
    if (currentLookup.status === "found") {
      current = decodeMemoryCurrentManifestV1(currentLookup.manifest);
      if (current === null) {
        return this.#fail(
          "memory_manifest_corrupt",
          "the current manifest is damaged and is never trusted or overwritten",
          { scope, scopeKey, stage: "manifest", progress: stage },
        );
      }
    }
    const actualRevision = current?.revision ?? 0;
    const expected = input.expectedManifestRevision ?? actualRevision;
    if (expected !== actualRevision) {
      return this.#fail(
        "memory_manifest_stale",
        "the manifest revision moved on; this commit is stale and writes nothing",
        {
          scope,
          scopeKey,
          stage: "manifest",
          progress: stage,
          details: { expected, actual: actualRevision },
        },
      );
    }
    const existingEntry =
      current?.entries.find((entry) => entry.basisRevision === basisRevision) ??
      null;
    if (existingEntry !== null && current !== null) {
      if (
        existingEntry.receiptId === receipt.receiptId &&
        existingEntry.receiptHash === receipt.receiptHash
      ) {
        return this.#success({ replay: true, receipt, manifest: current });
      }
      return this.#fail(
        "memory_basis_conflict",
        "this basis revision is already durably bound to a different artifact",
        {
          scope,
          scopeKey,
          stage: "manifest",
          progress: stage,
          details: {
            existing: existingEntry.receiptHash,
            requested: receipt.receiptHash,
          },
        },
      );
    }

    const entries = Object.freeze([
      ...(current?.entries ?? []),
      memoryManifestEntryFromReceiptV1(receipt),
    ]);
    const manifest = buildManifestV1({
      scope,
      scopeKey,
      revision: actualRevision + 1,
      previousRevision: current?.revision ?? null,
      entries,
      committedAt: this.#timestamp(),
    });
    const manifestRequestHash = fingerprintPactileContractV1({
      domain: "memory-manifest-request-v1",
      requestId: input.requestId,
      scope,
      scopeKey,
      expectedRevision: expected,
      manifestHash: manifest.manifestHash,
    });
    const cas = await this.#manifests.compareAndSwap({
      idempotencyKey: input.requestId,
      requestHash: manifestRequestHash,
      scope,
      scopeKey,
      expectedRevision: expected,
      manifest,
      lease: input.lease,
    });
    if (!cas.ok) {
      return this.#adoptStore(
        cas,
        { scope, scopeKey, stage: "manifest", progress: stage },
        "manifest_cas",
      );
    }
    const verifyLookup = await this.#manifests.readCurrent({ scope, scopeKey });
    if (!verifyLookup.ok) {
      return this.#adoptStore(
        verifyLookup,
        { scope, scopeKey, stage: "manifest", progress: stage },
        "manifest_read",
      );
    }
    const persisted =
      verifyLookup.status === "found"
        ? decodeMemoryCurrentManifestV1(verifyLookup.manifest)
        : null;
    if (persisted === null) {
      return this.#fail(
        "memory_manifest_corrupt",
        "the manifest write could not be verified; the effect is unknown and is not replayed",
        {
          scope,
          scopeKey,
          stage: "manifest",
          progress: stage,
          details: { effect: "unknown", applied: cas.applied },
        },
      );
    }
    return this.#success({
      replay: input.replay || !cas.applied,
      receipt,
      manifest: persisted,
    });
  }

  #success(input: {
    readonly replay: boolean;
    readonly receipt: MemoryDurableReceiptV1;
    readonly manifest: MemoryCurrentManifestV1;
  }): MemoryCommitSuccessV1 {
    const { receipt, manifest } = input;
    return Object.freeze({
      ok: true as const,
      replay: input.replay,
      durable: true as const,
      order: MEMORY_COMMIT_ORDER_V1,
      scope: receipt.scope,
      scopeKey: receipt.scopeKey,
      artifactId: receipt.artifactId,
      version: receipt.version,
      basisRevision: receipt.basisRevision,
      contentHash: receipt.contentHash,
      byteLength: receipt.byteLength,
      storageRef: receipt.storageRef,
      factCount: receipt.factCount,
      summaryCount: receipt.summaryCount,
      whenToRead: receipt.whenToRead,
      receiptId: receipt.receiptId,
      receiptHash: receipt.receiptHash,
      manifestId: manifest.manifestId,
      manifestRevision: manifest.revision,
      manifestHash: manifest.manifestHash,
    });
  }

  // ── preflight ────────────────────────────────────────────────────────────

  async preflight(
    input: MemoryPreflightRequestV1,
  ): Promise<MemoryPreflightResultV1> {
    const invalid = validatePreflightRequestV1(
      input,
      this.#requireCanonicalScopeKey,
    );
    if (invalid !== null) return invalid;
    const resolved = await this.#resolve({
      scope: input.scope,
      scopeKey: input.scopeKey,
      basisRevision: input.basisRevision,
    });
    return this.#toPreflight(resolved, input.disclose);
  }

  async #resolve(input: {
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly basisRevision: number;
  }): Promise<ResolvedMemoryStateV1> {
    const { scope, scopeKey, basisRevision } = input;
    const checks: MemoryPreflightCheckV1[] = [];
    const failed = (
      status: DurableExternalizationStatusV1,
      reason: MemoryPreflightReasonV1,
      check: string,
      failure: { readonly code: string; readonly domain?: unknown } | null,
    ): ResolvedMemoryStateV1 => {
      const failureCode = resolveFailureCodeV1(failure, reason);
      checks.push(checkV1(check, false, failureCode));
      return Object.freeze({
        ok: false as const,
        status,
        reason,
        failureCode,
        failure:
          failure !== null && failure.domain === "memory"
            ? (failure as MemoryDurabilityFailureV1)
            : null,
        checks: Object.freeze([...checks]),
      });
    };

    const manifestLookup = await this.#manifests.readCurrent({
      scope,
      scopeKey,
    });
    if (!manifestLookup.ok) {
      return failed("unknown", "store_unavailable", "manifest", manifestLookup);
    }
    let manifest: MemoryCurrentManifestV1 | null = null;
    if (manifestLookup.status === "found") {
      manifest = decodeMemoryCurrentManifestV1(manifestLookup.manifest);
      if (manifest === null) {
        return failed("unknown", "manifest_corrupt", "manifest", null);
      }
    }
    checks.push(
      checkV1(
        "manifest",
        true,
        manifest === null ? "absent" : `revision:${manifest.revision}`,
      ),
    );

    if (manifest !== null) {
      const entry =
        manifest.entries.find((item) => item.basisRevision === basisRevision) ??
        null;
      const newest = newestManifestBasisRevisionV1(manifest);
      if (entry === null) {
        const pending = await this.#hasReceiptForBasis(
          scope,
          scopeKey,
          basisRevision,
        );
        if (!pending.ok) return pending.state;
        if (pending.found) {
          return failed("pending", "receipt_pending", "receipt", null);
        }
        if (newest !== null && newest > basisRevision) {
          return failed(
            "unknown",
            "manifest_stale_revision",
            "basis_revision",
            null,
          );
        }
        return failed(
          "absent",
          "manifest_entry_missing",
          "manifest_entry",
          null,
        );
      }
      if (newest !== null && newest > basisRevision) {
        return failed(
          "unknown",
          "manifest_stale_revision",
          "basis_revision",
          null,
        );
      }
      const receiptLookup = await this.#receipts.getReceipt({
        scope,
        scopeKey,
        receiptId: entry.receiptId,
      });
      if (!receiptLookup.ok) {
        if (receiptLookup.code === "memory_store_denied") {
          return failed("unknown", "receipt_denied", "receipt", receiptLookup);
        }
        return failed("unknown", "store_unavailable", "receipt", receiptLookup);
      }
      if (receiptLookup.status !== "found") {
        if (receiptLookup.status === "pending") {
          return failed("pending", "receipt_pending", "receipt", null);
        }
        if (receiptLookup.status === "corrupt") {
          return failed("unknown", "receipt_corrupt", "receipt", null);
        }
        return failed("unknown", "receipt_absent", "receipt", null);
      }
      const receipt = decodeMemoryDurableReceiptV1(receiptLookup.receipt);
      if (receipt === null) {
        return failed("unknown", "receipt_hash_mismatch", "receipt", null);
      }
      if (!manifestEntryMatchesReceiptV1(entry, receipt)) {
        return failed("unknown", "receipt_conflict", "receipt", null);
      }
      if (receipt.scope !== scope || receipt.scopeKey !== scopeKey) {
        return failed("unknown", "scope_key_mismatch", "scope", null);
      }
      checks.push(checkV1("receipt", true, `verified:${receipt.receiptId}`));

      const artifactCheck = await this.#readVerifiedArtifact(receipt);
      if (!artifactCheck.ok) {
        return failed("unknown", artifactCheck.reason, "artifact", null);
      }
      const documentDecode = decodeMemoryFactDocumentV1(artifactCheck.document);
      if (!documentDecode.ok) {
        return failed("unknown", "artifact_corrupt", "artifact", null);
      }
      const document = documentDecode.document;
      if (
        document.scope !== scope ||
        document.scopeKey !== scopeKey ||
        document.basisRevision !== receipt.basisRevision
      ) {
        return failed("unknown", "scope_key_mismatch", "document", null);
      }
      if (
        document.facts.length !== receipt.factCount ||
        document.summaries.length !== receipt.summaryCount
      ) {
        return failed("unknown", "receipt_conflict", "document", null);
      }
      checks.push(checkV1("artifact", true, "verified"));
      return Object.freeze({
        ok: true as const,
        manifest,
        entry,
        receipt,
        document,
        checks: Object.freeze([...checks]),
      });
    }

    const pending = await this.#hasReceiptForBasis(
      scope,
      scopeKey,
      basisRevision,
    );
    if (!pending.ok) return pending.state;
    if (pending.found) {
      return failed("pending", "receipt_pending", "receipt", null);
    }
    const listed = await this.#receipts.listReceipts({
      scope,
      scopeKey,
      limit: 1,
    });
    if (!listed.ok) {
      return failed("unknown", "store_unavailable", "receipt", listed);
    }
    if (listed.receipts.length === 0) {
      return failed("absent", "manifest_absent", "manifest_entry", null);
    }
    return failed("unknown", "receipt_absent", "manifest_entry", null);
  }

  async #hasReceiptForBasis(
    scope: MemoryScopeV1,
    scopeKey: string,
    basisRevision: number,
  ): Promise<
    | { readonly ok: true; readonly found: boolean }
    | { readonly ok: false; readonly state: ResolvedMemoryStateV1 }
  > {
    const listed = await this.#receipts.listReceipts({
      scope,
      scopeKey,
      limit: MEMORY_RECEIPT_LIST_LIMIT_V1,
    });
    if (!listed.ok) {
      return {
        ok: false,
        state: Object.freeze({
          ok: false as const,
          status: "unknown" as const,
          reason: "store_unavailable" as const,
          failureCode: "memory_store_unavailable" as const,
          failure: listed,
          checks: Object.freeze([
            checkV1("receipt", false, "store_unavailable"),
          ]),
        }),
      };
    }
    return {
      ok: true,
      found: listed.receipts.some(
        (receipt) => receipt.basisRevision === basisRevision,
      ),
    };
  }

  #toPreflight(
    resolved: ResolvedMemoryStateV1,
    disclose: boolean,
  ): MemoryPreflightV1 {
    if (!resolved.ok) {
      const preflight: MemoryPreflightV1 = Object.freeze({
        ok: true as const,
        status: resolved.status,
        reason: resolved.reason,
        assurance: "assurance_unknown" as const,
        verified: false as const,
        disclosed: false as const,
        scope: null,
        scopeKey: null,
        basisRevision: null,
        contentHash: null,
        receiptId: null,
        manifestRevision: null,
        disclosure: null,
        externalization: externalizationV1(resolved.status, null, false),
        failureCode: resolved.failureCode,
        checks: resolved.checks,
      });
      return preflight;
    }
    const { receipt, manifest } = resolved;
    const disclosure = disclosureV1(receipt);
    const checks: readonly MemoryPreflightCheckV1[] = Object.freeze([
      ...resolved.checks,
      checkV1("disclosure", disclose, disclose ? "disclosed" : "not_disclosed"),
    ]);
    const preflight: MemoryPreflightV1 = Object.freeze({
      ok: true as const,
      status: "durable" as const,
      reason: "verified_durable" as const,
      assurance: "assurance_exact" as const,
      verified: true as const,
      disclosed: disclose,
      scope: receipt.scope,
      scopeKey: receipt.scopeKey,
      basisRevision: receipt.basisRevision,
      contentHash: receipt.contentHash,
      receiptId: receipt.receiptId,
      manifestRevision: manifest.revision,
      disclosure,
      externalization: externalizationV1("durable", disclosure, disclose),
      failureCode: null,
      checks,
    });
    return preflight;
  }

  // ── read ─────────────────────────────────────────────────────────────────

  async read(input: MemoryReadRequestV1): Promise<MemoryReadResultV1> {
    const invalid = validateReadRequestV1(
      input,
      this.#requireCanonicalScopeKey,
    );
    if (invalid !== null) return invalid;
    const { scope, scopeKey, basisRevision } = input;
    const requestHash = fingerprintPactileContractV1({
      domain: "memory-read-request-v1",
      scope,
      scopeKey,
      basisRevision,
      acknowledgeDisclosure: input.acknowledgeDisclosure,
    });
    const requestId =
      input.requestId ??
      `memory_read_v1_${requestHash.slice("sha256:".length, "sha256:".length + 24)}`;
    const leaseFailure = await this.#leaseGate({
      lease: input.lease,
      scope,
      scopeKey,
      requestHash,
      stage: null,
      progress: null,
    });
    if (leaseFailure !== null) return leaseFailure;

    const resolved = await this.#resolve({ scope, scopeKey, basisRevision });
    if (!resolved.ok) {
      return this.#fail(
        PREFLIGHT_REASON_CODES_V1[resolved.reason],
        `memory.read is refused because the durable chain is not verified (${resolved.reason})`,
        {
          scope,
          scopeKey,
          details: { reason: resolved.reason, status: resolved.status },
        },
      );
    }
    const { receipt, manifest, document } = resolved;
    const contentHash = receipt.contentHash;
    const facts = Object.freeze(
      document.facts.map((fact) =>
        Object.freeze({
          factId: fact.factId,
          statement: fact.statement,
          source: "artifact" as const,
          scope: receipt.scope,
          scopeKey: receipt.scopeKey,
          basisRevision: receipt.basisRevision,
          contentHash,
          factHash: memoryFactHashV1(fact, contentHash),
          tags: fact.tags,
          exact: true as const,
        }),
      ),
    );
    const summaries = Object.freeze(
      document.summaries.map((summary) =>
        Object.freeze({
          summaryId: summary.summaryId,
          statement: summary.statement,
          derivedFrom: summary.derivedFrom,
          exact: false as const,
          authoritative: false as const,
        }),
      ),
    );
    const disclosure = disclosureV1(receipt);
    const readReceipt = buildReadReceiptV1({
      requestId,
      requestHash,
      scope,
      scopeKey,
      basisRevision,
      contentHash,
      storageRef: receipt.storageRef,
      manifestRevision: manifest.revision,
      receiptId: receipt.receiptId,
      factIds: Object.freeze(facts.map((fact) => fact.factId)),
      exactFactCount: facts.length,
      summaryCount: summaries.length,
      disclosure: {
        path: disclosure.path,
        fingerprint: disclosure.fingerprint,
        whenToRead: disclosure.whenToRead,
      },
      acknowledgedDisclosure: true,
      recordedAt: this.#timestamp(),
    });
    const append = await this.#audits.append({
      idempotencyKey: requestId,
      requestHash,
      receipt: readReceipt,
    });
    if (!append.ok) {
      return this.#adoptStore(
        append,
        { scope, scopeKey, details: { requirement: "read_receipt_required" } },
        "audit",
      );
    }
    // The read id is derived from the request, so an identical read replays
    // the first audit entry. Return what the audit store holds, never a second
    // receipt that shares its id but not its hash.
    const auditedReceipt = append.receipt ?? readReceipt;
    if (
      auditedReceipt.kind !== MEMORY_READ_RECEIPT_KIND_V1 ||
      auditedReceipt.readReceiptId !== readReceipt.readReceiptId ||
      auditedReceipt.requestHash !== requestHash ||
      auditedReceipt.contentHash !== contentHash ||
      auditedReceipt.storageRef !== receipt.storageRef
    ) {
      return this.#fail(
        "memory_audit_write_failed",
        "the audit store holds a different receipt for this read",
        { scope, scopeKey, details: { requirement: "read_receipt_match" } },
      );
    }
    const success: MemoryReadSuccessV1 = Object.freeze({
      ok: true as const,
      assurance: "assurance_exact" as const,
      scope,
      scopeKey,
      basisRevision,
      contentHash,
      byteLength: receipt.byteLength,
      manifestRevision: manifest.revision,
      receiptId: receipt.receiptId,
      facts,
      summaries,
      exactFactCount: facts.length,
      summaryCount: summaries.length,
      summaryIsExactFactSource: false as const,
      disclosure,
      readReceipt: auditedReceipt,
    });
    return success;
  }

  // ── compaction ───────────────────────────────────────────────────────────

  async authorizeCompaction(
    input: MemoryCompactionRequestV1,
  ): Promise<MemoryCompactionOutcomeV1 | MemoryDurabilityFailureV1> {
    const invalid = validateCompactionRequestV1(
      input,
      this.#requireCanonicalScopeKey,
    );
    if (invalid !== null) return invalid;
    const { scope, scopeKey, basisRevision } = input;
    const providerFailure = input.providerFailure ?? null;
    const requestHash = fingerprintPactileContractV1({
      domain: "memory-compaction-request-v1",
      scope,
      scopeKey,
      basisRevision,
      contextTokens: input.contextTokens,
      contextWindow: input.contextWindow,
      reserveTokens: input.reserveTokens,
      maskableToolResultTokens: input.maskableToolResultTokens,
      disclose: input.disclose,
      providerFailureCode: providerFailure?.code ?? null,
    });
    const requestId =
      input.requestId ??
      `memory_compact_v1_${requestHash.slice("sha256:".length, "sha256:".length + 24)}`;
    const leaseFailure = await this.#leaseGate({
      lease: input.lease,
      scope,
      scopeKey,
      requestHash,
      stage: null,
      progress: null,
    });
    if (leaseFailure !== null) return leaseFailure;

    const resolved = await this.#resolve({ scope, scopeKey, basisRevision });
    const preflight = this.#toPreflight(resolved, input.disclose);
    const decision = decideContextSurgeryV1(
      {
        contextTokens: input.contextTokens,
        contextWindow: input.contextWindow,
        reserveTokens: input.reserveTokens,
        maskableToolResultTokens: input.maskableToolResultTokens,
        externalization: preflight.externalization,
      },
      this.#policy,
    );

    const memoryFault = MEMORY_FAULT_PREFLIGHT_REASONS_V1.includes(
      preflight.reason,
    );
    const memoryErrorCode = memoryFault
      ? PREFLIGHT_REASON_CODES_V1[preflight.reason]
      : null;
    let error: MemoryCompactionErrorV1 | null = null;
    if (memoryFault && memoryErrorCode !== null) {
      error = Object.freeze({
        domain: "memory" as const,
        code: memoryErrorCode,
        retryable: false,
      });
    } else if (providerFailure !== null && decision.action === "compact") {
      error = Object.freeze({
        domain: "provider" as const,
        code: providerFailure.code,
        retryable: providerFailure.retryable ?? null,
      });
    }

    let authorization: MemoryCompactionAuthorizationV1;
    let action: ContextSurgeryActionV1 = decision.action;
    let assurance: ContextSurgeryAssuranceV1 = decision.assurance;
    if (error !== null) {
      authorization =
        error.domain === "provider"
          ? "blocked_provider_error"
          : "blocked_memory_error";
      action = "blocked";
      assurance = "assurance_unknown";
    } else if (decision.action === "compact") {
      authorization = "compact_authorized";
    } else if (decision.action === "mask") {
      authorization = "mask_authorized";
    } else if (decision.action === "blocked") {
      authorization = "blocked_policy";
    } else {
      authorization = "continue_authorized";
    }

    const disclosure = preflight.disclosure;
    const compactionReceipt = buildCompactionReceiptV1({
      requestId,
      requestHash,
      scope,
      scopeKey,
      basisRevision,
      action,
      assurance,
      reason: decision.reason,
      authorization,
      preflightStatus: preflight.status,
      preflightReason: preflight.reason,
      disclosurePath: disclosure?.path ?? null,
      disclosureFingerprint: disclosure?.fingerprint ?? null,
      whenToRead: disclosure?.whenToRead ?? null,
      errorDomain: error?.domain ?? null,
      errorCode: error?.code ?? null,
      providerErrorCode: providerFailure?.code ?? null,
      memoryErrorCode,
      decision,
      recordedAt: this.#timestamp(),
    });
    const append = await this.#audits.append({
      idempotencyKey: requestId,
      requestHash,
      receipt: compactionReceipt,
    });
    if (!append.ok) {
      const blocked: MemoryCompactionOutcomeV1 = Object.freeze({
        ok: true as const,
        scope,
        scopeKey,
        basisRevision,
        decision,
        authorization: "blocked_memory_error" as const,
        action: "blocked" as const,
        assurance: "assurance_unknown" as const,
        reason: decision.reason,
        preflight,
        error: Object.freeze({
          domain: "memory" as const,
          code: "memory_audit_write_failed",
          retryable: false,
        }),
        recorded: false,
        receipt: compactionReceipt,
        reexecute: false as const,
        replayPolicy: MEMORY_REPLAY_POLICY_V1,
      });
      return blocked;
    }
    const outcome: MemoryCompactionOutcomeV1 = Object.freeze({
      ok: true as const,
      scope,
      scopeKey,
      basisRevision,
      decision,
      authorization,
      action,
      assurance,
      reason: decision.reason,
      preflight,
      error,
      recorded: true,
      receipt: compactionReceipt,
      reexecute: false as const,
      replayPolicy: MEMORY_REPLAY_POLICY_V1,
    });
    return outcome;
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  async recover(
    input: MemoryRecoveryRequestV1,
  ): Promise<MemoryRecoveryResultV1> {
    const invalid = validateScopeInputV1(input, this.#requireCanonicalScopeKey);
    if (invalid !== null) return invalid;
    const { scope, scopeKey } = input;
    const manifestLookup = await this.#manifests.readCurrent({
      scope,
      scopeKey,
    });
    if (!manifestLookup.ok) {
      return this.#adoptStore(
        manifestLookup,
        { scope, scopeKey },
        "manifest_read",
      );
    }
    const manifest =
      manifestLookup.status === "found"
        ? decodeMemoryCurrentManifestV1(manifestLookup.manifest)
        : null;
    if (manifestLookup.status === "found" && manifest === null) {
      return this.#fail(
        "memory_manifest_corrupt",
        "the current manifest is damaged and cannot be trusted during recovery",
        { scope, scopeKey },
      );
    }
    const listed = await this.#receipts.listReceipts({
      scope,
      scopeKey,
      limit: MEMORY_RECEIPT_LIST_LIMIT_V1,
    });
    if (!listed.ok) {
      return this.#adoptStore(listed, { scope, scopeKey }, "receipt_read");
    }
    const summaries = new Map(
      listed.receipts.map((summary) => [summary.receiptId, summary]),
    );
    const effects: MemoryRecoveredEffectV1[] = [];
    const referenced = new Set<string>();
    let verifiedEntries = 0;
    for (const entry of manifest?.entries ?? []) {
      referenced.add(entry.receiptId);
      const summary = summaries.get(entry.receiptId);
      if (
        summary?.receiptHash !== entry.receiptHash ||
        summary.contentHash !== entry.contentHash
      ) {
        effects.push(
          Object.freeze({
            receiptId: entry.receiptId,
            basisRevision: entry.basisRevision,
            status: "waiting" as const,
            assurance: "assurance_unknown" as const,
            reexecute: false as const,
            reason: "effect_unknown" as const,
          }),
        );
        continue;
      }
      const receiptLookup = await this.#receipts.getReceipt({
        scope,
        scopeKey,
        receiptId: entry.receiptId,
      });
      const decodedReceipt =
        receiptLookup.ok && receiptLookup.status === "found"
          ? decodeMemoryDurableReceiptV1(receiptLookup.receipt)
          : null;
      if (
        !receiptLookup.ok ||
        receiptLookup.status !== "found" ||
        decodedReceipt === null
      ) {
        effects.push(
          Object.freeze({
            receiptId: entry.receiptId,
            basisRevision: entry.basisRevision,
            status: "waiting" as const,
            assurance: "assurance_unknown" as const,
            reexecute: false as const,
            reason: "effect_unknown" as const,
          }),
        );
        continue;
      }
      const artifactCheck = await this.#readVerifiedArtifact(decodedReceipt);
      if (!artifactCheck.ok) {
        effects.push(
          Object.freeze({
            receiptId: entry.receiptId,
            basisRevision: entry.basisRevision,
            status: "waiting" as const,
            assurance: "assurance_unknown" as const,
            reexecute: false as const,
            reason: "effect_unknown" as const,
          }),
        );
        continue;
      }
      verifiedEntries += 1;
    }
    for (const summary of listed.receipts) {
      if (referenced.has(summary.receiptId)) continue;
      effects.push(
        Object.freeze({
          receiptId: summary.receiptId,
          basisRevision: summary.basisRevision,
          status: "waiting" as const,
          assurance: "assurance_unknown" as const,
          reexecute: false as const,
          reason: "effect_pending" as const,
        }),
      );
    }
    const recovery: MemoryRecoveryV1 = Object.freeze({
      ok: true as const,
      schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
      recoveredAt: this.#timestamp(),
      replayPolicy: MEMORY_REPLAY_POLICY_V1,
      scope,
      scopeKey,
      manifestRevision: manifest?.revision ?? null,
      manifestTrusted:
        manifest !== null &&
        verifiedEntries === manifest.entries.length &&
        manifest.entries.length > 0,
      verifiedEntries,
      effects: Object.freeze(effects),
      truncated: listed.truncated,
    });
    return recovery;
  }

  // ── internals ────────────────────────────────────────────────────────────

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #fail(
    code: MemoryDurabilityFailureCodeV1,
    message: string,
    options: MemoryDurabilityFailureOptionsV1,
  ): MemoryDurabilityFailureV1 {
    return memoryDurabilityFailureV1(code, message, options);
  }

  async #findReceiptByRequestId(input: {
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly requestId: string;
  }): Promise<
    | { readonly ok: true; readonly receipt: MemoryReceiptSummaryV1 | null }
    | { readonly ok: false; readonly failure: MemoryDurabilityFailureV1 }
  > {
    const listed = await this.#receipts.listReceipts({
      scope: input.scope,
      scopeKey: input.scopeKey,
      limit: MEMORY_RECEIPT_LIST_LIMIT_V1,
    });
    if (!listed.ok) return { ok: false, failure: listed };
    return {
      ok: true,
      receipt:
        listed.receipts.find(
          (receipt) => receipt.requestId === input.requestId,
        ) ?? null,
    };
  }

  #mapArtifactFailure(
    failure: { readonly code: string; readonly message: string },
    options: MemoryDurabilityFailureOptionsV1,
  ): MemoryDurabilityFailureV1 {
    const mapped = ARTIFACT_FAILURE_MAP_V1[failure.code];
    return this.#fail(
      mapped?.code ?? "memory_artifact_corrupt",
      failure.message,
      {
        ...options,
        details: { artifactCode: failure.code },
      },
    );
  }

  /**
   * Adopt a host-port failure into the memory domain. A host that already
   * speaks the memory failure vocabulary is passed through; a foreign shape
   * (for example a raw artifact-store failure) is translated so callers never
   * receive a non-memory failure from a memory operation.
   */
  #adoptStore(
    failure: { readonly code: string; readonly message: string },
    options: MemoryDurabilityFailureOptionsV1,
    context:
      | "receipt_put"
      | "receipt_read"
      | "manifest_read"
      | "manifest_cas"
      | "audit"
      | "lease" = "receipt_read",
  ): MemoryDurabilityFailureV1 {
    const foreign = failure as {
      readonly domain?: unknown;
      readonly details?: MemoryDurabilityDetailsV1 | null;
    };
    if (foreign.domain === "memory" && isMemoryFailureCodeV1(failure.code)) {
      return memoryDurabilityFailureV1(
        failure.code as MemoryDurabilityFailureCodeV1,
        failure.message,
        {
          ...options,
          details: options.details ?? foreign.details ?? null,
        },
      );
    }
    let code: MemoryDurabilityFailureCodeV1;
    if (context === "manifest_cas" && failure.code === "artifact_stale") {
      code = "memory_manifest_stale";
    } else if (
      context === "manifest_cas" &&
      failure.code === "artifact_conflict"
    ) {
      code = "memory_cas_conflict";
    } else if (
      context === "receipt_put" &&
      failure.code === "artifact_conflict"
    ) {
      code = "memory_request_conflict";
    } else if (
      context === "receipt_read" &&
      failure.code === "artifact_conflict"
    ) {
      code = "memory_receipt_conflict";
    } else {
      code = "memory_store_unavailable";
    }
    return this.#fail(code, failure.message, {
      ...options,
      details: { storeCode: failure.code },
    });
  }

  async #readVerifiedArtifact(receipt: MemoryDurableReceiptV1): Promise<
    | { readonly ok: true; readonly document: unknown }
    | {
        readonly ok: false;
        readonly code: MemoryDurabilityFailureCodeV1;
        readonly reason: MemoryPreflightReasonV1;
      }
  > {
    const result = await this.#artifacts.read({
      artifactId: receipt.artifactId,
      version: receipt.version,
      storageRef: receipt.storageRef,
      scope: receipt.scope,
      scopeKey: receipt.scopeKey,
      basisRevision: receipt.basisRevision,
      contentHash: receipt.contentHash,
      byteLength: receipt.byteLength,
    });
    if (!result.ok) {
      const mapped = ARTIFACT_FAILURE_MAP_V1[result.code];
      return {
        ok: false,
        code: mapped?.code ?? "memory_artifact_corrupt",
        reason: mapped?.reason ?? "artifact_corrupt",
      };
    }
    const contentFailure = verifyArtifactStoreReadV1(
      result.identity,
      result.content,
      {
        scope: receipt.scope,
        scopeKey: receipt.scopeKey,
        basisRevision: receipt.basisRevision,
        contentHash: receipt.contentHash,
        byteLength: receipt.byteLength,
      },
    );
    if (contentFailure !== null) {
      const mapped = ARTIFACT_FAILURE_MAP_V1[contentFailure.code];
      return {
        ok: false,
        code: mapped?.code ?? "memory_artifact_corrupt",
        reason: mapped?.reason ?? "artifact_corrupt",
      };
    }
    let document: unknown;
    try {
      document = JSON.parse(
        new TextDecoder().decode(result.content),
      ) as unknown;
    } catch {
      return {
        ok: false,
        code: "memory_artifact_corrupt",
        reason: "artifact_corrupt",
      };
    }
    return { ok: true, document };
  }

  async #leaseGate(input: {
    readonly lease: MemoryLeaseProofV1 | undefined;
    readonly scope: MemoryScopeV1;
    readonly scopeKey: string;
    readonly requestHash: string;
    readonly stage: MemoryCommitStageV1 | null;
    readonly progress: MemoryCommitProgressV1 | null;
  }): Promise<MemoryDurabilityFailureV1 | null> {
    const { lease, scope, scopeKey } = input;
    const options: MemoryDurabilityFailureOptionsV1 = {
      scope,
      scopeKey,
      stage: input.stage,
      progress: input.progress,
    };
    if (lease === undefined) {
      if (!this.#requireLease) return null;
      return this.#fail(
        "memory_lease_missing",
        "this host requires a lease proof for durable memory writes",
        options,
      );
    }
    if (!isLogicalIdV1(lease.leaseId) || !isLogicalIdV1(lease.ownerId)) {
      return this.#fail(
        "memory_invalid_input",
        "lease leaseId and ownerId must be logical ids",
        options,
      );
    }
    if (!Number.isSafeInteger(lease.epoch) || lease.epoch < 1) {
      return this.#fail(
        "memory_invalid_input",
        "lease epoch must be a positive safe integer",
        options,
      );
    }
    if (lease.partition !== memoryPartitionV1(scope, scopeKey)) {
      return this.#fail(
        "memory_lease_fenced",
        "the lease proof belongs to a different memory partition",
        { ...options, details: { fence: "lease_partition_mismatch" } },
      );
    }
    if (
      !RFC3339_PATTERN_V1.test(lease.expiresAt) ||
      Number.isNaN(Date.parse(lease.expiresAt))
    ) {
      return this.#fail(
        "memory_invalid_input",
        "lease expiresAt must be an RFC 3339 timestamp",
        options,
      );
    }
    const now = this.#timestamp();
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
      return this.#fail(
        "memory_lease_expired",
        "the lease expired before this durable write started",
        { ...options, details: { fence: "lease_expired", now } },
      );
    }
    if (this.#leases === undefined) {
      return this.#fail(
        "memory_lease_fenced",
        "no lease validator is configured for this host",
        { ...options, details: { fence: "lease_validator_missing" } },
      );
    }
    const validated = await this.#leases.validateLease({
      proof: lease,
      scope,
      scopeKey,
      requestHash: input.requestHash,
      now,
    });
    if (!validated.ok) {
      return this.#adoptStore(
        validated,
        {
          scope,
          scopeKey,
          stage: input.stage,
          progress: input.progress,
        },
        "lease",
      );
    }
    return null;
  }
}

function isPortV1(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === "function");
}

/**
 * Create the durability port over a host adapter. The port is host-neutral: it
 * performs no filesystem, SQLite, Pi or network I/O of its own.
 */
export function createContextMemoryDurabilityV1(
  deps: ContextMemoryDurabilityDepsV1,
): ContextMemoryDurabilityPort {
  if (
    !isPortV1(deps, []) ||
    !isPortV1(deps.artifacts, ["prepare", "commitImmutable", "read"]) ||
    !isPortV1(deps.receipts, ["putReceipt", "getReceipt", "listReceipts"]) ||
    !isPortV1(deps.manifests, ["readCurrent", "compareAndSwap"]) ||
    !isPortV1(deps.audits, ["append"])
  ) {
    throw new TypeError(
      "context memory durability requires artifact, receipt, manifest and audit ports",
    );
  }
  if (deps.leases !== undefined && !isPortV1(deps.leases, ["validateLease"])) {
    throw new TypeError("the lease port must implement validateLease");
  }
  if (deps.requireLease === true && deps.leases === undefined) {
    throw new TypeError(
      "requireLease needs a lease port so durable writes can be fenced",
    );
  }
  return new ContextMemoryDurability(deps);
}
