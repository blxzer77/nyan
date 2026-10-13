/** Deterministic ranking of already collected retrieval candidates. */
import type { PactileIntentV1 } from "../../providers/contract.js";
import type { RetrievalCandidateContract } from "./contract.js";

export interface RankAgentRetrievalOptions {
  readonly intents: readonly PactileIntentV1[];
  readonly topK?: number;
}

export interface RankedAgentRetrievalCandidate extends RetrievalCandidateContract {
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RankedAgentRetrievalResult {
  readonly ranked: readonly RankedAgentRetrievalCandidate[];
  readonly total: number;
}

function clamp(value: number | undefined, min = 0, max = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

function scoreCandidate(
  candidate: RetrievalCandidateContract,
  intents: ReadonlySet<PactileIntentV1>,
): RankedAgentRetrievalCandidate {
  let score = clamp(candidate.score, -1000, 1000);
  const reasons: string[] = [];
  if (intents.has(candidate.intent)) {
    score += candidate.intent === "exact" ? 100 : candidate.intent === "structural" ? 60 : 40;
    reasons.push(`${candidate.intent}-candidate`);
  }
  if (candidate.provenance.evidenceRefs.length > 0) {
    score += 10;
    reasons.push("evidence-reference-present");
  }
  return { ...candidate, score, reasons };
}

export function rankAgentRetrievalCandidates(
  candidates: readonly RetrievalCandidateContract[],
  options: RankAgentRetrievalOptions,
): RankedAgentRetrievalResult {
  const intents = new Set(options.intents);
  const topK = Math.max(0, Math.min(options.topK ?? candidates.length, candidates.length));
  const ranked = candidates
    .map((candidate) => scoreCandidate(candidate, intents))
    .sort((left, right) => {
      const byScore = right.score - left.score;
      if (byScore !== 0) return byScore;
      const leftPath = pathKey(left.path);
      const rightPath = pathKey(right.path);
      if (leftPath < rightPath) return -1;
      if (leftPath > rightPath) return 1;
      return (left.line ?? 0) - (right.line ?? 0);
    })
    .slice(0, topK);
  return Object.freeze({ ranked, total: candidates.length });
}
