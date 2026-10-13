/**
 * Host-neutral Context compaction contracts.
 *
 * This module validates transcript boundaries and fingerprints only. It never
 * truncates a transcript, writes memory, calls a Provider, or mutates a Pi
 * Agent. The Agent Context Pipeline owns orchestration over these contracts.
 */

import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../shared/validation.js";

export const CONTEXT_COMPACTION_SCHEMA_VERSION = 1 as const;
export type ContextCompactionSchemaVersion =
  typeof CONTEXT_COMPACTION_SCHEMA_VERSION;

export type ContextBoundaryRoleV1 = "assistant" | "toolResult";

export interface ContextCutPointV1 {
  readonly schemaVersion: ContextCompactionSchemaVersion;
  /** Number of messages retained in the validated prefix. */
  readonly prefixMessageCount: number;
  /** Number of messages after the cut-point. */
  readonly retainedMessageCount: number;
  /** Verified transcript sequence revision represented by this prefix. */
  readonly basisRevision: number;
  /** Fingerprint of the exact prefix, never the prefix content itself. */
  readonly prefixHash: string;
  /** Fingerprint of the complete transcript inspected by validation. */
  readonly transcriptHash: string;
  readonly boundaryRole: ContextBoundaryRoleV1;
}

export interface FindValidCutPointsOptionsV1 {
  /** At least this many messages must remain after the cut-point. */
  readonly minimumRetainedMessages?: number;
}

export type ContextSnapshotV1 = ContextSnapshotRefV1;

export interface ContextSnapshotRefV1 {
  readonly schemaVersion: ContextCompactionSchemaVersion;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly messageCount: number;
  readonly contentHash: string;
  readonly contextBasisHash: string;
  readonly sourceCursor: string;
  readonly source: "compaction";
  readonly oldSnapshotHash: string;
  readonly compactionReceiptHash: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly artifactHash: string;
  readonly manifestId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
  readonly checkpointId: string;
}

export interface ContextDeltaV1 {
  readonly schemaVersion: ContextCompactionSchemaVersion;
  readonly deltaId: string;
  readonly operation: "mask" | "compact";
  readonly baseSnapshotHash: string;
  readonly resultSnapshotHash: string;
  readonly sourceCursorStart: string;
  readonly sourceCursorEnd: string;
  readonly basisRevision: number;
  readonly cutPoint: ContextCutPointV1 | null;
  readonly maskedToolCallIds: readonly string[];
  readonly removedRangeHash: string | null;
}

export interface ProtectedRegionPolicyV1 {
  readonly protectedMessageIndices?: readonly number[];
  readonly protectedMessageReasons?: Readonly<Record<number, "approval" | "evidence" | "effect" | "explicit_index">>;
  readonly protectedToolCallIds?: readonly string[];
  readonly protectedToolNames?: readonly string[];
  readonly allowToolResultMasking: boolean;
}

export interface ProtectedRegionV1 {
  readonly messageIndex: number;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly reason:
    | "system"
    | "user"
    | "assistant"
    | "tool_call"
    | "protected_tool"
    | "unpaired_tool_result"
    | "approval"
    | "evidence"
    | "effect"
    | "explicit_index";
}

export interface ToolResultMaskCandidateV1 {
  readonly messageIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly payloadHash: string;
  readonly placeholder: string;
}

