import { describe, expect, it } from "vitest";

import {
  bindContextGovernanceReceiptV1,
  type ContextGovernanceReceiptKindV1,
} from "../../../src/pactile/runtime/context-governance-receipts.js";
import type { EffectLedgerEntryV1 } from "../../../src/pactile/runtime/run-ledger.js";
import type { RuntimeStoreJsonObject } from "../../../src/pactile/runtime/store-port.js";

const hash = `sha256:${"a".repeat(64)}`;

function effect(): EffectLedgerEntryV1 {
  return {
    schemaVersion: 1,
    operationId: "operation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    operationEpoch: 1,
    inputHash: hash,
    status: "success",
    receiptId: "receipt-1",
    idempotencyKey: "effect-1",
    createdAt: "2026-10-10T00:00:00Z",
    completedAt: "2026-10-10T00:00:01Z",
  };
}

function envelope(
  kind: ContextGovernanceReceiptKindV1,
): Record<string, unknown> {
  return {
    schemaId:
      kind === "cdr"
        ? "pactile.cg.compression-decision-receipt"
        : "pactile.cg.compaction-audit-receipt",
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
  };
}

function cdr(): RuntimeStoreJsonObject {
  return {
    ...envelope("cdr"),
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
    effect: { operationId: "operation-1", ledgerReceiptId: "receipt-1" },
  } as unknown as RuntimeStoreJsonObject;
}

function car(): RuntimeStoreJsonObject {
  return {
    ...envelope("car"),
    auditId: "car-1",
    decisionRef: {
      schemaId: "pactile.cg.compression-decision-receipt",
      schemaVersion: 1,
    },
    compaction: { piCompactionId: "pi-compaction-1", commitReceiptRef: null },
    snapshots: { beforeHash: hash, afterHash: hash },
    checks: [
      "source_cursor",
      "exact_anchor",
      "protected_content",
      "tool_call_pairing",
      "permission",
      "source_hash",
      "source_revision",
      "generation",
      "worktree_fence",
      "semantic_drift",
      "jev_preservation",
      "pointer_reachability",
      "manifest_current_pointer",
      "memory_read_probe",
      "epoch_fence",
      "supersedes_relation",
      "rollback_reference",
    ].map((id) => ({
      id,
      result: { status: "ok", value: "pass" },
      detailHash: null,
    })),
    verdict: "accepted",
    regressionCaseRef: null,
  } as unknown as RuntimeStoreJsonObject;
}

function memoryRead(status: string): RuntimeStoreJsonObject {
  return {
    ...envelope("cdr"),
    schemaId: "pactile.cg.memory-read-record",
    contextOperationId: "context-memory-read-1",
    readRecordId: "read-record-1",
    requestHash: hash,
    responseHash: hash,
    manifestRef: status === "ok" ? "memory://manifest-1" : null,
    manifestRevision: status === "ok" ? 1 : null,
    contentHash: status === "ok" ? hash : null,
    scope: "run",
    scopeKey: "run-1",
    basisRevision: 1,
    disclosureRecordId: status === "ok" ? "disclosure-1" : null,
    status,
    factIds: [],
    exactFactCount: 0,
    summaryCount: 0,
    checks: [{ id: "memory_read", result: status === "ok" ? "ok" : "fail" }],
  } as unknown as RuntimeStoreJsonObject;
}

function memoryCommit(status: string): RuntimeStoreJsonObject {
  const ok = status === "ok";
  return {
    ...envelope("cdr"),
    schemaId: "pactile.cg.memory-commit-record",
    contextOperationId: "context-memory-commit-1:memory-commit",
    commitRecordId: "context-memory-commit-1:memory-commit",
    requestId: "memory-request-1",
    requestHash: hash,
    responseHash: hash,
    scope: "run",
    scopeKey: "run-1",
    basisRevision: 1,
    artifactId: "memory-artifact-1",
    artifactVersion: 1,
    artifactRef: ok ? "artifact://memory-artifact-1" : null,
    contentHash: ok ? hash : null,
    memoryReceiptId: ok ? "receipt-1" : null,
    memoryReceiptHash: ok ? hash : null,
    manifestId: ok ? "manifest-1" : null,
    manifestRevision: ok ? 1 : null,
    manifestHash: ok ? hash : null,
    status,
    progress: { artifact: true, receipt: ok, manifest: ok },
    checks: [{ id: "memory_commit", result: ok ? "ok" : "fail" }],
  } as unknown as RuntimeStoreJsonObject;
}

