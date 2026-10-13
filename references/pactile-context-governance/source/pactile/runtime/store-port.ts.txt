/**
 * Node-neutral RuntimeStore contract.
 *
 * This module contains records and deterministic helpers only. Host adapters
 * (SQLite, filesystem, or Electron Main) implement the port; this layer never
 * writes the Task Kernel or replays an unknown side effect.
 */

import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../shared/validation.js";

export const RUNTIME_STORE_SCHEMA_VERSION = 1 as const;
export type RuntimeStoreSchemaVersion = typeof RUNTIME_STORE_SCHEMA_VERSION;

export type RuntimeStoreJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeStoreJsonValue[]
  | RuntimeStoreJsonObject;

export interface RuntimeStoreJsonObject {
  readonly [key: string]: RuntimeStoreJsonValue;
}

export interface RuntimeStoreErrorRecord {
  readonly code: string;
  readonly message: string;
  readonly details: RuntimeStoreJsonValue | null;
}

export type RuntimeStoreRunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface RuntimeStoreRun {
  readonly schemaVersion: RuntimeStoreSchemaVersion;
  readonly runId: string;
  readonly status: RuntimeStoreRunStatus;
  readonly revision: number;
  readonly input: RuntimeStoreJsonValue;
  readonly output: RuntimeStoreJsonValue | null;
  readonly error: RuntimeStoreErrorRecord | null;
  readonly metadata: RuntimeStoreJsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RuntimeStoreEffectStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown";

export type RuntimeStoreEffectAssurance = "assurance_exact" | "assurance_unknown";

export interface RuntimeStoreEffectReceipt {
  readonly schemaVersion: RuntimeStoreSchemaVersion;
  readonly effectId: string;
  readonly runId: string;
  readonly status: RuntimeStoreEffectStatus;
  readonly assurance: RuntimeStoreEffectAssurance;
  readonly result: RuntimeStoreJsonValue | null;
  readonly error: RuntimeStoreErrorRecord | null;
  readonly requestHash: string;
  readonly recordedAt: string;
}

export interface RuntimeStoreEvent {
  readonly schemaVersion: RuntimeStoreSchemaVersion;
  readonly eventId: string;
  readonly partition: string;
  readonly sequence: number;
  readonly runId: string;
  readonly type: string;
  readonly payload: RuntimeStoreJsonValue;
  readonly requestHash: string;
  readonly createdAt: string;
}

export interface RuntimeStoreLease {
  readonly schemaVersion: RuntimeStoreSchemaVersion;
  readonly leaseId: string;
  readonly partition: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly requestHash: string;
}

/** Stable fence reasons a host adapter may attach to a rejected write. */
export type RuntimeStoreFenceReason =
  | "event_sequence_mismatch"
  | "lease_missing"
  | "lease_id_mismatch"
  | "lease_partition_mismatch"
  | "lease_run_mismatch"
  | "lease_owner_mismatch"
  | "lease_epoch_mismatch"
  | "lease_expired";

/**
 * Optional proof that the caller still holds one live lease. A host adapter
 * must re-validate every field of this proof inside the same mutation
 * transaction as the write, so a stale read cannot append a fenced event.
 */
export interface RuntimeStoreLeaseProof {
  readonly partition: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly epoch: number;
}

export interface RuntimeStoreMutationInput {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface RuntimeStorePutRunInput extends RuntimeStoreMutationInput {
  readonly run: RuntimeStoreRun;
}

export interface RuntimeStorePutEffectInput extends RuntimeStoreMutationInput {
  readonly receipt: RuntimeStoreEffectReceipt;
  /** Optional live lease proof; adapters re-validate it inside the write transaction. */
  readonly lease?: RuntimeStoreLeaseProof;
}

export interface RuntimeStoreAppendEventInput extends RuntimeStoreMutationInput {
  readonly partition: string;
  readonly runId: string;
  readonly type: string;
  readonly payload: RuntimeStoreJsonValue;
  readonly eventId?: string;
  readonly expectedSequence?: number;
  /** Absent keeps legacy append behavior; present fences the write to the lease. */
  readonly lease?: RuntimeStoreLeaseProof;
}

export interface RuntimeStoreAcquireLeaseInput extends RuntimeStoreMutationInput {
  readonly partition: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly expectedEpoch?: number;
  readonly leaseId?: string;
}

export interface RuntimeStoreReleaseLeaseInput extends RuntimeStoreMutationInput {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly epoch: number;
}

export interface RuntimeStoreReadEventsOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface RuntimeStoreRecoverInput {
  readonly runId?: string;
  readonly now?: string;
}

export interface RuntimeStoreMutationResult<TValue> {
  readonly applied: boolean;
  readonly value: TValue;
}

export type RuntimeStorePutRunResult = RuntimeStoreMutationResult<RuntimeStoreRun>;
export type RuntimeStorePutEffectResult = RuntimeStoreMutationResult<RuntimeStoreEffectReceipt>;
export type RuntimeStoreAppendEventResult = RuntimeStoreMutationResult<RuntimeStoreEvent>;
export type RuntimeStoreAcquireLeaseResult = RuntimeStoreMutationResult<RuntimeStoreLease>;

export interface RuntimeStoreReleaseLeaseResult {
  readonly released: boolean;
  readonly leaseId: string;
}

export interface RuntimeStoreReadEventsResult {
  readonly partition: string;
  readonly events: readonly RuntimeStoreEvent[];
  readonly lastSequence: number | null;
}

export interface RuntimeStoreRecoveredEffect {
  readonly effectId: string;
  readonly runId: string;
  readonly status: "waiting";
  readonly assurance: "assurance_unknown";
  readonly reexecute: false;
  readonly reason: "effect_pending" | "effect_unknown";
}

export interface RuntimeStoreRecoverResult {
  readonly schemaVersion: RuntimeStoreSchemaVersion;
  readonly recoveredAt: string;
  readonly replayPolicy: "no_automatic_replay";
  readonly runs: readonly RuntimeStoreRun[];
  readonly effects: readonly RuntimeStoreRecoveredEffect[];
  readonly leases: readonly RuntimeStoreLease[];
}

export interface RuntimeStorePort {
  putRun(input: RuntimeStorePutRunInput): Promise<RuntimeStorePutRunResult>;
  getRun(runId: string): Promise<RuntimeStoreRun | null>;
  putEffect(input: RuntimeStorePutEffectInput): Promise<RuntimeStorePutEffectResult>;
  getEffect(effectId: string): Promise<RuntimeStoreEffectReceipt | null>;
  appendEvent(input: RuntimeStoreAppendEventInput): Promise<RuntimeStoreAppendEventResult>;
  readEvents(partition: string, options?: RuntimeStoreReadEventsOptions): Promise<RuntimeStoreReadEventsResult>;
  acquireLease(input: RuntimeStoreAcquireLeaseInput): Promise<RuntimeStoreAcquireLeaseResult>;
  releaseLease(input: RuntimeStoreReleaseLeaseInput): Promise<RuntimeStoreReleaseLeaseResult>;
  recover(input?: RuntimeStoreRecoverInput): Promise<RuntimeStoreRecoverResult>;
  close(): Promise<void>;
}

export type RuntimeStoreErrorCode =
  | "runtime_store_conflict"
  | "runtime_store_unsupported"
  | "runtime_store_fenced";

export class RuntimeStoreConflictError extends Error {
  readonly code = "runtime_store_conflict" as const;
  constructor(
    message: string,
    readonly operation: string | null = null,
    readonly idempotencyKey: string | null = null,
    readonly requestHash: string | null = null,
  ) {
    super(message);
    this.name = "RuntimeStoreConflictError";
    Object.setPrototypeOf(this, RuntimeStoreConflictError.prototype);
  }
}

export class RuntimeStoreUnsupportedError extends Error {
  readonly code = "runtime_store_unsupported" as const;
  constructor(
    message: string,
    readonly operation: string | null = null,
    readonly feature: string | null = null,
  ) {
    super(message);
    this.name = "RuntimeStoreUnsupportedError";
    Object.setPrototypeOf(this, RuntimeStoreUnsupportedError.prototype);
  }
}

export class RuntimeStoreFencedError extends Error {
  readonly code = "runtime_store_fenced" as const;
  readonly reason: RuntimeStoreFenceReason | null;
  constructor(
    message: string,
    readonly partition: string,
    readonly expectedEpoch: number,
    readonly actualEpoch: number,
    reason: RuntimeStoreFenceReason | null = null,
  ) {
    super(message);
    this.name = "RuntimeStoreFencedError";
    this.reason = reason;
    Object.setPrototypeOf(this, RuntimeStoreFencedError.prototype);
  }
}

export function runtimeRequestHashV1(operation: string, payload: unknown): string {
  return fingerprintPactileContractV1({
    schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
    domain: "runtime-request-v1",
    operation,
    payload: JSON.parse(canonicalizePactileJsonV1(payload)),
  });
}

export function runtimeEventIdV1(
  partition: string,
  sequence: number,
  requestHash: string,
): string {
  return `runtime_event_v1_${fingerprintPactileContractV1({
    schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
    domain: "runtime-event-v1",
    partition,
    sequence,
    requestHash,
  })}`;
}
