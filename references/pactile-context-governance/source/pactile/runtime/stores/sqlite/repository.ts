import fs from "node:fs";
import path from "node:path";
import {
  RUNTIME_STORE_SCHEMA_VERSION,
  RuntimeStoreConflictError,
  RuntimeStoreFencedError,
  RuntimeStoreUnsupportedError,
  type RuntimeStoreAcquireLeaseInput,
  type RuntimeStoreAcquireLeaseResult,
  type RuntimeStoreAppendEventInput,
  type RuntimeStoreAppendEventResult,
  type RuntimeStoreEffectReceipt,
  type RuntimeStoreEvent,
  type RuntimeStoreLease,
  type RuntimeStoreLeaseProof,
  type RuntimeStorePort,
  type RuntimeStorePutEffectInput,
  type RuntimeStorePutEffectResult,
  type RuntimeStorePutRunInput,
  type RuntimeStorePutRunResult,
  type RuntimeStoreReadEventsOptions,
  type RuntimeStoreReadEventsResult,
  type RuntimeStoreRecoveredEffect,
  type RuntimeStoreRecoverInput,
  type RuntimeStoreRecoverResult,
  type RuntimeStoreReleaseLeaseInput,
  type RuntimeStoreReleaseLeaseResult,
  type RuntimeStoreRun,
  type RuntimeStoreJsonValue,
} from "../../store-port.js";
import {
  memoryDurabilityFailureV1,
  memoryPartitionV1,
  decodeMemoryAuditReceiptV1,
  decodeMemoryCurrentManifestV1,
  decodeMemoryDurableReceiptV1,
  type MemoryDurabilityFailureCodeV1,
  type MemoryDurabilityFailureV1,
  type MemoryScopeV1,
} from "../../../agent/memory/index.js";
import { runtimeEventIdV1 } from "../../store-port.js";
import type {
  MemoryAuditAppendResultV1,
  MemoryAuditReceiptStorePort,
  MemoryAuditReceiptV1,
  MemoryLeasePort,
  MemoryLeaseProofV1,
  MemoryLeaseValidationResultV1,
  MemoryManifestCasResultV1,
  MemoryManifestLookupV1,
  MemoryManifestStorePort,
  MemoryReceiptListResultV1,
  MemoryReceiptLookupV1,
  MemoryReceiptPutResultV1,
  MemoryReceiptStorePort,
  MemoryReceiptSummaryV1,
} from "../../../agent/memory/durability.js";
import { fingerprintPactileContractV1 } from "../../../shared/validation.js";
import { assertCanonicalWriteTarget } from "../../paths.js";
import {
  RUNTIME_STORE_SQLITE_BUSY_TIMEOUT_MS,
  SqliteRuntimeStoreError,
  type SqliteRuntimeStoreDiagnostics,
  type SqliteRuntimeStoreOptions,
  type SqliteDatabaseDriver,
} from "./types.js";
import {
  assertEffectLedgerEntry,
  assertRunLedger,
  assertRunLedgerTransition,
  ledgerEntryFromRuntimeEffect,
  ledgerFromRuntimeRun,
  RUN_LEDGER_METADATA_KEY,
  runtimeEffectForLedgerEntry,
  runtimeRunForLedger,
  type EffectLedgerEntryV1,
  type RunLedgerCommitInput,
  type RunLedgerCommitResult,
  type RunLedgerEnumerationPort,
  type RunLedgerListEntryV1,
  type RunLedgerListInputV1,
  type RunLedgerListPageV1,
  type RunLedgerSnapshot,
} from "../../run-ledger.js";
import {
  assertSqliteRuntimeStoreCapability,
  applyPragmas,
  loadNodeSqliteModule,
  openDriverDatabase,
  prepareDirectory,
  resolveDatabasePath,
  probeSqliteRuntimeStoreCapability,
} from "./capability.js";
import { initializeSchema } from "./schema.js";
import {
  assertEffectRecord,
  assertEventRecord,
  assertLeaseRecord,
  assertRunRecord,
  columnInteger,
  columnText,
  decodeJson,
  encodeRecord,
  firstFlagOf,
  firstIntegerOf,
  firstTextOf,
  hasRow,
  isBusyError,
  isConstraintError,
  requireInteger,
  requireText,
  resultRows,
  isRow,
} from "./codec.js";

/**
 * The store refused the caller rather than failing: SQLITE_PERM (3),
 * SQLITE_READONLY (8) and SQLITE_AUTH (23), read from node:sqlite's `errcode`.
 * Only the plain result codes count; extended READONLY_* codes (recovery,
 * rollback, moved database) describe the environment, not a permission
 * decision, and stay generic store failures.
 */
function isStorePermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { readonly errcode?: unknown }).errcode;
  return errcode === 3 || errcode === 8 || errcode === 23;
}

function ledgerEffectIdentity(entry: EffectLedgerEntryV1): string {
  return JSON.stringify({
    schemaVersion: entry.schemaVersion,
    operationId: entry.operationId,
    runId: entry.runId,
    attemptId: entry.attemptId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    operationEpoch: entry.operationEpoch,
    inputHash: entry.inputHash,
  });
}

function canAdvanceLedgerEffect(
  prior: EffectLedgerEntryV1,
  next: EffectLedgerEntryV1,
): boolean {
  return (
    prior.status === "intent" &&
    next.status !== "intent" &&
    ledgerEffectIdentity(prior) === ledgerEffectIdentity(next)
  );
}

function canBindLedgerEffectPayload(
  prior: EffectLedgerEntryV1,
  next: EffectLedgerEntryV1,
): boolean {
  const priorPayload = [
    prior.payloadType,
    prior.payloadHash,
    prior.payloadArtifactRef,
  ];
  const nextPayload = [
    next.payloadType,
    next.payloadHash,
    next.payloadArtifactRef,
  ];
  return (
    prior.status !== "intent" &&
    prior.status === next.status &&
    ledgerEffectIdentity(prior) === ledgerEffectIdentity(next) &&
    priorPayload.every((value) => value === undefined || value === null) &&
    nextPayload.every((value) => typeof value === "string" && value.length > 0)
  );
}

/**
 * Open (and migrate) the SQLite runtime store for one canonical repository.
 * Throws `RuntimeStoreUnsupportedError` when the host cannot provide it.
 */
export async function openSqliteRuntimeStore(
  options: SqliteRuntimeStoreOptions,
): Promise<SqliteRuntimeStore> {
  const io = options.io ?? fs;
  const projectRoot = path.resolve(options.projectRoot);
  const databasePath = resolveDatabasePath(projectRoot, options.databasePath);
  const busyTimeoutMs =
    options.busyTimeoutMs ?? RUNTIME_STORE_SQLITE_BUSY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 2_147_483_647
  ) {
    throw new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      "busyTimeoutMs must be a non-negative safe integer",
      "open",
    );
  }
  const capability = probeSqliteRuntimeStoreCapability(
    options.driver === undefined ? {} : { driver: options.driver },
  );
  assertSqliteRuntimeStoreCapability(capability, "open");
  prepareDirectory(projectRoot, path.dirname(databasePath), io);
  const contained = assertCanonicalWriteTarget(projectRoot, databasePath, io);
  const factory = options.driver ?? loadNodeSqliteModule;
  const opened = openDriverDatabase(factory, contained, busyTimeoutMs);
  try {
    applyPragmas(opened.database, busyTimeoutMs);
    const schemaVersion = initializeSchema(opened.database, "open");
    return new SqliteRuntimeStore({
      projectRoot,
      databasePath: contained,
      database: opened.database,
      busyTimeoutMs,
      sqliteVersion: opened.sqliteVersion,
      schemaVersion,
      clock: options.now ?? (() => new Date()),
    });
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      /* the original failure is the reportable one */
    }
    throw error;
  }
}

