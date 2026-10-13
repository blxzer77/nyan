/**
 * Host-neutral Session Registry contract.
 *
 * A session binding ties one Pi session to one task / work item / block / run
 * tuple under a monotonically increasing operation epoch. Host adapters
 * persist the binding as RuntimeStore events and fence every write with a
 * lease proof; this module performs data validation, deterministic folding and
 * recovery classification only. It never reads files, SQLite, or Pi.
 */

import {
  PACTILE_FINGERPRINT_PATTERN,
  PACTILE_LOGICAL_ID_PATTERN,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  canonicalizePactileJsonV1,
  childPathV1,
  decodeFingerprintV1,
  decodeLogicalIdV1,
  decodeNullableTimestampV1,
  decodeSchemaVersionV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
  fingerprintPactileContractV1,
  isPlainRecordV1,
} from "../../shared/validation.js";
import type {
  RuntimeStoreEvent,
  RuntimeStoreJsonValue,
} from "../store-port.js";

export const SESSION_REGISTRY_SCHEMA_VERSION = 1 as const;
export type SessionRegistrySchemaVersion = typeof SESSION_REGISTRY_SCHEMA_VERSION;

/** Fixed Session Registry actions. Unknown actions fail closed. */
export const SESSION_REGISTRY_ACTIONS_V1 = [
  "bound",
  "heartbeat",
  "reconnected",
  "released",
] as const;
export type SessionRegistryActionV1 = (typeof SESSION_REGISTRY_ACTIONS_V1)[number];

export const SESSION_REGISTRY_BINDING_STATUSES_V1 = [
  "active",
  "released",
] as const;
export type SessionRegistryBindingStatusV1 =
  (typeof SESSION_REGISTRY_BINDING_STATUSES_V1)[number];

export type SessionRegistryRecoveryClassificationV1 =
  | "unbound"
  | "released"
  | "active"
  | "expired";

/** RuntimeStore event types reserved for Session Registry facts. */
export const SESSION_REGISTRY_EVENT_TYPES_V1 = {
  bound: "session.registry.bound",
  heartbeat: "session.registry.heartbeat",
  reconnected: "session.registry.reconnected",
  released: "session.registry.released",
} as const satisfies Record<SessionRegistryActionV1, string>;
export const SESSION_REGISTRY_PARTITION_PREFIX_V1 = "session:" as const;

