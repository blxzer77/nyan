/** Stable, redacted explanations for a retrieval plan and its outcome. */
import type { RetrievalPlanV3, RetrievalStopReasonV3 } from "../../retrieval/types.js";

export interface RetrievalExplanation {
  readonly summary: string;
  readonly intents: readonly string[];
  readonly steps: readonly string[];
  readonly stopReasons: readonly RetrievalStopReasonV3[];
  readonly verificationStages: readonly string[];
  readonly replayed: false;
}

export function explainRetrievalPlan(plan: RetrievalPlanV3): RetrievalExplanation {
  return Object.freeze({
    summary: `retrieval plan V${plan.schemaVersion} with ${plan.steps.length} step(s)`,
    intents: [...plan.intents],
    steps: plan.steps.map((step) =>
      step.kind === "local-exact"
        ? `${step.order}:${step.intent}:local-exact`
        : `${step.order}:${step.intent}:provider-request:${step.providerRequirement?.status ?? "unknown"}`,
    ),
    stopReasons: plan.stopReasons.map((reason) => ({ ...reason })),
    verificationStages: plan.verificationChain.map((stage) => `${stage.order}:${stage.stage}`),
    replayed: false,
  });
}

