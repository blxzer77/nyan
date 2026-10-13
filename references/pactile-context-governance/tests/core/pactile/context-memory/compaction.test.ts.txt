import { describe, expect, it } from "vitest";

import {
  applyToolResultMasksV1,
  buildCompactionIntentV1,
  buildContextDeltaV1,
  buildContextSnapshotRefV1,
  contextSnapshotHashV1,
  decideCompactionV1,
  findMaskableToolResultsV1,
  findValidCutPoints,
  validateContextCutPointV1,
} from "../../../../src/core/pactile/context-memory/compaction.js";

const hash = (letter: string): string => `sha256:${letter.repeat(64)}`;

const system = { role: "system", content: "system" };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const toolTranscript = [
  system,
  user("request"),
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    details: { lowValue: "large payload" },
    content: [{ type: "text", text: "result" }],
  },
  user("follow up"),
] as const;

describe("Context compaction cut-point contract", () => {
  it("only selects closed assistant turns and never cuts by string length", () => {
    const messages = [system, user("a"), assistant("done"), user("b")];
    const points = findValidCutPoints(messages, { minimumRetainedMessages: 1 });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      prefixMessageCount: 3,
      retainedMessageCount: 1,
      basisRevision: 3,
      boundaryRole: "assistant",
    });
    const point = points[0];
    expect(point).toBeDefined();
    if (point === undefined) throw new Error("expected a cut-point");
    expect(validateContextCutPointV1(messages, point)).toBe(true);
    expect(
      validateContextCutPointV1([...messages.slice(0, 2), assistant("changed"), user("b")], point),
    ).toBe(false);
  });

  it("requires tool-call and tool-result pairing before a cut-point", () => {
    const points = findValidCutPoints(toolTranscript, { minimumRetainedMessages: 1 });
    expect(points.map((point) => point.prefixMessageCount)).toEqual([4]);
    expect(points[0]?.boundaryRole).toBe("toolResult");
  });

  it("fails closed for an unresolved or malformed transcript", () => {
    expect(
      findValidCutPoints([
        system,
        user("request"),
        { role: "assistant", content: [{ type: "toolCall", id: "open", name: "read", arguments: {} }] },
        user("invalid interleave"),
      ]),
    ).toEqual([]);
    expect(findValidCutPoints([{ role: "assistant" }, { content: "missing role" }])).toEqual([]);
  });

  it("builds a snapshot reference that binds memory and checkpoint evidence", () => {
    const messages = [system, user("summary"), user("new turn")];
    const snapshot = buildContextSnapshotRefV1({
      messages,
      snapshotRevision: 4,
      oldSnapshotHash: contextSnapshotHashV1([system, user("old")]),
      compactionReceiptHash: hash("a"),
      artifactId: "context-artifact-1",
      artifactVersion: 1,
      artifactHash: hash("b"),
      manifestId: "memory-manifest-1",
      manifestRevision: 2,
      manifestHash: hash("c"),
      contextBasisHash: hash("d"),
      sourceCursor: "session-1:4",
      checkpointId: "checkpoint-1",
    });
    expect(snapshot.contentHash).toBe(contextSnapshotHashV1(messages));
    expect(snapshot.source).toBe("compaction");
    expect(snapshot.checkpointId).toBe("checkpoint-1");
    expect(snapshot.contextBasisHash).toBe(hash("d"));
    expect(snapshot.sourceCursor).toBe("session-1:4");
    expect(snapshot).not.toHaveProperty("messages");
  });

  it("keeps protected tool arcs while exposing only payload-mask candidates", () => {
    const candidates = findMaskableToolResultsV1(toolTranscript, {
      allowToolResultMasking: true,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toolCallId).toBe("call-1");
    expect(candidates[0]?.placeholder).toContain("read");
    const protectedCandidates = findMaskableToolResultsV1(toolTranscript, {
      allowToolResultMasking: true,
      protectedToolNames: ["read"],
    });
    expect(protectedCandidates).toEqual([]);
    const protectedEffect = findMaskableToolResultsV1(toolTranscript, {
      allowToolResultMasking: true,
      protectedMessageReasons: { 3: "effect" },
    });
    expect(protectedEffect).toEqual([]);
    const masked = applyToolResultMasksV1(toolTranscript, candidates);
    expect(masked).toHaveLength(toolTranscript.length);
    expect(masked[3]).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "read" });
    expect(masked[3]).not.toHaveProperty("details");
    expect(masked[3]).toMatchObject({ content: [{ type: "text", text: "[cleared] output of: read (toolCallId call-1)" }] });
    expect(() => applyToolResultMasksV1([
      ...toolTranscript.slice(0, 3),
      { ...toolTranscript[3], details: { changed: true } },
      toolTranscript[4],
    ], candidates)).toThrow("stale");
  });

  it("does not freeze provider parameters and blocks compaction without durable preflight", () => {
    const messages = [system, user("request"), assistant("done"), user("next")];
    const point = findValidCutPoints(messages, { minimumRetainedMessages: 1 })[0] ?? null;
    const blocked = decideCompactionV1({
      contextTokens: 100,
      effectiveWindow: 100,
      reserveTokens: 10,
      maskCandidates: [],
      cutPoint: point,
      durablePreflight: "missing",
    });
    expect(blocked.action).toBe("blocked");
    expect(blocked.assurance).toBe("assurance_unknown");
    const delta = buildContextDeltaV1({
      operation: "compact",
      baseSnapshotHash: hash("a"),
      resultMessages: [system, user("summary")],
      sourceCursorStart: "session-1:0",
      sourceCursorEnd: "session-1:4",
      basisRevision: 3,
      cutPoint: point,
    });
    expect(delta.deltaId).toMatch(/^context_delta_v1_/u);
    expect(delta.maskedToolCallIds).toEqual([]);
    const intent = buildCompactionIntentV1({
      compactionId: "compaction-1",
      contextOperationId: "context-op-1",
      runId: "run-1",
      sourceCursor: "session-1:4",
      basisSourceRevision: 3,
      committedSourceRevision: 3,
      contextBasisHash: hash("a"),
      durableMemoryReceiptId: "receipt-1",
      operationEpoch: 1,
      leaseEpoch: 1,
      fencingToken: "fence-1",
      commandId: "command-1",
      disclosurePayloadHash: hash("b"),
      promptAssemblyHash: hash("c"),
      piSessionRef: "session://session-1",
    });
    expect(intent.schemaVersion).toBe(1);
    expect(intent.fencingToken).toBe("fence-1");
  });
});