// These records stay type aliases (not interfaces) on purpose: the JSON
// compatibility guard at the bottom of this module needs the implicit index
// signature that only object type aliases get. Interfaces would make that
// guard evaluate to `never` without a compiler error.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- type alias keeps the implicit index signature required by SessionRegistryJsonCompatibilityV1
export type SessionRegistryBindingV1 = {
  readonly schemaVersion: SessionRegistrySchemaVersion;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly blockId: string;
  readonly runId: string;
  readonly semanticFingerprint: string;
  readonly operationEpoch: number;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: string;
  readonly boundAt: string;
  readonly updatedAt: string;
  readonly status: SessionRegistryBindingStatusV1;
  readonly releasedAt: string | null;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- type alias keeps the implicit index signature required by SessionRegistryJsonCompatibilityV1
export type SessionRegistryEventV1 = {
  readonly schemaVersion: SessionRegistrySchemaVersion;
  readonly sessionId: string;
  readonly action: SessionRegistryActionV1;
  readonly sequence: number;
  readonly previousOperationEpoch: number | null;
  readonly requestHash: string;
  readonly at: string;
  readonly binding: SessionRegistryBindingV1;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- kept a type alias for consistency with the JSON-shaped registry records
export type SessionRegistryFoldStateV1 = {
  readonly schemaVersion: SessionRegistrySchemaVersion;
  readonly sessionId: string;
  readonly binding: SessionRegistryBindingV1 | null;
  readonly lastEvent: SessionRegistryEventV1 | null;
  readonly lastSequence: number;
  readonly eventCount: number;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- kept a type alias for consistency with the JSON-shaped registry records
export type SessionRegistryDecodedEventV1 = {
  readonly envelope: RuntimeStoreEvent;
  readonly event: SessionRegistryEventV1;
};

/** Stable Session Registry error codes shared by every host adapter. */
export type SessionRegistryErrorCode =
  | "session_registry_unknown_schema"
  | "session_registry_malformed_event"
  | "session_registry_out_of_order"
  | "session_registry_conflict"
  | "session_registry_identity_conflict"
  | "session_registry_semantic_conflict"
  | "session_registry_run_conflict"
  | "session_registry_owner_conflict"
  | "session_registry_epoch_conflict"
  | "session_registry_not_bound"
  | "session_registry_released"
  | "session_registry_lease_active"
  | "session_registry_lease_expired"
  | "session_registry_reconnect_required"
  | "session_registry_invalid_request";

export interface SessionRegistryErrorOptions {
  readonly sessionId?: string | null;
  readonly sequence?: number | null;
}

export class SessionRegistryError extends Error {
  readonly code: SessionRegistryErrorCode;
  readonly sessionId: string | null;
  readonly sequence: number | null;

  constructor(
    code: SessionRegistryErrorCode,
    message: string,
    options: SessionRegistryErrorOptions = {},
  ) {
    super(message);
    this.name = "SessionRegistryError";
    this.code = code;
    this.sessionId = options.sessionId ?? null;
    this.sequence = options.sequence ?? null;
    Object.setPrototypeOf(this, SessionRegistryError.prototype);
  }
}

function fail(
  code: SessionRegistryErrorCode,
  message: string,
  sessionId: string | null,
  sequence: number | null = null,
): never {
  throw new SessionRegistryError(code, message, { sessionId, sequence });
}

/** Validate a lowercase logical id without touching any host resource. */
export function assertSessionRegistryLogicalIdV1(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !PACTILE_LOGICAL_ID_PATTERN.test(value)) {
    fail(
      "session_registry_invalid_request",
      `${label} must be a non-empty lowercase logical id`,
      null,
    );
  }
  return value;
}

/** Validate a `sha256:<lowercase hex>` semantic fingerprint. */
export function assertSessionRegistryFingerprintV1(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !PACTILE_FINGERPRINT_PATTERN.test(value)) {
    fail(
      "session_registry_invalid_request",
      `${label} must be a sha256:<lowercase hex> fingerprint`,
      null,
    );
  }
  return value;
}

export function sessionRegistryPartitionV1(sessionId: string): string {
  return `${SESSION_REGISTRY_PARTITION_PREFIX_V1}${assertSessionRegistryLogicalIdV1(
    sessionId,
    "sessionId",
  )}`;
}

export function sessionRegistryEventTypeV1(
  action: SessionRegistryActionV1,
): string {
  return SESSION_REGISTRY_EVENT_TYPES_V1[action];
}

/** Stable request hash for one Session Registry operation. */
export function sessionRegistryRequestHashV1(
  operation: string,
  payload: unknown,
): string {
  assertSessionRegistryLogicalIdV1(operation, "operation");
  return fingerprintPactileContractV1({
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    domain: "session-registry-request-v1",
    operation,
    payload: JSON.parse(canonicalizePactileJsonV1(payload)),
  });
}

/** Stable idempotency key derived from the session, action and request hash. */
export function sessionRegistryIdempotencyKeyV1(
  sessionId: string,
  operation: string,
  requestHash: string,
): string {
  assertSessionRegistryLogicalIdV1(sessionId, "sessionId");
  assertSessionRegistryLogicalIdV1(operation, "operation");
  assertSessionRegistryFingerprintV1(requestHash, "requestHash");
  return `session_registry_v1:${sessionId}:${operation}:${requestHash}`;
}

function decodeSessionRegistryBindingV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): SessionRegistryBindingV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "sessionId",
    "taskId",
    "workItemId",
    "blockId",
    "runId",
    "semanticFingerprint",
    "operationEpoch",
    "ownerId",
    "leaseId",
    "leaseEpoch",
    "leaseExpiresAt",
    "boundAt",
    "updatedAt",
    "status",
    "releasedAt",
  ]);
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    SESSION_REGISTRY_BINDING_STATUSES_V1,
    childPathV1(path, "status"),
  );
  const releasedAt = decodeNullableTimestampV1(
    decoder.required(record, "releasedAt", path),
    decoder,
    childPathV1(path, "releasedAt"),
  );
  if (status === "released" && releasedAt === null) {
    decoder.issue(
      "required",
      childPathV1(path, "releasedAt"),
      "is required for a released binding",
    );
  }
  if (status === "active" && releasedAt !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "releasedAt"),
      "is only valid for a released binding",
    );
  }
  const boundAt = decodeTimestampV1(
    decoder.required(record, "boundAt", path),
    decoder,
    childPathV1(path, "boundAt"),
  );
  const updatedAt = decodeTimestampV1(
    decoder.required(record, "updatedAt", path),
    decoder,
    childPathV1(path, "updatedAt"),
  );
  const leaseExpiresAt = decodeTimestampV1(
    decoder.required(record, "leaseExpiresAt", path),
    decoder,
    childPathV1(path, "leaseExpiresAt"),
  );
  if (
    Date.parse(leaseExpiresAt) < Date.parse(boundAt) ||
    Date.parse(updatedAt) < Date.parse(boundAt)
  ) {
    decoder.issue(
      "conflict",
      path,
      "leaseExpiresAt and updatedAt must not precede boundAt",
    );
  }
  if (releasedAt !== null && Date.parse(releasedAt) < Date.parse(boundAt)) {
    decoder.issue(
      "conflict",
      childPathV1(path, "releasedAt"),
      "must not precede boundAt",
    );
  }
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    sessionId: decodeLogicalIdV1(
      decoder.required(record, "sessionId", path),
      decoder,
      childPathV1(path, "sessionId"),
    ),
    taskId: decodeLogicalIdV1(
      decoder.required(record, "taskId", path),
      decoder,
      childPathV1(path, "taskId"),
    ),
    workItemId: decodeLogicalIdV1(
      decoder.required(record, "workItemId", path),
      decoder,
      childPathV1(path, "workItemId"),
    ),
    blockId: decodeLogicalIdV1(
      decoder.required(record, "blockId", path),
      decoder,
      childPathV1(path, "blockId"),
    ),
    runId: decodeLogicalIdV1(
      decoder.required(record, "runId", path),
      decoder,
      childPathV1(path, "runId"),
    ),
    semanticFingerprint: decodeFingerprintV1(
      decoder.required(record, "semanticFingerprint", path),
      decoder,
      childPathV1(path, "semanticFingerprint"),
    ),
    operationEpoch: decoder.integer(
      decoder.required(record, "operationEpoch", path),
      childPathV1(path, "operationEpoch"),
      { min: 1 },
    ),
    ownerId: decodeLogicalIdV1(
      decoder.required(record, "ownerId", path),
      decoder,
      childPathV1(path, "ownerId"),
    ),
    leaseId: decodeLogicalIdV1(
      decoder.required(record, "leaseId", path),
      decoder,
      childPathV1(path, "leaseId"),
    ),
    leaseEpoch: decoder.integer(
      decoder.required(record, "leaseEpoch", path),
      childPathV1(path, "leaseEpoch"),
      { min: 1 },
    ),
    leaseExpiresAt,
    boundAt,
    updatedAt,
    status,
    releasedAt,
  };
}

