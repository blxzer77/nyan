import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRIEVAL_POLICY_V3 } from "../../../../src/pactile/retrieval/index.js";
import {
  candidateWithinScope,
  evaluateRetrievalPolicy,
  explainRetrievalPlan,
  invokeRetrievalAdapter,
  rankAgentRetrievalCandidates,
  routeAgentRetrieval,
} from "../../../../src/pactile/agent/retrieval/index.js";

describe("Agent retrieval bounded context seams", () => {
  it("routes in canonical intent order and does not invoke providers", () => {
    const plan = routeAgentRetrieval(
      "find the exact symbol behavior and explain its caller impact",
    );
    expect(plan.intents).toEqual(["exact", "semantic", "structural"]);
    expect(plan.steps.map((step) => step.order)).toEqual([1, 2, 3]);
  });

  it("keeps scope and provenance explicit when ranking", () => {
    const ranked = rankAgentRetrievalCandidates(
      [
        {
          path: "src/z.ts",
          line: 2,
          intent: "exact",
          provenance: {
            source: "local",
            adapterId: "rg",
            scope: ["src"],
            evidenceRefs: ["source://src/z.ts"],
            generation: null,
            snapshot: null,
          },
        },
        {
          path: "src/a.ts",
          line: 1,
          intent: "exact",
          provenance: {
            source: "local",
            adapterId: "rg",
            scope: ["src"],
            evidenceRefs: [],
            generation: null,
            snapshot: null,
          },
        },
      ],
      { intents: ["exact"] },
    );
    expect(ranked.ranked.map((item) => item.path)).toEqual([
      "src/z.ts",
      "src/a.ts",
    ]);
    expect(candidateWithinScope("src/a.ts", ["src"])).toBe(true);
    expect(candidateWithinScope("tests/a.ts", ["src"])).toBe(false);
    expect(candidateWithinScope("src/../tests/a.ts", ["src"])).toBe(false);
    expect(candidateWithinScope("C:/repo/src/a.ts", ["src"])).toBe(false);
  });

  it("fails policy closed for missing or degraded readiness", () => {
    const input = {
      minimumAssurance: "evidence-backed" as const,
      requestedPolicy: DEFAULT_RETRIEVAL_POLICY_V3,
      providerAssurance: "verified" as const,
      providerPolicyCeiling: DEFAULT_RETRIEVAL_POLICY_V3,
    };
    expect(evaluateRetrievalPolicy(input).allowed).toBe(false);
    expect(
      evaluateRetrievalPolicy({ ...input, providerReadiness: "ready" }),
    ).toEqual({ allowed: true, reason: "policy-and-readiness-satisfied" });
    expect(
      evaluateRetrievalPolicy({ ...input, providerReadiness: "degraded" }),
    ).toEqual({ allowed: false, reason: "provider-degraded" });
    expect(
      evaluateRetrievalPolicy({ ...input, providerStatus: "unsupported" }),
    ).toEqual({ allowed: false, reason: "provider-unsupported" });
  });

  it("explains stop and verification stages without replay metadata", () => {
    const plan = routeAgentRetrieval({ query: "where is Widget defined" });
    const explanation = explainRetrievalPlan(plan);
    expect(explanation.replayed).toBe(false);
    expect(explanation.verificationStages).toEqual([
      "1:candidate",
      "2:corroborate",
      "3:classify-evidence",
      "4:check-assurance",
      "5:accept-or-stop",
    ]);
  });

  it("invokes an adapter exactly once; retry is an explicit caller policy", async () => {
    const retrieve = vi.fn(async () => ({
      candidates: [],
      provenance: {
        source: "adapter" as const,
        adapterId: "fixture",
        scope: ["src"],
        evidenceRefs: [],
        generation: null,
        snapshot: null,
      },
    }));
    await invokeRetrievalAdapter(
      { id: "fixture", retrieve },
      { plan: routeAgentRetrieval("find Widget"), scope: ["src"] },
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("bounds adapter results and rejects out-of-scope candidates", async () => {
    const plan = routeAgentRetrieval({
      query: "find Widget",
      intents: ["exact"],
      budget: { maxSteps: 1, maxCandidatesPerStep: 1 },
    });
    const provenance = {
      source: "adapter" as const,
      adapterId: "fixture",
      scope: ["src"],
      evidenceRefs: [],
      generation: null,
      snapshot: null,
      rawResponse: "provider-secret",
    };
    const bounded = await invokeRetrievalAdapter(
      {
        id: "fixture",
        retrieve: async () => ({
          candidates: [
            { path: "src/one.ts", line: 1, intent: "exact" as const, provenance },
            { path: "src/two.ts", line: 2, intent: "exact" as const, provenance },
          ],
          provenance,
        }),
      },
      { plan, scope: ["src"] },
    );
    expect(bounded.candidates).toHaveLength(1);
    expect(JSON.stringify(bounded)).not.toContain("provider-secret");
    expect(JSON.stringify(bounded)).not.toContain("rawResponse");

    await expect(
      invokeRetrievalAdapter(
        {
          id: "fixture",
          retrieve: async () => ({
            candidates: [
              { path: "C:/outside.ts", line: 1, intent: "exact" as const, provenance },
            ],
            provenance,
          }),
        },
        { plan, scope: ["src"] },
      ),
    ).rejects.toMatchObject({ code: "candidate-out-of-scope" });
  });

  it("does not accept provider candidates before resolver readiness", async () => {
    const plan = routeAgentRetrieval({
      query: "find Widget behavior",
      intents: ["semantic"],
      providerAvailability: [
        { intent: "semantic", status: "degraded", readiness: "degraded" },
      ],
    });
    const provenance = {
      source: "provider" as const,
      adapterId: "fixture",
      scope: ["src"],
      evidenceRefs: [],
      generation: null,
      snapshot: null,
    };
    await expect(
      invokeRetrievalAdapter(
        {
          id: "fixture",
          retrieve: async () => ({
            candidates: [
              { path: "src/widget.ts", line: 1, intent: "semantic" as const, provenance },
            ],
            provenance,
          }),
        },
        { plan, scope: ["src"] },
      ),
    ).rejects.toMatchObject({ code: "candidate-provider-not-ready" });
  });
});
