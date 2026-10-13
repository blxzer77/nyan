import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentTool } from "../agent/pi/types.js";
import type { ArtifactStorePort } from "../agent/memory/artifact-store.js";
import {
  memoryPartitionV1,
  type ContextMemoryDurabilityPort,
  type MemoryLeaseProofV1,
} from "../agent/memory/durability.js";
import { memoryScopeKeyV1 } from "../agent/memory/scope.js";
import { PACTILE_LOGICAL_ID_PATTERN } from "../shared/validation.js";
import { reconcileContextGovernanceArtifactIntentsV1 } from "./context-governance-artifact-intents.js";
import { createGovernedMemoryReadToolV1 } from "./context-governance-memory-read-port.js";
import { PactileRunLedgerEffectReceiptPort } from "./run-ledger-effect-receipts.js";
import {
  RUN_LEDGER_METADATA_KEY,
  type RunLedgerPort,
  type RunLedgerStatus,
  type RunLedgerV1,
} from "./run-ledger.js";
import {
  runtimeRequestHashV1,
  type RuntimeStoreLeaseProof,
  type RuntimeStorePort,
  type RuntimeStoreRun,
} from "./store-port.js";

/**
 * Host composition of one governed Agent run: the RunLedger, the Memory Port
 * lease, the RunLedger-backed effect receipts and the `memory_read` tool, plus
 * the recovery that has to happen before the Agent may act again.
 *
 * This is Host wiring only. It adds no Agent behaviour and no Kernel fact; the
 * Agent receives the effect port and the tool through its normal options.
 */

export interface GovernedRunSessionHostV1 {
  readonly store: RuntimeStorePort;
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly memory: ContextMemoryDurabilityPort;
}

export interface GovernedRunSessionOptionsV1 {
  readonly host: GovernedRunSessionHostV1;
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly operationEpoch: number;
  /** Owner of the Memory Port lease; unique per process. */
  readonly ownerId: string;
  /**
   * The Agent session lease that fences this process. The ledger commits of
   * the effect receipts carry it, so a replaced owner cannot write.
   */
  readonly runLease: RuntimeStoreLeaseProof;
  readonly memoryLeaseTtlMs: number;
  readonly now?: () => Date;
}

export interface GovernedRunRecoveryV1 {
  /** Artifact intents an earlier process left pending and this open finished. */
  readonly reconciledIntents: readonly string[];
  /** Intents given up on after their grace deadline. */
  readonly abandonedIntents: readonly string[];
  /** Intents that could not be finished yet; the run still starts. */
  readonly pendingIntents: readonly string[];
  /**
   * Effects an earlier attempt began but never finished (intent / unknown).
   * They are reported, never replayed.
   */
  readonly unresolvedEffects: readonly string[];
  readonly missingOperationIds: readonly string[];
  readonly orphanOperationIds: readonly string[];
}

export type GovernedRunSessionFinishStatusV1 =
  | "completed"
  | "failed"
  | "waiting"
  | "cancelled";

export interface GovernedRunSessionV1 {
  readonly runId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly scopeKey: string;
  readonly memoryLease: MemoryLeaseProofV1;
  readonly recovery: GovernedRunRecoveryV1;
  readonly effectReceipts: PactileRunLedgerEffectReceiptPort;
  readonly tools: readonly AgentTool<never, never>[];
  /** Record the end of this attempt in the RunLedger. Idempotent per status. */
  finish(status: GovernedRunSessionFinishStatusV1): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly message: string }
  >;
  /** Release the Memory Port lease. Safe to call more than once. */
  release(): Promise<void>;
}

export type OpenGovernedRunSessionResultV1 =
  | { readonly ok: true; readonly session: GovernedRunSessionV1 }
  | {
      readonly ok: false;
      readonly code:
        | "input_invalid"
        | "memory_lease_failed"
        | "ledger_failed";
      readonly message: string;
    };

function openFailure(
  code: "input_invalid" | "memory_lease_failed" | "ledger_failed",
  message: string,
): OpenGovernedRunSessionResultV1 {
  return { ok: false, code, message };
}

function runLedgerLease(proof: RuntimeStoreLeaseProof): RunLedgerV1["lease"] {
  return { leaseId: proof.leaseId, epoch: proof.epoch, owner: proof.ownerId };
}

