import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createContextMemoryDurabilityV1,
  fingerprintPactileContractV1,
  memoryManifestIdV1,
  memoryPartitionV1,
  type MemoryCurrentManifestV1,
  type MemoryFactDocumentV1,
} from "../../../src/core/index.js";
import { FileArtifactStore } from "../../../src/pactile/runtime/file-artifact-store.js";
import {
  openSqliteRuntimeStore,
  probeSqliteRuntimeStoreCapability,
} from "../../../src/pactile/runtime/sqlite-runtime-store.js";

const capability = probeSqliteRuntimeStoreCapability();
const roots: string[] = [];
const NOW = "2026-10-08T00:00:00.000Z";
const SCOPE_KEY = "workspace-1/project-1/run-1";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-context-memory-sqlite-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Windows may keep SQLite WAL handles for a short interval; evidence is
      // still preserved in the test output and the next run gets a new root.
    }
  }
});

function document(basisRevision = 3): MemoryFactDocumentV1 {
  return {
    schemaVersion: 1,
    kind: "memory_fact_document_v1",
    source: "artifact",
    scope: "run",
    scopeKey: SCOPE_KEY,
    basisRevision,
    facts: [
      {
        factId: `fact-${String(basisRevision)}`,
        statement: "The current run keeps the approved write set.",
        basisRevision,
        tags: ["decision"],
      },
    ],
    summaries: [
      {
        summaryId: `summary-${String(basisRevision)}`,
        statement: "The approved write set remains current.",
        derivedFrom: [`fact-${String(basisRevision)}`],
      },
    ],
  };
}

async function open(root: string) {
  return openSqliteRuntimeStore({
    projectRoot: root,
    now: () => new Date(NOW),
  });
}

