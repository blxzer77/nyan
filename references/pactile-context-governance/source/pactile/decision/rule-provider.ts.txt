import {
  DECISION_SCOPES_V1,
  DECISION_AUTONOMY_LEVELS_V1,
  type DecisionProviderV1,
  type DecisionRequestV1,
  type DecisionAdviceV1,
} from "./contract.js";

export function createRuleDecisionProviderV1(options: { readonly id?: string; readonly priority?: number } = {}): DecisionProviderV1 {
  const descriptor = Object.freeze({ id: options.id ?? "rule-default", kind: "rule" as const, scopes: DECISION_SCOPES_V1, autonomyLevels: DECISION_AUTONOMY_LEVELS_V1, priority: options.priority ?? 0 });
  return Object.freeze({ descriptor: () => descriptor, decide: (request: DecisionRequestV1): DecisionAdviceV1 => {
    const selectedProfileId = request.candidateProfileIds[0] ?? null;
    return { selectedProfileId, thinkingLevel: request.requestedThinkingLevel ?? null, serviceVariant: request.requestedServiceVariant ?? null, route: selectedProfileId ? "selected" as const : "needs_review" as const, rationaleCodes: [selectedProfileId ? "stable-first-candidate" : "no-candidate"] };
  } });
}
