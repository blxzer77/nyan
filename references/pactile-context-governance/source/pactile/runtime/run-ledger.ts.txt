import type {
  RuntimeStoreEffectReceipt,
  RuntimeStoreJsonObject,
  RuntimeStoreLeaseProof,
  RuntimeStoreRun,
  RuntimeStoreRunStatus,
} from "./store-port.js";

export const RUN_LEDGER_SCHEMA_VERSION = 1 as const;
export const RUN_LEDGER_METADATA_KEY = "__pactileRunLedgerV1" as const;
export const RUN_LEDGER_EFFECT_KEY = "ledgerEntry" as const;

export type RunLedgerStatus = RuntimeStoreRunStatus | "settled";

export interface RunLedgerLeaseV1 {
  readonly leaseId: string;
  readonly epoch: number;
  readonly owner: string;
}

export interface RunLedgerCursorV1 {
  readonly partition: string;
  readonly sequence: number;
}

export type RunLedgerContextOperationKindV1 =
  | "disclosure"
  | "memory_read"
  | "memory_commit"
  | "approval_grant";
export type RunLedgerContextOperationStatusV1 =
  | "succeeded"
  | "failed"
  | "blocked"
  | "waiting";

/**
 * Host-owned context-operation metadata. These records are deliberately
 * separate from EffectLedgerEntryV1: disclosure and memory.read are read-only
 * governance operations, not tool effects.
 */
export interface RunLedgerContextOperationV1 {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly contextOperationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly kind: RunLedgerContextOperationKindV1;
  readonly status: RunLedgerContextOperationStatusV1;
  readonly requestHash: string;
  readonly responseHash: string | null;
  readonly payloadType: string;
  readonly payloadHash: string;
  readonly payloadArtifactRef: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

import {
  decodeArtifactStoreBindingV1,
  type ArtifactStoreBindingV1,
} from "../agent/memory/artifact-store.js";

export type RunLedgerApprovalStateV1 =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export type RunLedgerReviewFollowUpV1 =
  | "new_admission"
  | "restore"
  | "expand"
  | "block";

/**
 * A human / Kernel review held on one Context Operation (contract 01 4.14).
 * While `pending` the operation is waiting and nothing reversible, lossy or
 * new may run. The entry only ever moves pending -> approved | rejected |
 * expired and is immutable afterwards, except that an approved
 * `new_admission` is consumed exactly once.
 */
export interface RunLedgerReviewProposalV1 {
  readonly prefixMessageCount: number;
  /** Fingerprint of the exact prefix, never its content. */
  readonly prefixHash: string;
  readonly basisRevision: number;
}

/**
 * Contract 01 `ArtifactRefV1`: the content-addressed reference a CDR carries as
 * `authorization.grantRef`.
 */
export interface RunLedgerGrantRefV1 {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly storageRef: string;
}

export interface RunLedgerApprovalRequestV1 {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly approvalRequestId: string;
  readonly kind: "context_operation_review";
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  /** The held operation. A new admission must use a different id. */
  readonly contextOperationId: string;
  readonly subject: {
    /** CDQ gate verdict `review`, CDR or CAR `review_required`. */
    readonly source: "cdq" | "cdr" | "car";
    readonly receiptId: string;
    readonly payloadHash: string | null;
    readonly manifestRef: string | null;
    /**
     * The exact range the review is about. An approval authorizes this range
     * and nothing else; a later, larger compaction needs its own review.
     */
    readonly proposal?: RunLedgerReviewProposalV1;
  };
  readonly state: RunLedgerApprovalStateV1;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly resolution: {
    /** Resolves to a durable Kernel command receipt. */
    readonly approvalRef: string;
    readonly authority: "user" | "kernel";
    readonly decidedAt: string;
    readonly evidenceRef: string | null;
    readonly followUp: RunLedgerReviewFollowUpV1;
    /** The new contextOperationId an approved new_admission was spent on. */
    readonly consumedBy: string | null;
    /**
     * An immutable snapshot of this decision, written as an artifact. The ledger
     * stays the authority; the snapshot is what a CDR can point to. Decisions
     * recorded before snapshots existed have none.
     */
    readonly grant?: RunLedgerGrantRefV1;
  } | null;
}

export type RunLedgerArtifactIntentStateV1 =
  | "pending"
  | "bound"
  | "abandoned";

export interface RunLedgerArtifactIntentArtifactV1 {
  readonly artifactId: string;
  readonly scope: "run";
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly record: RuntimeStoreJsonObject;
  readonly binding: ArtifactStoreBindingV1;
}

export interface RunLedgerArtifactIntentEffectBindingV1 {
  readonly operationId: string;
  readonly payloadType: string;
  readonly payloadHash: string;
  readonly payloadArtifactRef: string;
}

/**
 * Durable plan written before any immutable artifact bytes. A pending intent
 * is the recovery source for a crash between artifact commit and ledger bind;
 * it is never inferred from filesystem residue.
 */
export interface RunLedgerArtifactIntentV1 {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly intentId: string;
  readonly runId: string;
  readonly state: RunLedgerArtifactIntentStateV1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly abandonAfter: string;
  readonly artifacts: readonly RunLedgerArtifactIntentArtifactV1[];
  readonly contextOperations: readonly RunLedgerContextOperationV1[];
  readonly effectBindings: readonly RunLedgerArtifactIntentEffectBindingV1[];
  readonly abandonedAt: string | null;
}

export interface RunLedgerV1 {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly ledgerId: string;
  readonly commitId: string;
  readonly runId: string;
  readonly activeAttemptId: string | null;
  readonly activeTurnId: string | null;
  readonly status: RunLedgerStatus;
  readonly lease: RunLedgerLeaseV1 | null;
  readonly lastCursor: RunLedgerCursorV1 | null;
  readonly effectOperationIds: readonly string[];
  readonly kernelSettlement: {
    readonly status: "open" | "settled";
    readonly receiptId: string | null;
  };
  readonly dispatchOutboxId: string | null;
  /** Optional for backward compatibility with pre-context-operation ledgers. */
  readonly contextOperations?: readonly RunLedgerContextOperationV1[];
  /** Optional for backward compatibility with ledgers that never held a review. */
  readonly approvalRequests?: readonly RunLedgerApprovalRequestV1[];
  /** Artifact-first recovery plans; optional for pre-intent ledgers. */
  readonly artifactIntents?: readonly RunLedgerArtifactIntentV1[];
  readonly revision: number;
  readonly updatedAt: string;
}

export type EffectLedgerStatusV1 = "intent" | "success" | "failure" | "unknown";

export interface EffectLedgerEntryV1 {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly operationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly operationEpoch: number;
  readonly inputHash: string;
  readonly status: EffectLedgerStatusV1;
  readonly receiptId: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** Optional typed receipt payload binding, populated after terminal effect. */
  readonly payloadType?: string | null;
  readonly payloadHash?: string | null;
  readonly payloadArtifactRef?: string | null;
}

export interface RunLedgerCommitInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly ledger: RunLedgerV1;
  readonly effects: readonly EffectLedgerEntryV1[];
  readonly lease?: RuntimeStoreLeaseProof;
}

