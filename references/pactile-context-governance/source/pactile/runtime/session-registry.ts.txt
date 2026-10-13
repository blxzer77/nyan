/**
 * Session Registry host adapter.
 *
 * This module owns no storage. It translates Session Registry operations into
 * RuntimeStorePort mutations, so the host adapter (SQLite) owns durability and
 * the mutation transaction while the host-neutral contract in
 * `../runtime/contracts/session-registry.js` supplies parsing, folding and recovery classification.
 *
 * Boundaries:
 * - every session event is appended with a lease proof, so a stale owner,
 *   stale epoch, wrong partition, expired lease, or stale sequence is rejected
 *   inside the same transaction as the insert;
 * - `bind` never preempts an unexpired lease held by another owner;
 * - `heartbeat` is current-owner only, advances the operation epoch
 *   monotonically, and renews the lease with a newer lease epoch;
 * - only an expired lease may be taken over, and only through `reconnect`;
 * - `release` records the fact before dropping the lease, and a repeated
 *   identical release replays without a second event;
 * - `recover` returns a structured receipt; it never replays a Pi side effect
 *   and never changes WorkItem, Block, or AgentRun settlement.
 */

import {
  SessionRegistryError,
  SESSION_REGISTRY_SCHEMA_VERSION,
  assertSessionRegistryFingerprintV1,
  assertSessionRegistryLogicalIdV1,
  classifySessionRegistryRecoveryV1,
  decodeSessionRegistryRuntimeEventsV1,
  foldSessionRegistryEventsV1,
  parseSessionRegistryEventV1,
  sessionRegistryEventTypeV1,
  sessionRegistryIdempotencyKeyV1,
  sessionRegistryPartitionV1,
  sessionRegistryRequestHashV1,
  type SessionRegistryActionV1,
  type SessionRegistryBindingV1,
  type SessionRegistryDecodedEventV1,
  type SessionRegistryErrorCode,
  type SessionRegistryRecoveryClassificationV1,
} from "./contracts/session-registry.js";
import type { RuntimeStoreEvent, RuntimeStorePort } from "./store-port.js";

/** Default lease lifetime when a caller does not supply one. */
export const SESSION_REGISTRY_DEFAULT_LEASE_TTL_MS = 60_000;

export interface SessionRegistryOptions {
  readonly store: RuntimeStorePort;
  /** Injectable clock so expiry can be exercised deterministically. */
  readonly now?: () => Date;
}

export interface SessionRegistryIdentity {
  readonly sessionId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly blockId: string;
}

export interface SessionRegistryBindRequest extends SessionRegistryIdentity {
  readonly runId: string;
  readonly semanticFingerprint: string;
  readonly ownerId: string;
  readonly ttlMs?: number;
}

export interface SessionRegistryHeartbeatRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly operationEpoch: number;
  readonly ttlMs?: number;
}

export interface SessionRegistryReconnectRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly ttlMs?: number;
}

export interface SessionRegistryReleaseRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly operationEpoch: number;
}

export interface SessionRegistryReadResult {
  readonly schemaVersion: typeof SESSION_REGISTRY_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly binding: SessionRegistryBindingV1 | null;
  readonly classification: SessionRegistryRecoveryClassificationV1;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly events: readonly RuntimeStoreEvent[];
}

export interface SessionRegistryLeaseView {
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
}

export interface SessionRegistryMutationResult {
  readonly schemaVersion: typeof SESSION_REGISTRY_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly action: SessionRegistryActionV1;
  readonly applied: boolean;
  readonly binding: SessionRegistryBindingV1;
  readonly lease: SessionRegistryLeaseView;
  readonly sequence: number;
  readonly classification: SessionRegistryRecoveryClassificationV1;
}

/**
 * Structured recovery receipt. `replayed: false` and the explicit settlement
 * fields make it impossible to mistake recovery for executed side effects.
 */
export interface SessionRegistryRecoveryReceipt {
  readonly schemaVersion: typeof SESSION_REGISTRY_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly recoveredAt: string;
  readonly replayPolicy: "no_automatic_replay";
  readonly replayed: false;
  readonly workItemSettlementChanged: false;
  readonly blockSettlementChanged: false;
  readonly agentRunSettlementChanged: false;
  readonly classification: SessionRegistryRecoveryClassificationV1;
  readonly binding: SessionRegistryBindingV1 | null;
  readonly events: readonly RuntimeStoreEvent[];
  readonly lastSequence: number;
}

