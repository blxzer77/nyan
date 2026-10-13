/**
 * Focused tests for the Retrieval Worker -> ABI V3 adapter seam.
 *
 * The transport here is a TEST DOUBLE that returns hand-built wire packs in
 * the frozen candidate's `RetrievalPack` v1 shape. It is not a host and these
 * tests are not evidence that the real Worker behaves this way; they pin the
 * adapter's own contract (scope, budget, abort, timeout, fencing, containment,
 * evidence eligibility and identity stripping).
 */
import { describe, expect, it } from "vitest";

import {
  assessLocalWorkerClaimV1,
  corroborateLocalWorkerCandidateV1,
  localWorkerCandidateRefsV1,
  localWorkerStructuralAvailabilityV1,
  reconcileLocalWorkerIndexEffectV1,
  runLocalWorkerRetrievalV1,
  runLocalWorkerVerificationChainV1,
  type LocalWorkerExecuteRequestV1,
  type LocalWorkerHandshakeV1,
  type LocalWorkerScopeV1,
  type LocalWorkerTransportV1,
} from "../../../src/pactile/retrieval/adapters/local-worker.js";
import {
  buildRetrievalRequestV3,
  createRetrievalPlanV3,
  type RetrievalPlanV3,
  type RetrievalProviderStatusV3,
} from "../../../src/pactile/retrieval/index.js";

const QUERY = "where is widget defined";
const HOST_ROOT = "D:\\host-only\\SecretRoot";
const WORKER_TREE_HASH = "a1b2c3d4e5f60718";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const SCOPE: LocalWorkerScopeV1 = {
  worktreeId: "wt.main",
  expectedGeneration: 3,
  expectedSnapshot: "snap-3",
};

function plan(
  options: {
    intents?: ("exact" | "semantic" | "structural" | "external")[];
    scopeHints?: string[];
    structural?: Exclude<RetrievalProviderStatusV3, "resolution-required">;
    maxCandidatesPerStep?: number;
    maxSteps?: number;
  } = {},
): RetrievalPlanV3 {
  return createRetrievalPlanV3(
    buildRetrievalRequestV3({
      query: QUERY,
      intents: options.intents ?? ["exact"],
      scopeHints: options.scopeHints ?? [],
      budget: {
        maxSteps: options.maxSteps ?? 16,
        maxCandidatesPerStep: options.maxCandidatesPerStep ?? 50,
      },
    }),
    options.structural
      ? {
          providerAvailability: [
            {
              intent: "structural",
              status: options.structural,
              readiness:
                options.structural === "unsupported"
                  ? "unavailable"
                  : options.structural,
            },
          ],
        }
      : {},
  );
}

interface WireCandidate {
  path: string;
  line: number | null;
  source: "exact" | "graph";
  hash: string | null;
}

