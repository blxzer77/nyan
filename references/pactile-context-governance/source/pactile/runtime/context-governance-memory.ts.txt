import type {
  MemoryDurabilityFailureCodeV1,
  MemoryDurabilityFailureV1,
  MemoryReadRequestV1,
  MemoryReadSuccessV1,
} from "../agent/memory/durability/index.js";
import type {
  ArtifactStoreBindingV1,
  ArtifactStorePort,
} from "../agent/memory/artifact-store.js";
import { fingerprintPactileContractV1 } from "../shared/validation.js";
import {
  CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1,
  bindContextGovernanceReceiptV1,
  type DisclosureRecordV1,
  type MemoryReadRecordV1,
} from "./context-governance-receipts.js";
import {
  type RunLedgerContextOperationV1,
  type RunLedgerPort,
  type RunLedgerV1,
} from "./run-ledger.js";
import type {
  RuntimeStoreJsonObject,
  RuntimeStoreLeaseProof,
} from "./store-port.js";
import {
  envelope,
  positiveInteger,
  recordFailure as failure,
  text,
  type MemoryRecordPersistFailureV1,
} from "./context-governance-record-support.js";
import {
  artifactIntentIdV1,
  persistContextGovernanceArtifactIntentV1,
  priorArtifactIntentCreatedAtV1,
  plannedArtifactBindingV1,
  type ArtifactIntentFailureV1,
} from "./context-governance-artifact-intents.js";

export type { MemoryRecordPersistFailureV1 };

function memoryFailureFromArtifactIntent(
  result: ArtifactIntentFailureV1,
): MemoryRecordPersistFailureV1 {
  const code =
    result.code === "intent_invalid"
      ? "input_invalid"
      : result.code === "ledger_missing"
        ? "ledger_missing"
        : result.code === "ledger_conflict" || result.code === "intent_abandoned"
          ? "ledger_conflict"
          : result.code;
  return failure(code, result.message, result.committedArtifacts ?? []);
}

function intentDeadline(now: string): string {
  return new Date(Date.parse(now) + 5 * 60_000).toISOString();
}

export interface PersistContextGovernanceMemoryInputV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly read: MemoryReadSuccessV1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly restoreTokenRef: string;
  readonly disclosureArtifactId: string;
  readonly memoryReadArtifactId: string;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly now?: () => Date;
  readonly lease?: RuntimeStoreLeaseProof;
}

export type PersistContextGovernanceMemoryResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly disclosure: DisclosureRecordV1;
      readonly memoryRead: MemoryReadRecordV1;
      readonly disclosureArtifact: ArtifactStoreBindingV1;
      readonly memoryReadArtifact: ArtifactStoreBindingV1;
      readonly ledger: RunLedgerV1;
    }
  | MemoryRecordPersistFailureV1;

export type MemoryReadFailureStatusV1 = Exclude<
  MemoryReadRecordV1["status"],
  "ok"
>;

/**
 * Memory durability failure code -> MemoryReadRecordV1 status, following the
 * failure-code mapping table in 01-contract-draft (still marked draft there).
 * The table is exhaustive over the failure code union, so adding a failure code
 * without deciding its status is a compile error.
 *
 * `null` means the code maps to provider_unavailable, invalid_response or
 * unknown. MemoryReadRecordV1 cannot express those, so such a failure is not
 * recorded as a memory.read: guessing a nearby status (for example calling a
 * corrupt artifact `missing`) is a forbidden fold.
 */
const MEMORY_READ_FAILURE_STATUS_V1: Readonly<
  Record<MemoryDurabilityFailureCodeV1, MemoryReadFailureStatusV1 | null>
> = Object.freeze({
  memory_artifact_missing: "missing",
  memory_manifest_absent: "missing",
  memory_receipt_absent: "missing",
  memory_disclosure_missing: "missing",
  memory_artifact_stale: "stale",
  memory_manifest_stale: "stale",
  memory_cas_conflict: "manifest_conflict",
  memory_artifact_conflict: "manifest_conflict",
  memory_receipt_conflict: "manifest_conflict",
  memory_request_conflict: "manifest_conflict",
  memory_lease_missing: "epoch_mismatch",
  memory_lease_fenced: "epoch_mismatch",
  memory_lease_expired: "epoch_mismatch",
  memory_store_denied: "permission_denied",
  memory_basis_conflict: "revision_mismatch",
  memory_store_unavailable: null,
  memory_invalid_input: null,
  memory_content_rejected: null,
  memory_scope_mismatch: null,
  memory_receipt_corrupt: null,
  memory_receipt_hash_mismatch: null,
  memory_manifest_corrupt: null,
  memory_artifact_corrupt: null,
  memory_artifact_hash_mismatch: null,
  memory_artifact_scope_mismatch: null,
  memory_not_durable: null,
  memory_receipt_pending: null,
  memory_audit_write_failed: null,
});