function decodeSessionRegistryEventV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): SessionRegistryEventV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "sessionId",
    "action",
    "sequence",
    "previousOperationEpoch",
    "requestHash",
    "at",
    "binding",
  ]);
  const sessionId = decodeLogicalIdV1(
    decoder.required(record, "sessionId", path),
    decoder,
    childPathV1(path, "sessionId"),
  );
  const action = decoder.enumValue(
    decoder.required(record, "action", path),
    SESSION_REGISTRY_ACTIONS_V1,
    childPathV1(path, "action"),
  );
  const previousValue = decoder.required(record, "previousOperationEpoch", path);
  const previousOperationEpoch =
    previousValue === null
      ? null
      : decoder.integer(previousValue, childPathV1(path, "previousOperationEpoch"), {
          min: 1,
        });
  const at = decodeTimestampV1(
    decoder.required(record, "at", path),
    decoder,
    childPathV1(path, "at"),
  );
  const binding = decodeSessionRegistryBindingV1(
    decoder.required(record, "binding", path),
    decoder,
    childPathV1(path, "binding"),
  );
  if (binding.sessionId !== sessionId) {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.sessionId"),
      "must match the event sessionId",
    );
  }
  if (binding.updatedAt !== at) {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.updatedAt"),
      "must equal the event instant",
    );
  }
  if (action !== "released" && Date.parse(binding.leaseExpiresAt) <= Date.parse(at)) {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.leaseExpiresAt"),
      "must not be expired at the event instant; an expired lease cannot record a live session event",
    );
  }
  if (action !== "bound" && previousOperationEpoch === null) {
    decoder.issue(
      "required",
      childPathV1(path, "previousOperationEpoch"),
      "is required for heartbeat, reconnected, and released events",
    );
  }
  if (action === "bound" && previousOperationEpoch === null && binding.boundAt !== at) {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.boundAt"),
      "a binding event records the binding instant",
    );
  }
  if (action === "released" && binding.status !== "released") {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.status"),
      "a released event must carry a released binding",
    );
  }
  if (action !== "released" && binding.status !== "active") {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.status"),
      "only a released event may carry a released binding",
    );
  }
  if (action === "bound" && binding.releasedAt !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "binding.releasedAt"),
      "a bound binding cannot be released",
    );
  }
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    sessionId,
    action,
    sequence: decoder.integer(
      decoder.required(record, "sequence", path),
      childPathV1(path, "sequence"),
      { min: 1 },
    ),
    previousOperationEpoch,
    requestHash: decodeFingerprintV1(
      decoder.required(record, "requestHash", path),
      decoder,
      childPathV1(path, "requestHash"),
    ),
    at,
    binding,
  };
}