function wirePack(
  overrides: {
    candidates?: WireCandidate[];
    scope?: Record<string, unknown>;
    status?: string;
    missing?: string[];
    provider?: string;
    query?: string;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const candidates = overrides.candidates ?? [
    { path: "src/widget.ts", line: 12, source: "exact", hash: H1 },
  ];
  return {
    packVersion: 1,
    query: overrides.query ?? QUERY,
    scope: {
      root: HOST_ROOT,
      worktreeId: WORKER_TREE_HASH,
      generation: 3,
      snapshot: "snap-3",
      freshness: "fresh",
      ...overrides.scope,
    },
    status: overrides.status ?? "complete",
    candidates: candidates.map((candidate) => ({
      ref: `source://${candidate.path}#L${candidate.line ?? 0}`,
      path: candidate.path,
      line: candidate.line,
      source: candidate.source,
      inspected: candidate.hash !== null,
      hash: candidate.hash,
    })),
    facts: candidates.map((candidate) => ({
      ref: `source://${candidate.path}`,
      path: candidate.path,
      exists: true,
      hash: candidate.hash,
      bytes: 10,
      lineCount: 20,
    })),
    missing: overrides.missing ?? [],
    budget: { maxCandidates: 50, maxBytes: 131072, maxNodes: 150 },
    decision: {
      provider: overrides.provider ?? "rule",
      intents: ["exact"],
      parallel: false,
      earlyStop: true,
      maxCandidates: 50,
      maxBytes: 131072,
      maxNodes: 150,
      timeoutMs: 15000,
      rationale: ["rule"],
      createdAt: "2026-10-07T00:00:00.000Z",
    },
    createdAt: "2026-10-07T00:00:00.000Z",
    hash: "f".repeat(64),
    ...overrides.extra,
  };
}

/** Test double. Records every request and the signal it received. */
function fakeTransport(
  respond: (
    request: LocalWorkerExecuteRequestV1,
    signal: AbortSignal,
  ) => unknown,
): LocalWorkerTransportV1 & {
  calls: { request: LocalWorkerExecuteRequestV1; signal: AbortSignal }[];
} {
  const calls: { request: LocalWorkerExecuteRequestV1; signal: AbortSignal }[] =
    [];
  return {
    calls,
    async execute(request, signal) {
      calls.push({ request, signal });
      return await respond(request, signal);
    },
  };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe("Retrieval Worker V3 adapter: request derivation", () => {
  it("derives intents and budget from plan steps and clamps candidates to the Worker cap", async () => {
    const transport = fakeTransport(() => wirePack());
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({
        intents: ["exact", "structural"],
        structural: "ready",
        maxCandidatesPerStep: 500,
      }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].request).toEqual({
      query: QUERY,
      intents: ["exact", "structural"],
      maxCandidates: 200,
      maxBytes: 128 * 1024,
      maxNodes: 150,
      timeoutMs: 15_000,
    });
    expect(result.stopReasons).toContainEqual({
      code: "budget-clamped",
      intent: null,
      blocking: false,
    });
  });

  it("requests exact explicitly for structural-only plans and drops the planner-added exact hits", async () => {
    const transport = fakeTransport(() =>
      wirePack({
        candidates: [
          { path: "src/widget.ts", line: 12, source: "exact", hash: H1 },
          { path: "src/graph.ts", line: 4, source: "graph", hash: H2 },
        ],
      }),
    );
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ intents: ["structural"], structural: "ready" }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls[0].request.intents).toEqual(["exact", "structural"]);
    expect(result.candidates.map((c) => [c.intent, c.sourcePath])).toEqual([
      ["structural", "src/graph.ts"],
    ]);
    expect(result.stopReasons).toContainEqual({
      code: "worker-added-exact-dropped",
      intent: "exact",
      blocking: false,
    });
    expect(localWorkerCandidateRefsV1(result, "structural")).toEqual([
      "source://src/graph.ts",
    ]);
  });

  it("maps scope hints to contained POSIX paths", async () => {
    const transport = fakeTransport(() => wirePack());
    await runLocalWorkerRetrievalV1({
      plan: plan({ scopeHints: ["src", "packages\\cli"] }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls[0].request.paths).toEqual(["packages/cli", "src"]);
  });

  it("never sends a path-scoped structural step (P3 REPRO-D30) and falls back to exact", async () => {
    const transport = fakeTransport(() => wirePack());
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({
        intents: ["exact", "structural"],
        structural: "ready",
        scopeHints: ["src"],
      }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls[0].request.intents).toEqual(["exact"]);
    expect(result.stopReasons).toContainEqual({
      code: "structural-path-scope-unsupported",
      intent: "structural",
      blocking: true,
    });
    expect(result.intentStatus).toContainEqual({
      intent: "structural",
      status: "unsupported",
    });
    expect(result.fallback).toEqual({ intent: "exact", requiresReplan: false });

    const structuralOnly = fakeTransport(() => wirePack());
    const rejected = await runLocalWorkerRetrievalV1({
      plan: plan({ intents: ["structural"], structural: "ready", scopeHints: ["src"] }),
      scope: SCOPE,
      transport: structuralOnly,
    });
    expect(structuralOnly.calls).toHaveLength(0);
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.fallback).toEqual({ intent: "exact", requiresReplan: true });
  });

  it("reports partial coverage when the Worker hit a limit or filled the cap", async () => {
    const limited = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack({ status: "limit_hit" })),
    });
    expect(limited.coverage).toBe("partial");
    expect(limited.stopReasons).toContainEqual({
      code: "worker-budget-limited",
      intent: null,
      blocking: false,
    });
    const full = await runLocalWorkerRetrievalV1({
      plan: plan({ maxCandidatesPerStep: 1 }),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    expect(full.coverage).toBe("partial");
    const complete = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    expect(complete.coverage).toBe("complete");
  });

  it("uses budget-truncated steps instead of every planned intent", async () => {
    const transport = fakeTransport(() => wirePack());
    await runLocalWorkerRetrievalV1({
      plan: plan({
        intents: ["exact", "structural"],
        structural: "ready",
        maxSteps: 1,
      }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls[0].request.intents).toEqual(["exact"]);
  });

  it.each([
    ["absolute posix", "/etc"],
    ["drive letter", "C:\\Users"],
    ["parent traversal", "src/../.."],
    ["home", "~/repo"],
    ["glob", "src/**/*.ts"],
  ])("rejects a %s scope hint without calling the Worker", async (_label, hint) => {
    const transport = fakeTransport(() => wirePack());
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ scopeHints: ["src", hint] }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls).toHaveLength(0);
    expect(result.outcome).toBe("rejected");
    expect(result.stopReasons).toContainEqual({
      code: "scope-hint-rejected",
      intent: null,
      blocking: true,
    });
  });

  it("does not send a structural step whose provider is not ready and recommends exact fallback", async () => {
    const transport = fakeTransport(() => wirePack());
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ intents: ["exact", "structural"], structural: "degraded" }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls[0].request.intents).toEqual(["exact"]);
    expect(result.fallback).toEqual({ intent: "exact", requiresReplan: false });
    expect(result.intentStatus).toContainEqual({
      intent: "structural",
      status: "degraded",
    });
    expect(localWorkerCandidateRefsV1(result, "exact")).toEqual([
      "source://src/widget.ts",
    ]);
  });

  it("reports semantic/external as unsupported and requires a re-plan for exact fallback", async () => {
    const transport = fakeTransport(() => wirePack());
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ intents: ["semantic", "external"] }),
      scope: SCOPE,
      transport,
    });
    expect(transport.calls).toHaveLength(0);
    expect(result.outcome).toBe("rejected");
    expect(result.fallback).toEqual({ intent: "exact", requiresReplan: true });
    expect(result.intentStatus).toEqual(
      expect.arrayContaining([
        { intent: "semantic", status: "unsupported" },
        { intent: "external", status: "unsupported" },
      ]),
    );
  });

  it("rejects a tampered plan and an invalid logical worktree id", async () => {
    const transport = fakeTransport(() => wirePack());
    const tampered = { ...plan(), query: "something else" };
    expect(
      (
        await runLocalWorkerRetrievalV1({ plan: tampered, scope: SCOPE, transport })
      ).stopReasons,
    ).toContainEqual({ code: "invalid-plan", intent: null, blocking: true });
    const badScope = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: { ...SCOPE, worktreeId: "D:\\repo" },
      transport,
    });
    expect(badScope.outcome).toBe("rejected");
    expect(JSON.stringify(badScope)).not.toContain("repo");
    expect(transport.calls).toHaveLength(0);
  });
});

