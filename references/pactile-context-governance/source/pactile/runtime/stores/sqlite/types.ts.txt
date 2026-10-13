import type { RuntimeFileSystem } from "../../paths.js";
export const RUNTIME_STORE_SQLITE_SCHEMA_VERSION = 2 as const;

/** File name used below the canonical `<root>/.pactile/runtime` directory. */
export const RUNTIME_STORE_SQLITE_FILE_NAME = "runtime-store.sqlite";

/** Default busy timeout; SQLite waits this long before reporting a lock. */
export const RUNTIME_STORE_SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** Node API surface required from the guarded `node:sqlite` load. */
export type SqliteDriverFactory = () => unknown;

/** Stable adapter-local error codes (the core port keeps its own three). */
export type SqliteRuntimeStoreErrorCode =
  | "runtime_store_closed"
  | "runtime_store_invalid_path"
  | "runtime_store_invalid_record"
  | "runtime_store_privacy_violation";

/** Adapter-local failure that is not an idempotency/fencing outcome. */
export class SqliteRuntimeStoreError extends Error {
  readonly code: SqliteRuntimeStoreErrorCode;
  readonly operation: string | null;

  constructor(
    code: SqliteRuntimeStoreErrorCode,
    message: string,
    operation: string | null = null,
  ) {
    super(message);
    this.name = "SqliteRuntimeStoreError";
    this.code = code;
    this.operation = operation;
    Object.setPrototypeOf(this, SqliteRuntimeStoreError.prototype);
  }
}

/** Stable reason codes for the capability probe. */
export type SqliteRuntimeStoreUnsupportedReason =
  | "driver_unavailable"
  | "driver_api_incompatible"
  | "driver_smoke_failed"
  | "node_version_unsupported";

export interface SqliteRuntimeStoreCapability {
  readonly supported: boolean;
  readonly feature: "node:sqlite";
  readonly nodeVersion: string;
  readonly sqliteVersion: string | null;
  readonly reason: SqliteRuntimeStoreUnsupportedReason | null;
  readonly reasonDetail: string | null;
}

export interface SqliteRuntimeStoreDiagnostics {
  readonly databasePath: string;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly userVersion: number;
  readonly schemaVersion: number;
}

export interface SqliteRuntimeStoreOptions {
  readonly projectRoot: string;
  /** Override below the canonical root; rejected when it escapes `.pactile`. */
  readonly databasePath?: string;
  readonly busyTimeoutMs?: number;
  readonly io?: RuntimeFileSystem;
  readonly driver?: SqliteDriverFactory;
  readonly now?: () => Date;
}

export type SqliteBindValue = string | number | bigint | null;

export interface SqliteStatementDriver {
  run(...params: SqliteBindValue[]): unknown;
  get(...params: SqliteBindValue[]): unknown;
  all(...params: SqliteBindValue[]): unknown[];
}

export interface SqliteDatabaseDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementDriver;
  close(): void;
}

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

