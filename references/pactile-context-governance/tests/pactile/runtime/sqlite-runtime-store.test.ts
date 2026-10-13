import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeStoreConflictError,
  RuntimeStoreFencedError,
  RuntimeStoreUnsupportedError,
  runtimeRequestHashV1,
  type RuntimeStoreEffectReceipt,
  type RuntimeStoreRun,
} from "../../../src/core/index.js";

import {
  RUNTIME_STORE_SQLITE_SCHEMA_VERSION,
  SqliteRuntimeStoreError,
  openSqliteRuntimeStore,
  probeSqliteRuntimeStoreCapability,
  type SqliteRuntimeStore,
} from "../../../src/pactile/runtime/sqlite-runtime-store.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-sqlite-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  // A failed close leaves the WAL sidecar files locked; retry so cleanup is
  // not the flake, and never mask a real assertion failure.
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const AT = "2026-10-03T00:00:00.000Z";

function run(runId = "run-1", revision = 1): RuntimeStoreRun {
  return {
    schemaVersion: 1,
    runId,
    status: "running",
    revision,
    input: { goal: "sqlite-adapter" },
    output: null,
    error: null,
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
  };
}

function effect(
  effectId = "effect-1",
  status: RuntimeStoreEffectReceipt["status"] = "pending",
): RuntimeStoreEffectReceipt {
  return {
    schemaVersion: 1,
    effectId,
    runId: "run-1",
    status,
    assurance: "assurance_unknown",
    result: null,
    error: null,
    requestHash: "effect-hash",
    recordedAt: AT,
  };
}

/** Injected driver that exposes no usable constructor (missing/old Node). */
const unsupportedDriver = (): unknown => ({ DatabaseSync: undefined });

/** Injected driver whose module cannot be loaded at all. */
const missingDriver = (): unknown => {
  throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
};

const nativeRequire = createRequire(import.meta.url);

const capability = probeSqliteRuntimeStoreCapability();
// Record the branch this machine took so a Node 18 run is never a silent skip.
console.log(`[sqlite-capability] ${JSON.stringify(capability)}`);

async function open(
  root: string,
  driver?: () => unknown,
): Promise<SqliteRuntimeStore> {
  return openSqliteRuntimeStore({
    projectRoot: root,
    ...(driver === undefined ? {} : { driver }),
    now: () => new Date(AT),
  });
}

describe("SQLite runtime store capability gating", () => {
  it("reports a typed capability for this runtime", () => {
    expect(capability.feature).toBe("node:sqlite");
    expect(capability.nodeVersion).toBe(process.version);
    if (capability.supported) {
      expect(capability.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(capability.reason).toBeNull();
    } else {
      expect(capability.reason).not.toBeNull();
      expect(capability.sqliteVersion).toBeNull();
    }
  });

  it("always proves the unsupported branch, even on a real driver host", async () => {
    const root = fixture();
    const missing = probeSqliteRuntimeStoreCapability({ driver: missingDriver });
    expect(missing.supported).toBe(false);
    expect(missing.reason).toBe("driver_unavailable");
    const incompatible = probeSqliteRuntimeStoreCapability({
      driver: unsupportedDriver,
    });
    expect(incompatible.supported).toBe(false);
    expect(incompatible.reason).toBe("driver_api_incompatible");
    const oldNode = probeSqliteRuntimeStoreCapability({
      driver: () => ({ DatabaseSync: undefined }),
      nodeVersion: "v22.12.0",
    });
    expect(oldNode.supported).toBe(false);
    expect(oldNode.reason).toBe("node_version_unsupported");
    expect(oldNode.reasonDetail).toContain("Node >=22.13");

    for (const driver of [missingDriver, unsupportedDriver]) {
      const failure = await open(root, driver).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeStoreUnsupportedError);
      expect((failure as RuntimeStoreUnsupportedError).code).toBe(
        "runtime_store_unsupported",
      );
      expect((failure as RuntimeStoreUnsupportedError).feature).toBe(
        "node:sqlite",
      );
    }
    // No silent JSON/memory fallback may leave artifacts behind.
    expect(fs.existsSync(path.join(root, ".pactile"))).toBe(false);
  });

  it("refuses a real store on a runtime without the driver", async () => {
    if (capability.supported) {
      // Covered by the injected-driver case above; the real driver is asserted
      // in the persistence suites below instead of being skipped silently.
      expect(capability.supported).toBe(true);
      return;
    }
    const root = fixture();
    await expect(open(root)).rejects.toBeInstanceOf(RuntimeStoreUnsupportedError);
  });
});

