import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { memoryDurabilityFailureV1, type MemoryFactDocumentV1 } from "../../../src/core/index.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import { memoryPartitionV1 } from "../../../src/pactile/agent/memory/durability.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import { createPactileEffectIntentV1 } from "../../../src/pactile/agent/effects/contract.js";
import { persistContextGovernanceMemoryFailureV1 } from "../../../src/pactile/runtime/context-governance-memory.js";
import {
  openGovernedRunSessionV1,
  preserveRunLedgerMetadataV1,
  type GovernedRunSessionOptionsV1,
  type GovernedRunSessionV1,
} from "../../../src/pactile/runtime/governed-run-session.js";
import type { RunLedgerPort } from "../../../src/pactile/runtime/run-ledger.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { probeSqliteRuntimeStoreCapability } from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}`;
const FACT = "The approved write set remains current.";
const RUN_ID = "run-1";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-governed-run-"));
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

const scopeKey = memoryScopeKeyV1({
  scope: "run",
  workspaceId: "workspace-1",
  projectId: "project-1",
  runId: RUN_ID,
});

/** The Agent session lease: what fences a process in the real CLI. */
async function acquireRunLease(host: PactileRuntimeHost, ownerId: string, tag: string) {
  const acquired = await host.store.acquireLease({
    partition: "session-registry-test",
    runId: RUN_ID,
    ownerId,
    ttlMs: 600_000,
    idempotencyKey: `run-lease-${tag}`,
    requestHash: runtimeRequestHashV1("run-lease", { tag }),
  });
  return {
    partition: acquired.value.partition,
    leaseId: acquired.value.leaseId,
    ownerId: acquired.value.ownerId,
    epoch: acquired.value.epoch,
  };
}

async function seedMemory(host: PactileRuntimeHost) {
  const acquired = await host.store.acquireLease({
    partition: memoryPartitionV1("run", scopeKey),
    runId: RUN_ID,
    ownerId: "seed-owner",
    ttlMs: 600_000,
    idempotencyKey: "seed-memory-lease",
    requestHash: hash,
  });
  const lease = {
    leaseId: acquired.value.leaseId,
    ownerId: acquired.value.ownerId,
    epoch: acquired.value.epoch,
    expiresAt: acquired.value.expiresAt,
    partition: acquired.value.partition,
  };
  const document: MemoryFactDocumentV1 = {
    schemaVersion: 1,
    kind: "memory_fact_document_v1",
    source: "artifact",
    scope: "run",
    scopeKey,
    basisRevision: 1,
    facts: [{ factId: "fact-1", statement: FACT, basisRevision: 1, tags: ["decision"] }],
    summaries: [],
  };
  const committed = await host.memory.commit({
    requestId: "memory-request-session-1",
    scope: "run",
    scopeKey,
    artifactId: "memory-artifact-session-1",
    version: 1,
    basisRevision: 1,
    document,
    whenToRead: "Read before selecting the next write.",
    lease,
  });
  if (!committed.ok) throw new Error(committed.message);
  return lease;
}