interface ResolvedStoreOptions {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly database: SqliteDatabaseDriver;
  readonly busyTimeoutMs: number;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly clock: () => Date;
}

/** Durable, single-connection RuntimeStore port implementation. */
export class SqliteRuntimeStore
  implements
    RuntimeStorePort,
    MemoryReceiptStorePort,
    MemoryManifestStorePort,
    MemoryAuditReceiptStorePort,
    MemoryLeasePort,
    RunLedgerEnumerationPort
{
  readonly projectRoot: string;
  readonly databaseFilePath: string;
  readonly schemaVersion: number;
  private readonly database: SqliteDatabaseDriver;
  private readonly busyTimeoutMs: number;
  private readonly sqliteVersion: string;
  private readonly clock: () => Date;
  private closed = false;

  /**
   * Requires an already-probed driver; callers use
   * {@link openSqliteRuntimeStore} so containment and pragmas are applied.
   */
  constructor(options: ResolvedStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.databaseFilePath = options.databasePath;
    this.database = options.database;
    this.busyTimeoutMs = options.busyTimeoutMs;
    this.sqliteVersion = options.sqliteVersion;
    this.schemaVersion = options.schemaVersion;
    this.clock = options.clock;
  }

  /** Read-only schema and pragma snapshot used by diagnostics and evidence. */
  async diagnostics(): Promise<SqliteRuntimeStoreDiagnostics> {
    this.assertOpen("diagnostics");
    return {
      databasePath: this.databaseFilePath,
      nodeVersion: process.version,
      sqliteVersion: this.sqliteVersion,
      journalMode: firstTextOf(
        this.database.prepare("PRAGMA journal_mode").get(),
        "journal_mode",
        "diagnostics",
      ).toLowerCase(),
      foreignKeys: firstFlagOf(
        this.database.prepare("PRAGMA foreign_keys").get(),
      ),
      busyTimeoutMs: firstIntegerOf(
        this.database.prepare("PRAGMA busy_timeout").get(),
        "busy_timeout",
        "diagnostics",
      ),
      userVersion: firstIntegerOf(
        this.database.prepare("PRAGMA user_version").get(),
        "user_version",
        "diagnostics",
      ),
      schemaVersion: this.schemaVersion,
    };
  }

  /**
   * Commit one RunLedger snapshot and its effect entries in the same SQLite
   * mutation transaction. This is the first thin Host P1 seam; it reuses the
   * existing RuntimeStore tables while exposing operationId reconciliation.
   */
  async commitRunLedger(
    input: RunLedgerCommitInput,
  ): Promise<RunLedgerCommitResult> {
    return this.mutate(
      "commitRunLedger",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const ledger = assertRunLedger(input.ledger, "commitRunLedger.ledger");
        if (input.lease !== undefined) {
          this.assertLeaseProof(
            input.lease.partition,
            ledger.runId,
            input.lease,
            "commitRunLedger",
          );
        }
        const effects = input.effects.map((entry) =>
          assertEffectLedgerEntry(entry, "commitRunLedger.effect"),
        );
        for (const effect of effects) {
          if (effect.runId !== ledger.runId)
            throw new TypeError(
              "commitRunLedger effect runId must match ledger runId",
            );
          if (!ledger.effectOperationIds.includes(effect.operationId)) {
            throw new TypeError(
              "commitRunLedger ledger must list every effect operationId",
            );
          }
        }
        const replay = this.replayMutation<RunLedgerCommitResult>(
          "commitRunLedger",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return { ...replay.value, applied: false };

        const existingRow = this.database
          .prepare("SELECT payload FROM runtime_store_runs WHERE run_id = ?")
          .get(ledger.runId);
        const existingRun = hasRow(existingRow)
          ? assertRunRecord(
              decodeJson(
                columnText(existingRow, "payload", "commitRunLedger"),
                "commitRunLedger",
              ),
              "commitRunLedger",
            )
          : null;
        const existingLedger =
          existingRun === null ? null : ledgerFromRuntimeRun(existingRun);
        if (
          existingLedger !== null &&
          existingLedger.ledgerId !== ledger.ledgerId
        ) {
          throw new RuntimeStoreConflictError(
            "runId is already bound to another ledger",
            "commitRunLedger",
            input.idempotencyKey,
            input.requestHash,
          );
        }
        if (
          existingLedger !== null &&
          ledger.revision !== existingLedger.revision + 1
        ) {
          throw new RuntimeStoreFencedError(
            "run ledger revision must advance exactly one step",
            "run-ledger",
            existingLedger.revision + 1,
            ledger.revision,
            "event_sequence_mismatch",
          );
        }

        if (existingLedger !== null) {
          try {
            assertRunLedgerTransition(existingLedger, ledger, "commitRunLedger");
            // An intent only becomes bound if every effect payload it
            // planned is on the effect row after this commit.
            for (const intent of ledger.artifactIntents ?? []) {
              const was = (existingLedger.artifactIntents ?? []).find(
                (candidate) => candidate.intentId === intent.intentId,
              );
              if (intent.state !== "bound" || was?.state !== "pending") continue;
              for (const planned of intent.effectBindings) {
                let stored = effects.find(
                  (entry) => entry.operationId === planned.operationId,
                );
                if (stored === undefined) {
                  const row = this.database
                    .prepare(
                      "SELECT payload FROM runtime_store_effects WHERE effect_id = ?",
                    )
                    .get(planned.operationId);
                  stored = hasRow(row)
                    ? (ledgerEntryFromRuntimeEffect(
                        assertEffectRecord(
                          decodeJson(
                            columnText(row, "payload", "commitRunLedger"),
                            "commitRunLedger",
                          ),
                          "commitRunLedger",
                        ),
                      ) ?? undefined)
                    : undefined;
                }
                if (
                  stored?.payloadType !== planned.payloadType ||
                  stored.payloadHash !== planned.payloadHash ||
                  stored.payloadArtifactRef !== planned.payloadArtifactRef
                ) {
                  throw new TypeError(
                    `bound artifact intent ${intent.intentId} is missing the effect payload binding of ${planned.operationId}`,
                  );
                }
              }
            }
          } catch (error) {
            throw new RuntimeStoreConflictError(
              error instanceof Error
                ? error.message
                : "run ledger transition is not allowed",
              "commitRunLedger",
              input.idempotencyKey,
              input.requestHash,
            );
          }
        }

        const runtimeRun = runtimeRunForLedger(ledger, existingRun);
        const payload = encodeRecord(runtimeRun, "commitRunLedger");
        this.database
          .prepare(
            `INSERT INTO runtime_store_runs(run_id, status, revision, payload, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             status = excluded.status,
             revision = excluded.revision,
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
          )
          .run(
            runtimeRun.runId,
            runtimeRun.status,
            runtimeRun.revision,
            payload,
            runtimeRun.updatedAt,
          );

        for (const effect of effects) {
          const priorRow = this.database
            .prepare(
              "SELECT payload FROM runtime_store_effects WHERE effect_id = ?",
            )
            .get(effect.operationId);
          if (hasRow(priorRow)) {
            const prior = ledgerEntryFromRuntimeEffect(
              assertEffectRecord(
                decodeJson(
                  columnText(priorRow, "payload", "commitRunLedger"),
                  "commitRunLedger",
                ),
                "commitRunLedger",
              ),
            );
            if (
              prior === null ||
              (JSON.stringify(prior) !== JSON.stringify(effect) &&
                !canAdvanceLedgerEffect(prior, effect) &&
                !canBindLedgerEffectPayload(prior, effect))
            ) {
              throw new RuntimeStoreConflictError(
                "operationId is already bound to a different effect entry",
                "commitRunLedger",
                input.idempotencyKey,
                input.requestHash,
              );
            }
            if (
              prior !== null &&
              (canAdvanceLedgerEffect(prior, effect) ||
                canBindLedgerEffectPayload(prior, effect))
            ) {
              const receipt = runtimeEffectForLedgerEntry(effect);
              this.database
                .prepare(
                  `UPDATE runtime_store_effects
                   SET status = ?, assurance = ?, payload = ?
                   WHERE effect_id = ?`,
                )
                .run(
                  receipt.status,
                  receipt.assurance,
                  encodeRecord(receipt, "commitRunLedger"),
                  receipt.effectId,
                );
            }
            continue;
          }
          const receipt = runtimeEffectForLedgerEntry(effect);
          this.database
            .prepare(
              `INSERT INTO runtime_store_effects(effect_id, run_id, status, assurance, payload)
             VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              receipt.effectId,
              receipt.runId,
              receipt.status,
              receipt.assurance,
              encodeRecord(receipt, "commitRunLedger"),
            );
        }
        const result: RunLedgerCommitResult = {
          applied: true,
          ledger,
          effects,
        };
        return this.recordMutation(
          "commitRunLedger",
          input.idempotencyKey,
          input.requestHash,
          result,
        ).value;
      },
    );
  }

  async readRunLedger(runId: string): Promise<RunLedgerSnapshot | null> {
    this.assertOpen("readRunLedger");
    requireText(runId, "runId", "readRunLedger");
    const runRow = this.database
      .prepare("SELECT payload FROM runtime_store_runs WHERE run_id = ?")
      .get(runId);
    if (!hasRow(runRow)) return null;
    const run = assertRunRecord(
      decodeJson(
        columnText(runRow, "payload", "readRunLedger"),
        "readRunLedger",
      ),
      "readRunLedger",
    );
    const ledger = ledgerFromRuntimeRun(run);
    if (ledger === null) return null;
    const rows = this.database
      .prepare(
        "SELECT payload FROM runtime_store_effects WHERE run_id = ? ORDER BY effect_id ASC",
      )
      .all(runId);
    const effects: EffectLedgerEntryV1[] = [];
    const orphanOperationIds: string[] = [];
    for (const row of rows) {
      const entry = ledgerEntryFromRuntimeEffect(
        assertEffectRecord(
          decodeJson(
            columnText(row, "payload", "readRunLedger"),
            "readRunLedger",
          ),
          "readRunLedger",
        ),
      );
      if (entry === null) continue;
      effects.push(entry);
      if (!ledger.effectOperationIds.includes(entry.operationId))
        orphanOperationIds.push(entry.operationId);
    }
    const known = new Set(effects.map((entry) => entry.operationId));
    const missingOperationIds = ledger.effectOperationIds.filter(
      (operationId) => !known.has(operationId),
    );
    return { ledger, effects, missingOperationIds, orphanOperationIds };
  }

  async listRunLedgers(
    input: RunLedgerListInputV1 = {},
  ): Promise<RunLedgerListPageV1> {
    this.assertOpen("listRunLedgers");
    const limit =
      input.limit === undefined
        ? 100
        : requireInteger(input.limit, "limit", "listRunLedgers");
    if (limit < 1 || limit > 500) {
      throw new TypeError("listRunLedgers limit must be between 1 and 500");
    }
    const after =
      input.after === undefined
        ? ""
        : requireText(input.after, "after", "listRunLedgers");
    // The key is a prefilter only; a row that does not decode to a ledger is
    // skipped below, so a page can be shorter than the limit.
    const rows = resultRows(
      this.database
        .prepare(
          `SELECT run_id, payload FROM runtime_store_runs
           WHERE run_id > ? AND instr(payload, ?) > 0
           ORDER BY run_id ASC LIMIT ?`,
        )
        .all(after, RUN_LEDGER_METADATA_KEY, limit + 1),
    );
    const included = rows.slice(0, limit);
    const entries: RunLedgerListEntryV1[] = [];
    for (const row of included) {
      const run = assertRunRecord(
        decodeJson(columnText(row, "payload", "listRunLedgers"), "listRunLedgers"),
        "listRunLedgers",
      );
      const ledger = ledgerFromRuntimeRun(run);
      if (ledger === null) continue;
      const lease = this.database
        .prepare(
          "SELECT MAX(expires_at) AS expires_at FROM runtime_store_leases WHERE run_id = ?",
        )
        .get(run.runId) as Record<string, unknown> | undefined;
      const expiresAt = lease?.expires_at;
      entries.push({
        runId: run.runId,
        status: ledger.status,
        revision: ledger.revision,
        updatedAt: ledger.updatedAt,
        pendingArtifactIntentIds: (ledger.artifactIntents ?? [])
          .filter((intent) => intent.state === "pending")
          .map((intent) => intent.intentId),
        leaseExpiresAt: typeof expiresAt === "string" ? expiresAt : null,
      });
    }
    const last = included.at(-1);
    return {
      entries,
      next:
        rows.length > limit && last !== undefined
          ? columnText(last, "run_id", "listRunLedgers")
          : null,
    };
  }

  async putRun(
    input: RuntimeStorePutRunInput,
  ): Promise<RuntimeStorePutRunResult> {
    return this.mutate(
      "putRun",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const run = assertRunRecord(input.run, "putRun");
        const replay = this.replayMutation<RuntimeStoreRun>(
          "putRun",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return replay;
        const payload = encodeRecord(run, "putRun");
        this.database
          .prepare(
            `INSERT INTO runtime_store_runs(run_id, status, revision, payload, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             status = excluded.status,
             revision = excluded.revision,
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
          )
          .run(run.runId, run.status, run.revision, payload, run.updatedAt);
        return this.recordMutation<RuntimeStoreRun>(
          "putRun",
          input.idempotencyKey,
          input.requestHash,
          run,
        );
      },
    );
  }

  async getRun(runId: string): Promise<RuntimeStoreRun | null> {
    this.assertOpen("getRun");
    const row = this.database
      .prepare("SELECT payload FROM runtime_store_runs WHERE run_id = ?")
      .get(runId);
    if (!hasRow(row)) return null;
    return assertRunRecord(
      decodeJson(columnText(row, "payload", "getRun"), "getRun"),
      "getRun",
    );
  }

  async putEffect(
    input: RuntimeStorePutEffectInput,
  ): Promise<RuntimeStorePutEffectResult> {
    return this.mutate(
      "putEffect",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const receipt = assertEffectRecord(input.receipt, "putEffect");
        if (input.lease !== undefined) {
          this.assertLeaseProof(
            input.lease.partition,
            receipt.runId,
            input.lease,
            "putEffect",
          );
        }
        const replay = this.replayMutation<RuntimeStoreEffectReceipt>(
          "putEffect",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return replay;
        const payload = encodeRecord(receipt, "putEffect");
        this.database
          .prepare(
            `INSERT INTO runtime_store_effects(effect_id, run_id, status, assurance, payload)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(effect_id) DO UPDATE SET
               run_id = excluded.run_id,
               status = excluded.status,
               assurance = excluded.assurance,
               payload = excluded.payload`,
          )
          .run(
            receipt.effectId,
            receipt.runId,
            receipt.status,
            receipt.assurance,
            payload,
          );
        return this.recordMutation<RuntimeStoreEffectReceipt>(
          "putEffect",
          input.idempotencyKey,
          input.requestHash,
          receipt,
        );
      },
    );
  }

  async getEffect(effectId: string): Promise<RuntimeStoreEffectReceipt | null> {
    this.assertOpen("getEffect");
    const row = this.database
      .prepare("SELECT payload FROM runtime_store_effects WHERE effect_id = ?")
      .get(effectId);
    if (!hasRow(row)) return null;
    return assertEffectRecord(
      decodeJson(columnText(row, "payload", "getEffect"), "getEffect"),
      "getEffect",
    );
  }

  // ── Context Memory Host Adapter ─────────────────────────────────────────

  async putReceipt(
    input: Parameters<MemoryReceiptStorePort["putReceipt"]>[0],
  ): Promise<MemoryReceiptPutResultV1> {
    const operation = "memory.putReceipt";
    const key = this.memoryMutationKey(
      operation,
      input.receipt.scope,
      input.receipt.scopeKey,
      input.idempotencyKey,
    );
    const decoded = decodeMemoryDurableReceiptV1(input.receipt);
    if (decoded === null) {
      return this.memoryFailure(
        "memory_receipt_corrupt",
        "refusing to persist an invalid durable memory receipt",
      );
    }
    if (decoded.requestHash !== input.requestHash) {
      return this.memoryFailure(
        "memory_receipt_conflict",
        "receipt request hash does not match the mutation request hash",
      );
    }
    try {
      return this.mutate(operation, key, input.requestHash, () => {
        const leaseFailure = this.memoryLeaseFailure(
          input.lease,
          input.receipt.scope,
          input.receipt.scopeKey,
          operation,
        );
        if (leaseFailure !== null) return leaseFailure;
        const replay = this.replayMutation<MemoryReceiptPutResultV1>(
          operation,
          key,
          input.requestHash,
        );
        if (replay !== null) return replay.value;
        const existing = this.database
          .prepare(
            `SELECT payload, request_hash FROM runtime_store_memory_receipts
             WHERE scope = ? AND scope_key = ? AND receipt_id = ?`,
          )
          .get(decoded.scope, decoded.scopeKey, decoded.receiptId);
        if (hasRow(existing)) {
          const stored = decodeMemoryDurableReceiptV1(
            decodeJson(columnText(existing, "payload", operation), operation),
          );
          if (stored === null) {
            return this.memoryFailure(
              "memory_receipt_corrupt",
              "stored memory receipt is not parseable or self-consistent",
            );
          }
          if (
            stored.receiptHash !== decoded.receiptHash ||
            stored.requestHash !== decoded.requestHash
          ) {
            return this.memoryFailure(
              "memory_receipt_conflict",
              "immutable memory receipt identity conflicts with the stored receipt",
            );
          }
          const result: MemoryReceiptPutResultV1 = {
            ok: true,
            applied: false,
            receipt: stored,
          };
          this.recordMutation(operation, key, input.requestHash, result);
          return result;
        }
        const sameRequest = this.database
          .prepare(
            `SELECT receipt_id, content_hash FROM runtime_store_memory_receipts
             WHERE scope = ? AND scope_key = ? AND request_id = ?`,
          )
          .get(decoded.scope, decoded.scopeKey, decoded.requestId);
        if (hasRow(sameRequest)) {
          return this.memoryFailure(
            "memory_request_conflict",
            "memory request id is already bound to another receipt",
          );
        }
        this.database
          .prepare(
            `INSERT INTO runtime_store_memory_receipts(
               scope, scope_key, receipt_id, request_id, request_hash,
               content_hash, receipt_hash, committed_at, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decoded.scope,
            decoded.scopeKey,
            decoded.receiptId,
            decoded.requestId,
            decoded.requestHash,
            decoded.contentHash,
            decoded.receiptHash,
            decoded.committedAt,
            encodeRecord(decoded, operation),
          );
        const result: MemoryReceiptPutResultV1 = {
          ok: true,
          applied: true,
          receipt: decoded,
        };
        this.recordMutation(operation, key, input.requestHash, result);
        return result;
      });
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_receipt_conflict",
        operation,
        error,
      );
    }
  }

  async getReceipt(
    input: Parameters<MemoryReceiptStorePort["getReceipt"]>[0],
  ): Promise<MemoryReceiptLookupV1> {
    const operation = "memory.getReceipt";
    try {
      this.assertOpen(operation);
      const row = this.database
        .prepare(
          `SELECT payload FROM runtime_store_memory_receipts
           WHERE scope = ? AND scope_key = ? AND receipt_id = ?`,
        )
        .get(input.scope, input.scopeKey, input.receiptId);
      if (!hasRow(row)) return { ok: true, status: "absent" };
      const receipt = decodeMemoryDurableReceiptV1(
        decodeJson(columnText(row, "payload", operation), operation),
      );
      if (receipt === null) {
        return this.memoryFailure(
          "memory_receipt_corrupt",
          "stored memory receipt is not self-consistent",
        );
      }
      if (
        receipt.scope !== input.scope ||
        receipt.scopeKey !== input.scopeKey
      ) {
        return this.memoryFailure(
          "memory_scope_mismatch",
          "stored memory receipt scope does not match the requested scope",
        );
      }
      return { ok: true, status: "found", receipt };
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_store_unavailable",
        operation,
        error,
      );
    }
  }

  async listReceipts(
    input: Parameters<MemoryReceiptStorePort["listReceipts"]>[0],
  ): Promise<MemoryReceiptListResultV1> {
    const operation = "memory.listReceipts";
    try {
      this.assertOpen(operation);
      const limit = input.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        return this.memoryFailure(
          "memory_invalid_input",
          "receipt list limit must be a non-negative safe integer",
        );
      }
      const statement =
        limit === undefined
          ? this.database.prepare(
              `SELECT payload FROM runtime_store_memory_receipts
             WHERE scope = ? AND scope_key = ? ORDER BY committed_at ASC, receipt_id ASC`,
            )
          : this.database.prepare(
              `SELECT payload FROM runtime_store_memory_receipts
             WHERE scope = ? AND scope_key = ? ORDER BY committed_at ASC, receipt_id ASC LIMIT ?`,
            );
      const rows =
        limit === undefined
          ? resultRows(statement.all(input.scope, input.scopeKey))
          : resultRows(statement.all(input.scope, input.scopeKey, limit + 1));
      const truncated = limit !== undefined && rows.length > limit;
      const selected = truncated ? rows.slice(0, limit) : rows;
      const receipts: MemoryReceiptSummaryV1[] = [];
      for (const row of selected) {
        const receipt = decodeMemoryDurableReceiptV1(
          decodeJson(columnText(row, "payload", operation), operation),
        );
        if (receipt === null) {
          return this.memoryFailure(
            "memory_receipt_corrupt",
            "receipt listing encountered a corrupt durable receipt",
          );
        }
        receipts.push({
          receiptId: receipt.receiptId,
          requestId: receipt.requestId,
          basisRevision: receipt.basisRevision,
          contentHash: receipt.contentHash,
          receiptHash: receipt.receiptHash,
          committedAt: receipt.committedAt,
        });
      }
      return { ok: true, receipts, truncated };
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_store_unavailable",
        operation,
        error,
      );
    }
  }

  async readCurrent(
    input: Parameters<MemoryManifestStorePort["readCurrent"]>[0],
  ): Promise<MemoryManifestLookupV1> {
    const operation = "memory.readCurrent";
    try {
      this.assertOpen(operation);
      const row = this.database
        .prepare(
          `SELECT payload FROM runtime_store_memory_manifests
           WHERE scope = ? AND scope_key = ?`,
        )
        .get(input.scope, input.scopeKey);
      if (!hasRow(row)) return { ok: true, status: "absent" };
      return {
        ok: true,
        status: "found",
        manifest: decodeJson(columnText(row, "payload", operation), operation),
      };
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_store_unavailable",
        operation,
        error,
      );
    }
  }

  async compareAndSwap(
    input: Parameters<MemoryManifestStorePort["compareAndSwap"]>[0],
  ): Promise<MemoryManifestCasResultV1> {
    const operation = "memory.compareAndSwap";
    const manifest = decodeMemoryCurrentManifestV1(input.manifest);
    if (manifest === null) {
      return this.memoryFailure(
        "memory_manifest_corrupt",
        "refusing to persist an invalid current memory manifest",
      );
    }
    if (
      manifest.scope !== input.scope ||
      manifest.scopeKey !== input.scopeKey
    ) {
      return this.memoryFailure(
        "memory_scope_mismatch",
        "manifest scope does not match the CAS partition",
      );
    }
    const key = this.memoryMutationKey(
      operation,
      input.scope,
      input.scopeKey,
      input.idempotencyKey,
    );
    try {
      return this.mutate(operation, key, input.requestHash, () => {
        const leaseFailure = this.memoryLeaseFailure(
          input.lease,
          input.scope,
          input.scopeKey,
          operation,
        );
        if (leaseFailure !== null) return leaseFailure;
        const replay = this.replayMutation<MemoryManifestCasResultV1>(
          operation,
          key,
          input.requestHash,
        );
        if (replay !== null) return replay.value;
        const row = this.database
          .prepare(
            `SELECT revision, manifest_hash, payload FROM runtime_store_memory_manifests
             WHERE scope = ? AND scope_key = ?`,
          )
          .get(input.scope, input.scopeKey);
        const actualRevision = hasRow(row)
          ? columnInteger(row, "revision", operation)
          : 0;
        if (input.expectedRevision !== actualRevision) {
          return this.memoryFailure(
            "memory_manifest_stale",
            `manifest CAS expected revision ${String(input.expectedRevision)} but found ${String(actualRevision)}`,
            { expected: input.expectedRevision, actual: actualRevision },
          );
        }
        if (manifest.revision !== actualRevision + 1) {
          return this.memoryFailure(
            "memory_cas_conflict",
            "manifest revision must advance exactly one step during CAS",
            { expected: actualRevision + 1, actual: manifest.revision },
          );
        }
        this.database
          .prepare(
            `INSERT INTO runtime_store_memory_manifests(
               scope, scope_key, revision, manifest_hash, committed_at, payload
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope, scope_key) DO UPDATE SET
               revision = excluded.revision,
               manifest_hash = excluded.manifest_hash,
               committed_at = excluded.committed_at,
               payload = excluded.payload`,
          )
          .run(
            manifest.scope,
            manifest.scopeKey,
            manifest.revision,
            manifest.manifestHash,
            manifest.committedAt,
            encodeRecord(manifest, operation),
          );
        const result: MemoryManifestCasResultV1 = {
          ok: true,
          applied: true,
          manifest,
        };
        this.recordMutation(operation, key, input.requestHash, result);
        return result;
      });
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_cas_conflict",
        operation,
        error,
      );
    }
  }

  async append(
    input: Parameters<MemoryAuditReceiptStorePort["append"]>[0],
  ): Promise<MemoryAuditAppendResultV1> {
    const operation = "memory.appendAudit";
    const decoded = decodeMemoryAuditReceiptV1(input.receipt);
    if (decoded === null) {
      return this.memoryFailure(
        "memory_audit_write_failed",
        "refusing to persist an invalid or privacy-unsafe memory audit receipt",
      );
    }
    const record = decoded as unknown as Record<string, unknown>;
    const scope = decoded.scope;
    const scopeKey = decoded.scopeKey;
    const kind = decoded.kind;
    const receiptId =
      decoded.kind === "memory_read_receipt_v1"
        ? decoded.readReceiptId
        : decoded.compactionReceiptId;
    const requestId = decoded.requestId;
    const receiptHash = decoded.receiptHash;
    const key = this.memoryMutationKey(
      operation,
      scope,
      scopeKey,
      input.idempotencyKey,
    );
    try {
      const outcome = this.mutate(operation, key, input.requestHash, () => {
        const replay = this.replayMutation<MemoryAuditAppendResultV1>(
          operation,
          key,
          input.requestHash,
        );
        if (replay !== null) return replay.value;
        const existing = this.database
          .prepare(
            `SELECT receipt_hash FROM runtime_store_memory_audits
             WHERE scope = ? AND scope_key = ? AND kind = ? AND receipt_id = ?`,
          )
          .get(scope, scopeKey, kind, receiptId);
        if (hasRow(existing)) {
          if (columnText(existing, "receipt_hash", operation) !== receiptHash) {
            return this.memoryFailure(
              "memory_audit_write_failed",
              "audit receipt id is already bound to a different hash",
            );
          }
          const result: MemoryAuditAppendResultV1 = {
            ok: true,
            applied: false,
          };
          this.recordMutation(operation, key, input.requestHash, result);
          return result;
        }
        this.database
          .prepare(
            `INSERT INTO runtime_store_memory_audits(
               scope, scope_key, kind, receipt_id, request_id,
               request_hash, receipt_hash, recorded_at, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope,
            scopeKey,
            kind,
            receiptId,
            requestId,
            input.requestHash,
            receiptHash,
            typeof record.recordedAt === "string"
              ? record.recordedAt
              : new Date().toISOString(),
            encodeRecord(record, operation),
          );
        const result: MemoryAuditAppendResultV1 = { ok: true, applied: true };
        this.recordMutation(operation, key, input.requestHash, result);
        return result;
      });
      if (!outcome.ok) return outcome;
      // Return the receipt the audit log really holds: on an idempotent replay
      // that is the first append's receipt, not the one offered this time.
      const stored = this.database
        .prepare(
          `SELECT payload FROM runtime_store_memory_audits
           WHERE scope = ? AND scope_key = ? AND kind = ? AND receipt_id = ?`,
        )
        .get(scope, scopeKey, kind, receiptId);
      if (!hasRow(stored)) return outcome;
      const receipt = decodeMemoryAuditReceiptV1(
        decodeJson(columnText(stored, "payload", operation), operation),
      );
      return receipt === null ? outcome : { ...outcome, receipt };
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_audit_write_failed",
        operation,
        error,
      );
    }
  }

  async validateLease(
    input: Parameters<MemoryLeasePort["validateLease"]>[0],
  ): Promise<MemoryLeaseValidationResultV1> {
    const operation = "memory.validateLease";
    try {
      this.assertOpen(operation);
      const failure = this.memoryLeaseFailure(
        input.proof,
        input.scope,
        input.scopeKey,
        operation,
        input.now,
      );
      return failure ?? { ok: true };
    } catch (error) {
      return this.memoryFailureFromError(
        "memory_store_unavailable",
        operation,
        error,
      );
    }
  }

  /**
   * Re-check a memory lease while the caller's mutation transaction is open.
   * The earlier durability preflight is not sufficient: a takeover may occur
   * between artifact preparation, receipt write and manifest CAS.
   */
  private memoryLeaseFailure(
    proof: MemoryLeaseProofV1 | undefined,
    scope: MemoryScopeV1,
    scopeKey: string,
    operation: string,
    now = this.clock().toISOString(),
  ): MemoryDurabilityFailureV1 | null {
    if (proof === undefined) return null;
    if (
      typeof proof.partition !== "string" ||
      typeof proof.leaseId !== "string" ||
      typeof proof.ownerId !== "string" ||
      !Number.isSafeInteger(proof.epoch) ||
      proof.epoch < 1 ||
      typeof proof.expiresAt !== "string"
    ) {
      return this.memoryFailure(
        "memory_invalid_input",
        "memory lease proof is malformed",
        { fence: "lease_invalid" },
      );
    }
    const expectedPartition = memoryPartitionV1(scope, scopeKey);
    if (proof.partition !== expectedPartition) {
      return this.memoryFailure(
        "memory_lease_fenced",
        "lease proof belongs to another memory partition",
        {
          fence: "lease_partition_mismatch",
        },
      );
    }
    const row = this.database
      .prepare(
        `SELECT lease_id, owner_id, epoch, expires_at FROM runtime_store_leases
         WHERE partition = ?`,
      )
      .get(proof.partition);
    if (!hasRow(row))
      return this.memoryFailure(
        "memory_lease_missing",
        "memory lease is not present",
      );
    if (columnText(row, "lease_id", operation) !== proof.leaseId) {
      return this.memoryFailure(
        "memory_lease_fenced",
        "memory lease id is stale",
        { fence: "lease_id_mismatch" },
      );
    }
    if (columnText(row, "owner_id", operation) !== proof.ownerId) {
      return this.memoryFailure(
        "memory_lease_fenced",
        "memory lease owner is stale",
        { fence: "lease_owner_mismatch" },
      );
    }
    if (columnInteger(row, "epoch", operation) !== proof.epoch) {
      return this.memoryFailure(
        "memory_lease_fenced",
        "memory lease epoch is stale",
        { fence: "lease_epoch_mismatch" },
      );
    }
    const nowMs = Date.parse(now);
    const proofExpiresMs = Date.parse(proof.expiresAt);
    const liveExpiresMs = Date.parse(columnText(row, "expires_at", operation));
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(proofExpiresMs) ||
      !Number.isFinite(liveExpiresMs)
    ) {
      return this.memoryFailure(
        "memory_invalid_input",
        "memory lease timestamps are invalid",
        { fence: "lease_timestamp_invalid" },
      );
    }
    if (proofExpiresMs <= nowMs || liveExpiresMs <= nowMs) {
      return this.memoryFailure(
        "memory_lease_expired",
        "memory lease has expired",
        { fence: "lease_expired" },
      );
    }
    if (proofExpiresMs > liveExpiresMs) {
      return this.memoryFailure(
        "memory_lease_fenced",
        "memory lease proof outlives the live lease",
        { fence: "lease_expiry_mismatch" },
      );
    }
    return null;
  }

  /** Read-only audit evidence used by restart tests; it never replays effects. */
  async readMemoryAuditReceipts(
    scope: MemoryScopeV1,
    scopeKey: string,
  ): Promise<readonly MemoryAuditReceiptV1[]> {
    this.assertOpen("memory.readAudit");
    const rows = resultRows(
      this.database
        .prepare(
          `SELECT payload FROM runtime_store_memory_audits
           WHERE scope = ? AND scope_key = ? ORDER BY recorded_at ASC, receipt_id ASC`,
        )
        .all(scope, scopeKey),
    );
    return rows.map((row) => {
      const decoded = decodeMemoryAuditReceiptV1(
        decodeJson(
          columnText(row, "payload", "memory.readAudit"),
          "memory.readAudit",
        ),
      );
      if (decoded === null) {
        throw new SqliteRuntimeStoreError(
          "runtime_store_invalid_record",
          "stored memory audit receipt is invalid or privacy-unsafe",
          "memory.readAudit",
        );
      }
      return decoded;
    });
  }

  async appendEvent(
    input: RuntimeStoreAppendEventInput,
  ): Promise<RuntimeStoreAppendEventResult> {
    return this.mutate(
      "appendEvent",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const partition = requireText(
          input.partition,
          "partition",
          "appendEvent",
        );
        const runId = requireText(input.runId, "runId", "appendEvent");
        const type = requireText(input.type, "type", "appendEvent");
        const lastRow = this.database
          .prepare(
            "SELECT MAX(sequence) AS last_sequence FROM runtime_store_events WHERE partition = ?",
          )
          .get(partition);
        const lastValue = isRow(lastRow) ? lastRow.last_sequence : null;
        const currentSequence =
          lastValue === null || lastValue === undefined
            ? 0
            : requireInteger(lastValue, "last_sequence", "appendEvent");
        if (
          input.expectedSequence !== undefined &&
          input.expectedSequence !== currentSequence
        ) {
          throw new RuntimeStoreFencedError(
            "event sequence fenced",
            partition,
            input.expectedSequence,
            currentSequence,
            "event_sequence_mismatch",
          );
        }
        const sequence = currentSequence + 1;
        const eventId =
          input.eventId === undefined
            ? runtimeEventIdV1(partition, sequence, input.requestHash)
            : requireText(input.eventId, "eventId", "appendEvent");
        const existing = this.database
          .prepare(
            "SELECT payload FROM runtime_store_events WHERE partition = ? AND event_id = ?",
          )
          .get(partition, eventId);
        if (hasRow(existing)) {
          return {
            applied: false,
            value: assertEventRecord(
              decodeJson(
                columnText(existing, "payload", "appendEvent"),
                "appendEvent",
              ),
              "appendEvent",
            ),
          };
        }
        const replay = this.replayMutation<RuntimeStoreEvent>(
          "appendEvent",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return replay;
        // A new write must re-prove the lease inside this transaction so a
        // stale owner, epoch, partition, or expired lease can never append.
        if (input.lease !== undefined) {
          this.assertLeaseProof(partition, runId, input.lease);
        }
        const event: RuntimeStoreEvent = {
          schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
          eventId,
          partition,
          sequence,
          runId,
          type,
          payload: input.payload as RuntimeStoreJsonValue,
          requestHash: input.requestHash,
          createdAt: this.clock().toISOString(),
        };
        this.database
          .prepare(
            "INSERT OR IGNORE INTO runtime_store_partitions(partition) VALUES (?)",
          )
          .run(partition);
        this.database
          .prepare(
            `INSERT INTO runtime_store_events(
               partition, sequence, event_id, run_id, type, request_hash, created_at, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            partition,
            sequence,
            eventId,
            runId,
            type,
            input.requestHash,
            event.createdAt,
            encodeRecord(event, "appendEvent"),
          );
        return this.recordMutation<RuntimeStoreEvent>(
          "appendEvent",
          input.idempotencyKey,
          input.requestHash,
          event,
        );
      },
    );
  }

  async readEvents(
    partition: string,
    options: RuntimeStoreReadEventsOptions = {},
  ): Promise<RuntimeStoreReadEventsResult> {
    this.assertOpen("readEvents");
    const scope = requireText(partition, "partition", "readEvents");
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new SqliteRuntimeStoreError(
        "runtime_store_invalid_record",
        "afterSequence must be a non-negative safe integer",
        "readEvents",
      );
    }
    const limit = options.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new SqliteRuntimeStoreError(
        "runtime_store_invalid_record",
        "limit must be a non-negative safe integer",
        "readEvents",
      );
    }
    const statement =
      limit === undefined
        ? this.database.prepare(
            `SELECT payload FROM runtime_store_events
             WHERE partition = ? AND sequence > ?
             ORDER BY sequence ASC`,
          )
        : this.database.prepare(
            `SELECT payload FROM runtime_store_events
             WHERE partition = ? AND sequence > ?
             ORDER BY sequence ASC LIMIT ?`,
          );
    const rows =
      limit === undefined
        ? resultRows(statement.all(scope, afterSequence))
        : resultRows(statement.all(scope, afterSequence, limit));
    const events = rows.map((row) =>
      assertEventRecord(
        decodeJson(columnText(row, "payload", "readEvents"), "readEvents"),
        "readEvents",
      ),
    );
    return {
      partition: scope,
      events,
      lastSequence: events.at(-1)?.sequence ?? null,
    };
  }

  async acquireLease(
    input: RuntimeStoreAcquireLeaseInput,
  ): Promise<RuntimeStoreAcquireLeaseResult> {
    return this.mutate(
      "acquireLease",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const partition = requireText(
          input.partition,
          "partition",
          "acquireLease",
        );
        const runId = requireText(input.runId, "runId", "acquireLease");
        const ownerId = requireText(input.ownerId, "ownerId", "acquireLease");
        const ttlMs = requireInteger(input.ttlMs, "ttlMs", "acquireLease");
        if (ttlMs <= 0) {
          throw new SqliteRuntimeStoreError(
            "runtime_store_invalid_record",
            "ttlMs must be a positive safe integer",
            "acquireLease",
          );
        }
        const epochRow = this.database
          .prepare(
            "SELECT epoch FROM runtime_store_lease_epochs WHERE partition = ?",
          )
          .get(partition);
        const currentEpoch = hasRow(epochRow)
          ? columnInteger(epochRow, "epoch", "acquireLease")
          : 0;
        if (
          input.expectedEpoch !== undefined &&
          input.expectedEpoch !== currentEpoch
        ) {
          throw new RuntimeStoreFencedError(
            "lease epoch fenced",
            partition,
            input.expectedEpoch,
            currentEpoch,
          );
        }
        const replay = this.replayMutation<RuntimeStoreLease>(
          "acquireLease",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return replay;
        const epoch = currentEpoch + 1;
        const acquiredAt = this.clock();
        const leaseId =
          input.leaseId === undefined
            ? `runtime_lease_v1_${fingerprintPactileContractV1({
                schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
                domain: "runtime-lease-v1",
                partition,
                epoch,
                requestHash: input.requestHash,
              })}`
            : requireText(input.leaseId, "leaseId", "acquireLease");
        const lease: RuntimeStoreLease = {
          schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
          leaseId,
          partition,
          runId,
          ownerId,
          epoch,
          acquiredAt: acquiredAt.toISOString(),
          expiresAt: new Date(acquiredAt.getTime() + ttlMs).toISOString(),
          requestHash: input.requestHash,
        };
        this.database
          .prepare(
            "INSERT OR IGNORE INTO runtime_store_partitions(partition) VALUES (?)",
          )
          .run(partition);
        this.database
          .prepare(
            `INSERT INTO runtime_store_leases(
               partition, lease_id, run_id, owner_id, epoch, acquired_at, expires_at, request_hash, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(partition) DO UPDATE SET
               lease_id = excluded.lease_id,
               run_id = excluded.run_id,
               owner_id = excluded.owner_id,
               epoch = excluded.epoch,
               acquired_at = excluded.acquired_at,
               expires_at = excluded.expires_at,
               request_hash = excluded.request_hash,
               payload = excluded.payload`,
          )
          .run(
            partition,
            lease.leaseId,
            lease.runId,
            lease.ownerId,
            lease.epoch,
            lease.acquiredAt,
            lease.expiresAt,
            lease.requestHash,
            encodeRecord(lease, "acquireLease"),
          );
        this.database
          .prepare(
            `INSERT INTO runtime_store_lease_epochs(partition, epoch) VALUES (?, ?)
             ON CONFLICT(partition) DO UPDATE SET epoch = excluded.epoch`,
          )
          .run(partition, epoch);
        return this.recordMutation<RuntimeStoreLease>(
          "acquireLease",
          input.idempotencyKey,
          input.requestHash,
          lease,
        );
      },
    );
  }

  async releaseLease(
    input: RuntimeStoreReleaseLeaseInput,
  ): Promise<RuntimeStoreReleaseLeaseResult> {
    return this.mutate(
      "releaseLease",
      input.idempotencyKey,
      input.requestHash,
      () => {
        const leaseId = requireText(input.leaseId, "leaseId", "releaseLease");
        const ownerId = requireText(input.ownerId, "ownerId", "releaseLease");
        const epoch = requireInteger(input.epoch, "epoch", "releaseLease");
        const replay = this.replayMutation<RuntimeStoreReleaseLeaseResult>(
          "releaseLease",
          input.idempotencyKey,
          input.requestHash,
        );
        if (replay !== null) return replay.value;
        const row = this.database
          .prepare(
            `SELECT partition, owner_id, epoch FROM runtime_store_leases WHERE lease_id = ?`,
          )
          .get(leaseId);
        if (!hasRow(row)) {
          throw new RuntimeStoreFencedError(
            "lease release fenced",
            "unknown",
            epoch,
            0,
          );
        }
        const partition = columnText(row, "partition", "releaseLease");
        const currentOwner = columnText(row, "owner_id", "releaseLease");
        const currentEpoch = columnInteger(row, "epoch", "releaseLease");
        if (currentEpoch !== epoch || currentOwner !== ownerId) {
          throw new RuntimeStoreFencedError(
            "lease release fenced",
            partition,
            epoch,
            currentEpoch,
          );
        }
        this.database
          .prepare("DELETE FROM runtime_store_leases WHERE partition = ?")
          .run(partition);
        const result: RuntimeStoreReleaseLeaseResult = {
          released: true,
          leaseId,
        };
        return this.recordMutation<RuntimeStoreReleaseLeaseResult>(
          "releaseLease",
          input.idempotencyKey,
          input.requestHash,
          result,
        ).value;
      },
    );
  }

  /**
   * Read-only recovery view. Pending/unknown effects are reported as
   * `waiting`/`assurance_unknown` facts; nothing is re-executed and no row is
   * modified, so a caller can never mistake recovery for a replayed effect.
   */
  async recover(
    input: RuntimeStoreRecoverInput = {},
  ): Promise<RuntimeStoreRecoverResult> {
    this.assertOpen("recover");
    const runId =
      input.runId === undefined
        ? null
        : requireText(input.runId, "runId", "recover");
    const recoveredAt =
      input.now === undefined
        ? this.clock().toISOString()
        : requireText(input.now, "now", "recover");
    this.database.exec("BEGIN");
    try {
      const runRows =
        runId === null
          ? resultRows(
              this.database
                .prepare(
                  "SELECT payload FROM runtime_store_runs ORDER BY run_id ASC",
                )
                .all(),
            )
          : resultRows(
              this.database
                .prepare(
                  "SELECT payload FROM runtime_store_runs WHERE run_id = ? ORDER BY run_id ASC",
                )
                .all(runId),
            );
      const effectRows =
        runId === null
          ? resultRows(
              this.database
                .prepare(
                  `SELECT effect_id, run_id, status FROM runtime_store_effects
                   WHERE status IN ('pending', 'unknown')
                   ORDER BY effect_id ASC`,
                )
                .all(),
            )
          : resultRows(
              this.database
                .prepare(
                  `SELECT effect_id, run_id, status FROM runtime_store_effects
                   WHERE status IN ('pending', 'unknown') AND run_id = ?
                   ORDER BY effect_id ASC`,
                )
                .all(runId),
            );
      const leaseRows = resultRows(
        this.database
          .prepare(
            runId === null
              ? "SELECT payload FROM runtime_store_leases ORDER BY partition ASC"
              : "SELECT payload FROM runtime_store_leases WHERE run_id = ? ORDER BY partition ASC",
          )
          .all(...(runId === null ? [] : [runId])),
      );
      const effects: RuntimeStoreRecoveredEffect[] = effectRows.map((row) => {
        const status = columnText(row, "status", "recover");
        return {
          effectId: columnText(row, "effect_id", "recover"),
          runId: columnText(row, "run_id", "recover"),
          status: "waiting",
          assurance: "assurance_unknown",
          reexecute: false,
          reason: status === "pending" ? "effect_pending" : "effect_unknown",
        };
      });
      const result: RuntimeStoreRecoverResult = {
        schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
        recoveredAt,
        replayPolicy: "no_automatic_replay",
        runs: runRows.map((row) =>
          assertRunRecord(
            decodeJson(columnText(row, "payload", "recover"), "recover"),
            "recover",
          ),
        ),
        effects,
        leases: leaseRows.map((row) =>
          assertLeaseRecord(
            decodeJson(columnText(row, "payload", "recover"), "recover"),
            "recover",
          ),
        ),
      };
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* the original failure is the reportable one */
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private memoryMutationKey(
    operation: string,
    scope: string,
    scopeKey: string,
    idempotencyKey: string,
  ): string {
    return `${operation}:${scope}:${scopeKey}:${idempotencyKey}`;
  }

  private memoryFailure(
    code: MemoryDurabilityFailureCodeV1,
    message: string,
    details: Readonly<
      Record<string, string | number | boolean | null>
    > | null = null,
  ): MemoryDurabilityFailureV1 {
    return memoryDurabilityFailureV1(code, message, { details });
  }

  private memoryFailureFromError(
    fallbackCode: MemoryDurabilityFailureCodeV1,
    operation: string,
    error: unknown,
  ): MemoryDurabilityFailureV1 {
    if (error instanceof RuntimeStoreConflictError) {
      return this.memoryFailure(
        fallbackCode,
        `memory host conflict during ${operation}`,
      );
    }
    if (isStorePermissionError(error)) {
      return this.memoryFailure(
        "memory_store_denied",
        `memory host operation ${operation} was denied by the store`,
      );
    }
    return this.memoryFailure(
      "memory_store_unavailable",
      `memory host operation ${operation} failed`,
    );
  }

  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new SqliteRuntimeStoreError(
        "runtime_store_closed",
        "runtime store is closed",
        operation,
      );
    }
  }

  /**
   * Validate an optional append-event lease proof against the live lease row
   * inside the caller's `BEGIN IMMEDIATE` transaction. Every rejection is a
   * typed fence tied to the SQLite fact that failed, never a silent success.
   */
  private assertLeaseProof(
    partition: string,
    runId: string,
    proof: RuntimeStoreLeaseProof,
    operation = "appendEvent",
  ): void {
    const proofPartition = requireText(
      proof.partition,
      "lease.partition",
      operation,
    );
    const proofLeaseId = requireText(proof.leaseId, "lease.leaseId", operation);
    const proofOwnerId = requireText(proof.ownerId, "lease.ownerId", operation);
    const proofEpoch = requireInteger(proof.epoch, "lease.epoch", operation);
    if (proofEpoch <= 0) {
      throw new SqliteRuntimeStoreError(
        "runtime_store_invalid_record",
        "lease.epoch must be a positive safe integer",
        operation,
      );
    }
    if (proofPartition !== partition) {
      throw new RuntimeStoreFencedError(
        "lease proof partition does not match the event partition",
        partition,
        proofEpoch,
        proofEpoch,
        "lease_partition_mismatch",
      );
    }
    const row = this.database
      .prepare(
        `SELECT lease_id, run_id, owner_id, epoch, expires_at
         FROM runtime_store_leases WHERE partition = ?`,
      )
      .get(partition);
    if (!hasRow(row)) {
      throw new RuntimeStoreFencedError(
        "lease proof references a partition with no live lease",
        partition,
        proofEpoch,
        0,
        "lease_missing",
      );
    }
    const leaseId = columnText(row, "lease_id", operation);
    const leaseRunId = columnText(row, "run_id", operation);
    const ownerId = columnText(row, "owner_id", operation);
    const epoch = columnInteger(row, "epoch", operation);
    const expiresAt = columnText(row, "expires_at", operation);
    if (leaseId !== proofLeaseId) {
      throw new RuntimeStoreFencedError(
        "lease proof leaseId is stale",
        partition,
        proofEpoch,
        epoch,
        "lease_id_mismatch",
      );
    }
    if (leaseRunId !== runId) {
      throw new RuntimeStoreFencedError(
        "lease proof runId does not match the live lease",
        partition,
        proofEpoch,
        epoch,
        "lease_run_mismatch",
      );
    }
    if (ownerId !== proofOwnerId) {
      throw new RuntimeStoreFencedError(
        "lease proof ownerId is not the current owner",
        partition,
        proofEpoch,
        epoch,
        "lease_owner_mismatch",
      );
    }
    if (epoch !== proofEpoch) {
      throw new RuntimeStoreFencedError(
        "lease proof epoch is stale or ahead of the live lease",
        partition,
        proofEpoch,
        epoch,
        "lease_epoch_mismatch",
      );
    }
    if (Date.parse(expiresAt) <= this.clock().getTime()) {
      throw new RuntimeStoreFencedError(
        "lease proof has expired",
        partition,
        proofEpoch,
        epoch,
        "lease_expired",
      );
    }
  }

  /**
   * One synchronous `BEGIN IMMEDIATE` transaction per mutation. The action must
   * stay synchronous: no Provider, Pi, IPC or prompt access happens here.
   */
  private mutate<T>(
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    action: () => T,
  ): T {
    this.assertOpen(operation);
    requireText(idempotencyKey, "idempotencyKey", operation);
    requireText(requestHash, "requestHash", operation);
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.mapError(operation, idempotencyKey, requestHash, error);
    }
    try {
      const value = action();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* the original failure is the reportable one */
      }
      throw this.mapError(operation, idempotencyKey, requestHash, error);
    }
  }

  private mapError(
    operation: string,
    idempotencyKey: string | null,
    requestHash: string | null,
    error: unknown,
  ): Error {
    if (error instanceof Error) {
      if (
        error instanceof RuntimeStoreConflictError ||
        error instanceof RuntimeStoreFencedError ||
        error instanceof RuntimeStoreUnsupportedError ||
        error instanceof SqliteRuntimeStoreError
      ) {
        return error;
      }
      if (isBusyError(error) || isConstraintError(error)) {
        return new RuntimeStoreConflictError(
          `runtime store write conflict during ${operation}`,
          operation,
          idempotencyKey,
          requestHash,
        );
      }
      return error;
    }
    return new SqliteRuntimeStoreError(
      "runtime_store_invalid_record",
      `runtime store operation ${operation} failed with a non-Error value`,
      operation,
    );
  }

  /** Replay the stored response of an identical mutation, else fail closed. */
  private replayMutation<T>(
    operation: string,
    idempotencyKey: string,
    requestHash: string,
  ): { applied: boolean; value: T } | null {
    const row = this.database
      .prepare(
        "SELECT request_hash, response FROM runtime_store_mutations WHERE idempotency_key = ?",
      )
      .get(idempotencyKey);
    if (!hasRow(row)) return null;
    const storedHash = columnText(row, "request_hash", operation);
    if (storedHash !== requestHash) {
      throw new RuntimeStoreConflictError(
        `idempotency key '${idempotencyKey}' was already used with a different request hash`,
        operation,
        idempotencyKey,
        requestHash,
      );
    }
    return {
      applied: false,
      value: decodeJson(columnText(row, "response", operation), operation) as T,
    };
  }

  private recordMutation<T>(
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    value: T,
  ): { applied: boolean; value: T } {
    this.database
      .prepare(
        `INSERT INTO runtime_store_mutations(idempotency_key, operation, request_hash, response, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           request_hash = excluded.request_hash,
           response = excluded.response,
           created_at = excluded.created_at`,
      )
      .run(
        idempotencyKey,
        operation,
        requestHash,
        encodeRecord(value, operation),
        this.clock().toISOString(),
      );
    return { applied: true, value };
  }
}
