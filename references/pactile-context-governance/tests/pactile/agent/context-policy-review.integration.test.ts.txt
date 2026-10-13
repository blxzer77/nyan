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
  productKernelRequestHashV1,
  type MemoryFactDocumentV1,
} from "../../../src/core/index.js";
import {
  checkpointWriterFromPiSession,
  PactileContextPipeline,
  type PactileContextProposalV1,
} from "../../../src/pactile/agent/context-pipeline.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import type { AgentMessage } from "../../../src/pactile/agent/pi/types.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import {
  createRunLedgerContextAdmissionGateV1,
  createThresholdContextPolicyV1,
  CONTEXT_POLICY_RULE_IDS_V1,
  type ContextPolicyV1,
} from "../../../src/pactile/runtime/context-governance-policy.js";
import { createContextGovernancePipelineReceiptProducerV1 } from "../../../src/pactile/runtime/context-governance-pipeline-producer.js";
import {
  createKernelApprovalVerifierV1,
  resolveContextReviewV1,
} from "../../../src/pactile/runtime/context-governance-review.js";
import type { ArtifactStorePort } from "../../../src/pactile/agent/memory/artifact-store.js";
import { approvalGrantIntentIdV1 } from "../../../src/pactile/runtime/context-governance-approval-grant.js";
import { FilePiSessionManager } from "../../../src/pactile/runtime/pi-session-manager.js";
import type { RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { probeSqliteRuntimeStoreCapability } from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const NOW = "2026-10-10T00:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const SCOPE_KEY = memoryScopeKeyV1({
  scope: "run",
  workspaceId: "workspace-1",
  projectId: "project-1",
  runId: "run-1",
});

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
        statement: "The approved write set remains current.",
        basisRevision,
        tags: ["context"],
      },
    ],
    summaries: [
      {
        summaryId: `summary-${String(basisRevision)}`,
        statement: "The write set is unchanged.",
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

/** A real, durable Kernel command: the approval the Host can verify. */
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
      record: {
        schemaVersion: 1 as const,
        projectId: `proj-${commandId}`,
        title: "Approval",
        createdAt: NOW,
        archivedAt: null,
      },
    },
  ];
  await host.productKernel.applyCommand({
    commandId,
    requestHash: productKernelRequestHashV1("apply.command", { commandId, upserts }),
    expectedRevision: snapshot.revision,
    lease: {
      scope: lease.lease.scope,
      leaseId: lease.lease.leaseId,
      ownerId: lease.lease.ownerId,
      epoch: lease.lease.epoch,
    },
    upserts,
  });
  return commandId;
}

/** The stored CDR behind one of the producer's effects. */
async function readCdr(
  host: PactileRuntimeHost,
  snapshot: Awaited<ReturnType<PactileRuntimeHost["ledger"]["readRunLedger"]>>,
  operationId: string,
  artifactId: string,
): Promise<Record<string, unknown>> {
  const ref = snapshot?.effects.find((effect) => effect.operationId === operationId)?.payloadArtifactRef;
  if (ref === undefined || ref === null) throw new Error(`no CDR bound to ${operationId}`);
  const stored = await host.artifacts.read({
    artifactId,
    version: 1,
    storageRef: ref,
    scope: "run",
    scopeKey: "run-1",
  });
  if (!stored.ok) throw new Error(stored.message);
  return JSON.parse(new TextDecoder().decode(stored.content)) as Record<string, unknown>;
}

interface Harness {
  readonly host: PactileRuntimeHost;
  readonly root: string;
  readonly lease: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly expiresAt: string;
    readonly partition: string;
  };
  readonly summaries: { count: number; lastMessageCount: number | null };
  /** A pipeline for one operation, gated by the given policy. */
  pipeline(input: {
    readonly operation: number;
    readonly policy?: ContextPolicyV1;
    /** What the admission gate reads and finishes grant snapshots with. */
    readonly gateArtifacts?: ArtifactStorePort;
  }): PactileContextPipeline;
}