describe.skipIf(!capability.supported)("real SQLite Context Memory Host Adapter", () => {
  it("commits artifact, receipt, manifest and audit, then restores them after restart", async () => {
    const root = fixture();
    const store = await open(root);
    const artifacts = new FileArtifactStore({
      storageRoot: path.join(root, ".pactile", "memory-artifacts"),
      now: () => new Date(NOW),
    });
    const memory = createContextMemoryDurabilityV1({
      artifacts,
      receipts: store,
      manifests: store,
      audits: store,
      leases: store,
      now: () => new Date(NOW),
    });
    const first = await memory.commit({
      requestId: "memory-request-1",
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "memory-artifact-1",
      version: 1,
      basisRevision: 3,
      document: document(),
      whenToRead: "Read before selecting the next write.",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.order).toEqual(["artifact", "receipt", "manifest"]);
    const replay = await memory.commit({
      requestId: "memory-request-1",
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "memory-artifact-1",
      version: 1,
      basisRevision: 3,
      document: document(),
      whenToRead: "Read before selecting the next write.",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.message);
    expect(replay.replay).toBe(true);
    expect(replay.manifestRevision).toBe(first.manifestRevision);

    const audit = await store.readMemoryAuditReceipts("run", SCOPE_KEY);
    expect(audit).toEqual([]);
    await store.close();

    const reopenedStore = await open(root);
    const reopenedArtifacts = new FileArtifactStore({
      storageRoot: path.join(root, ".pactile", "memory-artifacts"),
    });
    const reopened = createContextMemoryDurabilityV1({
      artifacts: reopenedArtifacts,
      receipts: reopenedStore,
      manifests: reopenedStore,
      audits: reopenedStore,
      leases: reopenedStore,
      now: () => new Date(NOW),
    });
    const preflight = await reopened.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 3,
      disclose: true,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(preflight.message);
    expect(preflight.status).toBe("durable");
    expect(preflight.verified).toBe(true);
    expect(preflight.externalization.path).toBe(first.storageRef);
    const contentHex = first.contentHash.slice("sha256:".length);
    fs.rmSync(path.join(root, ".pactile", "memory-artifacts", "objects", contentHex.slice(0, 2), contentHex), { force: true });
    const damaged = await reopened.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 3,
      disclose: true,
    });
    expect(damaged.ok).toBe(true);
    if (!damaged.ok) throw new Error(damaged.message);
    expect(damaged.status).toBe("unknown");
    expect(damaged.reason).toBe("artifact_missing");
    expect(damaged.assurance).toBe("assurance_unknown");
    const recovery = await reopened.recover({ scope: "run", scopeKey: SCOPE_KEY });
    expect(recovery.ok).toBe(true);
    if (!recovery.ok) throw new Error(recovery.message);
    expect(recovery.manifestTrusted).toBe(false);
    expect(recovery.effects).toMatchObject([{ receiptId: first.receiptId, reason: "effect_unknown" }]);
    await reopenedStore.close();
  });

  it("fences memory commits with the real SQLite lease epoch", async () => {
    const root = fixture();
    const store = await open(root);
    const artifacts = new FileArtifactStore({
      storageRoot: path.join(root, ".pactile", "memory-artifacts"),
      now: () => new Date(NOW),
    });
    const partition = memoryPartitionV1("run", SCOPE_KEY);
    const acquired = await store.acquireLease({
      partition,
      runId: "run-1",
      ownerId: "owner-a",
      ttlMs: 60_000,
      idempotencyKey: "memory-lease-1",
      requestHash: "memory-lease-hash-1",
    });
    const proof = {
      leaseId: acquired.value.leaseId,
      ownerId: acquired.value.ownerId,
      epoch: acquired.value.epoch,
      expiresAt: acquired.value.expiresAt,
      partition,
    };
    const memory = createContextMemoryDurabilityV1({
      artifacts,
      receipts: store,
      manifests: store,
      audits: store,
      leases: store,
      requireLease: true,
      now: () => new Date(NOW),
    });
    const accepted = await memory.commit({
      requestId: "lease-commit-1",
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "lease-artifact-1",
      version: 1,
      basisRevision: 3,
      document: document(),
      whenToRead: "Read before the next write.",
      lease: proof,
    });
    expect(accepted.ok).toBe(true);

    const takeover = await store.acquireLease({
      partition,
      runId: "run-1",
      ownerId: "owner-b",
      ttlMs: 60_000,
      idempotencyKey: "memory-lease-2",
      requestHash: "memory-lease-hash-2",
      expectedEpoch: 1,
    });
    expect(takeover.value.epoch).toBe(2);
    const stored = await store.getReceipt({ scope: "run", scopeKey: SCOPE_KEY, receiptId: accepted.receiptId });
    expect(stored.ok && stored.status === "found").toBe(true);
    if (!stored.ok || stored.status !== "found") throw new Error("expected the accepted receipt to be readable");
    const staleReceiptWrite = await store.putReceipt({
      idempotencyKey: "stale-receipt-after-takeover",
      requestHash: stored.receipt.requestHash,
      receipt: stored.receipt,
      lease: proof,
    });
    expect(staleReceiptWrite.ok).toBe(false);
    if (staleReceiptWrite.ok) throw new Error("expected receipt write fence");
    expect(staleReceiptWrite.code).toBe("memory_lease_fenced");

    const currentLookup = await store.readCurrent({ scope: "run", scopeKey: SCOPE_KEY });
    expect(currentLookup.ok && currentLookup.status === "found").toBe(true);
    if (!currentLookup.ok || currentLookup.status !== "found") throw new Error("expected current manifest");
    const currentManifest = currentLookup.manifest as MemoryCurrentManifestV1;
    const nextManifestBody = {
      schemaVersion: currentManifest.schemaVersion,
      kind: currentManifest.kind,
      manifestId: memoryManifestIdV1("run", SCOPE_KEY, currentManifest.revision + 1),
      scope: currentManifest.scope,
      scopeKey: currentManifest.scopeKey,
      revision: currentManifest.revision + 1,
      previousRevision: currentManifest.revision,
      entries: currentManifest.entries,
      committedAt: NOW,
    };
    const staleCas = await store.compareAndSwap({
      idempotencyKey: "stale-cas-after-takeover",
      requestHash: "stale-cas-after-takeover-hash",
      scope: "run",
      scopeKey: SCOPE_KEY,
      expectedRevision: currentManifest.revision,
      manifest: {
        ...nextManifestBody,
        manifestHash: fingerprintPactileContractV1({
          domain: "memory-current-manifest-hash-v1",
          ...nextManifestBody,
        }),
      },
      lease: proof,
    });
    expect(staleCas.ok).toBe(false);
    if (staleCas.ok) throw new Error("expected manifest CAS fence");
    expect(staleCas.code).toBe("memory_lease_fenced");

    const fenced = await memory.commit({
      requestId: "lease-commit-2",
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "lease-artifact-2",
      version: 2,
      basisRevision: 4,
      document: document(4),
      whenToRead: "Read before the next write.",
      lease: proof,
    });
    expect(fenced.ok).toBe(false);
    if (fenced.ok) throw new Error("expected stale lease rejection");
    expect(fenced.code).toBe("memory_lease_fenced");

    const expired = await memory.commit({
      requestId: "lease-commit-3",
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "lease-artifact-3",
      version: 3,
      basisRevision: 5,
      document: document(5),
      whenToRead: "Read before the next write.",
      lease: { ...proof, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) throw new Error("expected expired lease rejection");
    expect(expired.code).toBe("memory_lease_expired");
    await store.close();
  });

  it("rejects stale manifest CAS and serializes concurrent commits", async () => {
    const root = fixture();
    const first = await open(root);
    const second = await open(root);
    const body = {
      schemaVersion: 1 as const,
      kind: "memory_current_manifest_v1" as const,
      manifestId: memoryManifestIdV1("run", SCOPE_KEY, 1),
      scope: "run" as const,
      scopeKey: SCOPE_KEY,
      revision: 1,
      previousRevision: null,
      entries: [],
      committedAt: NOW,
    };
    const manifest = {
      ...body,
      manifestHash: fingerprintPactileContractV1({
        domain: "memory-current-manifest-hash-v1",
        ...body,
      }),
    };
    const stale = await first.compareAndSwap({
      idempotencyKey: "manifest-stale",
      requestHash: "manifest-stale-hash",
      scope: "run",
      scopeKey: SCOPE_KEY,
      expectedRevision: 2,
      manifest,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected stale CAS");
    expect(stale.code).toBe("memory_manifest_stale");

    const secondManifestBody = {
      ...body,
      manifestId: memoryManifestIdV1("run", SCOPE_KEY, 1),
    };
    const secondManifest = {
      ...secondManifestBody,
      manifestHash: fingerprintPactileContractV1({
        domain: "memory-current-manifest-hash-v1",
        ...secondManifestBody,
      }),
    };
    const outcomes = await Promise.all([
      first.compareAndSwap({
        idempotencyKey: "manifest-concurrent-a",
        requestHash: "manifest-concurrent-a-hash",
        scope: "run",
        scopeKey: SCOPE_KEY,
        expectedRevision: 0,
        manifest,
      }),
      second.compareAndSwap({
        idempotencyKey: "manifest-concurrent-b",
        requestHash: "manifest-concurrent-b-hash",
        scope: "run",
        scopeKey: SCOPE_KEY,
        expectedRevision: 0,
        manifest: secondManifest,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    const rejected = outcomes.find((outcome) => !outcome.ok);
    if (rejected === undefined || rejected.ok) throw new Error("expected one concurrent CAS refusal");
    expect(["memory_manifest_stale", "memory_cas_conflict"]).toContain(rejected.code);

    expect(memoryPartitionV1("run", SCOPE_KEY)).toContain("memory_run_");
    await Promise.all([first.close(), second.close()]);
  });
});