/** Does this stored run carry a RunLedger, i.e. was it governed? */
export function runHasLedgerV1(run: RuntimeStoreRun | null): boolean {
  return run?.metadata[RUN_LEDGER_METADATA_KEY] !== undefined;
}

export const DEFAULT_GOVERNED_PROJECT_ID_V1 = "agent-project" as const;

/**
 * The workspace a governed run belongs to when the caller names none: an
 * opaque, stable id of the repository root. The same checkout always maps to
 * the same id (case-folded on Windows, symlinks resolved), so a resumed run
 * finds its own memory scope.
 */
export function defaultGovernedWorkspaceIdV1(repositoryRoot: string): string {
  let canonical = path.resolve(repositoryRoot);
  try {
    canonical = fs.realpathSync.native(canonical);
  } catch {
    // A root that cannot be resolved is still named by its absolute path.
  }
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const digest = crypto
    .createHash("sha256")
    .update(`pactile-workspace-v1\0${canonical}`)
    .digest("hex")
    .slice(0, 16);
  return `workspace-${digest}`;
}

export type GovernedRunScopeSourceV1 = "stored" | "explicit" | "default";

export type ResolveGovernedRunScopeResultV1 =
  | {
      readonly ok: true;
      readonly workspaceId: string;
      readonly projectId: string;
      readonly source: GovernedRunScopeSourceV1;
    }
  | { readonly ok: false; readonly message: string };

function storedScope(
  run: RuntimeStoreRun | null,
): { readonly workspaceId: string; readonly projectId: string } | null {
  const input = run?.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const { workspaceId, projectId } = input as Record<string, unknown>;
  return typeof workspaceId === "string" &&
    typeof projectId === "string" &&
    PACTILE_LOGICAL_ID_PATTERN.test(workspaceId) &&
    PACTILE_LOGICAL_ID_PATTERN.test(projectId)
    ? { workspaceId, projectId }
    : null;
}

/**
 * Which memory scope a governed run uses. The scope is part of where its
 * memory lives, so a run keeps the scope it started with: a resume takes it
 * from the run record, and naming a different one is refused rather than
 * silently pointing the run at memory it never wrote. Only a new run falls
 * back to a default.
 */
export function resolveGovernedRunScopeV1(input: {
  readonly repositoryRoot: string;
  readonly explicitWorkspaceId?: string;
  readonly explicitProjectId?: string;
  readonly existingRun: RuntimeStoreRun | null;
}): ResolveGovernedRunScopeResultV1 {
  const stored = storedScope(input.existingRun);
  if (stored !== null) {
    if (
      (input.explicitWorkspaceId !== undefined && input.explicitWorkspaceId !== stored.workspaceId) ||
      (input.explicitProjectId !== undefined && input.explicitProjectId !== stored.projectId)
    ) {
      return {
        ok: false,
        message: `this run already uses workspace ${stored.workspaceId} and project ${stored.projectId}; a resume cannot change them`,
      };
    }
    return { ok: true, ...stored, source: "stored" };
  }
  if (runHasLedgerV1(input.existingRun)) {
    // A governed run from before the scope was recorded: guessing a default
    // would point it at the wrong memory.
    if (input.explicitWorkspaceId === undefined || input.explicitProjectId === undefined) {
      return {
        ok: false,
        message:
          "this governed run did not record its memory scope; resume it with the --workspace-id and --project-id it was started with",
      };
    }
    return {
      ok: true,
      workspaceId: input.explicitWorkspaceId,
      projectId: input.explicitProjectId,
      source: "explicit",
    };
  }
  const named = input.explicitWorkspaceId !== undefined || input.explicitProjectId !== undefined;
  return {
    ok: true,
    workspaceId: input.explicitWorkspaceId ?? defaultGovernedWorkspaceIdV1(input.repositoryRoot),
    projectId: input.explicitProjectId ?? DEFAULT_GOVERNED_PROJECT_ID_V1,
    source: named ? "explicit" : "default",
  };
}

/**
 * Keep the RunLedger when a caller rewrites the run record. `putRun` replaces
 * the whole record, and the ledger lives in its metadata: a plain overwrite
 * would silently erase it. The ledger is the owner of `revision`.
 */