describe("Retrieval Worker V3 adapter: identity and evidence boundary", () => {
  it("drops the host root and Worker worktree hash and never marks output as Close/AC evidence", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SecretRoot");
    expect(serialized).not.toContain("host-only");
    expect(serialized).not.toContain(WORKER_TREE_HASH);
    expect(serialized).not.toContain("rule");
    expect(result).toMatchObject({
      worktreeId: "wt.main",
      outcome: "candidates",
      closeEvidenceEligible: false,
      notAcEvidence: true,
      generation: 3,
      snapshot: "snap-3",
    });
    expect(result.candidates[0]).toEqual({
      role: "candidate",
      intent: "exact",
      sourcePath: "src/widget.ts",
      line: 12,
      evidenceRef: "source://src/widget.ts",
      workerObservedSha256: H1,
      generation: 3,
      snapshot: "snap-3",
      freshness: "fresh",
    });
  });

  it("keeps paths the V3 ref grammar cannot represent as candidates without an evidence ref", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() =>
        wirePack({
          candidates: [
            { path: "README.md", line: 1, source: "exact", hash: H1 },
            { path: "src/widget.ts", line: 12, source: "exact", hash: H2 },
          ],
        }),
      ),
    });
    expect(result.candidates.find((c) => c.sourcePath === "README.md")?.evidenceRef).toBeNull();
    expect(result.stopReasons).toContainEqual({
      code: "ref-not-representable",
      intent: "exact",
      blocking: false,
    });
    expect(localWorkerCandidateRefsV1(result, "exact")).toEqual([
      "source://src/widget.ts",
    ]);
  });

  it("does not let Worker-observed facts corroborate their own candidate", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    const withoutCorroboration = assessLocalWorkerClaimV1({
      plan: executionPlan,
      result,
      intent: "exact",
      corroboration: [],
    });
    expect(withoutCorroboration.accepted).toBe(false);
    expect(withoutCorroboration.reasonCodes).toContain("required-evidence-missing");

    const agentRead = corroborateLocalWorkerCandidateV1(result.candidates[0], {
      sourcePath: "src/widget.ts",
      sha256: H1,
    });
    expect(agentRead).toEqual({
      fact: { kind: "source-reference", ref: "source://src/widget.ts" },
      issue: null,
    });
    const assessed = assessLocalWorkerClaimV1({
      plan: executionPlan,
      result,
      intent: "exact",
      corroboration: agentRead.fact ? [agentRead.fact] : [],
    });
    expect(assessed).toMatchObject({
      accepted: true,
      achievedAssurance: "evidence-backed",
    });
  });

  it("refuses corroboration when the Agent's independent read shows changed content", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    expect(
      corroborateLocalWorkerCandidateV1(result.candidates[0], {
        sourcePath: "src/widget.ts",
        sha256: H2,
      }),
    ).toEqual({ fact: null, issue: "content-changed" });
    expect(
      corroborateLocalWorkerCandidateV1(result.candidates[0], {
        sourcePath: "src/other.ts",
        sha256: H1,
      }).issue,
    ).toBe("path-mismatch");
  });

  it("cannot upgrade a structural claim without an Agent-supplied provider resolution", async () => {
    const executionPlan = plan({ intents: ["structural"], structural: "ready" });
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() =>
        wirePack({
          candidates: [{ path: "src/widget.ts", line: 3, source: "graph", hash: H1 }],
        }),
      ),
    });
    const fact = corroborateLocalWorkerCandidateV1(result.candidates[0], {
      sourcePath: "src/widget.ts",
      sha256: H1,
    }).fact;
    const assessed = assessLocalWorkerClaimV1({
      plan: executionPlan,
      result,
      intent: "structural",
      corroboration: fact ? [fact] : [],
    });
    expect(assessed.accepted).toBe(false);
    expect(assessed.reasonCodes).toContain("minimum-assurance-not-met");
  });

  it("rejects output produced by a non-local decision provider", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack({ provider: "semantic" })),
    });
    expect(result.outcome).toBe("rejected");
    expect(result.candidates).toEqual([]);
    expect(result.stopReasons).toContainEqual({
      code: "non-local-decision-provider",
      intent: null,
      blocking: true,
    });
  });
});