export interface RunLedgerCommitResult {
  readonly applied: boolean;
  readonly ledger: RunLedgerV1;
  readonly effects: readonly EffectLedgerEntryV1[];
}

export interface RunLedgerSnapshot {
  readonly ledger: RunLedgerV1;
  readonly effects: readonly EffectLedgerEntryV1[];
  readonly missingOperationIds: readonly string[];
  readonly orphanOperationIds: readonly string[];
}

export interface RunLedgerPort {
  commitRunLedger(input: RunLedgerCommitInput): Promise<RunLedgerCommitResult>;
  readRunLedger(runId: string): Promise<RunLedgerSnapshot | null>;
}

/** What a Host learns about one stored RunLedger without reading its effects. */
export interface RunLedgerListEntryV1 {
  readonly runId: string;
  readonly status: RunLedgerStatus;
  readonly revision: number;
  readonly updatedAt: string;
  /** Artifact intents still waiting for their bytes or their binding. */
  readonly pendingArtifactIntentIds: readonly string[];
  /**
   * The latest expiry among the leases the store still holds for this run, or
   * null when it holds none. A released lease is gone; a crashed owner's
   * lease stays until it expires. The caller compares it with its own clock.
   */
  readonly leaseExpiresAt: string | null;
}

export interface RunLedgerListInputV1 {
  /** Return runs whose id sorts after this one. */
  readonly after?: string;
  /** 1..500, default 100. A page may hold fewer entries than the limit. */
  readonly limit?: number;
}

export interface RunLedgerListPageV1 {
  /** Ordered by run id, ascending. */
  readonly entries: readonly RunLedgerListEntryV1[];
  /** Pass as `after` for the next page; null when there is no more. */
  readonly next: string | null;
}

/**
 * Read-only enumeration of the stored RunLedgers. It is a separate port so a
 * store (or a test double) that cannot enumerate still satisfies
 * `RunLedgerPort`; whatever needs a scan asks for both.
 */
export interface RunLedgerEnumerationPort {
  listRunLedgers(input?: RunLedgerListInputV1): Promise<RunLedgerListPageV1>;
}

export function runtimeRunStatusForLedger(
  status: RunLedgerStatus,
): RuntimeStoreRunStatus {
  return status === "settled" ? "completed" : status;
}

export function ledgerRuntimeMetadata(
  ledger: RunLedgerV1,
): RuntimeStoreJsonObject {
  return {
    [RUN_LEDGER_METADATA_KEY]: ledger as unknown as RuntimeStoreJsonObject,
  };
}

