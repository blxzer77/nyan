import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  memoryDurabilityFailureV1,
  memoryPartitionV1,
} from "../../../src/core/index.js";
import {
  artifactStoreFailureV1,
  type ArtifactStorePort,
} from "../../../src/pactile/agent/memory/artifact-store.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import { reconcileContextGovernanceArtifactIntentsV1 } from "../../../src/pactile/runtime/context-governance-artifact-intents.js";
import { persistContextGovernanceMemoryFailureV1 } from "../../../src/pactile/runtime/context-governance-memory.js";
import { persistContextGovernanceReceiptV1 } from "../../../src/pactile/runtime/context-governance-producer.js";
import type {
  EffectLedgerEntryV1,
  RunLedgerPort,
  RunLedgerV1,
} from "../../../src/pactile/runtime/run-ledger.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { probeSqliteRuntimeStoreCapability } from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import {
  runtimeRequestHashV1,
  type RuntimeStoreJsonObject,
} from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cg-intent-"));
  roots.push(root);
  return root;
}

function artifactTree(host: PactileRuntimeHost): Record<string, string> {
  const root = host.artifacts.diagnostics().storageRoot;
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = fs.statSync(full, { bigint: true });
      files[path.relative(root, full)] =
        `${String(stat.size)}:${String(stat.ino)}:${String(stat.mtimeNs)}`;
    }
  };
  walk(root);
  return files;
}

function baseLedger(effectOperationIds: readonly string[] = []): RunLedgerV1 {
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
    effectOperationIds,
    kernelSettlement: { status: "open", receiptId: null },
    dispatchOutboxId: null,
    revision: 1,
    updatedAt: "2026-10-10T00:00:00Z",
  };
}

function effect(operationId: string): EffectLedgerEntryV1 {
  return {
    schemaVersion: 1,
    operationId,
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    toolCallId: `tool-${operationId}`,
    operationEpoch: 1,
    inputHash: hash,
    status: "success",
    receiptId: null,
    idempotencyKey: `effect-${operationId}`,
    createdAt: "2026-10-10T00:00:00Z",
    completedAt: "2026-10-10T00:00:01Z",
  };
}

function cdr(operationId: string): RuntimeStoreJsonObject {
  return {
    schemaId: "pactile.cg.compression-decision-receipt",
    schemaVersion: 1,
    plane: "runtime",
    workspaceId: "workspace-1",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    operationEpoch: 1,
    contextOperationId: "context-operation-1",
    bodyHash: hash,
    receiptHash: hash,
    createdAt: "2026-10-10T00:00:01Z",
    provenance: { authority: "host" },
    receiptId: "cdr-1",
    requestRef: {
      schemaId: "pactile.cg.compression-decision-request",
      schemaVersion: 1,
    },
    verdict: "admitted",
    adopted: [],
    overridden: [],
    policy: { policyVersion: "policy-v1", ruleIds: [] },
    authorization: { class: "reversible", grantRef: null },
    effect: { operationId, ledgerReceiptId: null },
  } as unknown as RuntimeStoreJsonObject;
}

/** Fails the first commit of one artifact-intent step, before or after it lands. */
function lossyLedger(
  host: PactileRuntimeHost,
  step: "open" | "bind",
  mode: "lose-before" | "lose-ack" = "lose-before",
): RunLedgerPort {
  let lost = false;
  return {
    readRunLedger: (runId) => host.ledger.readRunLedger(runId),
    commitRunLedger: async (commit) => {
      if (lost || !commit.idempotencyKey.startsWith(`pactile-artifact-intent:${step}:`)) {
        return host.ledger.commitRunLedger(commit);
      }
      lost = true;
      if (mode === "lose-before") throw new Error("simulated crash before the ledger commit");
      await host.ledger.commitRunLedger(commit);
      throw new Error("simulated lost acknowledgement");
    },
  };
}

