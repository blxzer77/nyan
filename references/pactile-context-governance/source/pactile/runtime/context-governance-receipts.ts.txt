import type { RuntimeStoreJsonObject } from "./store-port.js";
import type { EffectLedgerEntryV1 } from "./run-ledger.js";

export const CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1 = {
  cdr: "pactile.cg.compression-decision-receipt",
  car: "pactile.cg.compaction-audit-receipt",
  disclosure: "pactile.cg.disclosure-record",
  memoryRead: "pactile.cg.memory-read-record",
  memoryCommit: "pactile.cg.memory-commit-record",
} as const;

export type ContextGovernanceReceiptKindV1 =
  keyof typeof CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1;

export interface ContextGovernanceReceiptBindingV1 {
  readonly kind: ContextGovernanceReceiptKindV1;
  readonly schemaId: string;
  readonly receiptId: string;
  readonly contextOperationId: string;
  readonly operationId: string;
  readonly receiptHash: string;
  readonly bodyHash: string;
  readonly receipt: RuntimeStoreJsonObject;
}

export interface DisclosureRecordV1 {
  readonly schemaId: typeof CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.disclosure;
  readonly schemaVersion: 1;
  readonly plane: "runtime";
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly disclosureId: string;
  readonly manifestRef: string;
  readonly pointer: string;
  readonly restoreTokenRef: string;
  readonly fingerprint: string;
  readonly whenToRead: string;
  readonly scope: string;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly bodyHash: string;
  readonly receiptHash: string;
  readonly createdAt: string;
  readonly provenance: RuntimeStoreJsonObject;
}

export interface MemoryReadRecordV1 {
  readonly schemaId: typeof CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryRead;
  readonly schemaVersion: 1;
  readonly plane: "runtime";
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly readRecordId: string;
  readonly requestHash: string;
  readonly responseHash: string;
  /** Null when the read failed before a durable manifest/content was verified. */
  readonly manifestRef: string | null;
  readonly manifestRevision: number | null;
  readonly contentHash: string | null;
  readonly scope: string;
  readonly scopeKey: string;
  readonly basisRevision: number;
  /** Null when disclosure was never established for the failed read. */
  readonly disclosureRecordId: string | null;
  readonly status: "ok" | "missing" | "permission_denied" | "stale" | "revision_mismatch" | "epoch_mismatch" | "manifest_conflict";
  readonly factIds: readonly string[];
  readonly exactFactCount: number;
  readonly summaryCount: number;
  readonly checks: readonly RuntimeStoreJsonObject[];
  readonly bodyHash: string;
  readonly receiptHash: string;
  readonly createdAt: string;
  readonly provenance: RuntimeStoreJsonObject;
}

/**
 * What the Memory Port durably did for one commit request: artifact, receipt
 * and manifest, in that order. On failure every field the port did not verify
 * is null; `progress` still says how far the order got, so an unbound
 * artifact or receipt is visible without being claimed as durable.
 */