async function harness(): Promise<Harness | null> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cg-policy-"));
  roots.push(root);
  const host = await openPactileRuntimeHost({ repositoryRoot: root, now: () => new Date(NOW) });
  // Note: no CDR / CAR effect is seeded. The producer has to create them.
  await host.ledger.commitRunLedger({
    idempotencyKey: "seed-policy-ledger",
    requestHash: runtimeRequestHashV1("run-ledger.seed", initialLedger()),
    ledger: initialLedger(),
    effects: [],
  });
  const leaseRecord = await host.store.acquireLease({
    partition: memoryPartitionV1("run", SCOPE_KEY),
    runId: "run-1",
    ownerId: "context-owner-1",
    ttlMs: 600_000,
    idempotencyKey: "context-lease-policy",
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
  const session = new FilePiSessionManager({
    sessionId: "session-1",
    sessionFile: path.join(root, ".pactile", "sessions", "session-1.jsonl"),
  });
  const summaries = { count: 0, lastMessageCount: null as number | null };
  const now = () => new Date(NOW);
  return {
    host,
    root,
    lease,
    summaries,
    pipeline: ({ operation, policy, gateArtifacts }) => {
      const contextOperationId = `context-operation-${String(operation)}`;
      return new PactileContextPipeline({
        durability: host.memory,
        audits: host.store,
        checkpoint: checkpointWriterFromPiSession(session),
        admissionGate: createRunLedgerContextAdmissionGateV1({
          ledger: host.ledger,
          artifacts: gateArtifacts ?? host.artifacts,
          runId: "run-1",
          ...(policy === undefined ? {} : { policy }),
          contextOperationId,
          operationEpoch: operation,
          now,
        }),
        scope: "run",
        scopeKey: SCOPE_KEY,
        runId: "run-1",
        semanticFingerprint: `sha256:${"1".repeat(64)}`,
        operationEpoch: operation,
        contextOperationId,
        sourceCursor: "session-1:0",
        leaseEpoch: lease.epoch,
        lease,
        fencingToken: `fence-${String(operation)}`,
        commandId: `command-${String(operation)}`,
        piSessionRef: "session://session-1",
        whenToRead: "Read before choosing the next write.",
        contextWindow: 100,
        reserveTokens: 10,
        keepRecentMessages: 1,
        measureTokens: () => 90,
        summarize: ({ basisRevision, messages }) => {
          summaries.count += 1;
          summaries.lastMessageCount = messages.length;
          return memoryDocument(basisRevision);
        },
        now,
        onResult: createContextGovernancePipelineReceiptProducerV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: operation,
          contextOperationId,
          scopeKey: "run-1",
          cdrOperationId: `context-cdr-operation-${String(operation)}`,
          carOperationId: `context-car-operation-${String(operation)}`,
          cdrArtifactId: `cg-cdr-context-${String(operation)}`,
          carArtifactId: `cg-car-context-${String(operation)}`,
          memoryCommit: {
            scope: "run",
            scopeKey: SCOPE_KEY,
            artifactId: `cg-memory-commit-context-${String(operation)}`,
          },
          now,
        }),
      });
    },
  };
}