export function applyToolResultMasksV1(
  messages: readonly unknown[],
  candidates: readonly ToolResultMaskCandidateV1[],
): readonly unknown[] {
  const byIndex = new Map<number, ToolResultMaskCandidateV1>();
  const currentToolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of toolCallDetails(message)) currentToolNames.set(call.id, call.name);
  }
  for (const candidate of candidates) {
    if (byIndex.has(candidate.messageIndex)) throw new TypeError("duplicate tool-result mask candidate");
    if (!Number.isSafeInteger(candidate.messageIndex) || candidate.messageIndex < 0 || candidate.messageIndex >= messages.length) {
      throw new TypeError("tool-result mask candidate index is outside the context");
    }
    byIndex.set(candidate.messageIndex, candidate);
  }
  const masked = messages.map((message, messageIndex) => {
    const candidate = byIndex.get(messageIndex);
    if (candidate === undefined) return message;
    if (roleOf(message) !== "toolResult" || toolResultId(message) !== candidate.toolCallId || currentToolNames.get(candidate.toolCallId) !== candidate.toolName || !isRecord(message)) {
      throw new TypeError("tool-result mask candidate does not match the protected tool arc");
    }
    if (toolResultPayloadHash(message) !== candidate.payloadHash) {
      throw new TypeError("tool-result mask candidate is stale for the current payload");
    }
    const metadata = { ...message };
    delete metadata.details;
    delete metadata.content;
    return {
      ...metadata,
      content: [{ type: "text", text: candidate.placeholder }],
    };
  });
  return Object.freeze(masked);
}

export type CompactionDecisionActionV1 = "continue" | "mask" | "compact" | "blocked";

export interface CompactionDecisionV1 {
  readonly schemaVersion: ContextCompactionSchemaVersion;
  readonly action: CompactionDecisionActionV1;
  readonly assurance: "assurance_exact" | "assurance_unknown";
  readonly reason:
    | "below_threshold"
    | "mask_first"
    | "durable_preflight_missing"
    | "durable_preflight_verified"
    | "cut_point_missing"
    | "protected_region"
    | "provider_error"
    | "stale"
    | "conflict";
  readonly contextTokens: number;
  readonly effectiveWindow: number;
  readonly reserveTokens: number;
  readonly cutPoint: ContextCutPointV1 | null;
  readonly maskCandidates: readonly ToolResultMaskCandidateV1[];
}

export interface CompactionIntentV1 {
  readonly schemaVersion: ContextCompactionSchemaVersion;
  readonly compactionId: string;
  readonly contextOperationId: string;
  readonly runId: string;
  readonly sourceCursor: string;
  readonly basisSourceRevision: number;
  readonly committedSourceRevision: number | null;
  readonly contextBasisHash: string;
  readonly durableMemoryReceiptId: string;
  readonly operationEpoch: number;
  readonly leaseEpoch: number;
  readonly fencingToken: string;
  readonly commandId: string;
  readonly disclosurePayloadHash: string;
  readonly promptAssemblyHash: string;
  readonly piSessionRef: string;
}

export function buildCompactionIntentV1(
  input: Omit<CompactionIntentV1, "schemaVersion">,
): CompactionIntentV1 {
  for (const [label, value] of [
    ["compactionId", input.compactionId],
    ["contextOperationId", input.contextOperationId],
    ["runId", input.runId],
    ["sourceCursor", input.sourceCursor],
    ["contextBasisHash", input.contextBasisHash],
    ["durableMemoryReceiptId", input.durableMemoryReceiptId],
    ["fencingToken", input.fencingToken],
    ["commandId", input.commandId],
    ["disclosurePayloadHash", input.disclosurePayloadHash],
    ["promptAssemblyHash", input.promptAssemblyHash],
    ["piSessionRef", input.piSessionRef],
  ] as const) {
    if (!nonEmpty(value)) throw new TypeError(`${label} must be non-empty`);
  }
  if (!Number.isSafeInteger(input.basisSourceRevision) || input.basisSourceRevision < 0) {
    throw new TypeError("basisSourceRevision must be non-negative");
  }
  if (input.committedSourceRevision !== null && (!Number.isSafeInteger(input.committedSourceRevision) || input.committedSourceRevision < 0)) {
    throw new TypeError("committedSourceRevision must be null or non-negative");
  }
  if (!Number.isSafeInteger(input.operationEpoch) || input.operationEpoch < 1) throw new TypeError("operationEpoch must be positive");
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) throw new TypeError("leaseEpoch must be positive");
  return Object.freeze({ schemaVersion: CONTEXT_COMPACTION_SCHEMA_VERSION, ...input });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleOf(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  return message.role;
}

