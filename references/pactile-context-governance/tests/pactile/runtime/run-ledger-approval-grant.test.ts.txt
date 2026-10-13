import { describe, expect, it } from "vitest";

import {
  assertRunLedger,
  assertRunLedgerApprovalRequest,
  assertRunLedgerTransition,
  type RunLedgerApprovalRequestV1,
  type RunLedgerV1,
} from "../../../src/pactile/runtime/run-ledger.js";

const HASH = `sha256:${"b".repeat(64)}`;
const GRANT = {
  artifactId: "cg-approval-grant-context-review-1",
  version: 1,
  contentHash: HASH,
  storageRef: `artifact://cg-approval-grant-context-review-1/1/${HASH}`,
};

function request(
  state: "pending" | "approved" | "rejected" | "expired",
  resolution: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    approvalRequestId: "context-review-1",
    kind: "context_operation_review",
    runId: "run-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    operationEpoch: 1,
    contextOperationId: "context-operation-1",
    subject: { source: "cdr", receiptId: "cdr-1", payloadHash: HASH, manifestRef: null },
    state,
    requestedAt: "2026-10-10T00:00:00Z",
    expiresAt: "2026-10-10T01:00:00Z",
    resolution,
  };
}

function decision(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalRef: "user-cli-1",
    authority: "user",
    decidedAt: "2026-10-10T00:10:00Z",
    evidenceRef: null,
    followUp: "new_admission",
    consumedBy: null,
    ...extra,
  };
}

function ledgerWith(approval: RunLedgerApprovalRequestV1): RunLedgerV1 {
  return assertRunLedger({
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
    approvalRequests: [approval],
  });
}

describe("the grant reference on an approval in the RunLedger", () => {
  it("keeps a well-formed grant on an approved request and none on an older one", () => {
    const withGrant = assertRunLedgerApprovalRequest(request("approved", decision({ grant: GRANT })));
    expect(withGrant.resolution?.grant).toEqual(GRANT);
    const older = assertRunLedgerApprovalRequest(request("approved", decision()));
    expect(older.resolution?.grant).toBeUndefined();
  });

  it("refuses a grant on anything that was not approved, and a malformed one", () => {
    expect(() =>
      assertRunLedgerApprovalRequest(
        request("rejected", decision({ followUp: "block", grant: GRANT })),
      ),
    ).toThrow(/only an approved request has a grant/u);
    for (const bad of [
      "grant-1",
      { ...GRANT, contentHash: "not-a-hash" },
      { ...GRANT, version: 0 },
      { ...GRANT, storageRef: "" },
      null,
    ]) {
      expect(() =>
        assertRunLedgerApprovalRequest(request("approved", decision({ grant: bad }))),
      ).toThrow(/grant/u);
    }
  });

  it("lets spending change only consumedBy, never the grant", () => {
    const approved = assertRunLedgerApprovalRequest(request("approved", decision({ grant: GRANT })));
    const spent = assertRunLedgerApprovalRequest(
      request("approved", decision({ grant: GRANT, consumedBy: "context-operation-2" })),
    );
    expect(() => assertRunLedgerTransition(ledgerWith(approved), ledgerWith(spent))).not.toThrow();

    const swapped = assertRunLedgerApprovalRequest(
      request(
        "approved",
        decision({ grant: { ...GRANT, contentHash: `sha256:${"c".repeat(64)}` }, consumedBy: "context-operation-2" }),
      ),
    );
    expect(() => assertRunLedgerTransition(ledgerWith(approved), ledgerWith(swapped))).toThrow(/immutable/u);
    const dropped = assertRunLedgerApprovalRequest(
      request("approved", decision({ consumedBy: "context-operation-2" })),
    );
    expect(() => assertRunLedgerTransition(ledgerWith(approved), ledgerWith(dropped))).toThrow(/immutable/u);
  });
});
