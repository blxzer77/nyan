import type {
  PiExecutorOutcomeDecisionV1,
  PiExecutorOutcomeFactsV1,
  PiExecutorReasonCodeV1,
  PiExecutorRunOutcomeV1,
} from "./types.js";

function outcomeDecisionV1(
  outcome: PiExecutorRunOutcomeV1,
  reason: PiExecutorReasonCodeV1,
  retryable: boolean,
  nativeReceiptAuthoritative = false,
): PiExecutorOutcomeDecisionV1 {
  return Object.freeze({
    outcome,
    reason,
    retryable,
    nativeReceiptAuthoritative,
    workItemCompleted: false as const,
  });
}

/**
 * Fail-closed outcome decision. Fact precedence is fixed:
 *
 * 1. lifecycle admission, 2. workspace binding, 3. explicit cancellation,
 * 4. host binding state, 5. native Pi receipt, 6. terminal/effects/evidence/gate.
 *
 * `result_submitted` requires a native host receipt that settled, an explicit
 * terminal fact with known effects, accepted evidence and an accepted gate. A
 * controller/stub host can never produce it, and even a full success keeps
 * `workItemCompleted: false`.
 *
 * `unknown_effects` is not retryable: retrying an attempt with unknown side
 * effects can duplicate them, so reconciliation — not blind retry — is needed.
 */
export function decidePiExecutorOutcomeV1(
  facts: PiExecutorOutcomeFactsV1,
): PiExecutorOutcomeDecisionV1 {
  if (!facts.admissionAccepted) {
    return outcomeDecisionV1("waiting", "admission-rejected", false);
  }
  if (!facts.bindingAdmitted) {
    return outcomeDecisionV1("waiting", "binding-rejected", false);
  }
  if (facts.cancelRequested) {
    return outcomeDecisionV1("cancelled", "run-cancelled", true);
  }
  if (!facts.hostAttempted) {
    return outcomeDecisionV1("waiting", "host-unbound", true);
  }
  if (facts.hostKind !== "native") {
    return outcomeDecisionV1("waiting", "host-not-native", true);
  }
  if (!facts.hostBound || facts.hostFailed) {
    return outcomeDecisionV1("provider_error", "provider-error", true);
  }
  const piStatus = facts.piStatus;
  if (piStatus === null) {
    return outcomeDecisionV1("waiting", "missing-native-receipt", true);
  }
  if (piStatus === "timed_out") {
    return outcomeDecisionV1("timed_out", "run-timed-out", true);
  }
  if (piStatus === "failed" || piStatus === "process_exited") {
    return outcomeDecisionV1("provider_error", "provider-error", true);
  }
  if (piStatus !== "settled") {
    // `handled` means Pi answered without settling the agent, so there is no
    // native completion receipt to stand on.
    return outcomeDecisionV1("waiting", "missing-native-receipt", true);
  }
  const terminal = facts.terminal;
  if (terminal === null) {
    return outcomeDecisionV1("waiting", "missing-terminal-fact", true);
  }
  if (!terminal.effectsKnown) {
    return outcomeDecisionV1("unknown_effects", "effects-unknown", false);
  }
  if (!facts.evidenceAccepted) {
    return outcomeDecisionV1("waiting", "evidence-missing", true);
  }
  if (!facts.gateAccepted) {
    return outcomeDecisionV1("waiting", "gate-missing", true);
  }
  return outcomeDecisionV1("result_submitted", "none", false, true);
}

/**
 * Decision for an attempt that is refused before any host contact: an
 * idempotency conflict, a settled prior attempt, or an unusable binding.
 *
 * The attempt produced no Pi receipt, so the outcome is `rejected`/`waiting`
 * with the specific reason rather than a generic failure; nothing here may be
 * read as a successful Run Result.
 */
export function piExecutorRejectionDecisionV1(
  reason: PiExecutorReasonCodeV1,
  outcome: Extract<PiExecutorRunOutcomeV1, "rejected" | "waiting"> = "rejected",
  retryable = false,
): PiExecutorOutcomeDecisionV1 {
  return outcomeDecisionV1(outcome, reason, retryable);
}