export function runtimeRunForLedger(
  ledger: RunLedgerV1,
  existing: RuntimeStoreRun | null,
): RuntimeStoreRun {
  const metadata: RuntimeStoreJsonObject = {
    ...(existing?.metadata ?? {}),
    ...ledgerRuntimeMetadata(ledger),
  };
  return {
    schemaVersion: 1,
    runId: ledger.runId,
    status: runtimeRunStatusForLedger(ledger.status),
    revision: ledger.revision,
    input: existing?.input ?? { runId: ledger.runId },
    output: existing?.output ?? null,
    error: existing?.error ?? null,
    metadata,
    createdAt: existing?.createdAt ?? ledger.updatedAt,
    updatedAt: ledger.updatedAt,
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function requireNullableText(value: unknown, field: string): string | null {
  return value === null ? null : requireText(value, field);
}

function optionalNullableText(
  record: Record<string, unknown>,
  key: string,
  label = key,
): string | null | undefined {
  return key in record ? requireNullableText(record[key], label) : undefined;
}

export function assertRunLedgerContextOperation(
  value: unknown,
  operation = "run-ledger.contextOperation",
): RunLedgerContextOperationV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${operation}: context operation must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new TypeError(`${operation}: unsupported schemaVersion`);
  }
  requireText(record.contextOperationId, `${operation}.contextOperationId`);
  requireText(record.runId, `${operation}.runId`);
  requireText(record.attemptId, `${operation}.attemptId`);
  requireText(record.turnId, `${operation}.turnId`);
  requirePositiveInteger(record.operationEpoch, `${operation}.operationEpoch`);
  if (
    record.kind !== "disclosure" &&
    record.kind !== "memory_read" &&
    record.kind !== "memory_commit" &&
    record.kind !== "approval_grant"
  ) {
    throw new TypeError(`${operation}.kind is invalid`);
  }
  if (
    record.status !== "succeeded" &&
    record.status !== "failed" &&
    record.status !== "blocked" &&
    record.status !== "waiting"
  ) {
    throw new TypeError(`${operation}.status is invalid`);
  }
  requireText(record.requestHash, `${operation}.requestHash`);
  requireNullableText(record.responseHash, `${operation}.responseHash`);
  requireText(record.payloadType, `${operation}.payloadType`);
  requireText(record.payloadHash, `${operation}.payloadHash`);
  requireText(record.payloadArtifactRef, `${operation}.payloadArtifactRef`);
  requireText(record.createdAt, `${operation}.createdAt`);
  return Object.freeze({
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    contextOperationId: record.contextOperationId as string,
    runId: record.runId as string,
    attemptId: record.attemptId as string,
    turnId: record.turnId as string,
    operationEpoch: record.operationEpoch as number,
    kind: record.kind as RunLedgerContextOperationKindV1,
    status: record.status as RunLedgerContextOperationStatusV1,
    requestHash: record.requestHash as string,
    responseHash: requireNullableText(
      record.responseHash,
      `${operation}.responseHash`,
    ),
    payloadType: record.payloadType as string,
    payloadHash: record.payloadHash as string,
    payloadArtifactRef: record.payloadArtifactRef as string,
    createdAt: record.createdAt as string,
    completedAt: requireNullableText(
      record.completedAt,
      `${operation}.completedAt`,
    ),
  });
}

function requireArtifactIntentObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertRunLedgerArtifactIntent(
  value: unknown,
  operation = "run-ledger.artifactIntent",
): RunLedgerArtifactIntentV1 {
  const record = requireArtifactIntentObject(value, operation);
  if (record.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION)
    throw new TypeError(`${operation}: unsupported schemaVersion`);
  requireText(record.intentId, `${operation}.intentId`);
  requireText(record.runId, `${operation}.runId`);
  if (
    record.state !== "pending" &&
    record.state !== "bound" &&
    record.state !== "abandoned"
  )
    throw new TypeError(`${operation}.state is invalid`);
  const createdAt = requireText(record.createdAt, `${operation}.createdAt`);
  const updatedAt = requireText(record.updatedAt, `${operation}.updatedAt`);
  const abandonAfter = requireText(record.abandonAfter, `${operation}.abandonAfter`);
  if (
    Number.isNaN(Date.parse(createdAt)) ||
    Number.isNaN(Date.parse(updatedAt)) ||
    Number.isNaN(Date.parse(abandonAfter)) ||
    Date.parse(abandonAfter) <= Date.parse(createdAt)
  )
    throw new TypeError(`${operation}: intent timestamps are invalid`);
  const rawArtifacts = record.artifacts;
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length === 0)
    throw new TypeError(`${operation}.artifacts must be a non-empty array`);
  const artifacts = rawArtifacts.map((raw, index) => {
    const artifact = requireArtifactIntentObject(
      raw,
      `${operation}.artifacts[${index}]`,
    );
    requireText(artifact.artifactId, `${operation}.artifacts[${index}].artifactId`);
    if (artifact.scope !== "run")
      throw new TypeError(`${operation}.artifacts[${index}].scope is invalid`);
    requireText(artifact.scopeKey, `${operation}.artifacts[${index}].scopeKey`);
    requirePositiveInteger(
      artifact.version,
      `${operation}.artifacts[${index}].version`,
    );
    if (
      !Number.isSafeInteger(artifact.basisRevision) ||
      (artifact.basisRevision as number) < 0
    )
      throw new TypeError(
        `${operation}.artifacts[${index}].basisRevision is invalid`,
      );
    const recordValue = requireArtifactIntentObject(
      artifact.record,
      `${operation}.artifacts[${index}].record`,
    ) as RuntimeStoreJsonObject;
    const binding = decodeArtifactStoreBindingV1(artifact.binding);
    if (binding === null)
      throw new TypeError(`${operation}.artifacts[${index}].binding is invalid`);
    if (
      binding.artifactId !== artifact.artifactId ||
      binding.scope !== artifact.scope ||
      binding.scopeKey !== artifact.scopeKey ||
      binding.version !== artifact.version ||
      binding.basisRevision !== artifact.basisRevision
    )
      throw new TypeError(
        `${operation}.artifacts[${index}] does not match its binding`,
      );
    return Object.freeze({
      artifactId: artifact.artifactId as string,
      scope: "run" as const,
      scopeKey: artifact.scopeKey as string,
      version: artifact.version as number,
      basisRevision: artifact.basisRevision as number,
      record: recordValue,
      binding,
    });
  });
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length)
    throw new TypeError(`${operation}.artifacts must be unique`);
  const rawOperations = record.contextOperations;
  if (!Array.isArray(rawOperations))
    throw new TypeError(`${operation}.contextOperations must be an array`);
  const contextOperations = rawOperations.map((entry, index) =>
    assertRunLedgerContextOperation(
      entry,
      `${operation}.contextOperations[${index}]`,
    ),
  );
  const rawEffects = record.effectBindings;
  if (!Array.isArray(rawEffects))
    throw new TypeError(`${operation}.effectBindings must be an array`);
  const effectBindings = rawEffects.map((entry, index) => {
    const effect = requireArtifactIntentObject(
      entry,
      `${operation}.effectBindings[${index}]`,
    );
    requireText(effect.operationId, `${operation}.effectBindings[${index}].operationId`);
    requireText(effect.payloadType, `${operation}.effectBindings[${index}].payloadType`);
    requireText(effect.payloadHash, `${operation}.effectBindings[${index}].payloadHash`);
    requireText(
      effect.payloadArtifactRef,
      `${operation}.effectBindings[${index}].payloadArtifactRef`,
    );
    return Object.freeze({
      operationId: effect.operationId as string,
      payloadType: effect.payloadType as string,
      payloadHash: effect.payloadHash as string,
      payloadArtifactRef: effect.payloadArtifactRef as string,
    });
  });
  if (
    new Set(contextOperations.map((entry) => entry.contextOperationId)).size !==
      contextOperations.length ||
    new Set(effectBindings.map((entry) => entry.operationId)).size !==
      effectBindings.length
  )
    throw new TypeError(`${operation}: intent bindings must be unique`);
  const abandonedAt = requireNullableText(
    record.abandonedAt,
    `${operation}.abandonedAt`,
  );
  if (record.state === "abandoned" && abandonedAt === null)
    throw new TypeError(`${operation}: abandoned intent needs abandonedAt`);
  if (record.state !== "abandoned" && abandonedAt !== null)
    throw new TypeError(`${operation}: only abandoned intent has abandonedAt`);
  return Object.freeze({
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    intentId: record.intentId as string,
    runId: record.runId as string,
    state: record.state as RunLedgerArtifactIntentStateV1,
    createdAt,
    updatedAt,
    abandonAfter,
    artifacts: Object.freeze(artifacts),
    contextOperations: Object.freeze(contextOperations),
    effectBindings: Object.freeze(effectBindings),
    abandonedAt,
  });
}

const REVIEW_SOURCES: ReadonlySet<string> = new Set(["cdq", "cdr", "car"]);
const APPROVAL_STATES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
const REVIEW_FOLLOW_UPS: ReadonlySet<string> = new Set([
  "new_admission",
  "restore",
  "expand",
  "block",
]);

/**
 * Shape and state-consistency rules of one approval request. Who may decide
 * and whether the approvalRef is real are the Host's job; here an entry that
 * is internally inconsistent cannot be stored.
 */
