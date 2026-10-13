import { fingerprintPactileContractV1 } from "../shared/validation.js";
import {
  DECISION_SCOPES_V1,
  DECISION_PROVIDER_KINDS_V1,
  DECISION_AUTONOMY_LEVELS_V1,
  type DecisionRequestV1,
  type DecisionAdviceV1,
  type DecisionProviderV1,
  type DecisionProviderRegistryV1,
  type DecisionResultV1,
} from "./contract.js";

function assertRequest(request: DecisionRequestV1): void {
  if (!request || typeof request !== "object" || !DECISION_SCOPES_V1.includes(request.scope)) throw new TypeError("invalid decision scope");
  const ids = request.candidateProfileIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.trim() === "")) throw new TypeError("candidateProfileIds must be non-empty strings");
  if (!request.taskFacts || typeof request.taskFacts !== "object" || Array.isArray(request.taskFacts)) throw new TypeError("taskFacts must be a flat object");
}
function validateAdvice(advice: DecisionAdviceV1, request: DecisionRequestV1): DecisionAdviceV1 {
  if (!advice || typeof advice !== "object") throw new TypeError("decision provider returned no advice");
  if (advice.selectedProfileId !== null && !request.candidateProfileIds.includes(advice.selectedProfileId)) throw new TypeError("selected profile is outside candidate set");
  if (advice.route === "selected" && advice.selectedProfileId === null) throw new TypeError("selected route requires a profile");
  if (advice.route === "needs_review" && advice.selectedProfileId !== null) throw new TypeError("needs_review cannot select a profile");
  return Object.freeze({ ...advice, rationaleCodes: Object.freeze([...advice.rationaleCodes]) });
}
export function createDecisionProviderRegistryV1(initial: readonly DecisionProviderV1[] = []): DecisionProviderRegistryV1 {
  const providers = new Map<string, DecisionProviderV1>();
  const register = (provider: DecisionProviderV1): void => {
    const descriptor = provider?.descriptor?.();
    if (!descriptor || typeof descriptor.id !== "string" || descriptor.id.trim() === "" || !DECISION_PROVIDER_KINDS_V1.includes(descriptor.kind) || !Array.isArray(descriptor.scopes) || !Array.isArray(descriptor.autonomyLevels) || descriptor.autonomyLevels.some((level) => !DECISION_AUTONOMY_LEVELS_V1.includes(level))) throw new TypeError("invalid DecisionProvider descriptor");
    if (providers.has(descriptor.id)) throw new TypeError(`duplicate DecisionProvider: ${descriptor.id}`);
    providers.set(descriptor.id, provider);
  };
  initial.forEach(register);
  return Object.freeze({
    register,
    list: () => Object.freeze([...providers.values()].map((p) => p.descriptor()).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))),
    decide: async (request: DecisionRequestV1): Promise<DecisionResultV1> => {
      assertRequest(request);
      if (!DECISION_AUTONOMY_LEVELS_V1.includes(request.autonomy)) throw new TypeError("invalid decision autonomy");
      const selected = [...providers.values()].map((provider) => ({ provider, descriptor: provider.descriptor() })).filter(({ descriptor }) => descriptor.scopes.includes(request.scope) && descriptor.autonomyLevels.includes(request.autonomy)).sort((a, b) => b.descriptor.priority - a.descriptor.priority || a.descriptor.id.localeCompare(b.descriptor.id))[0];
      const providerId = selected?.descriptor.id ?? null;
      let advice: DecisionAdviceV1 = Object.freeze({ selectedProfileId: null, thinkingLevel: null, serviceVariant: null, route: "needs_review", rationaleCodes: Object.freeze(["no_provider"]) });
      if (selected) advice = validateAdvice(await selected.provider.decide(request), request);
      const requestHash = fingerprintPactileContractV1(request);
      const decisionId = `decision:${fingerprintPactileContractV1({ requestHash, providerId, advice }).slice("sha256:".length)}`;
      const receipt = Object.freeze({ decisionId, requestHash, providerId, scope: request.scope, advice });
      return Object.freeze({ receipt, advice });
    },
  });
}
