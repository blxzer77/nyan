import type { ArtifactStoreBindingV1, ArtifactStorePort } from "../agent/memory/artifact-store.js";
import type {
  ContextMemoryDurabilityPort,
  MemoryCommitRequestV1,
  MemoryCommitSuccessV1,
  MemoryDurabilityFailureV1,
} from "../agent/memory/durability.js";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../shared/validation.js";
import { memoryReadFailureStatusV1 } from "./context-governance-memory.js";
import {
  envelope,
  positiveInteger,
  recordFailure,
  text,
  type MemoryRecordPersistFailureV1,
} from "./context-governance-record-support.js";
import {
  artifactIntentIdV1,
  persistContextGovernanceArtifactIntentV1,
  plannedArtifactBindingV1,
  priorArtifactIntentCreatedAtV1,
} from "./context-governance-artifact-intents.js";
import {
  CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1,
  bindContextGovernanceReceiptV1,
  type MemoryCommitRecordV1,
} from "./context-governance-receipts.js";
import type { RunLedgerContextOperationV1, RunLedgerPort, RunLedgerV1 } from "./run-ledger.js";
import type { RuntimeStoreJsonObject, RuntimeStoreLeaseProof } from "./store-port.js";

/** Identity of one Memory Port commit request, without its document body. */
export interface MemoryCommitRequestIdentityV1 {
  readonly requestId: string;
  readonly scope: string;
  readonly scopeKey: string;
  readonly artifactId: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly requestHash: string;
}

/** Hash the full request (document and disclosure text included). */
export function memoryCommitRequestIdentityV1(
  request: MemoryCommitRequestV1,
): MemoryCommitRequestIdentityV1 {
  return {
    requestId: request.requestId,
    scope: request.scope,
    scopeKey: request.scopeKey,
    artifactId: request.artifactId,
    version: request.version,
    basisRevision: request.basisRevision,
    requestHash: fingerprintPactileContractV1({
      domain: "memory-commit-request-v1",
      requestId: request.requestId,
      scope: request.scope,
      scopeKey: request.scopeKey,
      artifactId: request.artifactId,
      version: request.version,
      basisRevision: request.basisRevision,
      whenToRead: request.whenToRead,
      document: canonicalizePactileJsonV1(request.document),
    }),
  };
}

/** What a verified commit proved; `MemoryCommitSuccessV1` satisfies it. */
export interface MemoryCommitFactsV1 {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly storageRef: string;
  readonly receiptId: string;
  readonly receiptHash: string;
  readonly manifestId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
}

export type MemoryCommitOutcomeV1 =
  | { readonly kind: "committed"; readonly facts: MemoryCommitFactsV1 }
  | { readonly kind: "failed"; readonly failure: MemoryDurabilityFailureV1 };

export interface PersistContextGovernanceMemoryCommitInputV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly request: MemoryCommitRequestIdentityV1;
  readonly outcome: MemoryCommitOutcomeV1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  /** The operation id is `<contextOperationId>:memory-commit`. */
  readonly contextOperationId: string;
  readonly memoryCommitArtifactId: string;
  /** Where the record artifact lives; independent of the memory scope key. */
  readonly artifactScopeKey: string;
  readonly artifactVersion: number;
  readonly now?: () => Date;
  readonly lease?: RuntimeStoreLeaseProof;
}

export type PersistContextGovernanceMemoryCommitResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly memoryCommit: MemoryCommitRecordV1;
      readonly memoryCommitArtifact: ArtifactStoreBindingV1;
      readonly ledger: RunLedgerV1;
    }
  | MemoryRecordPersistFailureV1;

/**
 * Persist what the Memory Port did for one commit as a MemoryCommitRecord and
 * bind it to the RunLedger as a `memory_commit` Context Operation. A failed
 * commit is recorded with every unverified field null and the progress of the
 * artifact -> receipt -> manifest order, so an unbound artifact or receipt is
 * visible without being claimed. Failures that MemoryCommitRecordV1 has no
 * status for are refused, never folded into a neighbouring status.
 */
