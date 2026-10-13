import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeStoreConflictError,
  RuntimeStoreFencedError,
  runtimeRequestHashV1,
} from "../../../src/pactile/runtime/store-port.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import type {
  EffectLedgerEntryV1,
  RunLedgerV1,
} from "../../../src/pactile/runtime/run-ledger.js";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-run-ledger-"));
  roots.push(root);
  return root;
}

async function openHostOrSkip(
  root: string,
): Promise<PactileRuntimeHost | null> {
  try {
    return await openPactileRuntimeHost({ repositoryRoot: root });
  } catch (error) {
    expect((error as { code?: string }).code).toBe("runtime_store_unsupported");
    return null;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

function ledger(revision = 1): RunLedgerV1 {
  return {
    schemaVersion: 1,
    ledgerId: "ledger-run-1",
    commitId: `commit-${revision}`,
    runId: "run-1",
    activeAttemptId: "attempt-1",
    activeTurnId: "turn-1",
    status: "running",
    lease: null,
    lastCursor: null,
    effectOperationIds: ["operation-1"],
    kernelSettlement: { status: "open", receiptId: null },
    dispatchOutboxId: null,
    revision,
    updatedAt: `2026-10-10T00:00:0${revision}Z`,
  };
}

function effect(
  status: EffectLedgerEntryV1["status"] = "intent",
): EffectLedgerEntryV1 {
  return {
    schemaVersion: 1,
    operationId: "operation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    operationEpoch: 1,
    inputHash: runtimeRequestHashV1("run-ledger.effect", {
      toolCallId: "tool-1",
    }),
    status,
    receiptId: null,
    idempotencyKey: `effect-${status}-1`,
    createdAt: "2026-10-10T00:00:00Z",
    completedAt: null,
  };
}

describe("RunLedger host seam", () => {
  it("commits and reads back runtime ledger/effect operationIds idempotently", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const current = ledger();
      const currentEffect = effect();
      const requestHash = runtimeRequestHashV1("run-ledger.commit", {
        current,
        currentEffect,
      });
      const first = await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-commit-1",
        requestHash,
        ledger: current,
        effects: [currentEffect],
      });
      expect(first.applied).toBe(true);
      const replay = await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-commit-1",
        requestHash,
        ledger: current,
        effects: [currentEffect],
      });
      expect(replay.applied).toBe(false);
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.ledger.commitId).toBe("commit-1");
      expect(snapshot?.effects.map((entry) => entry.operationId)).toEqual([
        "operation-1",
      ]);
      expect(snapshot?.missingOperationIds).toEqual([]);
      expect(snapshot?.orphanOperationIds).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("advances one effect from intent to a terminal receipt", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const intentLedger = ledger();
      const intent = effect("intent");
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-intent-1",
        requestHash: runtimeRequestHashV1("run-ledger.intent", {
          intentLedger,
          intent,
        }),
        ledger: intentLedger,
        effects: [intent],
      });
      const terminalLedger = {
        ...intentLedger,
        commitId: "commit-2",
        revision: 2,
        updatedAt: "2026-10-10T00:00:02Z",
      } satisfies RunLedgerV1;
      const terminal = {
        ...intent,
        status: "success" as const,
        receiptId: "receipt-1",
        completedAt: "2026-10-10T00:00:02Z",
      };
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-receipt-1",
        requestHash: runtimeRequestHashV1("run-ledger.receipt", {
          terminalLedger,
          terminal,
        }),
        ledger: terminalLedger,
        effects: [terminal],
      });
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.ledger.revision).toBe(2);
      expect(snapshot?.effects[0]?.status).toBe("success");
      expect(snapshot?.effects[0]?.receiptId).toBe("receipt-1");
      expect(snapshot?.missingOperationIds).toEqual([]);
      expect(snapshot?.orphanOperationIds).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("fences a second writer that reuses the next revision", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const current = ledger();
      const currentEffect = effect();
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-fence-seed",
        requestHash: runtimeRequestHashV1("run-ledger.fence.seed", {
          current,
          currentEffect,
        }),
        ledger: current,
        effects: [currentEffect],
      });
      const first = {
        ...current,
        commitId: "commit-2-first",
        revision: 2,
        updatedAt: "2026-10-10T00:00:02Z",
      } satisfies RunLedgerV1;
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-fence-first",
        requestHash: runtimeRequestHashV1("run-ledger.fence.first", first),
        ledger: first,
        effects: [currentEffect],
      });
      const stale = {
        ...current,
        commitId: "commit-2-stale",
        revision: 2,
        updatedAt: "2026-10-10T00:00:03Z",
      } satisfies RunLedgerV1;
      await expect(
        host.ledger.commitRunLedger({
          idempotencyKey: "ledger-fence-stale",
          requestHash: runtimeRequestHashV1("run-ledger.fence.stale", stale),
          ledger: stale,
          effects: [currentEffect],
        }),
      ).rejects.toBeInstanceOf(RuntimeStoreFencedError);
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.ledger.commitId).toBe("commit-2-first");
      expect(snapshot?.ledger.revision).toBe(2);
    } finally {
      await host.close();
    }
  });

  it("reports an operationId written outside the ledger as an orphan", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const current = ledger();
      const currentEffect = effect();
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-commit-1",
        requestHash: runtimeRequestHashV1("run-ledger.commit", {
          current,
          currentEffect,
        }),
        ledger: current,
        effects: [currentEffect],
      });
      const orphan = {
        ...currentEffect,
        operationId: "operation-orphan",
        idempotencyKey: "effect-orphan-1",
      };
      await host.store.putEffect({
        idempotencyKey: "runtime-orphan-1",
        requestHash: runtimeRequestHashV1("runtime.orphan", orphan),
        receipt: {
          schemaVersion: 1,
          effectId: orphan.operationId,
          runId: orphan.runId,
          status: "pending",
          assurance: "assurance_unknown",
          result: { ledgerEntry: orphan },
          error: null,
          requestHash: orphan.inputHash,
          recordedAt: orphan.createdAt,
        },
      });
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.orphanOperationIds).toEqual(["operation-orphan"]);
    } finally {
      await host.close();
    }
  });

  it("reports a ledger operationId with no stored effect", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const current = ledger();
      const currentEffect = effect();
      const requestHash = runtimeRequestHashV1("run-ledger.commit", {
        current,
        currentEffect,
      });
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-commit-1",
        requestHash,
        ledger: current,
        effects: [currentEffect],
      });
      const stored = await host.store.getRun("run-1");
      if (stored === null) throw new Error("expected stored run");
      const missingLedger = ledger();
      const missingOperationId = "operation-missing";
      const updatedRun = {
        ...stored,
        revision: stored.revision + 1,
        metadata: {
          ...stored.metadata,
          __pactileRunLedgerV1: {
            ...missingLedger,
            commitId: "commit-2",
            effectOperationIds: ["operation-1", missingOperationId],
            revision: stored.revision + 1,
            updatedAt: "2026-10-10T00:00:02Z",
          },
        },
        updatedAt: "2026-10-10T00:00:02Z",
      };
      await host.store.putRun({
        idempotencyKey: "runtime-ledger-missing-1",
        requestHash: runtimeRequestHashV1("runtime.ledger-missing", updatedRun),
        run: updatedRun,
      });
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.missingOperationIds).toEqual([missingOperationId]);
      expect(snapshot?.orphanOperationIds).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("rejects a commit whose idempotency key changes request hash", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const current = ledger();
      const currentEffect = effect();
      await host.ledger.commitRunLedger({
        idempotencyKey: "ledger-commit-1",
        requestHash: runtimeRequestHashV1("run-ledger.commit", {
          current,
          currentEffect,
        }),
        ledger: current,
        effects: [currentEffect],
      });
      await expect(
        host.ledger.commitRunLedger({
          idempotencyKey: "ledger-commit-1",
          requestHash: runtimeRequestHashV1("run-ledger.commit", {
            changed: true,
          }),
          ledger: current,
          effects: [currentEffect],
        }),
      ).rejects.toBeInstanceOf(RuntimeStoreConflictError);
    } finally {
      await host.close();
    }
  });
});
