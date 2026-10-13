import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPactileEffectIntentV1 } from "../../../src/pactile/agent/effects/contract.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { PactileRunLedgerEffectReceiptPort } from "../../../src/pactile/runtime/run-ledger-effect-receipts.js";
import type { RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-ledger-effect-"));
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

function ledger(): RunLedgerV1 {
  return {
    schemaVersion: 1,
    ledgerId: "ledger-run-1",
    commitId: "commit-1",
    runId: "run-1",
    activeAttemptId: "attempt-1",
    activeTurnId: "turn-1",
    status: "running",
    lease: null,
    lastCursor: null,
    effectOperationIds: [],
    kernelSettlement: { status: "open", receiptId: null },
    dispatchOutboxId: null,
    revision: 1,
    updatedAt: "2026-10-10T00:00:00Z",
  };
}

function now(): () => Date {
  let sequence = 0;
  return () => new Date(`2026-10-10T00:00:0${++sequence}Z`);
}

describe("RunLedger-backed effect receipt seam", () => {
  it("commits intent and terminal receipt through one ledger port", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const initialLedger = ledger();
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-ledger-1",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger),
        ledger: initialLedger,
        effects: [],
      });
      const gateway = new PactileRunLedgerEffectReceiptPort({
        ledger: host.ledger,
        initialLedger,
        attemptId: "attempt-1",
        turnId: "turn-1",
        now: now(),
      });
      const intent = createPactileEffectIntentV1({
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "fixture-tool",
        args: { value: "synthetic" },
        operationEpoch: 1,
      });
      const admitted = await gateway.begin(intent);
      expect(admitted).toMatchObject({ ok: true, replay: false });
      const completed = await gateway.complete({
        intent,
        status: "succeeded",
        result: {
          isError: false,
          contentHash: "sha256:content",
          detailsHash: "sha256:details",
          durationMs: 2,
        },
      });
      expect(completed).toEqual({ ok: true, status: "succeeded" });
      expect(gateway.effectsKnown()).toBe(true);
      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.effects).toHaveLength(1);
      expect(snapshot?.effects[0]).toMatchObject({
        operationId: intent.effectId,
        status: "success",
        attemptId: "attempt-1",
        turnId: "turn-1",
      });
      expect(snapshot?.missingOperationIds).toEqual([]);
      expect(snapshot?.orphanOperationIds).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("keeps unknown outcomes non-replayable", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const initialLedger = ledger();
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-ledger-1",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger),
        ledger: initialLedger,
        effects: [],
      });
      const gateway = new PactileRunLedgerEffectReceiptPort({
        ledger: host.ledger,
        initialLedger,
        attemptId: "attempt-1",
        turnId: "turn-1",
        now: now(),
      });
      const intent = createPactileEffectIntentV1({
        runId: "run-1",
        toolCallId: "tool-call-unknown",
        toolName: "fixture-tool",
        args: null,
        operationEpoch: 1,
      });
      await expect(gateway.begin(intent)).resolves.toMatchObject({ ok: true });
      await expect(
        gateway.complete({
          intent,
          status: "unknown",
          result: {
            isError: true,
            contentHash: "sha256:content",
            detailsHash: "sha256:details",
            durationMs: null,
          },
          errorCode: "process-crashed",
        }),
      ).resolves.toEqual({ ok: true, status: "unknown" });
      expect(gateway.effectsKnown()).toBe(false);
      await expect(gateway.begin(intent)).resolves.toMatchObject({
        ok: false,
        code: "effect_unknown",
      });
    } finally {
      await host.close();
    }
  });
});
