import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { productKernelRequestHashV1 } from "../../../src/core/index.js";
import {
  checkpointWriterFromPiSession,
  type ContextPipelineResultV1,
  type PactileContextPipelinePortV1,
} from "../../../src/pactile/agent/context-pipeline.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import {
  createThresholdContextPolicyV1,
  CONTEXT_POLICY_RULE_IDS_V1,
} from "../../../src/pactile/runtime/context-governance-policy.js";
import {
  createKernelApprovalVerifierV1,
  resolveContextReviewV1,
} from "../../../src/pactile/runtime/context-governance-review.js";
import {
  createGovernedContextPipelineV1,
  type GovernedContextPipelineOptionsV1,
} from "../../../src/pactile/runtime/governed-context-pipeline.js";
import {
  openGovernedRunSessionV1,
  type GovernedRunSessionV1,
} from "../../../src/pactile/runtime/governed-run-session.js";
import { FilePiSessionManager } from "../../../src/pactile/runtime/pi-session-manager.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { probeSqliteRuntimeStoreCapability } from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const RUN_ID = "run-1";
const NOW = "2026-10-10T00:00:00.000Z";
const FINGERPRINT = `sha256:${"1".repeat(64)}`;
const LONG = "lorem ipsum ".repeat(30);

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

async function runLease(host: PactileRuntimeHost, tag: string) {
  const acquired = await host.store.acquireLease({
    partition: "session-registry-test",
    runId: RUN_ID,
    ownerId: `agent-owner-${tag}`,
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

async function kernelApproval(host: PactileRuntimeHost, commandId: string): Promise<string> {
  const lease = await host.productKernel.acquireLease({
    commandId: `lease-${commandId}`,
    requestHash: productKernelRequestHashV1("acquire.lease", { commandId }),
    scope: "product-kernel",
    ownerId: "owner-a",
    ttlMs: 60_000,
  });
  const snapshot = await host.productKernel.readSnapshot();
  const upserts = [
    {
      factKind: "project" as const,
      record: { schemaVersion: 1 as const, projectId: `proj-${commandId}`, title: "Approval", createdAt: NOW, archivedAt: null },
    },
  ];
  await host.productKernel.applyCommand({
    commandId,
    requestHash: productKernelRequestHashV1("apply.command", { commandId, upserts }),
    expectedRevision: snapshot.revision,
    lease: { scope: lease.lease.scope, leaseId: lease.lease.leaseId, ownerId: lease.lease.ownerId, epoch: lease.lease.epoch },
    upserts,
  });
  return commandId;
}

interface Harness {
  readonly host: PactileRuntimeHost;
  readonly root: string;
  /** One attempt: the governed session, its pipeline and an Agent that uses it. */
  attempt(input: {
    readonly epoch: number;
    readonly overrides?: Partial<GovernedContextPipelineOptionsV1>;
    /** The transcript a resumed attempt starts from. */
    readonly messages?: readonly unknown[];
  }): Promise<Attempt>;
}

interface Attempt {
  readonly session: GovernedRunSessionV1;
  readonly pipeline: PactileContextPipelineAccess;
  readonly agent: PactileNativeAgent;
  readonly results: { readonly result: ContextPipelineResultV1; readonly contextOperationId: string }[];
  /** Prompt until the predicate holds on the latest result (at most `max` prompts). */
  promptUntil(
    predicate: (result: ContextPipelineResultV1) => boolean,
    max?: number,
  ): Promise<ContextPipelineResultV1 | null>;
  close(): Promise<void>;
}

type PactileContextPipelineAccess = PactileContextPipelinePortV1;

async function harness(): Promise<Harness | null> {
  if (!probeSqliteRuntimeStoreCapability().supported) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-governed-ctx-"));
  roots.push(root);
  const host = await openPactileRuntimeHost({ repositoryRoot: root, now: () => new Date(NOW) });
  return {
    host,
    root,
    attempt: async ({ epoch, overrides, messages }) => {
      const lease = await runLease(host, `epoch-${String(epoch)}`);
      const opened = await openGovernedRunSessionV1({
        host,
        runId: RUN_ID,
        workspaceId: "workspace-1",
        projectId: "project-1",
        operationEpoch: epoch,
        ownerId: `agent-owner-${String(epoch)}`,
        runLease: lease,
        memoryLeaseTtlMs: 600_000,
        now: () => new Date(NOW),
      });
      if (!opened.ok) throw new Error(`${opened.code}: ${opened.message}`);
      const session = opened.session;
      const sessionManager = new FilePiSessionManager({
        sessionId: "session-1",
        sessionFile: path.join(root, ".pactile", "sessions", `session-1-${String(epoch)}.jsonl`),
      });
      const results: Attempt["results"] = [];
      const pipeline = createGovernedContextPipelineV1({
        host: { audits: host.store, ledger: host.ledger, artifacts: host.artifacts, memory: host.memory },
        session,
        workspaceId: "workspace-1",
        operationEpoch: epoch,
        runLease: lease,
        checkpoint: checkpointWriterFromPiSession(sessionManager),
        sessionId: "session-1",
        piSessionRef: "session://session-1",
        semanticFingerprint: FINGERPRINT,
        contextWindow: 200,
        keepRecentMessages: 2,
        onResult: (result, contextOperationId) => results.push({ result, contextOperationId }),
        now: () => new Date(NOW),
        ...overrides,
      });
      const agent = new PactileNativeAgent({
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("ok") }));
          return stream;
        },
        contextPipeline: pipeline,
        ...(messages === undefined ? {} : { initialState: { messages: [...messages] as never } }),
      });
      let turn = 0;
      return {
        session,
        pipeline,
        agent,
        results,
        promptUntil: async (predicate, max = 14) => {
          for (let index = 0; index < max; index += 1) {
            turn += 1;
            await agent.prompt(`turn ${String(epoch)}-${String(turn)}: ${LONG}`);
            const latest = pipeline.lastResult;
            if (latest !== null && predicate(latest)) return latest;
          }
          return null;
        },
        close: async () => {
          agent.dispose();
          await session.release();
        },
      };
    },
  };
}

