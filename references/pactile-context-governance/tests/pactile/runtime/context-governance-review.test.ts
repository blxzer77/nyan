import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  productKernelRequestHashV1,
  type ProductKernelFactUpsertV1,
} from "../../../src/core/index.js";
import { CAR_CHECK_IDS_V1 } from "../../../src/pactile/runtime/context-governance-receipts.js";
import {
  admitReviewedContextOperationV1,
  contextOperationStateForReviewV1,
  createKernelApprovalVerifierV1,
  createRunLedgerContextReviewGateV1,
  expireContextReviewsV1,
  openContextReviewForReceiptV1,
  openContextReviewV1,
  pendingContextReviewsV1,
  resolveContextReviewV1,
  type ContextReviewApprovalVerifierV1,
} from "../../../src/pactile/runtime/context-governance-review.js";
import type {
  EffectLedgerEntryV1,
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
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);

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

function envelope(schemaId: string, contextOperationId: string): Record<string, unknown> {
  return {
    schemaId,
    schemaVersion: 1,
    plane: "runtime",
    workspaceId: "workspace-1",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    operationEpoch: 1,
    contextOperationId,
    bodyHash: hash,
    receiptHash: hash,
    createdAt: "2026-10-10T00:00:01Z",
    provenance: { authority: "host" },
  };
}

function cdrReview(contextOperationId: string, operationId: string): RuntimeStoreJsonObject {
  return {
    ...envelope("pactile.cg.compression-decision-receipt", contextOperationId),
    receiptId: `cdr-${contextOperationId}`,
    requestRef: { schemaId: "pactile.cg.compression-decision-request", schemaVersion: 1 },
    verdict: "review_required",
    adopted: [],
    overridden: [],
    policy: { policyVersion: "policy-v1", ruleIds: [] },
    authorization: { class: "reversible", grantRef: null },
    effect: { operationId, ledgerReceiptId: null },
  } as unknown as RuntimeStoreJsonObject;
}

function carReview(contextOperationId: string): RuntimeStoreJsonObject {
  return {
    ...envelope("pactile.cg.compaction-audit-receipt", contextOperationId),
    auditId: `car-${contextOperationId}`,
    decisionRef: { schemaId: "pactile.cg.compression-decision-receipt", schemaVersion: 1, receiptId: "cdr-1" },
    compaction: { piCompactionId: "compaction-1", commitReceiptRef: null },
    snapshots: { beforeHash: hash, afterHash: hash },
    checks: CAR_CHECK_IDS_V1.map((id) => ({
      id,
      result: { status: "unknown", value: "fail" },
      detailHash: null,
    })),
    verdict: "review_required",
    regressionCaseRef: null,
  } as unknown as RuntimeStoreJsonObject;
}

async function openHost(root?: string): Promise<PactileRuntimeHost> {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "pactile-review-"));
  if (root === undefined) roots.push(dir);
  return openPactileRuntimeHost({ repositoryRoot: dir });
}

async function seed(host: PactileRuntimeHost): Promise<void> {
  const initial = ledger();
  await host.ledger.commitRunLedger({
    idempotencyKey: "seed-ledger-review-1",
    requestHash: runtimeRequestHashV1("run-ledger.seed", initial),
    ledger: initial,
    effects: [],
  });
}

