import path from "node:path";
import { createRequire } from "node:module";
import {
  RuntimeStoreUnsupportedError,
} from "../../store-port.js";
import {
  assertCanonicalWriteTarget,
  resolveCanonicalPaths,
  type RuntimeFileSystem,
} from "../../paths.js";
import {
  RUNTIME_STORE_SQLITE_FILE_NAME,
  SqliteRuntimeStoreError,
  type SqliteDatabaseDriver,
  type SqliteDriverFactory,
  type SqliteRuntimeStoreCapability,
  type SqliteRuntimeStoreUnsupportedReason,
} from "./types.js";
import { firstTextOf, isRow } from "./codec.js";

export function resolveDatabasePath(
  projectRoot: string,
  requested: string | undefined,
): string {
  const canonicalRoot = resolveCanonicalPaths(projectRoot).canonicalRoot;
  if (requested === undefined) {
    return path.join(canonicalRoot, "runtime", RUNTIME_STORE_SQLITE_FILE_NAME);
  }
  // A scheme-like value is a URL, not a filesystem path; and on Windows an
  // unadorned `C:name` is drive-relative, not canonical-root-relative.
  if (/^[a-z][a-z0-9+.-]*:/i.test(requested)) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_path",
      "databasePath must be a filesystem path below the canonical root",
      "open",
    );
  }
  const absolute = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(projectRoot, requested.replace(/\\/g, "/"));
  const relative = path.relative(canonicalRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_path",
      "databasePath must resolve to a file inside the canonical root",
      "open",
    );
  }
  return absolute;
}

interface OpenedDriver {
  readonly database: SqliteDatabaseDriver;
  readonly sqliteVersion: string;
}

/** Load the driver namespace, mapping any load failure to a typed refusal. */
function loadDriverModule(factory: SqliteDriverFactory): unknown {
  try {
    return factory();
  } catch {
    throw new RuntimeStoreUnsupportedError(
      "node:sqlite is not available in this Node runtime",
      "open",
      "node:sqlite",
    );
  }
}

/** Construct a `DatabaseSync`, mapping API gaps and open failures to refusals. */
function constructDatabase(
  module: unknown,
  location: string,
): SqliteDatabaseDriver {
  const DatabaseSync = isRow(module) ? module.DatabaseSync : undefined;
  if (typeof DatabaseSync !== "function") {
    throw new RuntimeStoreUnsupportedError(
      "node:sqlite does not expose a usable DatabaseSync constructor",
      "open",
      "node:sqlite",
    );
  }
  try {
    const construct = DatabaseSync as new (
      location: string,
    ) => SqliteDatabaseDriver;
    return new construct(location);
  } catch {
    throw new RuntimeStoreUnsupportedError(
      "node:sqlite failed to open the runtime store database",
      "open",
      "node:sqlite",
    );
  }
}

export function openDriverDatabase(
  factory: SqliteDriverFactory,
  databasePath: string,
  busyTimeoutMs: number,
): OpenedDriver {
  const module = loadDriverModule(factory);
  const database = constructDatabase(module, databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const mode = firstTextOf(
      database.prepare("PRAGMA journal_mode = WAL").get(),
      "journal_mode",
      "open",
    ).toLowerCase();
    if (mode !== "wal") {
      throw new RuntimeStoreUnsupportedError(
        `SQLite refused WAL journaling (reported '${mode}')`,
        "open",
        "runtime_store_wal",
      );
    }
    const sqliteVersion = firstTextOf(
      database.prepare("SELECT sqlite_version() AS version").get(),
      "sqlite_version",
      "open",
    );
    return { database, sqliteVersion };
  } catch (error) {
    try {
      database.close();
    } catch {
      /* the original failure is the reportable one */
    }
    if (error instanceof RuntimeStoreUnsupportedError) throw error;
    throw new RuntimeStoreUnsupportedError(
      "node:sqlite failed its runtime smoke check",
      "open",
      "node:sqlite",
    );
  }
}

