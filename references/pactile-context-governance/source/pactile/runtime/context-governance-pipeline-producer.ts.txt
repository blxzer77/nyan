import type {
  ContextPipelineResultV1,
  PactileContextGrantV1,
} from "../agent/context-pipeline.js";
import { CAR_CHECK_IDS_V1 } from "./context-governance-receipts.js";
import { fingerprintPactileContractV1 } from "../shared/validation.js";
import type {
  ArtifactStorePort,
} from "../agent/memory/artifact-store.js";
import {
  persistContextGovernanceReceiptV1,
} from "./context-governance-producer.js";
import {
  memoryReadFailureStatusV1,
} from "./context-governance-memory.js";
import {
  persistContextGovernanceMemoryCommitV1,
} from "./context-governance-memory-commit.js";
import { openContextReviewForReceiptV1 } from "./context-governance-review.js";
import type {
  EffectLedgerEntryV1,
  RunLedgerPort,
} from "./run-ledger.js";
import {
  runtimeRequestHashV1,
  type RuntimeStoreJsonObject,
  type RuntimeStoreLeaseProof,
} from "./store-port.js";

export interface ContextGovernancePipelineReceiptProducerOptionsV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly scopeKey: string;
  readonly cdrOperationId: string;
  readonly carOperationId: string;
  readonly cdrArtifactId: string;
  readonly carArtifactId: string;
  /**
   * Also record the pipeline's Memory Port commit (artifact, receipt,
   * manifest) as a `memory_commit` Context Operation. Opt-in because the
   * memory scope is not otherwise known to the producer.
   */
  readonly memoryCommit?: {
    readonly scope: string;
    readonly scopeKey: string;
    readonly artifactId: string;
  };
  /** Fences the ledger writes of this producer to the Memory Port lease. */
  readonly lease?: RuntimeStoreLeaseProof;
  /** How long a review this producer opens stays open. Default 24 hours. */
  readonly reviewTtlMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_REVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function hash(domain: string, value: unknown): string {
  return fingerprintPactileContractV1({ domain, value });
}

/**
 * The CDR / CAR bind to a RunLedger effect. Production code used to rely on
 * somebody else having created those entries (only tests did). Make sure the
 * entry exists; an entry that is already there (seeded, or left by an earlier
 * attempt) is used as it is, so this is idempotent.
 */
async function ensureTerminalEffect(input: {
  readonly options: ContextGovernancePipelineReceiptProducerOptionsV1;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly now: () => Date;
}): Promise<EffectLedgerEntryV1> {
  const { options } = input;
  const snapshot = await options.ledger.readRunLedger(options.runId);
  if (snapshot === null) throw new Error("Context Governance RunLedger is missing");
  const existing = snapshot.effects.find(
    (entry) => entry.operationId === input.operationId,
  );
  if (existing !== undefined) return existing;
  const at = input.now().toISOString();
  const entry: EffectLedgerEntryV1 = {
    schemaVersion: 1,
    operationId: input.operationId,
    runId: options.runId,
    attemptId: options.attemptId,
    turnId: options.turnId,
    toolCallId: input.toolCallId,
    operationEpoch: options.operationEpoch,
    inputHash: hash("context-governance-effect-v1", {
      operationId: input.operationId,
      contextOperationId: options.contextOperationId,
    }),
    status: "success",
    receiptId: null,
    idempotencyKey: `${input.operationId}:idempotency`,
    createdAt: at,
    completedAt: at,
  };
  const ledger = {
    ...snapshot.ledger,
    commitId: `${snapshot.ledger.commitId}:context-effect:${input.operationId}`,
    effectOperationIds: [...snapshot.ledger.effectOperationIds, input.operationId],
    revision: snapshot.ledger.revision + 1,
    updatedAt: at,
  };
  await options.ledger.commitRunLedger({
    idempotencyKey: `pactile-ledger-context-effect:${input.operationId}`,
    requestHash: runtimeRequestHashV1("run-ledger.context-effect", {
      operationId: input.operationId,
      expectedRevision: snapshot.ledger.revision,
    }),
    ledger,
    effects: [entry],
    ...(options.lease === undefined ? {} : { lease: options.lease }),
  });
  return entry;
}