describe("Retrieval Worker V3 adapter: generation, snapshot and stale candidates", () => {
  it.each([
    ["generation", { expectedGeneration: 2 }, "generation-mismatch"],
    ["snapshot", { expectedSnapshot: "snap-2" }, "snapshot-mismatch"],
  ] as const)("marks a %s mismatch stale and not assessable", async (_label, scopePatch, code) => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: { ...SCOPE, ...scopePatch },
      transport: fakeTransport(() => wirePack()),
    });
    expect(result.outcome).toBe("stale");
    expect(result.freshness).toBe("stale");
    expect(result.candidates.every((c) => c.freshness === "stale")).toBe(true);
    expect(result.stopReasons).toContainEqual({ code, intent: null, blocking: true });
    expect(localWorkerCandidateRefsV1(result, "exact")).toEqual([]);
  });

  it("treats a generation change during execute as stale", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() =>
        wirePack({ status: "stale", missing: ["generation-changed"] }),
      ),
    });
    expect(result.outcome).toBe("stale");
    expect(result.stopReasons).toContainEqual({
      code: "generation-changed-during-execute",
      intent: null,
      blocking: true,
    });
  });

  it("blocks structural candidates from a non-fresh index but keeps live exact candidates", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ intents: ["exact", "structural"], structural: "ready" }),
      scope: { ...SCOPE, expectedGeneration: null, expectedSnapshot: null },
      transport: fakeTransport(() =>
        wirePack({
          scope: { freshness: "stale" },
          candidates: [
            { path: "src/widget.ts", line: 12, source: "exact", hash: H1 },
            { path: "src/graph.ts", line: 4, source: "graph", hash: H2 },
          ],
        }),
      ),
    });
    expect(result.outcome).toBe("candidates");
    expect(localWorkerCandidateRefsV1(result, "structural")).toEqual([]);
    expect(localWorkerCandidateRefsV1(result, "exact")).toEqual([
      "source://src/widget.ts",
    ]);
    expect(result.fallback).toEqual({ intent: "exact", requiresReplan: false });
  });

  it.each([
    ["degraded", "worker-status-degraded", "degraded"],
    ["unavailable", "worker-status-unavailable", "unavailable"],
    ["unsupported", "worker-status-unsupported", "unsupported"],
  ] as const)("maps Worker status %s to an explicit blocking state", async (status, code, intentState) => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => wirePack({ status })),
    });
    expect(result.stopReasons).toContainEqual({ code, intent: null, blocking: true });
    expect(result.intentStatus).toContainEqual({ intent: "exact", status: intentState });
    expect(localWorkerCandidateRefsV1(result, "exact")).toEqual([]);
  });
});