/** Status a failed memory.read is recorded with, or null when none applies. */
export function memoryReadFailureStatusV1(
  code: MemoryDurabilityFailureCodeV1,
): MemoryReadFailureStatusV1 | null {
  return MEMORY_READ_FAILURE_STATUS_V1[code] ?? null;
}

export interface PersistContextGovernanceMemoryFailureInputV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly request: MemoryReadRequestV1;
  readonly failure: MemoryDurabilityFailureV1;
  /**
   * Derived from `failure.code` when omitted. When supplied it must equal the
   * derived status; a caller cannot relabel a failure (for example record
   * permission_denied as missing).
   */
  readonly status?: MemoryReadFailureStatusV1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly memoryReadArtifactId: string;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly now?: () => Date;
  readonly lease?: RuntimeStoreLeaseProof;
}

export type PersistContextGovernanceMemoryFailureResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly memoryRead: MemoryReadRecordV1;
      readonly memoryReadArtifact: ArtifactStoreBindingV1;
      readonly ledger: RunLedgerV1;
    }
  | MemoryRecordPersistFailureV1;

/**
 * Persist the structured disclosure and memory.read records produced by the
 * existing Memory Port, then append two read-only Context Operations to the
 * same RunLedger snapshot. They intentionally do not enter EffectLedger.
 */