function receiptEnvelope(input: {
  readonly schemaId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly createdAt: string;
  readonly body: RuntimeStoreJsonObject;
}): RuntimeStoreJsonObject {
  const bodyHash = hash(`${input.schemaId}:body-v1`, input.body);
  return {
    schemaId: input.schemaId,
    schemaVersion: 1,
    plane: "runtime",
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    bodyHash,
    receiptHash: hash(`${input.schemaId}:receipt-v1`, {
      bodyHash,
      body: input.body,
    }),
    createdAt: input.createdAt,
    provenance: {
      authority: "host",
      producer: "pactile-context-pipeline",
    },
    ...input.body,
  } as RuntimeStoreJsonObject;
}

function cdrReceipt(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly effect: EffectLedgerEntryV1;
  readonly createdAt: string;
  /**
   * Set when the compaction was admitted under an approval: the CDR then
   * names the immutable snapshot of that approval (`authorization.grantRef`)
   * and the policy that asked for the review.
   */
  readonly grant?: PactileContextGrantV1;
  /** Set when the Policy Gate, not an admission, produced this decision. */
  readonly gated?: {
    readonly verdict: "review_required" | "blocked";
    readonly policyVersion: string;
    readonly ruleIds: readonly string[];
    readonly proposalHash: string;
  };
}): RuntimeStoreJsonObject {
  return receiptEnvelope({
    schemaId: "pactile.cg.compression-decision-receipt",
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    createdAt: input.createdAt,
    body: {
      receiptId: `cdr-${input.contextOperationId}`,
      requestRef:
        input.gated === undefined
          ? {
              schemaId: "pactile.cg.compression-decision-request",
              schemaVersion: 1,
            }
          : {
              schemaId: "pactile.cg.compression-decision-request",
              schemaVersion: 1,
              id: `proposal-${input.contextOperationId}`,
              bodyHash: input.gated.proposalHash,
            },
      verdict: input.gated?.verdict ?? "admitted",
      adopted: [],
      overridden: [],
      policy:
        input.gated !== undefined
          ? { policyVersion: input.gated.policyVersion, ruleIds: [...input.gated.ruleIds] }
          : input.grant !== undefined
            ? { policyVersion: input.grant.policyVersion, ruleIds: [...input.grant.ruleIds] }
            : { policyVersion: "context-pipeline-v1", ruleIds: [] },
      authorization: {
        class: "reversible",
        grantRef: input.grant === undefined ? null : { ...input.grant.artifactRef },
      },
      effect: {
        operationId: input.effect.operationId,
        ledgerReceiptId: input.effect.receiptId,
      },
    },
  });
}

function carReceipt(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly cdrReceiptId: string;
  readonly compactionReceiptId: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly createdAt: string;
}): RuntimeStoreJsonObject {
  return receiptEnvelope({
    schemaId: "pactile.cg.compaction-audit-receipt",
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    createdAt: input.createdAt,
    body: {
      auditId: `car-${input.contextOperationId}`,
      decisionRef: {
        schemaId: "pactile.cg.compression-decision-receipt",
        schemaVersion: 1,
        receiptId: input.cdrReceiptId,
      },
      compaction: {
        piCompactionId: input.compactionReceiptId,
        commitReceiptRef: null,
      },
      snapshots: {
        beforeHash: input.beforeHash,
        afterHash: input.afterHash,
      },
      checks: CAR_CHECK_IDS_V1.map((id) => ({
        id,
        result: { status: "unknown", value: "fail" },
        detailHash: null,
      })),
      verdict: "assurance_unknown",
      regressionCaseRef: null,
    },
  });
}

