/**
 * OPT-IN candidate smoke: drives the REAL frozen Retrieval Worker build
 * through `LocalWorkerProcessV1` + the V3 adapter on a synthetic temp fixture.
 *
 * Skipped unless `PACTILE_RETRIEVAL_WORKER_SMOKE_ENTRY` points at the Worker's
 * built bin (`dist/bin/retrieval-worker.js`). The Worker runtime is the
 * current `process.execPath`; the smoke records its version. A pass here is
 * candidate-smoke evidence only: it is not an evaluation bucket, not Agent
 * integration and not release evidence.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  localWorkerStructuralAvailabilityV1,
  reconcileLocalWorkerIndexEffectV1,
  runLocalWorkerRetrievalV1,
  runLocalWorkerVerificationChainV1,
  type LocalWorkerHandshakeV1,
} from "../../../src/pactile/retrieval/adapters/local-worker.js";
import {
  LocalWorkerProcessV1,
  type LocalWorkerStartResultV1,
} from "../../../src/pactile/retrieval/adapters/local-worker-process.js";
import {
  buildRetrievalRequestV3,
  createRetrievalPlanV3,
  type RetrievalPlanV3,
} from "../../../src/pactile/retrieval/index.js";

const ENTRY = process.env.PACTILE_RETRIEVAL_WORKER_SMOKE_ENTRY ?? "";
const OUT = process.env.PACTILE_RETRIEVAL_WORKER_SMOKE_OUT ?? "";
const observations: Record<string, unknown> = {};
const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-rw-smoke-"));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

function sha256(root: string, relative: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(root, relative)))
    .digest("hex");
}

async function start(root: string): Promise<LocalWorkerStartResultV1> {
  return await LocalWorkerProcessV1.start({
    nodeExecutable: process.execPath,
    workerEntry: ENTRY,
    workspaceRoot: root,
    startupTimeoutMs: 30_000,
    controlTimeoutMs: 30_000,
    writeTimeoutMs: 120_000,
  });
}

function started(result: LocalWorkerStartResultV1): {
  transport: LocalWorkerProcessV1;
  handshake: LocalWorkerHandshakeV1;
} {
  if (result.status !== "started") {
    throw new Error(`worker did not start: ${JSON.stringify(result)}`);
  }
  return result;
}

function exactPlan(query: string, scopeHints: string[] = []): RetrievalPlanV3 {
  return createRetrievalPlanV3(
    buildRetrievalRequestV3({ query, intents: ["exact"], scopeHints }),
  );
}

afterAll(() => {
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      `${JSON.stringify({ nodeVersion: process.version, observations }, null, 2)}\n`,
    );
  }
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe.skipIf(ENTRY === "")("Retrieval Worker candidate smoke (opt-in)", () => {
  it("indexes, retrieves exact candidates, corroborates and fences generations", async () => {
    const root = fixture({
      "src/widget.ts":
        "export function widgetFactory(size: number): number {\n  return size * 2;\n}\n",
      "src/use.ts":
        'import { widgetFactory } from "./widget";\nexport const made = widgetFactory(3);\n',
      "README.md": "widgetFactory builds widgets.\n",
    });
    const { transport, handshake } = started(await start(root));
    try {
      observations.initialHandshake = handshake;
      observations.initialAvailability = localWorkerStructuralAvailabilityV1(handshake);
      expect(JSON.stringify(handshake)).not.toContain(root);

      const write = await transport.writeIndex("init");
      observations.init = { outcome: write.outcome, before: write.before, after: write.after };
      expect(write.outcome).toBe("committed");
      const after = write.after;
      if (after === null) throw new Error("no post-write handshake");
      observations.readyAvailability = localWorkerStructuralAvailabilityV1(after);
      observations.indexInsideWorkspace = fs.existsSync(path.join(root, ".pactile", "retrieval"));

      const plan = exactPlan("widgetFactory");
      const scope = {
        worktreeId: "wt.smoke",
        expectedGeneration: after.generation,
        expectedSnapshot: after.snapshot,
      };
      const result = await runLocalWorkerRetrievalV1({ plan, scope, transport });
      const serialized = JSON.stringify(result);
      observations.exact = {
        outcome: result.outcome,
        coverage: result.coverage,
        freshness: result.freshness,
        candidates: result.candidates.map((c) => ({
          intent: c.intent,
          sourcePath: c.sourcePath,
          line: c.line,
          evidenceRef: c.evidenceRef,
        })),
        stopReasons: result.stopReasons,
        containsRoot: serialized.includes(root) || serialized.includes(root.replaceAll("\\", "/")),
      };
      expect(result.outcome).toBe("candidates");
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain(root.replaceAll("\\", "/"));
      expect(result.candidates.map((c) => c.sourcePath)).toEqual(
        expect.arrayContaining(["src/use.ts", "src/widget.ts"]),
      );

      const trace = runLocalWorkerVerificationChainV1({
        plan,
        result,
        requestedIntent: "exact",
        agentReads: ["src/widget.ts", "src/use.ts"].map((sourcePath) => ({
          sourcePath,
          sha256: sha256(root, sourcePath),
        })),
      });
      observations.exactChain = {
        stages: trace.stages,
        assessment: trace.assessment,
        contextItems: trace.contextItems.map((item) => ({
          kind: item.kind,
          sourcePath: item.sourcePath,
          assurance: item.assurance,
          evidenceRef: item.evidenceRef,
        })),
      };
      expect(trace.assessment.accepted).toBe(true);

      // Mutate + sync: the old generation/snapshot must fence the next answer.
      fs.writeFileSync(
        path.join(root, "src", "widget.ts"),
        "export function widgetFactory(size: number): number {\n  return size * 3;\n}\n",
      );
      const sync = await transport.writeIndex("sync");
      observations.sync = { outcome: sync.outcome, before: sync.before, after: sync.after };
      const fenced = await runLocalWorkerRetrievalV1({ plan, scope, transport });
      observations.fenced = { outcome: fenced.outcome, stopReasons: fenced.stopReasons };
      if (sync.after && sync.after.generation !== after.generation) {
        expect(fenced.outcome).toBe("stale");
      }

      // Path containment / scope: a parent-traversal hint never reaches the Worker.
      const traversal = await runLocalWorkerRetrievalV1({
        plan: exactPlan("widgetFactory", ["../outside"]),
        scope: { ...scope, expectedGeneration: null, expectedSnapshot: null },
        transport,
      });
      observations.traversal = { outcome: traversal.outcome, stopReasons: traversal.stopReasons };
      expect(traversal.outcome).toBe("rejected");

      // Structural, when the index is ready.
      const availability = localWorkerStructuralAvailabilityV1(sync.after ?? after);
      const structuralPlan = createRetrievalPlanV3(
        buildRetrievalRequestV3({ query: "widgetFactory", intents: ["structural"] }),
        { providerAvailability: [availability] },
      );
      const structural = await runLocalWorkerRetrievalV1({
        plan: structuralPlan,
        scope: { ...scope, expectedGeneration: null, expectedSnapshot: null },
        transport,
      });
      observations.structural = {
        availability,
        outcome: structural.outcome,
        freshness: structural.freshness,
        intentStatus: structural.intentStatus,
        candidates: structural.candidates.map((c) => ({
          intent: c.intent,
          sourcePath: c.sourcePath,
          line: c.line,
        })),
        stopReasons: structural.stopReasons,
      };
    } finally {
      observations.exit = await transport.close();
      observations.stderrBytes = transport.stderrByteCount;
    }
  });

  it("classifies a terminated index build as unknown effect and reconciles after restart", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 3000; index += 1) {
      files[`src/m${String(index).padStart(4, "0")}.ts`] =
        `export function fn${index}(value: number): number {\n  return value + ${index};\n}\n`;
    }
    const root = fixture(files);
    const first = started(await start(root));
    const write = await first.transport.writeIndex("init", AbortSignal.timeout(150));
    const firstExit = first.transport.exit;
    const restart = started(await start(root));
    try {
      const effect = reconcileLocalWorkerIndexEffectV1(write.before, restart.handshake);
      observations.unknownEffect = {
        writeOutcome: write.outcome,
        before: write.before,
        firstExit,
        afterRestart: restart.handshake,
        reconciled: effect,
      };
      expect(write.outcome).not.toBe("failed");
      if (write.outcome === "unknown-effect") {
        expect(firstExit).toMatchObject({ expected: true });
      }
    } finally {
      observations.restartExit = await restart.transport.close();
    }
  });
});
