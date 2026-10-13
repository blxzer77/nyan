import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPactileEffectIntentV1 } from "../../../src/pactile/agent/effects/contract.js";
import {
  fingerprintPactileContractV1,
  memoryDurabilityFailureV1,
  memoryManifestIdV1,
  memoryPartitionV1,
  type MemoryCurrentManifestV1,
  type MemoryFactDocumentV1,
} from "../../../src/core/index.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import type { RuntimeStoreJsonObject } from "../../../src/pactile/runtime/store-port.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { persistContextGovernanceReceiptV1 } from "../../../src/pactile/runtime/context-governance-producer.js";
import {
  memoryReadFailureStatusV1,
  persistContextGovernanceMemoryFailureV1,
  persistContextGovernanceMemoryV1,
} from "../../../src/pactile/runtime/context-governance-memory.js";
import {
  commitGovernedContextMemoryV1,
  memoryCommitRequestIdentityV1,
  persistContextGovernanceMemoryCommitV1,
} from "../../../src/pactile/runtime/context-governance-memory-commit.js";
import { readGovernedContextMemoryV1 } from "../../../src/pactile/runtime/context-governance-memory-read.js";
import {
  RUNTIME_STORE_SQLITE_FILE_NAME,
  probeSqliteRuntimeStoreCapability,
} from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { PactileRunLedgerEffectReceiptPort } from "../../../src/pactile/runtime/run-ledger-effect-receipts.js";
import type { RunLedgerPort, RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}`;

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cg-producer-"));
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

/** Every artifact-store file with its size and identity, to prove a retry rewrites nothing. */
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

function memoryDocument(
  scopeKey: string,
  basisRevision = 1,
): MemoryFactDocumentV1 {
  return {
    schemaVersion: 1,
    kind: "memory_fact_document_v1",
    source: "artifact",
    scope: "run",
    scopeKey,
    basisRevision,
    facts: [
      {
        factId: `fact-${String(basisRevision)}`,
        statement: "The approved write set remains current.",
        basisRevision,
        tags: ["decision"],
      },
    ],
    summaries: [],
  };
}

describe("Context Governance receipt producer seam", () => {
  it("persists disclosure and memory.read as RunLedger context operations", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const initialLedger = ledger();
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-ledger-memory-1",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger),
        ledger: initialLedger,
        effects: [],
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
        ttlMs: 60_000,
        idempotencyKey: "context-memory-lease-1",
        requestHash: hash,
      });
      if (leaseRecord.value === undefined)
        throw new Error("expected context memory lease");
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const committed = await host.memory.commit({
        requestId: "memory-request-1",
        scope: "run",
        scopeKey,
        artifactId: "memory-artifact-1",
        version: 1,
        basisRevision: 1,
        document: memoryDocument(scopeKey),
        whenToRead: "Read before selecting the next write.",
        lease,
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw new Error(committed.message);
      const read = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 1,
        acknowledgeDisclosure: true,
        lease,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.message);
      const failedRead = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 1,
        acknowledgeDisclosure: false,
        lease,
      });
      expect(failedRead).toMatchObject({
        ok: false,
        code: "memory_disclosure_missing",
      });
      if (failedRead.ok) throw new Error("expected disclosure refusal");
      const failureInput = {
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 1,
          acknowledgeDisclosure: false,
          lease,
        },
        failure: failedRead,
        status: "missing" as const,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-failure-1",
        memoryReadArtifactId: "cg-memory-read-failure-1",
        scopeKey,
        version: 1,
        basisRevision: 1,
        now: () => new Date("2026-10-10T00:00:02Z"),
        lease,
      } as const;
      const failedRecord = await persistContextGovernanceMemoryFailureV1(
        failureInput,
      );
      expect(failedRecord).toMatchObject({
        ok: true,
        applied: true,
        memoryRead: {
          schemaId: "pactile.cg.memory-read-record",
          status: "missing",
          manifestRef: null,
          manifestRevision: null,
          contentHash: null,
          disclosureRecordId: null,
        },
      });
      if (!failedRecord.ok) throw new Error(failedRecord.message);
      const failedReplay = await persistContextGovernanceMemoryFailureV1(
        failureInput,
      );
      expect(failedReplay).toMatchObject({ ok: true, applied: false });
      const failureLedger = await host.ledger.readRunLedger("run-1");
      expect(failureLedger?.ledger.contextOperations).toContainEqual(
        expect.objectContaining({
          contextOperationId: "context-memory-failure-1:memory-read",
          kind: "memory_read",
          status: "failed",
        }),
      );
      const input = {
        ledger: host.ledger,
        artifacts: host.artifacts,
        read,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-1",
        restoreTokenRef: "restore-token-1",
        disclosureArtifactId: "cg-disclosure-1",
        memoryReadArtifactId: "cg-memory-read-1",
        scopeKey,
        version: 1,
        basisRevision: 1,
        now: () => new Date("2026-10-10T00:00:02Z"),
        lease,
      } as const;
      const first = await persistContextGovernanceMemoryV1(input);
      expect(first).toMatchObject({
        ok: true,
        applied: true,
        disclosure: { schemaId: "pactile.cg.disclosure-record" },
        memoryRead: { schemaId: "pactile.cg.memory-read-record", status: "ok" },
      });
      if (!first.ok) throw new Error(first.message);
      const stored = await host.ledger.readRunLedger("run-1");
      expect(stored?.missingOperationIds).toEqual([]);
      expect(stored?.orphanOperationIds).toEqual([]);
      expect(stored?.effects).toEqual([]);
      expect(stored?.ledger.contextOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "disclosure", status: "succeeded" }),
          expect.objectContaining({ kind: "memory_read", status: "succeeded" }),
        ]),
      );
      const revision = stored?.ledger.revision;
      const second = await persistContextGovernanceMemoryV1(input);
      expect(second).toMatchObject({ ok: true, applied: false });
      const replayed = await host.ledger.readRunLedger("run-1");
      expect(replayed?.ledger.revision).toBe(revision);

      const secondCommit = await host.memory.commit({
        requestId: "memory-request-artifact-missing-1",
        scope: "run",
        scopeKey,
        artifactId: "memory-artifact-missing-1",
        version: 2,
        basisRevision: 2,
        document: memoryDocument(scopeKey, 2),
        whenToRead: "Read before selecting the next write.",
        lease,
      });
      expect(secondCommit.ok).toBe(true);
      if (!secondCommit.ok) throw new Error(secondCommit.message);

      const staleRead = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 1,
        acknowledgeDisclosure: true,
        lease,
      });
      expect(staleRead).toMatchObject({
        ok: false,
        code: "memory_manifest_stale",
      });
      if (staleRead.ok) {
        throw new Error("expected a stale manifest memory read failure");
      }
      const staleFailure = await persistContextGovernanceMemoryFailureV1({
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 1,
          acknowledgeDisclosure: true,
          lease,
        },
        failure: staleRead,
        status: "stale" as const,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-stale-1",
        memoryReadArtifactId: "cg-memory-read-stale-1",
        scopeKey,
        version: 1,
        basisRevision: 1,
        now: () => new Date("2026-10-10T00:00:02.500Z"),
        lease,
      });
      expect(staleFailure).toMatchObject({
        ok: true,
        applied: true,
        memoryRead: {
          schemaId: "pactile.cg.memory-read-record",
          status: "stale",
          manifestRef: null,
          manifestRevision: null,
          contentHash: null,
          disclosureRecordId: null,
        },
      });
      const objectHex = secondCommit.contentHash.slice("sha256:".length);
      fs.rmSync(
        path.join(
          host.artifacts.diagnostics().objectRoot,
          objectHex.slice(0, 2),
          objectHex,
        ),
        { force: true },
      );
      const artifactMissingRead = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 2,
        acknowledgeDisclosure: true,
        lease,
      });
      expect(artifactMissingRead).toMatchObject({
        ok: false,
        code: "memory_artifact_missing",
      });
      if (artifactMissingRead.ok) {
        throw new Error("expected an artifact-missing memory read failure");
      }
      const artifactMissingFailureInput = {
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 2,
          acknowledgeDisclosure: true,
          lease,
        },
        failure: artifactMissingRead,
        status: "missing" as const,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-artifact-missing-1",
        memoryReadArtifactId: "cg-memory-read-artifact-missing-1",
        scopeKey,
        version: 2,
        basisRevision: 2,
        now: () => new Date("2026-10-10T00:00:03Z"),
        lease,
      } as const;
      const artifactMissingRecord =
        await persistContextGovernanceMemoryFailureV1(
          artifactMissingFailureInput,
        );
      expect(artifactMissingRecord).toMatchObject({
        ok: true,
        applied: true,
        memoryRead: {
          schemaId: "pactile.cg.memory-read-record",
          status: "missing",
          manifestRef: null,
          manifestRevision: null,
          contentHash: null,
          disclosureRecordId: null,
        },
      });

      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentLedger: RunLedgerPort = {
        readRunLedger: async (runId) => {
          const snapshot = await host.ledger.readRunLedger(runId);
          reads += 1;
          if (reads === 2) release();
          await bothRead;
          return snapshot;
        },
        commitRunLedger: (commit) => host.ledger.commitRunLedger(commit),
      };
      const concurrentInput = (suffix: string) => ({
        ...input,
        ledger: concurrentLedger,
        contextOperationId: "context-memory-concurrent-" + suffix,
        disclosureArtifactId: "cg-disclosure-concurrent-" + suffix,
        memoryReadArtifactId: "cg-memory-read-concurrent-" + suffix,
      });
      const [concurrentA, concurrentB] = await Promise.all([
        persistContextGovernanceMemoryV1(concurrentInput("a")),
        persistContextGovernanceMemoryV1(concurrentInput("b")),
      ]);
      const concurrentResults = [concurrentA, concurrentB];
      expect(
        concurrentResults.filter(
          (result): result is Extract<typeof result, { ok: true }> =>
            result.ok,
        ),
      ).toHaveLength(1);
      expect(
        concurrentResults.filter(
          (result): result is Extract<typeof result, { ok: false }> =>
            !result.ok,
        ),
      ).toMatchObject([{ ok: false, code: "ledger_binding_failed" }]);
      const afterConcurrent = await host.ledger.readRunLedger("run-1");
      expect(
        afterConcurrent?.ledger.contextOperations?.filter((operation) =>
          operation.contextOperationId.startsWith("context-memory-concurrent-"),
        ),
      ).toHaveLength(2);

      const takeover = await host.store.acquireLease({
        partition: memoryPartitionV1("run", scopeKey),
        runId: "run-1",
        ownerId: "context-memory-owner-2",
        ttlMs: 60_000,
        idempotencyKey: "context-memory-lease-2",
        requestHash: hash,
        expectedEpoch: 1,
      });
      if (takeover.value === undefined) {
        throw new Error("expected the current context memory lease");
      }
      expect(takeover.value.epoch).toBe(2);
      const currentLease = {
        leaseId: takeover.value.leaseId,
        ownerId: takeover.value.ownerId,
        epoch: takeover.value.epoch,
        expiresAt: takeover.value.expiresAt,
        partition: takeover.value.partition,
      };
      const epochRead = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 2,
        acknowledgeDisclosure: true,
        lease,
      });
      expect(epochRead).toMatchObject({
        ok: false,
        code: "memory_lease_fenced",
      });
      if (epochRead.ok) {
        throw new Error("expected a fenced memory read failure");
      }
      const epochFailure = await persistContextGovernanceMemoryFailureV1({
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 2,
          acknowledgeDisclosure: true,
          lease,
        },
        failure: epochRead,
        status: "epoch_mismatch" as const,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-epoch-1",
        memoryReadArtifactId: "cg-memory-read-epoch-1",
        scopeKey,
        version: 2,
        basisRevision: 2,
        now: () => new Date("2026-10-10T00:00:04Z"),
        lease: currentLease,
      });
      expect(epochFailure).toMatchObject({
        ok: true,
        applied: true,
        memoryRead: {
          schemaId: "pactile.cg.memory-read-record",
          status: "epoch_mismatch",
          manifestRef: null,
          manifestRevision: null,
          contentHash: null,
          disclosureRecordId: null,
        },
      });

      const thirdCommit = await host.memory.commit({
        requestId: "memory-request-manifest-conflict-1",
        scope: "run",
        scopeKey,
        artifactId: "memory-artifact-manifest-conflict-1",
        version: 3,
        basisRevision: 3,
        document: memoryDocument(scopeKey, 3),
        whenToRead: "Read before selecting the next write.",
        lease: currentLease,
      });
      expect(thirdCommit.ok).toBe(true);
      if (!thirdCommit.ok) throw new Error(thirdCommit.message);
      const currentLookup = await host.store.readCurrent({
        scope: "run",
        scopeKey,
      });
      expect(currentLookup.ok && currentLookup.status === "found").toBe(true);
      if (!currentLookup.ok || currentLookup.status !== "found") {
        throw new Error("expected current manifest for conflict injection");
      }
      const currentManifest = currentLookup.manifest as MemoryCurrentManifestV1;
      const conflictEntry = currentManifest.entries.find(
        (entry) => entry.basisRevision === 3,
      );
      if (conflictEntry === undefined) {
        throw new Error("expected the manifest entry for basis revision 3");
      }
      const conflictHash = `sha256:${"b".repeat(64)}`;
      const conflictEntries = currentManifest.entries.map((entry) =>
        entry.basisRevision === 3
          ? {
              ...entry,
              contentHash: conflictHash,
              storageRef: entry.storageRef.replace(
                entry.contentHash.slice("sha256:".length),
                conflictHash.slice("sha256:".length),
              ),
            }
          : entry,
      );
      const conflictManifestBody = {
        schemaVersion: currentManifest.schemaVersion,
        kind: currentManifest.kind,
        manifestId: memoryManifestIdV1(
          "run",
          scopeKey,
          currentManifest.revision + 1,
        ),
        scope: currentManifest.scope,
        scopeKey: currentManifest.scopeKey,
        revision: currentManifest.revision + 1,
        previousRevision: currentManifest.revision,
        entries: conflictEntries,
        committedAt: "2026-10-10T00:00:05Z",
      };
      const conflictWrite = await host.store.compareAndSwap({
        idempotencyKey: "context-memory-manifest-conflict-cas-1",
        requestHash: hash,
        scope: "run",
        scopeKey,
        expectedRevision: currentManifest.revision,
        manifest: {
          ...conflictManifestBody,
          manifestHash: fingerprintPactileContractV1({
            domain: "memory-current-manifest-hash-v1",
            ...conflictManifestBody,
          }),
        },
        lease: currentLease,
      });
      expect(conflictWrite.ok).toBe(true);
      const manifestConflictRead = await host.memory.read({
        scope: "run",
        scopeKey,
        basisRevision: 3,
        acknowledgeDisclosure: true,
        lease: currentLease,
      });
      expect(manifestConflictRead).toMatchObject({
        ok: false,
        code: "memory_receipt_conflict",
      });
      if (manifestConflictRead.ok) {
        throw new Error("expected a manifest/receipt conflict failure");
      }
      const manifestConflictFailure =
        await persistContextGovernanceMemoryFailureV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          request: {
            scope: "run" as const,
            scopeKey,
            basisRevision: 3,
            acknowledgeDisclosure: true,
            lease: currentLease,
          },
          failure: manifestConflictRead,
          status: "manifest_conflict" as const,
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: 1,
          contextOperationId: "context-memory-manifest-conflict-1",
          memoryReadArtifactId: "cg-memory-read-manifest-conflict-1",
          scopeKey,
          version: 3,
          basisRevision: 3,
          now: () => new Date("2026-10-10T00:00:06Z"),
          lease: currentLease,
        });
      expect(manifestConflictFailure).toMatchObject({
        ok: true,
        applied: true,
        memoryRead: {
          schemaId: "pactile.cg.memory-read-record",
          status: "manifest_conflict",
          manifestRef: null,
          manifestRevision: null,
          contentHash: null,
          disclosureRecordId: null,
        },
      });

      const disclosure = await host.artifacts.read({
        artifactId: first.disclosureArtifact.artifactId,
        version: first.disclosureArtifact.version,
        storageRef: first.disclosureArtifact.storageRef,
        scope: first.disclosureArtifact.scope,
        scopeKey: first.disclosureArtifact.scopeKey,
        basisRevision: first.disclosureArtifact.basisRevision,
        contentHash: first.disclosureArtifact.contentHash,
        byteLength: first.disclosureArtifact.byteLength,
      });
      expect(disclosure).toMatchObject({ ok: true });
    } finally {
      await host.close();
    }
  });

  it("writes the receipt artifact and binds it to the terminal effect", async () => {
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
      });
      const intent = createPactileEffectIntentV1({
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "fixture-tool",
        args: { value: "synthetic" },
        operationEpoch: 1,
      });
      await expect(gateway.begin(intent)).resolves.toMatchObject({ ok: true });
      await expect(
        gateway.complete({
          intent,
          status: "succeeded",
          result: {
            isError: false,
            contentHash: hash,
            detailsHash: hash,
            durationMs: 1,
          },
        }),
      ).resolves.toEqual({ ok: true, status: "succeeded" });
      const terminal = await host.ledger.readRunLedger("run-1");
      if (terminal === null || terminal.effects[0] === undefined) {
        throw new Error("expected terminal effect");
      }
      const effect = terminal.effects[0];
      const result = await persistContextGovernanceReceiptV1({
        ledger: host.ledger,
        artifacts: host.artifacts,
        receipt: cdr(effect.operationId),
        effect,
        artifactId: "cg-cdr-receipt-1",
        scopeKey: "run-1",
        version: 1,
        basisRevision: terminal.ledger.revision,
      });
      expect(result).toMatchObject({
        ok: true,
        applied: true,
        binding: { kind: "cdr", operationId: effect.operationId },
      });
      if (!result.ok) throw new Error(result.message);
      const stored = await host.ledger.readRunLedger("run-1");
      expect(stored?.missingOperationIds).toEqual([]);
      expect(stored?.orphanOperationIds).toEqual([]);
      expect(stored?.effects[0]).toMatchObject({
        operationId: effect.operationId,
        payloadType: "pactile.cg.compression-decision-receipt",
        payloadHash: hash,
        payloadArtifactRef: result.artifact.storageRef,
      });
      const artifact = await host.artifacts.read({
        artifactId: result.artifact.artifactId,
        version: result.artifact.version,
        storageRef: result.artifact.storageRef,
        scope: result.artifact.scope,
        scopeKey: result.artifact.scopeKey,
        basisRevision: result.artifact.basisRevision,
        contentHash: result.artifact.contentHash,
        byteLength: result.artifact.byteLength,
      });
      expect(artifact).toMatchObject({ ok: true });
    } finally {
      await host.close();
    }
  });

  it("replays the same payload binding without advancing the ledger", async () => {
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
      const effect = {
        schemaVersion: 1 as const,
        operationId: "operation-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        operationEpoch: 1,
        inputHash: hash,
        status: "success" as const,
        receiptId: null,
        idempotencyKey: "effect-1",
        createdAt: "2026-10-10T00:00:00Z",
        completedAt: "2026-10-10T00:00:01Z",
      };
      const effectLedger = {
        ...initialLedger,
        commitId: "commit-2",
        effectOperationIds: [effect.operationId],
        revision: 2,
        updatedAt: effect.completedAt,
      };
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-effect-1",
        requestHash: runtimeRequestHashV1("run-ledger.effect", {
          effectLedger,
          effect,
        }),
        ledger: effectLedger,
        effects: [effect],
      });
      const input = {
        ledger: host.ledger,
        artifacts: host.artifacts,
        receipt: cdr(effect.operationId),
        effect,
        artifactId: "cg-cdr-receipt-1",
        scopeKey: "run-1",
        version: 1,
        basisRevision: 2,
      };
      const mismatched = await persistContextGovernanceReceiptV1({
        ...input,
        receipt: {
          ...cdr(effect.operationId),
          runId: "run-other",
        } as unknown as RuntimeStoreJsonObject,
      });
      expect(mismatched).toMatchObject({
        ok: false,
        code: "ledger_effect_conflict",
      });
      const first = await persistContextGovernanceReceiptV1(input);
      if (!first.ok) throw new Error(first.message);
      const second = await persistContextGovernanceReceiptV1(input);
      expect(second).toMatchObject({ ok: true, applied: false });
      const stored = await host.ledger.readRunLedger("run-1");
      // seed (1) + effect (2) + intent open (3) + intent bind (4); the replay adds none.
      expect(stored?.ledger.revision).toBe(4);
    } finally {
      await host.close();
    }
  });

  it("reconciles a receipt after a crash between artifact commit and ledger binding", async () => {
    const root = fixture();
    const host = await openHostOrSkip(root);
    if (host === null) return;
    try {
      const initialLedger = ledger();
      const effect = {
        schemaVersion: 1 as const,
        operationId: "operation-crash-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        toolCallId: "tool-crash-1",
        operationEpoch: 1,
        inputHash: hash,
        status: "success" as const,
        receiptId: null,
        idempotencyKey: "effect-crash-1",
        createdAt: "2026-10-10T00:00:00Z",
        completedAt: "2026-10-10T00:00:01Z",
      };
      const effectLedger = {
        ...initialLedger,
        commitId: "commit-crash-1",
        effectOperationIds: [effect.operationId],
        revision: 2,
        updatedAt: effect.completedAt,
      };
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-effect-crash-1",
        requestHash: runtimeRequestHashV1("run-ledger.effect-crash", {
          effectLedger,
          effect,
        }),
        ledger: effectLedger,
        effects: [effect],
      });

      let commitAttempts = 0;
      const flakyLedger: RunLedgerPort = {
        readRunLedger: (runId) => host.ledger.readRunLedger(runId),
        commitRunLedger: async (input) => {
          if (input.idempotencyKey.startsWith("pactile-artifact-intent:bind:")) {
            commitAttempts += 1;
            if (commitAttempts === 1) {
              throw new Error("simulated crash after artifact commit");
            }
          }
          return host.ledger.commitRunLedger(input);
        },
      };
      const input = {
        ledger: flakyLedger,
        artifacts: host.artifacts,
        receipt: cdr(effect.operationId),
        effect,
        artifactId: "cg-cdr-crash-1",
        scopeKey: "run-1",
        version: 1,
        basisRevision: 2,
      };

      await expect(persistContextGovernanceReceiptV1(input)).resolves.toMatchObject({
        ok: false,
        code: "ledger_binding_failed",
      });
      // The artifact exists and a durable pending intent owns it.
      const crashed = await host.ledger.readRunLedger("run-1");
      expect(crashed?.ledger.artifactIntents).toEqual([
        expect.objectContaining({ state: "pending" }),
      ]);
      expect(crashed?.effects[0]?.payloadArtifactRef ?? null).toBeNull();
      const recovered = await persistContextGovernanceReceiptV1(input);
      expect(recovered).toMatchObject({ ok: true, applied: true });
      if (!recovered.ok) throw new Error(recovered.message);

      const reconciled = await host.ledger.readRunLedger("run-1");
      expect(reconciled?.missingOperationIds).toEqual([]);
      expect(reconciled?.orphanOperationIds).toEqual([]);
      expect(reconciled?.effects[0]).toMatchObject({
        operationId: effect.operationId,
        payloadType: "pactile.cg.compression-decision-receipt",
        payloadArtifactRef: recovered.artifact.storageRef,
      });
      const artifact = await host.artifacts.read({
        artifactId: recovered.artifact.artifactId,
        version: recovered.artifact.version,
        storageRef: recovered.artifact.storageRef,
        scope: recovered.artifact.scope,
        scopeKey: recovered.artifact.scopeKey,
        basisRevision: recovered.artifact.basisRevision,
        contentHash: recovered.artifact.contentHash,
        byteLength: recovered.artifact.byteLength,
      });
      expect(artifact).toMatchObject({ ok: true });
      expect(commitAttempts).toBe(2);
    } finally {
      await host.close();
    }
  });

  it("adopts the committed receipt artifact when the crash retry carries a later createdAt", async () => {
    const host = await openHostOrSkip(fixture());
    if (host === null) return;
    try {
      const initialLedger = ledger();
      const effect = {
        schemaVersion: 1 as const,
        operationId: "operation-later-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        toolCallId: "tool-later-1",
        operationEpoch: 1,
        inputHash: hash,
        status: "success" as const,
        receiptId: null,
        idempotencyKey: "effect-later-1",
        createdAt: "2026-10-10T00:00:00Z",
        completedAt: "2026-10-10T00:00:01Z",
      };
      const effectLedger = {
        ...initialLedger,
        commitId: "commit-later-1",
        effectOperationIds: [effect.operationId],
        revision: 2,
        updatedAt: effect.completedAt,
      };
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-effect-later-1",
        requestHash: runtimeRequestHashV1("run-ledger.effect-later", {
          effectLedger,
          effect,
        }),
        ledger: effectLedger,
        effects: [effect],
      });
      let attempts = 0;
      const crashingLedger: RunLedgerPort = {
        readRunLedger: (runId) => host.ledger.readRunLedger(runId),
        commitRunLedger: async (commit) => {
          if (commit.idempotencyKey.startsWith("pactile-artifact-intent:bind:")) {
            attempts += 1;
            if (attempts === 1) throw new Error("simulated crash before binding");
          }
          return host.ledger.commitRunLedger(commit);
        },
      };
      const input = {
        ledger: crashingLedger,
        artifacts: host.artifacts,
        receipt: cdr(effect.operationId),
        effect,
        artifactId: "cg-cdr-later-1",
        scopeKey: "run-1",
        version: 1,
        basisRevision: 2,
      };
      await expect(
        persistContextGovernanceReceiptV1(input),
      ).resolves.toMatchObject({ ok: false, code: "ledger_binding_failed" });
      const orphanTree = artifactTree(host);

      // Same receipt, produced again later: only createdAt moved on.
      const retried = await persistContextGovernanceReceiptV1({
        ...input,
        receipt: {
          ...cdr(effect.operationId),
          createdAt: "2026-10-10T00:05:00Z",
        } as unknown as RuntimeStoreJsonObject,
      });
      expect(retried).toMatchObject({ ok: true, applied: true });
      if (!retried.ok) throw new Error(retried.message);
      expect(artifactTree(host)).toEqual(orphanTree);
      const stored = await host.artifacts.read({
        artifactId: retried.artifact.artifactId,
        version: retried.artifact.version,
        storageRef: retried.artifact.storageRef,
        scope: retried.artifact.scope,
        scopeKey: retried.artifact.scopeKey,
        basisRevision: retried.artifact.basisRevision,
        contentHash: retried.artifact.contentHash,
        byteLength: retried.artifact.byteLength,
      });
      if (!stored.ok) throw new Error(stored.message);
      expect(
        (
          JSON.parse(new TextDecoder().decode(stored.content)) as {
            createdAt: string;
          }
        ).createdAt,
      ).toBe("2026-10-10T00:00:01Z");
      const bound = await host.ledger.readRunLedger("run-1");
      expect(bound?.effects[0]?.payloadArtifactRef).toBe(
        retried.artifact.storageRef,
      );

      // A different receipt under the same artifact id is a real conflict.
      const different = await persistContextGovernanceReceiptV1({
        ...input,
        ledger: host.ledger,
        receipt: {
          ...cdr(effect.operationId),
          createdAt: "2026-10-10T00:09:00Z",
          verdict: "blocked",
        } as unknown as RuntimeStoreJsonObject,
      });
      // The durable plan already fixes what this operation is.
      expect(different).toMatchObject({
        ok: false,
        code: "ledger_effect_conflict",
      });
      expect(artifactTree(host)).toEqual(orphanTree);
    } finally {
      await host.close();
    }
  });
});

describe("memory read failure status mapping", () => {
  it("maps durability failure codes to the contract statuses and never folds the rest", () => {
    const contract = {
      missing: [
        "memory_artifact_missing",
        "memory_manifest_absent",
        "memory_receipt_absent",
        "memory_disclosure_missing",
      ],
      stale: ["memory_artifact_stale", "memory_manifest_stale"],
      manifest_conflict: [
        "memory_cas_conflict",
        "memory_artifact_conflict",
        "memory_receipt_conflict",
        "memory_request_conflict",
      ],
      epoch_mismatch: [
        "memory_lease_missing",
        "memory_lease_fenced",
        "memory_lease_expired",
      ],
      permission_denied: ["memory_store_denied"],
      revision_mismatch: ["memory_basis_conflict"],
    } as const;
    for (const [status, codes] of Object.entries(contract)) {
      for (const code of codes) {
        expect(memoryReadFailureStatusV1(code)).toBe(status);
      }
    }
    // provider_unavailable / invalid_response / unknown have no
    // MemoryReadRecordV1 status, so they must not be recorded as one.
    for (const code of [
      "memory_store_unavailable",
      "memory_invalid_input",
      "memory_content_rejected",
      "memory_scope_mismatch",
      "memory_receipt_corrupt",
      "memory_receipt_hash_mismatch",
      "memory_manifest_corrupt",
      "memory_artifact_corrupt",
      "memory_artifact_hash_mismatch",
      "memory_artifact_scope_mismatch",
      "memory_not_durable",
      "memory_receipt_pending",
      "memory_audit_write_failed",
    ] as const) {
      expect(memoryReadFailureStatusV1(code)).toBeNull();
    }
  });
});

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "memory read failures on the real SQLite and file artifact path",
  () => {
    /**
     * Real node:sqlite connections. The wrapper only records the runtime-store
     * handle so a test can flip `PRAGMA query_only`, which is how SQLite itself
     * reports a read-only store (SQLITE_READONLY).
     */
    function capturingSqliteDriver() {
      const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (location: string) => { exec(sql: string): void };
      };
      const runtimeStores: { exec(sql: string): void }[] = [];
      class CapturingDatabaseSync extends nodeSqlite.DatabaseSync {
        constructor(location: string) {
          super(location);
          if (location.endsWith(RUNTIME_STORE_SQLITE_FILE_NAME)) {
            runtimeStores.push(this);
          }
        }
      }
      return {
        driver: () => ({ DatabaseSync: CapturingDatabaseSync }),
        runtimeStores,
      };
    }

    async function seedMemoryRun(host: PactileRuntimeHost) {
      const initialLedger = ledger();
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-ledger-status-1",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger),
        ledger: initialLedger,
        effects: [],
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
        ttlMs: 60_000,
        idempotencyKey: "context-memory-lease-status-1",
        requestHash: hash,
      });
      if (leaseRecord.value === undefined)
        throw new Error("expected context memory lease");
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const committed = await host.memory.commit({
        requestId: "memory-request-status-1",
        scope: "run",
        scopeKey,
        artifactId: "memory-artifact-status-1",
        version: 1,
        basisRevision: 1,
        document: memoryDocument(scopeKey),
        whenToRead: "Read before selecting the next write.",
        lease,
      });
      if (!committed.ok) throw new Error(committed.message);
      return {
        scopeKey,
        lease,
        committed,
        request: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 1,
          acknowledgeDisclosure: true,
          lease,
        },
        // The request that `memory.read` refuses with memory_disclosure_missing.
        refusedRequest: {
          scope: "run" as const,
          scopeKey,
          basisRevision: 1,
          acknowledgeDisclosure: false,
          lease,
        },
      };
    }

    function recordInput(
      host: PactileRuntimeHost,
      seeded: Awaited<ReturnType<typeof seedMemoryRun>>,
      failure: Parameters<
        typeof persistContextGovernanceMemoryFailureV1
      >[0]["failure"],
      name: string,
    ) {
      return {
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: seeded.request,
        failure,
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
        now: () => new Date("2026-10-10T00:00:02Z"),
        lease: seeded.lease,
      } as const;
    }

    const nullUnverified = {
      manifestRef: null,
      manifestRevision: null,
      contentHash: null,
      disclosureRecordId: null,
      factIds: [],
      exactFactCount: 0,
      summaryCount: 0,
    } as const;

    it("records a SQLite store denial as permission_denied and fails the read closed", async () => {
      const { driver, runtimeStores } = capturingSqliteDriver();
      const host = await openPactileRuntimeHost({
        repositoryRoot: fixture(),
        driver,
      });
      try {
        const seeded = await seedMemoryRun(host);
        const store = runtimeStores[0];
        if (store === undefined) throw new Error("expected the runtime store handle");

        store.exec("PRAGMA query_only = ON");
        let denied;
        try {
          denied = await host.memory.read(seeded.request);
        } finally {
          store.exec("PRAGMA query_only = OFF");
        }
        expect(denied).toMatchObject({
          ok: false,
          domain: "memory",
          code: "memory_store_denied",
          reexecute: false,
          replayPolicy: "no_automatic_replay",
        });
        if (denied.ok) throw new Error("expected a store denial");
        // Fail closed: the denied read returned no facts and left no read audit.
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toEqual([]);

        const input = recordInput(host, seeded, denied, "denied-1");
        const recorded = await persistContextGovernanceMemoryFailureV1(input);
        expect(recorded).toMatchObject({
          ok: true,
          applied: true,
          memoryRead: {
            schemaId: "pactile.cg.memory-read-record",
            status: "permission_denied",
            checks: [
              { id: "request", result: "ok" },
              { id: "memory_read", result: "fail", code: "memory_store_denied" },
            ],
            ...nullUnverified,
          },
        });
        if (!recorded.ok) throw new Error(recorded.message);

        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.missingOperationIds).toEqual([]);
        expect(bound?.orphanOperationIds).toEqual([]);
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: "context-memory-denied-1:memory-read",
            kind: "memory_read",
            status: "failed",
            payloadType: "pactile.cg.memory-read-record",
            payloadArtifactRef: recorded.memoryReadArtifact.storageRef,
          }),
        ]);

        // Replay is idempotent and does not advance the ledger.
        await expect(
          persistContextGovernanceMemoryFailureV1(input),
        ).resolves.toMatchObject({ ok: true, applied: false });
        const replayed = await host.ledger.readRunLedger("run-1");
        expect(replayed?.ledger.revision).toBe(bound?.ledger.revision);

        // A caller cannot relabel the denial as a neighbouring status.
        const relabeled = await persistContextGovernanceMemoryFailureV1({
          ...recordInput(host, seeded, denied, "denied-relabel"),
          status: "missing",
        });
        expect(relabeled).toMatchObject({
          ok: false,
          code: "input_invalid",
          message: expect.stringContaining("contradicts"),
        });
        const afterRelabel = await host.ledger.readRunLedger("run-1");
        expect(afterRelabel?.ledger.revision).toBe(bound?.ledger.revision);

        // Nothing replays the denied read automatically; a deliberate re-read
        // after the store is writable again succeeds and keeps the record.
        const reread = await host.memory.read(seeded.request);
        expect(reread.ok).toBe(true);
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toHaveLength(1);
        const kept = await host.ledger.readRunLedger("run-1");
        expect(kept?.ledger.contextOperations).toHaveLength(1);
      } finally {
        await host.close();
      }
    });

    it("keeps revision_mismatch off commit-stage conflicts and records a read-stage one", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        // The real producer of memory_basis_conflict is the commit path: the
        // same basis revision is already bound to different content.
        const conflicting = await host.memory.commit({
          requestId: "memory-request-basis-conflict-1",
          scope: "run",
          scopeKey: seeded.scopeKey,
          artifactId: "memory-artifact-basis-conflict-1",
          version: 2,
          basisRevision: 1,
          document: {
            ...memoryDocument(seeded.scopeKey),
            facts: [
              {
                factId: "fact-1-conflict",
                statement: "A different statement for the same basis revision.",
                basisRevision: 1,
                tags: ["decision"],
              },
            ],
          },
          whenToRead: "Read before selecting the next write.",
          lease: seeded.lease,
        });
        expect(conflicting).toMatchObject({
          ok: false,
          code: "memory_basis_conflict",
          stage: "manifest",
          reexecute: false,
          replayPolicy: "no_automatic_replay",
        });
        if (conflicting.ok) throw new Error("expected a basis conflict");
        expect(memoryReadFailureStatusV1(conflicting.code)).toBe(
          "revision_mismatch",
        );

        const before = await host.ledger.readRunLedger("run-1");
        const refused = await persistContextGovernanceMemoryFailureV1(
          recordInput(host, seeded, conflicting, "basis-conflict-commit"),
        );
        expect(refused).toMatchObject({
          ok: false,
          code: "input_invalid",
          message: expect.stringContaining("commit-stage"),
        });
        const afterRefusal = await host.ledger.readRunLedger("run-1");
        expect(afterRefusal?.ledger.revision).toBe(before?.ledger.revision);
        expect(afterRefusal?.ledger.contextOperations ?? []).toEqual([]);

        // durability has no read-stage producer for this code yet, so the
        // read-stage failure is constructed. It still has to land as
        // revision_mismatch with every unverified field null.
        const readStage = memoryDurabilityFailureV1(
          "memory_basis_conflict",
          "the requested basis revision is bound to different content",
          { scope: "run", scopeKey: seeded.scopeKey },
        );
        const input = recordInput(host, seeded, readStage, "basis-conflict-read");
        const recorded = await persistContextGovernanceMemoryFailureV1(input);
        expect(recorded).toMatchObject({
          ok: true,
          applied: true,
          memoryRead: {
            status: "revision_mismatch",
            checks: [
              { id: "request", result: "ok" },
              {
                id: "memory_read",
                result: "fail",
                code: "memory_basis_conflict",
              },
            ],
            ...nullUnverified,
          },
        });
        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: "context-memory-basis-conflict-read:memory-read",
            kind: "memory_read",
            status: "failed",
          }),
        ]);
        await expect(
          persistContextGovernanceMemoryFailureV1(input),
        ).resolves.toMatchObject({ ok: true, applied: false });
        const replayed = await host.ledger.readRunLedger("run-1");
        expect(replayed?.ledger.revision).toBe(bound?.ledger.revision);
      } finally {
        await host.close();
      }
    });

    it("does not record a corrupt artifact read as a neighbouring status", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const objectHex = seeded.committed.contentHash.slice("sha256:".length);
        const objectPath = path.join(
          host.artifacts.diagnostics().objectRoot,
          objectHex.slice(0, 2),
          objectHex,
        );
        fs.writeFileSync(objectPath, Buffer.from("tampered memory artifact"));
        const corrupt = await host.memory.read(seeded.request);
        expect(corrupt).toMatchObject({ ok: false, domain: "memory" });
        if (corrupt.ok) throw new Error("expected a corrupt artifact failure");
        expect(memoryReadFailureStatusV1(corrupt.code)).toBeNull();

        const before = await host.ledger.readRunLedger("run-1");
        for (const status of [undefined, "missing" as const]) {
          const refused = await persistContextGovernanceMemoryFailureV1({
            ...recordInput(host, seeded, corrupt, "corrupt-1"),
            ...(status === undefined ? {} : { status }),
          });
          expect(refused).toMatchObject({
            ok: false,
            code: "input_invalid",
            message: expect.stringContaining(
              `${corrupt.code} has no MemoryReadRecordV1 status`,
            ),
          });
        }
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(before?.ledger.revision);
        expect(after?.ledger.contextOperations ?? []).toEqual([]);
      } finally {
        await host.close();
      }
    });

    // ── artifact-first recovery ────────────────────────────────────────────

    /**
     * First ledger commit is lost. `lose-before` crashes before the ledger
     * moves; `lose-ack` lets the commit land and then reports a failure.
     */
    /**
     * Loses the first commit of the given artifact-intent step. `bind` is the
     * step after the artifacts are committed (the orphan window); `open` is the
     * step before any artifact exists.
     */
    function lossyLedger(
      host: PactileRuntimeHost,
      mode: "lose-before" | "lose-ack",
      step: "open" | "bind" = "bind",
    ): RunLedgerPort {
      let lost = false;
      return {
        readRunLedger: (runId) => host.ledger.readRunLedger(runId),
        commitRunLedger: async (commit) => {
          if (
            lost ||
            !commit.idempotencyKey.startsWith(`pactile-artifact-intent:${step}:`)
          ) {
            return host.ledger.commitRunLedger(commit);
          }
          lost = true;
          if (mode === "lose-before") {
            throw new Error("simulated crash before the ledger commit");
          }
          await host.ledger.commitRunLedger(commit);
          throw new Error("simulated lost acknowledgement");
        },
      };
    }

    /** A wall clock that moves on every call, like the default `new Date()`. */
    function advancingClock(startMs: number): () => Date {
      let tick = 0;
      return () => new Date(startMs + 1000 * tick++);
    }

    const CLOCK_START = Date.UTC(2026, 9, 10, 0, 0, 2);
    const FIRST_ATTEMPT_AT = new Date(CLOCK_START).toISOString();

    function readBinding(
      host: PactileRuntimeHost,
      binding: {
        readonly artifactId: string;
        readonly version: number;
        readonly storageRef: string;
        readonly scope: "run";
        readonly scopeKey: string;
        readonly basisRevision: number;
        readonly contentHash: string;
        readonly byteLength: number;
      },
    ) {
      return host.artifacts.read(binding);
    }

    it("adopts committed artifacts when a ledger binding failure is retried with a later clock", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const read = await host.memory.read(seeded.request);
        if (!read.ok) throw new Error(read.message);
        const input = {
          ledger: lossyLedger(host, "lose-before"),
          artifacts: host.artifacts,
          read,
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: 1,
          contextOperationId: "context-memory-rebind-1",
          restoreTokenRef: "restore-token-rebind-1",
          disclosureArtifactId: "cg-disclosure-rebind-1",
          memoryReadArtifactId: "cg-memory-read-rebind-1",
          scopeKey: seeded.scopeKey,
          version: 1,
          basisRevision: 1,
          now: advancingClock(CLOCK_START),
          lease: seeded.lease,
        };
        const beforeTree = artifactTree(host);
        const first = await persistContextGovernanceMemoryV1(input);
        expect(first).toMatchObject({
          ok: false,
          code: "ledger_binding_failed",
        });
        if (first.ok) throw new Error("expected a binding failure");

        // The unbound state is explicit: two committed, readable, immutable
        // artifacts that no RunLedger operation references yet.
        const orphans = first.committedArtifacts ?? [];
        expect(orphans).toHaveLength(2);
        for (const orphan of orphans) {
          await expect(readBinding(host, orphan)).resolves.toMatchObject({
            ok: true,
          });
        }
        const unbound = await host.ledger.readRunLedger("run-1");
        expect(unbound?.ledger.contextOperations ?? []).toEqual([]);
        // The residue is not anonymous: a durable intent owns it.
        expect(unbound?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "pending" }),
        ]);
        const orphanTree = artifactTree(host);
        expect(Object.keys(orphanTree).length).toBeGreaterThan(
          Object.keys(beforeTree).length,
        );

        // Retry with the same inputs and a later clock adopts them.
        const second = await persistContextGovernanceMemoryV1(input);
        expect(second).toMatchObject({ ok: true, applied: true });
        if (!second.ok) throw new Error(second.message);
        expect([
          second.disclosureArtifact.storageRef,
          second.memoryReadArtifact.storageRef,
        ]).toEqual(orphans.map((orphan) => orphan.storageRef));
        expect(second.disclosure.createdAt).toBe(FIRST_ATTEMPT_AT);
        expect(second.memoryRead.createdAt).toBe(FIRST_ATTEMPT_AT);
        expect(artifactTree(host)).toEqual(orphanTree);

        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.missingOperationIds).toEqual([]);
        expect(bound?.orphanOperationIds).toEqual([]);
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            kind: "disclosure",
            status: "succeeded",
            payloadArtifactRef: orphans[0]?.storageRef,
          }),
          expect.objectContaining({
            kind: "memory_read",
            status: "succeeded",
            payloadArtifactRef: orphans[1]?.storageRef,
          }),
        ]);

        // A further replay changes nothing.
        await expect(
          persistContextGovernanceMemoryV1(input),
        ).resolves.toMatchObject({ ok: true, applied: false });
        const replayed = await host.ledger.readRunLedger("run-1");
        expect(replayed?.ledger.revision).toBe(bound?.ledger.revision);
        expect(artifactTree(host)).toEqual(orphanTree);
      } finally {
        await host.close();
      }
    });

    it("reports applied=false when the ledger commit landed but its acknowledgement was lost", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const denied = await host.memory.read(seeded.refusedRequest);
        if (denied.ok) throw new Error("expected a disclosure refusal");
        const input = {
          ...recordInput(host, seeded, denied, "lost-ack-1"),
          request: seeded.refusedRequest,
          ledger: lossyLedger(host, "lose-ack"),
          now: advancingClock(CLOCK_START),
        };
        const first = await persistContextGovernanceMemoryFailureV1(input);
        expect(first).toMatchObject({ ok: false, code: "ledger_binding_failed" });
        if (first.ok) throw new Error("expected a lost acknowledgement");
        expect(first.committedArtifacts).toHaveLength(1);
        const landed = await host.ledger.readRunLedger("run-1");
        expect(landed?.ledger.contextOperations).toHaveLength(1);
        const tree = artifactTree(host);

        const second = await persistContextGovernanceMemoryFailureV1(input);
        expect(second).toMatchObject({ ok: true, applied: false });
        if (!second.ok) throw new Error(second.message);
        expect(second.memoryRead.createdAt).toBe(FIRST_ATTEMPT_AT);
        expect(second.memoryReadArtifact.storageRef).toBe(
          first.committedArtifacts?.[0]?.storageRef,
        );
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(landed?.ledger.revision);
        expect(after?.ledger.contextOperations).toHaveLength(1);
        expect(artifactTree(host)).toEqual(tree);
      } finally {
        await host.close();
      }
    });

    it("rebinds an orphaned failure artifact after the SQLite store is reopened", async () => {
      const root = fixture();
      const first = await openPactileRuntimeHost({ repositoryRoot: root });
      let orphan: { readonly storageRef: string } | undefined;
      let seededScope: string;
      let orphanTree: Record<string, string>;
      let seededLease: Awaited<ReturnType<typeof seedMemoryRun>>["lease"];
      try {
        const seeded = await seedMemoryRun(first);
        seededScope = seeded.scopeKey;
        seededLease = seeded.lease;
        const denied = await first.memory.read(seeded.refusedRequest);
        if (denied.ok) throw new Error("expected a disclosure refusal");
        const crashed = await persistContextGovernanceMemoryFailureV1({
          ...recordInput(first, seeded, denied, "reopen-1"),
          request: seeded.refusedRequest,
          ledger: lossyLedger(first, "lose-before"),
          now: advancingClock(CLOCK_START),
        });
        expect(crashed).toMatchObject({
          ok: false,
          code: "ledger_binding_failed",
        });
        if (crashed.ok) throw new Error("expected a crash before binding");
        orphan = crashed.committedArtifacts?.[0];
        orphanTree = artifactTree(first);
      } finally {
        await first.close();
      }
      if (orphan === undefined) throw new Error("expected an orphan artifact");

      // A new process: nothing is held in memory, the read is run again by the
      // caller, and the clock has moved on.
      const reopened = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        const unbound = await reopened.ledger.readRunLedger("run-1");
        expect(unbound?.ledger.contextOperations ?? []).toEqual([]);
        expect(artifactTree(reopened)).toEqual(orphanTree);

        const request = {
          scope: "run" as const,
          scopeKey: seededScope,
          basisRevision: 1,
          acknowledgeDisclosure: false,
          lease: seededLease,
        };
        const again = await reopened.memory.read(request);
        if (again.ok) throw new Error("expected the same refusal after reopen");
        const recovered = await persistContextGovernanceMemoryFailureV1({
          ledger: reopened.ledger,
          artifacts: reopened.artifacts,
          request,
          failure: again,
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: 1,
          contextOperationId: "context-memory-reopen-1",
          memoryReadArtifactId: "cg-memory-read-reopen-1",
          scopeKey: seededScope,
          version: 1,
          basisRevision: 1,
          now: () => new Date("2026-10-10T01:00:00Z"),
          lease: seededLease,
        });
        if (!recovered.ok) throw new Error(`${recovered.code}: ${recovered.message}`);
        expect(recovered).toMatchObject({ ok: true, applied: true });
        expect(recovered.memoryReadArtifact.storageRef).toBe(orphan.storageRef);
        expect(recovered.memoryRead.createdAt).toBe(FIRST_ATTEMPT_AT);
        expect(artifactTree(reopened)).toEqual(orphanTree);
        const bound = await reopened.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: "context-memory-reopen-1:memory-read",
            status: "failed",
            payloadArtifactRef: orphan.storageRef,
          }),
        ]);
      } finally {
        await reopened.close();
      }
    });

    it("returns the audited read receipt when the same read is repeated later", async () => {
      let clock = Date.UTC(2026, 9, 10, 0, 0, 0);
      const host = await openPactileRuntimeHost({
        repositoryRoot: fixture(),
        now: () => new Date(clock),
      });
      try {
        const seeded = await seedMemoryRun(host);
        clock += 1000;
        const first = await host.memory.read(seeded.request);
        clock += 1000;
        const second = await host.memory.read(seeded.request);
        if (!first.ok || !second.ok) throw new Error("expected two verified reads");
        const audits = await host.store.readMemoryAuditReceipts(
          "run",
          seeded.scopeKey,
        );
        expect(audits).toHaveLength(1);
        expect(second.readReceipt).toEqual(first.readReceipt);
        expect(audits[0]?.receiptHash).toBe(second.readReceipt.receiptHash);
      } finally {
        await host.close();
      }
    });

    it("rebinds an orphaned success record after reopen when the caller repeats the read", async () => {
      const root = fixture();
      let clock = Date.UTC(2026, 9, 10, 0, 0, 0);
      const open = () =>
        openPactileRuntimeHost({
          repositoryRoot: root,
          now: () => new Date(clock),
        });
      const recordFor = (
        host: PactileRuntimeHost,
        seeded: Awaited<ReturnType<typeof seedMemoryRun>>,
        read: Parameters<typeof persistContextGovernanceMemoryV1>[0]["read"],
        ledgerPort: RunLedgerPort,
      ) => ({
        ledger: ledgerPort,
        artifacts: host.artifacts,
        read,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-memory-reopen-success-1",
        restoreTokenRef: "restore-token-reopen-success-1",
        disclosureArtifactId: "cg-disclosure-reopen-success-1",
        memoryReadArtifactId: "cg-memory-read-reopen-success-1",
        scopeKey: seeded.scopeKey,
        version: 1,
        basisRevision: 1,
        now: () => new Date(clock),
        lease: seeded.lease,
      });

      const first = await open();
      let orphans: readonly { readonly storageRef: string }[] = [];
      let orphanTree: Record<string, string> = {};
      let originalReceiptHash = "";
      let request: Awaited<ReturnType<typeof seedMemoryRun>>["request"];
      let scopeKey: string;
      try {
        const seeded = await seedMemoryRun(first);
        request = seeded.request;
        scopeKey = seeded.scopeKey;
        clock += 1000;
        const read = await first.memory.read(seeded.request);
        if (!read.ok) throw new Error(read.message);
        originalReceiptHash = read.readReceipt.receiptHash;
        clock += 1000;
        const crashed = await persistContextGovernanceMemoryV1(
          recordFor(first, seeded, read, lossyLedger(first, "lose-before")),
        );
        expect(crashed).toMatchObject({
          ok: false,
          code: "ledger_binding_failed",
        });
        if (crashed.ok) throw new Error("expected a crash before binding");
        orphans = crashed.committedArtifacts ?? [];
        expect(orphans).toHaveLength(2);
        orphanTree = artifactTree(first);
      } finally {
        await first.close();
      }

      // New process, later clock: the in-memory read result is gone, so the
      // caller reads again. The audit log answers with the original receipt.
      clock += 10_000;
      const reopened = await open();
      try {
        const reread = await reopened.memory.read(request);
        if (!reread.ok) throw new Error(reread.message);
        expect(reread.readReceipt.receiptHash).toBe(originalReceiptHash);
        const recovered = await persistContextGovernanceMemoryV1(
          recordFor(
            reopened,
            { scopeKey, lease: request.lease } as Awaited<
              ReturnType<typeof seedMemoryRun>
            >,
            reread,
            reopened.ledger,
          ),
        );
        if (!recovered.ok)
          throw new Error(`${recovered.code}: ${recovered.message}`);
        expect(recovered.applied).toBe(true);
        expect([
          recovered.disclosureArtifact.storageRef,
          recovered.memoryReadArtifact.storageRef,
        ]).toEqual(orphans.map((orphan) => orphan.storageRef));
        expect(artifactTree(reopened)).toEqual(orphanTree);
        const bound = await reopened.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toHaveLength(2);
        await expect(
          reopened.store.readMemoryAuditReceipts("run", scopeKey),
        ).resolves.toHaveLength(1);
      } finally {
        await reopened.close();
      }
    });

    it("does not adopt an artifact that holds a different record", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const denied = await host.memory.read(seeded.refusedRequest);
        if (denied.ok) throw new Error("expected a disclosure refusal");
        const recorded = await persistContextGovernanceMemoryFailureV1({
          ...recordInput(host, seeded, denied, "different-1"),
          request: seeded.refusedRequest,
        });
        expect(recorded).toMatchObject({ ok: true, applied: true });
        const bound = await host.ledger.readRunLedger("run-1");
        const tree = artifactTree(host);

        // Same operation and artifact id, but a different failure (stale, not
        // missing). Only createdAt may differ for an artifact to be adopted.
        const stale = memoryDurabilityFailureV1(
          "memory_manifest_stale",
          "the manifest revision moved on",
          { scope: "run", scopeKey: seeded.scopeKey },
        );
        const conflicting = await persistContextGovernanceMemoryFailureV1({
          ...recordInput(host, seeded, stale, "different-1"),
          request: seeded.refusedRequest,
          now: () => new Date("2026-10-10T02:00:00Z"),
        });
        // The durable plan of the first attempt already says what this
        // operation is; a different record is refused before any write.
        expect(conflicting).toMatchObject({
          ok: false,
          code: "ledger_conflict",
        });
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(bound?.ledger.revision);
        expect(after?.ledger.contextOperations).toEqual(
          bound?.ledger.contextOperations,
        );
        expect(artifactTree(host)).toEqual(tree);
      } finally {
        await host.close();
      }
    });

    function governed(
      host: PactileRuntimeHost,
      seeded: Awaited<ReturnType<typeof seedMemoryRun>>,
      id: string,
    ) {
      return {
        memory: host.memory,
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: seeded.request,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: id,
        restoreTokenRef: `restore-token-${id}`,
        now: advancingClock(CLOCK_START),
      };
    }

    it("records a governed read, retries it after a lost ledger commit and replays idempotently", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const input = governed(host, seeded, "governed-ok-1");

        // The read lands, binding fails: the read is handed back for a retry.
        const lost = await readGovernedContextMemoryV1({
          ...input,
          ledger: lossyLedger(host, "lose-before"),
        });
        expect(lost).toMatchObject({
          ok: false,
          stage: "record",
          read: { ok: true },
          recordFailure: { code: "ledger_binding_failed" },
        });
        if (lost.ok || lost.stage !== "record") throw new Error("expected a record failure");
        expect(lost.recordFailure.committedArtifacts).toHaveLength(2);
        const orphanTree = artifactTree(host);

        const first = await readGovernedContextMemoryV1(input);
        expect(first).toMatchObject({ ok: true, recorded: { applied: true } });
        if (!first.ok) throw new Error("expected a recorded read");
        expect(first.read.readReceipt).toEqual(lost.read.readReceipt);
        expect(artifactTree(host)).toEqual(orphanTree);
        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({ kind: "disclosure", status: "succeeded" }),
          expect.objectContaining({ kind: "memory_read", status: "succeeded" }),
        ]);

        await expect(readGovernedContextMemoryV1(input)).resolves.toMatchObject({
          ok: true,
          recorded: { applied: false },
        });
        const replayed = await host.ledger.readRunLedger("run-1");
        expect(replayed?.ledger.revision).toBe(bound?.ledger.revision);
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toHaveLength(1);
      } finally {
        await host.close();
      }
    });

    it("records a refused governed read once and never replays it", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const input = {
          ...governed(host, seeded, "governed-refused-1"),
          request: seeded.refusedRequest,
        };
        const first = await readGovernedContextMemoryV1(input);
        expect(first).toMatchObject({
          ok: false,
          stage: "read",
          failure: {
            code: "memory_disclosure_missing",
            reexecute: false,
            replayPolicy: "no_automatic_replay",
          },
          record: {
            kind: "recorded",
            result: {
              applied: true,
              memoryRead: { status: "missing", ...nullUnverified },
            },
          },
        });
        await expect(readGovernedContextMemoryV1(input)).resolves.toMatchObject({
          ok: false,
          stage: "read",
          record: { kind: "recorded", result: { applied: false } },
        });
        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toHaveLength(1);
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toEqual([]);
      } finally {
        await host.close();
      }
    });

    it("fails closed when a retried governed read changes outcome, and does not record unrepresentable failures", async () => {
      const { driver, runtimeStores } = capturingSqliteDriver();
      const host = await openPactileRuntimeHost({
        repositoryRoot: fixture(),
        driver,
      });
      try {
        const seeded = await seedMemoryRun(host);
        const store = runtimeStores[0];
        if (store === undefined) throw new Error("expected the runtime store handle");
        const input = governed(host, seeded, "governed-denied-1");
        const emptyTree = artifactTree(host);

        // A read-only store denies the read, and the same store cannot take the
        // ledger write either: the denial is returned, the record is not bound.
        store.exec("PRAGMA query_only = ON");
        let denied;
        try {
          denied = await readGovernedContextMemoryV1(input);
        } finally {
          store.exec("PRAGMA query_only = OFF");
        }
        expect(denied).toMatchObject({
          ok: false,
          stage: "read",
          failure: { code: "memory_store_denied" },
          record: {
            kind: "record_failed",
            failure: { code: "ledger_binding_failed" },
          },
        });
        const unbound = await host.ledger.readRunLedger("run-1");
        expect(unbound?.ledger.contextOperations ?? []).toEqual([]);
        // The plan could not be made durable, so no artifact was written.
        expect(unbound?.ledger.artifactIntents ?? []).toEqual([]);
        expect(artifactTree(host)).toEqual(emptyTree);

        // Nothing durable exists for that id, so repeating it is a clean first
        // attempt rather than an adoption.
        await expect(readGovernedContextMemoryV1(input)).resolves.toMatchObject({
          ok: true,
          recorded: { applied: true },
        });

        // Once an attempt is durable, the same id with a different outcome (a
        // recorded refusal, then a successful read) is not adopted.
        const refusedInput = {
          ...governed(host, seeded, "governed-changed-1"),
          request: seeded.refusedRequest,
        };
        await expect(
          readGovernedContextMemoryV1(refusedInput),
        ).resolves.toMatchObject({
          ok: false,
          stage: "read",
          record: { kind: "recorded", result: { applied: true } },
        });
        const bindingsBefore = await host.ledger.readRunLedger("run-1");
        const changed = await readGovernedContextMemoryV1(
          governed(host, seeded, "governed-changed-1"),
        );
        expect(changed).toMatchObject({
          ok: false,
          stage: "record",
          recordFailure: { code: "ledger_conflict" },
        });
        const bindingsAfter = await host.ledger.readRunLedger("run-1");
        expect(bindingsAfter?.ledger.revision).toBe(
          bindingsBefore?.ledger.revision,
        );

        // A new operation id is a new read.
        await expect(
          readGovernedContextMemoryV1(governed(host, seeded, "governed-denied-2")),
        ).resolves.toMatchObject({ ok: true, recorded: { applied: true } });

        // Corrupt data has no MemoryReadRecordV1 status: returned, not recorded.
        const objectHex = seeded.committed.contentHash.slice("sha256:".length);
        fs.writeFileSync(
          path.join(
            host.artifacts.diagnostics().objectRoot,
            objectHex.slice(0, 2),
            objectHex,
          ),
          Buffer.from("tampered memory artifact"),
        );
        const before = await host.ledger.readRunLedger("run-1");
        const corrupt = await readGovernedContextMemoryV1(
          governed(host, seeded, "governed-corrupt-1"),
        );
        expect(corrupt).toMatchObject({
          ok: false,
          stage: "read",
          record: {
            kind: "not_representable",
            reason: expect.stringContaining("has no MemoryReadRecordV1 status"),
          },
        });
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(before?.ledger.revision);

        await expect(
          readGovernedContextMemoryV1({
            ...governed(host, seeded, "governed-scope-1"),
            request: { ...seeded.request, scope: "workspace" as never },
          }),
        ).resolves.toMatchObject({ ok: false, stage: "input" });
      } finally {
        await host.close();
      }
    });

    function governedCommit(
      host: PactileRuntimeHost,
      seeded: Awaited<ReturnType<typeof seedMemoryRun>>,
      id: string,
      request: Partial<Parameters<PactileRuntimeHost["memory"]["commit"]>[0]> = {},
    ) {
      return {
        memory: host.memory,
        ledger: host.ledger,
        artifacts: host.artifacts,
        request: {
          requestId: `memory-request-${id}`,
          scope: "run" as const,
          scopeKey: seeded.scopeKey,
          artifactId: `memory-artifact-${id}`,
          version: 2,
          basisRevision: 2,
          document: memoryDocument(seeded.scopeKey, 2),
          whenToRead: "Read before selecting the next write.",
          lease: seeded.lease,
          ...request,
        },
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: `context-${id}`,
        now: advancingClock(CLOCK_START),
      };
    }

    const unverifiedCommit = {
      artifactRef: null,
      contentHash: null,
      memoryReceiptId: null,
      memoryReceiptHash: null,
      manifestId: null,
      manifestRevision: null,
      manifestHash: null,
    } as const;

    it("binds a governed memory commit, retries it after a lost ledger commit and replays idempotently", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const input = governedCommit(host, seeded, "commit-ok-1");

        const lost = await commitGovernedContextMemoryV1({
          ...input,
          ledger: lossyLedger(host, "lose-before"),
        });
        expect(lost).toMatchObject({
          ok: false,
          stage: "record",
          commit: { ok: true, replay: false },
          recordFailure: { code: "ledger_binding_failed" },
        });
        const orphanTree = artifactTree(host);

        // The Memory Port commit is durable; only the binding was lost.
        const first = await commitGovernedContextMemoryV1(input);
        expect(first).toMatchObject({
          ok: true,
          commit: { replay: true },
          recorded: {
            applied: true,
            memoryCommit: {
              status: "ok",
              progress: { artifact: true, receipt: true, manifest: true },
            },
          },
        });
        if (!first.ok) throw new Error("expected a recorded commit");
        expect(first.recorded.memoryCommit).toMatchObject({
          artifactRef: first.commit.storageRef,
          contentHash: first.commit.contentHash,
          memoryReceiptId: first.commit.receiptId,
          manifestRevision: first.commit.manifestRevision,
          manifestHash: first.commit.manifestHash,
        });
        expect(artifactTree(host)).toEqual(orphanTree);

        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: "context-commit-ok-1:memory-commit",
            kind: "memory_commit",
            status: "succeeded",
            payloadType: "pactile.cg.memory-commit-record",
          }),
        ]);
        await expect(commitGovernedContextMemoryV1(input)).resolves.toMatchObject({
          ok: true,
          recorded: { applied: false },
        });
        const replayed = await host.ledger.readRunLedger("run-1");
        expect(replayed?.ledger.revision).toBe(bound?.ledger.revision);
        const receipts = await host.store.listReceipts({
          scope: "run",
          scopeKey: seeded.scopeKey,
        });
        if (!receipts.ok) throw new Error(receipts.message);
        expect(receipts.receipts).toHaveLength(2);
      } finally {
        await host.close();
      }
    });

    it("records a real basis conflict as revision_mismatch with the partial commit progress", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const input = governedCommit(host, seeded, "commit-basis-1", {
          basisRevision: 1,
          document: {
            ...memoryDocument(seeded.scopeKey),
            facts: [
              {
                factId: "fact-1-other",
                statement: "A different statement for the same basis revision.",
                basisRevision: 1,
                tags: ["decision"],
              },
            ],
          },
        });
        const first = await commitGovernedContextMemoryV1(input);
        expect(first).toMatchObject({
          ok: false,
          stage: "commit",
          failure: {
            code: "memory_basis_conflict",
            reexecute: false,
            replayPolicy: "no_automatic_replay",
          },
          record: {
            kind: "recorded",
            result: {
              applied: true,
              memoryCommit: {
                status: "revision_mismatch",
                // The artifact and receipt landed; the manifest did not.
                progress: { artifact: true, receipt: true, manifest: false },
                ...unverifiedCommit,
              },
            },
          },
        });
        const bound = await host.ledger.readRunLedger("run-1");
        expect(bound?.ledger.contextOperations).toEqual([
          expect.objectContaining({ kind: "memory_commit", status: "failed" }),
        ]);

        // Recorded once; repeating the call never replays the commit.
        const again = await commitGovernedContextMemoryV1(input);
        expect(again).toMatchObject({
          ok: false,
          stage: "commit",
          record: { kind: "recorded", result: { applied: false } },
        });
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(bound?.ledger.revision);
        const receipts = await host.store.listReceipts({
          scope: "run",
          scopeKey: seeded.scopeKey,
        });
        if (!receipts.ok) throw new Error(receipts.message);
        expect(receipts.receipts).toHaveLength(2);
      } finally {
        await host.close();
      }
    });

    it("refuses to bind a different commit record under an operation id that is already bound", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const input = governedCommit(host, seeded, "commit-bound-1");
        const committed = await host.memory.commit(input.request);
        if (!committed.ok) throw new Error(committed.message);
        const persistInput = {
          ledger: host.ledger,
          artifacts: host.artifacts,
          request: memoryCommitRequestIdentityV1(input.request),
          outcome: { kind: "committed" as const, facts: committed },
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: 1,
          contextOperationId: "context-commit-bound-1",
          memoryCommitArtifactId: "cg-memory-commit-bound-a",
          artifactScopeKey: seeded.scopeKey,
          artifactVersion: 1,
        };
        await expect(
          persistContextGovernanceMemoryCommitV1(persistInput),
        ).resolves.toMatchObject({ ok: true, applied: true });
        const before = await host.ledger.readRunLedger("run-1");
        const treeBefore = artifactTree(host);

        // Same operation id, different record (a failed outcome, new artifact).
        const different = await persistContextGovernanceMemoryCommitV1({
          ...persistInput,
          memoryCommitArtifactId: "cg-memory-commit-bound-b",
          outcome: {
            kind: "failed",
            failure: memoryDurabilityFailureV1(
              "memory_manifest_stale",
              "the manifest revision moved on",
              { scope: "run", scopeKey: seeded.scopeKey },
            ),
          },
        });
        // Refused by the durable plan before any artifact is written.
        expect(different).toMatchObject({
          ok: false,
          code: "ledger_conflict",
        });
        if (different.ok) throw new Error("expected a conflict");
        expect(different.committedArtifacts).toBeUndefined();
        expect(artifactTree(host)).toEqual(treeBefore);
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.contextOperations).toEqual(
          before?.ledger.contextOperations,
        );
      } finally {
        await host.close();
      }
    });

    it("fences a stale epoch out of the RunLedger and refuses unrepresentable commit failures", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const takeover = await host.store.acquireLease({
          partition: memoryPartitionV1("run", seeded.scopeKey),
          runId: "run-1",
          ownerId: "context-memory-owner-2",
          ttlMs: 60_000,
          idempotencyKey: "context-memory-lease-commit-2",
          requestHash: hash,
          expectedEpoch: 1,
        });
        expect(takeover.value?.epoch).toBe(2);

        // The old owner still holds epoch 1: the commit is fenced and its
        // record cannot be bound with the same stale proof.
        const stale = await commitGovernedContextMemoryV1(
          governedCommit(host, seeded, "commit-stale-1"),
        );
        expect(stale).toMatchObject({
          ok: false,
          stage: "commit",
          failure: { code: "memory_lease_fenced" },
          record: { kind: "record_failed" },
        });
        const unbound = await host.ledger.readRunLedger("run-1");
        expect(unbound?.ledger.contextOperations ?? []).toEqual([]);

        // The current owner commits something the Port rejects: no status
        // fits, so nothing is recorded as a memory commit.
        const current = {
          leaseId: takeover.value?.leaseId ?? "",
          ownerId: takeover.value?.ownerId ?? "",
          epoch: takeover.value?.epoch ?? 0,
          expiresAt: takeover.value?.expiresAt ?? "",
          partition: takeover.value?.partition ?? "",
        };
        const rejected = await commitGovernedContextMemoryV1(
          governedCommit(host, seeded, "commit-rejected-1", {
            lease: current,
            document: { ...memoryDocument(seeded.scopeKey, 2), basisRevision: 9 },
          }),
        );
        expect(rejected).toMatchObject({
          ok: false,
          stage: "commit",
          record: {
            kind: "not_representable",
            reason: expect.stringContaining("has no MemoryCommitRecordV1 status"),
          },
        });
        const after = await host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(unbound?.ledger.revision);
      } finally {
        await host.close();
      }
    });

    it("leaves a conflicting commit's receipt observable as pending and does not grow on retry", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const seeded = await seedMemoryRun(host);
        const conflictingCommit = {
          requestId: "memory-request-orphan-1",
          scope: "run" as const,
          scopeKey: seeded.scopeKey,
          artifactId: "memory-artifact-orphan-1",
          version: 2,
          basisRevision: 1,
          document: {
            ...memoryDocument(seeded.scopeKey),
            facts: [
              {
                factId: "fact-1-orphan",
                statement: "A different statement for the same basis revision.",
                basisRevision: 1,
                tags: ["decision"],
              },
            ],
          },
          whenToRead: "Read before selecting the next write.",
          lease: seeded.lease,
        };
        const first = await host.memory.commit(conflictingCommit);
        expect(first).toMatchObject({
          ok: false,
          code: "memory_basis_conflict",
          progress: { artifact: true, receipt: true, manifest: false },
        });
        const receipts = await host.store.listReceipts({
          scope: "run",
          scopeKey: seeded.scopeKey,
        });
        if (!receipts.ok) throw new Error(receipts.message);
        expect(receipts.receipts).toHaveLength(2);
        const tree = artifactTree(host);

        // The orphan is reported, never trusted, never replayed.
        const recovery = await host.memory.recover({
          scope: "run",
          scopeKey: seeded.scopeKey,
        });
        if (!recovery.ok) throw new Error(recovery.message);
        expect(recovery.manifestTrusted).toBe(true);
        expect(recovery.effects).toEqual([
          expect.objectContaining({
            status: "waiting",
            assurance: "assurance_unknown",
            reexecute: false,
            reason: "effect_pending",
          }),
        ]);

        const retry = await host.memory.commit(conflictingCommit);
        expect(retry).toMatchObject({
          ok: false,
          code: "memory_basis_conflict",
        });
        const after = await host.store.listReceipts({
          scope: "run",
          scopeKey: seeded.scopeKey,
        });
        if (!after.ok) throw new Error(after.message);
        expect(after.receipts).toHaveLength(2);
        expect(artifactTree(host)).toEqual(tree);
      } finally {
        await host.close();
      }
    });
  },
);
