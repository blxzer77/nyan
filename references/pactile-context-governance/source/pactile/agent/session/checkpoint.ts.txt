/**
 * Minimal Pi durable Session checkpoint seam.
 *
 * Pactile appends a custom entry through Pi's SessionManager-shaped port and
 * never parses or owns the underlying transcript/storage format.
 */

export const PACTILE_PI_CHECKPOINT_TYPE = "pactile.run-checkpoint" as const;
export const PACTILE_PI_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type CheckpointStatus = "known" | "missing" | "invalid" | "unknown";
export type RunResumeKind = "resume_same_run" | "new_run" | "blocked";
export type RunResumeReason =
  | "same_run"
  | "checkpoint_missing"
  | "checkpoint_invalid"
  | "checkpoint_unknown"
  | "run_settled"
  | "run_changed"
  | "semantic_changed"
  | "effects_unknown"
  | "epoch_mismatch";

export interface PiSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface PiSessionManagerPort {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntryCount(): number;
  getEntries(): readonly PiSessionEntry[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface PiRunCheckpoint {
  readonly schemaVersion: typeof PACTILE_PI_CHECKPOINT_SCHEMA_VERSION;
  readonly runId: string;
  readonly checkpointId: string;
  readonly semanticFingerprint: string;
  readonly effectsKnown: boolean;
  readonly nextActionFingerprint: string | null;
  readonly operationEpoch: number;
  /** Present when the checkpoint was written after a durable Context swap. */
  readonly contextSnapshotHash?: string;
  readonly compactionReceiptHash?: string;
}

export interface PiSessionSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly leafEntryId: string | null;
  readonly entryCount: number;
  readonly checkpoint: PiRunCheckpoint | null;
  readonly checkpointStatus: CheckpointStatus;
}

export interface RunResumeInput {
  readonly currentRunId: string;
  readonly currentRunSettled: boolean;
  readonly requestedSemanticFingerprint: string;
  readonly expectedOperationEpoch: number;
  readonly snapshot: PiSessionSnapshot;
}

export interface RunResumeDecision {
  readonly kind: RunResumeKind;
  readonly reason: RunResumeReason;
  readonly runId: string | null;
}

export class PiCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiCheckpointValidationError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseCheckpoint(value: unknown):
  | { readonly kind: "valid"; readonly checkpoint: PiRunCheckpoint }
  | { readonly kind: "invalid" }
  | { readonly kind: "unknown" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid" };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PACTILE_PI_CHECKPOINT_SCHEMA_VERSION) return { kind: "unknown" };
  if (!nonEmpty(record.runId) || !nonEmpty(record.checkpointId) || !nonEmpty(record.semanticFingerprint)) return { kind: "invalid" };
  if (typeof record.effectsKnown !== "boolean") return { kind: "invalid" };
  if (record.nextActionFingerprint !== null && !nonEmpty(record.nextActionFingerprint)) return { kind: "invalid" };
  if (typeof record.operationEpoch !== "number" || !Number.isSafeInteger(record.operationEpoch) || record.operationEpoch < 0) return { kind: "invalid" };
  if (record.contextSnapshotHash !== undefined && !nonEmpty(record.contextSnapshotHash)) return { kind: "invalid" };
  if (record.compactionReceiptHash !== undefined && !nonEmpty(record.compactionReceiptHash)) return { kind: "invalid" };
  const checkpoint: PiRunCheckpoint = {
    schemaVersion: PACTILE_PI_CHECKPOINT_SCHEMA_VERSION,
    runId: record.runId,
    checkpointId: record.checkpointId,
    semanticFingerprint: record.semanticFingerprint,
    effectsKnown: record.effectsKnown,
    nextActionFingerprint: record.nextActionFingerprint,
    operationEpoch: record.operationEpoch,
  };
  if (record.contextSnapshotHash !== undefined) {
    (checkpoint as { contextSnapshotHash?: string }).contextSnapshotHash = record.contextSnapshotHash;
  }
  if (record.compactionReceiptHash !== undefined) {
    (checkpoint as { compactionReceiptHash?: string }).compactionReceiptHash = record.compactionReceiptHash;
  }
  return { kind: "valid", checkpoint };
}

function validateCheckpoint(input: Omit<PiRunCheckpoint, "schemaVersion">): PiRunCheckpoint {
  const parsed = parseCheckpoint({ schemaVersion: PACTILE_PI_CHECKPOINT_SCHEMA_VERSION, ...input });
  if (parsed.kind !== "valid") throw new PiCheckpointValidationError("invalid Pactile Pi checkpoint");
  return parsed.checkpoint;
}

export function appendPiRunCheckpoint(
  manager: PiSessionManagerPort,
  checkpoint: Omit<PiRunCheckpoint, "schemaVersion">,
): string {
  const validated = validateCheckpoint(checkpoint);
  return manager.appendCustomEntry(PACTILE_PI_CHECKPOINT_TYPE, validated);
}

export function readPiSessionSnapshot(
  manager: PiSessionManagerPort,
  runId?: string,
): PiSessionSnapshot {
  const base = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    leafEntryId: manager.getLeafId(),
    entryCount: manager.getEntryCount(),
  };
  const entries = manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PACTILE_PI_CHECKPOINT_TYPE) continue;
    const parsed = parseCheckpoint(entry.data);
    if (parsed.kind === "unknown") return { ...base, checkpoint: null, checkpointStatus: "unknown" };
    if (parsed.kind === "invalid") return { ...base, checkpoint: null, checkpointStatus: "invalid" };
    if (runId === undefined || parsed.checkpoint.runId === runId) {
      return { ...base, checkpoint: parsed.checkpoint, checkpointStatus: "known" };
    }
  }
  return { ...base, checkpoint: null, checkpointStatus: "missing" };
}

export function decidePiRunResume(input: RunResumeInput): RunResumeDecision {
  const { snapshot } = input;
  if (snapshot.checkpointStatus === "invalid") return { kind: "blocked", reason: "checkpoint_invalid", runId: null };
  if (snapshot.checkpointStatus === "unknown") return { kind: "blocked", reason: "checkpoint_unknown", runId: null };
  if (snapshot.checkpoint === null) return { kind: "new_run", reason: "checkpoint_missing", runId: null };
  if (input.currentRunSettled) return { kind: "new_run", reason: "run_settled", runId: null };
  if (snapshot.checkpoint.runId !== input.currentRunId) return { kind: "new_run", reason: "run_changed", runId: null };
  if (snapshot.checkpoint.semanticFingerprint !== input.requestedSemanticFingerprint) return { kind: "new_run", reason: "semantic_changed", runId: null };
  if (!snapshot.checkpoint.effectsKnown) return { kind: "new_run", reason: "effects_unknown", runId: null };
  if (snapshot.checkpoint.operationEpoch !== input.expectedOperationEpoch) return { kind: "new_run", reason: "epoch_mismatch", runId: null };
  return { kind: "resume_same_run", reason: "same_run", runId: input.currentRunId };
}