/** Two completed turns and the start of a third: a valid prefix of 2 messages. */
async function transcript(
  pipeline: PactileContextPipeline,
): Promise<{ agent: PactileNativeAgent; messages: AgentMessage[] }> {
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
  return { agent, messages: [...agent.state.messages] };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

async function prepare(
  pipeline: PactileContextPipeline,
  messages: readonly AgentMessage[],
) {
  await pipeline.prepareRequest({
    context: { systemPrompt: "", messages: [...messages], tools: [] } as never,
    model: {} as never,
    thinkingLevel: "off",
  } as never);
  const result = pipeline.lastResult;
  if (result === null) throw new Error("expected a pipeline result");
  return result;
}

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "Policy Gate and review_required through the native Context pipeline",
  () => {
    it("holds a large compaction for review, records it, and stays held without duplicating records", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
        const first = h.pipeline({ operation: 1, policy });
        const { agent } = await transcript(first);
        const held = agent.lastContextPipelineResult;
        expect(held).toMatchObject({
          status: "blocked",
          reason: "context_review_required",
          messages: null,
          memoryCommitRequest: null,
          policy: {
            verdict: "review",
            ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview],
          },
          proposal: { action: "externalize", effectClass: "reversible", prefixMessageCount: 2 },
        });
        // Nothing ran: no summary provider call, no memory write.
        expect(h.summaries.count).toBe(0);
        await expect(h.host.store.readCurrent({ scope: "run", scopeKey: SCOPE_KEY })).resolves.toMatchObject({
          ok: true,
          status: "absent",
        });

        const snapshot = await h.host.ledger.readRunLedger("run-1");
        // The producer created the CDR effect itself and bound the receipt.
        expect(snapshot?.effects).toEqual([
          expect.objectContaining({
            operationId: "context-cdr-operation-1",
            status: "success",
            payloadType: "pactile.cg.compression-decision-receipt",
          }),
        ]);
        expect(snapshot?.missingOperationIds).toEqual([]);
        expect(snapshot?.ledger.approvalRequests).toEqual([
          expect.objectContaining({
            state: "pending",
            contextOperationId: "context-operation-1",
            subject: expect.objectContaining({
              source: "cdr",
              proposal: {
                prefixMessageCount: 2,
                prefixHash: held?.cutPoint?.prefixHash,
                basisRevision: held?.cutPoint?.basisRevision,
              },
            }),
          }),
        ]);
        const artifactRef = snapshot?.effects[0]?.payloadArtifactRef ?? "";
        const stored = await h.host.artifacts.read({
          artifactId: "cg-cdr-context-1",
          version: 1,
          storageRef: artifactRef,
          scope: "run",
          scopeKey: "run-1",
        });
        if (!stored.ok) throw new Error(stored.message);
        const cdr = JSON.parse(new TextDecoder().decode(stored.content)) as Record<string, unknown>;
        expect(cdr).toMatchObject({
          verdict: "review_required",
          policy: { ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview] },
          requestRef: { bodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
        });

        // Held: later turns are refused by the pending review, and add no records.
        const revision = snapshot?.ledger.revision;
        const messages = [...agent.state.messages, userMessage("third turn")];
        await expect(prepare(first, messages)).resolves.toMatchObject({
          status: "blocked",
          reason: "context_review_pending",
          policy: null,
        });
        const after = await h.host.ledger.readRunLedger("run-1");
        expect(after?.ledger.revision).toBe(revision);
        expect(after?.ledger.approvalRequests).toHaveLength(1);
        agent.dispose();
      } finally {
        await h.host.close();
      }
    });

    it("spends an approval once, on a later operation, for exactly the approved range", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
        const { agent, messages } = await transcript(h.pipeline({ operation: 1, policy }));
        const held = agent.lastContextPipelineResult;
        const requestId = (await h.host.ledger.readRunLedger("run-1"))?.ledger.approvalRequests?.[0]
          ?.approvalRequestId;
        if (requestId === undefined || held?.cutPoint === null || held === null) {
          throw new Error("expected a held review");
        }
        agent.dispose();

        // The user approves through a durable Kernel command.
        const approvalRef = await kernelApproval(h.host, "cmd-policy-approve-1");
        await expect(
          resolveContextReviewV1({
            ledger: h.host.ledger,
            artifacts: h.host.artifacts,
            runId: "run-1",
            approvalRequestId: requestId,
            decision: "approve",
            authority: "user",
            approvalRef,
            verifier: createKernelApprovalVerifierV1(h.host.productKernel),
            now: () => new Date(NOW),
          }),
        ).resolves.toMatchObject({ ok: true, request: { state: "approved" } });

        // The transcript grew meanwhile: the newest cut-point is now larger.
        const grown = [...messages, userMessage("third turn"), { ...messages[1] } as AgentMessage, userMessage("fourth turn")];

        // The operation that asked cannot spend its own approval, even though
        // it is approved: it needs a new admission.
        await expect(prepare(h.pipeline({ operation: 1, policy }), grown)).resolves.toMatchObject({
          status: "blocked",
          reason: "context_review_required",
        });
        const stillOpen = await h.host.ledger.readRunLedger("run-1");
        expect(stillOpen?.ledger.approvalRequests?.[0]?.resolution?.consumedBy).toBeNull();
        expect(stillOpen?.ledger.approvalRequests).toHaveLength(1);

        // A later operation spends it, and compacts the approved range only.
        const second = await prepare(h.pipeline({ operation: 2, policy }), grown);
        expect(second).toMatchObject({ status: "compacted" });
        expect(second.cutPoint?.prefixMessageCount).toBe(2);
        expect(second.cutPoint?.prefixHash).toBe(held.cutPoint?.prefixHash);
        expect(h.summaries.count).toBe(1);
        expect(h.summaries.lastMessageCount).toBe(2);
        const spent = await h.host.ledger.readRunLedger("run-1");
        expect(spent?.ledger.approvalRequests?.[0]?.resolution).toMatchObject({
          consumedBy: "context-operation-2",
          followUp: "new_admission",
        });
        // The admitted CDR and the CAR effect were created by the producer too.
        expect(spent?.effects.map((effect) => effect.operationId).sort()).toEqual([
          "context-car-operation-2",
          "context-cdr-operation-1",
          "context-cdr-operation-2",
        ]);
        expect(spent?.missingOperationIds).toEqual([]);

        // The admitted CDR names the approval it rests on, by an immutable
        // artifact reference, and the policy that asked for the review.
        const grant = spent?.ledger.approvalRequests?.[0]?.resolution?.grant;
        expect(grant).toMatchObject({
          artifactId: expect.stringMatching(/^cg-approval-grant-context-review-/u),
          version: 1,
          contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        });
        const admitted = await readCdr(h.host, spent, "context-cdr-operation-2", "cg-cdr-context-2");
        expect(admitted).toMatchObject({
          verdict: "admitted",
          authorization: { class: "reversible", grantRef: grant },
          policy: { ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview] },
        });
        const asked = await readCdr(h.host, spent, "context-cdr-operation-1", "cg-cdr-context-1");
        expect(asked).toMatchObject({
          verdict: "review_required",
          authorization: { grantRef: null },
        });
        // The reference resolves to the snapshot of the decision.
        const snapshotArtifact = await h.host.artifacts.read({
          artifactId: grant?.artifactId ?? "",
          version: 1,
          storageRef: grant?.storageRef ?? "",
          scope: "run",
          scopeKey: "run-1",
        });
        if (!snapshotArtifact.ok) throw new Error(snapshotArtifact.message);
        expect(JSON.parse(new TextDecoder().decode(snapshotArtifact.content))).toMatchObject({
          schemaId: "pactile.cg.approval-grant",
          decision: "approved",
          subject: { proposal: { prefixMessageCount: 2, prefixHash: held.cutPoint?.prefixHash } },
          grantedBy: { authority: "user", attestation: { kernelFact: false } },
        });

        // One approval, one compaction: the next operation is held again for a new review.
        const third = await prepare(h.pipeline({ operation: 3, policy }), grown);
        expect(third).toMatchObject({ status: "blocked", reason: "context_review_required" });
        expect(h.summaries.count).toBe(1);
        const reopened = await h.host.ledger.readRunLedger("run-1");
        expect(reopened?.ledger.approvalRequests?.map((request) => request.state)).toEqual([
          "approved",
          "pending",
        ]);
      } finally {
        await h.host.close();
      }
    });

    it("does not spend an approval until its grant snapshot is written, and finishes it when it can", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
        const { agent, messages } = await transcript(h.pipeline({ operation: 1, policy }));
        const requestId = (await h.host.ledger.readRunLedger("run-1"))?.ledger.approvalRequests?.[0]
          ?.approvalRequestId;
        if (requestId === undefined) throw new Error("expected a held review");
        agent.dispose();

        // The disk fails while the decision is recorded: the decision stands,
        // and its snapshot is a pending plan that cannot be written yet.
        const failing = Object.assign(Object.create(h.host.artifacts) as ArtifactStorePort, {
          prepare: () => Promise.resolve({ ok: false, code: "artifact_store_unavailable", message: "simulated disk failure" }),
        }) as ArtifactStorePort;
        const decided = await resolveContextReviewV1({
          ledger: h.host.ledger,
          artifacts: failing,
          runId: "run-1",
          approvalRequestId: requestId,
          decision: "approve",
          authority: "kernel",
          approvalRef: await kernelApproval(h.host, "cmd-policy-approve-3"),
          verifier: createKernelApprovalVerifierV1(h.host.productKernel),
          now: () => new Date(NOW),
        });
        expect(decided).toMatchObject({ ok: true, grantBound: false, request: { state: "approved" } });
        const pending = await h.host.ledger.readRunLedger("run-1");
        // The first intent is the review CDR's, already bound; the second is the grant's.
        expect(pending?.ledger.artifactIntents?.map((intent) => intent.state)).toEqual(["bound", "pending"]);

        const grown = [...messages, userMessage("third turn"), { ...messages[1] } as AgentMessage, userMessage("fourth turn")];
        // The gate cannot finish the snapshot either: the approval is not spent.
        const refused = await prepare(h.pipeline({ operation: 2, policy, gateArtifacts: failing }), grown);
        expect(refused).toMatchObject({ status: "blocked", reason: "context_review_admission_failed" });
        expect(h.summaries.count).toBe(0);
        expect(
          (await h.host.ledger.readRunLedger("run-1"))?.ledger.approvalRequests?.[0]?.resolution?.consumedBy,
        ).toBeNull();

        // With a working store the gate writes the snapshot first, then spends.
        const done = await prepare(h.pipeline({ operation: 3, policy }), grown);
        expect(done).toMatchObject({ status: "compacted", grant: { artifactRef: { version: 1 } } });
        const after = await h.host.ledger.readRunLedger("run-1");
        // The grant's intent was finished by the gate, along with the compaction's own.
        expect(
          after?.ledger.artifactIntents?.find(
            (intent) => intent.intentId === approvalGrantIntentIdV1("run-1", requestId),
          )?.state,
        ).toBe("bound");
        expect(after?.ledger.artifactIntents?.every((intent) => intent.state === "bound")).toBe(true);
        expect(after?.ledger.contextOperations?.map((operation) => operation.kind)).toContain("approval_grant");
        expect(after?.ledger.approvalRequests?.[0]?.resolution?.consumedBy).toBe("context-operation-3");
      } finally {
        await h.host.close();
      }
    });

    it("does not spend an approval that has no grant snapshot, such as a decision recorded before snapshots existed", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
        const { agent, messages } = await transcript(h.pipeline({ operation: 1, policy }));
        agent.dispose();
        const held = await h.host.ledger.readRunLedger("run-1");
        const request = held?.ledger.approvalRequests?.[0];
        if (held === null || request === undefined) throw new Error("expected a held review");
        // An approved decision exactly as an older release recorded it: no grant.
        const legacy = {
          ...request,
          state: "approved" as const,
          resolution: {
            approvalRef: "legacy-approval",
            authority: "user" as const,
            decidedAt: NOW,
            evidenceRef: null,
            followUp: "new_admission" as const,
            consumedBy: null,
          },
        };
        const next = {
          ...held.ledger,
          approvalRequests: [legacy],
          commitId: `${held.ledger.commitId}:legacy-approval`,
          revision: held.ledger.revision + 1,
          updatedAt: NOW,
        };
        await h.host.ledger.commitRunLedger({
          idempotencyKey: "legacy-approval",
          requestHash: runtimeRequestHashV1("run-ledger.legacy-approval", { revision: next.revision }),
          ledger: next,
          effects: held.effects,
        });

        const grown = [...messages, userMessage("third turn"), { ...messages[1] } as AgentMessage, userMessage("fourth turn")];
        const result = await prepare(h.pipeline({ operation: 2, policy }), grown);
        expect(result).toMatchObject({ status: "blocked", reason: "context_review_required" });
        expect(h.summaries.count).toBe(0);
        const after = await h.host.ledger.readRunLedger("run-1");
        expect(after?.ledger.approvalRequests?.[0]?.resolution?.consumedBy).toBeNull();

        // The new situation opened its own review; once that one is approved
        // properly, the gate spends IT, not the older grantless approval that
        // still sits first in the ledger.
        const second = after?.ledger.approvalRequests?.[1];
        if (second === undefined) throw new Error("expected a second review");
        await resolveContextReviewV1({
          ledger: h.host.ledger,
          artifacts: h.host.artifacts,
          runId: "run-1",
          approvalRequestId: second.approvalRequestId,
          decision: "approve",
          authority: "kernel",
          approvalRef: await kernelApproval(h.host, "cmd-policy-approve-4"),
          verifier: createKernelApprovalVerifierV1(h.host.productKernel),
          now: () => new Date(NOW),
        });
        const spent = await prepare(h.pipeline({ operation: 3, policy }), grown);
        expect(spent).toMatchObject({ status: "compacted" });
        expect(spent.cutPoint?.prefixHash).toBe(second.subject.proposal?.prefixHash);
        const final = await h.host.ledger.readRunLedger("run-1");
        expect(final?.ledger.approvalRequests?.map((request) => request.resolution?.consumedBy ?? null)).toEqual([
          null,
          "context-operation-3",
        ]);
      } finally {
        await h.host.close();
      }
    });

    it("does not burn an approval on a range that is no longer a valid cut-point", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 2 });
        const { agent, messages } = await transcript(h.pipeline({ operation: 1, policy }));
        const requestId = (await h.host.ledger.readRunLedger("run-1"))?.ledger.approvalRequests?.[0]
          ?.approvalRequestId;
        if (requestId === undefined) throw new Error("expected a held review");
        agent.dispose();
        await resolveContextReviewV1({
          ledger: h.host.ledger,
          artifacts: h.host.artifacts,
          runId: "run-1",
          approvalRequestId: requestId,
          decision: "approve",
          authority: "user",
          approvalRef: await kernelApproval(h.host, "cmd-policy-approve-2"),
          verifier: createKernelApprovalVerifierV1(h.host.productKernel),
          now: () => new Date(NOW),
        });

        // A different history: the approved prefix no longer exists.
        const rewritten = [
          userMessage("a different first turn"),
          messages[1] as AgentMessage,
          userMessage("a different second turn"),
          messages[3] as AgentMessage,
          userMessage("third"),
        ];
        const result = await prepare(h.pipeline({ operation: 2, policy }), rewritten);
        expect(result).toMatchObject({ status: "blocked", reason: "context_review_required" });
        expect(h.summaries.count).toBe(0);
        const ledger = await h.host.ledger.readRunLedger("run-1");
        // Still approved and unspent; the new range waits for its own review.
        expect(ledger?.ledger.approvalRequests?.map((request) => request.state)).toEqual([
          "approved",
          "pending",
        ]);
        expect(ledger?.ledger.approvalRequests?.[0]?.resolution?.consumedBy).toBeNull();
      } finally {
        await h.host.close();
      }
    });

    it("blocks a denied proposal with a blocked CDR and no review, and allows everything without a policy", async () => {
      const h = await harness();
      if (h === null) return;
      try {
        const denying: ContextPolicyV1 = {
          policyVersion: "test-deny-v1",
          evaluate: () => ({
            verdict: "deny",
            policyVersion: "test-deny-v1",
            ruleIds: ["test.rule"],
            reason: "not open",
          }),
        };
        const { agent } = await transcript(h.pipeline({ operation: 1, policy: denying }));
        expect(agent.lastContextPipelineResult).toMatchObject({
          status: "blocked",
          reason: "context_policy_denied",
          policy: { verdict: "deny", ruleIds: ["test.rule"] },
        });
        agent.dispose();
        const snapshot = await h.host.ledger.readRunLedger("run-1");
        expect(snapshot?.ledger.approvalRequests ?? []).toEqual([]);
        const artifactRef = snapshot?.effects[0]?.payloadArtifactRef ?? "";
        const stored = await h.host.artifacts.read({
          artifactId: "cg-cdr-context-1",
          version: 1,
          storageRef: artifactRef,
          scope: "run",
          scopeKey: "run-1",
        });
        if (!stored.ok) throw new Error(stored.message);
        expect(JSON.parse(new TextDecoder().decode(stored.content))).toMatchObject({
          verdict: "blocked",
          policy: { policyVersion: "test-deny-v1", ruleIds: ["test.rule"] },
        });
        expect(h.summaries.count).toBe(0);

        // No policy configured: the previous behaviour, compaction proceeds.
        const open = await transcript(h.pipeline({ operation: 2 }));
        expect(open.agent.lastContextPipelineResult).toMatchObject({ status: "compacted" });
        expect(h.summaries.count).toBe(1);
        open.agent.dispose();
      } finally {
        await h.host.close();
      }
    });
  },
);