export async function persistContextGovernanceMemoryV1(
  input: PersistContextGovernanceMemoryInputV1,
): Promise<PersistContextGovernanceMemoryResultV1> {
  try {
    text(input.workspaceId, "workspaceId");
    text(input.runId, "runId");
    text(input.attemptId, "attemptId");
    text(input.turnId, "turnId");
    positiveInteger(input.operationEpoch, "operationEpoch");
    text(input.contextOperationId, "contextOperationId");
    text(input.restoreTokenRef, "restoreTokenRef");
    positiveInteger(input.version, "version");
    if (!Number.isSafeInteger(input.basisRevision) || input.basisRevision < 0)
      throw new TypeError("basisRevision must be a non-negative safe integer");
    if (
      input.read.scopeKey !== input.scopeKey ||
      input.read.basisRevision !== input.basisRevision
    ) {
      throw new TypeError("memory read identity does not match persistence scope");
    }
  } catch (error) {
    return failure(
      "input_invalid",
      error instanceof Error ? error.message : "memory record input is invalid",
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const disclosureOperationId = `${input.contextOperationId}:disclosure`;
  const memoryReadOperationId = `${input.contextOperationId}:memory-read`;
  const identity = {
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
  };
  const buildDisclosure = (createdAt: string): DisclosureRecordV1 =>
    envelope(
      CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.disclosure,
      { ...identity, contextOperationId: disclosureOperationId, createdAt },
      {
        disclosureId: disclosureOperationId,
        manifestRef: input.read.readReceipt.storageRef,
        pointer: input.read.disclosure.path,
        restoreTokenRef: input.restoreTokenRef,
        fingerprint: input.read.disclosure.fingerprint,
        whenToRead: input.read.disclosure.whenToRead,
        scope: input.read.scope,
        scopeKey: input.read.scopeKey,
        basisRevision: input.read.basisRevision,
      },
    ) as unknown as DisclosureRecordV1;
  const buildMemoryRead = (createdAt: string): MemoryReadRecordV1 =>
    envelope(
      CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryRead,
      { ...identity, contextOperationId: memoryReadOperationId, createdAt },
      {
        readRecordId: input.read.readReceipt.readReceiptId,
        requestHash: input.read.readReceipt.requestHash,
        responseHash: input.read.readReceipt.receiptHash,
        manifestRef: input.read.readReceipt.storageRef,
        manifestRevision: input.read.manifestRevision,
        contentHash: input.read.contentHash,
        scope: input.read.scope,
        scopeKey: input.read.scopeKey,
        basisRevision: input.read.basisRevision,
        disclosureRecordId: disclosureOperationId,
        status: "ok",
        factIds: input.read.readReceipt.factIds,
        exactFactCount: input.read.exactFactCount,
        summaryCount: input.read.summaryCount,
        checks: [
          { id: "scope", result: "ok" },
          { id: "disclosure", result: "ok" },
          { id: "pointer", result: "ok" },
          { id: "manifest", result: "ok" },
          { id: "content", result: "ok" },
          { id: "epoch", result: "ok" },
        ],
      },
    ) as unknown as MemoryReadRecordV1;

  try {
    bindContextGovernanceReceiptV1({
      receipt: buildDisclosure(now) as unknown as RuntimeStoreJsonObject,
    });
    bindContextGovernanceReceiptV1({
      receipt: buildMemoryRead(now) as unknown as RuntimeStoreJsonObject,
    });
  } catch (error) {
    return failure(
      "input_invalid",
      error instanceof Error ? error.message : "memory governance record is invalid",
    );
  }

  const intentId = artifactIntentIdV1(input.runId, input.contextOperationId);
  const createdAt =
    (await priorArtifactIntentCreatedAtV1(input.ledger, input.runId, intentId)) ?? now;
  const disclosure = buildDisclosure(createdAt);
  const memoryRead = buildMemoryRead(createdAt);
  const disclosureBinding = plannedArtifactBindingV1({
    artifactId: input.disclosureArtifactId,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    record: disclosure as unknown as RuntimeStoreJsonObject,
  });
  const memoryReadBinding = plannedArtifactBindingV1({
    artifactId: input.memoryReadArtifactId,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    record: memoryRead as unknown as RuntimeStoreJsonObject,
  });
  const disclosureOperation: RunLedgerContextOperationV1 = {
    schemaVersion: 1,
    contextOperationId: disclosure.contextOperationId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    kind: "disclosure",
    status: "succeeded",
    requestHash: fingerprintPactileContractV1({
      domain: "context-disclosure-request-v1",
      value: { pointer: disclosure.pointer, scopeKey: input.scopeKey },
    }),
    responseHash: disclosure.receiptHash,
    payloadType: disclosure.schemaId,
    payloadHash: disclosure.receiptHash,
    payloadArtifactRef: disclosureBinding.storageRef,
    createdAt: disclosure.createdAt,
    completedAt: disclosure.createdAt,
  };
  const memoryReadOperation: RunLedgerContextOperationV1 = {
    schemaVersion: 1,
    contextOperationId: memoryRead.contextOperationId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    kind: "memory_read",
    status: "succeeded",
    requestHash: memoryRead.requestHash,
    responseHash: memoryRead.responseHash,
    payloadType: memoryRead.schemaId,
    payloadHash: memoryRead.receiptHash,
    payloadArtifactRef: memoryReadBinding.storageRef,
    createdAt: memoryRead.createdAt,
    completedAt: memoryRead.createdAt,
  };
  const intent = await persistContextGovernanceArtifactIntentV1({
    ledger: input.ledger,
    artifacts: input.artifacts,
    intentId,
    runId: input.runId,
    records: [
      {
        artifactId: input.disclosureArtifactId,
        scopeKey: input.scopeKey,
        version: input.version,
        basisRevision: input.basisRevision,
        record: disclosure as unknown as RuntimeStoreJsonObject,
      },
      {
        artifactId: input.memoryReadArtifactId,
        scopeKey: input.scopeKey,
        version: input.version,
        basisRevision: input.basisRevision,
        record: memoryRead as unknown as RuntimeStoreJsonObject,
      },
    ],
    contextOperations: [disclosureOperation, memoryReadOperation],
    effectBindings: [],
    now: createdAt,
    abandonAfter: intentDeadline(createdAt),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
  if (!intent.ok) return memoryFailureFromArtifactIntent(intent);
  const records = intent.intent.artifacts.map((artifact) => artifact.record);
  return {
    ok: true,
    applied: intent.applied,
    disclosure: records[0] as unknown as DisclosureRecordV1,
    memoryRead: records[1] as unknown as MemoryReadRecordV1,
    disclosureArtifact: intent.artifacts[0] ?? disclosureBinding,
    memoryReadArtifact: intent.artifacts[1] ?? memoryReadBinding,
    ledger: intent.ledger,
  };
}
const failureRecordFailure = failure;

/**
 * Persist a failed memory.read without claiming a manifest, content, or
 * disclosure that was never verified. The caller supplies the S10 status
 * because a storage failure code can be observed at different boundaries.
 */
export async function persistContextGovernanceMemoryFailureV1(
  input: PersistContextGovernanceMemoryFailureInputV1,
): Promise<PersistContextGovernanceMemoryFailureResultV1> {
  let status: MemoryReadFailureStatusV1;
  try {
    text(input.workspaceId, "workspaceId");
    text(input.runId, "runId");
    text(input.attemptId, "attemptId");
    text(input.turnId, "turnId");
    positiveInteger(input.operationEpoch, "operationEpoch");
    text(input.contextOperationId, "contextOperationId");
    text(input.memoryReadArtifactId, "memoryReadArtifactId");
    text(input.scopeKey, "scopeKey");
    positiveInteger(input.version, "version");
    if (!Number.isSafeInteger(input.basisRevision) || input.basisRevision < 0)
      throw new TypeError("basisRevision must be a non-negative safe integer");
    if (
      input.request.scopeKey !== input.scopeKey ||
      input.request.basisRevision !== input.basisRevision
    ) {
      throw new TypeError("memory read request does not match persistence scope");
    }
    if (input.failure.domain !== "memory")
      throw new TypeError("memory read failure must belong to the memory domain");
    if (
      input.failure.scopeKey !== null &&
      input.failure.scopeKey !== input.scopeKey
    ) {
      throw new TypeError("memory read failure scopeKey does not match persistence scope");
    }
    if (input.failure.reexecute || input.failure.replayPolicy !== "no_automatic_replay")
      throw new TypeError("memory read failures must remain non-replayable");
    if (input.failure.stage !== null)
      throw new TypeError(
        "a commit-stage memory failure is not a memory.read failure and is not recorded as one",
      );
    const derived = MEMORY_READ_FAILURE_STATUS_V1[input.failure.code];
    if (derived === undefined)
      throw new TypeError(
        "memory read failure code is not part of the status mapping",
      );
    if (derived === null)
      throw new TypeError(
        `memory failure ${input.failure.code} has no MemoryReadRecordV1 status and is not recorded as a memory.read`,
      );
    if (input.status !== undefined && input.status !== derived)
      throw new TypeError(
        `memory read status ${input.status} contradicts failure ${input.failure.code} (expected ${derived})`,
      );
    status = derived;
  } catch (error) {
    return failureRecordFailure(
      "input_invalid",
      error instanceof Error ? error.message : "memory read failure is invalid",
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const requestHash = fingerprintPactileContractV1({
    domain: "memory-read-request-v1",
    scope: input.request.scope,
    scopeKey: input.request.scopeKey,
    basisRevision: input.request.basisRevision,
    acknowledgeDisclosure: input.request.acknowledgeDisclosure,
  });
  const responseHash = fingerprintPactileContractV1({
    domain: "memory-read-failure-response-v1",
    status,
    code: input.failure.code,
    details: input.failure.details,
  });
  const buildMemoryRead = (createdAt: string): MemoryReadRecordV1 =>
    envelope(
      CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryRead,
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        attemptId: input.attemptId,
        turnId: input.turnId,
        operationEpoch: input.operationEpoch,
        contextOperationId: `${input.contextOperationId}:memory-read`,
        createdAt,
      },
      {
        readRecordId: `${input.contextOperationId}:memory-read`,
        requestHash,
        responseHash,
        manifestRef: null,
        manifestRevision: null,
        contentHash: null,
        scope: input.request.scope,
        scopeKey: input.request.scopeKey,
        basisRevision: input.request.basisRevision,
        disclosureRecordId: null,
        status,
        factIds: [],
        exactFactCount: 0,
        summaryCount: 0,
        checks: [
          { id: "request", result: "ok" },
          { id: "memory_read", result: "fail", code: input.failure.code },
        ],
      },
    ) as unknown as MemoryReadRecordV1;

  try {
    bindContextGovernanceReceiptV1({
      receipt: buildMemoryRead(now) as unknown as RuntimeStoreJsonObject,
    });
  } catch (error) {
    return failureRecordFailure(
      "input_invalid",
      error instanceof Error
        ? error.message
        : "memory read failure record is invalid",
    );
  }

  const intentId = artifactIntentIdV1(input.runId, input.contextOperationId);
  const createdAt =
    (await priorArtifactIntentCreatedAtV1(input.ledger, input.runId, intentId)) ?? now;
  const memoryRead = buildMemoryRead(createdAt);
  const memoryReadBinding = plannedArtifactBindingV1({
    artifactId: input.memoryReadArtifactId,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    record: memoryRead as unknown as RuntimeStoreJsonObject,
  });
  const operation: RunLedgerContextOperationV1 = {
    schemaVersion: 1,
    contextOperationId: memoryRead.contextOperationId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    kind: "memory_read",
    status: "failed",
    requestHash,
    responseHash,
    payloadType: memoryRead.schemaId,
    payloadHash: memoryRead.receiptHash,
    payloadArtifactRef: memoryReadBinding.storageRef,
    createdAt: memoryRead.createdAt,
    completedAt: memoryRead.createdAt,
  };
  const intent = await persistContextGovernanceArtifactIntentV1({
    ledger: input.ledger,
    artifacts: input.artifacts,
    intentId,
    runId: input.runId,
    records: [
      {
        artifactId: input.memoryReadArtifactId,
        scopeKey: input.scopeKey,
        version: input.version,
        basisRevision: input.basisRevision,
        record: memoryRead as unknown as RuntimeStoreJsonObject,
      },
    ],
    contextOperations: [operation],
    effectBindings: [],
    now: createdAt,
    abandonAfter: intentDeadline(createdAt),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
  if (!intent.ok) return memoryFailureFromArtifactIntent(intent);
  return {
    ok: true,
    applied: intent.applied,
    memoryRead: intent.intent.artifacts[0]?.record as unknown as MemoryReadRecordV1,
    memoryReadArtifact: intent.artifacts[0] as ArtifactStoreBindingV1,
    ledger: intent.ledger,
  };
}