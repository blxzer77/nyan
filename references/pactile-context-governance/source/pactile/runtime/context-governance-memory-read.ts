import type {
  ContextMemoryDurabilityPort,
  MemoryDurabilityFailureV1,
  MemoryReadRequestV1,
  MemoryReadSuccessV1,
} from "../agent/memory/durability.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import {
  memoryReadFailureStatusV1,
  persistContextGovernanceMemoryFailureV1,
  persistContextGovernanceMemoryV1,
  type MemoryRecordPersistFailureV1,
  type PersistContextGovernanceMemoryFailureResultV1,
  type PersistContextGovernanceMemoryResultV1,
} from "./context-governance-memory.js";
import type { RunLedgerPort } from "./run-ledger.js";

export interface GovernedMemoryReadInputV1 {
  readonly memory: Pick<ContextMemoryDurabilityPort, "read">;
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  /** Only `scope: "run"` is supported: the records bind to one RunLedger. */
  readonly request: MemoryReadRequestV1;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  /**
   * Identifies one logical read attempt. Calling again with the same id is a
   * retry of that attempt (the records are adopted, not rewritten); a new
   * read needs a new id.
   */
  readonly contextOperationId: string;
  readonly restoreTokenRef: string;
  readonly now?: () => Date;
}

type RecordedSuccess = Extract<
  PersistContextGovernanceMemoryResultV1,
  { readonly ok: true }
>;
type RecordedFailure = Extract<
  PersistContextGovernanceMemoryFailureResultV1,
  { readonly ok: true }
>;

export type GovernedMemoryReadResultV1 =
  | {
      readonly ok: true;
      readonly read: MemoryReadSuccessV1;
      readonly recorded: RecordedSuccess;
    }
  | {
      /** The request was rejected before any read or write. */
      readonly ok: false;
      readonly stage: "input";
      readonly message: string;
    }
  | {
      /** The Memory Port refused the read; `record` says what was written. */
      readonly ok: false;
      readonly stage: "read";
      readonly failure: MemoryDurabilityFailureV1;
      readonly record:
        | { readonly kind: "recorded"; readonly result: RecordedFailure }
        | { readonly kind: "not_representable"; readonly reason: string }
        | {
            readonly kind: "record_failed";
            readonly failure: MemoryRecordPersistFailureV1;
          };
    }
  | {
      /**
       * The read succeeded but binding it to the RunLedger failed. The read
       * is returned so the caller can retry the same call: the records are
       * adopted and the read itself is idempotent.
       */
      readonly ok: false;
      readonly stage: "record";
      readonly read: MemoryReadSuccessV1;
      readonly recordFailure: MemoryRecordPersistFailureV1;
    };

/**
 * One governed `memory.read`: ask the Memory Port, then write the structured
 * record of what happened (DisclosureRecord + MemoryReadRecord on success, a
 * MemoryReadRecord with null unverified fields on a representable failure)
 * and bind it to the RunLedger as Context Operations.
 *
 * It never replays a failed read: a refusal is recorded once and returned.
 * Failures that MemoryReadRecordV1 cannot express (store unavailable,
 * corrupt data, ...) are returned unrecorded as `not_representable`.
 */
export async function readGovernedContextMemoryV1(
  input: GovernedMemoryReadInputV1,
): Promise<GovernedMemoryReadResultV1> {
  const { request } = input;
  if (request.scope !== "run") {
    return {
      ok: false,
      stage: "input",
      message: "governed memory reads are bound to a run and need scope=run",
    };
  }
  if (
    typeof input.contextOperationId !== "string" ||
    input.contextOperationId.trim().length === 0
  ) {
    return {
      ok: false,
      stage: "input",
      message: "contextOperationId must be a non-empty string",
    };
  }

  const identity = {
    ledger: input.ledger,
    artifacts: input.artifacts,
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    scopeKey: request.scopeKey,
    version: 1,
    basisRevision: request.basisRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(request.lease === undefined ? {} : { lease: request.lease }),
  };

  const read = await input.memory.read(request);
  if (read.ok) {
    const recorded = await persistContextGovernanceMemoryV1({
      ...identity,
      read,
      restoreTokenRef: input.restoreTokenRef,
      disclosureArtifactId: `cg-disclosure-${input.contextOperationId}`,
      memoryReadArtifactId: `cg-memory-read-${input.contextOperationId}`,
    });
    return recorded.ok
      ? { ok: true, read, recorded }
      : { ok: false, stage: "record", read, recordFailure: recorded };
  }

  if (memoryReadFailureStatusV1(read.code) === null) {
    return {
      ok: false,
      stage: "read",
      failure: read,
      record: {
        kind: "not_representable",
        reason: `memory failure ${read.code} has no MemoryReadRecordV1 status`,
      },
    };
  }
  const recorded = await persistContextGovernanceMemoryFailureV1({
    ...identity,
    request,
    failure: read,
    memoryReadArtifactId: `cg-memory-read-${input.contextOperationId}`,
  });
  return {
    ok: false,
    stage: "read",
    failure: read,
    record: recorded.ok
      ? { kind: "recorded", result: recorded }
      : { kind: "record_failed", failure: recorded },
  };
}
