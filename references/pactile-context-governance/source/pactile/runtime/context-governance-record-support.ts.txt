import type { ArtifactStoreBindingV1 } from "../agent/memory/artifact-store.js";
import { fingerprintPactileContractV1 } from "../shared/validation.js";
import type { RuntimeStoreJsonObject } from "./store-port.js";

/**
 * Shared plumbing of the memory Context Governance records (memory.read,
 * disclosure, memory.commit): envelope and failure shape. Persistence and the
 * RunLedger binding go through context-governance-artifact-intents.
 */

export interface MemoryRecordPersistFailureV1 {
  readonly ok: false;
  readonly code:
    | "input_invalid"
    | "ledger_missing"
    | "ledger_conflict"
    | "artifact_prepare_failed"
    | "artifact_commit_failed"
    | "ledger_binding_failed";
  readonly message: string;
  /**
   * Immutable artifacts already committed when the failure happened. They are
   * unbound residue, not a half-applied operation: nothing references them
   * until a retry with the same inputs adopts them and binds the RunLedger.
   */
  readonly committedArtifacts?: readonly ArtifactStoreBindingV1[];
}

export function recordFailure(
  code: MemoryRecordPersistFailureV1["code"],
  message: string,
  committedArtifacts: readonly ArtifactStoreBindingV1[] = [],
): MemoryRecordPersistFailureV1 {
  return committedArtifacts.length === 0
    ? { ok: false, code, message }
    : { ok: false, code, message, committedArtifacts };
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export interface RecordIdentityV1 {
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationEpoch: number;
  readonly contextOperationId: string;
  readonly createdAt: string;
}

export function envelope(
  schemaId: string,
  identity: RecordIdentityV1,
  body: RuntimeStoreJsonObject,
): RuntimeStoreJsonObject {
  const bodyHash = fingerprintPactileContractV1({
    domain: `${schemaId}:body-v1`,
    value: body,
  });
  return {
    schemaId,
    schemaVersion: 1,
    plane: "runtime",
    ...identity,
    bodyHash,
    receiptHash: fingerprintPactileContractV1({
      domain: `${schemaId}:receipt-v1`,
      value: { bodyHash, body },
    }),
    createdAt: identity.createdAt,
    provenance: {
      authority: "host",
      producer: "pactile-context-memory",
    },
    ...body,
  } as RuntimeStoreJsonObject;
}
