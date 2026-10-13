/** Port for retrieval adapters. The Agent owns orchestration; adapters only observe. */
import { isRetrievalLogicalRefV3 } from "../../retrieval/evidence.js";
import type { RetrievalPlanV3 } from "../../retrieval/types.js";
import {
  candidateWithinScope,
  type RetrievalCandidateContract,
  type RetrievalProvenance,
} from "./contract.js";

const SNAPSHOT_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

export type RetrievalAdapterBoundaryCodeV1 =
  | "invalid-response"
  | "request-scope-invalid"
  | "adapter-identity-mismatch"
  | "candidate-out-of-scope"
  | "candidate-intent-not-planned"
  | "candidate-provider-not-ready"
  | "provenance-out-of-scope"
  | "provenance-reference-invalid"
  | "provenance-snapshot-invalid";

export class RetrievalAdapterBoundaryError extends Error {
  readonly code: RetrievalAdapterBoundaryCodeV1;

  constructor(code: RetrievalAdapterBoundaryCodeV1) {
    super(`PACTILE_RETRIEVAL_ADAPTER_${code.toUpperCase().replaceAll("-", "_")}`);
    this.name = "RetrievalAdapterBoundaryError";
    this.code = code;
  }
}

export interface RetrievalAdapterRequest {
  readonly plan: RetrievalPlanV3;
  readonly scope: readonly string[];
  readonly signal?: AbortSignal;
}

export interface RetrievalAdapterResponse {
  readonly candidates: readonly RetrievalCandidateContract[];
  readonly provenance: RetrievalProvenance;
}

export interface RetrievalAdapterPort {
  readonly id: string;
  readonly retrieve: (
    request: RetrievalAdapterRequest,
  ) => Promise<RetrievalAdapterResponse>;
}

function validSnapshot(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SNAPSHOT_PATTERN.test(value));
}

function validateRequestScope(scope: readonly string[]): void {
  if (
    !Array.isArray(scope) ||
    scope.length === 0 ||
    scope.some(
      (entry) =>
        typeof entry !== "string" || !candidateWithinScope(entry, [entry]),
    )
  ) {
    throw new RetrievalAdapterBoundaryError("request-scope-invalid");
  }
}

function validateProvenance(
  adapter: RetrievalAdapterPort,
  provenance: RetrievalProvenance,
  scope: readonly string[],
): void {
  if (
    provenance.adapterId !== adapter.id ||
    !["local", "provider", "adapter"].includes(provenance.source) ||
    !Array.isArray(provenance.scope) ||
    !Array.isArray(provenance.evidenceRefs)
  ) {
    throw new RetrievalAdapterBoundaryError("adapter-identity-mismatch");
  }
  if (
    provenance.scope.length === 0 ||
    provenance.scope.some(
      (entry) => typeof entry !== "string" || !candidateWithinScope(entry, scope),
    )
  ) {
    throw new RetrievalAdapterBoundaryError("provenance-out-of-scope");
  }
  if (
    provenance.evidenceRefs.some(
      (reference) =>
        typeof reference !== "string" || !isRetrievalLogicalRefV3(reference),
    )
  ) {
    throw new RetrievalAdapterBoundaryError("provenance-reference-invalid");
  }
  if (!validSnapshot(provenance.snapshot)) {
    throw new RetrievalAdapterBoundaryError("provenance-snapshot-invalid");
  }
  if (
    provenance.generation !== null &&
    (!Number.isSafeInteger(provenance.generation) || provenance.generation < 0)
  ) {
    throw new RetrievalAdapterBoundaryError("invalid-response");
  }
}

function validateCandidate(
  adapter: RetrievalAdapterPort,
  candidate: RetrievalCandidateContract,
  plan: RetrievalPlanV3,
  scope: readonly string[],
): void {
  if (
    typeof candidate.path !== "string" ||
    candidate.path.length === 0 ||
    !candidateWithinScope(candidate.path, scope)
  ) {
    throw new RetrievalAdapterBoundaryError("candidate-out-of-scope");
  }
  if (!plan.intents.includes(candidate.intent)) {
    throw new RetrievalAdapterBoundaryError("candidate-intent-not-planned");
  }
  const step = plan.steps.find((item) => item.intent === candidate.intent);
  if (!step) {
    throw new RetrievalAdapterBoundaryError("candidate-intent-not-planned");
  }
  if (
    step.providerRequirement !== null &&
    step.providerRequirement.status !== "ready"
  ) {
    throw new RetrievalAdapterBoundaryError("candidate-provider-not-ready");
  }
  if (
    candidate.line !== null &&
    (!Number.isSafeInteger(candidate.line) || candidate.line < 1)
  ) {
    throw new RetrievalAdapterBoundaryError("invalid-response");
  }
  validateProvenance(adapter, candidate.provenance, scope);
}

function publicProvenance(
  provenance: RetrievalProvenance,
): RetrievalProvenance {
  return {
    source: provenance.source,
    adapterId: provenance.adapterId,
    scope: [...provenance.scope],
    evidenceRefs: [...provenance.evidenceRefs],
    generation: provenance.generation,
    snapshot: provenance.snapshot,
  };
}

function publicCandidate(
  candidate: RetrievalCandidateContract,
): RetrievalCandidateContract {
  return {
    path: candidate.path,
    line: candidate.line,
    intent: candidate.intent,
    provenance: publicProvenance(candidate.provenance),
    ...(typeof candidate.score === "number" && Number.isFinite(candidate.score)
      ? { score: candidate.score }
      : {}),
  };
}

function validateAndBoundResponse(
  adapter: RetrievalAdapterPort,
  request: RetrievalAdapterRequest,
  response: RetrievalAdapterResponse,
): RetrievalAdapterResponse {
  if (
    response === null ||
    typeof response !== "object" ||
    !Array.isArray(response.candidates) ||
    response.provenance === null ||
    typeof response.provenance !== "object"
  ) {
    throw new RetrievalAdapterBoundaryError("invalid-response");
  }
  validateProvenance(adapter, response.provenance, request.scope);
  const candidates = response.candidates.slice(
    0,
    request.plan.budget.maxCandidatesPerStep,
  );
  const publicCandidates: RetrievalCandidateContract[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      throw new RetrievalAdapterBoundaryError("invalid-response");
    }
    validateCandidate(adapter, candidate, request.plan, request.scope);
    publicCandidates.push(publicCandidate(candidate));
  }
  return {
    candidates: publicCandidates,
    provenance: publicProvenance(response.provenance),
  };
}

/** Execute once, then enforce the Agent scope/provenance/result boundary. */
export async function invokeRetrievalAdapter(
  adapter: RetrievalAdapterPort,
  request: RetrievalAdapterRequest,
): Promise<RetrievalAdapterResponse> {
  validateRequestScope(request.scope);
  const response = await adapter.retrieve(request);
  return validateAndBoundResponse(adapter, request, response);
}
