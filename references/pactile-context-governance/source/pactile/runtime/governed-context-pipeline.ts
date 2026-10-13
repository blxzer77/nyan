import {
  PactileContextPipeline,
  type ContextCheckpointWriterV1,
  type ContextPipelineResultV1,
  type ContextSummaryProviderV1,
  type PactileContextPipelinePortV1,
} from "../agent/context-pipeline.js";
import {
  createDeterministicContextSummarizerV1,
  estimateContextTokensV1,
} from "../agent/context-summarizer.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import type {
  ContextMemoryDurabilityPort,
  MemoryAuditReceiptStorePort,
} from "../agent/memory/durability.js";
import type { AgentMessage } from "../agent/pi/types.js";
import { createContextGovernancePipelineReceiptProducerV1 } from "./context-governance-pipeline-producer.js";
import {
  createRunLedgerContextAdmissionGateV1,
  type ContextPolicyV1,
} from "./context-governance-policy.js";
import type { GovernedRunSessionV1 } from "./governed-run-session.js";
import type { RunLedgerPort } from "./run-ledger.js";
import type { RuntimeStoreLeaseProof } from "./store-port.js";

/**
 * The Host's Context pipeline for a governed run.
 *
 * `PactileContextPipeline` is built for ONE Context Operation: its receipts
 * (CDR, CAR, memory commit) are keyed by that operation, and a second
 * compaction under the same id would collide with the first. A run can need
 * several compactions, so this port builds a fresh pipeline - a fresh Context
 * Operation - for each request, and only moves to the next operation number
 * once an operation has left a record.
 *
 * A decision that holds compaction (a review is required, or the policy
 * denies it) ends compaction for the rest of THIS process: asking again on the
 * next model turn would only open another review for the same situation. A new
 * attempt (a new operation epoch) decides again, and can spend an approval.
 *
 * Host wiring only. The Agent still sees the plain pipeline port.
 */

export interface GovernedContextPipelineHostV1 {
  /** Where the compaction audit receipts are appended (the RuntimeStore). */
  readonly audits: MemoryAuditReceiptStorePort;
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly memory: ContextMemoryDurabilityPort;
}

export interface GovernedContextPipelineOptionsV1 {
  readonly host: GovernedContextPipelineHostV1;
  readonly session: Pick<
    GovernedRunSessionV1,
    "runId" | "attemptId" | "turnId" | "scopeKey" | "memoryLease"
  >;
  readonly workspaceId: string;
  readonly operationEpoch: number;
  /** The Agent session lease; it fences the ledger writes of every receipt. */
  readonly runLease: RuntimeStoreLeaseProof;
  readonly checkpoint: ContextCheckpointWriterV1;
  readonly sessionId: string;
  readonly piSessionRef: string;
  readonly semanticFingerprint: string;
  readonly contextWindow: number;
  /** Default: a fifth of the window, at most 16 384 tokens. */
  readonly reserveTokens?: number;
  /** Messages kept verbatim after the compacted prefix. Default 4. */
  readonly keepRecentMessages?: number;
  /** Without a policy only a pending review holds compaction. */
  readonly policy?: ContextPolicyV1;
  /** Default: the deterministic, model-free summarizer. */
  readonly summarize?: ContextSummaryProviderV1;
  readonly measureTokens?: (messages: readonly AgentMessage[]) => number;
  readonly whenToRead?: string;
  readonly reviewTtlMs?: number;
  /** Told about every result that is not `not_needed`. Must not throw. */
  readonly onResult?: (
    result: ContextPipelineResultV1,
    contextOperationId: string,
  ) => void;
  readonly now?: () => Date;
}

const DEFAULT_KEEP_RECENT_MESSAGES = 4;
const MAX_DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_WHEN_TO_READ =
  "Read these notes before relying on details of the earlier conversation.";

/** Did this operation leave a durable record, so the next one needs a new id? */
function leftARecord(result: ContextPipelineResultV1): boolean {
  return (
    result.status === "compacted" ||
    result.policy !== null ||
    result.memoryCommitRequest !== null
  );
}