async function readMemoryDocument(
  host: PactileRuntimeHost,
  session: GovernedRunSessionV1,
  result: ContextPipelineResultV1,
): Promise<{ facts: { factId: string; statement: string }[]; summaries: { statement: string }[] }> {
  const commit = result.memoryCommit;
  if (commit === null) throw new Error("expected a memory commit");
  const stored = await host.artifacts.read({
    artifactId: commit.artifactId,
    version: commit.artifactVersion,
    storageRef: commit.artifactStorageRef,
    scope: "run",
    scopeKey: session.scopeKey,
  });
  if (!stored.ok) throw new Error(stored.message);
  return JSON.parse(new TextDecoder().decode(stored.content));
}

const compacted = (result: ContextPipelineResultV1): boolean => result.status === "compacted";

describe("governed Context pipeline", () => {
  it("compacts a long run with the deterministic summary and records the Context Operation", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const a = await h.attempt({ epoch: 1 });
      const first = await a.promptUntil(compacted);
      expect(first).toMatchObject({ status: "compacted", reason: "durable_compaction_complete" });
      expect(a.results.at(-1)).toMatchObject({ contextOperationId: "context-operation-1-1" });

      // What reached durable memory: one fact per message, with the user's words.
      const document = await readMemoryDocument(h.host, a.session, first as ContextPipelineResultV1);
      expect(document.facts[0]?.statement).toContain("turn 1-1: lorem ipsum");
      expect(document.summaries.length).toBe(document.facts.length);

      // The ledger holds the decision and the audit as effects of this operation.
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.effects.map((effect) => effect.operationId).sort()).toEqual([
        "context-car-operation-1-1",
        "context-cdr-operation-1-1",
      ]);
      expect(ledger?.effects.every((effect) => effect.status === "success")).toBe(true);
      expect(ledger?.missingOperationIds).toEqual([]);
      expect(ledger?.orphanOperationIds).toEqual([]);
      expect(ledger?.ledger.contextOperations?.map((operation) => operation.kind).sort()).toContain("memory_commit");

      // The next model request sees the summary message, not the old turns.
      const messages = a.agent.state.messages;
      expect(messages.length).toBeLessThan(8);
      await a.close();
    } finally {
      await h.host.close();
    }
  });

  it("starts a new Context Operation for a second compaction instead of colliding with the first", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const a = await h.attempt({ epoch: 1 });
      expect(await a.promptUntil(compacted)).not.toBeNull();
      const second = await a.promptUntil(
        (result) => compacted(result) && a.results.filter((entry) => compacted(entry.result)).length === 2,
      );
      expect(second).not.toBeNull();
      const compactions = a.results.filter((entry) => compacted(entry.result));
      expect(compactions.map((entry) => entry.contextOperationId)).toEqual([
        "context-operation-1-1",
        "context-operation-1-2",
      ]);
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.effects.map((effect) => effect.operationId).sort()).toEqual([
        "context-car-operation-1-1",
        "context-car-operation-1-2",
        "context-cdr-operation-1-1",
        "context-cdr-operation-1-2",
      ]);
      expect(ledger?.missingOperationIds).toEqual([]);
      await a.close();
    } finally {
      await h.host.close();
    }
  });

  it("holds a compaction for review, opens exactly one review and stops asking for the rest of the attempt", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
      const a = await h.attempt({ epoch: 1, overrides: { policy } });
      const held = await a.promptUntil((result) => result.policy !== null);
      expect(held).toMatchObject({
        status: "blocked",
        reason: "context_review_required",
        policy: { verdict: "review", ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview] },
      });
      const reported = a.results.length;

      // Several more turns: the pipeline is not asked again, nothing is added.
      await a.agent.prompt(`more: ${LONG}`);
      await a.agent.prompt(`even more: ${LONG}`);
      expect(a.results.length).toBe(reported);
      expect(a.pipeline.lastResult).toBe(held);
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.ledger.approvalRequests).toHaveLength(1);
      expect(ledger?.ledger.approvalRequests?.[0]).toMatchObject({ state: "pending", contextOperationId: "context-operation-1-1" });
      expect(ledger?.effects.map((effect) => effect.operationId)).toEqual(["context-cdr-operation-1-1"]);
      await a.close();
    } finally {
      await h.host.close();
    }
  });

  it("spends the approval in a later attempt and compacts exactly the approved range", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
      const first = await h.attempt({ epoch: 1, overrides: { policy } });
      const held = await first.promptUntil((result) => result.policy !== null);
      const approvedPrefix = held?.cutPoint?.prefixMessageCount;
      const requestId = (await h.host.ledger.readRunLedger(RUN_ID))?.ledger.approvalRequests?.[0]?.approvalRequestId;
      if (requestId === undefined || approvedPrefix === undefined) throw new Error("expected a held review");
      const transcript = [...first.agent.state.messages];
      await first.close();

      await resolveContextReviewV1({
        ledger: h.host.ledger,
        artifacts: h.host.artifacts,
        runId: RUN_ID,
        approvalRequestId: requestId,
        decision: "approve",
        authority: "user",
        approvalRef: await kernelApproval(h.host, "cmd-governed-approve-1"),
        verifier: createKernelApprovalVerifierV1(h.host.productKernel),
        now: () => new Date(NOW),
      });

      // A later attempt (a later operation epoch) resumes the same transcript.
      const second = await h.attempt({ epoch: 2, overrides: { policy }, messages: transcript });
      const done = await second.promptUntil(compacted);
      expect(done).toMatchObject({ status: "compacted" });
      // Exactly the approved range, not the newest one.
      expect(done?.cutPoint?.prefixMessageCount).toBe(approvedPrefix);
      expect(done?.cutPoint?.prefixHash).toBe(held?.cutPoint?.prefixHash);
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.ledger.approvalRequests?.[0]?.resolution).toMatchObject({
        consumedBy: "context-operation-2-1",
        followUp: "new_admission",
      });
      // The admitted CDR names the approval it rests on.
      const grant = ledger?.ledger.approvalRequests?.[0]?.resolution?.grant;
      const cdrRef = ledger?.effects.find((effect) => effect.operationId === "context-cdr-operation-2-1")
        ?.payloadArtifactRef;
      if (grant === undefined || cdrRef === undefined || cdrRef === null) throw new Error("expected a grant and a CDR");
      const storedCdr = await h.host.artifacts.read({
        artifactId: "cg-cdr-context-2-1",
        version: 1,
        storageRef: cdrRef,
        scope: "run",
        scopeKey: RUN_ID,
      });
      if (!storedCdr.ok) throw new Error(storedCdr.message);
      expect(JSON.parse(new TextDecoder().decode(storedCdr.content))).toMatchObject({
        verdict: "admitted",
        authorization: { class: "reversible", grantRef: grant },
      });
      await second.close();
    } finally {
      await h.host.close();
    }
  });

  it("cannot record a compaction once its Agent session lease has been replaced", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const a = await h.attempt({ epoch: 1 });
      // Another owner takes the Agent session lease: this process is fenced.
      await runLease(h.host, "takeover");
      for (let turn = 0; turn < 8 && a.agent.state.errorMessage === undefined; turn += 1) {
        await a.agent.prompt(`turn ${String(turn)}: ${LONG}`);
      }
      // The first record the compaction writes is refused by the ledger.
      expect(a.agent.state.errorMessage).toMatch(/persistence failed: ledger_binding_failed/u);
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.effects).toEqual([]);
      expect(ledger?.ledger.approvalRequests ?? []).toEqual([]);
      await a.close();
    } finally {
      await h.host.close();
    }
  });

  it("says nothing and leaves nothing behind while the context fits", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      const a = await h.attempt({ epoch: 1, overrides: { contextWindow: 1_000_000 } });
      await a.agent.prompt("a short turn");
      await a.agent.prompt("another short turn");
      expect(a.results).toEqual([]);
      expect(a.pipeline.lastResult).toMatchObject({ status: "not_needed" });
      const ledger = await h.host.ledger.readRunLedger(RUN_ID);
      expect(ledger?.effects).toEqual([]);
      await a.close();
    } finally {
      await h.host.close();
    }
  });

  it("refuses a context window it cannot work with", async () => {
    const h = await harness();
    if (h === null) return;
    try {
      await expect(h.attempt({ epoch: 1, overrides: { contextWindow: 1 } })).rejects.toThrow(/contextWindow/u);
    } finally {
      await h.host.close();
    }
  });
});