export function applyPragmas(database: SqliteDatabaseDriver, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA foreign_keys = ON");
}

function probeWithDriver(
  factory: SqliteDriverFactory,
  nodeVersion: string,
): SqliteRuntimeStoreCapability {
  const unsupported = (
    reason: SqliteRuntimeStoreUnsupportedReason,
    reasonDetail: string,
  ): SqliteRuntimeStoreCapability => ({
    supported: false,
    feature: "node:sqlite",
    nodeVersion,
    sqliteVersion: null,
    reason,
    reasonDetail,
  });
  const version = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(nodeVersion);
  const major = version === null ? -1 : Number(version[1]);
  const minor = version === null ? -1 : Number(version[2]);
  if (major < 22 || (major === 22 && minor < 13)) {
    return unsupported(
      "node_version_unsupported",
      `node:sqlite requires Node >=22.13 (received ${nodeVersion})`,
    );
  }
  let module: unknown;
  try {
    module = factory();
  } catch {
    return unsupported("driver_unavailable", "node:sqlite could not be loaded");
  }
  const DatabaseSync = isRow(module) ? module.DatabaseSync : undefined;
  if (typeof DatabaseSync !== "function") {
    return unsupported(
      "driver_api_incompatible",
      "node:sqlite does not expose DatabaseSync",
    );
  }
  let database: SqliteDatabaseDriver | null = null;
  try {
    const construct = DatabaseSync as new (
      location: string,
    ) => SqliteDatabaseDriver;
    database = new construct(":memory:");
    const version = firstTextOf(
      database.prepare("SELECT sqlite_version() AS version").get(),
      "sqlite_version",
      "probe",
    );
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
    return {
      supported: true,
      feature: "node:sqlite",
      nodeVersion,
      sqliteVersion: version,
      reason: null,
      reasonDetail: null,
    };
  } catch (error) {
    return unsupported(
      "driver_smoke_failed",
      error instanceof Error ? error.name : "driver smoke check failed",
    );
  } finally {
    if (database !== null) {
      try {
        database.close();
      } catch {
        /* a probe must never leak a driver handle */
      }
    }
  }
}

/** Guarded default loader; never a static import, so Node 18 still parses. */
export function loadNodeSqliteModule(): unknown {
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as unknown;
}

/** Read-only capability report; never throws for an unsupported runtime. */
export function probeSqliteRuntimeStoreCapability(
  options: {
    readonly driver?: SqliteDriverFactory;
    readonly nodeVersion?: string;
  } = {},
): SqliteRuntimeStoreCapability {
  const factory = options.driver ?? loadNodeSqliteModule;
  return probeWithDriver(factory, options.nodeVersion ?? process.version);
}

/** Typed refusal used whenever the host cannot provide durable SQLite facts. */
export function sqliteRuntimeStoreUnsupportedError(
  capability: SqliteRuntimeStoreCapability,
  operation: string,
): RuntimeStoreUnsupportedError {
  const detail = capability.reason ?? "driver_unavailable";
  return new RuntimeStoreUnsupportedError(
    `node:sqlite runtime store is unavailable (${detail}); no JSON or in-memory fallback is used`,
    operation,
    "node:sqlite",
  );
}

/** Replace a store whose only fault is an unusable driver. */
export function assertSqliteRuntimeStoreCapability(
  capability: SqliteRuntimeStoreCapability,
  operation: string,
): void {
  if (capability.supported) return;
  throw sqliteRuntimeStoreUnsupportedError(capability, operation);
}


export function prepareDirectory(
  projectRoot: string,
  directory: string,
  io: RuntimeFileSystem,
): void {
  assertCanonicalWriteTarget(projectRoot, directory, io);
  io.mkdirSync(directory, { recursive: true });
  assertCanonicalWriteTarget(projectRoot, directory, io);
}