export interface MemoryCommitRecordV1 {
  readonly schemaId: typeof CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryCommit;
  readonly schemaVersion: 1;
  readonly plane: "runtime";
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly commitRecordId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly responseHash: string;
  readonly scope: string;
  readonly scopeKey: string;
  readonly basisRevision: number;
  readonly artifactId: string;
  readonly artifactVersion: number;
  /** Null unless the artifact, receipt and manifest were all verified. */
  readonly artifactRef: string | null;
  readonly contentHash: string | null;
  readonly memoryReceiptId: string | null;
  readonly memoryReceiptHash: string | null;
  readonly manifestId: string | null;
  readonly manifestRevision: number | null;
  readonly manifestHash: string | null;
  readonly status: "ok" | "missing" | "permission_denied" | "stale" | "revision_mismatch" | "epoch_mismatch" | "manifest_conflict";
  readonly progress: {
    readonly artifact: boolean;
    readonly receipt: boolean;
    readonly manifest: boolean;
  };
  readonly checks: readonly RuntimeStoreJsonObject[];
  readonly bodyHash: string;
  readonly receiptHash: string;
  readonly createdAt: string;
  readonly provenance: RuntimeStoreJsonObject;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CDR_VERDICTS = new Set([
  "admitted",
  "overridden",
  "blocked",
  "review_required",
  "unknown",
]);
const CAR_VERDICTS = new Set([
  "accepted",
  "restored",
  "expanded",
  "blocked",
  "waiting",
  "assurance_unknown",
  "review_required",
]);
export const CAR_CHECK_IDS_V1 = [
  "source_cursor",
  "exact_anchor",
  "protected_content",
  "tool_call_pairing",
  "permission",
  "source_hash",
  "source_revision",
  "generation",
  "worktree_fence",
  "semantic_drift",
  "jev_preservation",
  "pointer_reachability",
  "manifest_current_pointer",
  "memory_read_probe",
  "epoch_fence",
  "supersedes_relation",
  "rollback_reference",
] as const;
const CAR_CHECK_IDS: ReadonlySet<string> = new Set(CAR_CHECK_IDS_V1);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!HASH_PATTERN.test(result))
    throw new TypeError(`${label} must be sha256:<64hex>`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function assertRuntimeEnvelope(
  receipt: Record<string, unknown>,
  kind: ContextGovernanceReceiptKindV1,
): void {
  const expectedSchemaId = CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1[kind];
  if (receipt.schemaId !== expectedSchemaId) {
    throw new TypeError(`${kind} schemaId is invalid`);
  }
  if (receipt.schemaVersion !== 1)
    throw new TypeError(`${kind} schemaVersion is invalid`);
  if (receipt.plane !== "runtime")
    throw new TypeError(`${kind} must be a runtime receipt`);
  text(receipt.workspaceId, `${kind}.workspaceId`);
  text(receipt.runId, `${kind}.runId`);
  text(receipt.attemptId, `${kind}.attemptId`);
  text(receipt.turnId, `${kind}.turnId`);
  positiveInteger(receipt.operationEpoch, `${kind}.operationEpoch`);
  text(receipt.contextOperationId, `${kind}.contextOperationId`);
  hash(receipt.bodyHash, `${kind}.bodyHash`);
  hash(receipt.receiptHash, `${kind}.receiptHash`);
  text(receipt.createdAt, `${kind}.createdAt`);
  record(receipt.provenance, `${kind}.provenance`);
  for (const forbidden of [
    "evaluationRunId",
    "candidateSha",
    "seed",
    "caseSetHash",
    "fixtureHash",
    "dirtyWriteSet",
  ]) {
    if (forbidden in receipt)
      throw new TypeError(`${kind} runtime receipt cannot carry ${forbidden}`);
  }
}

function assertCdr(receipt: Record<string, unknown>): string {
  const receiptId = text(receipt.receiptId, "cdr.receiptId");
  if (!CDR_VERDICTS.has(text(receipt.verdict, "cdr.verdict"))) {
    throw new TypeError("cdr.verdict is invalid");
  }
  const effect = record(receipt.effect, "cdr.effect");
  text(effect.operationId, "cdr.effect.operationId");
  if (effect.ledgerReceiptId !== null && effect.ledgerReceiptId !== undefined) {
    text(effect.ledgerReceiptId, "cdr.effect.ledgerReceiptId");
  }
  if ("lease" in receipt) {
    throw new TypeError("runtime cdr cannot carry lease");
  }
  // `authorization.grantRef` is an artifact reference (contract 01 4.9) and
  // only an admission rests on a grant.
  if (receipt.authorization !== undefined) {
    const authorization = record(receipt.authorization, "cdr.authorization");
    const grantRef = authorization.grantRef;
    if (grantRef !== null && grantRef !== undefined) {
      const ref = record(grantRef, "cdr.authorization.grantRef");
      text(ref.artifactId, "cdr.authorization.grantRef.artifactId");
      positiveInteger(ref.version, "cdr.authorization.grantRef.version");
      hash(ref.contentHash, "cdr.authorization.grantRef.contentHash");
      text(ref.storageRef, "cdr.authorization.grantRef.storageRef");
      if (receipt.verdict !== "admitted" && receipt.verdict !== "overridden") {
        throw new TypeError("only an admitted or overridden decision can carry a grantRef");
      }
    }
  }
  return receiptId;
}

function assertCar(receipt: Record<string, unknown>): string {
  const auditId = text(receipt.auditId, "car.auditId");
  if (!CAR_VERDICTS.has(text(receipt.verdict, "car.verdict"))) {
    throw new TypeError("car.verdict is invalid");
  }
  record(receipt.decisionRef, "car.decisionRef");
  const compaction = record(receipt.compaction, "car.compaction");
  text(compaction.piCompactionId, "car.compaction.piCompactionId");
  const snapshots = record(receipt.snapshots, "car.snapshots");
  hash(snapshots.beforeHash, "car.snapshots.beforeHash");
  hash(snapshots.afterHash, "car.snapshots.afterHash");
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== 17) {
    throw new TypeError("car.checks must contain exactly 17 checks");
  }
  const seenCheckIds = new Set<string>();
  for (const [index, check] of receipt.checks.entries()) {
    const item = record(check, `car.checks[${index}]`);
    const checkId = text(item.id, `car.checks[${index}].id`);
    if (!CAR_CHECK_IDS.has(checkId)) {
      throw new TypeError(
        `car.checks[${index}].id is not an approved check id`,
      );
    }
    if (seenCheckIds.has(checkId)) {
      throw new TypeError(`car.checks[${index}].id is duplicated`);
    }
    seenCheckIds.add(checkId);
    const result = record(item.result, `car.checks[${index}].result`);
    const status = text(result.status, `car.checks[${index}].result.status`);
    if (status !== "ok" && status !== "unknown") {
      throw new TypeError(`car.checks[${index}].result.status is invalid`);
    }
    if (result.value !== "pass" && result.value !== "fail") {
      throw new TypeError(`car.checks[${index}].result.value is invalid`);
    }
    if (
      !("detailHash" in item) ||
      (item.detailHash !== null && typeof item.detailHash !== "string")
    ) {
      throw new TypeError(`car.checks[${index}].detailHash is invalid`);
    }
  }
  return auditId;
}