export function preserveRunLedgerMetadataV1(
  existing: RuntimeStoreRun | null,
  next: RuntimeStoreRun,
): RuntimeStoreRun {
  const ledger = existing?.metadata[RUN_LEDGER_METADATA_KEY];
  if (existing === null || ledger === undefined) return next;
  return {
    ...next,
    revision: existing.revision,
    metadata: { ...next.metadata, [RUN_LEDGER_METADATA_KEY]: ledger },
  };
}

/**
 * Open the governed run: take the Memory Port lease, make sure the RunLedger
 * describes this attempt, finish whatever an earlier process left half done,
 * and build the effect port and tools the Agent will use.
 *
 * The caller must already hold the Agent session lease: it is what makes
 * taking over the Memory Port lease (a higher epoch) safe, because no other
 * live owner can reach this point for the same run.
 */
export async function openGovernedRunSessionV1(
  options: GovernedRunSessionOptionsV1,
): Promise<OpenGovernedRunSessionResultV1> {
  const now = options.now ?? (() => new Date());
  for (const [label, value] of [
    ["runId", options.runId],
    ["workspaceId", options.workspaceId],
    ["projectId", options.projectId],
  ] as const) {
    if (!PACTILE_LOGICAL_ID_PATTERN.test(value)) {
      return openFailure("input_invalid", `${label} must be a lowercase Pactile logical id`);
    }
  }
  if (!Number.isSafeInteger(options.operationEpoch) || options.operationEpoch < 1) {
    return openFailure("input_invalid", "operationEpoch must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.memoryLeaseTtlMs) || options.memoryLeaseTtlMs < 1) {
    return openFailure("input_invalid", "memoryLeaseTtlMs must be a positive safe integer");
  }
  let scopeKey: string;
  try {
    scopeKey = memoryScopeKeyV1({
      scope: "run",
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      runId: options.runId,
    });
  } catch (error) {
    return openFailure(
      "input_invalid",
      error instanceof Error ? error.message : "memory scope is invalid",
    );
  }

  const { host } = options;
  const partition = memoryPartitionV1("run", scopeKey);
  let memoryLease: MemoryLeaseProofV1;
  try {
    const acquired = await host.store.acquireLease({
      partition,
      runId: options.runId,
      ownerId: options.ownerId,
      ttlMs: options.memoryLeaseTtlMs,
      idempotencyKey: `pactile-governed-memory-lease:${options.runId}:${options.ownerId}`,
      requestHash: runtimeRequestHashV1("governed-memory-lease", {
        runId: options.runId,
        ownerId: options.ownerId,
        operationEpoch: options.operationEpoch,
        partition,
      }),
    });
    memoryLease = {
      leaseId: acquired.value.leaseId,
      ownerId: acquired.value.ownerId,
      epoch: acquired.value.epoch,
      expiresAt: acquired.value.expiresAt,
      partition: acquired.value.partition,
    };
  } catch (error) {
    return openFailure(
      "memory_lease_failed",
      error instanceof Error ? error.message : "the Memory Port lease could not be acquired",
    );
  }

  const attemptId = `attempt-${String(options.operationEpoch)}`;
  const turnId = `turn-${String(options.operationEpoch)}`;
  const updatedAt = now().toISOString();

  let ledger: RunLedgerV1;
  try {
    const snapshot = await host.ledger.readRunLedger(options.runId);
    const target = (base: RunLedgerV1 | null): RunLedgerV1 =>
      base === null
        ? {
            schemaVersion: 1,
            ledgerId: `ledger-${options.runId}`,
            commitId: `governed-run:${options.runId}`,
            runId: options.runId,
            activeAttemptId: attemptId,
            activeTurnId: turnId,
            status: "running",
            lease: runLedgerLease(options.runLease),
            lastCursor: null,
            effectOperationIds: [],
            kernelSettlement: { status: "open", receiptId: null },
            dispatchOutboxId: null,
            revision: 1,
            updatedAt,
          }
        : {
            ...base,
            commitId: `${base.commitId}:attempt:${attemptId}`,
            activeAttemptId: attemptId,
            activeTurnId: turnId,
            status: "running",
            lease: runLedgerLease(options.runLease),
            revision: base.revision + 1,
            updatedAt,
          };
    const current = snapshot?.ledger ?? null;
    const alreadyOpen =
      current !== null &&
      current.activeAttemptId === attemptId &&
      current.activeTurnId === turnId &&
      current.status === "running" &&
      current.lease?.leaseId === options.runLease.leaseId &&
      current.lease.epoch === options.runLease.epoch;
    if (alreadyOpen) {
      ledger = current;
    } else {
      const next = target(current);
      const committed = await host.ledger.commitRunLedger({
        idempotencyKey: `pactile-governed-attempt:${options.runId}:${attemptId}:${String(next.revision)}`,
        requestHash: runtimeRequestHashV1("governed-run-attempt", {
          ledger: next as unknown as Record<string, never>,
        }),
        ledger: next,
        effects: [],
        lease: options.runLease,
      });
      ledger = committed.ledger;
    }
  } catch (error) {
    await releaseMemoryLease(host.store, options.ownerId, memoryLease);
    return openFailure(
      "ledger_failed",
      error instanceof Error ? error.message : "the RunLedger could not be opened",
    );
  }

  // Finish what an earlier process left half done before the Agent acts.
  const reconciled = await reconcileContextGovernanceArtifactIntentsV1({
    ledger: host.ledger,
    artifacts: host.artifacts,
    runId: options.runId,
    lease: memoryLease,
    now,
  });
  const after = await host.ledger.readRunLedger(options.runId);
  const unresolvedEffects = (after?.effects ?? [])
    .filter((effect) => effect.status === "intent" || effect.status === "unknown")
    .map((effect) => effect.operationId);
  const recovery: GovernedRunRecoveryV1 = {
    reconciledIntents: reconciled.reconciled,
    abandonedIntents: reconciled.abandoned,
    pendingIntents: reconciled.pending,
    unresolvedEffects,
    missingOperationIds: after?.missingOperationIds ?? [],
    orphanOperationIds: after?.orphanOperationIds ?? [],
  };

  const effectReceipts = new PactileRunLedgerEffectReceiptPort({
    ledger: host.ledger,
    initialLedger: after?.ledger ?? ledger,
    attemptId,
    turnId,
    lease: options.runLease,
    now,
  });
  const tool = createGovernedMemoryReadToolV1({
    memory: host.memory,
    ledger: host.ledger,
    artifacts: host.artifacts,
    scopeKey,
    workspaceId: options.workspaceId,
    runId: options.runId,
    operationEpoch: options.operationEpoch,
    lease: memoryLease,
    attemptId,
    turnId,
    now,
  });

  let released = false;
  return {
    ok: true,
    session: {
      runId: options.runId,
      attemptId,
      turnId,
      scopeKey,
      memoryLease,
      recovery,
      effectReceipts,
      tools: [tool as unknown as AgentTool<never, never>],
      finish: async (status) => {
        try {
          const snapshot = await host.ledger.readRunLedger(options.runId);
          if (snapshot === null) return { ok: false, message: "the RunLedger is missing" };
          const target: RunLedgerStatus = status;
          if (snapshot.ledger.status === target) return { ok: true };
          const next: RunLedgerV1 = {
            ...snapshot.ledger,
            commitId: `${snapshot.ledger.commitId}:finish:${status}`,
            status: target,
            revision: snapshot.ledger.revision + 1,
            updatedAt: now().toISOString(),
          };
          await host.ledger.commitRunLedger({
            idempotencyKey: `pactile-governed-finish:${options.runId}:${attemptId}:${status}:${String(next.revision)}`,
            requestHash: runtimeRequestHashV1("governed-run-finish", {
              ledger: next as unknown as Record<string, never>,
            }),
            ledger: next,
            effects: [],
            lease: options.runLease,
          });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "the RunLedger could not be finished",
          };
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        await releaseMemoryLease(host.store, options.ownerId, memoryLease);
      },
    },
  };
}

async function releaseMemoryLease(
  store: RuntimeStorePort,
  ownerId: string,
  lease: MemoryLeaseProofV1,
): Promise<void> {
  try {
    await store.releaseLease({
      leaseId: lease.leaseId,
      ownerId,
      epoch: lease.epoch,
      idempotencyKey: `pactile-governed-memory-lease-release:${lease.leaseId}`,
      requestHash: runtimeRequestHashV1("governed-memory-lease-release", {
        leaseId: lease.leaseId,
        epoch: lease.epoch,
      }),
    });
  } catch {
    // A lease that cannot be released simply expires; it must not mask the
    // outcome of the run.
  }
}