interface HeldLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly epoch: number;
  /** `null` when proving a lease that is about to be released. */
  readonly expiresAt: string | null;
}

interface MutationPlan {
  readonly action: SessionRegistryActionV1;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly blockId: string;
  readonly runId: string;
  readonly semanticFingerprint: string;
  readonly ownerId: string;
  readonly operationEpoch: number;
  readonly previousOperationEpoch: number | null;
  readonly requestHash: string;
  /** `null` proves and releases the held lease instead of acquiring one. */
  readonly ttlMs: number | null;
  /** Prior folded state this plan expects to replace; `null` means empty. */
  readonly expectedPriorEpoch: number | null;
  readonly expectedPriorStatus: "active" | "released" | null;
  /** Original binding instant, carried forward from the folded prior state. */
  readonly boundAt: string | null;
}

function fail(
  code: SessionRegistryErrorCode,
  message: string,
  sessionId: string | null,
  sequence: number | null = null,
): never {
  throw new SessionRegistryError(code, message, { sessionId, sequence });
}

function requireTtl(value: number | undefined): number {
  const ttl = value ?? SESSION_REGISTRY_DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    fail(
      "session_registry_invalid_request",
      "ttlMs must be a positive safe integer",
      null,
    );
  }
  return ttl;
}

function requireOperationEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "session_registry_invalid_request",
      "operationEpoch must be a positive safe integer",
      null,
    );
  }
  return value;
}

function requireBinding(
  read: SessionRegistryReadResult,
  scope: string,
): SessionRegistryBindingV1 {
  if (read.binding === null) {
    fail("session_registry_not_bound", "session has no binding", scope);
  }
  return read.binding;
}

function leaseViewOf(binding: SessionRegistryBindingV1): SessionRegistryLeaseView {
  return {
    leaseId: binding.leaseId,
    leaseEpoch: binding.leaseEpoch,
    expiresAt: binding.leaseExpiresAt,
  };
}

/** Durable Session Registry facade over one RuntimeStorePort. */
export class SessionRegistry {
  private readonly store: RuntimeStorePort;
  private readonly now: () => Date;

