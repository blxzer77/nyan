/** Pure admission policy for Agent retrieval routes. */
import {
  assuranceSatisfiesV1,
  policyWithinCeilingV1,
  type AssuranceLevelV1,
  type PolicyCeilingV1,
  type ProviderReadinessV1,
} from "../../providers/contract.js";
import type { RetrievalProviderStatusV3 } from "../../retrieval/types.js";

export type RetrievalPolicyDecision =
  | { readonly allowed: true; readonly reason: "policy-and-readiness-satisfied" }
  | {
      readonly allowed: false;
      readonly reason:
        | "provider-unavailable"
        | "provider-degraded"
        | "provider-unsupported"
        | "assurance-below-minimum"
        | "policy-exceeds-ceiling";
    };

export interface RetrievalPolicyInput {
  readonly minimumAssurance: AssuranceLevelV1;
  readonly requestedPolicy: PolicyCeilingV1;
  readonly providerAssurance?: AssuranceLevelV1 | null;
  readonly providerReadiness?: ProviderReadinessV1;
  readonly providerStatus?: RetrievalProviderStatusV3;
  readonly providerPolicyCeiling?: PolicyCeilingV1 | null;
}

/**
 * Decide whether a resolved provider may answer a route. This function only
 * evaluates supplied facts; it never probes, authorizes, or retries a
 * provider. Missing facts fail closed.
 */
export function evaluateRetrievalPolicy(
  input: RetrievalPolicyInput,
): RetrievalPolicyDecision {
  if (input.providerStatus === "unsupported")
    return { allowed: false, reason: "provider-unsupported" };
  if (input.providerStatus === "unavailable")
    return { allowed: false, reason: "provider-unavailable" };
  if (input.providerStatus === "degraded")
    return { allowed: false, reason: "provider-degraded" };
  if (input.providerReadiness === "unavailable")
    return { allowed: false, reason: "provider-unavailable" };
  if (input.providerReadiness === "degraded")
    return { allowed: false, reason: "provider-degraded" };
  if (input.providerReadiness === undefined)
    return { allowed: false, reason: "provider-unavailable" };
  if (input.providerAssurance === undefined || input.providerAssurance === null)
    return { allowed: false, reason: "assurance-below-minimum" };
  if (!assuranceSatisfiesV1(input.providerAssurance, input.minimumAssurance))
    return { allowed: false, reason: "assurance-below-minimum" };
  if (
    input.providerPolicyCeiling === null ||
    input.providerPolicyCeiling === undefined ||
    !policyWithinCeilingV1(input.requestedPolicy, input.providerPolicyCeiling)
  ) {
    return { allowed: false, reason: "policy-exceeds-ceiling" };
  }
  return { allowed: true, reason: "policy-and-readiness-satisfied" };
}

export function assuranceAtLeast(
  actual: AssuranceLevelV1 | null | undefined,
  minimum: AssuranceLevelV1,
): boolean {
  return actual !== null && actual !== undefined && assuranceSatisfiesV1(actual, minimum);
}