describe("Retrieval Worker V3 adapter: containment and response validation", () => {
  it.each([
    ["absolute path", "D:/host-only/SecretRoot/src/widget.ts"],
    ["parent traversal", "../outside.ts"],
    ["outside requested scope", "docs/notes.md"],
  ])("fails closed on a candidate with an %s", async (_label, candidatePath) => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ scopeHints: ["src"] }),
      scope: SCOPE,
      transport: fakeTransport(() =>
        wirePack({
          candidates: [{ path: candidatePath, line: 1, source: "exact", hash: H1 }],
        }),
      ),
    });
    expect(result.outcome).toBe("failed");
    expect(result.candidates).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("SecretRoot");
    expect(result.stopReasons).toContainEqual({
      code: "path-containment-violation",
      intent: null,
      blocking: true,
    });
  });

  it.each([
    ["unknown top-level field", wirePack({ extra: { rawWorkerOutput: "x" } })],
    ["wrong pack version", wirePack({ extra: { packVersion: 2 } })],
    ["uncorrelated query", wirePack({ query: "another query" })],
    ["not an object", "garbage"],
    [
      "more candidates than the budget",
      wirePack({
        candidates: Array.from({ length: 6 }, (_, index) => ({
          path: `src/f${index}.ts`,
          line: 1,
          source: "exact" as const,
          hash: H1,
        })),
      }),
    ],
    [
      "graph candidate for an exact-only request",
      wirePack({ candidates: [{ path: "src/a.ts", line: 1, source: "graph", hash: H1 }] }),
    ],
  ])("rejects an invalid response: %s", async (_label, response) => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan({ maxCandidatesPerStep: 5 }),
      scope: SCOPE,
      transport: fakeTransport(() => response),
    });
    expect(result.outcome).toBe("failed");
    expect(result.candidates).toEqual([]);
    expect(result.stopReasons.some((stop) => stop.code === "invalid-response")).toBe(true);
  });

  it("does not propagate transport error text", async () => {
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport: fakeTransport(() => {
        throw new Error(`ENOENT ${HOST_ROOT}\\src`);
      }),
    });
    expect(result.outcome).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("SecretRoot");
    expect(result.stopReasons).toContainEqual({
      code: "transport-failed",
      intent: null,
      blocking: true,
    });
  });
});

