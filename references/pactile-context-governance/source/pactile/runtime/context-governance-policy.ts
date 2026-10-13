import type {
  PactileContextAdmissionGateV1,
  PactileContextAdmissionV1,
  PactileContextPolicyDecisionV1,
  PactileContextProposalV1,
} from "../agent/context-pipeline.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import { approvalGrantIntentIdV1 } from "./context-governance-approval-grant.js";
import { completeContextGovernanceArtifactIntentV1 } from "./context-governance-artifact-intents.js";
import {
  admitReviewedContextOperationV1,
  expireContextReviewsV1,
  pendingContextReviewsV1,
} from "./context-governance-review.js";
import type { RunLedgerPort, RunLedgerApprovalRequestV1 } from "./run-ledger.js";
import type { RuntimeStoreLeaseProof } from "./store-port.js";

/**
 * Minimal deterministic Policy Gate for the native Context pipeline
 * (contract 01 section 4.8 / 4.14: the Host decides admission, not the
 * Controller or a model). It judges one proposal and answers allow, review or
 * deny. Nothing here consults a provider or a model.
 */

export const CONTEXT_POLICY_RULE_IDS_V1 = Object.freeze({
  /** Contract section 5: `drop` and lossy actions are not open in v1. */
  actionNotOpen: "cg-policy.action-not-open",
  largePrefixReview: "cg-policy.large-prefix-review",
  highContextReview: "cg-policy.high-context-review",
});

export type ContextPolicyEvaluationV1 =
  | { readonly verdict: "allow" }
  | PactileContextPolicyDecisionV1;

export interface ContextPolicyV1 {
  readonly policyVersion: string;
  evaluate(proposal: PactileContextProposalV1): ContextPolicyEvaluationV1;
}

export interface ThresholdContextPolicyOptionsV1 {
  /** Recorded in every receipt this policy produces. */
  readonly policyVersion?: string;
  /** A compaction replacing at least this many messages needs a review. */
  readonly reviewWhenPrefixMessagesAtLeast?: number;
  /** A compaction triggered at or above this many tokens needs a review. */
  readonly reviewWhenContextTokensAtLeast?: number;
}

function threshold(value: number | undefined, label: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * The stock policy. With no threshold configured it allows every reversible
 * `externalize` proposal (the behaviour before a Policy Gate existed). The
 * action rule is not configurable: whatever the thresholds say, a proposal
 * that is not a reversible `externalize` is denied.
 */
export function createThresholdContextPolicyV1(
  options: ThresholdContextPolicyOptionsV1 = {},
): ContextPolicyV1 {
  const policyVersion = options.policyVersion ?? "context-policy-threshold-v1";
  const prefixLimit = threshold(
    options.reviewWhenPrefixMessagesAtLeast,
    "reviewWhenPrefixMessagesAtLeast",
  );
  const tokenLimit = threshold(
    options.reviewWhenContextTokensAtLeast,
    "reviewWhenContextTokensAtLeast",
  );
  return Object.freeze({
    policyVersion,
    evaluate: (proposal: PactileContextProposalV1): ContextPolicyEvaluationV1 => {
      if (proposal.action !== "externalize" || proposal.effectClass !== "reversible") {
        return {
          verdict: "deny",
          policyVersion,
          ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.actionNotOpen],
          reason: `action ${String(proposal.action)} (${String(proposal.effectClass)}) is not open in v1`,
        };
      }
      const ruleIds: string[] = [];
      const reasons: string[] = [];
      if (prefixLimit !== null && proposal.prefixMessageCount >= prefixLimit) {
        ruleIds.push(CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview);
        reasons.push(
          `${String(proposal.prefixMessageCount)} messages would be replaced (limit ${String(prefixLimit)})`,
        );
      }
      if (tokenLimit !== null && proposal.contextTokens >= tokenLimit) {
        ruleIds.push(CONTEXT_POLICY_RULE_IDS_V1.highContextReview);
        reasons.push(
          `context is ${String(proposal.contextTokens)} tokens (limit ${String(tokenLimit)})`,
        );
      }
      return ruleIds.length === 0
        ? { verdict: "allow" }
        : { verdict: "review", policyVersion, ruleIds, reason: reasons.join("; ") };
    },
  });
}

export interface RunLedgerContextAdmissionGateOptionsV1 {
  readonly ledger: RunLedgerPort;
  /** Where an approval's grant snapshot is read back and, if a crash left it pending, finished. */
  readonly artifacts: ArtifactStorePort;
  readonly runId: string;
  /** Without a policy the gate only holds compaction while a review is pending. */
  readonly policy?: ContextPolicyV1;
  /** The operation this gate admits; an approval can only be spent by another one. */
  readonly contextOperationId: string;
  readonly operationEpoch: number;
  readonly lease?: RuntimeStoreLeaseProof;
  readonly now?: () => Date;
}

