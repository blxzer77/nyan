import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  createContextMemoryDurabilityV1,
  memoryPartitionV1,
  readPiSessionSnapshot,
  type MemoryFactDocumentV1,
} from "../../../src/core/index.js";
import { FileArtifactStore } from "../../../src/pactile/runtime/file-artifact-store.js";
import {
  openSqliteRuntimeStore,
  probeSqliteRuntimeStoreCapability,
} from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import {
  checkpointWriterFromPiSession,
  PactileContextPipeline,
} from "../../../src/pactile/agent/context-pipeline.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import { FilePiSessionManager } from "../../../src/pactile/runtime/pi-session-manager.js";

const capability = probeSqliteRuntimeStoreCapability();
const roots: string[] = [];
const NOW = "2026-10-08T00:00:00.000Z";
const SCOPE_KEY = "workspace-1/project-1/run-1";

function fixture(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-context-native-"),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch {
      // The SQLite test evidence remains valid even when Windows delays WAL cleanup.
    }
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

describe.skipIf(!capability.supported)(
  "PactileNativeAgent Context Pipeline",
  () => {
    it("runs real SQLite/FileArtifactStore durability through the native loop", async () => {
      const root = fixture();
      const store = await openSqliteRuntimeStore({
        projectRoot: root,
        now: () => new Date(NOW),
      });
      const artifacts = new FileArtifactStore({
        storageRoot: path.join(root, ".pactile", "memory-artifacts"),
        now: () => new Date(NOW),
      });
      const session = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
      });
      const leaseRecord = await store.acquireLease({
        partition: memoryPartitionV1("run", SCOPE_KEY),
        runId: "run-1",
        ownerId: "context-owner-1",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-1",
        requestHash: "context-lease-hash-1",
      });
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const memory = createContextMemoryDurabilityV1({
        artifacts,
        receipts: store,
        manifests: store,
        audits: store,
        leases: store,
        now: () => new Date(NOW),
      });
      const pipeline = new PactileContextPipeline({
        durability: memory,
        audits: store,
        checkpoint: checkpointWriterFromPiSession(session),
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: "sha256:" + "1".repeat(64),
        operationEpoch: 1,
        contextOperationId: "context-operation-1",
        sourceCursor: "session-1:0",
        leaseEpoch: 1,
        fencingToken: "fence-1",
        lease,
        commandId: "command-1",
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision }) => memoryDocument(basisRevision),
        now: () => new Date(NOW),
      });
      const events: string[] = [];
      let calls = 0;
      const agent = new PactileNativeAgent({
        streamFn: () => {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          const message = assistant(calls === 1 ? "first" : "second");
          queueMicrotask(() =>
            stream.push({ type: "done", reason: "stop", message }),
          );
          return stream;
        },
        contextPipeline: pipeline,
        onEvent: (event) => events.push(event.type),
      });

      await agent.prompt("first turn");
      await agent.prompt("second turn");

      const result = agent.lastContextPipelineResult;
      expect(result?.status).toBe("compacted");
      expect(result?.delta?.operation).toBe("compact");
      expect(result?.delta?.removedRangeHash).toBe(
        result?.cutPoint?.prefixHash,
      );
      expect(result?.snapshot?.contentHash).toBeTruthy();
      expect(events).toContain("context_update");
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (part) =>
                part.type === "text" &&
                part.text.includes("durable context summary") &&
                part.text.includes("memory://"),
            ),
        ),
      ).toBe(true);
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (part) => part.type === "text" && part.text === "first",
            ),
        ),
      ).toBe(false);

      const audit = await store.readMemoryAuditReceipts("run", SCOPE_KEY);
      const auditKinds = audit.map((receipt) => receipt.kind);
      expect(auditKinds).toHaveLength(2);
      expect(auditKinds).toContain("memory_compaction_receipt_v1");
      expect(auditKinds).toContain("context_compaction_receipt_v1");
      const checkpoint = readPiSessionSnapshot(session, "run-1");
      expect(checkpoint.checkpointStatus).toBe("known");
      expect(checkpoint.checkpoint?.contextSnapshotHash).toBe(
        result?.snapshot?.contentHash,
      );

      await store.close();
      const reopenedStore = await openSqliteRuntimeStore({
        projectRoot: root,
        now: () => new Date(NOW),
      });
      const reopenedArtifacts = new FileArtifactStore({
        storageRoot: path.join(root, ".pactile", "memory-artifacts"),
      });
      const restartedSession = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
      });
      const restartedCheckpoint = readPiSessionSnapshot(
        restartedSession,
        "run-1",
      );
      expect(restartedCheckpoint.checkpointStatus).toBe("known");
      expect(restartedCheckpoint.checkpoint?.contextSnapshotHash).toBe(
        result?.snapshot?.contentHash,
      );
      const reopenedMemory = createContextMemoryDurabilityV1({
        artifacts: reopenedArtifacts,
        receipts: reopenedStore,
        manifests: reopenedStore,
        audits: reopenedStore,
        leases: reopenedStore,
        now: () => new Date(NOW),
      });
      const preflight = await reopenedMemory.preflight({
        scope: "run",
        scopeKey: SCOPE_KEY,
        basisRevision: result?.cutPoint?.basisRevision ?? 0,
        disclose: true,
      });
      expect(preflight.ok).toBe(true);
      if (!preflight.ok) throw new Error(preflight.message);
      expect(preflight.verified).toBe(true);
      await reopenedStore.close();
      agent.dispose();
    });

    it("does not replace Context when the checkpoint write is unknown", async () => {
      const root = fixture();
      const store = await openSqliteRuntimeStore({
        projectRoot: root,
        now: () => new Date(NOW),
      });
      const artifacts = new FileArtifactStore({
        storageRoot: path.join(root, ".pactile", "memory-artifacts"),
        now: () => new Date(NOW),
      });
      const leaseRecord = await store.acquireLease({
        partition: memoryPartitionV1("run", SCOPE_KEY),
        runId: "run-1",
        ownerId: "context-owner-failure",
        ttlMs: 60_000,
        idempotencyKey: "context-lease-failure",
        requestHash: "context-lease-hash-failure",
      });
      const lease = {
        leaseId: leaseRecord.value.leaseId,
        ownerId: leaseRecord.value.ownerId,
        epoch: leaseRecord.value.epoch,
        expiresAt: leaseRecord.value.expiresAt,
        partition: leaseRecord.value.partition,
      };
      const memory = createContextMemoryDurabilityV1({
        artifacts,
        receipts: store,
        manifests: store,
        audits: store,
        leases: store,
        now: () => new Date(NOW),
      });
      const pipeline = new PactileContextPipeline({
        durability: memory,
        audits: store,
        checkpoint: {
          write: () => ({
            ok: false as const,
            domain: "checkpoint" as const,
            code: "checkpoint_write_failed",
            message: "injected checkpoint failure",
            reexecute: false as const,
            replayPolicy: "no_automatic_replay" as const,
          }),
        },
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: "sha256:" + "2".repeat(64),
        operationEpoch: 1,
        contextOperationId: "context-operation-failure",
        sourceCursor: "session-1:0",
        leaseEpoch: 1,
        fencingToken: "fence-failure",
        lease,
        commandId: "command-failure",
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision }) => memoryDocument(basisRevision),
        now: () => new Date(NOW),
      });
      const events: string[] = [];
      let calls = 0;
      const agent = new PactileNativeAgent({
        streamFn: () => {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          const message = assistant(calls === 1 ? "first" : "second");
          queueMicrotask(() =>
            stream.push({ type: "done", reason: "stop", message }),
          );
          return stream;
        },
        contextPipeline: pipeline,
        onEvent: (event) => events.push(event.type),
      });

      await agent.prompt("first turn");
      await agent.prompt("second turn");

      expect(agent.lastContextPipelineResult?.status).toBe("unknown");
      expect(agent.lastContextPipelineResult?.error?.domain).toBe("checkpoint");
      expect(events).not.toContain("context_update");
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (part) =>
                part.type === "text" &&
                part.text.includes("durable context summary"),
            ),
        ),
      ).toBe(false);
      const auditKinds = (
        await store.readMemoryAuditReceipts("run", SCOPE_KEY)
      ).map((receipt) => receipt.kind);
      expect(auditKinds).toEqual(["memory_compaction_receipt_v1"]);
      await store.close();
      agent.dispose();
    });
  },
);
