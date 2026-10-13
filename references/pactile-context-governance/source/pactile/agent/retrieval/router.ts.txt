/** Deterministic Agent retrieval router. */
import type { PactileIntentV1 } from "../../providers/contract.js";
import {
  classifyRetrievalIntentsV3,
  createRetrievalPlanV3,
  type BuildRetrievalRequestV3Input,
} from "../../retrieval/planner.js";
import type {
  RetrievalPlanV3,
  RetrievalPlanningContextV3,
  RetrievalProviderAvailabilityV3,
  RetrievalRequestV3,
} from "../../retrieval/types.js";
import { buildAgentRetrievalRequest } from "./contract.js";

export interface RouteAgentRetrievalInput extends BuildRetrievalRequestV3Input {
  readonly providerAvailability?: readonly RetrievalProviderAvailabilityV3[];
}

export interface AgentRetrievalRouter {
  readonly route: (
    input: RouteAgentRetrievalInput | string,
  ) => RetrievalPlanV3;
}

/**
 * Route exact first, then the canonical intent order. Provider availability is
 * an observation supplied by middleware; this function does not discover a
 * provider and never invokes or replays one.
 */
export function routeAgentRetrieval(
  input: RouteAgentRetrievalInput | RetrievalRequestV3 | string,
): RetrievalPlanV3 {
  const request = typeof input === "string"
    ? buildAgentRetrievalRequest({
        query: input,
        intents: classifyRetrievalIntentsV3(input),
      })
    : "schemaVersion" in input
      ? input
      : (() => {
          const { providerAvailability: _providerAvailability, ...requestInput } = input;
          return buildAgentRetrievalRequest(requestInput);
        })();
  const context: RetrievalPlanningContextV3 =
    typeof input === "string" ||
    "schemaVersion" in input ||
    input.providerAvailability === undefined
      ? {}
      : { providerAvailability: input.providerAvailability };
  return createRetrievalPlanV3(request, context);
}

export function createAgentRetrievalRouter(): AgentRetrievalRouter {
  return Object.freeze({ route: routeAgentRetrieval });
}

export type { PactileIntentV1 };
