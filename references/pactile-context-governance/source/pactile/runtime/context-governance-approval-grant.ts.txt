import { fingerprintPactileContractV1 } from "../shared/validation.js";
import {
  artifactIntentIdV1,
  planContextGovernanceArtifactIntentV1,
  plannedArtifactBindingV1,
} from "./context-governance-artifact-intents.js";
import type {
  RunLedgerApprovalRequestV1,
  RunLedgerArtifactIntentV1,
  RunLedgerContextOperationV1,
  RunLedgerGrantRefV1,
} from "./run-ledger.js";
import type { RuntimeStoreJsonObject } from "./store-port.js";

/**
 * The immutable snapshot of an approval decision (contract 01 section 4.9:
 * `authorization.grantRef` is an artifact reference).
 *
 * The RunLedger stays the authority for the decision (contract 4.14: approval
 * results are recorded through the RunLedger / Kernel only). The snapshot is
 * derived from it, written in the same commit as the decision's plan, and is
 * what a later admitted CDR points to. Its content is fixed by the decision,
 * so it never contains the mutable part of an approval (`consumedBy`).
 *
 * Honesty about who decided: a `user` decision made at a terminal is NOT a
 * Kernel fact, and the snapshot says so.
 *
 * This payload schema is a Host definition; it is not yet in the contract
 * document, which still leaves the approval payload to the Host/Kernel track
 * (BL-05). Nothing here makes that track satisfied.
 */
export const APPROVAL_GRANT_SCHEMA_ID_V1 = "pactile.cg.approval-grant" as const;

const GRANT_INTENT_GRACE_MS = 5 * 60_000;

export function approvalGrantArtifactIdV1(approvalRequestId: string): string {
  return `cg-approval-grant-${approvalRequestId}`;
}

export function approvalGrantOperationIdV1(approvalRequestId: string): string {
  return `${approvalRequestId}:approval-grant`;
}

/** The artifact intent that carries a grant; derived, so the Gate can find it. */
export function approvalGrantIntentIdV1(
  runId: string,
  approvalRequestId: string,
): string {
  return artifactIntentIdV1(runId, `approval-grant:${approvalRequestId}`);
}

function hash(domain: string, value: unknown): string {
  return fingerprintPactileContractV1({ domain, value });
}

export interface ApprovalGrantDecisionV1 {
  readonly authority: "user" | "kernel";
  readonly approvalRef: string;
  readonly evidenceRef: string | null;
  readonly followUp: string;
  readonly decidedAt: string;
}

export function buildApprovalGrantRecordV1(input: {
  readonly request: RunLedgerApprovalRequestV1;
  readonly decision: ApprovalGrantDecisionV1;
}): RuntimeStoreJsonObject {
  const { request, decision } = input;
  const body = {
    approvalRequestId: request.approvalRequestId,
    decision: "approved",
    followUp: decision.followUp,
    subject: {
      source: request.subject.source,
      receiptId: request.subject.receiptId,
      payloadHash: request.subject.payloadHash,
      proposal: request.subject.proposal ?? null,
    },
    grantedBy: {
      authority: decision.authority,
      approvalRef: decision.approvalRef,
      evidenceRef: decision.evidenceRef,
      decidedAt: decision.decidedAt,
      attestation:
        decision.authority === "kernel"
          ? { kind: "kernel_command_receipt", kernelFact: true }
          : { kind: "interactive_user_confirmation", kernelFact: false },
    },
  } as unknown as RuntimeStoreJsonObject;
  const bodyHash = hash(`${APPROVAL_GRANT_SCHEMA_ID_V1}:body-v1`, body);
  return {
    schemaId: APPROVAL_GRANT_SCHEMA_ID_V1,
    schemaVersion: 1,
    plane: "runtime",
    runId: request.runId,
    attemptId: request.attemptId,
    turnId: request.turnId,
    operationEpoch: request.operationEpoch,
    // The operation that was held for review.
    contextOperationId: request.contextOperationId,
    bodyHash,
    receiptHash: hash(`${APPROVAL_GRANT_SCHEMA_ID_V1}:receipt-v1`, { bodyHash, body }),
    createdAt: decision.decidedAt,
    provenance: { authority: "host", producer: "pactile-context-review" },
    ...body,
  } as unknown as RuntimeStoreJsonObject;
}

export interface PlannedApprovalGrantV1 {
  readonly intent: RunLedgerArtifactIntentV1;
  readonly grant: RunLedgerGrantRefV1;
}

/**
 * Plan the grant of an approval about to be recorded. Nothing is written: the
 * caller commits `intent` together with the decision, then completes it.
 */
export function planApprovalGrantV1(input: {
  readonly request: RunLedgerApprovalRequestV1;
  readonly decision: ApprovalGrantDecisionV1;
}): PlannedApprovalGrantV1 {
  const { request, decision } = input;
  const record = buildApprovalGrantRecordV1(input);
  const artifactId = approvalGrantArtifactIdV1(request.approvalRequestId);
  const operation: RunLedgerContextOperationV1 = {
    schemaVersion: 1,
    contextOperationId: approvalGrantOperationIdV1(request.approvalRequestId),
    runId: request.runId,
    attemptId: request.attemptId,
    turnId: request.turnId,
    operationEpoch: request.operationEpoch,
    kind: "approval_grant",
    status: "succeeded",
    requestHash: hash("approval-grant-request-v1", {
      approvalRequestId: request.approvalRequestId,
      authority: decision.authority,
      approvalRef: decision.approvalRef,
      followUp: decision.followUp,
    }),
    responseHash: record.receiptHash as string,
    payloadType: APPROVAL_GRANT_SCHEMA_ID_V1,
    payloadHash: record.receiptHash as string,
    // Set below, once the artifact's reference is known.
    payloadArtifactRef: "",
    createdAt: decision.decidedAt,
    completedAt: decision.decidedAt,
  };
  // The reference is a function of the content, so it is known before any byte
  // is written.
  const plan = {
    artifactId,
    scopeKey: request.runId,
    version: 1,
    basisRevision: 0,
    record,
  };
  const binding = plannedArtifactBindingV1(plan);
  const intent = planContextGovernanceArtifactIntentV1({
    intentId: approvalGrantIntentIdV1(request.runId, request.approvalRequestId),
    runId: request.runId,
    records: [plan],
    contextOperations: [{ ...operation, payloadArtifactRef: binding.storageRef }],
    effectBindings: [],
    now: decision.decidedAt,
    abandonAfter: new Date(Date.parse(decision.decidedAt) + GRANT_INTENT_GRACE_MS).toISOString(),
  });  return {
    intent,
    grant: {
      artifactId,
      version: 1,
      contentHash: binding.contentHash,
      storageRef: binding.storageRef,
    },
  };
}