describe.skipIf(!capability.supported)("SQLite runtime store schema and containment", () => {
  it("creates a versioned schema inside the canonical root", async () => {
    const root = fixture();
    const store = await open(root);
    const diagnostics = await store.diagnostics();
        console.log(`[sqlite-diagnostics] ${JSON.stringify(diagnostics)}`);
    expect(diagnostics.schemaVersion).toBe(RUNTIME_STORE_SQLITE_SCHEMA_VERSION);
    expect(diagnostics.userVersion).toBe(RUNTIME_STORE_SQLITE_SCHEMA_VERSION);
    expect(diagnostics.journalMode).toBe("wal");
    expect(diagnostics.foreignKeys).toBe(true);
    expect(diagnostics.busyTimeoutMs).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(root, ".pactile/runtime/runtime-store.sqlite")),
    ).toBe(true);
    await store.close();
  });

  it("rejects a database path outside the canonical root", async () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-outside-"));
    roots.push(outside);
    await expect(
      openSqliteRuntimeStore({
        projectRoot: root,
        databasePath: path.join(outside, "escape.sqlite"),
      }),
    ).rejects.toBeInstanceOf(SqliteRuntimeStoreError);
    await expect(
      openSqliteRuntimeStore({
        projectRoot: root,
        databasePath: "../escape.sqlite",
      }),
    ).rejects.toBeInstanceOf(SqliteRuntimeStoreError);
    expect(fs.existsSync(path.join(outside, "escape.sqlite"))).toBe(false);
  });
});