function toolCallIds(message: unknown):
  | { readonly valid: true; readonly ids: readonly string[] }
  | { readonly valid: false } {
  if (roleOf(message) !== "assistant") return { valid: true, ids: [] };
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return { valid: true, ids: [] };
  }
  const ids: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.id !== "string" || block.id.trim().length === 0) {
      return { valid: false };
    }
    if (ids.includes(block.id)) return { valid: false };
    ids.push(block.id);
  }
  return { valid: true, ids };
}

function toolResultId(message: unknown): string | null {
  if (roleOf(message) !== "toolResult" || !isRecord(message)) return null;
  return typeof message.toolCallId === "string" && message.toolCallId.trim().length > 0
    ? message.toolCallId
    : null;
}

function toolCallDetails(message: unknown): readonly { readonly id: string; readonly name: string }[] {
  if (roleOf(message) !== "assistant" || !isRecord(message) || !Array.isArray(message.content)) return [];
  const details: { id: string; name: string }[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string") continue;
    details.push({ id: block.id, name: block.name });
  }
  return details;
}

function toolResultPayloadHash(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const payload = {
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.details === undefined ? {} : { details: message.details }),
  };
  try {
    return fingerprintPactileContractV1({ domain: "tool-result-payload-v1", payload });
  } catch {
    return null;
  }
}

function transcriptPrefixIsClosed(
  messages: readonly unknown[],
  prefixMessageCount: number,
): boolean {
  const pendingToolCalls = new Set<string>();
  for (let index = 0; index < prefixMessageCount; index += 1) {
    const message = messages[index];
    const role = roleOf(message);
    if (role === null) return false;
    const calls = toolCallIds(message);
    if (!calls.valid) return false;
    for (const id of calls.ids) {
      if (pendingToolCalls.has(id)) return false;
      pendingToolCalls.add(id);
    }
    if (role === "toolResult") {
      const id = toolResultId(message);
      if (id === null || !pendingToolCalls.has(id)) return false;
      pendingToolCalls.delete(id);
    } else if (role === "user" && pendingToolCalls.size > 0) {
      return false;
    }
  }
  return pendingToolCalls.size === 0;
}

function transcriptIsValid(messages: readonly unknown[]): boolean {
  if (messages.length === 0) return false;
  for (const message of messages) {
    if (roleOf(message) === null) return false;
  }
  return transcriptPrefixIsClosed(messages, messages.length);
}

export function deriveProtectedRegionsV1(
  messages: readonly unknown[],
  policy: ProtectedRegionPolicyV1,
): readonly ProtectedRegionV1[] {
  const explicitIndices = new Set(policy.protectedMessageIndices ?? []);
  const explicitReasons = new Map(
    Object.entries(policy.protectedMessageReasons ?? {}).map(([index, reason]) => [Number(index), reason] as const),
  );
  const protectedCallIds = new Set(policy.protectedToolCallIds ?? []);
  const protectedToolNames = new Set(policy.protectedToolNames ?? []);
  const regions: ProtectedRegionV1[] = [];
  const calls = new Map<string, string>();
  for (const [messageIndex, message] of messages.entries()) {
    const role = roleOf(message);
    if (explicitIndices.has(messageIndex) || explicitReasons.has(messageIndex)) {
      regions.push({
        messageIndex,
        toolCallId: null,
        toolName: null,
        reason: explicitReasons.get(messageIndex) ?? "explicit_index",
      });
    }
    if (role === "system") regions.push({ messageIndex, toolCallId: null, toolName: null, reason: "system" });
    if (role === "user") regions.push({ messageIndex, toolCallId: null, toolName: null, reason: "user" });
    for (const call of toolCallDetails(message)) {
      calls.set(call.id, call.name);
      regions.push({ messageIndex, toolCallId: call.id, toolName: call.name, reason: "tool_call" });
    }
    if (role === "assistant" && toolCallDetails(message).length === 0) {
      regions.push({ messageIndex, toolCallId: null, toolName: null, reason: "assistant" });
    }
    if (role === "toolResult") {
      const id = toolResultId(message);
      const toolName = id === null ? null : calls.get(id) ?? null;
      if (id === null || toolName === null) {
        regions.push({ messageIndex, toolCallId: id, toolName, reason: "unpaired_tool_result" });
      } else if (protectedCallIds.has(id) || protectedToolNames.has(toolName) || explicitIndices.has(messageIndex) || explicitReasons.has(messageIndex) || !policy.allowToolResultMasking) {
        regions.push({
          messageIndex,
          toolCallId: id,
          toolName,
          reason: explicitReasons.get(messageIndex) ?? "protected_tool",
        });
      }
    }
  }
  return Object.freeze(regions);
}