export const sessionRegistryBindingV1Schema = definePactileContractSchemaV1(
  "SessionRegistryBindingV1",
  decodeSessionRegistryBindingV1,
);

export const sessionRegistryEventV1Schema = definePactileContractSchemaV1(
  "SessionRegistryEventV1",
  decodeSessionRegistryEventV1,
);

export function parseSessionRegistryBindingV1(
  input: unknown,
): PactileContractParseResultV1<SessionRegistryBindingV1> {
  return sessionRegistryBindingV1Schema.parse(input);
}

export function parseSessionRegistryEventV1(
  input: unknown,
): PactileContractParseResultV1<SessionRegistryEventV1> {
  return sessionRegistryEventV1Schema.parse(input);
}

function parseSessionRegistryEventOrThrow(value: unknown): SessionRegistryEventV1 {
  if (isPlainRecordV1(value) && value.schemaVersion !== SESSION_REGISTRY_SCHEMA_VERSION) {
    fail(
      "session_registry_unknown_schema",
      `session registry events must use schemaVersion ${SESSION_REGISTRY_SCHEMA_VERSION}`,
      typeof value.sessionId === "string" ? value.sessionId : null,
    );
  }
  const parsed = sessionRegistryEventV1Schema.parse(value);
  if (!parsed.success) {
    const first = parsed.issues[0];
    fail(
      "session_registry_malformed_event",
      first === undefined
        ? "session registry event is malformed"
        : `session registry event is malformed at ${first.path}: ${first.message}`,
      null,
    );
  }
  return parsed.data;
}

function assertSameIdentity(
  sessionId: string,
  previous: SessionRegistryBindingV1,
  next: SessionRegistryBindingV1,
  sequence: number,
): void {
  if (next.runId !== previous.runId) {
    fail(
      "session_registry_run_conflict",
      "session binding runId cannot change for a live session",
      sessionId,
      sequence,
    );
  }
  if (next.semanticFingerprint !== previous.semanticFingerprint) {
    fail(
      "session_registry_semantic_conflict",
      "session binding semanticFingerprint cannot change for a live session",
      sessionId,
      sequence,
    );
  }
  if (
    next.taskId !== previous.taskId ||
    next.workItemId !== previous.workItemId ||
    next.blockId !== previous.blockId
  ) {
    fail(
      "session_registry_identity_conflict",
      "session binding task, work item, and block cannot change for a live session",
      sessionId,
      sequence,
    );
  }
}