/**
 * Build the existing `onResult` callback for a Host-owned Context Pipeline.
 * A successful compaction gets an admitted CDR and an explicitly unknown CAR;
 * no audit check is silently promoted to `accepted`.
 */
export function createContextGovernancePipelineReceiptProducerV1(
  options: ContextGovernancePipelineReceiptProducerOptionsV1,
): (result: ContextPipelineResultV1) => Promise<void> {
  const now = options.now ?? (() => new Date());
  // One governance decision per operation id. While the same pipeline keeps
  // being blocked by the same Policy Gate (for example after a rejected
  // review), later results add no second CDR or review: a new decision needs
  // a new operation, i.e. a new attempt.
  let gatedRecorded = false;
  return async (result): Promise<void> => {
    if (result.policy !== null && result.proposal !== null) {
      if (gatedRecorded) return;
      const policy = result.policy;
      const proposal = result.proposal;
      const effect = await ensureTerminalEffect({
        options,
        operationId: options.cdrOperationId,
        toolCallId: `context-cdr-${options.contextOperationId}`,
        now,
      });
      const verdict = policy.verdict === "review" ? "review_required" : "blocked";
      const cdr = cdrReceipt({
        workspaceId: options.workspaceId,
        runId: options.runId,
        attemptId: options.attemptId,
        turnId: options.turnId,
        operationEpoch: options.operationEpoch,
        contextOperationId: options.contextOperationId,
        effect,
        createdAt: now().toISOString(),
        gated: {
          verdict,
          policyVersion: policy.policyVersion,
          ruleIds: policy.ruleIds,
          proposalHash: hash("context-proposal-v1", proposal),
        },
      });
      const persisted = await persistContextGovernanceReceiptV1({
        ledger: options.ledger,
        artifacts: options.artifacts,
        receipt: cdr,
        effect,
        artifactId: options.cdrArtifactId,
        scopeKey: options.scopeKey,
        version: 1,
        basisRevision: proposal.basisRevision,
        ...(options.lease === undefined ? {} : { lease: options.lease }),
      });
      if (!persisted.ok && persisted.code === "ledger_effect_conflict") {
        // This operation already holds a different durable decision (for an
        // earlier proposal). The compaction stays blocked either way; a
        // second decision needs a new operation.
        gatedRecorded = true;
        return;
      }
      if (!persisted.ok) {
        throw new Error(`CDR persistence failed: ${persisted.code}`);
      }
      if (verdict === "review_required") {
        const opened = await openContextReviewForReceiptV1({
          ledger: options.ledger,
          runId: options.runId,
          receipt: cdr,
          effect,
          proposal: {
            prefixMessageCount: proposal.prefixMessageCount,
            prefixHash: proposal.prefixHash,
            basisRevision: proposal.basisRevision,
          },
          expiresAt: new Date(
            now().getTime() + (options.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS),
          ).toISOString(),
          now,
          ...(options.lease === undefined ? {} : { lease: options.lease }),
        });
        if (!opened.ok) {
          throw new Error(`Context review could not be opened: ${opened.code}`);
        }
      }
      gatedRecorded = true;
      return;
    }
    if (options.memoryCommit !== undefined && result.memoryCommitRequest !== null) {
      const attempt = result.memoryCommitRequest;
      const outcome =
        result.memoryCommit !== null
          ? ({
              kind: "committed",
              facts: {
                artifactId: result.memoryCommit.artifactId,
                version: result.memoryCommit.artifactVersion,
                contentHash: result.memoryCommit.artifactHash,
                storageRef: result.memoryCommit.artifactStorageRef,
                receiptId: result.memoryCommit.memoryReceiptId,
                receiptHash: result.memoryCommit.memoryReceiptHash,
                manifestId: result.memoryCommit.manifestId,
                manifestRevision: result.memoryCommit.manifestRevision,
                manifestHash: result.memoryCommit.manifestHash,
              },
            } as const)
          : result.memoryCommitFailure !== null &&
              memoryReadFailureStatusV1(result.memoryCommitFailure.code) !== null
            ? ({ kind: "failed", failure: result.memoryCommitFailure } as const)
            : null;
      if (outcome !== null) {
        const recorded = await persistContextGovernanceMemoryCommitV1({
          ledger: options.ledger,
          artifacts: options.artifacts,
          request: {
            requestId: attempt.requestId,
            scope: options.memoryCommit.scope,
            scopeKey: options.memoryCommit.scopeKey,
            artifactId: attempt.artifactId,
            version: attempt.version,
            basisRevision: attempt.basisRevision,
            requestHash: attempt.requestHash,
          },
          outcome,
          workspaceId: options.workspaceId,
          runId: options.runId,
          attemptId: options.attemptId,
          turnId: options.turnId,
          operationEpoch: options.operationEpoch,
          contextOperationId: options.contextOperationId,
          memoryCommitArtifactId: options.memoryCommit.artifactId,
          artifactScopeKey: options.scopeKey,
          artifactVersion: 1,
          now,
          ...(options.lease === undefined ? {} : { lease: options.lease }),
        });
        if (!recorded.ok) {
          throw new Error(`Memory commit persistence failed: ${recorded.code}`);
        }
      }
    }
    if (
      result.status !== "compacted" ||
      result.compactionReceipt === null ||
      result.snapshot === null
    ) {
      return;
    }
    const cdrEffect = await ensureTerminalEffect({
      options,
      operationId: options.cdrOperationId,
      toolCallId: `context-cdr-${options.contextOperationId}`,
      now,
    });
    const carEffect = await ensureTerminalEffect({
      options,
      operationId: options.carOperationId,
      toolCallId: `context-car-${options.contextOperationId}`,
      now,
    });
    const createdAt = now().toISOString();
    const cdr = cdrReceipt({
      workspaceId: options.workspaceId,
      runId: options.runId,
      attemptId: options.attemptId,
      turnId: options.turnId,
      operationEpoch: options.operationEpoch,
      contextOperationId: options.contextOperationId,
      effect: cdrEffect,
      createdAt,
      ...(result.grant === null ? {} : { grant: result.grant }),
    });
    const cdrRecord = cdr as Record<string, unknown>;
    const cdrPersisted = await persistContextGovernanceReceiptV1({
      ledger: options.ledger,
      artifacts: options.artifacts,
      receipt: cdr,
      effect: cdrEffect,
      artifactId: options.cdrArtifactId,
      scopeKey: options.scopeKey,
      version: 1,
      basisRevision: result.cutPoint?.basisRevision ?? 1,
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    });
    if (!cdrPersisted.ok) {
      throw new Error(`CDR persistence failed: ${cdrPersisted.code}`);
    }
    const car = carReceipt({
      workspaceId: options.workspaceId,
      runId: options.runId,
      attemptId: options.attemptId,
      turnId: options.turnId,
      operationEpoch: options.operationEpoch,
      contextOperationId: options.contextOperationId,
      cdrReceiptId: String(cdrRecord.receiptId),
      compactionReceiptId: result.compactionReceipt.piCompactionId,
      beforeHash: result.oldSnapshotHash,
      afterHash: result.snapshot.contentHash,
      createdAt: now().toISOString(),
    });
    const carPersisted = await persistContextGovernanceReceiptV1({
      ledger: options.ledger,
      artifacts: options.artifacts,
      receipt: car,
      effect: carEffect,
      artifactId: options.carArtifactId,
      scopeKey: options.scopeKey,
      version: 1,
      basisRevision: result.cutPoint?.basisRevision ?? 1,
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    });
    if (!carPersisted.ok) {
      throw new Error(`CAR persistence failed: ${carPersisted.code}`);
    }
  };
}