export function findMaskableToolResultsV1(
  messages: readonly unknown[],
  policy: ProtectedRegionPolicyV1,
): readonly ToolResultMaskCandidateV1[] {
  if (!policy.allowToolResultMasking) return Object.freeze([]);
  const protectedRegions = deriveProtectedRegionsV1(messages, policy);
  const protectedKeys = new Set(
    protectedRegions
      .filter((region) => region.reason === "protected_tool" || region.reason === "explicit_index" || region.reason === "approval" || region.reason === "evidence" || region.reason === "effect" || region.reason === "unpaired_tool_result")
      .map((region) => `${String(region.messageIndex)}:${region.toolCallId ?? ""}`),
  );
  const calls = new Map<string, string>();
  const candidates: ToolResultMaskCandidateV1[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const call of toolCallDetails(message)) calls.set(call.id, call.name);
    if (roleOf(message) !== "toolResult") continue;
    const toolCallId = toolResultId(message);
    if (toolCallId === null) continue;
    const toolName = calls.get(toolCallId);
    if (toolName === undefined || protectedKeys.has(`${String(messageIndex)}:${toolCallId}`)) continue;
    const payloadHash = toolResultPayloadHash(message);
    if (payloadHash === null) continue;
    candidates.push({
      messageIndex,
      toolCallId,
      toolName,
      payloadHash,
      placeholder: `[cleared] output of: ${toolName} (toolCallId ${toolCallId})`,
    });
  }
  return Object.freeze(candidates);
}

export function decideCompactionV1(input: {
  readonly contextTokens: number;
  readonly effectiveWindow: number;
  readonly reserveTokens: number;
  readonly maskCandidates: readonly ToolResultMaskCandidateV1[];
  readonly cutPoint: ContextCutPointV1 | null;
  readonly durablePreflight: "verified" | "missing" | "unknown";
  readonly providerError?: boolean;
}): CompactionDecisionV1 {
  if (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 0) throw new TypeError("contextTokens must be non-negative");
  if (!Number.isSafeInteger(input.effectiveWindow) || input.effectiveWindow <= 0) throw new TypeError("effectiveWindow must be positive");
  if (!Number.isSafeInteger(input.reserveTokens) || input.reserveTokens < 0 || input.reserveTokens >= input.effectiveWindow) throw new TypeError("reserveTokens must be less than effectiveWindow");
  const common = {
    schemaVersion: CONTEXT_COMPACTION_SCHEMA_VERSION,
    contextTokens: input.contextTokens,
    effectiveWindow: input.effectiveWindow,
    reserveTokens: input.reserveTokens,
    cutPoint: input.cutPoint,
    maskCandidates: input.maskCandidates,
  } as const;
  if (input.providerError === true) return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason: "provider_error" });
  if (input.contextTokens < input.effectiveWindow - input.reserveTokens) return Object.freeze({ ...common, action: "continue", assurance: "assurance_exact", reason: "below_threshold" });
  if (input.maskCandidates.length > 0) return Object.freeze({ ...common, action: "mask", assurance: "assurance_exact", reason: "mask_first" });
  if (input.durablePreflight !== "verified") return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason: input.durablePreflight === "missing" ? "durable_preflight_missing" : "stale" });
  if (input.cutPoint === null) return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason: "cut_point_missing" });
  return Object.freeze({ ...common, action: "compact", assurance: "assurance_exact", reason: "durable_preflight_verified" });
}