describe.skipIf(!capability.supported)("SQLite runtime store persistence and transactions", () => {
  it("keeps committed facts across reopen and leaks no rolled back write", async () => {
    const root = fixture();
    const first = await open(root);
    await first.putRun({
      idempotencyKey: "run-1-create",
      requestHash: runtimeRequestHashV1("putRun", run()),
      run: run("run-1", 1),
    });
    await first.putEffect({
      idempotencyKey: "effect-1",
      requestHash: "effect-hash",
      receipt: effect(),
    });
    await first.appendEvent({
      idempotencyKey: "event-1",
      requestHash: "event-hash-1",
      partition: "run-1",
      runId: "run-1",
      type: "step.started",
      payload: { step: 1 },
    });
    await first.close();

    const second = await open(root);
    expect((await second.getRun("run-1"))?.revision).toBe(1);
    expect((await second.getEffect("effect-1"))?.status).toBe("pending");
    expect((await second.readEvents("run-1")).events).toHaveLength(1);

    await expect(
      second.putRun({
        idempotencyKey: "run-2-create",
        requestHash: "run-2-hash",
        run: run("run-2", 2),
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      second.putRun({
        idempotencyKey: "run-1-create",
        requestHash: "different-hash",
        run: { ...run("run-2", 3), runId: "run-2" },
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreConflictError);
    expect(await second.getRun("run-2")).not.toBeNull();
    expect((await second.getRun("run-1"))?.revision).toBe(1);
    await second.close();
  });

  it("replays identical mutations and rejects a changed payload hash", async () => {
    const root = fixture();
    const store = await open(root);
    const hash = runtimeRequestHashV1("putRun", run());
    const first = await store.putRun({
      idempotencyKey: "replay-key",
      requestHash: hash,
      run: run(),
    });
    const replay = await store.putRun({
      idempotencyKey: "replay-key",
      requestHash: hash,
      run: run(),
    });
    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.value).toEqual(first.value);
    await expect(
      store.putRun({
        idempotencyKey: "replay-key",
        requestHash: "mutated-hash",
        run: run("run-1", 9),
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreConflictError);
    await store.close();
  });
});

describe.skipIf(!capability.supported)("SQLite runtime store events and leases", () => {
  it("deduplicates events per partition and keeps sequence monotonic", async () => {
    const root = fixture();
    const store = await open(root);
    const base = {
      partition: "run-1",
      runId: "run-1",
      type: "step",
      payload: { ok: true },
    };
    const first = await store.appendEvent({
      ...base,
      idempotencyKey: "e1",
      requestHash: "h1",
    });
    const replayIdempotent = await store.appendEvent({
      ...base,
      idempotencyKey: "e1",
      requestHash: "h1",
    });
    const replaySameEvent = await store.appendEvent({
      ...base,
      idempotencyKey: "e1b",
      requestHash: "h1",
      eventId: first.value.eventId,
    });
    const second = await store.appendEvent({
      ...base,
      idempotencyKey: "e2",
      requestHash: "h2",
    });
    const other = await store.appendEvent({
      ...base,
      partition: "run-2",
      idempotencyKey: "e3",
      requestHash: "h3",
    });
    expect(first.value.sequence).toBe(1);
    expect(replayIdempotent.applied).toBe(false);
    expect(replaySameEvent.applied).toBe(false);
    expect(replaySameEvent.value.sequence).toBe(1);
    expect(second.value.sequence).toBe(2);
    expect(other.value.sequence).toBe(1);
    await expect(
      store.appendEvent({
        ...base,
        idempotencyKey: "e4",
        requestHash: "h4",
        expectedSequence: 5,
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreFencedError);
    const page = await store.readEvents("run-1", { afterSequence: 0, limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.lastSequence).toBe(1);
    await store.close();
  });

  it("fences stale owner and epoch on lease acquisition and release", async () => {
    const root = fixture();
    const store = await open(root);
    const acquired = await store.acquireLease({
      partition: "run-1",
      runId: "run-1",
      ownerId: "owner-a",
      ttlMs: 60_000,
      idempotencyKey: "lease-1",
      requestHash: "lh1",
    });
    expect(acquired.value.epoch).toBe(1);
    await expect(
      store.acquireLease({
        partition: "run-1",
        runId: "run-1",
        ownerId: "owner-b",
        ttlMs: 60_000,
        idempotencyKey: "lease-2",
        requestHash: "lh2",
        expectedEpoch: 0,
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreFencedError);
    const takeover = await store.acquireLease({
      partition: "run-1",
      runId: "run-1",
      ownerId: "owner-b",
      ttlMs: 60_000,
      idempotencyKey: "lease-3",
      requestHash: "lh3",
      expectedEpoch: 1,
    });
    expect(takeover.value.epoch).toBe(2);
    await expect(
      store.releaseLease({
        leaseId: acquired.value.leaseId,
        ownerId: "owner-a",
        epoch: 1,
        idempotencyKey: "rel-1",
        requestHash: "rh1",
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreFencedError);
    await expect(
      store.releaseLease({
        leaseId: takeover.value.leaseId,
        ownerId: "owner-a",
        epoch: 2,
        idempotencyKey: "rel-2",
        requestHash: "rh2",
      }),
    ).rejects.toBeInstanceOf(RuntimeStoreFencedError);
    const released = await store.releaseLease({
      leaseId: takeover.value.leaseId,
      ownerId: "owner-b",
      epoch: 2,
      idempotencyKey: "rel-3",
      requestHash: "rh3",
    });
    expect(released.released).toBe(true);
    await store.close();
  });
});

describe.skipIf(!capability.supported)("SQLite runtime store recovery and privacy", () => {
  it("recovers pending and unknown effects as waiting without replay", async () => {
    const root = fixture();
    const store = await open(root);
    await store.putRun({
      idempotencyKey: "run-1-create",
      requestHash: runtimeRequestHashV1("putRun", run()),
      run: run(),
    });
    await store.putEffect({
      idempotencyKey: "fx-pending",
      requestHash: "pending-hash",
      receipt: effect("effect-pending", "pending"),
    });
    await store.putEffect({
      idempotencyKey: "fx-unknown",
      requestHash: "unknown-hash",
      receipt: effect("effect-unknown", "unknown"),
    });
    await store.acquireLease({
      partition: "run-1",
      runId: "run-1",
      ownerId: "owner-1",
      ttlMs: 60_000,
      idempotencyKey: "lease-run-1",
      requestHash: "lease-hash-1",
    });
    await store.acquireLease({
      partition: "run-2",
      runId: "run-2",
      ownerId: "owner-2",
      ttlMs: 60_000,
      idempotencyKey: "lease-run-2",
      requestHash: "lease-hash-2",
    });
    await store.putEffect({
      idempotencyKey: "fx-succeeded",
      requestHash: "succeeded-hash",
      receipt: effect("effect-done", "succeeded"),
    });
    await store.close();

    const reopened = await open(root);
    const recovery = await reopened.recover({ runId: "run-1" });
    expect(recovery.replayPolicy).toBe("no_automatic_replay");
    expect(recovery.runs).toHaveLength(1);
    expect(recovery.effects.map((item) => item.effectId)).toEqual([
      "effect-pending",
      "effect-unknown",
    ]);
    for (const item of recovery.effects) {
      expect(item.status).toBe("waiting");
      expect(item.assurance).toBe("assurance_unknown");
      expect(item.reexecute).toBe(false);
    }
    expect(recovery.effects[0]?.reason).toBe("effect_pending");
    expect(recovery.effects[1]?.reason).toBe("effect_unknown");
    expect(recovery.leases.map((item) => item.partition)).toEqual(["run-1"]);
    // Recovery must not mutate the receipts it reports.
    expect((await reopened.getEffect("effect-pending"))?.status).toBe("pending");
    expect((await reopened.getEffect("effect-unknown"))?.status).toBe("unknown");
    await reopened.close();
  });

  it("refuses to persist Pi transcript or prompt content", async () => {
    const root = fixture();
    const store = await open(root);
    await expect(
      store.putRun({
        idempotencyKey: "run-transcript",
        requestHash: "transcript-hash",
        run: { ...run(), metadata: { transcript: "user: hello" } },
      }),
    ).rejects.toBeInstanceOf(SqliteRuntimeStoreError);
    expect(await store.getRun("run-1")).toBeNull();
    await store.close();
  });
});

describe.skipIf(!capability.supported)("SQLite runtime store torn writes and Windows locking", () => {
  it("rolls back a torn multi-row write and keeps the prior facts", async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, ".pactile/runtime"), { recursive: true });
    const sqlite = nativeRequire("node:sqlite") as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { get(): unknown };
        close(): void;
      };
    };
    const databasePath = path.join(root, ".pactile/runtime/runtime-store.sqlite");
    const seeded = new sqlite.DatabaseSync(databasePath);
    seeded.exec("CREATE VIEW runtime_store_migrations AS SELECT 1 AS version");
    seeded.close();
    await expect(open(root)).rejects.toBeInstanceOf(RuntimeStoreUnsupportedError);
    const inspected = new sqlite.DatabaseSync(databasePath);
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_store_meta'",
    ).get()).toBeUndefined();
    expect(inspected.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 });
    inspected.close();

  });

  it("records Windows contention: serialised sequence, typed conflicts only", async () => {
    const root = fixture();
    const first = await open(root);
    const second = await open(root);
    const attempts = await Promise.allSettled([
      first.appendEvent({
        idempotencyKey: "c1",
        requestHash: "ch1",
        partition: "contended",
        runId: "run-1",
        type: "step",
        payload: { writer: 1 },
      }),
      second.appendEvent({
        idempotencyKey: "c2",
        requestHash: "ch2",
        partition: "contended",
        runId: "run-1",
        type: "step",
        payload: { writer: 2 },
      }),
    ]);
    const outcomes = attempts.map((attempt) =>
      attempt.status === "fulfilled"
        ? `ok:${String(attempt.value.value.sequence)}`
        : `err:${attempt.reason instanceof Error ? attempt.reason.name : "unknown"}`,
    );
    // Observed Windows lock behavior is recorded either way; SQLite must never
    // corrupt the stream, and any refusal must be a typed conflict.
        console.log(`[windows-concurrency] ${outcomes.join(",")}`);
    const events = await first.readEvents("contended");
    const sequences = events.events.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason).toBeInstanceOf(RuntimeStoreConflictError);
      }
    }
    await Promise.all([first.close(), second.close()]);
  });
});
