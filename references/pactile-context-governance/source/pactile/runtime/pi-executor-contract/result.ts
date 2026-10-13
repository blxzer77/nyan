import { PACTILE_CONTRACT_SCHEMA_VERSION } from "../../shared/validation.js";
import { requireTextV1, freezeWriteSetV1 } from "./helpers.js";
import type { PiExecutorRunResultInputV1, PiExecutorRunResultV1 } from "./types.js";

export function buildPiExecutorRunResultV1(
  input: PiExecutorRunResultInputV1,
): PiExecutorRunResultV1 {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new TypeError("epoch must be a non-negative safe integer");
  }
  const writeSet = freezeWriteSetV1(input.writeSet, "writeSet");
  if (
    !Number.isSafeInteger(input.envelopeErrorCount) ||
    input.envelopeErrorCount < 0
  ) {
    throw new TypeError("envelopeErrorCount must be a non-negative safe integer");
  }
  const decision = input.decision;
  return Object.freeze({
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    resultId: requireTextV1(input.resultId, "resultId"),
    workItemId: requireTextV1(input.workItemId, "workItemId"),
    blockId: requireTextV1(input.blockId, "blockId"),
    runId: input.runId === null ? null : requireTextV1(input.runId, "runId"),
    requestId: requireTextV1(input.requestId, "requestId"),
    requestHash: requireTextV1(input.requestHash, "requestHash"),
    piSessionId: requireTextV1(input.piSessionId, "piSessionId"),
    piOperationId: requireTextV1(input.piOperationId, "piOperationId"),
    epoch: input.epoch,
    semanticFingerprint: requireTextV1(
      input.semanticFingerprint,
      "semanticFingerprint",
    ),
    // An identity fact that was never established stays an explicit empty
    // string on a rejected attempt; a decoded Run Result refuses that shape
    // once the binding was admitted.
    repositoryRoot:
      typeof input.repositoryRoot === "string" ? input.repositoryRoot : "",
    hostWorkspaceRoot:
      input.hostWorkspaceRoot === null
        ? null
        : requireTextV1(input.hostWorkspaceRoot, "hostWorkspaceRoot"),
    baseSha:
      typeof input.baseSha === "string"
        ? input.baseSha.toLowerCase()
        : "",
    writeSet,
    observedWriteSet: Object.freeze([...input.observedWriteSet]),
    bindingOutcome: input.bindingOutcome,
    bindingReason: input.bindingReason,
    hostKind: input.hostKind,
    hostBound: input.hostBound,
    piStatus: input.piStatus,
    outcome: decision.outcome,
    reason: decision.reason,
    retryable: decision.retryable,
    nativeReceiptAuthoritative: decision.nativeReceiptAuthoritative,
    terminalStatus: input.terminal === null ? null : input.terminal.status,
    terminalReceiptId: input.terminal === null ? null : input.terminal.receiptId,
    terminalEffectsKnown:
      input.terminal === null ? null : input.terminal.effectsKnown,
    evidenceAccepted: input.evidenceAccepted,
    gateAccepted: input.gateAccepted,
    settled: input.settled,
    workItemCompleted: false as const,
    idempotencyKey: requireTextV1(input.idempotencyKey, "idempotencyKey"),
    attemptDisposition: input.attemptDisposition,
    supersedesResultId:
      input.supersedesResultId === null
        ? null
        : requireTextV1(input.supersedesResultId, "supersedesResultId"),
    envelopeFingerprints: Object.freeze([...input.envelopeFingerprints]),
    envelopeErrorCount: input.envelopeErrorCount,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