describe("threshold Context policy", () => {
  const proposal: PactileContextProposalV1 = {
    action: "externalize",
    effectClass: "reversible",
    contextTokens: 90,
    prefixMessageCount: 4,
    retainedMessageCount: 1,
    prefixHash: HASH,
    basisRevision: 4,
  };

  it("allows by default, reviews above a threshold and names the rule", () => {
    expect(createThresholdContextPolicyV1().evaluate(proposal)).toEqual({ verdict: "allow" });
    expect(
      createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 5 }).evaluate(proposal),
    ).toEqual({ verdict: "allow" });
    expect(
      createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 4 }).evaluate(proposal),
    ).toMatchObject({
      verdict: "review",
      ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview],
    });
    expect(
      createThresholdContextPolicyV1({
        reviewWhenPrefixMessagesAtLeast: 4,
        reviewWhenContextTokensAtLeast: 90,
      }).evaluate(proposal),
    ).toMatchObject({
      verdict: "review",
      ruleIds: [
        CONTEXT_POLICY_RULE_IDS_V1.largePrefixReview,
        CONTEXT_POLICY_RULE_IDS_V1.highContextReview,
      ],
    });
  });

  it("never opens an action that is not a reversible externalize, whatever the thresholds say", () => {
    const policy = createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 1000 });
    for (const bad of [
      { ...proposal, action: "drop" },
      { ...proposal, action: "lossy_compress" },
      { ...proposal, effectClass: "lossy" },
    ]) {
      expect(policy.evaluate(bad as unknown as PactileContextProposalV1)).toMatchObject({
        verdict: "deny",
        ruleIds: [CONTEXT_POLICY_RULE_IDS_V1.actionNotOpen],
      });
    }
  });

  it("refuses a nonsensical threshold", () => {
    expect(() => createThresholdContextPolicyV1({ reviewWhenPrefixMessagesAtLeast: 0 })).toThrow(
      /positive safe integer/u,
    );
    expect(() => createThresholdContextPolicyV1({ reviewWhenContextTokensAtLeast: 1.5 })).toThrow(
      /positive safe integer/u,
    );
  });
});