describe("Context Governance CDR/CAR binding", () => {
  it("validates memory commit records and refuses unverified claims", () => {
    expect(
      bindContextGovernanceReceiptV1({ receipt: memoryCommit("ok") }),
    ).toMatchObject({
      kind: "memoryCommit",
      operationId: "context-memory-commit-1:memory-commit",
    });
    for (const status of [
      "missing",
      "permission_denied",
      "stale",
      "revision_mismatch",
      "epoch_mismatch",
      "manifest_conflict",
    ]) {
      expect(
        bindContextGovernanceReceiptV1({ receipt: memoryCommit(status) }),
      ).toMatchObject({ kind: "memoryCommit" });
    }
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: {
          ...memoryCommit("revision_mismatch"),
          manifestHash: hash,
        } as unknown as RuntimeStoreJsonObject,
      }),
    ).toThrow("must not claim a verified artifact");
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: {
          ...memoryCommit("ok"),
          progress: { artifact: true, receipt: true, manifest: false },
        } as unknown as RuntimeStoreJsonObject,
      }),
    ).toThrow("all durable");
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: {
          ...memoryCommit("ok"),
          status: "unknown",
        } as unknown as RuntimeStoreJsonObject,
      }),
    ).toThrow("status is invalid");
  });

  it("binds runtime CDR operationId to the ledger effect", () => {
    const bound = bindContextGovernanceReceiptV1({
      receipt: cdr(),
      effect: effect(),
    });
    expect(bound).toMatchObject({
      kind: "cdr",
      receiptId: "cdr-1",
      contextOperationId: "context-operation-1",
      operationId: "operation-1",
    });
  });

  it("accepts a well-formed grantRef only on an admitted decision", () => {
    const grantRef = {
      artifactId: "cg-approval-grant-context-review-1",
      version: 1,
      contentHash: hash,
      storageRef: "artifact://cg-approval-grant-context-review-1/1/" + hash,
    };
    const withGrant = (verdict: string, ref: unknown): RuntimeStoreJsonObject =>
      ({
        ...cdr(),
        verdict,
        authorization: { class: "reversible", grantRef: ref },
      }) as unknown as RuntimeStoreJsonObject;
    const effectForCdr = effect();
    expect(
      bindContextGovernanceReceiptV1({ receipt: withGrant("admitted", grantRef), effect: effectForCdr }),
    ).toMatchObject({ kind: "cdr" });
    // A reference that is not an artifact reference is refused.
    for (const bad of [
      "approval-1",
      { ...grantRef, contentHash: "not-a-hash" },
      { ...grantRef, version: 0 },
      { artifactId: "x" },
    ]) {
      expect(() =>
        bindContextGovernanceReceiptV1({ receipt: withGrant("admitted", bad), effect: effectForCdr }),
      ).toThrow(/grantRef/u);
    }
    // A decision that held or blocked the proposal rests on no grant.
    for (const verdict of ["review_required", "blocked"]) {
      expect(() =>
        bindContextGovernanceReceiptV1({ receipt: withGrant(verdict, grantRef), effect: effectForCdr }),
      ).toThrow(/only an admitted or overridden decision/u);
    }
  });
  it("validates a runtime CAR with all 17 audit checks", () => {
    const bound = bindContextGovernanceReceiptV1({
      receipt: car(),
      effect: effect(),
    });
    expect(bound).toMatchObject({
      kind: "car",
      receiptId: "car-1",
      operationId: "operation-1",
    });
  });

  it("rejects evaluation identity and mismatched CDR operationId", () => {
    const evaluationReceipt = {
      ...cdr(),
      evaluationRunId: "eval-1",
    } as unknown as RuntimeStoreJsonObject;
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: evaluationReceipt,
        effect: effect(),
      }),
    ).toThrow("evaluationRunId");
    const mismatched = {
      ...cdr(),
      effect: { operationId: "operation-other", ledgerReceiptId: null },
    } as unknown as RuntimeStoreJsonObject;
    expect(() =>
      bindContextGovernanceReceiptV1({ receipt: mismatched, effect: effect() }),
    ).toThrow("operationId does not match");
    const withLease = {
      ...cdr(),
      lease: { leaseId: "lease-1", epoch: 1, revision: 1 },
    } as unknown as RuntimeStoreJsonObject;
    expect(() =>
      bindContextGovernanceReceiptV1({ receipt: withLease, effect: effect() }),
    ).toThrow("cannot carry lease");
    const duplicateCheck = {
      ...car(),
      checks: [
        ...((car().checks as unknown[]) ?? []).slice(0, 16),
        {
          id: "source_cursor",
          result: { status: "ok", value: "pass" },
          detailHash: null,
        },
      ],
    } as unknown as RuntimeStoreJsonObject;
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: duplicateCheck,
        effect: effect(),
      }),
    ).toThrow("duplicated");
  });

  it("accepts failed memory.read records without unverified manifest claims", () => {
    for (const status of [
      "missing",
      "permission_denied",
      "stale",
      "revision_mismatch",
      "epoch_mismatch",
      "manifest_conflict",
    ]) {
      const bound = bindContextGovernanceReceiptV1({
        receipt: memoryRead(status),
      });
      expect(bound).toMatchObject({
        kind: "memoryRead",
        operationId: "context-memory-read-1",
      });
    }
    expect(() =>
      bindContextGovernanceReceiptV1({
        receipt: {
          ...memoryRead("missing"),
          manifestRef: "memory://unverified",
        } as unknown as RuntimeStoreJsonObject,
      }),
    ).toThrow("must not claim a verified manifest");
  });
});
