import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryDurabilityFailureV1, memoryPartitionV1 } from "../../../src/core/index.js";
import { runAgentReconcileCli } from "../../../src/commands/agent-reconcile.js";
import { memoryScopeKeyV1 } from "../../../src/pactile/agent/memory/scope.js";
import { reconcileAllContextGovernanceArtifactIntentsV1 } from "../../../src/pactile/runtime/context-governance-artifact-intents.js";
import { persistContextGovernanceMemoryFailureV1 } from "../../../src/pactile/runtime/context-governance-memory.js";
import type { RunLedgerPort, RunLedgerV1 } from "../../../src/pactile/runtime/run-ledger.js";
import {
  openPactileRuntimeHost,
  type PactileRuntimeHost,
} from "../../../src/pactile/runtime/runtime-host.js";
import { probeSqliteRuntimeStoreCapability } from "../../../src/pactile/runtime/sqlite-runtime-store.js";
import { runtimeRequestHashV1 } from "../../../src/pactile/runtime/store-port.js";

const roots: string[] = [];
const hash = `sha256:${"a".repeat(64)}`;
const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cg-reconcile-all-"));
  roots.push(root);
  return root;
}

function ledgerFor(runId: string): RunLedgerV1 {
  return {
    schemaVersion: 1,
    ledgerId: `ledger-${runId}`,
    commitId: `commit-${runId}`,
    runId,
    activeAttemptId: "attempt-1",
    activeTurnId: "turn-1",
    status: "running",
    lease: null,
    lastCursor: null,
    effectOperationIds: [],
    kernelSettlement: { status: "open", receiptId: null },
    dispatchOutboxId: null,
    revision: 1,
    updatedAt: "2026-10-10T00:00:00Z",
  };
}

/** Loses the commit that would bind the intent: the bytes exist, the binding does not. */
function crashBeforeBind(host: PactileRuntimeHost): RunLedgerPort {
  let lost = false;
  return {
    readRunLedger: (runId) => host.ledger.readRunLedger(runId),
    commitRunLedger: async (commit) => {
      if (lost || !commit.idempotencyKey.startsWith("pactile-artifact-intent:bind:")) {
        return host.ledger.commitRunLedger(commit);
      }
      lost = true;
      throw new Error("simulated crash before the ledger commit");
    },
  };
}

/**
 * A run whose owner died after writing the bytes of an artifact but before
 * binding it. `release` models an owner that let go of its lease on the way
 * out; otherwise the lease stays until it expires, as after a hard crash.
 */
async function crashedRun(
  host: PactileRuntimeHost,
  runId: string,
  options: { readonly release?: boolean } = {},
): Promise<void> {
  const initial = ledgerFor(runId);
  await host.ledger.commitRunLedger({
    idempotencyKey: `seed-${runId}`,
    requestHash: runtimeRequestHashV1("run-ledger.seed", { runId }),
    ledger: initial,
    effects: [],
  });
  const scopeKey = memoryScopeKeyV1({
    scope: "run",
    workspaceId: "workspace-1",
    projectId: "project-1",
    runId,
  });
  const acquired = await host.store.acquireLease({
    partition: memoryPartitionV1("run", scopeKey),
    runId,
    ownerId: `owner-${runId}`,
    ttlMs: 600_000,
    idempotencyKey: `lease-${runId}`,
    requestHash: hash,
  });
  const lease = {
    leaseId: acquired.value.leaseId,
    ownerId: acquired.value.ownerId,
    epoch: acquired.value.epoch,
    expiresAt: acquired.value.expiresAt,
    partition: acquired.value.partition,
  };
  const crashed = await persistContextGovernanceMemoryFailureV1({
    ledger: crashBeforeBind(host),
    artifacts: host.artifacts,
    request: { scope: "run", scopeKey, basisRevision: 1, acknowledgeDisclosure: false, lease },
    failure: memoryDurabilityFailureV1("memory_disclosure_missing", "not acknowledged", {
      scope: "run",
      scopeKey,
    }),
    workspaceId: "workspace-1",
    runId,
    attemptId: "attempt-1",
    turnId: "turn-1",
    operationEpoch: 1,
    contextOperationId: `context-memory-${runId}`,
    memoryReadArtifactId: `cg-memory-read-${runId}`,
    scopeKey,
    version: 1,
    basisRevision: 1,
    now: () => new Date(),
    lease,
  });
  expect(crashed).toMatchObject({ ok: false, code: "ledger_binding_failed" });
  if (options.release === true) {
    await host.store.releaseLease({
      leaseId: lease.leaseId,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      idempotencyKey: `release-${runId}`,
      requestHash: hash,
    });
  }
}