  constructor(options: SessionRegistryOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** Read the folded binding and ordered events for one session. */
  async read(sessionId: string): Promise<SessionRegistryReadResult> {
    const scope = assertSessionRegistryLogicalIdV1(sessionId, "sessionId");
    const partition = sessionRegistryPartitionV1(scope);
    const stream = await this.store.readEvents(partition);
    const decoded = decodeSessionRegistryRuntimeEventsV1(scope, stream.events);
    const fold = foldSessionRegistryEventsV1(
      scope,
      decoded.map((entry) => entry.event),
    );
    return {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: scope,
      binding: fold.binding,
      classification: classifySessionRegistryRecoveryV1(
        fold.binding,
        this.now().toISOString(),
      ),
      lastSequence: fold.lastSequence,
      eventCount: fold.eventCount,
      events: stream.events,
    };
  }

  /**
   * Bind a session, or rebind a released session. An active lease held by a
   * different owner with time remaining is never preempted; the new owner must
   * wait for expiry and reconnect.
   */
  async bind(
    request: SessionRegistryBindRequest,
  ): Promise<SessionRegistryMutationResult> {
    const identity = this.identity(request);
    const runId = assertSessionRegistryLogicalIdV1(request.runId, "runId");
    const semanticFingerprint = assertSessionRegistryFingerprintV1(
      request.semanticFingerprint,
      "semanticFingerprint",
    );
    const ownerId = assertSessionRegistryLogicalIdV1(request.ownerId, "ownerId");
    const ttlMs = requireTtl(request.ttlMs);
    const requestHash = sessionRegistryRequestHashV1("bind", {
      operation: "bind",
      ...identity,
      runId,
      semanticFingerprint,
      ownerId,
      ttlMs,
    });
    const read = await this.read(identity.sessionId);
    const replay = this.findReplay(read, "bound", ownerId, requestHash);
    if (replay !== null) {
      return this.replayResult(read, "bound", replay);
    }
    const binding = read.binding;
    if (binding === null) {
      return this.commit({
        action: "bound",
        ...identity,
        runId,
        semanticFingerprint,
        ownerId,
        operationEpoch: 1,
        previousOperationEpoch: null,
        requestHash,
        ttlMs,
        expectedPriorEpoch: null,
        expectedPriorStatus: null,
        boundAt: null,
      });
    }
    if (binding.status === "active") {
      if (binding.ownerId !== ownerId) {
        fail(
          "session_registry_lease_active",
          "an active session lease belongs to another owner; wait for expiry, then reconnect",
          identity.sessionId,
        );
      }
      fail(
        "session_registry_conflict",
        "session is already bound and active; use heartbeat to renew it",
        identity.sessionId,
      );
    }
    if (binding.runId !== runId) {
      fail(
        "session_registry_run_conflict",
        "a rebound session must keep the recorded runId",
        identity.sessionId,
      );
    }
    if (binding.semanticFingerprint !== semanticFingerprint) {
      fail(
        "session_registry_semantic_conflict",
        "a rebound session must keep the recorded semantic fingerprint",
        identity.sessionId,
      );
    }
    return this.commit({
      action: "bound",
      ...identity,
      runId,
      semanticFingerprint,
      ownerId,
      operationEpoch: binding.operationEpoch + 1,
      previousOperationEpoch: binding.operationEpoch,
      requestHash,
      ttlMs,
      expectedPriorEpoch: binding.operationEpoch,
      expectedPriorStatus: "released",
      boundAt: binding.boundAt,
    });
  }

  /**
   * Current-owner heartbeat. It advances the operation epoch monotonically and
   * renews the lease with a newer lease epoch; it cannot transfer ownership.
   */
  async heartbeat(
    request: SessionRegistryHeartbeatRequest,
  ): Promise<SessionRegistryMutationResult> {
    const scope = assertSessionRegistryLogicalIdV1(request.sessionId, "sessionId");
    const ownerId = assertSessionRegistryLogicalIdV1(request.ownerId, "ownerId");
    const leaseId = assertSessionRegistryLogicalIdV1(request.leaseId, "leaseId");
    const operationEpoch = requireOperationEpoch(request.operationEpoch);
    const ttlMs = requireTtl(request.ttlMs);
    const requestHash = sessionRegistryRequestHashV1("heartbeat", {
      operation: "heartbeat",
      sessionId: scope,
      ownerId,
      leaseId,
      operationEpoch,
      ttlMs,
    });
    const read = await this.read(scope);
    const replay = this.findReplay(read, "heartbeat", ownerId, requestHash);
    if (replay !== null) {
      return this.replayResult(read, "heartbeat", replay);
    }
    const binding = requireBinding(read, scope);
    if (binding.status === "released") {
      fail("session_registry_released", "a released session cannot heartbeat", scope);
    }
    if (read.classification !== "active") {
      fail(
        "session_registry_lease_expired",
        "an expired session lease cannot heartbeat; reconnect instead",
        scope,
      );
    }
    if (binding.ownerId !== ownerId) {
      fail(
        "session_registry_owner_conflict",
        "only the current owner may heartbeat",
        scope,
      );
    }
    if (binding.leaseId !== leaseId) {
      fail(
        "session_registry_epoch_conflict",
        "heartbeat must name the current lease",
        scope,
      );
    }
    if (binding.operationEpoch !== operationEpoch) {
      fail(
        "session_registry_epoch_conflict",
        "heartbeat must name the current operation epoch",
        scope,
      );
    }
    return this.commit({
      action: "heartbeat",
      ...this.identityOf(binding),
      runId: binding.runId,
      semanticFingerprint: binding.semanticFingerprint,
      ownerId,
      operationEpoch: binding.operationEpoch + 1,
      previousOperationEpoch: binding.operationEpoch,
      requestHash,
      ttlMs,
      expectedPriorEpoch: binding.operationEpoch,
      expectedPriorStatus: "active",
      boundAt: binding.boundAt,
    });
  }

  /**
   * Take over an expired session lease with a fresh owner or a new process for
   * the same owner. A live lease is never stolen.
   */
  async reconnect(
    request: SessionRegistryReconnectRequest,
  ): Promise<SessionRegistryMutationResult> {
    const scope = assertSessionRegistryLogicalIdV1(request.sessionId, "sessionId");
    const ownerId = assertSessionRegistryLogicalIdV1(request.ownerId, "ownerId");
    const ttlMs = requireTtl(request.ttlMs);
    const requestHash = sessionRegistryRequestHashV1("reconnect", {
      operation: "reconnect",
      sessionId: scope,
      ownerId,
      ttlMs,
    });
    const read = await this.read(scope);
    const replay = this.findReplay(read, "reconnected", ownerId, requestHash);
    if (replay !== null) {
      return this.replayResult(read, "reconnected", replay);
    }
    const binding = requireBinding(read, scope);
    if (binding.status === "released") {
      fail(
        "session_registry_released",
        "a released session cannot reconnect; bind it again",
        scope,
      );
    }
    if (read.classification === "active") {
      fail(
        "session_registry_lease_active",
        "the current session lease has not expired; reconnect is only valid after expiry",
        scope,
      );
    }
    return this.commit({
      action: "reconnected",
      ...this.identityOf(binding),
      runId: binding.runId,
      semanticFingerprint: binding.semanticFingerprint,
      ownerId,
      operationEpoch: binding.operationEpoch + 1,
      previousOperationEpoch: binding.operationEpoch,
      requestHash,
      ttlMs,
      expectedPriorEpoch: binding.operationEpoch,
      expectedPriorStatus: "active",
      boundAt: binding.boundAt,
    });
  }

  /**
   * Release a session. The event records the release before the lease row is
   * dropped, and a repeated identical release replays without a new event.
   */
  async release(
    request: SessionRegistryReleaseRequest,
  ): Promise<SessionRegistryMutationResult> {
    const scope = assertSessionRegistryLogicalIdV1(request.sessionId, "sessionId");
    const ownerId = assertSessionRegistryLogicalIdV1(request.ownerId, "ownerId");
    const leaseId = assertSessionRegistryLogicalIdV1(request.leaseId, "leaseId");
    const operationEpoch = requireOperationEpoch(request.operationEpoch);
    const requestHash = sessionRegistryRequestHashV1("release", {
      operation: "release",
      sessionId: scope,
      ownerId,
      leaseId,
      operationEpoch,
    });
    const read = await this.read(scope);
    const replay = this.findReplay(read, "released", ownerId, requestHash);
    if (replay !== null) {
      return this.replayResult(read, "released", replay);
    }
    const binding = requireBinding(read, scope);
    if (binding.status === "released") {
      fail(
        "session_registry_released",
        "session was already released by a different request",
        scope,
      );
    }
    if (read.classification !== "active") {
      fail(
        "session_registry_lease_expired",
        "an expired session lease cannot be released; reconnect before release",
        scope,
      );
    }
    if (binding.ownerId !== ownerId) {
      fail(
        "session_registry_owner_conflict",
        "only the current owner may release a session",
        scope,
      );
    }
    if (binding.leaseId !== leaseId || binding.operationEpoch !== operationEpoch) {
      fail(
        "session_registry_epoch_conflict",
        "release must name the current lease and operation epoch",
        scope,
      );
    }
    return this.commit({
      action: "released",
      ...this.identityOf(binding),
      runId: binding.runId,
      semanticFingerprint: binding.semanticFingerprint,
      ownerId,
      operationEpoch,
      previousOperationEpoch: operationEpoch,
      requestHash,
      ttlMs: null,
      expectedPriorEpoch: operationEpoch,
      expectedPriorStatus: "active",
      boundAt: binding.boundAt,
    });
  }

  /**
   * Recover the durable session facts. The receipt is structured and reports
   * `replayed: false`; it never writes Pi state or any settlement.
   */
  async recover(sessionId: string): Promise<SessionRegistryRecoveryReceipt> {
    const read = await this.read(sessionId);
    const recoveredAt = this.now().toISOString();
    return {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: read.sessionId,
      recoveredAt,
      replayPolicy: "no_automatic_replay",
      replayed: false,
      workItemSettlementChanged: false,
      blockSettlementChanged: false,
      agentRunSettlementChanged: false,
      classification: classifySessionRegistryRecoveryV1(
        read.binding,
        recoveredAt,
      ),
      binding: read.binding,
      events: read.events,
      lastSequence: read.lastSequence,
    };
  }

  private identity(request: SessionRegistryIdentity): SessionRegistryIdentity {
    return {
      sessionId: assertSessionRegistryLogicalIdV1(request.sessionId, "sessionId"),
      taskId: assertSessionRegistryLogicalIdV1(request.taskId, "taskId"),
      workItemId: assertSessionRegistryLogicalIdV1(
        request.workItemId,
        "workItemId",
      ),
      blockId: assertSessionRegistryLogicalIdV1(request.blockId, "blockId"),
    };
  }

  private identityOf(binding: SessionRegistryBindingV1): SessionRegistryIdentity {
    return {
      sessionId: binding.sessionId,
      taskId: binding.taskId,
      workItemId: binding.workItemId,
      blockId: binding.blockId,
    };
  }

  private decode(
    read: SessionRegistryReadResult,
  ): readonly SessionRegistryDecodedEventV1[] {
    return decodeSessionRegistryRuntimeEventsV1(read.sessionId, read.events);
  }

  /**
   * A request is a replay only when its recorded event is still the latest
   * event and the current folded state matches that action. Anything older
   * means another writer superseded it, so the caller must fail closed rather
   * than act on stale intent.
   */
  private findReplay(
    read: SessionRegistryReadResult,
    action: SessionRegistryActionV1,
    ownerId: string,
    requestHash: string,
  ): SessionRegistryDecodedEventV1 | null {
    const decoded = this.decode(read);
    const entry = decoded.at(-1);
    if (
      entry?.event.requestHash !== requestHash ||
      entry.event.action !== action ||
      entry.event.binding.ownerId !== ownerId
    ) {
      return null;
    }
    const status = read.binding?.status ?? null;
    if (action === "released" ? status !== "released" : status !== "active") {
      return null;
    }
    return entry;
  }

  private replayResult(
    read: SessionRegistryReadResult,
    action: SessionRegistryActionV1,
    entry: SessionRegistryDecodedEventV1,
  ): SessionRegistryMutationResult {
    if (read.binding === null) {
      fail(
        "session_registry_conflict",
        "replayed request has no matching recorded session binding",
        read.sessionId,
      );
    }
    return {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: read.sessionId,
      action,
      applied: false,
      binding: read.binding,
      lease: leaseViewOf(read.binding),
      sequence: entry.event.sequence,
      classification: read.classification,
    };
  }

  private async commit(plan: MutationPlan): Promise<SessionRegistryMutationResult> {
    const partition = sessionRegistryPartitionV1(plan.sessionId);
    const read = await this.read(plan.sessionId);
    const replay = this.findReplay(read, plan.action, plan.ownerId, plan.requestHash);
    if (replay !== null) {
      return this.replayResult(read, plan.action, replay);
    }
    const prior = read.binding;
    if (
      (prior?.operationEpoch ?? null) !== plan.expectedPriorEpoch ||
      (prior?.status ?? null) !== plan.expectedPriorStatus
    ) {
      fail(
        "session_registry_conflict",
        "session changed before the mutation was recorded; retry from a fresh read",
        plan.sessionId,
      );
    }
    const lease =
      plan.ttlMs === null
        ? this.provenLease(prior, plan.sessionId)
        : await this.acquireLease(plan, partition);
    const payload = this.eventPayload(plan, read.lastSequence + 1, lease);
    const parsed = parseSessionRegistryEventV1(payload);
    if (!parsed.success) {
      fail(
        "session_registry_malformed_event",
        "refusing to append a session event that fails its own schema",
        plan.sessionId,
      );
    }
    const appended = await this.store.appendEvent({
      partition,
      runId: plan.runId,
      type: sessionRegistryEventTypeV1(plan.action),
      payload: parsed.data,
      expectedSequence: read.lastSequence,
      requestHash: plan.requestHash,
      idempotencyKey: sessionRegistryIdempotencyKeyV1(
        plan.sessionId,
        plan.action,
        plan.requestHash,
      ),
      lease: {
        partition,
        leaseId: lease.leaseId,
        ownerId: lease.ownerId,
        epoch: lease.epoch,
      },
    });
    if (plan.ttlMs === null && appended.applied) {
      await this.releaseLease(partition, lease);
    }
    const folded = await this.read(plan.sessionId);
    if (folded.binding === null) {
      fail(
        "session_registry_malformed_event",
        "session binding disappeared after a committed event",
        plan.sessionId,
        appended.value.sequence,
      );
    }
    return {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: plan.sessionId,
      action: plan.action,
      applied: appended.applied,
      binding: folded.binding,
      lease: leaseViewOf(folded.binding),
      sequence: appended.value.sequence,
      classification: folded.classification,
    };
  }

  private provenLease(
    binding: SessionRegistryBindingV1 | null,
    sessionId: string,
  ): HeldLease {
    if (binding === null) {
      fail(
        "session_registry_not_bound",
        "a release requires a bound session with a live lease",
        sessionId,
      );
    }
    return {
      leaseId: binding.leaseId,
      ownerId: binding.ownerId,
      epoch: binding.leaseEpoch,
      expiresAt: null,
    };
  }

  private eventPayload(
    plan: MutationPlan,
    sequence: number,
    lease: HeldLease,
  ): unknown {
    const at = this.now().toISOString();
    const released = plan.action === "released";
    const binding: SessionRegistryBindingV1 = {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: plan.sessionId,
      taskId: plan.taskId,
      workItemId: plan.workItemId,
      blockId: plan.blockId,
      runId: plan.runId,
      semanticFingerprint: plan.semanticFingerprint,
      operationEpoch: plan.operationEpoch,
      ownerId: plan.ownerId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.epoch,
      // A release pins the expiry to the event instant so a released binding
      // can never claim a live lease; a live event uses the acquired expiry.
      leaseExpiresAt: released
        ? at
        : (lease.expiresAt ?? this.defaultExpiry()),
      boundAt: plan.boundAt ?? at,
      updatedAt: at,
      status: released ? "released" : "active",
      releasedAt: released ? at : null,
    };
    return {
      schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
      sessionId: plan.sessionId,
      action: plan.action,
      sequence,
      previousOperationEpoch: plan.previousOperationEpoch,
      requestHash: plan.requestHash,
      at,
      binding,
    };
  }

  private defaultExpiry(): string {
    return new Date(
      this.now().getTime() + SESSION_REGISTRY_DEFAULT_LEASE_TTL_MS,
    ).toISOString();
  }

  private async acquireLease(
    plan: MutationPlan,
    partition: string,
  ): Promise<HeldLease> {
    const ttlMs = plan.ttlMs ?? SESSION_REGISTRY_DEFAULT_LEASE_TTL_MS;
    const requestHash = sessionRegistryRequestHashV1("acquire-lease", {
      operation: "acquire-lease",
      sessionId: plan.sessionId,
      ownerId: plan.ownerId,
      runId: plan.runId,
      ttlMs,
      mutationRequestHash: plan.requestHash,
    });
    const acquired = await this.store.acquireLease({
      partition,
      runId: plan.runId,
      ownerId: plan.ownerId,
      ttlMs,
      requestHash,
      idempotencyKey: sessionRegistryIdempotencyKeyV1(
        plan.sessionId,
        "lease",
        requestHash,
      ),
    });
    return {
      leaseId: acquired.value.leaseId,
      ownerId: acquired.value.ownerId,
      epoch: acquired.value.epoch,
      expiresAt: acquired.value.expiresAt,
    };
  }

  private async releaseLease(partition: string, lease: HeldLease): Promise<void> {
    const requestHash = sessionRegistryRequestHashV1("release-lease", {
      operation: "release-lease",
      partition,
      leaseId: lease.leaseId,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
    });
    await this.store.releaseLease({
      leaseId: lease.leaseId,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      requestHash,
      idempotencyKey: sessionRegistryIdempotencyKeyV1(
        partition,
        "lease-release",
        requestHash,
      ),
    });
  }
}
