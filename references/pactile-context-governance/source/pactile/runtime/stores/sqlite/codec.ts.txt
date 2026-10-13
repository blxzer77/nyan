import { canonicalizePactileJsonV1 } from "../../../shared/validation.js";
import {
  RUNTIME_STORE_SCHEMA_VERSION,
  type RuntimeStoreEffectReceipt,
  type RuntimeStoreEvent,
  type RuntimeStoreLease,
  type RuntimeStoreRun,
} from "../../store-port.js";
import { SqliteRuntimeStoreError } from "./types.js";

/** Field names that would copy Pi conversation content into the runtime store. */
const RUNTIME_STORE_FORBIDDEN_KEYS = new Set([
  "transcript",
  "transcripts",
  "prompt",
  "prompts",
  "prompttext",
  "messages",
  "conversation",
  "completion",
]);

const RUNTIME_STORE_MAX_JSON_DEPTH = 64;

export function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasRow(row: unknown): boolean {
  return row !== undefined && row !== null;
}

function errorProperty(error: unknown, key: string): unknown {
  return isRow(error) ? error[key] : undefined;
}

/** SQLite primary result code, tolerant of missing or extended errcode values. */
function sqlitePrimaryCode(error: unknown): number | null {
  const errcode = errorProperty(error, "errcode");
  if (typeof errcode === "number" && Number.isInteger(errcode)) {
    return ((errcode % 256) + 256) % 256;
  }
  return null;
}

export function isBusyError(error: unknown): boolean {
  const primary = sqlitePrimaryCode(error);
  if (primary !== null && (primary === 5 || primary === 6)) return true;
  const code = errorProperty(error, "code");
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code === "ERR_SQLITE_BUSY"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/i.test(message);
}

export function isConstraintError(error: unknown): boolean {
  const primary = sqlitePrimaryCode(error);
  if (primary !== null && primary === 19) return true;
  const message = error instanceof Error ? error.message : "";
  return /constraint failed|UNIQUE constraint|PRIMARY KEY constraint|FOREIGN KEY constraint|NOT NULL constraint/i.test(
    message,
  );
}

function assertPiFreeRecord(
  value: unknown,
  operation: string,
  depth: number,
): void {
  if (depth > RUNTIME_STORE_MAX_JSON_DEPTH) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "record nesting exceeds the supported depth",
      operation,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value)
      assertPiFreeRecord(item, operation, depth + 1);
    return;
  }
  if (!isRow(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (RUNTIME_STORE_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new SqliteRuntimeStoreError(
        "runtime_store_privacy_violation",
        `field '${key}' looks like Pi conversation content; the runtime store persists structured facts and opaque references only`,
        operation,
      );
    }
    assertPiFreeRecord(child, operation, depth + 1);
  }
}

/** Canonical JSON encoding of one structured record, privacy-screened. */
export function encodeRecord(record: unknown, operation: string): string {
  assertPiFreeRecord(record, operation, 0);
  try {
    return canonicalizePactileJsonV1(record);
  } catch {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "record must contain only finite JSON values",
      operation,
    );
  }
}

export function decodeJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "stored record is not parseable JSON",
      operation,
    );
  }
}

export function requireText(
  value: unknown,
  label: string,
  operation: string,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new SqliteRuntimeStoreError(
    "runtime_store_invalid_record",
    `expected a non-empty string for ${label}`,
    operation,
  );
}

export function requireInteger(
  value: unknown,
  label: string,
  operation: string,
): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new SqliteRuntimeStoreError(
    "runtime_store_invalid_record",
    `expected a safe integer for ${label}`,
    operation,
  );
}

export function columnText(
  row: unknown,
  column: string,
  operation: string,
): string {
  return requireText(isRow(row) ? row[column] : undefined, column, operation);
}

export function columnInteger(
  row: unknown,
  column: string,
  operation: string,
): number {
  return requireInteger(isRow(row) ? row[column] : undefined, column, operation);
}

/** Read a `PRAGMA` result without depending on a specific column name. */
function firstValueOf(row: unknown): unknown {
  if (!isRow(row)) return undefined;
  for (const key of Object.keys(row)) return row[key];
  return undefined;
}

export function firstTextOf(row: unknown, label: string, operation: string): string {
  return requireText(firstValueOf(row), label, operation);
}

export function firstIntegerOf(
  row: unknown,
  label: string,
  operation: string,
): number {
  return requireInteger(firstValueOf(row), label, operation);
}

export function firstFlagOf(row: unknown): boolean {
  const value = firstValueOf(row);
  return value === 1 || value === 1n || value === true;
}

export function resultRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

export function assertRunRecord(
  value: unknown,
  operation: string,
): RuntimeStoreRun {
  if (!isRow(value)) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "run record must be an object",
      operation,
    );
  }
  if (value.schemaVersion !== RUNTIME_STORE_SCHEMA_VERSION) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `run record must use schemaVersion ${RUNTIME_STORE_SCHEMA_VERSION}`,
      operation,
    );
  }
  requireText(value.runId, "run.runId", operation);
  requireInteger(value.revision, "run.revision", operation);
  requireText(value.createdAt, "run.createdAt", operation);
  requireText(value.updatedAt, "run.updatedAt", operation);
  return value as unknown as RuntimeStoreRun;
}

export function assertEffectRecord(
  value: unknown,
  operation: string,
): RuntimeStoreEffectReceipt {
  if (!isRow(value)) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "effect receipt must be an object",
      operation,
    );
  }
  if (value.schemaVersion !== RUNTIME_STORE_SCHEMA_VERSION) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `effect receipt must use schemaVersion ${RUNTIME_STORE_SCHEMA_VERSION}`,
      operation,
    );
  }
  requireText(value.effectId, "receipt.effectId", operation);
  requireText(value.runId, "receipt.runId", operation);
  requireText(value.requestHash, "receipt.requestHash", operation);
  requireText(value.recordedAt, "receipt.recordedAt", operation);
  return value as unknown as RuntimeStoreEffectReceipt;
}

export function assertEventRecord(
  value: unknown,
  operation: string,
): RuntimeStoreEvent {
  if (!isRow(value)) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "event record must be an object",
      operation,
    );
  }
  if (value.schemaVersion !== RUNTIME_STORE_SCHEMA_VERSION) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `event record must use schemaVersion ${RUNTIME_STORE_SCHEMA_VERSION}`,
      operation,
    );
  }
  requireText(value.eventId, "event.eventId", operation);
  requireText(value.partition, "event.partition", operation);
  requireInteger(value.sequence, "event.sequence", operation);
  requireText(value.createdAt, "event.createdAt", operation);
  return value as unknown as RuntimeStoreEvent;
}

export function assertLeaseRecord(
  value: unknown,
  operation: string,
): RuntimeStoreLease {
  if (!isRow(value)) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "lease record must be an object",
      operation,
    );
  }
  if (value.schemaVersion !== RUNTIME_STORE_SCHEMA_VERSION) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `lease record must use schemaVersion ${RUNTIME_STORE_SCHEMA_VERSION}`,
      operation,
    );
  }
  requireText(value.leaseId, "lease.leaseId", operation);
  requireText(value.partition, "lease.partition", operation);
  requireInteger(value.epoch, "lease.epoch", operation);
  return value as unknown as RuntimeStoreLease;
}