function messagePrefixHash(messages: readonly unknown[], count: number): string {
  return fingerprintPactileContractV1({
    domain: "context-cut-point-prefix-v1",
    prefixMessageCount: count,
    messages: messages.slice(0, count),
  });
}

/** Fingerprint a complete in-memory snapshot without persisting its messages. */
export function contextSnapshotHashV1(messages: readonly unknown[]): string {
  return fingerprintPactileContractV1({
    domain: "context-snapshot-v1",
    messages,
  });
}

/**
 * Find only closed turn boundaries. No string length or token count is used to
 * cut a transcript, and an unresolved tool call can never be a cut-point.
 */
export function findValidCutPoints(
  messages: readonly unknown[],
  options: FindValidCutPointsOptionsV1 = {},
): readonly ContextCutPointV1[] {
  const minimumRetainedMessages = options.minimumRetainedMessages ?? 1;
  if (
    !Number.isSafeInteger(minimumRetainedMessages) ||
    minimumRetainedMessages < 1 ||
    !transcriptIsValid(messages)
  ) {
    return Object.freeze([]);
  }
  const transcriptHash = contextSnapshotHashV1(messages);
  const points: ContextCutPointV1[] = [];
  const lastPrefix = messages.length - minimumRetainedMessages;
  for (let prefixMessageCount = 1; prefixMessageCount <= lastPrefix; prefixMessageCount += 1) {
    const boundary = messages[prefixMessageCount - 1];
    const boundaryRole = roleOf(boundary);
    if (boundaryRole !== "assistant" && boundaryRole !== "toolResult") continue;
    const calls = toolCallIds(boundary);
    if (!calls.valid || (boundaryRole === "assistant" && calls.ids.length > 0)) continue;
    if (!transcriptPrefixIsClosed(messages, prefixMessageCount)) continue;
    points.push(
      Object.freeze({
        schemaVersion: CONTEXT_COMPACTION_SCHEMA_VERSION,
        prefixMessageCount,
        retainedMessageCount: messages.length - prefixMessageCount,
        basisRevision: prefixMessageCount,
        prefixHash: messagePrefixHash(messages, prefixMessageCount),
        transcriptHash,
        boundaryRole,
      }),
    );
  }
  return Object.freeze(points);
}