async function intentStates(host: PactileRuntimeHost, runId: string): Promise<string[]> {
  const snapshot = await host.ledger.readRunLedger(runId);
  return (snapshot?.ledger.artifactIntents ?? []).map((intent) => intent.state);
}

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "reconciling artifact intents across every run (real SQLite + file ArtifactStore)",
  () => {
    it("lists stored RunLedgers in order and in pages, with pending intents and lease expiry", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-b");
        await crashedRun(host, "run-a");
        await crashedRun(host, "run-c", { release: true });
        // A run record without a RunLedger is not listed.
        await host.store.putRun({
          idempotencyKey: "plain-run",
          requestHash: hash,
          run: {
            schemaVersion: 1,
            runId: "run-aa-plain",
            status: "running",
            revision: 1,
            input: {},
            output: null,
            error: null,
            metadata: {},
            createdAt: "2026-10-10T00:00:00Z",
            updatedAt: "2026-10-10T00:00:00Z",
          },
        } as never);

        const first = await host.ledger.listRunLedgers({ limit: 2 });
        expect(first.entries.map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
        expect(first.next).toBe("run-b");
        const second = await host.ledger.listRunLedgers({ limit: 2, after: first.next ?? "" });
        expect(second.entries.map((entry) => entry.runId)).toEqual(["run-c"]);
        expect(second.next).toBeNull();

        const [a, , c] = [...first.entries, ...second.entries];
        expect(a).toMatchObject({ status: "running", revision: expect.any(Number) });
        expect(a?.pendingArtifactIntentIds).toHaveLength(1);
        expect(typeof a?.leaseExpiresAt).toBe("string");
        // Released: the store holds no lease for it any more.
        expect(c?.pendingArtifactIntentIds).toHaveLength(1);
        expect(c?.leaseExpiresAt).toBeNull();

        await expect(host.ledger.listRunLedgers({ limit: 0 })).rejects.toThrow(/between 1 and 500/u);
        await expect(host.ledger.listRunLedgers({ limit: 501 })).rejects.toThrow(/between 1 and 500/u);
      } finally {
        await host.close();
      }
    });

    it("reports runs that need work in a dry run and changes nothing", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-a", { release: true });
        await crashedRun(host, "run-b");
        const before = await host.ledger.readRunLedger("run-a");
        const result = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          dryRun: true,
          pageSize: 1,
        });
        expect(result.scanned).toBe(2);
        expect(result.runs.map((run) => [run.runId, run.action])).toEqual([
          ["run-a", "reported"],
          ["run-b", "skipped_live"],
        ]);
        expect((await host.ledger.readRunLedger("run-a"))?.ledger.revision).toBe(before?.ledger.revision);
        expect(await intentStates(host, "run-a")).toEqual(["pending"]);
      } finally {
        await host.close();
      }
    });

    it("finishes runs whose owner is gone and leaves a run with a live lease alone", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-live");
        await crashedRun(host, "run-gone", { release: true });
        const liveBefore = await host.ledger.readRunLedger("run-live");

        const first = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          leases: { store: host.store, ownerId: "scanner-one" },
        });
        expect(first.runs.map((run) => [run.runId, run.action])).toEqual([
          ["run-gone", "reconciled"],
          ["run-live", "skipped_live"],
        ]);
        expect(first.runs[0]).toMatchObject({ reconciled: expect.any(Array), pending: [] });
        expect(first.runs[0]?.reconciled).toHaveLength(1);
        expect(await intentStates(host, "run-gone")).toEqual(["bound"]);
        // The live run's ledger did not move at all.
        expect((await host.ledger.readRunLedger("run-live"))?.ledger.revision).toBe(
          liveBefore?.ledger.revision,
        );
        expect(await intentStates(host, "run-live")).toEqual(["pending"]);

        // Once its lease has expired the crashed owner's run is finished too.
        const later = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          leases: { store: host.store, ownerId: "scanner-one" },
          now: () => new Date(Date.now() + HOUR),
        });
        expect(later.runs.map((run) => [run.runId, run.action])).toEqual([["run-live", "reconciled"]]);
        expect(await intentStates(host, "run-live")).toEqual(["bound"]);

        // Nothing is left to do: a third scan lists no run.
        const quiet = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          leases: { store: host.store, ownerId: "scanner-one" },
          now: () => new Date(Date.now() + HOUR),
        });
        expect(quiet).toEqual({ scanned: 2, runs: [] });
      } finally {
        await host.close();
      }
    });

    it("never scans a run it was told to exclude", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-mine", { release: true });
        await crashedRun(host, "run-other", { release: true });
        const result = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          excludeRunIds: ["run-mine"],
        });
        expect(result.runs.map((run) => run.runId)).toEqual(["run-other"]);
        expect(await intentStates(host, "run-mine")).toEqual(["pending"]);
      } finally {
        await host.close();
      }
    });

    it("reports, and does not claim success, when the run's lease is replaced and fences every write", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-a", { release: true });
        const replacedStore = {
          releaseLease: (input: Parameters<typeof host.store.releaseLease>[0]) => host.store.releaseLease(input),
          acquireLease: async (input: Parameters<typeof host.store.acquireLease>[0]) => {
            const mine = await host.store.acquireLease(input);
            // Someone else takes the same partition over at once: ours is stale.
            await host.store.acquireLease({
              ...input,
              ownerId: "someone-else",
              idempotencyKey: `${input.idempotencyKey}:other`,
              requestHash: hash,
            });
            return mine;
          },
        };
        const result = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          leases: { store: replacedStore, ownerId: "scanner-stale" },
        });
        expect(result.runs).toEqual([
          expect.objectContaining({
            runId: "run-a",
            action: "failed",
            reconciled: [],
            message: expect.stringContaining("ledger_binding_failed"),
          }),
        ]);
        expect(await intentStates(host, "run-a")).toEqual(["pending"]);
      } finally {
        await host.close();
      }
    });

    it("skips a run another scan is working on, because its lease is live", async () => {
      const host = await openPactileRuntimeHost({ repositoryRoot: fixture() });
      try {
        await crashedRun(host, "run-a", { release: true });
        // Another scan's lease on this run, still held.
        await host.store.acquireLease({
          partition: "context-governance-reconcile:run-a",
          runId: "run-a",
          ownerId: "other-scan",
          ttlMs: 300_000,
          idempotencyKey: "other-scan-lease",
          requestHash: hash,
        });
        const result = await reconcileAllContextGovernanceArtifactIntentsV1({
          ledger: host.ledger,
          artifacts: host.artifacts,
          leases: { store: host.store, ownerId: "scanner-two" },
        });
        expect(result.runs.map((run) => [run.runId, run.action])).toEqual([["run-a", "skipped_live"]]);
        expect(await intentStates(host, "run-a")).toEqual(["pending"]);
      } finally {
        await host.close();
      }
    });  },
);