describe("Retrieval Worker V3 adapter: abort and timeout", () => {
  it("returns aborted promptly, aborts the transport signal and ignores a late answer", async () => {
    let release: (value: unknown) => void = () => undefined;
    const transport = fakeTransport(
      () => new Promise((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const running = runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    const result = await running;
    release(wirePack());
    expect(result.outcome).toBe("aborted");
    expect(result.candidates).toEqual([]);
    expect(transport.calls[0].signal.aborted).toBe(true);
  });

  it("does not call the Worker when the signal is already aborted", async () => {
    const transport = fakeTransport(() => wirePack());
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport,
      signal: controller.signal,
    });
    expect(result.outcome).toBe("aborted");
  });

  it("times out a transport that ignores its signal", async () => {
    const transport = fakeTransport(never);
    const started = Date.now();
    const result = await runLocalWorkerRetrievalV1({
      plan: plan(),
      scope: SCOPE,
      transport,
      timeoutMs: 20,
    });
    expect(result.outcome).toBe("timeout");
    expect(transport.calls[0].signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("Retrieval Worker verification chain and context items", () => {
  const STAGES = [
    "candidate",
    "corroborate",
    "classify-evidence",
    "check-assurance",
    "accept-or-stop",
  ];

  it("injects an uncorroborated Worker hit only as a candidate, never as a claim or evidence", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "exact",
      agentReads: [],
    });
    expect(trace.stages.map((stage) => stage.stage)).toEqual(STAGES);
    expect(trace.stages.map((stage) => stage.status)).toEqual([
      "passed",
      "stopped",
      "skipped",
      "stopped",
      "stopped",
    ]);
    expect(trace.assessment.accepted).toBe(false);
    expect(trace.contextItems).toEqual([
      expect.objectContaining({
        kind: "retrieval-candidate",
        assurance: null,
        kernelEvidence: false,
        closeEvidenceEligible: false,
        memoryEligible: false,
      }),
    ]);
  });

  it("promotes a candidate to an evidence-backed claim only after an independent Agent read", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "exact",
      agentReads: [{ sourcePath: "src/widget.ts", sha256: H1 }],
    });
    expect(trace.stages.every((stage) => stage.status === "passed")).toBe(true);
    expect(trace.contextItems).toEqual([
      expect.objectContaining({
        kind: "retrieval-claim",
        assurance: "evidence-backed",
        evidenceRef: "source://src/widget.ts",
        coverage: "complete",
        kernelEvidence: false,
        closeEvidenceEligible: false,
        memoryEligible: false,
      }),
    ]);
  });

  it("downgrades Worker timeout output to a candidate hint even after independent corroboration", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() => wirePack({ status: "timeout" })),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "exact",
      agentReads: [{ sourcePath: "src/widget.ts", sha256: H1 }],
    });
    expect(trace.assessment.accepted).toBe(false);
    expect(trace.assessment.achievedAssurance).toBeNull();
    expect(trace.assessment.reasonCodes).toContain("provider-degraded");
    expect(trace.contextItems).toEqual([
      expect.objectContaining({
        kind: "retrieval-candidate",
        assurance: null,
        coverage: "partial",
      }),
    ]);
  });

  it("drops a candidate whose content changed since the Worker observed it", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() => wirePack()),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "exact",
      agentReads: [{ sourcePath: "src/widget.ts", sha256: H2 }],
    });
    expect(trace.staleCandidates).toEqual(["src/widget.ts"]);
    expect(trace.contextItems).toEqual([]);
    expect(trace.assessment.accepted).toBe(false);
    expect(trace.stages[1]).toMatchObject({
      stage: "corroborate",
      status: "stopped",
    });
    expect(trace.stages[1].reasonCodes).toContain("content-changed");
  });

  it("stops at the candidate stage for stale output", async () => {
    const executionPlan = plan();
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: { ...SCOPE, expectedGeneration: 9 },
      transport: fakeTransport(() => wirePack()),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "exact",
      agentReads: [{ sourcePath: "src/widget.ts", sha256: H1 }],
    });
    expect(trace.stages[0]).toMatchObject({ stage: "candidate", status: "stopped" });
    expect(trace.stages[0].reasonCodes).toContain("generation-mismatch");
    expect(trace.contextItems).toEqual([]);
  });

  it("downgrades a structural request to exact and labels the downgrade", async () => {
    const executionPlan = plan({
      intents: ["exact", "structural"],
      structural: "ready",
    });
    const result = await runLocalWorkerRetrievalV1({
      plan: executionPlan,
      scope: SCOPE,
      transport: fakeTransport(() =>
        wirePack({
          scope: { freshness: "stale" },
          candidates: [{ path: "src/widget.ts", line: 12, source: "exact", hash: H1 }],
        }),
      ),
    });
    const trace = runLocalWorkerVerificationChainV1({
      plan: executionPlan,
      result,
      requestedIntent: "structural",
      agentReads: [{ sourcePath: "src/widget.ts", sha256: H1 }],
    });
    expect(trace.effectiveIntent).toBe("exact");
    expect(trace.contextItems).toEqual([
      expect.objectContaining({
        kind: "retrieval-claim",
        intent: "exact",
        downgradedFrom: "structural",
        assurance: "evidence-backed",
      }),
    ]);
  });
});

