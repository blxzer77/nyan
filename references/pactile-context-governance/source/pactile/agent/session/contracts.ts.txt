import {
  PACTILE_FINGERPRINT_PATTERN,
  PACTILE_LOGICAL_ID_PATTERN,
  fingerprintPactileContractV1,
} from "../../shared/validation.js";
import type { AgentMessage } from "../pi/types.js";
import type { PiSessionEntry, PiSessionManagerPort } from "./checkpoint.js";

/** Version of the Agent-owned session binding and transcript seam. */
export const PACTILE_AGENT_SESSION_SCHEMA_VERSION = 1 as const;
export const PACTILE_AGENT_MESSAGE_ENTRY_TYPE = "pactile.agent-message.v1" as const;

export interface PactileAgentSessionBindingV1 {
  readonly schemaVersion: typeof PACTILE_AGENT_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly repositoryRoot: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly generationId: string;
  readonly runId: string;
  readonly operationEpoch: number;
  readonly semanticFingerprint: string;
  readonly snapshotHash: string | null;
  readonly checkpointId: string | null;
  readonly updatedAt: string;
}

export type PactileAgentSessionBindingInputV1 = Omit<
  PactileAgentSessionBindingV1,
  "schemaVersion" | "snapshotHash" | "checkpointId" | "updatedAt"
> & {
  readonly snapshotHash?: string | null;
  readonly checkpointId?: string | null;
  readonly updatedAt?: string;
};

export interface PactileAgentSessionSnapshotUpdateV1 {
  readonly runId: string;
  readonly operationEpoch: number;
  readonly snapshotHash: string;
  readonly checkpointId: string;
  readonly updatedAt?: string;
}

export interface PactileAgentSessionEpochUpdateV1 {
  readonly runId: string;
  readonly operationEpoch: number;
  readonly semanticFingerprint: string;
  readonly updatedAt?: string;
}

/** Agent-owned extension of the Pi SessionManager-shaped checkpoint port. */
export interface PactileAgentSessionPort extends PiSessionManagerPort {
  readBinding(): PactileAgentSessionBindingV1 | null;
  ensureBinding(
    input: PactileAgentSessionBindingInputV1,
  ): PactileAgentSessionBindingV1;
  recordSnapshot(
    input: PactileAgentSessionSnapshotUpdateV1,
  ): PactileAgentSessionBindingV1;
  /** Explicit reconnect/rebind after the RuntimeStore lease epoch advances. */
  advanceOperationEpoch(
    input: PactileAgentSessionEpochUpdateV1,
  ): PactileAgentSessionBindingV1;
  appendTranscriptMessage(message: AgentMessage): string;
  readTranscriptMessages(): readonly AgentMessage[];
}

export class PactileAgentSessionBindingError extends TypeError {
  readonly code:
    | "invalid_binding"
    | "binding_conflict"
    | "snapshot_conflict"
    | "transcript_invalid";

  constructor(
    code:
      | "invalid_binding"
      | "binding_conflict"
      | "snapshot_conflict"
      | "transcript_invalid",
    message: string,
  ) {
    super(message);
    this.name = "PactileAgentSessionBindingError";
    this.code = code;
    Object.setPrototypeOf(this, PactileAgentSessionBindingError.prototype);
  }
}

export function assertPactileSessionIdV1(value: unknown, label = "sessionId"): string {
  if (typeof value !== "string" || !PACTILE_LOGICAL_ID_PATTERN.test(value)) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      `${label} must be a lowercase Pactile logical id`,
    );
  }
  return value;
}

export function assertPactileSessionFingerprintV1(
  value: unknown,
  label = "semanticFingerprint",
): string {
  if (typeof value !== "string" || !PACTILE_FINGERPRINT_PATTERN.test(value)) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      `${label} must be a sha256 fingerprint`,
    );
  }
  return value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertPathLike(value: unknown, label: string): string {
  if (!nonEmpty(value) || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      `${label} must be a non-empty path without control characters`,
    );
  }
  return value;
}

function assertEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      "operationEpoch must be a positive safe integer",
    );
  }
  return value;
}

export function validatePactileAgentSessionBindingV1(
  input: PactileAgentSessionBindingInputV1 | PactileAgentSessionBindingV1,
): PactileAgentSessionBindingV1 {
  const sessionId = assertPactileSessionIdV1(input.sessionId);
  const runId = assertPactileSessionIdV1(input.runId, "runId");
  const generationId = assertPactileSessionIdV1(input.generationId, "generationId");
  const semanticFingerprint = assertPactileSessionFingerprintV1(input.semanticFingerprint);
  const repositoryRoot = assertPathLike(input.repositoryRoot, "repositoryRoot");
  const cwd = assertPathLike(input.cwd, "cwd");
  const worktreePath = assertPathLike(input.worktreePath, "worktreePath");
  const operationEpoch = assertEpoch(input.operationEpoch);
  const snapshotHash = input.snapshotHash ?? null;
  if (snapshotHash !== null) assertPactileSessionFingerprintV1(snapshotHash, "snapshotHash");
  const checkpointId = input.checkpointId ?? null;
  if (checkpointId !== null && !nonEmpty(checkpointId)) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      "checkpointId must be non-empty when present",
    );
  }
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  if (!nonEmpty(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    throw new PactileAgentSessionBindingError(
      "invalid_binding",
      "updatedAt must be an ISO timestamp",
    );
  }
  return Object.freeze({
    schemaVersion: PACTILE_AGENT_SESSION_SCHEMA_VERSION,
    sessionId,
    repositoryRoot,
    cwd,
    worktreePath,
    generationId,
    runId,
    operationEpoch,
    semanticFingerprint,
    snapshotHash,
    checkpointId,
    updatedAt,
  });
}

export function assertPactileAgentSessionBindingV1(
  value: unknown,
): PactileAgentSessionBindingV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PactileAgentSessionBindingError("invalid_binding", "session binding must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PACTILE_AGENT_SESSION_SCHEMA_VERSION) {
    throw new PactileAgentSessionBindingError("invalid_binding", "unknown session binding schema version");
  }
  return validatePactileAgentSessionBindingV1(record as unknown as PactileAgentSessionBindingV1);
}

export function pactileAgentMessageFingerprintV1(message: AgentMessage): string {
  return fingerprintPactileContractV1({
    domain: "pactile-agent-session-message-v1",
    message,
  });
}

export function isPactileAgentMessageEntry(
  entry: PiSessionEntry,
): boolean {
  return entry.type === "custom" && entry.customType === PACTILE_AGENT_MESSAGE_ENTRY_TYPE;
}