export async function persistContextGovernanceMemoryCommitV1(
  input: PersistContextGovernanceMemoryCommitInputV1,
): Promise<PersistContextGovernanceMemoryCommitResultV1> {
  let status: MemoryCommitRecordV1["status"];
  try {
    text(input.workspaceId, "workspaceId");
    text(input.runId, "runId");
    text(input.attemptId, "attemptId");
    text(input.turnId, "turnId");
    positiveInteger(input.operationEpoch, "operationEpoch");
    text(input.contextOperationId, "contextOperationId");
    text(input.memoryCommitArtifactId, "memoryCommitArtifactId");
    text(input.artifactScopeKey, "artifactScopeKey");
    positiveInteger(input.artifactVersion, "artifactVersion");
    text(input.request.requestId, "request.requestId");
    text(input.request.scopeKey, "request.scopeKey");
    text(input.request.artifactId, "request.artifactId");
    positiveInteger(input.request.version, "request.version");
    if (
      !Number.isSafeInteger(input.request.basisRevision) ||
      input.request.basisRevision < 0
    )
      throw new TypeError("request.basisRevision must be a non-negative safe integer");
    if (input.outcome.kind === "committed") {
      const facts = input.outcome.facts;
      if (
        facts.artifactId !== input.request.artifactId ||
        facts.version !== input.request.version
      )
        throw new TypeError("commit result does not match the commit request");
      status = "ok";
    } else {
      const failed = input.outcome.failure;
      if (failed.domain !== "memory")
        throw new TypeError("memory commit failure must belong to the memory domain");
      if (failed.scopeKey !== null && failed.scopeKey !== input.request.scopeKey)
        throw new TypeError("memory commit failure scopeKey does not match the request");
      if (failed.reexecute || failed.replayPolicy !== "no_automatic_replay")
        throw new TypeError("memory commit failures must remain non-replayable");
      const mapped = memoryReadFailureStatusV1(failed.code);
      if (mapped === null)
        throw new TypeError(
          `memory failure ${failed.code} has no MemoryCommitRecordV1 status and is not recorded as a memory commit`,
        );
      status = mapped;
    }
  } catch (error) {
    return recordFailure(
      "input_invalid",
      error instanceof Error ? error.message : "memory commit record input is invalid",
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const operationId = `${input.contextOperationId}:memory-commit`;
  const { outcome, request } = input;
  const failed = outcome.kind === "failed" ? outcome.failure : null;
  const progress = failed?.progress ?? {
    artifact: failed === null,
    receipt: failed === null,
    manifest: failed === null,
  };
  const responseHash =
    outcome.kind === "committed"
      ? fingerprintPactileContractV1({
          domain: "memory-commit-response-v1",
          receiptHash: outcome.facts.receiptHash,
          manifestHash: outcome.facts.manifestHash,
        })
      : fingerprintPactileContractV1({
          domain: "memory-commit-failure-response-v1",
          status,
          code: outcome.failure.code,
          stage: outcome.failure.stage,
          progress: outcome.failure.progress,
          details: outcome.failure.details,
        });
  const verified = outcome.kind === "committed" ? outcome.facts : null;
  const buildCommit = (createdAt: string): MemoryCommitRecordV1 =>
    envelope(
      CONTEXT_GOVERNANCE_RECEIPT_SCHEMA_IDS_V1.memoryCommit,
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        attemptId: input.attemptId,
        turnId: input.turnId,
        operationEpoch: input.operationEpoch,
        contextOperationId: operationId,
        createdAt,
      },
      {
        commitRecordId: operationId,
        requestId: request.requestId,
        requestHash: request.requestHash,
        responseHash,
        scope: request.scope,
        scopeKey: request.scopeKey,
        basisRevision: request.basisRevision,
        artifactId: request.artifactId,
        artifactVersion: request.version,
        artifactRef: verified?.storageRef ?? null,
        contentHash: verified?.contentHash ?? null,
        memoryReceiptId: verified?.receiptId ?? null,
        memoryReceiptHash: verified?.receiptHash ?? null,
        manifestId: verified?.manifestId ?? null,
        manifestRevision: verified?.manifestRevision ?? null,
        manifestHash: verified?.manifestHash ?? null,
        status,
        progress: {
          artifact: progress.artifact,
          receipt: progress.receipt,
          manifest: progress.manifest,
        },
        checks:
          failed === null
            ? [
                { id: "artifact", result: "ok" },
                { id: "receipt", result: "ok" },
                { id: "manifest", result: "ok" },
              ]
            : [
                { id: "request", result: "ok" },
                { id: "memory_commit", result: "fail", code: failed.code },
              ],
      },
    ) as unknown as MemoryCommitRecordV1;

  try {
    bindContextGovernanceReceiptV1({
      receipt: buildCommit(now) as unknown as RuntimeStoreJsonObject,
    });
  } catch (error) {
    return recordFailure(
      "input_invalid",
      error instanceof Error ? error.message : "memory commit record is invalid",
    );
  }

  // A retry rebuilds the record with the `createdAt` of the durable plan an
  // earlier attempt made; a genuinely different outcome still conflicts.
  const intentId = artifactIntentIdV1(input.runId, operationId);
  const createdAt =
    (await priorArtifactIntentCreatedAtV1(input.ledger, input.runId, intentId)) ??
    now;
  const memoryCommit = buildCommit(createdAt);
  const memoryCommitArtifact = plannedArtifactBindingV1({
    artifactId: input.memoryCommitArtifactId,
    scopeKey: input.artifactScopeKey,
    version: input.artifactVersion,
    basisRevision: request.basisRevision,
    record: memoryCommit as unknown as RuntimeStoreJsonObject,
  });

  const operation: RunLedgerContextOperationV1 = {
    schemaVersion: 1,
    contextOperationId: operationId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    kind: "memory_commit",
    status: failed === null ? "succeeded" : "failed",
    requestHash: request.requestHash,
    responseHash,
    payloadType: memoryCommit.schemaId,
    payloadHash: memoryCommit.receiptHash,
    payloadArtifactRef: memoryCommitArtifact.storageRef,
    createdAt: memoryCommit.createdAt,
    completedAt: memoryCommit.createdAt,
  };
  const bound = await persistContextGovernanceArtifactIntentV1({
    ledger: input.ledger,
    artifacts: input.artifacts,
    intentId,
    runId: input.runId,
    records: [
      {
        artifactId: input.memoryCommitArtifactId,
        scopeKey: input.artifactScopeKey,
        version: input.artifactVersion,
        basisRevision: request.basisRevision,
        record: memoryCommit as unknown as RuntimeStoreJsonObject,
      },
    ],
    contextOperations: [operation],
    effectBindings: [],
    now: createdAt,
    abandonAfter: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
  if (!bound.ok) {
    return recordFailure(
      bound.code === "intent_invalid"
        ? "input_invalid"
        : bound.code === "intent_abandoned"
          ? "ledger_conflict"
          : bound.code,
      bound.message,
      bound.committedArtifacts ?? [],
    );
  }
  return {
    ok: true,
    applied: bound.applied,
    memoryCommit: bound.intent.artifacts[0]?.record as unknown as MemoryCommitRecordV1,
    memoryCommitArtifact: bound.artifacts[0] ?? memoryCommitArtifact,
    ledger: bound.ledger,
  };
}

export interface GovernedMemoryCommitInputV1 {
  readonly memory: Pick<ContextMemoryDurabilityPort, "commit">;
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly request: MemoryCommitRequestV1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  /**
   * One logical commit attempt. The Memory Port commit is idempotent by
   * `request.requestId`, so repeating the call with the same ids is a retry:
   * nothing is rewritten and the committed record artifact is adopted.
   */
  readonly contextOperationId: string;
  readonly now?: () => Date;
}

export type GovernedMemoryCommitResultV1 =
  | {
      readonly ok: true;
      readonly commit: MemoryCommitSuccessV1;
      readonly recorded: Extract<
        PersistContextGovernanceMemoryCommitResultV1,
        { readonly ok: true }
      >;
    }
  | {
      /** The Memory Port refused or failed; `record` says what was written. */
      readonly ok: false;
      readonly stage: "commit";
      readonly failure: MemoryDurabilityFailureV1;
      readonly record:
        | {
            readonly kind: "recorded";
            readonly result: Extract<
              PersistContextGovernanceMemoryCommitResultV1,
              { readonly ok: true }
            >;
          }
        | { readonly kind: "not_representable"; readonly reason: string }
        | {
            readonly kind: "record_failed";
            readonly failure: MemoryRecordPersistFailureV1;
          };
    }
  | {
      /** Durably committed, but the RunLedger binding failed. Retry the call. */
      readonly ok: false;
      readonly stage: "record";
      readonly commit: MemoryCommitSuccessV1;
      readonly recordFailure: MemoryRecordPersistFailureV1;
    };

/**
 * One governed memory commit: write through the Memory Port (artifact, then
 * receipt, then manifest), then record the outcome in the RunLedger. A failed
 * commit is recorded once and never replayed automatically.
 */
export async function commitGovernedContextMemoryV1(
  input: GovernedMemoryCommitInputV1,
): Promise<GovernedMemoryCommitResultV1> {
  const request = memoryCommitRequestIdentityV1(input.request);
  const common = {
    ledger: input.ledger,
    artifacts: input.artifacts,
    request,
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    memoryCommitArtifactId: `cg-memory-commit-${input.contextOperationId}`,
    artifactScopeKey: input.request.scopeKey,
    artifactVersion: 1,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.request.lease === undefined ? {} : { lease: input.request.lease }),
  };
  const commit = await input.memory.commit(input.request);
  if (commit.ok) {
    const recorded = await persistContextGovernanceMemoryCommitV1({
      ...common,
      outcome: { kind: "committed", facts: commit },
    });
    return recorded.ok
      ? { ok: true, commit, recorded }
      : { ok: false, stage: "record", commit, recordFailure: recorded };
  }
  if (memoryReadFailureStatusV1(commit.code) === null) {
    return {
      ok: false,
      stage: "commit",
      failure: commit,
      record: {
        kind: "not_representable",
        reason: `memory failure ${commit.code} has no MemoryCommitRecordV1 status`,
      },
    };
  }
  const recorded = await persistContextGovernanceMemoryCommitV1({
    ...common,
    outcome: { kind: "failed", failure: commit },
  });
  return {
    ok: false,
    stage: "commit",
    failure: commit,
    record: recorded.ok
      ? { kind: "recorded", result: recorded }
      : { kind: "record_failed", failure: recorded },
  };
}