describe.skipIf(!probeSqliteRuntimeStoreCapability().supported)(
  "pactile agent reconcile",
  () => {
    function captured() {
      const lines: string[] = [];
      return { lines, io: { write: (line: string) => lines.push(line) } };
    }

    async function prepared(): Promise<string> {
      const root = fixture();
      const host = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        await crashedRun(host, "run-gone", { release: true });
        await crashedRun(host, "run-live");
      } finally {
        await host.close();
      }
      return root;
    }

    it("reports by default and finishes only with --apply, releasing its own lease", async () => {
      const root = await prepared();
      const dry = captured();
      await expect(runAgentReconcileCli(["--repository-root", root], dry.io)).resolves.toBe(0);
      expect(dry.lines.join("\n")).toContain("run-gone  reported");
      expect(dry.lines.join("\n")).toContain("run-live  skipped_live");
      expect(dry.lines.join("\n")).toContain("dry run: nothing was changed");

      const check = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        expect(await intentStates(check, "run-gone")).toEqual(["pending"]);
      } finally {
        await check.close();
      }

      const applied = captured();
      await expect(runAgentReconcileCli(["--repository-root", root, "--apply"], applied.io)).resolves.toBe(0);
      expect(applied.lines.join("\n")).toContain("run-gone  reconciled  reconciled 1, abandoned 0, still pending 0");
      expect(applied.lines.join("\n")).toContain("run-live  skipped_live");

      const after = await openPactileRuntimeHost({ repositoryRoot: root });
      try {
        expect(await intentStates(after, "run-gone")).toEqual(["bound"]);
        expect(await intentStates(after, "run-live")).toEqual(["pending"]);
        // The leases the scan took are given back.
        const recovered = await after.store.recover();
        expect(recovered.leases.filter((lease) => lease.partition.startsWith("context-governance-reconcile:"))).toEqual([]);
      } finally {
        await after.close();
      }
    });

    it("prints machine-readable output with --json", async () => {
      const root = await prepared();
      const out = captured();
      await expect(runAgentReconcileCli(["--repository-root", root, "--json"], out.io)).resolves.toBe(0);
      const parsed = JSON.parse(out.lines.join("")) as {
        applied: boolean;
        scanned: number;
        runs: { runId: string; action: string }[];
      };
      expect(parsed).toMatchObject({ applied: false, scanned: 2 });
      expect(parsed.runs.map((run) => [run.runId, run.action])).toEqual([
        ["run-gone", "reported"],
        ["run-live", "skipped_live"],
      ]);
    });

    it("refuses a missing or relative repository root without opening anything", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(runAgentReconcileCli([], captured().io)).resolves.toBe(2);
      await expect(runAgentReconcileCli(["--repository-root", "relative/path"], captured().io)).resolves.toBe(2);
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/usage: pactile agent reconcile/u);
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/must be absolute/u);
    });
  },
);