/** A real, durable Product Kernel command: the approval the Host can verify. */
async function kernelApproval(host: PactileRuntimeHost, commandId: string): Promise<string> {
  const lease = await host.productKernel.acquireLease({
    commandId: `lease-${commandId}`,
    requestHash: productKernelRequestHashV1("acquire.lease", { commandId }),
    scope: "product-kernel",
    ownerId: "owner-a",
    ttlMs: 60_000,
  });
  const snapshot = await host.productKernel.readSnapshot();
  const upserts: ProductKernelFactUpsertV1[] = [
    {
      factKind: "project",
      record: {
        schemaVersion: 1,
        projectId: `proj-${commandId}`,
        title: "Approval",
        createdAt: "2026-10-10T00:00:00.000Z",
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

function clock(startMs = T0) {
  let current = startMs;
  const fn = () => new Date(current);
  return Object.assign(fn, { advance: (ms: number) => { current += ms; } });
}

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "review_required Host approval path",
  () => {
    it("holds a CDR operation, refuses self-approval and unverified approvals, then approves through the Kernel", async () => {
      const host = await openHost();
      try {
        await seed(host);
        const now = clock();
        const opened = await openContextReviewForReceiptV1({
          ledger: host.ledger,
          runId: "run-1",
          receipt: cdrReview("context-op-1", "effect-1"),
          effect: effect("effect-1"),
          expiresAt: new Date(T0 + 3_600_000).toISOString(),
          now,
        });
        expect(opened).toMatchObject({
          ok: true,
          applied: true,
          request: {
            state: "pending",
            contextOperationId: "context-op-1",
            subject: { source: "cdr", receiptId: "cdr-context-op-1" },
            resolution: null,
          },
        });
        if (!opened.ok) throw new Error(opened.message);
        const id = opened.request.approvalRequestId;
        expect(contextOperationStateForReviewV1(opened.request)).toBe("waiting");
        // Opening is idempotent per held operation.
        await expect(
          openContextReviewForReceiptV1({
            ledger: host.ledger,
            runId: "run-1",
            receipt: cdrReview("context-op-1", "effect-1"),
            effect: effect("effect-1"),
            expiresAt: new Date(T0 + 3_600_000).toISOString(),
            now,
          }),
        ).resolves.toMatchObject({ ok: true, applied: false });
        const verifier = createKernelApprovalVerifierV1(host.productKernel);
        const before = await host.ledger.readRunLedger("run-1");

        // Nothing but a user or the Kernel decides; the model, a provider, a
        // Controller or an evaluation run cannot, whatever approvalRef they cite.
        for (const authority of ["model", "provider", "controller", "evaluation", "agent", ""]) {
          await expect(
            resolveContextReviewV1({
              ledger: host.ledger,
              artifacts: host.artifacts,
              runId: "run-1",
              approvalRequestId: id,
              decision: "approve",
              authority,
              approvalRef: "cmd-whatever",
              verifier: { verify: async () => ({ ok: true, recordedAt: "x" }) },
              now,
            }),
          ).resolves.toMatchObject({ ok: false, code: "self_approval_refused" });
        }
        // A ref that is not a durable Kernel command proves nothing.
        await expect(
          resolveContextReviewV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            approvalRequestId: id,
            decision: "approve",
            authority: "user",
            approvalRef: "cmd-never-happened",
            verifier,
            now,
          }),
        ).resolves.toMatchObject({ ok: false, code: "approval_unverified" });
        const stillPending = await host.ledger.readRunLedger("run-1");
        expect(stillPending?.ledger.revision).toBe(before?.ledger.revision);
        if (stillPending === null) throw new Error("expected a ledger");
        expect(pendingContextReviewsV1(stillPending.ledger)).toHaveLength(1);

        const approvalRef = await kernelApproval(host, "cmd-approve-1");
        const approved = await resolveContextReviewV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          runId: "run-1",
          approvalRequestId: id,
          decision: "approve",
          authority: "kernel",
          approvalRef,
          evidenceRef: "evidence-1",
          verifier,
          now,
        });
        expect(approved).toMatchObject({
          ok: true,
          applied: true,
          request: {
            state: "approved",
            resolution: {
              approvalRef,
              authority: "kernel",
              evidenceRef: "evidence-1",
              followUp: "new_admission",
              consumedBy: null,
            },
          },
        });
        // Replays do nothing; a different decision on a decided request is refused.
        await expect(
          resolveContextReviewV1({
            ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: id, decision: "approve",
            authority: "kernel", approvalRef, verifier, now,
          }),
        ).resolves.toMatchObject({ ok: true, applied: false });
        await expect(
          resolveContextReviewV1({
            ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: id, decision: "reject",
            authority: "kernel", approvalRef, verifier, now,
          }),
        ).resolves.toMatchObject({ ok: false, code: "already_resolved" });
      } finally {
        await host.close();
      }
    });

    it("lets an approved proposal run only through one new admission", async () => {
      const host = await openHost();
      try {
        await seed(host);
        const now = clock();
        const verifier = createKernelApprovalVerifierV1(host.productKernel);
        const opened = await openContextReviewV1({
          ledger: host.ledger,
          runId: "run-1",
          attemptId: "attempt-1",
          turnId: "turn-1",
          operationEpoch: 1,
          contextOperationId: "context-op-2",
          subject: { source: "cdq", receiptId: "cdq-1", payloadHash: null, manifestRef: "memory://manifest-1" },
          expiresAt: new Date(T0 + 3_600_000).toISOString(),
          now,
        });
        if (!opened.ok) throw new Error(opened.message);
        const id = opened.request.approvalRequestId;

        // Not approved yet: nothing can be admitted.
        await expect(
          admitReviewedContextOperationV1({
            ledger: host.ledger, runId: "run-1", approvalRequestId: id,
            newContextOperationId: "context-op-3", newOperationEpoch: 2, now,
          }),
        ).resolves.toMatchObject({ ok: false, code: "not_approved" });

        await resolveContextReviewV1({
          ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: id, decision: "approve",
          authority: "user", approvalRef: await kernelApproval(host, "cmd-approve-2"), verifier, now,
        });

        const admit = (newId: string, epoch: number) =>
          admitReviewedContextOperationV1({
            ledger: host.ledger, runId: "run-1", approvalRequestId: id,
            newContextOperationId: newId, newOperationEpoch: epoch, now,
          });
        // The held operation cannot simply run again, nor can the epoch stand still.
        await expect(admit("context-op-2", 2)).resolves.toMatchObject({ ok: false, code: "admission_invalid" });
        await expect(admit("context-op-3", 1)).resolves.toMatchObject({ ok: false, code: "admission_invalid" });
        const spent = await admit("context-op-3", 2);
        expect(spent).toMatchObject({
          ok: true,
          applied: true,
          request: { resolution: { followUp: "new_admission", consumedBy: "context-op-3" } },
        });
        await expect(admit("context-op-3", 2)).resolves.toMatchObject({ ok: true, applied: false });
        await expect(admit("context-op-4", 3)).resolves.toMatchObject({ ok: false, code: "already_consumed" });
      } finally {
        await host.close();
      }
    });

    it("only lets a review of an executed CAR choose restore, expand or block", async () => {
      const host = await openHost();
      try {
        await seed(host);
        const now = clock();
        const verifier = createKernelApprovalVerifierV1(host.productKernel);
        const opened = await openContextReviewForReceiptV1({
          ledger: host.ledger, runId: "run-1", receipt: carReview("context-op-car"),
          effect: effect("effect-car"), expiresAt: new Date(T0 + 3_600_000).toISOString(), now,
        });
        if (!opened.ok) throw new Error(opened.message);
        const id = opened.request.approvalRequestId;
        const approvalRef = await kernelApproval(host, "cmd-approve-car");
        const decide = (followUp?: "new_admission" | "restore" | "expand" | "block") =>
          resolveContextReviewV1({
            ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: id, decision: "approve",
            authority: "user", approvalRef, verifier, now,
            ...(followUp === undefined ? {} : { followUp }),
          });
        // The audit conclusion is not rewritten and nothing is re-admitted.
        await expect(decide()).resolves.toMatchObject({ ok: false, code: "input_invalid" });
        await expect(decide("new_admission")).resolves.toMatchObject({ ok: false, code: "input_invalid" });
        await expect(decide("restore")).resolves.toMatchObject({
          ok: true,
          request: { state: "approved", resolution: { followUp: "restore" } },
        });
        await expect(
          admitReviewedContextOperationV1({
            ledger: host.ledger, runId: "run-1", approvalRequestId: id,
            newContextOperationId: "context-op-next", newOperationEpoch: 2, now,
          }),
        ).resolves.toMatchObject({ ok: false, code: "not_approved" });
      } finally {
        await host.close();
      }
    });

    it("blocks on rejection and on expiry, and the gate holds new compaction only while pending", async () => {
      const host = await openHost();
      try {
        await seed(host);
        const now = clock();
        const verifier = createKernelApprovalVerifierV1(host.productKernel);
        const gate = createRunLedgerContextReviewGateV1({ ledger: host.ledger, runId: "run-1", now });
        await expect(gate.check()).resolves.toEqual({ allowed: true });

        const open = async (operationId: string) => {
          const result = await openContextReviewV1({
            ledger: host.ledger, runId: "run-1", attemptId: "attempt-1", turnId: "turn-1",
            operationEpoch: 1, contextOperationId: operationId,
            subject: { source: "cdq", receiptId: `cdq-${operationId}`, payloadHash: null, manifestRef: null },
            expiresAt: new Date(now().getTime() + 60_000).toISOString(), now,
          });
          if (!result.ok) throw new Error(result.message);
          return result.request.approvalRequestId;
        };

        const rejectedId = await open("context-op-reject");
        await expect(gate.check()).resolves.toEqual({ allowed: false, reason: "context_review_pending" });
        const rejected = await resolveContextReviewV1({
          ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: rejectedId, decision: "reject",
          authority: "user", approvalRef: await kernelApproval(host, "cmd-reject-1"), verifier, now,
        });
        expect(rejected).toMatchObject({ ok: true, request: { state: "rejected", resolution: { followUp: "block" } } });
        if (!rejected.ok) throw new Error(rejected.message);
        expect(contextOperationStateForReviewV1(rejected.request)).toBe("blocked");
        await expect(gate.check()).resolves.toEqual({ allowed: true });
        await expect(
          admitReviewedContextOperationV1({
            ledger: host.ledger, runId: "run-1", approvalRequestId: rejectedId,
            newContextOperationId: "context-op-after-reject", newOperationEpoch: 2, now,
          }),
        ).resolves.toMatchObject({ ok: false, code: "not_approved" });

        // An unanswered review expires: the decision comes too late, the held
        // operation stays blocked and the gate reopens.
        const expiringId = await open("context-op-expire");
        await expect(gate.check()).resolves.toEqual({ allowed: false, reason: "context_review_pending" });
        now.advance(61_000);
        const late = await resolveContextReviewV1({
          ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: expiringId, decision: "approve",
          authority: "user", approvalRef: await kernelApproval(host, "cmd-late-1"), verifier, now,
        });
        expect(late).toMatchObject({ ok: false, code: "expired", request: { state: "expired", resolution: null } });
        const stored = await host.ledger.readRunLedger("run-1");
        expect(stored?.ledger.approvalRequests?.find((r) => r.approvalRequestId === expiringId)?.state).toBe("expired");
        await expect(gate.check()).resolves.toEqual({ allowed: true });

        // The gate also expires an overdue review by itself, and fails closed
        // when it cannot read the ledger.
        const sweptId = await open("context-op-swept");
        now.advance(61_000);
        await expect(gate.check()).resolves.toEqual({ allowed: true });
        const swept = await host.ledger.readRunLedger("run-1");
        expect(swept?.ledger.approvalRequests?.find((r) => r.approvalRequestId === sweptId)?.state).toBe("expired");
        await expect(expireContextReviewsV1({ ledger: host.ledger, runId: "run-1", now })).resolves.toMatchObject({ ok: true, expired: [] });
        const broken = createRunLedgerContextReviewGateV1({
          ledger: { readRunLedger: async () => { throw new Error("outage"); }, commitRunLedger: host.ledger.commitRunLedger.bind(host.ledger) },
          runId: "run-1", now,
        });
        await expect(broken.check()).resolves.toMatchObject({ allowed: false });
      } finally {
        await host.close();
      }
    });

    it("keeps the approval state machine and the context operations append-only in the store", async () => {
      const host = await openHost();
      try {
        await seed(host);
        const now = clock();
        const verifier = createKernelApprovalVerifierV1(host.productKernel);
        const opened = await openContextReviewV1({
          ledger: host.ledger, runId: "run-1", attemptId: "attempt-1", turnId: "turn-1", operationEpoch: 1,
          contextOperationId: "context-op-store", subject: { source: "cdr", receiptId: "cdr-store", payloadHash: hash, manifestRef: null },
          expiresAt: new Date(T0 + 3_600_000).toISOString(), now,
        });
        if (!opened.ok) throw new Error(opened.message);
        const id = opened.request.approvalRequestId;
        await resolveContextReviewV1({
          ledger: host.ledger, artifacts: host.artifacts, runId: "run-1", approvalRequestId: id, decision: "approve",
          authority: "user", approvalRef: await kernelApproval(host, "cmd-store-1"), verifier, now,
        });
        const snapshot = await host.ledger.readRunLedger("run-1");
        if (snapshot === null) throw new Error("expected a ledger");
        const base = snapshot.ledger;
        const commit = (name: string, next: RunLedgerV1) =>
          host.ledger.commitRunLedger({
            idempotencyKey: `tamper-${name}`,
            requestHash: runtimeRequestHashV1("run-ledger.tamper", { name }),
            ledger: { ...next, commitId: `tamper-${name}`, revision: base.revision + 1 },
            effects: snapshot.effects,
          });
        const approved = base.approvalRequests?.[0];
        if (approved?.resolution == null) throw new Error("expected a decided approval request");
        const decision = approved.resolution;

        // An approved request cannot be moved back, removed, re-decided or re-pointed.
        await expect(commit("pending", { ...base, approvalRequests: [{ ...approved, state: "pending", resolution: null }] }))
          .rejects.toThrow(/cannot become pending/u);
        await expect(commit("removed", { ...base, approvalRequests: [] })).rejects.toThrow(/cannot be removed/u);
        await expect(
          commit("redecided", {
            ...base,
            approvalRequests: [{ ...approved, resolution: { ...decision, approvalRef: "cmd-forged" } }],
          }),
        ).rejects.toThrow(/decision .* is immutable/u);
        await expect(
          commit("repointed", { ...base, approvalRequests: [{ ...approved, contextOperationId: "other-op" }] }),
        ).rejects.toThrow(/identity is immutable/u);
        // A rejected shape the store would never accept at all: a pending request with a decision.
        await expect(
          commit("inconsistent", {
            ...base,
            approvalRequests: [{ ...approved, state: "pending" }],
          }),
        ).rejects.toThrow();
        const unchanged = await host.ledger.readRunLedger("run-1");
        expect(unchanged?.ledger.revision).toBe(base.revision);
        expect(unchanged?.ledger.approvalRequests).toEqual(base.approvalRequests);
      } finally {
        await host.close();
      }
    });

    it("keeps a decided review across a SQLite reopen", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-review-reopen-"));
      roots.push(root);
      const now = clock();
      const first = await openHost(root);
      let id = "";
      let approvalRef = "";
      try {
        await seed(first);
        const opened = await openContextReviewV1({
          ledger: first.ledger, runId: "run-1", attemptId: "attempt-1", turnId: "turn-1", operationEpoch: 1,
          contextOperationId: "context-op-reopen", subject: { source: "cdr", receiptId: "cdr-reopen", payloadHash: hash, manifestRef: null },
          expiresAt: new Date(T0 + 3_600_000).toISOString(), now,
        });
        if (!opened.ok) throw new Error(opened.message);
        id = opened.request.approvalRequestId;
        approvalRef = await kernelApproval(first, "cmd-reopen-1");
        await resolveContextReviewV1({
          ledger: first.ledger, artifacts: first.artifacts, runId: "run-1", approvalRequestId: id, decision: "approve",
          authority: "user", approvalRef, verifier: createKernelApprovalVerifierV1(first.productKernel), now,
        });
      } finally {
        await first.close();
      }
      const reopened = await openHost(root);
      try {
        const stored = await reopened.ledger.readRunLedger("run-1");
        expect(stored?.ledger.approvalRequests).toEqual([
          expect.objectContaining({
            approvalRequestId: id,
            state: "approved",
            resolution: expect.objectContaining({ approvalRef, authority: "user", followUp: "new_admission" }),
          }),
        ]);
        // The Kernel still vouches for the approval after the restart.
        const verifier: ContextReviewApprovalVerifierV1 = createKernelApprovalVerifierV1(reopened.productKernel);
        await expect(verifier.verify(approvalRef)).resolves.toMatchObject({ ok: true });
        await expect(
          admitReviewedContextOperationV1({
            ledger: reopened.ledger, runId: "run-1", approvalRequestId: id,
            newContextOperationId: "context-op-reopen-2", newOperationEpoch: 2, now,
          }),
        ).resolves.toMatchObject({ ok: true, applied: true });
      } finally {
        await reopened.close();
      }
    });

    describe("the grant snapshot of an approval", () => {
      async function heldReview(host: PactileRuntimeHost, now: () => Date, operation = "context-op-g1") {
        await seed(host);
        const opened = await openContextReviewForReceiptV1({
          ledger: host.ledger,
          runId: "run-1",
          receipt: cdrReview(operation, "effect-1"),
          effect: effect("effect-1"),
          proposal: { prefixMessageCount: 3, prefixHash: hash, basisRevision: 7 },
          expiresAt: new Date(T0 + 3_600_000).toISOString(),
          now,
        });
        if (!opened.ok) throw new Error(opened.message);
        return opened.request.approvalRequestId;
      }

      async function readGrant(host: PactileRuntimeHost, ref: { artifactId: string; version: number; storageRef: string }) {
        const stored = await host.artifacts.read({
          artifactId: ref.artifactId,
          version: ref.version,
          storageRef: ref.storageRef,
          scope: "run",
          scopeKey: "run-1",
        });
        if (!stored.ok) throw new Error(stored.message);
        return JSON.parse(new TextDecoder().decode(stored.content)) as Record<string, unknown>;
      }

      it("is written and bound with the decision, names the exact range and says who decided", async () => {
        const host = await openHost();
        try {
          const now = clock();
          const id = await heldReview(host, now);
          const approvalRef = await kernelApproval(host, "cmd-grant-1");
          const approved = await resolveContextReviewV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            approvalRequestId: id,
            decision: "approve",
            authority: "kernel",
            approvalRef,
            verifier: createKernelApprovalVerifierV1(host.productKernel),
            now,
          });
          if (!approved.ok) throw new Error(approved.message);
          expect(approved.grantBound).toBe(true);
          const grant = approved.request.resolution?.grant;
          expect(grant).toEqual({
            artifactId: `cg-approval-grant-${id}`,
            version: 1,
            contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            storageRef: expect.any(String),
          });
          if (grant === undefined) throw new Error("expected a grant");

          const snapshot = await readGrant(host, grant);
          expect(snapshot).toMatchObject({
            schemaId: "pactile.cg.approval-grant",
            approvalRequestId: id,
            decision: "approved",
            followUp: "new_admission",
            contextOperationId: "context-op-g1",
            subject: {
              source: "cdr",
              proposal: { prefixMessageCount: 3, prefixHash: hash, basisRevision: 7 },
            },
            grantedBy: {
              authority: "kernel",
              approvalRef,
              attestation: { kind: "kernel_command_receipt", kernelFact: true },
            },
          });
          // The mutable part of an approval is not in the immutable snapshot.
          expect(JSON.stringify(snapshot)).not.toContain("consumedBy");

          const stored = await host.ledger.readRunLedger("run-1");
          expect(stored?.ledger.artifactIntents?.map((intent) => intent.state)).toEqual(["bound"]);
          expect(stored?.ledger.contextOperations).toEqual([
            expect.objectContaining({
              contextOperationId: `${id}:approval-grant`,
              kind: "approval_grant",
              status: "succeeded",
              payloadType: "pactile.cg.approval-grant",
              payloadArtifactRef: grant.storageRef,
            }),
          ]);

          // Spending the approval changes the ledger entry, never the snapshot.
          const spent = await admitReviewedContextOperationV1({
            ledger: host.ledger,
            runId: "run-1",
            approvalRequestId: id,
            newContextOperationId: "context-op-g2",
            newOperationEpoch: 2,
            now,
          });
          expect(spent).toMatchObject({ ok: true, request: { resolution: { consumedBy: "context-op-g2", grant } } });
          expect(await readGrant(host, grant)).toEqual(snapshot);
        } finally {
          await host.close();
        }
      });

      it("does not call a terminal confirmation a Kernel fact", async () => {
        const host = await openHost();
        try {
          const now = clock();
          const id = await heldReview(host, now);
          const approved = await resolveContextReviewV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            approvalRequestId: id,
            decision: "approve",
            authority: "user",
            approvalRef: "user-cli-abc",
            verifier: { verify: async () => ({ ok: true, recordedAt: "x" }) },
            now,
          });
          if (!approved.ok || approved.request.resolution?.grant === undefined) throw new Error("expected a grant");
          expect(await readGrant(host, approved.request.resolution.grant)).toMatchObject({
            grantedBy: {
              authority: "user",
              attestation: { kind: "interactive_user_confirmation", kernelFact: false },
            },
          });
        } finally {
          await host.close();
        }
      });

      it("is not written for a rejection", async () => {
        const host = await openHost();
        try {
          const now = clock();
          const id = await heldReview(host, now);
          const rejected = await resolveContextReviewV1({
            ledger: host.ledger,
            artifacts: host.artifacts,
            runId: "run-1",
            approvalRequestId: id,
            decision: "reject",
            authority: "user",
            approvalRef: "user-cli-no",
            verifier: { verify: async () => ({ ok: true, recordedAt: "x" }) },
            now,
          });
          expect(rejected).toMatchObject({ ok: true, request: { state: "rejected" } });
          if (!rejected.ok) throw new Error(rejected.message);
          expect(rejected.grantBound).toBeUndefined();
          expect(rejected.request.resolution?.grant).toBeUndefined();
          const stored = await host.ledger.readRunLedger("run-1");
          expect(stored?.ledger.artifactIntents ?? []).toEqual([]);
        } finally {
          await host.close();
        }
      });

      it("has its plan durable with the decision, so a crash before the bytes is finished by a replay", async () => {
        const host = await openHost();
        try {
          const now = clock();
          const id = await heldReview(host, now);
          const failing = Object.assign(Object.create(host.artifacts) as typeof host.artifacts, {
            prepare: () => Promise.resolve({ ok: false, code: "artifact_store_unavailable", message: "simulated crash" }),
          }) as typeof host.artifacts;
          const input = {
            ledger: host.ledger,
            runId: "run-1",
            approvalRequestId: id,
            decision: "approve" as const,
            authority: "user",
            approvalRef: "user-cli-crash",
            verifier: { verify: async () => ({ ok: true, recordedAt: "x" }) } as ContextReviewApprovalVerifierV1,
            now,
          };
          const crashed = await resolveContextReviewV1({ ...input, artifacts: failing });
          if (!crashed.ok) throw new Error(crashed.message);
          expect(crashed).toMatchObject({ applied: true, grantBound: false, request: { state: "approved" } });
          const grant = crashed.request.resolution?.grant;
          const pending = await host.ledger.readRunLedger("run-1");
          // The decision and the plan are one commit: the approval already names the snapshot.
          expect(pending?.ledger.artifactIntents).toEqual([
            expect.objectContaining({
              state: "pending",
              artifacts: [expect.objectContaining({ binding: expect.objectContaining({ storageRef: grant?.storageRef }) })],
            }),
          ]);
          expect(pending?.ledger.contextOperations ?? []).toEqual([]);

          // The same decision again, with a working store, finishes the snapshot.
          const replay = await resolveContextReviewV1({ ...input, artifacts: host.artifacts });
          expect(replay).toMatchObject({ ok: true, applied: false, grantBound: true });
          const healed = await host.ledger.readRunLedger("run-1");
          expect(healed?.ledger.artifactIntents?.map((intent) => intent.state)).toEqual(["bound"]);
          expect(healed?.ledger.contextOperations?.[0]).toMatchObject({
            kind: "approval_grant",
            payloadArtifactRef: grant?.storageRef,
          });
          expect(replay.ok && replay.request.resolution?.grant).toEqual(grant);
        } finally {
          await host.close();
        }
      });
    });  },
);