async function seed(host: PactileRuntimeHost, effects: readonly EffectLedgerEntryV1[] = []) {
  const initial = baseLedger(effects.map((entry) => entry.operationId));
  await host.ledger.commitRunLedger({
    idempotencyKey: "seed-ledger-intent-1",
    requestHash: runtimeRequestHashV1("run-ledger.seed", { initial, effects }),
    ledger: initial,
    effects,
  });
  const scopeKey = memoryScopeKeyV1({
    scope: "run",
    workspaceId: "workspace-1",
    projectId: "project-1",
    runId: "run-1",
  });
  const leaseRecord = await host.store.acquireLease({
    partition: memoryPartitionV1("run", scopeKey),
    runId: "run-1",
    ownerId: "context-memory-owner-1",
    ttlMs: 600_000,
    idempotencyKey: "context-memory-lease-intent-1",
    requestHash: hash,
  });
  if (leaseRecord.value === undefined) throw new Error("expected a lease");
  const lease = {
    leaseId: leaseRecord.value.leaseId,
    ownerId: leaseRecord.value.ownerId,
    epoch: leaseRecord.value.epoch,
    expiresAt: leaseRecord.value.expiresAt,
    partition: leaseRecord.value.partition,
  };
  return { scopeKey, lease };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** A refused memory.read: needs no committed memory, only a ledger and a lease. */
function failureRecord(
  host: PactileRuntimeHost,
  seeded: Seeded,
  name: string,
  overrides: {
    readonly ledger?: RunLedgerPort;
    readonly artifacts?: ArtifactStorePort;
    readonly now?: () => Date;
  } = {},
) {
  return {
    ledger: overrides.ledger ?? host.ledger,
    artifacts: overrides.artifacts ?? host.artifacts,
    request: {
      scope: "run" as const,
      scopeKey: seeded.scopeKey,
      basisRevision: 1,
      acknowledgeDisclosure: false,
      lease: seeded.lease,
    },
    failure: memoryDurabilityFailureV1(
      "memory_disclosure_missing",
      "the disclosure was not acknowledged",
      { scope: "run", scopeKey: seeded.scopeKey },
    ),
    workspaceId: "workspace-1",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    operationEpoch: 1,
    contextOperationId: `context-memory-${name}`,
    memoryReadArtifactId: `cg-memory-read-${name}`,
    scopeKey: seeded.scopeKey,
    version: 1,
    basisRevision: 1,
    now: overrides.now ?? (() => new Date("2026-10-10T00:00:02Z")),
    lease: seeded.lease,
  };
}

const T_CREATED = Date.parse("2026-10-10T00:00:02Z");
const BEFORE_DEADLINE = () => new Date(T_CREATED + 60_000);
const AFTER_DEADLINE = () => new Date(T_CREATED + 6 * 60_000);

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "artifact intents and the reconciler (real SQLite + file ArtifactStore)",
  () => {
    it("writes no artifact when the plan cannot be made durable, then retries cleanly", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seed(host);
        const emptyTree = artifactTree(host);
        const lost = await persistContextGovernanceMemoryFailureV1(
          failureRecord(host, seeded, "open-lost", {
            ledger: lossyLedger(host, "open"),
          }),
        );
        expect(lost).toMatchObject({ ok: false, code: "ledger_binding_failed" });
        if (lost.ok) throw new Error("expected a lost plan");
        // Nothing durable means nothing orphaned.
        expect(lost.committedArtifacts).toBeUndefined();
        expect(artifactTree(host)).toEqual(emptyTree);
        const afterLoss = await host.ledger.readRunLedger("run-1");
        expect(afterLoss?.ledger.artifactIntents ?? []).toEqual([]);

        await expect(
          persistContextGovernanceMemoryFailureV1(failureRecord(host, seeded, "open-lost")),
        ).resolves.toMatchObject({ ok: true, applied: true });
        const done = await host.ledger.readRunLedger("run-1");
        expect(done?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "bound" }),
        ]);
        expect(done?.ledger.contextOperations).toHaveLength(1);
      } finally {
        await host.close();
      }
    });

    it("finishes an interrupted binding after a restart without the caller coming back", async () => {
      const root = fixture();
      const first = await openPactileRuntimeHost({ repositoryRoot: root });
      let seeded: Seeded;
      let orphanTree: Record<string, string>;
      try {
        seeded = await seed(first);
        const crashed = await persistContextGovernanceMemoryFailureV1(
          failureRecord(first, seeded, "restart", { ledger: lossyLedger(first, "bind") }),
        );
        expect(crashed).toMatchObject({ ok: false, code: "ledger_binding_failed" });
        const pending = await first.ledger.readRunLedger("run-1");
        expect(pending?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "pending" }),
        ]);
        expect(pending?.ledger.contextOperations ?? []).toEqual([]);
        orphanTree = artifactTree(first);
        expect(Object.keys(orphanTree).length).toBeGreaterThan(0);
      } finally {
        await first.close();
      }

      const reopened = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        const result = await reconcileContextGovernanceArtifactIntentsV1({
          ledger: reopened.ledger,
          artifacts: reopened.artifacts,
          runId: "run-1",
          now: BEFORE_DEADLINE,
        });
        expect(result).toMatchObject({ ok: true, abandoned: [], pending: [] });
        expect(result.reconciled).toHaveLength(1);
        // The artifact the crashed process wrote is the one that is bound:
        // nothing was rewritten.
        expect(artifactTree(reopened)).toEqual(orphanTree);
        const bound = await reopened.ledger.readRunLedger("run-1");
        expect(bound?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "bound" }),
        ]);
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: "context-memory-restart:memory-read",
            kind: "memory_read",
            status: "failed",
          }),
        ]);
        const intent = bound?.ledger.artifactIntents?.[0];
        expect(bound?.ledger.contextOperations?.[0]?.payloadArtifactRef).toBe(
          intent?.artifacts[0]?.binding.storageRef,
        );

        // Reconciling again is a no-op, and so is the caller's late retry.
        const again = await reconcileContextGovernanceArtifactIntentsV1({
          ledger: reopened.ledger,
          artifacts: reopened.artifacts,
          runId: "run-1",
          now: AFTER_DEADLINE,
        });
        expect(again).toMatchObject({ ok: true, reconciled: [], abandoned: [], pending: [] });
        await expect(
          persistContextGovernanceMemoryFailureV1(
            failureRecord(reopened, seeded, "restart", { now: AFTER_DEADLINE }),
          ),
        ).resolves.toMatchObject({ ok: true, applied: false });
        const finalState = await reopened.ledger.readRunLedger("run-1");
        expect(finalState?.ledger.revision).toBe(bound?.ledger.revision);
        expect(artifactTree(reopened)).toEqual(orphanTree);
      } finally {
        await reopened.close();
      }
    });

    it("binds the effect payload of an interrupted CDR receipt", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const cdrEffect = effect("operation-reconcile-1");
        await seed(host, [cdrEffect]);
        const crashed = await persistContextGovernanceReceiptV1({
          ledger: lossyLedger(host, "bind"),
          artifacts: host.artifacts,
          receipt: cdr(cdrEffect.operationId),
          effect: cdrEffect,
          artifactId: "cg-cdr-reconcile-1",
          scopeKey: "run-1",
          version: 1,
          basisRevision: 2,
        });
        expect(crashed).toMatchObject({ ok: false, code: "ledger_binding_failed" });
        const before = await host.ledger.readRunLedger("run-1");
        expect(before?.effects[0]?.payloadArtifactRef ?? null).toBeNull();
        const tree = artifactTree(host);

        const result = await reconcileContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          runId: "run-1",
          now: BEFORE_DEADLINE,
        });
        expect(result.reconciled).toHaveLength(1);
        expect(artifactTree(host)).toEqual(tree);
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.missingOperationIds).toEqual([]);
        expect(after?.orphanOperationIds).toEqual([]);
        const intent = after?.ledger.artifactIntents?.[0];
        expect(intent?.state).toBe("bound");
        expect(after?.effects[0]).toMatchObject({
          operationId: cdrEffect.operationId,
          payloadType: "pactile.cg.compression-decision-receipt",
          payloadArtifactRef: intent?.artifacts[0]?.binding.storageRef,
        });
        // The caller's own retry now finds the work done.
        await expect(
          persistContextGovernanceReceiptV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            receipt: cdr(cdrEffect.operationId),
            effect: cdrEffect,
            artifactId: "cg-cdr-reconcile-1",
            scopeKey: "run-1",
            version: 1,
            basisRevision: 2,
          }),
        ).resolves.toMatchObject({ ok: true, applied: false });
      } finally {
        await host.close();
      }
    });

    it("keeps a plan pending while the ArtifactStore is failing and gives up only after its deadline", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seed(host);
        const failingArtifacts: ArtifactStorePort = {
          prepare: (input) => host.artifacts.prepare(input),
          read: (input) => host.artifacts.read(input),
          commitImmutable: async (input) =>
            artifactStoreFailureV1("artifact_io_failed", "simulated disk failure", input.artifactId),
        };
        const failed = await persistContextGovernanceMemoryFailureV1(
          failureRecord(host, seeded, "abandon", { artifacts: failingArtifacts }),
        );
        expect(failed).toMatchObject({ ok: false, code: "artifact_commit_failed" });
        // Only prepare-stage residue exists; no artifact version was committed.
        const stagedTree = artifactTree(host);
        expect(Object.keys(stagedTree).every((file) => file.startsWith("staging"))).toBe(true);

        const stillBroken = (now: () => Date) =>
          reconcileContextGovernanceArtifactIntentsV1({
            ledger: host.ledger,
            artifacts: failingArtifacts,
            runId: "run-1",
            now,
          });
        const early = await stillBroken(BEFORE_DEADLINE);
        expect(early.reconciled).toEqual([]);
        expect(early.abandoned).toEqual([]);
        expect(early.pending).toHaveLength(1);

        const late = await stillBroken(AFTER_DEADLINE);
        expect(late.reconciled).toEqual([]);
        expect(late.abandoned).toHaveLength(1);
        expect(late.pending).toEqual([]);
        const stored = await host.ledger.readRunLedger("run-1");
        expect(stored?.ledger.artifactIntents).toEqual([
          expect.objectContaining({
            state: "abandoned",
            abandonedAt: new Date(AFTER_DEADLINE()).toISOString(),
          }),
        ]);
        expect(stored?.ledger.contextOperations ?? []).toEqual([]);

        // An abandoned operation id is not silently revived with a healthy
        // store: the caller must start a new operation. Nothing was written.
        await expect(
          persistContextGovernanceMemoryFailureV1(failureRecord(host, seeded, "abandon")),
        ).resolves.toMatchObject({ ok: false, code: "ledger_conflict" });
        expect(artifactTree(host)).toEqual(stagedTree);
        await expect(
          persistContextGovernanceMemoryFailureV1(failureRecord(host, seeded, "abandon-2")),
        ).resolves.toMatchObject({ ok: true, applied: true });
        // And the reconciler does not touch a decided intent again.
        await expect(
          reconcileContextGovernanceArtifactIntentsV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            now: AFTER_DEADLINE,
          }),
        ).resolves.toMatchObject({ reconciled: [], abandoned: [], pending: [] });
      } finally {
        await host.close();
      }
    });

    it("lets two reconcilers race without binding twice, and fences a stale lease", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seed(host);
        await persistContextGovernanceMemoryFailureV1(
          failureRecord(host, seeded, "race", { ledger: lossyLedger(host, "bind") }),
        );

        // The old owner is replaced: its lease proof can no longer bind anything.
        const takeover = await host.store.acquireLease({
          partition: memoryPartitionV1("run", seeded.scopeKey),
          runId: "run-1",
          ownerId: "context-memory-owner-2",
          ttlMs: 600_000,
          idempotencyKey: "context-memory-lease-intent-2",
          requestHash: hash,
          expectedEpoch: 1,
        });
        if (takeover.value === undefined) throw new Error("expected a takeover");
        const stale = await reconcileContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          runId: "run-1",
          now: BEFORE_DEADLINE,
          lease: seeded.lease,
        });
        expect(stale.reconciled).toEqual([]);
        expect(stale.pending).toHaveLength(1);
        const unbound = await host.ledger.readRunLedger("run-1");
        expect(unbound?.ledger.contextOperations ?? []).toEqual([]);

        const fresh = {
          partition: takeover.value.partition,
          leaseId: takeover.value.leaseId,
          ownerId: takeover.value.ownerId,
          epoch: takeover.value.epoch,
        };
        const runs = await Promise.all([
          reconcileContextGovernanceArtifactIntentsV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            now: BEFORE_DEADLINE,
            lease: fresh,
          }),
          reconcileContextGovernanceArtifactIntentsV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            now: BEFORE_DEADLINE,
            lease: fresh,
          }),
        ]);
        expect(runs.every((run) => run.ok && run.pending.length === 0)).toBe(true);
        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toHaveLength(1);
        expect(bound?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "bound" }),
        ]);
        expect(bound?.ledger.revision).toBe((unbound?.ledger.revision ?? 0) + 1);
      } finally {
        await host.close();
      }
    });

    it("lets the store refuse an intent that is rewritten, removed or declared bound without proof", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const cdrEffect = effect("operation-tamper-1");
        const seeded = await seed(host, [cdrEffect]);
        await persistContextGovernanceMemoryFailureV1(
          failureRecord(host, seeded, "tamper", { ledger: lossyLedger(host, "bind") }),
        );
        await persistContextGovernanceReceiptV1({
          ledger: lossyLedger(host, "bind"),
          artifacts: host.artifacts,
          receipt: cdr(cdrEffect.operationId),
          effect: cdrEffect,
          artifactId: "cg-cdr-tamper-1",
          scopeKey: "run-1",
          version: 1,
          basisRevision: 2,
        });
        const snapshot = await host.ledger.readRunLedger("run-1");
        if (snapshot === null) throw new Error("expected a ledger");
        const base = snapshot.ledger;
        const intents = base.artifactIntents ?? [];
        expect(intents.map((intent) => intent.state)).toEqual(["pending", "pending"]);
        const [memoryIntent, receiptIntent] = intents;
        if (memoryIntent === undefined || receiptIntent === undefined)
          throw new Error("expected two intents");

        const commit = (name: string, next: Partial<RunLedgerV1>) =>
          host.ledger.commitRunLedger({
            idempotencyKey: `tamper-${name}`,
            requestHash: runtimeRequestHashV1("run-ledger.tamper", { name }),
            ledger: { ...base, ...next, commitId: `tamper-${name}`, revision: base.revision + 1 },
            effects: snapshot.effects,
          });
        const replace = (replacement: typeof memoryIntent) =>
          intents.map((intent) =>
            intent.intentId === replacement.intentId ? replacement : intent,
          );

        await expect(
          commit("plan", {
            artifactIntents: replace({ ...memoryIntent, abandonAfter: "2030-01-01T00:00:00Z" }),
          }),
        ).rejects.toThrow(/plan is immutable/u);
        await expect(
          commit("removed", { artifactIntents: [receiptIntent] }),
        ).rejects.toThrow(/cannot be removed/u);
        // Declared bound while the planned Context Operation is not in the ledger.
        await expect(
          commit("bound-no-op", { artifactIntents: replace({ ...memoryIntent, state: "bound" }) }),
        ).rejects.toThrow(/missing a planned Context Operation/u);
        // Declared bound while the planned effect payload is not on the effect.
        await expect(
          commit("bound-no-effect", { artifactIntents: replace({ ...receiptIntent, state: "bound" }) }),
        ).rejects.toThrow(/missing the effect payload binding/u);
        // A brand new intent cannot appear already decided.
        await expect(
          commit("born-bound", {
            artifactIntents: [
              ...intents,
              { ...memoryIntent, intentId: "artifact-intent-forged", state: "bound" },
            ],
          }),
        ).rejects.toThrow(/opened as pending/u);
        const untouched = await host.ledger.readRunLedger("run-1");
        expect(untouched?.ledger.revision).toBe(base.revision);

        // Once decided, an intent is final.
        await reconcileContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          runId: "run-1",
          now: BEFORE_DEADLINE,
        });
        const settled = await host.ledger.readRunLedger("run-1");
        if (settled === null) throw new Error("expected a ledger");
        expect((settled.ledger.artifactIntents ?? []).map((intent) => intent.state)).toEqual([
          "bound",
          "bound",
        ]);
        const revert = (state: "pending" | "abandoned") =>
          host.ledger.commitRunLedger({
            idempotencyKey: `tamper-revert-${state}`,
            requestHash: runtimeRequestHashV1("run-ledger.tamper", { state }),
            ledger: {
              ...settled.ledger,
              artifactIntents: (settled.ledger.artifactIntents ?? []).map((intent, index) =>
                index === 0
                  ? {
                      ...intent,
                      state,
                      abandonedAt: state === "abandoned" ? "2026-10-10T01:00:00Z" : null,
                    }
                  : intent,
              ),
              commitId: `tamper-revert-${state}`,
              revision: settled.ledger.revision + 1,
            },
            effects: settled.effects,
          });
        await expect(revert("pending")).rejects.toThrow(/already bound/u);
        await expect(revert("abandoned")).rejects.toThrow(/already bound/u);
      } finally {
        await host.close();
      }
    });
  },
);