function applySessionRegistryEventV1(
  sessionId: string,
  previous: SessionRegistryBindingV1 | null,
  event: SessionRegistryEventV1,
): SessionRegistryBindingV1 {
  const { binding, action, sequence } = event;
  if (previous === null) {
    if (action !== "bound") {
      fail(
        "session_registry_not_bound",
        "the first recorded session event must bind the session",
        sessionId,
        sequence,
      );
    }
    if (binding.operationEpoch !== 1) {
      fail(
        "session_registry_epoch_conflict",
        "an initial binding must start at operationEpoch 1",
        sessionId,
        sequence,
      );
    }
    return binding;
  }
  assertSameIdentity(sessionId, previous, binding, sequence);
  if (event.previousOperationEpoch !== previous.operationEpoch) {
    fail(
      "session_registry_epoch_conflict",
      "event previousOperationEpoch must match the folded operationEpoch",
      sessionId,
      sequence,
    );
  }
  switch (action) {
    case "bound": {
      if (previous.status !== "released") {
        fail(
          "session_registry_conflict",
          "a bound event requires an unbound or released session",
          sessionId,
          sequence,
        );
      }
      if (binding.operationEpoch !== previous.operationEpoch + 1) {
        fail(
          "session_registry_epoch_conflict",
          "a rebind must advance operationEpoch by exactly one",
          sessionId,
          sequence,
        );
      }
      if (binding.leaseEpoch <= previous.leaseEpoch) {
        fail(
          "session_registry_epoch_conflict",
          "a rebind must acquire a lease epoch newer than the released lease",
          sessionId,
          sequence,
        );
      }
      if (binding.boundAt !== previous.boundAt) {
        fail(
          "session_registry_conflict",
          "a rebind cannot move the original binding instant",
          sessionId,
          sequence,
        );
      }
      return binding;
    }
    case "heartbeat": {
      if (previous.status !== "active") {
        fail("session_registry_released", "a released session cannot heartbeat", sessionId, sequence);
      }
      if (binding.ownerId !== previous.ownerId) {
        fail(
          "session_registry_owner_conflict",
          "only the current owner may heartbeat",
          sessionId,
          sequence,
        );
      }
      if (binding.leaseEpoch <= previous.leaseEpoch) {
        fail(
          "session_registry_epoch_conflict",
          "a heartbeat must renew the lease with a newer lease epoch",
          sessionId,
          sequence,
        );
      }
      if (binding.operationEpoch !== previous.operationEpoch + 1) {
        fail(
          "session_registry_epoch_conflict",
          "a heartbeat must advance operationEpoch by exactly one",
          sessionId,
          sequence,
        );
      }
      if (binding.boundAt !== previous.boundAt) {
        fail(
          "session_registry_conflict",
          "a heartbeat cannot move the binding instant",
          sessionId,
          sequence,
        );
      }
      return binding;
    }
    case "reconnected": {
      if (previous.status !== "active") {
        fail(
          "session_registry_released",
          "a released session cannot reconnect",
          sessionId,
          sequence,
        );
      }
      if (binding.operationEpoch !== previous.operationEpoch + 1) {
        fail(
          "session_registry_epoch_conflict",
          "a reconnect must advance operationEpoch by exactly one",
          sessionId,
          sequence,
        );
      }
      if (binding.leaseEpoch <= previous.leaseEpoch) {
        fail(
          "session_registry_epoch_conflict",
          "a reconnect must acquire a lease epoch newer than the expired lease",
          sessionId,
          sequence,
        );
      }
      if (binding.boundAt !== previous.boundAt) {
        fail(
          "session_registry_conflict",
          "a reconnect cannot move the binding instant",
          sessionId,
          sequence,
        );
      }
      return binding;
    }
    case "released": {
      if (binding.ownerId !== previous.ownerId) {
        fail(
          "session_registry_owner_conflict",
          "only the current owner may release a session",
          sessionId,
          sequence,
        );
      }
      if (
        binding.leaseId !== previous.leaseId ||
        binding.leaseEpoch !== previous.leaseEpoch
      ) {
        fail(
          "session_registry_epoch_conflict",
          "a release must name the lease that was held",
          sessionId,
          sequence,
        );
      }
      if (binding.operationEpoch !== previous.operationEpoch) {
        fail(
          "session_registry_epoch_conflict",
          "a release does not advance the operation epoch",
          sessionId,
          sequence,
        );
      }
      if (binding.boundAt !== previous.boundAt) {
        fail(
          "session_registry_conflict",
          "a release cannot move the binding instant",
          sessionId,
          sequence,
        );
      }
      return binding;
    }
    default: {
      return fail(
        "session_registry_malformed_event",
        "unknown session registry action",
        sessionId,
        sequence,
      );
    }
  }
}

