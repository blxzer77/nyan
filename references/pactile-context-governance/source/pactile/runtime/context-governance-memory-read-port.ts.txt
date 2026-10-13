import type {
  AgentTool,
} from "../agent/pi/types.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import type {
  ContextMemoryDurabilityPort,
  MemoryLeaseProofV1,
} from "../agent/memory/durability.js";
import {
  createPactileMemoryReadTool,
  PACTILE_MEMORY_READ_TOOL_NAME_V1,
  type PACTILE_MEMORY_READ_PARAMETERS_V1,
  type PactileGovernedMemoryReadPortV1,
  type PactileMemoryReadOutcomeV1,
  type PactileMemoryReadToolDetailsV1,
} from "../agent/memory/read-tool.js";
import { createPactileEffectIntentV1 } from "../agent/effects/contract.js";
import { readGovernedContextMemoryV1 } from "./context-governance-memory-read.js";
import type { RunLedgerPort } from "./run-ledger.js";

export interface GovernedMemoryReadPortOptionsV1 {
  readonly memory: Pick<ContextMemoryDurabilityPort, "read">;
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  /** Fixed by the Host. The model cannot choose the memory scope. */
  readonly scopeKey: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly operationEpoch: number;
  /** The memory-partition lease proof, or a getter when it is re-acquired. */
  readonly lease?: MemoryLeaseProofV1 | (() => MemoryLeaseProofV1 | undefined);
  /** Default to the RunLedger's active attempt / turn at call time. */
  readonly attemptId?: string;
  readonly turnId?: string;
  readonly now?: () => Date;
}

/**
 * The Context Operation id of one tool call: derived from the same
 * run + toolCallId pair as the effect id, so the effect receipt and the
 * Context Operations of one `memory_read` call can be matched.
 */
export function memoryReadContextOperationIdV1(
  runId: string,
  toolCallId: string,
  operationEpoch: number,
): string {
  const intent = createPactileEffectIntentV1({
    runId,
    toolCallId,
    toolName: PACTILE_MEMORY_READ_TOOL_NAME_V1,
    args: null,
    operationEpoch,
  });
  return `memory-read-${intent.effectId}`;
}

/**
 * Host implementation of the Agent's `memory_read` port. Facts are only
 * handed to the model after the read has been recorded in the RunLedger
 * (audit before disclosure); a read that could not be recorded is reported
 * without its facts.
 */
export function createGovernedMemoryReadPortV1(
  options: GovernedMemoryReadPortOptionsV1,
): PactileGovernedMemoryReadPortV1 {
  return {
    read: async (input): Promise<PactileMemoryReadOutcomeV1> => {
      const contextOperationId = memoryReadContextOperationIdV1(
        options.runId,
        input.toolCallId,
        options.operationEpoch,
      );
      const refuse = (
        stage: "input" | "read" | "record",
        code: string,
        message: string,
        recording: "recorded" | "not_representable" | "record_failed" | "none",
      ): PactileMemoryReadOutcomeV1 => ({
        ok: false,
        contextOperationId,
        stage,
        code,
        message,
        recording,
      });
      if (input.signal?.aborted === true) {
        return refuse("input", "cancelled", "the tool call was aborted before the read started", "none");
      }
      const snapshot = await options.ledger.readRunLedger(options.runId);
      if (snapshot === null) {
        return refuse("input", "ledger_missing", "the run has no RunLedger to record the read in", "none");
      }
      const attemptId = options.attemptId ?? snapshot.ledger.activeAttemptId;
      const turnId = options.turnId ?? snapshot.ledger.activeTurnId;
      if (attemptId === null || turnId === null) {
        return refuse("input", "no_active_turn", "the RunLedger has no active attempt or turn", "none");
      }
      const lease =
        typeof options.lease === "function" ? options.lease() : options.lease;

      const governed = await readGovernedContextMemoryV1({
        memory: options.memory,
        ledger: options.ledger,
        artifacts: options.artifacts,
        request: {
          scope: "run",
          scopeKey: options.scopeKey,
          basisRevision: input.basisRevision,
          acknowledgeDisclosure: input.acknowledgeDisclosure,
          ...(lease === undefined ? {} : { lease }),
        },
        workspaceId: options.workspaceId,
        runId: options.runId,
        attemptId,
        turnId,
        operationEpoch: options.operationEpoch,
        contextOperationId,
        restoreTokenRef: `restore-${contextOperationId}`,
        ...(options.now === undefined ? {} : { now: options.now }),
      });

      if (governed.ok) {
        const { read } = governed;
        return {
          ok: true,
          contextOperationId,
          basisRevision: read.basisRevision,
          manifestRevision: read.manifestRevision,
          contentHash: read.contentHash,
          disclosure: {
            path: read.disclosure.path,
            fingerprint: read.disclosure.fingerprint,
            whenToRead: read.disclosure.whenToRead,
          },
          facts: read.facts.map((fact) => ({
            factId: fact.factId,
            statement: fact.statement,
            tags: fact.tags,
            factHash: fact.factHash,
          })),
          summaries: read.summaries.map((summary) => ({
            summaryId: summary.summaryId,
            statement: summary.statement,
            derivedFrom: summary.derivedFrom,
          })),
        };
      }
      if (governed.stage === "input") {
        return refuse("input", "input_invalid", governed.message, "none");
      }
      if (governed.stage === "record") {
        return refuse(
          "record",
          governed.recordFailure.code,
          governed.recordFailure.message,
          "record_failed",
        );
      }
      return refuse(
        "read",
        governed.failure.code,
        governed.failure.message,
        governed.record.kind,
      );
    },
  };
}

/** The `memory_read` tool wired to one run's Host-owned memory and ledger. */
export function createGovernedMemoryReadToolV1(
  options: GovernedMemoryReadPortOptionsV1,
): AgentTool<
  typeof PACTILE_MEMORY_READ_PARAMETERS_V1,
  PactileMemoryReadToolDetailsV1
> {
  return createPactileMemoryReadTool(createGovernedMemoryReadPortV1(options));
}