export function createGovernedContextPipelineV1(
  options: GovernedContextPipelineOptionsV1,
): PactileContextPipelinePortV1 {
  if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow < 2) {
    throw new RangeError("contextWindow must be a safe integer of at least 2");
  }
  const now = options.now ?? (() => new Date());
  const reserveTokens =
    options.reserveTokens ??
    Math.min(MAX_DEFAULT_RESERVE_TOKENS, Math.floor(options.contextWindow / 5));
  const summarize =
    options.summarize ??
    createDeterministicContextSummarizerV1({
      scope: "run",
      scopeKey: options.session.scopeKey,
    });
  const measureTokens = options.measureTokens ?? estimateContextTokensV1;
  const { session } = options;

  let sequence = 1;
  let last: ContextPipelineResultV1 | null = null;
  let held = false;

  return {
    get lastResult(): ContextPipelineResultV1 | null {
      return last;
    },
    async prepareRequest(request, signal) {
      if (held) return undefined;
      const operation = `${String(options.operationEpoch)}-${String(sequence)}`;
      const contextOperationId = `context-operation-${operation}`;
      const pipeline = new PactileContextPipeline({
        durability: options.host.memory,
        audits: options.host.audits,
        checkpoint: options.checkpoint,
        admissionGate: createRunLedgerContextAdmissionGateV1({
          ledger: options.host.ledger,
          artifacts: options.host.artifacts,
          runId: session.runId,
          ...(options.policy === undefined ? {} : { policy: options.policy }),
          contextOperationId,
          operationEpoch: options.operationEpoch,
          lease: options.runLease,
          now,
        }),
        scope: "run",
        scopeKey: session.scopeKey,
        runId: session.runId,
        semanticFingerprint: options.semanticFingerprint,
        operationEpoch: options.operationEpoch,
        contextOperationId,
        sourceCursor: `${options.sessionId}:${String(request.context.messages.length)}`,
        leaseEpoch: session.memoryLease.epoch,
        lease: session.memoryLease,
        fencingToken: `${session.memoryLease.leaseId}:${String(session.memoryLease.epoch)}`,
        commandId: `command-${operation}`,
        piSessionRef: options.piSessionRef,
        whenToRead: options.whenToRead ?? DEFAULT_WHEN_TO_READ,
        contextWindow: options.contextWindow,
        reserveTokens,
        keepRecentMessages: options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
        measureTokens,
        summarize,
        now,
        onResult: createContextGovernancePipelineReceiptProducerV1({
          ledger: options.host.ledger,
          artifacts: options.host.artifacts,
          workspaceId: options.workspaceId,
          runId: session.runId,
          attemptId: session.attemptId,
          turnId: session.turnId,
          operationEpoch: options.operationEpoch,
          contextOperationId,
          // CDR / CAR artifacts are scoped to the run (the producer checks it);
          // only the memory commit below uses the memory scope key.
          scopeKey: session.runId,
          cdrOperationId: `context-cdr-operation-${operation}`,
          carOperationId: `context-car-operation-${operation}`,
          cdrArtifactId: `cg-cdr-context-${operation}`,
          carArtifactId: `cg-car-context-${operation}`,
          memoryCommit: {
            scope: "run",
            scopeKey: session.scopeKey,
            artifactId: `cg-memory-commit-context-${operation}`,
          },
          lease: options.runLease,
          ...(options.reviewTtlMs === undefined ? {} : { reviewTtlMs: options.reviewTtlMs }),
          now,
        }),
      });
      const update = await pipeline.prepareRequest(request, signal);
      const result = pipeline.lastResult;
      if (result !== null) {
        last = result;
        if (result.policy !== null) held = true;
        if (leftARecord(result)) sequence += 1;
        if (result.status !== "not_needed") options.onResult?.(result, contextOperationId);
      }
      return update;
    },
  };
}
