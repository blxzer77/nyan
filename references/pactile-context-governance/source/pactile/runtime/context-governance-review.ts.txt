import type {
  PactileContextAdmissionGateV1,
  PactileContextAdmissionV1,
} from "../agent/context-pipeline.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import type { ProductKernelStorePort } from "../kernel/store/product/index.js";
import { fingerprintPactileContractV1 } from "../shared/validation.js";
import {
  approvalGrantIntentIdV1,
  planApprovalGrantV1,
} from "./context-governance-approval-grant.js";
import { completeContextGovernanceArtifactIntentV1 } from "./context-governance-artifact-intents.js";
import { bindContextGovernanceReceiptV1 } from "./context-governance-receipts.js";
import type {
  EffectLedgerEntryV1,
  RunLedgerApprovalRequestV1,
  RunLedgerArtifactIntentV1,
  RunLedgerPort,
  RunLedgerReviewFollowUpV1,
  RunLedgerReviewProposalV1,
  RunLedgerV1,
} from "./run-ledger.js";
import type {
  RuntimeStoreJsonObject,
  RuntimeStoreLeaseProof,
} from "./store-port.js";
import { runtimeRequestHashV1 } from "./store-port.js";

/**
 * Host side of the `review_required` path (contract 01 section 4.14).
 *
 *   review verdict -> approval request in the RunLedger (the operation waits)
 *   -> human / Kernel approval command -> approved | rejected | expired
 *   -> approved proposals need a NEW admission (new operation id, later epoch);
 *      an already executed compaction (CAR) only picks restore / expand / block
 *   -> rejected or expired: blocked, the existing Context is kept
 *
 * Nothing here is reachable from the model: there is no Agent tool for it, a
 * decision needs a `user` or `kernel` authority, and its approvalRef must
 * resolve to a durable Kernel command receipt.
 */

export type ContextReviewFailureCodeV1 =
  | "input_invalid"
  | "ledger_missing"
  | "not_found"
  | "conflict"
  | "self_approval_refused"
  | "approval_unverified"
  | "expired"
  | "already_resolved"
  | "not_approved"
  | "already_consumed"
  | "admission_invalid"
  | "ledger_binding_failed";

export type ContextReviewResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly request: RunLedgerApprovalRequestV1;
      readonly ledger: RunLedgerV1;
      /**
       * Set for an approval: whether its grant artifact is written and bound.
       * When false the decision stands and the grant is a pending artifact
       * intent that a reconciler or the next admission finishes.
       */
      readonly grantBound?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ContextReviewFailureCodeV1;
      readonly message: string;
      /** Set when the refusal itself durably moved the request (expiry). */
      readonly request?: RunLedgerApprovalRequestV1;
    };

function refuse(
  code: ContextReviewFailureCodeV1,
  message: string,
  request?: RunLedgerApprovalRequestV1,
): ContextReviewResultV1 {
  return request === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, request };
}