function spendable(
  request: RunLedgerApprovalRequestV1,
  options: RunLedgerContextAdmissionGateOptionsV1,
  validCuts: readonly { readonly prefixMessageCount: number; readonly prefixHash: string }[] | undefined,
): boolean {
  const resolution = request.resolution;
  const approved = request.subject.proposal;
  return (
    request.state === "approved" &&
    resolution?.followUp === "new_admission" &&
    // An approval without a grant snapshot (recorded before snapshots
    // existed) is not enough to admit anything: the CDR could not name it.
    resolution.grant !== undefined &&
    approved !== undefined &&
    // Do not burn an approval on a range that can no longer be compacted.
    (validCuts === undefined ||
      validCuts.some(
        (cut) =>
          cut.prefixMessageCount === approved.prefixMessageCount &&
          cut.prefixHash === approved.prefixHash,
      )) &&
    request.contextOperationId !== options.contextOperationId &&
    request.operationEpoch < options.operationEpoch &&
    (resolution.consumedBy === null ||
      resolution.consumedBy === options.contextOperationId)
  );
}

/**
 * The admission gate over a RunLedger: Policy Gate verdict plus the review
 * state. Order matters and every failure closes the gate:
 *
 * 1. overdue reviews are expired; a pending review holds all compaction;
 * 2. the policy judges the proposal (allow -> admitted, deny -> blocked);
 * 3. on `review`, an approved, unspent review from an EARLIER operation is
 *    spent (once) and the pipeline is told to compact exactly the approved
 *    range; otherwise the proposal waits for a review.
 *
 * An approval authorizes one range. It never admits a different or larger
 * compaction, and the operation that asked for the review cannot spend it.
 */
export function createRunLedgerContextAdmissionGateV1(
  options: RunLedgerContextAdmissionGateOptionsV1,
): PactileContextAdmissionGateV1 {
  const base = {
    ledger: options.ledger,
    runId: options.runId,
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return {
    check: async (
      proposal: PactileContextProposalV1,
      context?: { readonly validCuts: readonly { readonly prefixMessageCount: number; readonly prefixHash: string }[] },
    ): Promise<PactileContextAdmissionV1> => {
      const expired = await expireContextReviewsV1(base);
      if (!expired.ok) {
        return { allowed: false, reason: "context_review_gate_unavailable" };
      }
      if (pendingContextReviewsV1(expired.ledger).length > 0) {
        return { allowed: false, reason: "context_review_pending" };
      }
      const decision =
        options.policy === undefined
          ? ({ verdict: "allow" } as const)
          : options.policy.evaluate(proposal);
      if (decision.verdict === "allow") return { allowed: true };
      if (decision.verdict === "deny") {
        return { allowed: false, reason: "context_policy_denied", policy: decision };
      }

      const candidate = (expired.ledger.approvalRequests ?? []).find((request) =>
        spendable(request, options, context?.validCuts),
      );
      const grantRef = candidate?.resolution?.grant;
      if (candidate?.subject.proposal === undefined || grantRef === undefined) {
        return { allowed: false, reason: "context_review_required", policy: decision };
      }
      // The approval is spent only once its grant snapshot is written and
      // bound: the admitted CDR must be able to name it.
      const granted = await completeContextGovernanceArtifactIntentV1({
        ledger: options.ledger,
        artifacts: options.artifacts,
        runId: options.runId,
        intentId: approvalGrantIntentIdV1(options.runId, candidate.approvalRequestId),
        ...(options.lease === undefined ? {} : { lease: options.lease }),
      });
      if (!granted.ok) {
        return { allowed: false, reason: "context_review_admission_failed" };
      }
      const spent = await admitReviewedContextOperationV1({
        ...base,
        approvalRequestId: candidate.approvalRequestId,
        newContextOperationId: options.contextOperationId,
        newOperationEpoch: options.operationEpoch,
      });
      if (!spent.ok) {
        return { allowed: false, reason: "context_review_admission_failed" };
      }
      return {
        allowed: true,
        useCut: {
          prefixMessageCount: candidate.subject.proposal.prefixMessageCount,
          prefixHash: candidate.subject.proposal.prefixHash,
        },
        grant: {
          artifactRef: grantRef,
          policyVersion: decision.policyVersion,
          ruleIds: decision.ruleIds,
        },
      };
    },
  };
}