describe("Retrieval Worker readiness and recovery", () => {
  const handshake = (patch: Partial<LocalWorkerHandshakeV1> = {}): LocalWorkerHandshakeV1 => ({
    nodeVersion: "v24.3.0",
    sqliteAvailable: true,
    workerState: "ready",
    generation: 3,
    snapshot: "snap-3",
    freshness: "fresh",
    ...patch,
  });

  it.each([
    ["no handshake", null, "unavailable"],
    ["below Node 24 capability baseline", handshake({ nodeVersion: "v22.19.0" }), "unsupported"],
    ["node:sqlite missing", handshake({ sqliteAvailable: false }), "unsupported"],
    ["ready + fresh", handshake(), "ready"],
    ["ready but stale data", handshake({ freshness: "stale" }), "degraded"],
    ["stale index", handshake({ workerState: "stale" }), "degraded"],
    ["absent index", handshake({ workerState: "absent", generation: 0 }), "unavailable"],
  ] as const)("maps %s to structural %s", (_label, input, status) => {
    expect(localWorkerStructuralAvailabilityV1(input).status).toBe(status);
  });

  it("reconciles an unknown index write from generation/snapshot without replay", () => {
    const before = { generation: 3, snapshot: "snap-3" };
    expect(reconcileLocalWorkerIndexEffectV1(before, handshake({ generation: 4, snapshot: "snap-4" }))).toBe("committed");
    expect(reconcileLocalWorkerIndexEffectV1(before, handshake())).toBe("not-committed");
    expect(reconcileLocalWorkerIndexEffectV1(before, handshake({ snapshot: "other" }))).toBe("indeterminate");
    expect(reconcileLocalWorkerIndexEffectV1(before, handshake({ generation: 2 }))).toBe("indeterminate");
    expect(reconcileLocalWorkerIndexEffectV1(before, null)).toBe("indeterminate");
  });
});