async function open(
  host: PactileRuntimeHost,
  overrides: Partial<GovernedRunSessionOptionsV1> & { readonly runLease: GovernedRunSessionOptionsV1["runLease"] },
): Promise<GovernedRunSessionV1> {
  const result = await openGovernedRunSessionV1({
    host,
    runId: RUN_ID,
    workspaceId: "workspace-1",
    projectId: "project-1",
    operationEpoch: 1,
    ownerId: "agent-owner-1",
    memoryLeaseTtlMs: 600_000,
    ...overrides,
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.session;
}

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "pactile-test",
    model: "mock",
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedMemoryRead() {
  let calls = 0;
  return () => {
    calls += 1;
    const stream = createAssistantMessageEventStream();
    const message =
      calls === 1
        ? assistant(
            [
              {
                type: "toolCall",
                id: "call-memory-1",
                name: "memory_read",
                arguments: { basisRevision: 1, acknowledgeDisclosure: true } as never,
              },
            ],
            "toolUse",
          )
        : assistant([{ type: "text", text: "done" }], "stop");
    queueMicrotask(() =>
      stream.push({ type: "done", reason: calls === 1 ? "toolUse" : "stop", message }),
    );
    return stream;
  };
}

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "governed run session (real SQLite + file ArtifactStore)",
  () => {
    it("opens a run, lets the native Agent read memory through it, and records the end", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await seedMemory(host);
        const runLease = await acquireRunLease(host, "agent-owner-1", "a");
        const session = await open(host, { runLease });
        expect(session.recovery).toEqual({
          reconciledIntents: [],
          abandonedIntents: [],
          pendingIntents: [],
          unresolvedEffects: [],
          missingOperationIds: [],
          orphanOperationIds: [],
        });
        // The Memory Port lease was taken over from the seeding owner.
        expect(session.memoryLease.epoch).toBe(2);
        const opened = await host.ledger.readRunLedger(RUN_ID);
        expect(opened?.ledger).toMatchObject({
          activeAttemptId: "attempt-1",
          activeTurnId: "turn-1",
          status: "running",
          lease: { leaseId: runLease.leaseId, epoch: runLease.epoch, owner: "agent-owner-1" },
        });

        const agent = new PactileNativeAgent({
          streamFn: scriptedMemoryRead(),
          effectReceipts: session.effectReceipts,
          runId: RUN_ID,
          operationEpoch: 1,
          initialState: { tools: [...session.tools] as never },
        });
        await agent.prompt("recall the externalized decision");
        const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
        if (toolResult === undefined || toolResult.role !== "toolResult") {
          throw new Error("expected a tool result");
        }
        const text = toolResult.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
        expect(toolResult.isError).toBe(false);
        expect(text).toContain(FACT);
        expect(agent.effectsKnown).toBe(true);
        agent.dispose();

        const used = await host.ledger.readRunLedger(RUN_ID);
        expect(used?.effects).toEqual([expect.objectContaining({ status: "success", attemptId: "attempt-1" })]);
        expect(used?.ledger.contextOperations?.map((entry) => entry.kind)).toEqual([
          "disclosure",
          "memory_read",
        ]);
        expect(used?.ledger.artifactIntents).toEqual([expect.objectContaining({ state: "bound" })]);

        await expect(session.finish("completed")).resolves.toEqual({ ok: true });
        await expect(session.finish("completed")).resolves.toEqual({ ok: true });
        const finished = await host.ledger.readRunLedger(RUN_ID);
        expect(finished?.ledger.status).toBe("completed");
        const memoryPartition = memoryPartitionV1("run", scopeKey);
        const held = await host.store.recover({ runId: RUN_ID });
        expect(held.leases.map((lease) => lease.partition)).toContain(memoryPartition);
        await session.release();
        await session.release();
        const released = await host.store.recover({ runId: RUN_ID });
        expect(released.leases.map((lease) => lease.partition)).not.toContain(memoryPartition);
        // Released: the next owner gets a fresh epoch, not a conflict.
        const next = await open(host, {
          runLease: await acquireRunLease(host, "agent-owner-2", "b"),
          ownerId: "agent-owner-2",
          operationEpoch: 2,
        });
        expect(next.memoryLease.epoch).toBe(3);
        await next.release();
      } finally {
        await host.close();
      }
    });

    it("reports what an earlier attempt left unresolved and never replays it", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const first = await open(host, { runLease: await acquireRunLease(host, "agent-owner-1", "a") });
        // An effect that began and then the process died: no terminal receipt.
        const intent = createPactileEffectIntentV1({
          runId: RUN_ID,
          toolCallId: "call-crashed-1",
          toolName: "write_file",
          args: { path: "x" },
          operationEpoch: 1,
        });
        await expect(first.effectReceipts.begin(intent)).resolves.toMatchObject({ ok: true });

        const second = await open(host, {
          runLease: await acquireRunLease(host, "agent-owner-2", "b"),
          ownerId: "agent-owner-2",
          operationEpoch: 2,
        });
        expect(second.recovery.unresolvedEffects).toEqual([intent.effectId]);
        const ledger = await host.ledger.readRunLedger(RUN_ID);
        expect(ledger?.ledger).toMatchObject({ activeAttemptId: "attempt-2", activeTurnId: "turn-2" });
        // Reported, not replayed or settled on its own.
        expect(ledger?.effects).toEqual([expect.objectContaining({ operationId: intent.effectId, status: "intent" })]);
        // Asking to begin the same effect again is refused by the port.
        await expect(second.effectReceipts.begin(intent)).resolves.toMatchObject({
          ok: false,
          code: "effect_unknown",
        });
      } finally {
        await host.close();
      }
    });

    it("finishes an interrupted artifact binding before the Agent acts again", async () => {
      const root = fixture();
      const first = await openPactileRuntimeHost({ repositoryRoot: root });
      let tree: Record<string, string>;
      try {
        await seedMemory(first);
        const session = await open(first, { runLease: await acquireRunLease(first, "agent-owner-1", "a") });
        let lost = false;
        const lossy: RunLedgerPort = {
          readRunLedger: (runId) => first.ledger.readRunLedger(runId),
          commitRunLedger: async (commit) => {
            if (!lost && commit.idempotencyKey.startsWith("pactile-artifact-intent:bind:")) {
              lost = true;
              throw new Error("simulated crash before the ledger commit");
            }
            return first.ledger.commitRunLedger(commit);
          },
        };
        const crashed = await persistContextGovernanceMemoryFailureV1({
          ledger: lossy,
          artifacts: first.artifacts,
          request: {
            scope: "run",
            scopeKey,
            basisRevision: 1,
            acknowledgeDisclosure: false,
            lease: session.memoryLease,
          },
          failure: memoryDurabilityFailureV1("memory_disclosure_missing", "not acknowledged", {
            scope: "run",
            scopeKey,
          }),
          workspaceId: "workspace-1",
          runId: RUN_ID,
          attemptId: session.attemptId,
          turnId: session.turnId,
          operationEpoch: 1,
          contextOperationId: "context-memory-crashed",
          memoryReadArtifactId: "cg-memory-read-crashed",
          scopeKey,
          version: 1,
          basisRevision: 1,
          lease: session.memoryLease,
        });
        expect(crashed).toMatchObject({ ok: false, code: "ledger_binding_failed" });
        tree = artifactTree(first);
        // The process dies here: no finish, no release.
      } finally {
        await first.close();
      }

      const reopened = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        const session = await open(reopened, {
          runLease: await acquireRunLease(reopened, "agent-owner-2", "b"),
          ownerId: "agent-owner-2",
          operationEpoch: 2,
        });
        expect(session.recovery.reconciledIntents).toHaveLength(1);
        expect(session.recovery.pendingIntents).toEqual([]);
        expect(artifactTree(reopened)).toEqual(tree);
        const ledger = await reopened.ledger.readRunLedger(RUN_ID);
        expect(ledger?.ledger.contextOperations).toEqual([
          expect.objectContaining({ contextOperationId: "context-memory-crashed:memory-read", status: "failed" }),
        ]);
        expect(ledger?.ledger.artifactIntents).toEqual([expect.objectContaining({ state: "bound" })]);
      } finally {
        await reopened.close();
      }
    });

    it("fences a replaced owner out of the RunLedger", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const oldLease = await acquireRunLease(host, "agent-owner-1", "a");
        const stale = await open(host, { runLease: oldLease });
        // The session lease moves to a new owner (same partition, next epoch).
        const newLease = await acquireRunLease(host, "agent-owner-2", "b");
        expect(newLease.epoch).toBe(oldLease.epoch + 1);

        const intent = createPactileEffectIntentV1({
          runId: RUN_ID,
          toolCallId: "call-stale-1",
          toolName: "write_file",
          args: null,
          operationEpoch: 1,
        });
        await expect(stale.effectReceipts.begin(intent)).resolves.toMatchObject({ ok: false });
        expect(stale.effectReceipts.effectsKnown()).toBe(false);
        await expect(stale.finish("completed")).resolves.toMatchObject({ ok: false });
        const ledger = await host.ledger.readRunLedger(RUN_ID);
        expect(ledger?.effects).toEqual([]);
        expect(ledger?.ledger.status).toBe("running");
      } finally {
        await host.close();
      }
    });

    it("keeps the RunLedger when the run record is rewritten", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const session = await open(host, { runLease: await acquireRunLease(host, "agent-owner-1", "a") });
        await session.finish("completed");
        const existing = await host.store.getRun(RUN_ID);
        if (existing === null) throw new Error("expected a run record");
        const fresh = {
          schemaVersion: 1 as const,
          runId: RUN_ID,
          status: "running" as const,
          revision: 1,
          input: { requestRef: "request-1" },
          output: null,
          error: null,
          metadata: { runtime: "pactile-native-agent-v1" },
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
        };

        // A plain overwrite is exactly what erases the ledger.
        await host.store.putRun({
          idempotencyKey: "overwrite-plain",
          requestHash: runtimeRequestHashV1("overwrite", { plain: true }),
          run: fresh,
        });
        await expect(host.ledger.readRunLedger(RUN_ID)).resolves.toBeNull();
      } finally {
        await host.close();
      }

      const second = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const session = await open(second, { runLease: await acquireRunLease(second, "agent-owner-1", "a") });
        await session.finish("completed");
        const before = await second.ledger.readRunLedger(RUN_ID);
        const existing = await second.store.getRun(RUN_ID);
        if (existing === null || before === null) throw new Error("expected a run and a ledger");
        const rewritten = preserveRunLedgerMetadataV1(existing, {
          ...existing,
          status: "running",
          revision: 1,
          input: { requestRef: "request-1" },
          metadata: { runtime: "pactile-native-agent-v1" },
        });
        await second.store.putRun({
          idempotencyKey: "overwrite-preserved",
          requestHash: runtimeRequestHashV1("overwrite", { preserved: true }),
          run: rewritten,
        });
        const after = await second.ledger.readRunLedger(RUN_ID);
        expect(after?.ledger).toEqual(before.ledger);
        const run = await second.store.getRun(RUN_ID);
        expect(run).toMatchObject({ input: { requestRef: "request-1" }, revision: before.ledger.revision });
      } finally {
        await second.close();
      }
    });

    it("rejects identifiers that are not logical ids and does not take a lease for them", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        const runLease = await acquireRunLease(host, "agent-owner-1", "a");
        const rejected = await openGovernedRunSessionV1({
          host,
          runId: RUN_ID,
          workspaceId: "Workspace One",
          projectId: "project-1",
          operationEpoch: 1,
          ownerId: "agent-owner-1",
          runLease,
          memoryLeaseTtlMs: 600_000,
        });
        expect(rejected).toMatchObject({ ok: false, code: "input_invalid" });
        await expect(host.ledger.readRunLedger(RUN_ID)).resolves.toBeNull();
      } finally {
        await host.close();
      }
    });
  },
);