function assertDisclosure(receipt: Record<string, unknown>): string {
  const disclosureId = text(
    receipt.disclosureId,
    "disclosure.disclosureId",
  );
  text(receipt.manifestRef, "disclosure.manifestRef");
  text(receipt.pointer, "disclosure.pointer");
  text(receipt.restoreTokenRef, "disclosure.restoreTokenRef");
  hash(receipt.fingerprint, "disclosure.fingerprint");
  text(receipt.whenToRead, "disclosure.whenToRead");
  text(receipt.scope, "disclosure.scope");
  text(receipt.scopeKey, "disclosure.scopeKey");
  if (
    !Number.isSafeInteger(receipt.basisRevision) ||
    (receipt.basisRevision as number) < 0
  )
    throw new TypeError("disclosure.basisRevision must be non-negative");
  return disclosureId;
}

const MEMORY_RECORD_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "missing",
  "permission_denied",
  "stale",
  "revision_mismatch",
  "epoch_mismatch",
  "manifest_conflict",
]);

function assertMemoryRead(receipt: Record<string, unknown>): string {
  const readRecordId = text(receipt.readRecordId, "memoryRead.readRecordId");
  hash(receipt.requestHash, "memoryRead.requestHash");
  hash(receipt.responseHash, "memoryRead.responseHash");
  text(receipt.scope, "memoryRead.scope");
  text(receipt.scopeKey, "memoryRead.scopeKey");
  if (
    !Number.isSafeInteger(receipt.basisRevision) ||
    (receipt.basisRevision as number) < 0
  )
    throw new TypeError("memoryRead.basisRevision must be non-negative");
  const statuses = new Set([
    "ok",
    "missing",
    "permission_denied",
    "stale",
    "revision_mismatch",
    "epoch_mismatch",
    "manifest_conflict",
  ]);
  const status = text(receipt.status, "memoryRead.status");
  if (!statuses.has(status)) {
    throw new TypeError("memoryRead.status is invalid");
  }
  if (status === "ok") {
    text(receipt.manifestRef, "memoryRead.manifestRef");
    positiveInteger(receipt.manifestRevision, "memoryRead.manifestRevision");
    hash(receipt.contentHash, "memoryRead.contentHash");
    text(receipt.disclosureRecordId, "memoryRead.disclosureRecordId");
  } else {
    if (
      receipt.manifestRef !== null ||
      receipt.manifestRevision !== null ||
      receipt.contentHash !== null ||
      receipt.disclosureRecordId !== null
    ) {
      throw new TypeError(
        "failed memoryRead records must not claim a verified manifest, content, or disclosure",
      );
    }
  }
  if (!Array.isArray(receipt.factIds))
    throw new TypeError("memoryRead.factIds must be an array");
  for (const [index, factId] of receipt.factIds.entries())
    text(factId, `memoryRead.factIds[${index}]`);
  if (
    !Number.isSafeInteger(receipt.exactFactCount) ||
    (receipt.exactFactCount as number) < 0
  )
    throw new TypeError("memoryRead.exactFactCount must be a non-negative integer");
  if (
    !Number.isSafeInteger(receipt.summaryCount) ||
    (receipt.summaryCount as number) < 0
  )
    throw new TypeError("memoryRead.summaryCount must be a non-negative integer");
  if (!Array.isArray(receipt.checks) || receipt.checks.length === 0)
    throw new TypeError("memoryRead.checks must be a non-empty array");
  for (const [index, check] of receipt.checks.entries()) {
    const item = record(check, `memoryRead.checks[${index}]`);
    text(item.id, `memoryRead.checks[${index}].id`);
    if (item.result !== "ok" && item.result !== "fail")
      throw new TypeError(`memoryRead.checks[${index}].result is invalid`);
  }
  return readRecordId;
}