export function assertRunLedgerApprovalRequest(
  value: unknown,
  operation = "run-ledger.approvalRequest",
): RunLedgerApprovalRequestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${operation}: approval request must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new TypeError(`${operation}: unsupported schemaVersion`);
  }
  requireText(record.approvalRequestId, `${operation}.approvalRequestId`);
  requireText(record.runId, `${operation}.runId`);
  requireText(record.attemptId, `${operation}.attemptId`);
  requireText(record.turnId, `${operation}.turnId`);
  requirePositiveInteger(record.operationEpoch, `${operation}.operationEpoch`);
  requireText(record.contextOperationId, `${operation}.contextOperationId`);
  if (record.kind !== "context_operation_review") {
    throw new TypeError(`${operation}.kind is invalid`);
  }
  const subject = record.subject;
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
    throw new TypeError(`${operation}.subject must be an object`);
  }
  const subjectRecord = subject as Record<string, unknown>;
  if (!REVIEW_SOURCES.has(String(subjectRecord.source))) {
    throw new TypeError(`${operation}.subject.source is invalid`);
  }
  requireText(subjectRecord.receiptId, `${operation}.subject.receiptId`);
  requireNullableText(subjectRecord.payloadHash, `${operation}.subject.payloadHash`);
  requireNullableText(subjectRecord.manifestRef, `${operation}.subject.manifestRef`);
  let proposal: RunLedgerReviewProposalV1 | undefined;
  if (subjectRecord.proposal !== undefined) {
    const raw = subjectRecord.proposal;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`${operation}.subject.proposal must be an object`);
    }
    const candidate = raw as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.basisRevision) ||
      (candidate.basisRevision as number) < 0
    ) {
      throw new TypeError(`${operation}.subject.proposal.basisRevision is invalid`);
    }
    proposal = Object.freeze({
      prefixMessageCount: requirePositiveInteger(
        candidate.prefixMessageCount,
        `${operation}.subject.proposal.prefixMessageCount`,
      ),
      prefixHash: requireText(
        candidate.prefixHash,
        `${operation}.subject.proposal.prefixHash`,
      ),
      basisRevision: candidate.basisRevision as number,
    });
  }
  if (!APPROVAL_STATES.has(String(record.state))) {
    throw new TypeError(`${operation}.state is invalid`);
  }
  const requestedAt = requireText(record.requestedAt, `${operation}.requestedAt`);
  const expiresAt = requireText(record.expiresAt, `${operation}.expiresAt`);
  if (
    Number.isNaN(Date.parse(requestedAt)) ||
    Number.isNaN(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.parse(requestedAt)
  ) {
    throw new TypeError(`${operation}.expiresAt must be after requestedAt`);
  }
  const state = record.state as RunLedgerApprovalStateV1;
  let resolution: RunLedgerApprovalRequestV1["resolution"] = null;
  if (state === "pending" || state === "expired") {
    if (record.resolution !== null) {
      throw new TypeError(`${operation}: a ${state} request has no resolution`);
    }
  } else {
    const raw = record.resolution;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`${operation}: a ${state} request needs a resolution`);
    }
    const decided = raw as Record<string, unknown>;
    requireText(decided.approvalRef, `${operation}.resolution.approvalRef`);
    if (decided.authority !== "user" && decided.authority !== "kernel") {
      throw new TypeError(
        `${operation}.resolution.authority must be user or kernel`,
      );
    }
    requireText(decided.decidedAt, `${operation}.resolution.decidedAt`);
    requireNullableText(decided.evidenceRef, `${operation}.resolution.evidenceRef`);
    if (!REVIEW_FOLLOW_UPS.has(String(decided.followUp))) {
      throw new TypeError(`${operation}.resolution.followUp is invalid`);
    }
    const consumedBy = requireNullableText(
      decided.consumedBy,
      `${operation}.resolution.consumedBy`,
    );
    const followUp = decided.followUp as RunLedgerReviewFollowUpV1;
    if (state === "rejected" && (followUp !== "block" || consumedBy !== null)) {
      throw new TypeError(`${operation}: a rejected request can only block`);
    }
    if (state === "approved") {
      // A compaction that already happened (CAR) is never re-decided: the
      // review only picks restore / expand / block. Anything not yet
      // executed needs a new admission.
      const allowed =
        subjectRecord.source === "car"
          ? followUp !== "new_admission"
          : followUp === "new_admission";
      if (!allowed) {
        throw new TypeError(
          `${operation}: follow-up ${followUp} does not fit a ${String(subjectRecord.source)} review`,
        );
      }
      if (consumedBy !== null && followUp !== "new_admission") {
        throw new TypeError(`${operation}: only a new admission can be consumed`);
      }
      if (consumedBy === record.contextOperationId) {
        throw new TypeError(
          `${operation}: a new admission needs a new contextOperationId`,
        );
      }
    }
    let grant: RunLedgerGrantRefV1 | undefined;
    if (decided.grant !== undefined) {
      if (state !== "approved") {
        throw new TypeError(`${operation}: only an approved request has a grant`);
      }
      const rawGrant = decided.grant;
      if (rawGrant === null || typeof rawGrant !== "object" || Array.isArray(rawGrant)) {
        throw new TypeError(`${operation}.resolution.grant must be an object`);
      }
      const candidate = rawGrant as Record<string, unknown>;
      const contentHash = requireText(candidate.contentHash, `${operation}.resolution.grant.contentHash`);
      if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash)) {
        throw new TypeError(`${operation}.resolution.grant.contentHash is not a sha256 hash`);
      }
      grant = Object.freeze({
        artifactId: requireText(candidate.artifactId, `${operation}.resolution.grant.artifactId`),
        version: requirePositiveInteger(candidate.version, `${operation}.resolution.grant.version`),
        contentHash,
        storageRef: requireText(candidate.storageRef, `${operation}.resolution.grant.storageRef`),
      });
    }
    resolution = Object.freeze({
      approvalRef: decided.approvalRef as string,
      authority: decided.authority as "user" | "kernel",
      decidedAt: decided.decidedAt as string,
      evidenceRef: requireNullableText(
        decided.evidenceRef,
        `${operation}.resolution.evidenceRef`,
      ),
      followUp,
      consumedBy,
      ...(grant === undefined ? {} : { grant }),
    });
  }
  return Object.freeze({
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    approvalRequestId: record.approvalRequestId as string,
    kind: "context_operation_review" as const,
    runId: record.runId as string,
    attemptId: record.attemptId as string,
    turnId: record.turnId as string,
    operationEpoch: record.operationEpoch as number,
    contextOperationId: record.contextOperationId as string,
    subject: Object.freeze({
      source: subjectRecord.source as "cdq" | "cdr" | "car",
      receiptId: subjectRecord.receiptId as string,
      payloadHash: requireNullableText(
        subjectRecord.payloadHash,
        `${operation}.subject.payloadHash`,
      ),
      manifestRef: requireNullableText(
        subjectRecord.manifestRef,
        `${operation}.subject.manifestRef`,
      ),
      ...(proposal === undefined ? {} : { proposal }),
    }),
    state,
    requestedAt,
    expiresAt,
    resolution,
  });
}
export function assertRunLedger(
  value: unknown,
  operation = "run-ledger",
): RunLedgerV1 {
  if (value === null || typeof value !== "object")
    throw new TypeError(`${operation}: ledger must be an object`);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION)
    throw new TypeError(`${operation}: unsupported ledger schemaVersion`);
  requireText(record.ledgerId, `${operation}.ledgerId`);
  requireText(record.commitId, `${operation}.commitId`);
  requireText(record.runId, `${operation}.runId`);
  requireText(record.status, `${operation}.status`);
  requirePositiveInteger(record.revision, `${operation}.revision`);
  requireText(record.updatedAt, `${operation}.updatedAt`);
  if (!Array.isArray(record.effectOperationIds))
    throw new TypeError(`${operation}.effectOperationIds must be an array`);
  const effectOperationIds = record.effectOperationIds.map((id, index) =>
    requireText(id, `${operation}.effectOperationIds[${index}]`),
  );
  if (new Set(effectOperationIds).size !== effectOperationIds.length)
    throw new TypeError(`${operation}.effectOperationIds must be unique`);
  const contextOperations =
    record.contextOperations === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(record.contextOperations)) {
            throw new TypeError(
              `${operation}.contextOperations must be an array`,
            );
          }
          const entries = record.contextOperations.map((entry, index) =>
            assertRunLedgerContextOperation(
              entry,
              `${operation}.contextOperations[${index}]`,
            ),
          );
          if (
            new Set(entries.map((entry) => entry.contextOperationId)).size !==
            entries.length
          ) {
            throw new TypeError(
              `${operation}.contextOperations must be unique`,
            );
          }
          for (const entry of entries) {
            if (entry.runId !== record.runId) {
              throw new TypeError(
                `${operation}.contextOperations runId must match ledger runId`,
              );
            }
          }
          return entries;
        })();
  const approvalRequests =
    record.approvalRequests === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(record.approvalRequests)) {
            throw new TypeError(
              `${operation}.approvalRequests must be an array`,
            );
          }
          const entries = record.approvalRequests.map((entry, index) =>
            assertRunLedgerApprovalRequest(
              entry,
              `${operation}.approvalRequests[${index}]`,
            ),
          );
          if (
            new Set(entries.map((entry) => entry.approvalRequestId)).size !==
              entries.length ||
            new Set(entries.map((entry) => entry.contextOperationId)).size !==
              entries.length
          ) {
            throw new TypeError(
              `${operation}.approvalRequests must be unique per request and per held operation`,
            );
          }
          for (const entry of entries) {
            if (entry.runId !== record.runId) {
              throw new TypeError(
                `${operation}.approvalRequests runId must match ledger runId`,
              );
            }
          }
          return entries;
        })();
  const artifactIntents =
    record.artifactIntents === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(record.artifactIntents)) {
            throw new TypeError(
              `${operation}.artifactIntents must be an array`,
            );
          }
          const entries = record.artifactIntents.map((entry, index) =>
            assertRunLedgerArtifactIntent(
              entry,
              `${operation}.artifactIntents[${index}]`,
            ),
          );
          if (
            new Set(entries.map((entry) => entry.intentId)).size !==
              entries.length
          ) {
            throw new TypeError(
              `${operation}.artifactIntents must be unique`,
            );
          }
          for (const entry of entries) {
            if (entry.runId !== record.runId) {
              throw new TypeError(
                `${operation}.artifactIntents runId must match ledger runId`,
              );
            }
          }
          return entries;
        })();
  if (
    record.kernelSettlement === null ||
    typeof record.kernelSettlement !== "object"
  )
    throw new TypeError(`${operation}.kernelSettlement must be an object`);
  const settlement = record.kernelSettlement as Record<string, unknown>;
  if (settlement.status !== "open" && settlement.status !== "settled")
    throw new TypeError(`${operation}.kernelSettlement.status is invalid`);
  return Object.freeze({
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    ledgerId: record.ledgerId as string,
    commitId: record.commitId as string,
    runId: record.runId as string,
    activeAttemptId: requireNullableText(
      record.activeAttemptId,
      `${operation}.activeAttemptId`,
    ),
    activeTurnId: requireNullableText(
      record.activeTurnId,
      `${operation}.activeTurnId`,
    ),
    status: record.status as RunLedgerStatus,
    lease: record.lease === null ? null : (record.lease as RunLedgerLeaseV1),
    lastCursor:
      record.lastCursor === null
        ? null
        : (record.lastCursor as RunLedgerCursorV1),
    effectOperationIds: Object.freeze(effectOperationIds),
    kernelSettlement: Object.freeze({
      status: settlement.status as "open" | "settled",
      receiptId: requireNullableText(
        settlement.receiptId,
        `${operation}.kernelSettlement.receiptId`,
      ),
    }),
    dispatchOutboxId: requireNullableText(
      record.dispatchOutboxId,
      `${operation}.dispatchOutboxId`,
    ),
    ...(contextOperations === undefined
      ? {}
      : { contextOperations: Object.freeze(contextOperations) }),
    ...(approvalRequests === undefined
      ? {}
      : { approvalRequests: Object.freeze(approvalRequests) }),
    ...(artifactIntents === undefined
      ? {}
      : { artifactIntents: Object.freeze(artifactIntents) }),
    revision: record.revision as number,
    updatedAt: record.updatedAt as string,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Rules a ledger commit must keep relative to the stored ledger: Context
 * Operations are append-only, and an approval request only moves
 * pending -> approved | rejected | expired. Once decided it never changes,
 * except that an approved new admission is consumed exactly once.
 */
export function assertRunLedgerTransition(
  previous: RunLedgerV1,
  next: RunLedgerV1,
  operation = "run-ledger",
): void {
  const nextOperations = next.contextOperations ?? [];
  for (const entry of previous.contextOperations ?? []) {
    const kept = nextOperations.find(
      (candidate) => candidate.contextOperationId === entry.contextOperationId,
    );
    if (kept === undefined || !sameJson(kept, entry)) {
      throw new TypeError(
        `${operation}: context operation ${entry.contextOperationId} is append-only`,
      );
    }
  }
  const nextApprovals = next.approvalRequests ?? [];
  for (const before of previous.approvalRequests ?? []) {
    const after = nextApprovals.find(
      (candidate) => candidate.approvalRequestId === before.approvalRequestId,
    );
    if (after === undefined) {
      throw new TypeError(
        `${operation}: approval request ${before.approvalRequestId} cannot be removed`,
      );
    }
    const { state: beforeState, resolution: beforeResolution, ...beforeFixed } =
      before;
    const { state: afterState, resolution: afterResolution, ...afterFixed } =
      after;
    if (!sameJson(beforeFixed, afterFixed)) {
      throw new TypeError(
        `${operation}: approval request ${before.approvalRequestId} identity is immutable`,
      );
    }
    if (beforeState === "pending") continue;
    if (afterState !== beforeState) {
      throw new TypeError(
        `${operation}: a ${beforeState} approval request cannot become ${afterState}`,
      );
    }
    if (beforeResolution === null || afterResolution === null) continue;
    const { consumedBy: beforeConsumed, ...beforeDecision } = beforeResolution;
    const { consumedBy: afterConsumed, ...afterDecision } = afterResolution;
    if (!sameJson(beforeDecision, afterDecision)) {
      throw new TypeError(
        `${operation}: the decision of approval request ${before.approvalRequestId} is immutable`,
      );
    }
    if (beforeConsumed !== null && afterConsumed !== beforeConsumed) {
      throw new TypeError(
        `${operation}: approval request ${before.approvalRequestId} was already consumed`,
      );
    }
  }
  const nextIntents = next.artifactIntents ?? [];
  for (const entry of nextIntents) {
    if (
      !(previous.artifactIntents ?? []).some(
        (candidate) => candidate.intentId === entry.intentId,
      ) &&
      entry.state !== "pending"
    ) {
      throw new TypeError(
        `${operation}: artifact intent ${entry.intentId} must be opened as pending`,
      );
    }
  }
  for (const before of previous.artifactIntents ?? []) {
    const after = nextIntents.find(
      (candidate) => candidate.intentId === before.intentId,
    );
    if (after === undefined) {
      throw new TypeError(
        `${operation}: artifact intent ${before.intentId} cannot be removed`,
      );
    }
    const {
      state: beforeState,
      updatedAt: _beforeUpdatedAt,
      abandonedAt: beforeAbandonedAt,
      ...beforeFixed
    } = before;
    const {
      state: afterState,
      updatedAt: _afterUpdatedAt,
      abandonedAt: afterAbandonedAt,
      ...afterFixed
    } = after;
    if (!sameJson(beforeFixed, afterFixed)) {
      throw new TypeError(
        `${operation}: artifact intent ${before.intentId} plan is immutable`,
      );
    }
    if (beforeState !== "pending") {
      if (
        afterState !== beforeState ||
        !sameJson(beforeAbandonedAt, afterAbandonedAt)
      ) {
        throw new TypeError(
          `${operation}: artifact intent ${before.intentId} is already ${beforeState}`,
        );
      }
      continue;
    }
    if (afterState === "bound") {
      // Bound is only true if the Context Operations the plan promised are
      // in this very ledger. (Effect payload bindings are checked by the
      // store, which sees the effect rows.)
      for (const planned of after.contextOperations) {
        const present = (next.contextOperations ?? []).find(
          (entry) => entry.contextOperationId === planned.contextOperationId,
        );
        if (present === undefined || !sameJson(present, planned)) {
          throw new TypeError(
            `${operation}: bound artifact intent ${before.intentId} is missing a planned Context Operation`,
          );
        }
      }
    }
  }
}
export function assertEffectLedgerEntry(
  value: unknown,
  operation = "run-ledger.effect",
): EffectLedgerEntryV1 {
  if (value === null || typeof value !== "object")
    throw new TypeError(`${operation}: effect must be an object`);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION)
    throw new TypeError(`${operation}: unsupported effect schemaVersion`);
  requireText(record.operationId, `${operation}.operationId`);
  requireText(record.runId, `${operation}.runId`);
  requireText(record.attemptId, `${operation}.attemptId`);
  requireText(record.turnId, `${operation}.turnId`);
  requireText(record.toolCallId, `${operation}.toolCallId`);
  requirePositiveInteger(record.operationEpoch, `${operation}.operationEpoch`);
  requireText(record.inputHash, `${operation}.inputHash`);
  requireText(record.status, `${operation}.status`);
  requireText(record.idempotencyKey, `${operation}.idempotencyKey`);
  requireText(record.createdAt, `${operation}.createdAt`);
  const payloadType = optionalNullableText(
    record,
    "payloadType",
    `${operation}.payloadType`,
  );
  const payloadHash = optionalNullableText(
    record,
    "payloadHash",
    `${operation}.payloadHash`,
  );
  const payloadArtifactRef = optionalNullableText(
    record,
    "payloadArtifactRef",
    `${operation}.payloadArtifactRef`,
  );
  return Object.freeze({
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    operationId: record.operationId as string,
    runId: record.runId as string,
    attemptId: record.attemptId as string,
    turnId: record.turnId as string,
    toolCallId: record.toolCallId as string,
    operationEpoch: record.operationEpoch as number,
    inputHash: record.inputHash as string,
    status: record.status as EffectLedgerStatusV1,
    receiptId: requireNullableText(record.receiptId, `${operation}.receiptId`),
    idempotencyKey: record.idempotencyKey as string,
    createdAt: record.createdAt as string,
    completedAt: requireNullableText(
      record.completedAt,
      `${operation}.completedAt`,
    ),
    ...(payloadType === undefined ? {} : { payloadType }),
    ...(payloadHash === undefined ? {} : { payloadHash }),
    ...(payloadArtifactRef === undefined ? {} : { payloadArtifactRef }),
  });
}

export function runtimeEffectForLedgerEntry(
  entry: EffectLedgerEntryV1,
): RuntimeStoreEffectReceipt {
  const status =
    entry.status === "intent"
      ? "pending"
      : entry.status === "success"
        ? "succeeded"
        : entry.status === "failure"
          ? "failed"
          : "unknown";
  return {
    schemaVersion: 1,
    effectId: entry.operationId,
    runId: entry.runId,
    status,
    assurance:
      entry.status === "success" ? "assurance_exact" : "assurance_unknown",
    result: {
      [RUN_LEDGER_EFFECT_KEY]: entry,
    } as unknown as RuntimeStoreJsonObject,
    error: null,
    requestHash: entry.inputHash,
    recordedAt: entry.completedAt ?? entry.createdAt,
  };
}

export function ledgerEntryFromRuntimeEffect(
  effect: RuntimeStoreEffectReceipt,
): EffectLedgerEntryV1 | null {
  if (
    effect.result === null ||
    typeof effect.result !== "object" ||
    Array.isArray(effect.result)
  )
    return null;
  const candidate = (effect.result as RuntimeStoreJsonObject)[
    RUN_LEDGER_EFFECT_KEY
  ];
  if (candidate === undefined) return null;
  return assertEffectLedgerEntry(candidate, "stored run-ledger effect");
}

export function ledgerFromRuntimeRun(run: RuntimeStoreRun): RunLedgerV1 | null {
  const candidate = run.metadata[RUN_LEDGER_METADATA_KEY];
  return candidate === undefined
    ? null
    : assertRunLedger(candidate, "stored run-ledger");
}