/** Re-validate a previously selected cut-point against the current snapshot. */
export function validateContextCutPointV1(
  messages: readonly unknown[],
  cutPoint: ContextCutPointV1,
): boolean {
  if (
    cutPoint.schemaVersion !== CONTEXT_COMPACTION_SCHEMA_VERSION ||
    !Number.isSafeInteger(cutPoint.prefixMessageCount) ||
    !Number.isSafeInteger(cutPoint.retainedMessageCount) ||
    cutPoint.prefixMessageCount < 1 ||
    cutPoint.retainedMessageCount < 1 ||
    cutPoint.prefixMessageCount + cutPoint.retainedMessageCount !== messages.length
  ) {
    return false;
  }
  const candidates = findValidCutPoints(messages, {
    minimumRetainedMessages: cutPoint.retainedMessageCount,
  });
  return candidates.some(
    (candidate) =>
      candidate.prefixMessageCount === cutPoint.prefixMessageCount &&
      candidate.basisRevision === cutPoint.basisRevision &&
      candidate.prefixHash === cutPoint.prefixHash &&
      candidate.transcriptHash === cutPoint.transcriptHash &&
      candidate.boundaryRole === cutPoint.boundaryRole,
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function buildContextDeltaV1(input: {
  readonly operation: "mask" | "compact";
  readonly baseSnapshotHash: string;
  readonly resultMessages: readonly unknown[];
  readonly sourceCursorStart: string;
  readonly sourceCursorEnd: string;
  readonly basisRevision: number;
  readonly cutPoint: ContextCutPointV1 | null;
  readonly maskedToolCallIds?: readonly string[];
  readonly removedRangeHash?: string | null;
}): ContextDeltaV1 {
  if (!nonEmpty(input.sourceCursorStart) || !nonEmpty(input.sourceCursorEnd)) {
    throw new TypeError("ContextDelta source cursors must be non-empty");
  }
  if (!Number.isSafeInteger(input.basisRevision) || input.basisRevision < 0) {
    throw new TypeError("ContextDelta basisRevision must be non-negative");
  }
  const resultSnapshotHash = contextSnapshotHashV1(input.resultMessages);
  const deltaId = `context_delta_v1_${fingerprintPactileContractV1({
    domain: "context-delta-v1",
    operation: input.operation,
    baseSnapshotHash: input.baseSnapshotHash,
    resultSnapshotHash,
    sourceCursorStart: input.sourceCursorStart,
    sourceCursorEnd: input.sourceCursorEnd,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  return Object.freeze({
    schemaVersion: CONTEXT_COMPACTION_SCHEMA_VERSION,
    deltaId,
    operation: input.operation,
    baseSnapshotHash: input.baseSnapshotHash,
    resultSnapshotHash,
    sourceCursorStart: input.sourceCursorStart,
    sourceCursorEnd: input.sourceCursorEnd,
    basisRevision: input.basisRevision,
    cutPoint: input.cutPoint,
    maskedToolCallIds: Object.freeze([...(input.maskedToolCallIds ?? [])]),
    removedRangeHash: input.removedRangeHash ?? null,
  });
}

/** Build an immutable reference for a new context; messages stay in memory. */
export function buildContextSnapshotRefV1(input: {
  readonly messages: readonly unknown[];
  readonly snapshotRevision: number;
  readonly oldSnapshotHash: string;
  readonly contextBasisHash: string;
  readonly sourceCursor: string;
  readonly compactionReceiptHash: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly artifactHash: string;
  readonly manifestId: string;
  readonly manifestRevision: number;
  readonly manifestHash: string;
  readonly checkpointId: string;
}): ContextSnapshotRefV1 {
  if (!positiveInteger(input.snapshotRevision)) {
    throw new TypeError("snapshotRevision must be a positive safe integer");
  }
  if (!positiveInteger(input.artifactVersion)) {
    throw new TypeError("artifactVersion must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.manifestRevision) || input.manifestRevision < 1) {
    throw new TypeError("manifestRevision must be a positive safe integer");
  }
  for (const [label, value] of [
    ["oldSnapshotHash", input.oldSnapshotHash],
    ["contextBasisHash", input.contextBasisHash],
    ["sourceCursor", input.sourceCursor],
    ["compactionReceiptHash", input.compactionReceiptHash],
    ["artifactId", input.artifactId],
    ["artifactHash", input.artifactHash],
    ["manifestId", input.manifestId],
    ["manifestHash", input.manifestHash],
    ["checkpointId", input.checkpointId],
  ] as const) {
    if (!nonEmpty(value)) throw new TypeError(`${label} must be non-empty`);
  }
  const contentHash = contextSnapshotHashV1(input.messages);
  const snapshotId = `context_snapshot_v1_${contentHash.slice("sha256:".length, "sha256:".length + 32)}`;
  return Object.freeze({
    schemaVersion: CONTEXT_COMPACTION_SCHEMA_VERSION,
    snapshotId,
    snapshotRevision: input.snapshotRevision,
    messageCount: input.messages.length,
    contentHash,
    contextBasisHash: input.contextBasisHash,
    sourceCursor: input.sourceCursor,
    source: "compaction",
    oldSnapshotHash: input.oldSnapshotHash,
    compactionReceiptHash: input.compactionReceiptHash,
    artifactId: input.artifactId,
    artifactVersion: input.artifactVersion,
    artifactHash: input.artifactHash,
    manifestId: input.manifestId,
    manifestRevision: input.manifestRevision,
    manifestHash: input.manifestHash,
    checkpointId: input.checkpointId,
  });
}

/** Canonical encoding helper for evidence/hash tests; it never stores content. */
export function encodeContextCutPointV1(cutPoint: ContextCutPointV1): string {
  return canonicalizePactileJsonV1(cutPoint);
}