function assertMemoryCommit(receipt: Record<string, unknown>): string {
  const commitRecordId = text(receipt.commitRecordId, "memoryCommit.commitRecordId");
  text(receipt.requestId, "memoryCommit.requestId");
  hash(receipt.requestHash, "memoryCommit.requestHash");
  hash(receipt.responseHash, "memoryCommit.responseHash");
  text(receipt.scope, "memoryCommit.scope");
  text(receipt.scopeKey, "memoryCommit.scopeKey");
  text(receipt.artifactId, "memoryCommit.artifactId");
  positiveInteger(receipt.artifactVersion, "memoryCommit.artifactVersion");
  if (
    !Number.isSafeInteger(receipt.basisRevision) ||
    (receipt.basisRevision as number) < 0
  )
    throw new TypeError("memoryCommit.basisRevision must be non-negative");
  const status = text(receipt.status, "memoryCommit.status");
  if (!MEMORY_RECORD_STATUSES.has(status)) {
    throw new TypeError("memoryCommit.status is invalid");
  }
  const progress = record(receipt.progress, "memoryCommit.progress");
  for (const stage of ["artifact", "receipt", "manifest"]) {
    if (typeof progress[stage] !== "boolean")
      throw new TypeError(`memoryCommit.progress.${stage} must be boolean`);
  }
  if (status === "ok") {
    text(receipt.artifactRef, "memoryCommit.artifactRef");
    hash(receipt.contentHash, "memoryCommit.contentHash");
    text(receipt.memoryReceiptId, "memoryCommit.memoryReceiptId");
    hash(receipt.memoryReceiptHash, "memoryCommit.memoryReceiptHash");
    text(receipt.manifestId, "memoryCommit.manifestId");
    positiveInteger(receipt.manifestRevision, "memoryCommit.manifestRevision");
    hash(receipt.manifestHash, "memoryCommit.manifestHash");
    if (
      progress.artifact !== true ||
      progress.receipt !== true ||
      progress.manifest !== true
    ) {
      throw new TypeError(
        "an ok memoryCommit record needs artifact, receipt and manifest all durable",
      );
    }
  } else if (
    receipt.artifactRef !== null ||
    receipt.contentHash !== null ||
    receipt.memoryReceiptId !== null ||
    receipt.memoryReceiptHash !== null ||
    receipt.manifestId !== null ||
    receipt.manifestRevision !== null ||
    receipt.manifestHash !== null
  ) {
    throw new TypeError(
      "failed memoryCommit records must not claim a verified artifact, receipt, or manifest",
    );
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length === 0)
    throw new TypeError("memoryCommit.checks must be a non-empty array");
  for (const [index, check] of receipt.checks.entries()) {
    const item = record(check, `memoryCommit.checks[${index}]`);
    text(item.id, `memoryCommit.checks[${index}].id`);
    if (item.result !== "ok" && item.result !== "fail")
      throw new TypeError(`memoryCommit.checks[${index}].result is invalid`);
  }
  return commitRecordId;
}

/**
 * Validate the shared runtime CDR/CAR envelope and bind it to one ledger
 * operation. This is a pure validator; it does not persist the payload.
 */
export function bindContextGovernanceReceiptV1(input: {
  readonly receipt: RuntimeStoreJsonObject;
  readonly effect?: EffectLedgerEntryV1;
}): ContextGovernanceReceiptBindingV1 {
  const receipt = record(input.receipt, "context receipt");
  const kind =
    receipt.schemaId === CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.cdr
      ? "cdr"
      : receipt.schemaId === CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.car
        ? "car"
        : receipt.schemaId === CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.disclosure
          ? "disclosure"
          : receipt.schemaId === CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryRead
            ? "memoryRead"
            : receipt.schemaId === CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryCommit
              ? "memoryCommit"
        : null;
  if (kind === null)
    throw new TypeError("context receipt schemaId is not CDR or CAR");
  assertRuntimeEnvelope(receipt, kind);
  const operationId =
    input.effect === undefined
      ? text(receipt.contextOperationId, "contextOperationId")
      : text(input.effect.operationId, "effect.operationId");
  if (kind === "cdr") {
    if (input.effect === undefined) {
      throw new TypeError("CDR binding requires a RunLedger effect");
    }
    const receiptOperationId = text(
      record(receipt.effect, "cdr.effect").operationId,
      "cdr.effect.operationId",
    );
    if (receiptOperationId !== operationId) {
      throw new TypeError(
        "context receipt operationId does not match RunLedger effect",
      );
    }
  }
  const receiptId =
    kind === "cdr"
      ? assertCdr(receipt)
      : kind === "car"
        ? assertCar(receipt)
        : kind === "disclosure"
          ? assertDisclosure(receipt)
          : kind === "memoryRead"
            ? assertMemoryRead(receipt)
            : assertMemoryCommit(receipt);
  return Object.freeze({
    kind,
    schemaId: receipt.schemaId as string,
    receiptId,
    contextOperationId: receipt.contextOperationId as string,
    operationId,
    receiptHash: receipt.receiptHash as string,
    bodyHash: receipt.bodyHash as string,
    receipt: input.receipt,
  });
}
