import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  memoryPartitionV1,
  type MemoryFactDocumentV1,
} from "../../../src/core/index.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import { parseArtifactStorageRefV1 } from "../../../src/pactile/agent/memory/artifact-store.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import {
  checkpointWriterFromPiSession,
  PactileContextPipeline,
} from "../../../src/pactile/agent/context-pipeline.js";
import { FilePiSessionManager } from "../../../src/pactile/runtime/pi-session-manager.js";
import { createContextGovernancePipelineReceiptProducerV1 } from "../../../src/pactile/runtime/context-governance-pipeline-producer.js";
import {
  createKernelApprovalVerifierV1,
  createRunLedgerContextReviewGateV1,
  openContextReviewV1,
  resolveContextReviewV1,
} from "../../../src/pactile/runtime/context-governance-review.js";
import { productKernelRequestHashV1 } from "../../../src/core/index.js";
import { openPactileRuntimeHost, type PactileRuntimeHost } from "../../../src/pactile/runtime/runtime-host.js";
import type { EffectLedgerEntryV1, RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const NOW = "2026-10-10T00:00:00.000Z";
const SCOPE_KEY = memoryScopeKeyV1({
  scope: "run",
  workspaceId: "workspace-1",
  projectId: "project-1",
  runId: "run-1",
});
const HASH = `sha256:${"a".repeat(64)}`;

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cg-pipeline-"));
  roots.push(root);
  return root;
}

async function openHostOrSkip(root: string): Promise<PactileRuntimeHost | null> {
  try {
    return await openPactileRuntimeHost({ repositoryRoot: root, now: () => new Date(NOW) });
  } catch (error) {
    expect((error as { code?: string }).code).toBe("runtime_store_unsupported");
    return null;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "pactile-test",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function memoryDocument(basisRevision: number): MemoryFactDocumentV1 {
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
        statement: "The native Context pipeline keeps the approved write set.",
        basisRevision,
        tags: ["context"],
      },
    ],
    summaries: [
      {
        summaryId: `summary-${String(basisRevision)}`,
        statement: "The approved write set remains current after compaction.",
        derivedFrom: [`fact-${String(basisRevision)}`],
      },
    ],
  };
}

function initialLedger(): RunLedgerV1 {
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
    updatedAt: NOW,
  };
}

function terminalEffect(operationId: string, toolCallId: string): EffectLedgerEntryV1 {
  return {
    schemaVersion: 1,
    operationId,
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    toolCallId,
    operationEpoch: 1,
    inputHash: HASH,
    status: "success",
    receiptId: null,
    idempotencyKey: `${operationId}:idempotency`,
    createdAt: NOW,
    completedAt: "2026-10-10T00:00:02.000Z",
  };
}

