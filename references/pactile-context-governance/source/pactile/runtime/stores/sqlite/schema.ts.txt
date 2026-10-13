import {
  RuntimeStoreUnsupportedError,
} from "../../store-port.js";
import {
  RUNTIME_STORE_SQLITE_SCHEMA_VERSION,
  SqliteRuntimeStoreError,
  type SqliteDatabaseDriver,
  type SqliteMigration,
} from "./types.js";
import { firstIntegerOf } from "./codec.js";

function highestMigrationVersion(): number {
  const highest = RUNTIME_STORE_SQLITE_MIGRATIONS.reduce((value, migration) => Math.max(value, migration.version), 0);
  if (highest !== RUNTIME_STORE_SQLITE_SCHEMA_VERSION) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `migration chain defines schema version ${highest} but the adapter declares ${RUNTIME_STORE_SQLITE_SCHEMA_VERSION}`,
      "open",
    );
  }
  return highest;
}


export const RUNTIME_STORE_SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "runtime-store-initial",
    statements: [
      `CREATE TABLE IF NOT EXISTS runtime_store_meta (
         key TEXT PRIMARY KEY NOT NULL,
         value TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_migrations (
         version INTEGER PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_partitions (
         partition TEXT PRIMARY KEY NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_runs (
         run_id TEXT PRIMARY KEY NOT NULL,
         status TEXT NOT NULL,
         revision INTEGER NOT NULL,
         payload TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_effects (
         effect_id TEXT PRIMARY KEY NOT NULL,
         run_id TEXT NOT NULL,
         status TEXT NOT NULL,
         assurance TEXT NOT NULL,
         payload TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_events (
         partition TEXT NOT NULL REFERENCES runtime_store_partitions(partition) ON DELETE CASCADE,
         sequence INTEGER NOT NULL,
         event_id TEXT NOT NULL,
         run_id TEXT NOT NULL,
         type TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (partition, sequence),
         UNIQUE (partition, event_id)
       )`,
      `CREATE INDEX IF NOT EXISTS runtime_store_events_run
         ON runtime_store_events(run_id, partition, sequence)`,
      `CREATE TABLE IF NOT EXISTS runtime_store_leases (
         partition TEXT PRIMARY KEY NOT NULL REFERENCES runtime_store_partitions(partition) ON DELETE CASCADE,
         lease_id TEXT NOT NULL,
         run_id TEXT NOT NULL,
         owner_id TEXT NOT NULL,
         epoch INTEGER NOT NULL,
         acquired_at TEXT NOT NULL,
         expires_at TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         payload TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS runtime_store_leases_id
         ON runtime_store_leases(lease_id)`,
      `CREATE TABLE IF NOT EXISTS runtime_store_lease_epochs (
         partition TEXT PRIMARY KEY NOT NULL,
         epoch INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS runtime_store_effects_recovery
         ON runtime_store_effects(status, run_id)`,
      `CREATE TABLE IF NOT EXISTS runtime_store_mutations (
         idempotency_key TEXT PRIMARY KEY NOT NULL,
         operation TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         response TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    ],
  },
  {
    version: 2,
    name: "runtime-store-context-memory",
    statements: [
      `CREATE TABLE IF NOT EXISTS runtime_store_memory_receipts (
         scope TEXT NOT NULL,
         scope_key TEXT NOT NULL,
         receipt_id TEXT NOT NULL,
         request_id TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         receipt_hash TEXT NOT NULL,
         committed_at TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (scope, scope_key, receipt_id),
         UNIQUE (scope, scope_key, request_id)
       )`,
      `CREATE INDEX IF NOT EXISTS runtime_store_memory_receipts_basis
         ON runtime_store_memory_receipts(scope, scope_key, request_id)`,
      `CREATE TABLE IF NOT EXISTS runtime_store_memory_manifests (
         scope TEXT NOT NULL,
         scope_key TEXT NOT NULL,
         revision INTEGER NOT NULL,
         manifest_hash TEXT NOT NULL,
         committed_at TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (scope, scope_key)
       )`,
      `CREATE TABLE IF NOT EXISTS runtime_store_memory_audits (
         scope TEXT NOT NULL,
         scope_key TEXT NOT NULL,
         kind TEXT NOT NULL,
         receipt_id TEXT NOT NULL,
         request_id TEXT NOT NULL,
         request_hash TEXT NOT NULL,
         receipt_hash TEXT NOT NULL,
         recorded_at TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (scope, scope_key, kind, receipt_id),
         UNIQUE (scope, scope_key, kind, request_id)
       )`,
    ],
  },
];

export function initializeSchema(
  database: SqliteDatabaseDriver,
  operation: string,
): number {
  const target = highestMigrationVersion();
  database.exec("BEGIN IMMEDIATE");
  try {
    const userVersion = firstIntegerOf(
      database.prepare("PRAGMA user_version").get(),
      "user_version",
      operation,
    );
    if (userVersion > target) {
      throw new RuntimeStoreUnsupportedError(
        `runtime store schema version ${userVersion} is newer than the supported version ${target}`,
        operation,
        "runtime_store_schema",
      );
    }
    const appliedAt = new Date().toISOString();
    for (const migration of RUNTIME_STORE_SQLITE_MIGRATIONS) {
      if (migration.version <= userVersion) continue;
      if (!Number.isSafeInteger(migration.version) || migration.version < 0) {
        throw new SqliteRuntimeStoreError(
          "runtime_store_invalid_record",
          "migration version must be a non-negative safe integer",
          operation,
        );
      }
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database
        .prepare(
          "INSERT OR REPLACE INTO runtime_store_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, appliedAt);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database
      .prepare(
        "INSERT OR REPLACE INTO runtime_store_meta(key, value) VALUES (?, ?)",
      )
      .run("schema_version", String(target));
    database.exec("COMMIT");
    return target;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the original failure is the reportable one */
    }
    if (
      error instanceof RuntimeStoreUnsupportedError ||
      error instanceof SqliteRuntimeStoreError
    ) {
      throw error;
    }
    throw new RuntimeStoreUnsupportedError(
      "runtime store schema initialization failed",
      operation,
      "runtime_store_schema",
    );
  }
}