/** Proves an approvalRef is a real, durable Kernel command. */
export interface ContextReviewApprovalVerifierV1 {
  verify(
    approvalRef: string,
  ): Promise<
    | { readonly ok: true; readonly recordedAt: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

/**
 * The Kernel owns the fact that an approval command happened: the ref must be
 * the id of an applied Product Kernel command receipt. (The Kernel work model
 * has no approval fact type yet; this binds to the command ledger it does
 * have rather than inventing a second approval store.)
 */
export function createKernelApprovalVerifierV1(
  kernel: Pick<ProductKernelStorePort, "readCommandReceipt">,
): ContextReviewApprovalVerifierV1 {
  return {
    verify: async (approvalRef) => {
      try {
        const receipt = await kernel.readCommandReceipt(approvalRef);
        if (receipt === null) {
          return { ok: false, reason: "no Kernel command receipt for this approvalRef" };
        }
        return { ok: true, recordedAt: receipt.recordedAt };
      } catch {
        return { ok: false, reason: "the Kernel command ledger could not be read" };
      }
    },
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function contextReviewIdV1(runId: string, contextOperationId: string): string {
  return `context-review-${fingerprintPactileContractV1({
    domain: "context-review-v1",
    runId,
    contextOperationId,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
}

/** Context Operation state implied by a review (contract: waiting / blocked). */
export function contextOperationStateForReviewV1(
  request: RunLedgerApprovalRequestV1,
): "waiting" | "blocked" | "review_approved" {
  return request.state === "pending"
    ? "waiting"
    : request.state === "approved"
      ? "review_approved"
      : "blocked";
}

export function pendingContextReviewsV1(
  ledger: RunLedgerV1,
): readonly RunLedgerApprovalRequestV1[] {
  return (ledger.approvalRequests ?? []).filter(
    (request) => request.state === "pending",
  );
}

interface LedgerChangeInput {
  readonly ledger: RunLedgerPort;
  readonly runId: string;
  readonly lease?: RuntimeStoreLeaseProof;
}

/** Commit a change to `approvalRequests` as the next ledger revision. */
async function commitApprovalChange(
  input: LedgerChangeInput & {
    readonly snapshot: { readonly ledger: RunLedgerV1; readonly effects: readonly EffectLedgerEntryV1[] };
    readonly next: readonly RunLedgerApprovalRequestV1[];
    readonly action: string;
    readonly subjectId: string;
    readonly now: string;
    /** Plans made durable in the same commit as the change that justifies them. */
    readonly intents?: readonly RunLedgerArtifactIntentV1[];
  },
): Promise<
  | { readonly ok: true; readonly applied: boolean; readonly ledger: RunLedgerV1 }
  | { readonly ok: false; readonly message: string }
> {
  const { ledger } = input.snapshot;
  const intents = input.intents ?? [];
  const nextLedger: RunLedgerV1 = {
    ...ledger,
    approvalRequests: input.next,
    ...(intents.length === 0
      ? {}
      : { artifactIntents: [...(ledger.artifactIntents ?? []), ...intents] }),
    commitId: `${ledger.commitId}:approval:${input.action}:${input.subjectId}`,
    revision: ledger.revision + 1,
    updatedAt: input.now,
  };
  try {
    const committed = await input.ledger.commitRunLedger({
      idempotencyKey: `pactile-ledger-approval:${input.action}:${input.subjectId}`,
      requestHash: runtimeRequestHashV1("run-ledger.approval", {
        action: input.action,
        subjectId: input.subjectId,
        next: input.next as unknown as RuntimeStoreJsonObject[],
        intents: intents as unknown as RuntimeStoreJsonObject[],
        expectedRevision: ledger.revision,
      }),
      ledger: nextLedger,
      effects: input.snapshot.effects,
      ...(input.lease === undefined ? {} : { lease: input.lease }),
    });
    return { ok: true, applied: committed.applied, ledger: committed.ledger };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "RunLedger approval change failed",
    };
  }
}

function replaceRequest(
  requests: readonly RunLedgerApprovalRequestV1[],
  next: RunLedgerApprovalRequestV1,
): readonly RunLedgerApprovalRequestV1[] {
  return requests.map((request) =>
    request.approvalRequestId === next.approvalRequestId ? next : request,
  );
}

export interface OpenContextReviewInputV1 extends LedgerChangeInput {
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  /** The operation that is held; a new admission must use a different id. */
  readonly contextOperationId: string;
  readonly subject: RunLedgerApprovalRequestV1["subject"];
  readonly expiresAt: string;
  readonly now?: () => Date;
}

/** Hold a Context Operation for review. Idempotent per held operation. */
export async function openContextReviewV1(
  input: OpenContextReviewInputV1,
): Promise<ContextReviewResultV1> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  try {
    text(input.runId, "runId");
    text(input.attemptId, "attemptId");
    text(input.turnId, "turnId");
    text(input.contextOperationId, "contextOperationId");
    text(input.subject.receiptId, "subject.receiptId");
    if (!Number.isSafeInteger(input.operationEpoch) || input.operationEpoch < 1)
      throw new TypeError("operationEpoch must be a positive safe integer");
    if (!["cdq", "cdr", "car"].includes(input.subject.source))
      throw new TypeError("subject.source is invalid");
    if (
      Number.isNaN(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.parse(now)
    )
      throw new TypeError("expiresAt must be a future RFC 3339 timestamp");
  } catch (error) {
    return refuse(
      "input_invalid",
      error instanceof Error ? error.message : "review input is invalid",
    );
  }
  const snapshot = await input.ledger.readRunLedger(input.runId);
  if (snapshot === null) return refuse("ledger_missing", "RunLedger does not exist");
  const approvalRequestId = contextReviewIdV1(input.runId, input.contextOperationId);
  const existing = snapshot.ledger.approvalRequests ?? [];
  const prior = existing.find((request) => request.approvalRequestId === approvalRequestId);
  const request: RunLedgerApprovalRequestV1 = {
    schemaVersion: 1,
    approvalRequestId,
    kind: "context_operation_review",
    runId: input.runId,
    attemptId: input.attemptId,
    turnId: input.turnId,
    operationEpoch: input.operationEpoch,
    contextOperationId: input.contextOperationId,
    subject: input.subject,
    state: "pending",
    requestedAt: prior?.requestedAt ?? now,
    expiresAt: prior?.expiresAt ?? input.expiresAt,
    resolution: null,
  };
  if (prior !== undefined) {
    const sameHeld =
      JSON.stringify({ ...prior, state: null, resolution: null, expiresAt: null }) ===
      JSON.stringify({ ...request, state: null, resolution: null, expiresAt: null });
    return sameHeld
      ? { ok: true, applied: false, request: prior, ledger: snapshot.ledger }
      : refuse("conflict", "this operation is already held for a different review", prior);
  }
  const changed = await commitApprovalChange({
    ...input,
    snapshot,
    next: [...existing, request],
    action: "open",
    subjectId: approvalRequestId,
    now,
  });
  return changed.ok
    ? { ok: true, applied: changed.applied, request, ledger: changed.ledger }
    : refuse("ledger_binding_failed", changed.message);
}

export interface OpenContextReviewForReceiptInputV1 extends LedgerChangeInput {
  /** A persisted CDR or CAR payload whose verdict is `review_required`. */
  readonly receipt: RuntimeStoreJsonObject;
  readonly effect: EffectLedgerEntryV1;
  /** The exact range the review is about; an approval authorizes only this. */
  readonly proposal?: RunLedgerReviewProposalV1;
  readonly expiresAt: string;
  readonly now?: () => Date;
}

/** Open the review a CDR / CAR with `verdict = review_required` calls for. */
export async function openContextReviewForReceiptV1(
  input: OpenContextReviewForReceiptInputV1,
): Promise<ContextReviewResultV1> {
  let binding;
  try {
    binding = bindContextGovernanceReceiptV1({
      receipt: input.receipt,
      effect: input.effect,
    });
  } catch (error) {
    return refuse(
      "input_invalid",
      error instanceof Error ? error.message : "context receipt is invalid",
    );
  }
  const receipt = input.receipt as Record<string, unknown>;
  if (
    (binding.kind !== "cdr" && binding.kind !== "car") ||
    receipt.verdict !== "review_required"
  ) {
    return refuse(
      "input_invalid",
      "only a CDR or CAR with verdict review_required opens a review",
    );
  }
  if (receipt.runId !== input.runId) {
    return refuse("input_invalid", "the receipt belongs to a different run");
  }
  return openContextReviewV1({
    ledger: input.ledger,
    runId: input.runId,
    attemptId: receipt.attemptId as string,
    turnId: receipt.turnId as string,
    operationEpoch: receipt.operationEpoch as number,
    contextOperationId: receipt.contextOperationId as string,
    subject: {
      source: binding.kind,
      receiptId: binding.receiptId,
      payloadHash: binding.receiptHash,
      manifestRef: null,
      ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
    },
    expiresAt: input.expiresAt,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
}

export interface ResolveContextReviewInputV1 extends LedgerChangeInput {
  /** Where the grant snapshot of an approval is written. */
  readonly artifacts: ArtifactStorePort;
  readonly approvalRequestId: string;
  readonly decision: "approve" | "reject";
  /** Must be `user` or `kernel`. Anything else is a refused self-approval. */
  readonly authority: string;
  /** Id of the Kernel approval command. */
  readonly approvalRef: string;
  readonly evidenceRef?: string | null;
  /** Required for a CAR review: `restore`, `expand` or `block`. */
  readonly followUp?: RunLedgerReviewFollowUpV1;
  readonly verifier: ContextReviewApprovalVerifierV1;
  readonly now?: () => Date;
}

async function expireOverdue(
  input: LedgerChangeInput,
  snapshot: { readonly ledger: RunLedgerV1; readonly effects: readonly EffectLedgerEntryV1[] },
  now: string,
  only?: string,
): Promise<
  | { readonly ok: true; readonly expired: readonly RunLedgerApprovalRequestV1[]; readonly ledger: RunLedgerV1 }
  | { readonly ok: false; readonly message: string }
> {
  const requests = snapshot.ledger.approvalRequests ?? [];
  const overdue = requests.filter(
    (request) =>
      request.state === "pending" &&
      Date.parse(request.expiresAt) <= Date.parse(now) &&
      (only === undefined || request.approvalRequestId === only),
  );
  if (overdue.length === 0) {
    return { ok: true, expired: [], ledger: snapshot.ledger };
  }
  const expired = overdue.map((request) => ({ ...request, state: "expired" as const }));
  const changed = await commitApprovalChange({
    ...input,
    snapshot,
    next: requests.map((request) => expired.find((entry) => entry.approvalRequestId === request.approvalRequestId) ?? request),
    action: "expire",
    subjectId: overdue.map((request) => request.approvalRequestId).join("+"),
    now,
  });
  return changed.ok
    ? { ok: true, expired, ledger: changed.ledger }
    : { ok: false, message: changed.message };
}

/** Approve or reject a pending review. */
export async function resolveContextReviewV1(
  input: ResolveContextReviewInputV1,
): Promise<ContextReviewResultV1> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  if (input.authority !== "user" && input.authority !== "kernel") {
    return refuse(
      "self_approval_refused",
      "only a user or the Kernel may decide a review; a Controller, provider, model or evaluation run cannot",
    );
  }
  const authority: "user" | "kernel" = input.authority;
  try {
    text(input.approvalRef, "approvalRef");
    text(input.approvalRequestId, "approvalRequestId");
    if (input.decision !== "approve" && input.decision !== "reject")
      throw new TypeError("decision must be approve or reject");
  } catch (error) {
    return refuse(
      "input_invalid",
      error instanceof Error ? error.message : "review decision is invalid",
    );
  }
  const snapshot = await input.ledger.readRunLedger(input.runId);
  if (snapshot === null) return refuse("ledger_missing", "RunLedger does not exist");
  const requests = snapshot.ledger.approvalRequests ?? [];
  const request = requests.find((entry) => entry.approvalRequestId === input.approvalRequestId);
  if (request === undefined) return refuse("not_found", "no such approval request");

  const wantedState = input.decision === "approve" ? "approved" : "rejected";
  if (request.state !== "pending") {
    if (request.state !== wantedState || request.resolution?.approvalRef !== input.approvalRef) {
      return refuse("already_resolved", `the request is already ${request.state}`, request);
    }
    // A replay of the same decision also finishes a grant a crash left pending.
    const grantBound =
      request.state === "approved" && request.resolution.grant !== undefined
        ? await finishGrant(input, request)
        : undefined;
    return {
      ok: true,
      applied: false,
      request,
      ledger: (await input.ledger.readRunLedger(input.runId))?.ledger ?? snapshot.ledger,
      ...(grantBound === undefined ? {} : { grantBound }),
    };
  }
  if (Date.parse(request.expiresAt) <= Date.parse(now)) {
    const expired = await expireOverdue(input, snapshot, now, request.approvalRequestId);
    if (!expired.ok) return refuse("ledger_binding_failed", expired.message);
    return refuse(
      "expired",
      "the review expired before a decision; the held operation stays blocked",
      expired.expired[0],
    );
  }
  const verified = await input.verifier.verify(input.approvalRef);
  if (!verified.ok) return refuse("approval_unverified", verified.reason);

  let followUp: RunLedgerReviewFollowUpV1;
  if (input.decision === "reject") {
    followUp = "block";
  } else if (request.subject.source === "car") {
    if (
      input.followUp !== "restore" &&
      input.followUp !== "expand" &&
      input.followUp !== "block"
    ) {
      return refuse(
        "input_invalid",
        "a review of an executed compaction can only choose restore, expand or block",
      );
    }
    followUp = input.followUp;
  } else {
    if (input.followUp !== undefined && input.followUp !== "new_admission") {
      return refuse(
        "input_invalid",
        "an approved proposal that has not run needs a new admission",
      );
    }
    followUp = "new_admission";
  }
  const decision = {
    authority,
    approvalRef: input.approvalRef,
    evidenceRef: input.evidenceRef ?? null,
    followUp,
    decidedAt: now,
  };
  // An approval carries an immutable snapshot of itself. Its plan is made
  // durable in the SAME commit as the decision, so the plan exists exactly
  // when the decision does; the bytes follow.
  let planned: ReturnType<typeof planApprovalGrantV1> | null = null;
  if (input.decision === "approve") {
    try {
      planned = planApprovalGrantV1({ request, decision });
    } catch (error) {
      return refuse(
        "input_invalid",
        error instanceof Error ? error.message : "the approval grant could not be planned",
      );
    }
  }
  const resolved: RunLedgerApprovalRequestV1 = {
    ...request,
    state: wantedState,
    resolution: {
      ...decision,
      consumedBy: null,
      ...(planned === null ? {} : { grant: planned.grant }),
    },
  };
  const changed = await commitApprovalChange({
    ...input,
    snapshot,
    next: replaceRequest(requests, resolved),
    action: input.decision,
    subjectId: request.approvalRequestId,
    now,
    ...(planned === null ? {} : { intents: [planned.intent] }),
  });
  if (!changed.ok) return refuse("ledger_binding_failed", changed.message);
  const grantBound = planned === null ? undefined : await finishGrant(input, resolved);
  return {
    ok: true,
    applied: changed.applied,
    request: resolved,
    ledger: changed.ledger,
    ...(grantBound === undefined ? {} : { grantBound }),
  };
}

/** Write the grant snapshot and bind it. False leaves a pending intent for later. */
async function finishGrant(
  input: {
    readonly ledger: RunLedgerPort;
    readonly artifacts: ArtifactStorePort;
    readonly runId: string;
    readonly lease?: RuntimeStoreLeaseProof;
  },
  request: RunLedgerApprovalRequestV1,
): Promise<boolean> {
  try {
    const done = await completeContextGovernanceArtifactIntentV1({
      ledger: input.ledger,
      artifacts: input.artifacts,
      runId: input.runId,
      intentId: approvalGrantIntentIdV1(input.runId, request.approvalRequestId),
      ...(input.lease === undefined ? {} : { lease: input.lease }),
    });
    return done.ok;
  } catch {
    return false;
  }
}

/** Move every overdue pending review to `expired` (the operation stays blocked). */
export async function expireContextReviewsV1(
  input: LedgerChangeInput & { readonly now?: () => Date },
): Promise<
  | { readonly ok: true; readonly expired: readonly RunLedgerApprovalRequestV1[]; readonly ledger: RunLedgerV1 }
  | { readonly ok: false; readonly code: ContextReviewFailureCodeV1; readonly message: string }
> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  let snapshot: Awaited<ReturnType<RunLedgerPort["readRunLedger"]>>;
  try {
    snapshot = await input.ledger.readRunLedger(input.runId);
  } catch {
    return {
      ok: false,
      code: "ledger_binding_failed",
      message: "RunLedger could not be read",
    };
  }
  if (snapshot === null) {
    return { ok: false, code: "ledger_missing", message: "RunLedger does not exist" };
  }
  const result = await expireOverdue(input, snapshot, now);
  return result.ok
    ? result
    : { ok: false, code: "ledger_binding_failed", message: result.message };
}

export interface AdmitReviewedContextOperationInputV1 extends LedgerChangeInput {
  readonly approvalRequestId: string;
  /** The new operation. It cannot reuse the id that was held. */
  readonly newContextOperationId: string;
  /** Must be later than the epoch the held operation ran under. */
  readonly newOperationEpoch: number;
  readonly now?: () => Date;
}

/**
 * Spend an approved `new_admission` on one new operation. The approval
 * authorizes exactly one such admission; it does not execute anything.
 */
export async function admitReviewedContextOperationV1(
  input: AdmitReviewedContextOperationInputV1,
): Promise<ContextReviewResultV1> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const snapshot = await input.ledger.readRunLedger(input.runId);
  if (snapshot === null) return refuse("ledger_missing", "RunLedger does not exist");
  const requests = snapshot.ledger.approvalRequests ?? [];
  const request = requests.find((entry) => entry.approvalRequestId === input.approvalRequestId);
  if (request === undefined) return refuse("not_found", "no such approval request");
  if (request.state !== "approved" || request.resolution?.followUp !== "new_admission") {
    return refuse("not_approved", "only an approved new admission can be admitted", request);
  }
  try {
    text(input.newContextOperationId, "newContextOperationId");
  } catch (error) {
    return refuse("input_invalid", error instanceof Error ? error.message : "invalid id");
  }
  if (
    input.newContextOperationId === request.contextOperationId ||
    !Number.isSafeInteger(input.newOperationEpoch) ||
    input.newOperationEpoch <= request.operationEpoch
  ) {
    return refuse(
      "admission_invalid",
      "a new admission needs a new contextOperationId and a later operationEpoch",
      request,
    );
  }
  const consumedBy = request.resolution.consumedBy;
  if (consumedBy !== null) {
    return consumedBy === input.newContextOperationId
      ? { ok: true, applied: false, request, ledger: snapshot.ledger }
      : refuse("already_consumed", "this approval already authorized another admission", request);
  }
  const spent: RunLedgerApprovalRequestV1 = {
    ...request,
    resolution: { ...request.resolution, consumedBy: input.newContextOperationId },
  };
  const changed = await commitApprovalChange({
    ...input,
    snapshot,
    next: replaceRequest(requests, spent),
    action: "admit",
    subjectId: `${request.approvalRequestId}:${input.newContextOperationId}`,
    now,
  });
  return changed.ok
    ? { ok: true, applied: changed.applied, request: spent, ledger: changed.ledger }
    : refuse("ledger_binding_failed", changed.message);
}

/**
 * The pipeline's admission gate over a RunLedger: no new compaction while a
 * review is pending. Overdue reviews are expired first; if that cannot be
 * made durable, or the ledger cannot be read, the gate stays closed.
 */
export function createRunLedgerContextReviewGateV1(
  options: LedgerChangeInput & { readonly now?: () => Date },
): PactileContextAdmissionGateV1 {
  return {
    check: async (): Promise<PactileContextAdmissionV1> => {
      const expired = await expireContextReviewsV1(options);
      if (!expired.ok) {
        return { allowed: false, reason: "context_review_gate_unavailable" };
      }
      const pending = pendingContextReviewsV1(expired.ledger);
      return pending.length === 0
        ? { allowed: true }
        : { allowed: false, reason: "context_review_pending" };
    },
  };
}