/** Fold a validated, ordered payload list into the current session binding. */
export function foldSessionRegistryEventsV1(
  sessionId: string,
  events: readonly SessionRegistryEventV1[],
): SessionRegistryFoldStateV1 {
  const scope = assertSessionRegistryLogicalIdV1(sessionId, "sessionId");
  let binding: SessionRegistryBindingV1 | null = null;
  let lastEvent: SessionRegistryEventV1 | null = null;
  let lastSequence = 0;
  for (const candidate of events) {
    const event = parseSessionRegistryEventOrThrow(candidate);
    if (event.sessionId !== scope) {
      fail(
        "session_registry_malformed_event",
        "session registry event belongs to another session",
        scope,
        event.sequence,
      );
    }
    if (event.sequence !== lastSequence + 1) {
      fail(
        "session_registry_out_of_order",
        "session registry events must be contiguous and append-only",
        scope,
        event.sequence,
      );
    }
    binding = applySessionRegistryEventV1(scope, binding, event);
    lastEvent = event;
    lastSequence = event.sequence;
  }
  return {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    sessionId: scope,
    binding,
    lastEvent,
    lastSequence,
    eventCount: lastSequence,
  };
}

/**
 * Decode RuntimeStore events from one session partition. Envelope and payload
 * must agree; any foreign, unknown, or malformed record fails closed.
 */
export function decodeSessionRegistryRuntimeEventsV1(
  sessionId: string,
  events: readonly RuntimeStoreEvent[],
): readonly SessionRegistryDecodedEventV1[] {
  const scope = assertSessionRegistryLogicalIdV1(sessionId, "sessionId");
  const partition = sessionRegistryPartitionV1(scope);
  return events.map((envelope) => {
    if (envelope.schemaVersion !== SESSION_REGISTRY_SCHEMA_VERSION) {
      fail(
        "session_registry_unknown_schema",
        `runtime events must use schemaVersion ${SESSION_REGISTRY_SCHEMA_VERSION}`,
        scope,
      );
    }
    const event = parseSessionRegistryEventOrThrow(envelope.payload);
    if (event.sessionId !== scope) {
      fail(
        "session_registry_malformed_event",
        "session registry event belongs to another session",
        scope,
        event.sequence,
      );
    }
    if (envelope.partition !== partition) {
      fail(
        "session_registry_malformed_event",
        "session registry event is stored in a foreign partition",
        scope,
        event.sequence,
      );
    }
    if (envelope.sequence !== event.sequence) {
      fail(
        "session_registry_malformed_event",
        "runtime sequence and payload sequence disagree",
        scope,
        event.sequence,
      );
    }
    if (envelope.requestHash !== event.requestHash) {
      fail(
        "session_registry_malformed_event",
        "runtime request hash and payload request hash disagree",
        scope,
        event.sequence,
      );
    }
    if (envelope.runId !== event.binding.runId) {
      fail(
        "session_registry_malformed_event",
        "runtime runId and payload runId disagree",
        scope,
        event.sequence,
      );
    }
    if (envelope.type !== sessionRegistryEventTypeV1(event.action)) {
      fail(
        "session_registry_malformed_event",
        "runtime type is not the Session Registry type for this action",
        scope,
        event.sequence,
      );
    }
    return { envelope, event };
  });
}

export function foldSessionRegistryRuntimeEventsV1(
  sessionId: string,
  events: readonly RuntimeStoreEvent[],
): SessionRegistryFoldStateV1 {
  return foldSessionRegistryEventsV1(
    sessionId,
    decodeSessionRegistryRuntimeEventsV1(sessionId, events).map(
      (entry) => entry.event,
    ),
  );
}

/** Deterministic recovery classification; no host I/O and no replay. */
export function classifySessionRegistryRecoveryV1(
  binding: SessionRegistryBindingV1 | null,
  now: string,
): SessionRegistryRecoveryClassificationV1 {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    fail(
      "session_registry_invalid_request",
      "now must be an RFC 3339 timestamp",
      binding?.sessionId ?? null,
    );
  }
  if (binding === null) return "unbound";
  const parsed = sessionRegistryBindingV1Schema.parse(binding);
  if (!parsed.success) {
    fail(
      "session_registry_malformed_event",
      "session binding is malformed and cannot be classified",
      binding.sessionId,
    );
  }
  if (parsed.data.status === "released") return "released";
  return Date.parse(parsed.data.leaseExpiresAt) > nowMs ? "active" : "expired";
}

/** Compile-time guard: bindings must remain JSON-shaped RuntimeStore payloads. */
export type SessionRegistryJsonCompatibilityV1 =
  SessionRegistryEventV1 extends RuntimeStoreJsonValue ? true : never;
