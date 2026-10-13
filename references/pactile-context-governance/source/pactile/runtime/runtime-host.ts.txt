import path from "node:path";

import { RuntimeStoreUnsupportedError } from "./store-port.js";
import {
  createContextMemoryDurabilityV1,
  type ContextMemoryDurabilityPort,
} from "../agent/memory/durability.js";
import { FileArtifactStore } from "./file-artifact-store.js";
import type { RunLedgerEnumerationPort, RunLedgerPort } from "./run-ledger.js";
import type { ProductKernelStorePort } from "../kernel/store/product/index.js";

import {
  RUNTIME_STORE_SQLITE_FILE_NAME,
  SqliteRuntimeStoreError,
  assertSqliteRuntimeStoreCapability,
  openSqliteRuntimeStore,
  probeSqliteRuntimeStoreCapability,
  type SqliteDriverFactory,
  type SqliteRuntimeStore,
  type SqliteRuntimeStoreCapability,
  type SqliteRuntimeStoreDiagnostics,
} from "./sqlite-runtime-store.js";
import {
  openSqliteProductKernelStore,
  type SqliteProductKernelStore,
  type SqliteProductKernelStoreDiagnostics,
} from "./sqlite-product-kernel-store.js";
import { resolveCanonicalPaths, type RuntimeFileSystem } from "./paths.js";

export interface PactileRuntimeHostOptions {
  /** Explicit repository/Git root. The host never derives this from CWD. */
  readonly repositoryRoot: string;
  readonly databasePath?: string;
  readonly busyTimeoutMs?: number;
  readonly io?: RuntimeFileSystem;
  readonly driver?: SqliteDriverFactory;
  readonly now?: () => Date;
}

export interface PactileRuntimeHost {
  readonly repositoryRoot: string;
  readonly databasePath: string;
  readonly capability: SqliteRuntimeStoreCapability;
  readonly diagnostics: SqliteRuntimeStoreDiagnostics;
  readonly store: SqliteRuntimeStore;
  /** Thin Host P1 ledger seam backed by the same SQLite connection. */
  readonly ledger: RunLedgerPort & RunLedgerEnumerationPort;
  /** Product Kernel facts, leases, observations and settlements. */
  readonly productKernel: ProductKernelStorePort;
  readonly productKernelDiagnostics: SqliteProductKernelStoreDiagnostics;
  /** Canonical immutable memory payloads below `<repositoryRoot>/.pactile/`. */
  readonly artifacts: FileArtifactStore;
  /** Host composition of the one RuntimeStore and the canonical ArtifactStore. */
  readonly memory: ContextMemoryDurabilityPort;
  close(): Promise<void>;
}

function explicitRepositoryRoot(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_path",
      "repositoryRoot must be an explicit non-empty filesystem path",
      "open-host",
    );
  }
  return path.resolve(value);
}

/**
 * Open the one durable runtime store owned by a CLI/Electron host.
 *
 * The bootstrap owns lifecycle only: the adapter owns schema, transactions,
 * idempotency and fencing. No fallback is permitted when SQLite is missing.
 */
export async function openPactileRuntimeHost(
  options: PactileRuntimeHostOptions,
): Promise<PactileRuntimeHost> {
  const repositoryRoot = explicitRepositoryRoot(options.repositoryRoot);
  const canonical = resolveCanonicalPaths(repositoryRoot);
  const capability = probeSqliteRuntimeStoreCapability(
    options.driver === undefined ? {} : { driver: options.driver },
  );
  assertSqliteRuntimeStoreCapability(capability, "open-host");

  let store: SqliteRuntimeStore | undefined;
  let productKernel: SqliteProductKernelStore | undefined;
  let closed = false;
  try {
    store = await openSqliteRuntimeStore({
      projectRoot: repositoryRoot,
      ...(options.databasePath === undefined
        ? {}
        : { databasePath: options.databasePath }),
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.driver === undefined ? {} : { driver: options.driver }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const diagnostics = await store.diagnostics();
    productKernel = await openSqliteProductKernelStore({
      projectRoot: repositoryRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.driver === undefined ? {} : { driver: options.driver }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const productKernelDiagnostics = await productKernel.diagnostics();
    const artifacts = new FileArtifactStore({
      projectRoot: repositoryRoot,
      ...(options.io === undefined ? {} : { io: options.io }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const memory = createContextMemoryDurabilityV1({
      artifacts,
      receipts: store,
      manifests: store,
      audits: store,
      leases: store,
      requireLease: true,
      requireCanonicalScopeKey: true,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      repositoryRoot,
      databasePath:
        diagnostics.databasePath ||
        path.join(
          canonical.canonicalRoot,
          "runtime",
          RUNTIME_STORE_SQLITE_FILE_NAME,
        ),
      capability,
      diagnostics,
      store,
      ledger: store,
      productKernel,
      productKernelDiagnostics,
      artifacts,
      memory,
      close: async () => {
        if (closed) return;
        closed = true;
        await productKernel?.close();
        await store?.close();
      },
    };
  } catch (error) {
    if (store !== undefined) {
      try {
        await store.close();
      } catch {
        // Preserve the original open/diagnostics error; cleanup is best effort.
      }
    }
    if (productKernel !== undefined) {
      try {
        await productKernel.close();
      } catch {
        // Preserve the original open/diagnostics error; cleanup is best effort.
      }
    }
    if (error instanceof RuntimeStoreUnsupportedError) throw error;
    throw error;
  }
}