describe("Context Governance native pipeline ledger integration", () => {
  it("holds new compaction while a review is pending and resumes once it is decided", async () => {
    const root = fixture();
    const host = await openHostOrSkip(root);
    if (host === null) return;
    try {
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-review-ledger",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger()),
        ledger: initialLedger(),
        effects: [],
      });
      const leaseRecord = await host.store.acquireLease({
        partition: memoryPartitionV1("run", SCOPE_KEY),
        runId: "run-1",
        ownerId: "context-owner-1",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-1",
        requestHash: HASH,
      });
      if (leaseRecord.value === undefined) throw new Error("lease acquisition failed");
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const now = () => new Date(NOW);
      const opened = await openContextReviewV1({
        ledger: host.ledger,
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-operation-held",
        subject: { source: "cdq", receiptId: "cdq-1", payloadHash: null, manifestRef: null },
        expiresAt: "2026-10-10T01:00:00.000Z",
        now,
      });
      if (!opened.ok) throw new Error(opened.message);

      const session = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
      });
      let summaries = 0;
      const pipeline = new PactileContextPipeline({
        durability: host.memory,
        audits: host.store,
        checkpoint: checkpointWriterFromPiSession(session),
        admissionGate: createRunLedgerContextReviewGateV1({ ledger: host.ledger, runId: "run-1", now }),
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: `sha256:${"1".repeat(64)}`,
        operationEpoch: 1,
        contextOperationId: "context-operation-1",
        sourceCursor: "session-1:0",
        leaseEpoch: lease.epoch,
        lease,
        fencingToken: "fence-1",
        commandId: "command-1",
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision }) => {
          summaries += 1;
          return memoryDocument(basisRevision);
        },
        now,
      });
      const agent = new PactileNativeAgent({
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("ok") }));
          return stream;
        },
        contextPipeline: pipeline,
      });
      await agent.prompt("first turn");
      await agent.prompt("second turn");
      expect(agent.lastContextPipelineResult).toMatchObject({
        status: "blocked",
        reason: "context_review_pending",
        memoryCommitRequest: null,
        messages: null,
      });
      // No summary provider call, no memory write, the original context stays.
      expect(summaries).toBe(0);
      await expect(host.store.readCurrent({ scope: "run", scopeKey: SCOPE_KEY })).resolves.toMatchObject({
        ok: true,
        status: "absent",
      });
      const heldMessages = agent.state.messages.length;

      // A Kernel-recorded rejection ends the hold; the next proposal may run.
      const lease2 = await host.productKernel.acquireLease({
        commandId: "lease-kernel-1",
        requestHash: productKernelRequestHashV1("acquire.lease", { n: 1 }),
        scope: "product-kernel",
        ownerId: "owner-a",
        ttlMs: 60_000,
      });
      const kernelSnapshot = await host.productKernel.readSnapshot();
      const upserts = [
        {
          factKind: "project" as const,
          record: { schemaVersion: 1 as const, projectId: "proj-review", title: "Review", createdAt: NOW, archivedAt: null },
        },
      ];
      await host.productKernel.applyCommand({
        commandId: "cmd-reject-review",
        requestHash: productKernelRequestHashV1("apply.command", { upserts }),
        expectedRevision: kernelSnapshot.revision,
        lease: {
          scope: lease2.lease.scope,
          leaseId: lease2.lease.leaseId,
          ownerId: lease2.lease.ownerId,
          epoch: lease2.lease.epoch,
        },
        upserts,
      });
      await expect(
        resolveContextReviewV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          runId: "run-1",
          approvalRequestId: opened.request.approvalRequestId,
          decision: "reject",
          authority: "user",
          approvalRef: "cmd-reject-review",
          verifier: createKernelApprovalVerifierV1(host.productKernel),
          now,
        }),
      ).resolves.toMatchObject({ ok: true, request: { state: "rejected" } });

      await agent.prompt("third turn");
      expect(agent.lastContextPipelineResult).toMatchObject({ status: "compacted" });
      expect(summaries).toBe(1);
      expect(agent.state.messages.length).toBeLessThan(heldMessages + 2);
      agent.dispose();
    } finally {
      await host.close();
    }
  });

  it("records a fenced Memory Port commit as epoch_mismatch without claiming durability", async () => {
    const root = fixture();
    const host = await openHostOrSkip(root);
    if (host === null) return;
    try {
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-context-ledger",
        requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger()),
        ledger: initialLedger(),
        effects: [],
      });
      const partition = memoryPartitionV1("run", SCOPE_KEY);
      const first = await host.store.acquireLease({
        partition,
        runId: "run-1",
        ownerId: "context-owner-1",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-1",
        requestHash: HASH,
      });
      if (first.value === undefined) throw new Error("lease acquisition failed");
      const stale = {
        leaseId: first.value.leaseId,
        ownerId: first.value.ownerId,
        epoch: first.value.epoch,
        expiresAt: first.value.expiresAt,
        partition: first.value.partition,
      };
      // Another owner takes over, so the pipeline's proof is now stale.
      const takeover = await host.store.acquireLease({
        partition,
        runId: "run-1",
        ownerId: "context-owner-2",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-2",
        requestHash: HASH,
        expectedEpoch: 1,
      });
      expect(takeover.value?.epoch).toBe(2);

      const session = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
      });
      const governanceProducer = createContextGovernancePipelineReceiptProducerV1({
        ledger: host.ledger,
        artifacts: host.artifacts,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId: "context-operation-1",
        scopeKey: "run-1",
        cdrOperationId: "context-cdr-operation-1",
        carOperationId: "context-car-operation-1",
        cdrArtifactId: "cg-cdr-context-1",
        carArtifactId: "cg-car-context-1",
        memoryCommit: {
          scope: "run",
          scopeKey: SCOPE_KEY,
          artifactId: "cg-memory-commit-context-1",
        },
        now: () => new Date(NOW),
      });
      const pipeline = new PactileContextPipeline({
        durability: host.memory,
        audits: host.store,
        checkpoint: checkpointWriterFromPiSession(session),
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: `sha256:${"1".repeat(64)}`,
        operationEpoch: 1,
        contextOperationId: "context-operation-1",
        sourceCursor: "session-1:0",
        leaseEpoch: stale.epoch,
        lease: stale,
        fencingToken: "fence-1",
        commandId: "command-1",
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision }) => memoryDocument(basisRevision),
        now: () => new Date(NOW),
        onResult: governanceProducer,
      });
      let calls = 0;
      const agent = new PactileNativeAgent({
        streamFn: () => {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(calls === 1 ? "first" : "second") }));
          return stream;
        },
        contextPipeline: pipeline,
      });
      await agent.prompt("first turn");
      await agent.prompt("second turn");
      const result = agent.lastContextPipelineResult;
      agent.dispose();
      expect(result).toMatchObject({
        reason: "memory_commit_failed",
        memoryCommit: null,
        memoryCommitFailure: { code: "memory_lease_fenced" },
      });

      const stored = await host.ledger.readRunLedger("run-1");
      expect(stored?.ledger.contextOperations).toEqual([
        expect.objectContaining({
          contextOperationId: "context-operation-1:memory-commit",
          kind: "memory_commit",
          status: "failed",
        }),
      ]);
      const operation = stored?.ledger.contextOperations?.[0];
      const ref = parseArtifactStorageRefV1(operation?.payloadArtifactRef ?? "");
      if (!ref.ok) throw new Error("expected a record artifact reference");
      const artifact = await host.artifacts.read({
        artifactId: ref.reference.artifactId,
        version: ref.reference.version,
        storageRef: operation?.payloadArtifactRef ?? "",
        scope: "run",
        scopeKey: "run-1",
        contentHash: ref.reference.contentHash,
      });
      if (!artifact.ok) throw new Error("expected the record artifact");
      expect(JSON.parse(new TextDecoder().decode(artifact.content))).toMatchObject({
        status: "epoch_mismatch",
        requestId: result?.memoryCommitRequest?.requestId,
        artifactRef: null,
        contentHash: null,
        memoryReceiptId: null,
        manifestHash: null,
        progress: { artifact: false, receipt: false, manifest: false },
      });
      // Nothing compacted, so no CDR/CAR and no Memory Port durability claim.
      expect(stored?.effects).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it("runs native compaction and reconciles CDR/CAR payloads after restart", async () => {
    const root = fixture();
    const host = await openHostOrSkip(root);
    if (host === null) return;
    const contextOperationId = "context-operation-1";
    const cdrEffect = terminalEffect("context-cdr-operation-1", "context-cdr");
    const carEffect = terminalEffect("context-car-operation-1", "context-car");
    try {
      const ledger = initialLedger();
      const effects = [cdrEffect, carEffect];
      await host.ledger.commitRunLedger({
        idempotencyKey: "seed-context-effects",
        requestHash: runtimeRequestHashV1("run-ledger.seed-context-effects", { ledger, effects }),
        ledger: {
          ...ledger,
          commitId: "commit-2",
          effectOperationIds: effects.map((effect) => effect.operationId),
          revision: 2,
          updatedAt: "2026-10-10T00:00:02.000Z",
        },
        effects,
      });
      const leaseRecord = await host.store.acquireLease({
        partition: memoryPartitionV1("run", SCOPE_KEY),
        runId: "run-1",
        ownerId: "context-owner-1",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-1",
        requestHash: HASH,
      });
      if (leaseRecord.value === undefined) throw new Error(`lease acquisition failed: ${JSON.stringify(leaseRecord)}`);
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const session = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
      });
      const governanceProducer = createContextGovernancePipelineReceiptProducerV1({
        ledger: host.ledger,
        artifacts: host.artifacts,
        workspaceId: "workspace-1",
        runId: "run-1",
        attemptId: "attempt-1",
        turnId: "turn-1",
        operationEpoch: 1,
        contextOperationId,
        scopeKey: "run-1",
        cdrOperationId: cdrEffect.operationId,
        carOperationId: carEffect.operationId,
        cdrArtifactId: "cg-cdr-context-1",
        carArtifactId: "cg-car-context-1",
        memoryCommit: {
          scope: "run",
          scopeKey: SCOPE_KEY,
          artifactId: "cg-memory-commit-context-1",
        },
        now: () => new Date(NOW),
      });
      const pipeline = new PactileContextPipeline({
        durability: host.memory,
        audits: host.store,
        checkpoint: checkpointWriterFromPiSession(session),
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: `sha256:${"1".repeat(64)}`,
        operationEpoch: 1,
        contextOperationId,
        sourceCursor: "session-1:0",
        leaseEpoch: lease.epoch,
        lease,
        fencingToken: "fence-1",
        commandId: "command-1",
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision }) => memoryDocument(basisRevision),
        now: () => new Date(NOW),
        onResult: governanceProducer,
      });
      let calls = 0;
      const agent = new PactileNativeAgent({
        streamFn: () => {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(calls === 1 ? "first" : "second") }));
          return stream;
        },
        contextPipeline: pipeline,
      });
      await agent.prompt("first turn");
      await agent.prompt("second turn");
      const result = agent.lastContextPipelineResult;
      expect(result?.status).toBe("compacted");
      expect(result?.compactionReceipt).not.toBeNull();
      expect(result?.snapshot?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      if (result?.compactionReceipt === null || result?.compactionReceipt === undefined || result.snapshot === null) {
        throw new Error("expected a durable compaction result");
      }

      const snapshot = await host.ledger.readRunLedger("run-1");
      expect(snapshot?.effects).toHaveLength(2);
      expect(snapshot?.effects.every((effect) => effect.payloadType !== undefined)).toBe(true);
      const revisionAfterFirstProducer = snapshot?.ledger.revision;
      await governanceProducer(result);
      const replayed = await host.ledger.readRunLedger("run-1");
      expect(replayed?.ledger.revision).toBe(revisionAfterFirstProducer);
      agent.dispose();
      await host.close();

      const reopened = await openPactileRuntimeHost({ repositoryRoot: root, now: () => new Date(NOW) });
      try {
        const reconciled = await reopened.ledger.readRunLedger("run-1");
        expect(reconciled?.missingOperationIds).toEqual([]);
        expect(reconciled?.orphanOperationIds).toEqual([]);
        expect(reconciled?.effects).toHaveLength(2);
        // The pipeline's own Memory Port commit is bound as a Context Operation.
        const commitOperation = reconciled?.ledger.contextOperations?.[0];
        expect(reconciled?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: `${contextOperationId}:memory-commit`,
            kind: "memory_commit",
            status: "succeeded",
            payloadType: "pactile.cg.memory-commit-record",
          }),
        ]);
        const commitRef = parseArtifactStorageRefV1(commitOperation?.payloadArtifactRef ?? "");
        if (!commitRef.ok) throw new Error("expected a memory commit record reference");
        const commitArtifact = await reopened.artifacts.read({
          artifactId: commitRef.reference.artifactId,
          version: commitRef.reference.version,
          storageRef: commitOperation?.payloadArtifactRef ?? "",
          scope: "run",
          scopeKey: "run-1",
          contentHash: commitRef.reference.contentHash,
        });
        if (!commitArtifact.ok) throw new Error("expected the memory commit record artifact");
        expect(
          JSON.parse(new TextDecoder().decode(commitArtifact.content)),
        ).toMatchObject({
          status: "ok",
          requestId: result.compactionReceipt.requestId,
          artifactRef: result.memoryCommit?.artifactStorageRef,
          manifestHash: result.memoryCommit?.manifestHash,
          progress: { artifact: true, receipt: true, manifest: true },
        });
        expect(reconciled?.effects.map((effect) => effect.payloadType)).toEqual(
          expect.arrayContaining([
            "pactile.cg.compression-decision-receipt",
            "pactile.cg.compaction-audit-receipt",
          ]),
        );
        const cdrEffect = reconciled?.effects.find(
          (effect) => effect.payloadType === "pactile.cg.compression-decision-receipt",
        );
        const carEffect = reconciled?.effects.find(
          (effect) => effect.payloadType === "pactile.cg.compaction-audit-receipt",
        );
        if (cdrEffect?.payloadArtifactRef === undefined || carEffect?.payloadArtifactRef === undefined) {
          throw new Error("expected CDR and CAR artifact references");
        }
        const cdrRef = parseArtifactStorageRefV1(cdrEffect.payloadArtifactRef);
        const carRef = parseArtifactStorageRefV1(carEffect.payloadArtifactRef);
        if (!cdrRef.ok || !carRef.ok) throw new Error("expected logical receipt artifact references");
        const cdrArtifact = await reopened.artifacts.read({
          artifactId: cdrRef.reference.artifactId,
          version: cdrRef.reference.version,
          storageRef: cdrEffect.payloadArtifactRef,
          scope: "run",
          scopeKey: "run-1",
          contentHash: cdrRef.reference.contentHash,
        });
        const carArtifact = await reopened.artifacts.read({
          artifactId: carRef.reference.artifactId,
          version: carRef.reference.version,
          storageRef: carEffect.payloadArtifactRef,
          scope: "run",
          scopeKey: "run-1",
          contentHash: carRef.reference.contentHash,
        });
        if (!cdrArtifact.ok || !carArtifact.ok) throw new Error("expected persisted receipt payloads");
        const cdrPayload = JSON.parse(new TextDecoder().decode(cdrArtifact.content)) as Record<string, unknown>;
        const carPayload = JSON.parse(new TextDecoder().decode(carArtifact.content)) as Record<string, unknown>;
        expect(cdrPayload.verdict).toBe("admitted");
        expect(carPayload.verdict).toBe("assurance_unknown");
        const carChecks = carPayload.checks as { result: { status: string; value: string } }[];
        expect(carChecks).toHaveLength(17);
        expect(carChecks.every(
          (check) => check.result.status === "unknown" && check.result.value === "fail",
        )).toBe(true);
      } finally {
        await reopened.close();
      }
    } finally {
      try {
        await host.close();
      } catch {
        // The test closes the host before restart; cleanup is best effort.
      }
    }
  });
});
