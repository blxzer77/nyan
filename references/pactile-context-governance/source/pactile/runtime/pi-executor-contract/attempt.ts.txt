import type { PiExecutorAttemptFactsV1, PiExecutorAttemptPlanV1, PiExecutorAttemptPriorV1 } from "./types.js";

/**
 * Idempotency, retry, resume and new-Run matrix for one logical WorkItem/Block.
 *
 * - `fresh`: no prior attempt for this logical work.
 * - `replay`: identical request id and hash; the recorded Run Result is reused
 *   and the host must not be contacted again.
 * - `resume`: same logical work, same semantics, effects known, prior unsettled;
 *   the same Run/Pi session may be prompted again as a continuation.
 * - `restart`: a new Run is mandatory — the prior attempt settled, the semantics
 *   changed, or side effects are unknown (retrying an attempt with unknown side
 *   effects could duplicate them, so a fresh Run plus reconciliation is required).
 * - `reject`: the request id was reused with a different payload; nothing may be
 *   dispatched.
 *
 * A `settled` prior never resumes in place: settlement is Kernel-visible and a
 * continuation must be a new Run.
 */
export function planPiExecutorAttemptV1(
  prior: PiExecutorAttemptPriorV1 | null | undefined,
  current: PiExecutorAttemptFactsV1,
): PiExecutorAttemptPlanV1 {
  if (prior === null || prior === undefined) {
    return Object.freeze({
      disposition: "fresh" as const,
      reason: "none" as const,
      reusePriorResult: false,
    });
  }
  if (
    prior.requestId === current.requestId &&
    prior.requestHash === current.requestHash
  ) {
    return Object.freeze({
      disposition: "replay" as const,
      reason: "none" as const,
      reusePriorResult: true,
    });
  }
  if (prior.requestId === current.requestId) {
    return Object.freeze({
      disposition: "reject" as const,
      reason: "request-conflict" as const,
      reusePriorResult: false,
    });
  }
  if (prior.settled) {
    return Object.freeze({
      disposition: "restart" as const,
      reason: "already-settled" as const,
      reusePriorResult: false,
    });
  }
  if (prior.semanticFingerprint !== current.semanticFingerprint) {
    return Object.freeze({
      disposition: "restart" as const,
      reason: "semantic-changed" as const,
      reusePriorResult: false,
    });
  }
  if (!prior.effectsKnown || !current.effectsKnown) {
    return Object.freeze({
      disposition: "restart" as const,
      reason: "effects-unknown" as const,
      reusePriorResult: false,
    });
  }
  return Object.freeze({
    disposition: "resume" as const,
    reason: "none" as const,
    reusePriorResult: false,
  });
}
