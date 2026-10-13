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
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import {
  createGovernedMemoryReadToolV1,
  memoryReadContextOperationIdV1,
} from "../../../src/pactile/runtime/context-governance-memory-read-port.js";
import { PactileRunLedgerEffectReceiptPort } from "../../../src/pactile/runtime/run-ledger-effect-receipts.js";
import type { RunLedgerPort, RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import {
  probeSqliteRuntimeStoreCapability,
} from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}`;
const FACT = "The approved write set remains current.";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/** Call 1 asks for memory_read; call 2 (after the tool result) just stops. */
function scriptedModel(args: Record<string, unknown>) {
  let calls = 0;
  return () => {
    calls += 1;
    const stream = createAssistantMessageEventStream();
    const message =
      calls === 1
        ? assistant(
            [{ type: "toolCall", id: "call-memory-1", name: "memory_read", arguments: args as never }],
            "toolUse",
          )
        : assistant([{ type: "text", text: "done" }], "stop");
    queueMicrotask(() =>
      stream.push({
        type: "done",
        reason: calls === 1 ? "toolUse" : "stop",
        message,
      }),
    );
    return stream;
  };
}

async function openOrSkip(): Promise<PactileRuntimeHost | null> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-memory-tool-"));
  roots.push(root);
  return openPactileRuntimeHost({ repositoryRoot: root });
}

async function seed(host: PactileRuntimeHost) {
  const initial = ledger();
  await host.ledger.commitRunLedger({
    idempotencyKey: "seed-ledger-tool-1",
    requestHash: runtimeRequestHashV1("run-ledger.seed", initial),
    ledger: initial,
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
    idempotencyKey: "context-memory-lease-tool-1",
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
  const document: MemoryFactDocumentV1 = {
    schemaVersion: 1,
    kind: "memory_fact_document_v1",
    source: "artifact",
    scope: "run",
    scopeKey,
    basisRevision: 1,
    facts: [{ factId: "fact-1", statement: FACT, basisRevision: 1, tags: ["decision"] }],
    summaries: [
      { summaryId: "summary-1", statement: "A derived restatement.", derivedFrom: ["fact-1"] },
    ],
  };
  const committed = await host.memory.commit({
    requestId: "memory-request-tool-1",
    scope: "run",
    scopeKey,
    artifactId: "memory-artifact-tool-1",
    version: 1,
    basisRevision: 1,
    document,
    whenToRead: "Read before selecting the next write.",
    lease,
  });
  if (!committed.ok) throw new Error(committed.message);
  return { initial, scopeKey, lease };
}

async function runAgent(
  host: PactileRuntimeHost,
  seeded: Awaited<ReturnType<typeof seed>>,
  args: Record<string, unknown>,
  toolLedger: RunLedgerPort = host.ledger,
) {
  const tool = createGovernedMemoryReadToolV1({
    memory: host.memory,
    ledger: toolLedger,
    artifacts: host.artifacts,
    scopeKey: seeded.scopeKey,
    workspaceId: "workspace-1",
    runId: "run-1",
    operationEpoch: 1,
    lease: seeded.lease,
  });
  const agent = new PactileNativeAgent({
    streamFn: scriptedModel(args),
    effectReceipts: new PactileRunLedgerEffectReceiptPort({
      ledger: host.ledger,
      initialLedger: seeded.initial,
      attemptId: "attempt-1",
      turnId: "turn-1",
    }),
    runId: "run-1",
    operationEpoch: 1,
    initialState: { tools: [tool] },
  });
  await agent.prompt("recall the externalized decision");
  agent.dispose();
  const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
  if (toolResult === undefined || toolResult.role !== "toolResult") {
    throw new Error("expected a tool result message");
  }
  const text = toolResult.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  return { agent, toolResult, text };
}

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "memory_read tool through the native Agent",
  () => {
    it("returns recorded facts and binds the tool effect and both Context Operations", async () => {
      const host = await openOrSkip();
      if (host === null) return;
      try {
        const seeded = await seed(host);
        const { agent, toolResult, text } = await runAgent(host, seeded, {
          basisRevision: 1,
          acknowledgeDisclosure: true,
        });
        expect(toolResult.isError).toBe(false);
        expect(text).toContain(FACT);
        expect(text).toContain("NOT exact facts");
        expect(agent.effectsKnown).toBe(true);

        const stored = await host.ledger.readRunLedger("run-1");
        expect(stored?.effects).toHaveLength(1);
        const effect = stored?.effects[0];
        expect(effect).toMatchObject({ toolCallId: "call-memory-1", status: "success" });
        const contextOperationId = memoryReadContextOperationIdV1("run-1", "call-memory-1", 1);
        expect(contextOperationId).toBe(`memory-read-${effect?.operationId}`);
        expect(stored?.ledger.contextOperations).toEqual([
          expect.objectContaining({
            contextOperationId: `${contextOperationId}:disclosure`,
            kind: "disclosure",
            status: "succeeded",
          }),
          expect.objectContaining({
            contextOperationId: `${contextOperationId}:memory-read`,
            kind: "memory_read",
            status: "succeeded",
          }),
        ]);
        expect(stored?.missingOperationIds).toEqual([]);
        expect(stored?.orphanOperationIds).toEqual([]);
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toHaveLength(1);
      } finally {
        await host.close();
      }
    });

    it("records an unacknowledged read as a known refusal that keeps effects known", async () => {
      const host = await openOrSkip();
      if (host === null) return;
      try {
        const seeded = await seed(host);
        const { agent, toolResult, text } = await runAgent(host, seeded, {
          basisRevision: 1,
          acknowledgeDisclosure: false,
        });
        expect(toolResult.isError).toBe(true);
        expect(text).toContain("memory_disclosure_missing");
        expect(text).not.toContain(FACT);
        // A refusal the Host fully understands is a failed effect, not an
        // unknown one, so the run does not stall on reconciliation.
        expect(agent.effectsKnown).toBe(true);

        const stored = await host.ledger.readRunLedger("run-1");
        expect(stored?.effects[0]).toMatchObject({ status: "failure" });
        expect(stored?.ledger.contextOperations).toEqual([
          expect.objectContaining({ kind: "memory_read", status: "failed" }),
        ]);
        await expect(
          host.store.readMemoryAuditReceipts("run", seeded.scopeKey),
        ).resolves.toEqual([]);
      } finally {
        await host.close();
      }
    });

    it("withholds facts that could not be recorded and leaves the effect unknown", async () => {
      const host = await openOrSkip();
      if (host === null) return;
      try {
        const seeded = await seed(host);
        const refusingContextOperations: RunLedgerPort = {
          readRunLedger: (runId) => host.ledger.readRunLedger(runId),
          commitRunLedger: (commit) => {
            if (commit.idempotencyKey.startsWith("pactile-artifact-intent:bind:")) {
              return Promise.reject(new Error("simulated ledger outage"));
            }
            return host.ledger.commitRunLedger(commit);
          },
        };
        const { agent, toolResult, text } = await runAgent(
          host,
          seeded,
          { basisRevision: 1, acknowledgeDisclosure: true },
          refusingContextOperations,
        );
        expect(toolResult.isError).toBe(true);
        expect(text).toContain("ledger_binding_failed");
        expect(text).not.toContain(FACT);
        // Governance writes may be half applied, so this must not look known.
        expect(agent.effectsKnown).toBe(false);

        const stored = await host.ledger.readRunLedger("run-1");
        expect(stored?.effects[0]).toMatchObject({ status: "unknown" });
        expect(stored?.ledger.contextOperations ?? []).toEqual([]);
        // The unbound artifacts are owned by a durable, still pending intent.
        expect(stored?.ledger.artifactIntents).toEqual([
          expect.objectContaining({ state: "pending" }),
        ]);
      } finally {
        await host.close();
      }
    });
  },
);
