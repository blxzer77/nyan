/**
 * Agent retrieval boundary.
 *
 * The V3 planner remains the compatibility implementation for now. This
 * module is the Agent-facing contract seam: callers validate and normalize a
 * request before routing it, and adapter output carries explicit scope and
 * provenance. It deliberately contains no I/O and never replays a request.
 */
import type {
  AssuranceLevelV1,
  PactileIntentV1,
  PolicyCeilingV1,
} from "../../providers/contract.js";
import {
  buildRetrievalRequestV3,
  parseRetrievalRequestV3,
  type BuildRetrievalRequestV3Input,
} from "../../retrieval/planner.js";
import type {
  RetrievalParseResultV3,
  RetrievalRequestV3,
} from "../../retrieval/types.js";

export type RetrievalContractIntent = PactileIntentV1;

export interface AgentRetrievalRequest {
  readonly query: string;
  readonly intents?: readonly RetrievalContractIntent[];
  readonly scopeHints?: readonly string[];
  readonly minimumAssurance?: AssuranceLevelV1;
  readonly requestedPolicy?: PolicyCeilingV1;
  readonly requiredEvidenceKinds?: readonly string[];
  readonly budget?: BuildRetrievalRequestV3Input["budget"];
}

export interface RetrievalProvenance {
  readonly source: "local" | "provider" | "adapter";
  readonly adapterId: string;
  readonly scope: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly generation: number | null;
  readonly snapshot: string | null;
}

export interface RetrievalCandidateContract {
  readonly path: string;
  readonly line: number | null;
  readonly intent: RetrievalContractIntent;
  readonly provenance: RetrievalProvenance;
  readonly score?: number;
}

/** Validate at the public boundary without invoking accessors or proxies. */
export function parseAgentRetrievalRequest(
  input: unknown,
): RetrievalParseResultV3<RetrievalRequestV3> {
  return parseRetrievalRequestV3(input);
}

/** Build the canonical V3 request after the caller has supplied plain data. */
export function buildAgentRetrievalRequest(
  input: AgentRetrievalRequest,
): RetrievalRequestV3 {
  return buildRetrievalRequestV3(input);
}

/**
 * Scope membership is lexical and deterministic. An empty scope means the
 * candidate is outside a bounded request; callers must pass explicit scope
 * hints when adapting provider output.
 */
export function candidateWithinScope(
  candidatePath: string,
  scopeHints: readonly string[],
): boolean {
  const candidate = normalizePath(candidatePath);
  const scopes = scopeHints.map(normalizePath).filter(Boolean);
  if (!candidate || scopes.length === 0) return false;
  return scopes.some(
    (scope) => candidate === scope || candidate.startsWith(`${scope}/`),
  );
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  // Scope checks must never turn an absolute path or a parent traversal into
  // a prefix match. Adapters remain responsible for their own filesystem
  // containment checks; this is the Agent-side second fence.
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return "";
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return "";
  return parts.join("/");
}
