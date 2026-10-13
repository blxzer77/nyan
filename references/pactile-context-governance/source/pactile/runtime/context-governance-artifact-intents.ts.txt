import crypto from "node:crypto";

import {
  compareArtifactStoreBindingsV1,
  formatArtifactStorageRefV1,
  hashArtifactContentV1,
  type ArtifactStoreBindingV1,
  type ArtifactStorePort,
} from "../agent/memory/artifact-store.js";
import { canonicalizePactileJsonV1, fingerprintPactileContractV1 } from "../shared/validation.js";
import type {
  RunLedgerArtifactIntentArtifactV1,
  RunLedgerArtifactIntentEffectBindingV1,
  RunLedgerArtifactIntentV1,
  RunLedgerContextOperationV1,
  RunLedgerEnumerationPort,
  RunLedgerPort,
  RunLedgerV1,
  EffectLedgerEntryV1,
} from "./run-ledger.js";
import {
  runtimeRequestHashV1,
  type RuntimeStoreJsonObject,
  type RuntimeStoreLeaseProof,
  type RuntimeStorePort,
} from "./store-port.js";

export interface ArtifactIntentPlanArtifactV1 {
  readonly artifactId: string;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly record: RuntimeStoreJsonObject;
}

export interface ArtifactIntentPlanV1 {
  readonly intentId: string;
  readonly runId: string;
  readonly records: readonly ArtifactIntentPlanArtifactV1[];
  readonly contextOperations: readonly RunLedgerContextOperationV1[];
  readonly effectBindings: readonly RunLedgerArtifactIntentEffectBindingV1[];
  readonly now: string;
  readonly abandonAfter: string;
  readonly lease?: RuntimeStoreLeaseProof;
}

export type ArtifactIntentFailureCodeV1 =
  | "ledger_missing"
  | "ledger_conflict"
  | "artifact_prepare_failed"
  | "artifact_commit_failed"
  | "ledger_binding_failed"
  | "intent_abandoned"
  | "intent_invalid";

export interface ArtifactIntentFailureV1 {
  readonly ok: false;
  readonly code: ArtifactIntentFailureCodeV1;
  readonly message: string;
  readonly committedArtifacts?: readonly ArtifactStoreBindingV1[];
}

export interface ArtifactIntentSuccessV1 {
  readonly ok: true;
  readonly applied: boolean;
  readonly intent: RunLedgerArtifactIntentV1;
  readonly artifacts: readonly ArtifactStoreBindingV1[];
  readonly ledger: RunLedgerV1;
}

export type ArtifactIntentResultV1 =
  | ArtifactIntentSuccessV1
  | ArtifactIntentFailureV1;

function failure(
  code: ArtifactIntentFailureCodeV1,
  message: string,
  committedArtifacts: readonly ArtifactStoreBindingV1[] = [],
): ArtifactIntentFailureV1 {
  return committedArtifacts.length === 0
    ? { ok: false, code, message }
    : { ok: false, code, message, committedArtifacts };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizePactileJsonV1(left) === canonicalizePactileJsonV1(right);
}

export function plannedArtifactBindingV1(
  input: ArtifactIntentPlanArtifactV1,
): ArtifactStoreBindingV1 {
  const bytes = new TextEncoder().encode(canonicalizePactileJsonV1(input.record));
  const contentHash = hashArtifactContentV1(bytes);
  return {
    artifactId: input.artifactId,
    scope: "run",
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    contentHash,
    byteLength: bytes.byteLength,
    storageRef: formatArtifactStorageRefV1(
      input.artifactId,
      input.version,
      contentHash,
    ),
  };
}

function planArtifact(
  input: ArtifactIntentPlanArtifactV1,
): RunLedgerArtifactIntentArtifactV1 {
  const binding = plannedArtifactBindingV1(input);
  return {
    artifactId: input.artifactId,
    scope: "run",
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    record: input.record,
    binding,
  };
}

/**
 * The pending intent a plan describes, without committing it. For a caller
 * that must make the plan durable in the SAME ledger commit as the fact that
 * justifies it (an approval decision and the grant artifact it implies), so
 * that the plan exists exactly when the decision does.
 */
export function planContextGovernanceArtifactIntentV1(
  input: ArtifactIntentPlanV1,
): RunLedgerArtifactIntentV1 {
  if (input.records.length === 0) throw new TypeError("intent needs an artifact");
  if (input.contextOperations.length === 0 && input.effectBindings.length === 0)
    throw new TypeError("intent needs a ledger binding");
  return intentForPlan(input);
}

function intentForPlan(
  input: ArtifactIntentPlanV1,
  state: "pending" | "bound" | "abandoned" = "pending",
): RunLedgerArtifactIntentV1 {
  return {
    schemaVersion: 1,
    intentId: input.intentId,
    runId: input.runId,
    state,
    createdAt: input.now,
    updatedAt: input.now,
    abandonAfter: input.abandonAfter,
    artifacts: input.records.map(planArtifact),
    contextOperations: input.contextOperations,
    effectBindings: input.effectBindings,
    abandonedAt: state === "abandoned" ? input.now : null,
  };
}

function planWithoutTime(intent: RunLedgerArtifactIntentV1): unknown {
  const { state: _state, createdAt: _createdAt, updatedAt: _updatedAt, abandonedAt: _abandonedAt, ...stable } = intent;
  return stable;
}

function operationMatches(
  left: RunLedgerContextOperationV1,
  right: RunLedgerContextOperationV1,
): boolean {
  return sameJson(left, right);
}

async function commitLedger(
  ledger: RunLedgerPort,
  snapshot: { readonly ledger: RunLedgerV1; readonly effects: readonly EffectLedgerEntryV1[] },
  nextLedger: RunLedgerV1,
  effects: readonly EffectLedgerEntryV1[],
  action: string,
  lease: RuntimeStoreLeaseProof | undefined,
): Promise<ArtifactIntentResultV1 | { readonly ok: true; readonly applied: boolean; readonly ledger: RunLedgerV1 }> {
  try {
    const result = await ledger.commitRunLedger({
      idempotencyKey: `pactile-artifact-intent:${action}:${nextLedger.runId}:${nextLedger.revision}`,
      requestHash: runtimeRequestHashV1("run-ledger.artifact-intent", {
        action,
        ledger: nextLedger,
        effects,
        expectedRevision: snapshot.ledger.revision,
      }),
      ledger: nextLedger,
      effects,
      ...(lease === undefined ? {} : { lease }),
    });
    return { ok: true, applied: result.applied, ledger: result.ledger };
  } catch (error) {
    return failure(
      "ledger_binding_failed",
      error instanceof Error ? error.message : "artifact intent ledger mutation failed",
    );
  }
}

/**
 * Record the complete recovery plan before touching the ArtifactStore. A
 * repeated plan is idempotent; a different plan for the same intent or
 * artifact identity is a conflict.
 */
export async function openContextGovernanceArtifactIntentV1(
  input: ArtifactIntentPlanV1 & { readonly ledger: RunLedgerPort },
): Promise<ArtifactIntentResultV1> {
  let planned: RunLedgerArtifactIntentV1;
  try {
    if (input.records.length === 0) throw new TypeError("intent needs an artifact");
    if (input.contextOperations.length === 0 && input.effectBindings.length === 0)
      throw new TypeError("intent needs a ledger binding");
    planned = intentForPlan(input);
  } catch (error) {
    return failure(
      "intent_invalid",
      error instanceof Error ? error.message : "artifact intent is invalid",
    );
  }
  let snapshot;
  try {
    snapshot = await input.ledger.readRunLedger(input.runId);
  } catch (error) {
    return failure("ledger_binding_failed", error instanceof Error ? error.message : "RunLedger read failed");
  }
  if (snapshot === null) return failure("ledger_missing", "RunLedger does not exist");
  const intents = snapshot.ledger.artifactIntents ?? [];
  const prior = intents.find((intent) => intent.intentId === input.intentId);
  if (prior !== undefined) {
    if (!sameJson(planWithoutTime(prior), planWithoutTime(planned)))
      return failure("ledger_conflict", "artifact intent already contains a different plan");
    if (prior.state === "abandoned")
      return failure("intent_abandoned", "artifact intent was abandoned and needs a new operation id");
    return {
      ok: true,
      applied: false,
      intent: prior,
      artifacts: prior.artifacts.map((artifact) => artifact.binding),
      ledger: snapshot.ledger,
    };
  }
  for (const existing of intents) {
    if (
      existing.artifacts.some((artifact) =>
        planned.artifacts.some((candidate) => candidate.artifactId === artifact.artifactId),
      )
    ) {
      return failure("ledger_conflict", "artifact identity is already owned by another intent");
    }
  }
  const nextLedger: RunLedgerV1 = {
    ...snapshot.ledger,
    artifactIntents: [...intents, planned],
    commitId: `${snapshot.ledger.commitId}:artifact-intent:${input.intentId}`,
    revision: snapshot.ledger.revision + 1,
    updatedAt: input.now,
  };
  const committed = await commitLedger(
    input.ledger,
    snapshot,
    nextLedger,
    snapshot.effects,
    "open",
    input.lease,
  );
  if (!committed.ok) return committed;
  return {
    ok: true,
    applied: committed.applied,
    intent: planned,
    artifacts: planned.artifacts.map((artifact) => artifact.binding),
    ledger: committed.ledger,
  };
}

async function writePlannedArtifacts(
  artifacts: ArtifactStorePort,
  intent: RunLedgerArtifactIntentV1,
): Promise<
  | { readonly ok: true; readonly bindings: readonly ArtifactStoreBindingV1[] }
  | ArtifactIntentFailureV1
> {
  const written: ArtifactStoreBindingV1[] = [];
  for (const artifact of intent.artifacts) {
    const bytes = new TextEncoder().encode(canonicalizePactileJsonV1(artifact.record));
    const prepared = await artifacts.prepare({
      artifactId: artifact.artifactId,
      scope: artifact.scope,
      scopeKey: artifact.scopeKey,
      version: artifact.version,
      basisRevision: artifact.basisRevision,
      content: bytes,
      expectedContentHash: artifact.binding.contentHash,
    });
    if (!prepared.ok) {
      return failure("artifact_prepare_failed", prepared.message, written);
    }
    const committed = await artifacts.commitImmutable({
      artifactId: artifact.artifactId,
      scope: artifact.scope,
      scopeKey: artifact.scopeKey,
      version: artifact.version,
      basisRevision: artifact.basisRevision,
      contentHash: artifact.binding.contentHash,
      byteLength: artifact.binding.byteLength,
    });
    if (!committed.ok) {
      return failure("artifact_commit_failed", committed.message, written);
    }
    // A replay returns the stored object record (binding plus commit
    // metadata), so compare the binding fields, not the whole value.
    if (compareArtifactStoreBindingsV1(artifact.binding, committed.identity) !== null) {
      return failure("artifact_commit_failed", "ArtifactStore returned a different binding", written);
    }
    written.push(artifact.binding);
  }
  return { ok: true, bindings: written };
}

function effectWithBinding(
  effect: EffectLedgerEntryV1,
  binding: RunLedgerArtifactIntentEffectBindingV1,
): EffectLedgerEntryV1 | null {
  if (
    effect.payloadType !== undefined &&
    effect.payloadType !== null &&
    (effect.payloadType !== binding.payloadType ||
      effect.payloadHash !== binding.payloadHash ||
      effect.payloadArtifactRef !== binding.payloadArtifactRef)
  )
    return null;
  return {
    ...effect,
    payloadType: binding.payloadType,
    payloadHash: binding.payloadHash,
    payloadArtifactRef: binding.payloadArtifactRef,
  };
}

/** Write every planned artifact and atomically bind the intent's ledger facts. */
export async function completeContextGovernanceArtifactIntentV1(
  input: {
    readonly ledger: RunLedgerPort;
    readonly artifacts: ArtifactStorePort;
    readonly runId: string;
    readonly intentId: string;
    readonly lease?: RuntimeStoreLeaseProof;
  },
): Promise<ArtifactIntentResultV1> {
  const snapshot = await input.ledger.readRunLedger(input.runId);
  if (snapshot === null) return failure("ledger_missing", "RunLedger does not exist");
  const intent = (snapshot.ledger.artifactIntents ?? []).find(
    (candidate) => candidate.intentId === input.intentId,
  );
  if (intent === undefined) return failure("ledger_conflict", "artifact intent is missing");
  if (intent.state === "abandoned") return failure("intent_abandoned", "artifact intent was abandoned");
  if (intent.state === "bound") {
    return {
      ok: true,
      applied: false,
      intent,
      artifacts: intent.artifacts.map((artifact) => artifact.binding),
      ledger: snapshot.ledger,
    };
  }
  const written = await writePlannedArtifacts(input.artifacts, intent);
  if (!written.ok) return written;

  const existingOperations = snapshot.ledger.contextOperations ?? [];
  for (const planned of intent.contextOperations) {
    const current = existingOperations.find(
      (entry) => entry.contextOperationId === planned.contextOperationId,
    );
    if (current !== undefined && !operationMatches(current, planned))
      return failure("ledger_conflict", "Context Operation is already bound to another record", written.bindings);
  }
  const operations = [
    ...existingOperations,
    ...intent.contextOperations.filter(
      (planned) =>
        !existingOperations.some((current) => operationMatches(current, planned)),
    ),
  ];
  const changedEffects: EffectLedgerEntryV1[] = [];
  for (const binding of intent.effectBindings) {
    const effect = snapshot.effects.find(
      (candidate) => candidate.operationId === binding.operationId,
    );
    if (effect === undefined)
      return failure(
        "ledger_conflict",
        "Effect binding operation is missing",
        written.bindings,
      );
    const next = effectWithBinding(effect, binding);
    if (next === null)
      return failure(
        "ledger_conflict",
        "Effect payload binding conflicts with the artifact intent",
        written.bindings,
      );
    if (!sameJson(next, effect)) changedEffects.push(next);
  }
  const now = new Date().toISOString();
  const boundIntent: RunLedgerArtifactIntentV1 = {
    ...intent,
    state: "bound",
    updatedAt: now,
    abandonedAt: null,
  };
  const nextLedger: RunLedgerV1 = {
    ...snapshot.ledger,
    contextOperations: operations,
    artifactIntents: (snapshot.ledger.artifactIntents ?? []).map((candidate) =>
      candidate.intentId === intent.intentId ? boundIntent : candidate,
    ),
    commitId: `${snapshot.ledger.commitId}:artifact-bind:${intent.intentId}`,
    revision: snapshot.ledger.revision + 1,
    updatedAt: now,
  };
  const committed = await commitLedger(
    input.ledger,
    snapshot,
    nextLedger,
    changedEffects,
    "bind",
    input.lease,
  );
  if (!committed.ok) return { ...committed, committedArtifacts: written.bindings };
  return {
    ok: true,
    applied: committed.applied,
    intent: boundIntent,
    artifacts: written.bindings,
    ledger: committed.ledger,
  };
}

export async function persistContextGovernanceArtifactIntentV1(
  input: ArtifactIntentPlanV1 & {
    readonly ledger: RunLedgerPort;
    readonly artifacts: ArtifactStorePort;
  },
): Promise<ArtifactIntentResultV1> {
  const opened = await openContextGovernanceArtifactIntentV1(input);
  if (!opened.ok) return opened;
  if (opened.intent.state === "bound") return opened;
  const completed = await completeContextGovernanceArtifactIntentV1({
    ledger: input.ledger,
    artifacts: input.artifacts,
    runId: input.runId,
    intentId: input.intentId,
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
  return completed;
}

export interface ReconcileContextGovernanceArtifactIntentsInputV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly runId: string;
  readonly now?: () => Date;
  readonly lease?: RuntimeStoreLeaseProof;
}

export interface ReconcileContextGovernanceArtifactIntentsResultV1 {
  readonly ok: boolean;
  readonly reconciled: readonly string[];
  readonly abandoned: readonly string[];
  readonly pending: readonly string[];
  /**
   * Why an intent that is still pending could not be finished this time (a
   * replaced lease, a store error, missing bytes). Empty when nothing failed.
   */
  readonly failures: readonly {
    readonly intentId: string;
    readonly code: ArtifactIntentFailureCodeV1;
    readonly message: string;
  }[];
  readonly ledger: RunLedgerV1 | null;
}

/**
 * Re-drive pending plans. A fresh failure remains pending for a later retry;
 * only a plan beyond its explicit grace deadline may be abandoned. Competing
 * writers are fenced by the ordinary RunLedger revision transition.
 */
export async function reconcileContextGovernanceArtifactIntentsV1(
  input: ReconcileContextGovernanceArtifactIntentsInputV1,
): Promise<ReconcileContextGovernanceArtifactIntentsResultV1> {
  let snapshot = await input.ledger.readRunLedger(input.runId);
  if (snapshot === null) {
    return { ok: false, reconciled: [], abandoned: [], pending: [], failures: [], ledger: null };
  }
  const reconciled: string[] = [];
  const abandoned: string[] = [];
  const lastFailure = new Map<
    string,
    { readonly code: ArtifactIntentFailureCodeV1; readonly message: string }
  >();
  const now = (input.now ?? (() => new Date()))();
  for (const intent of snapshot.ledger.artifactIntents ?? []) {
    if (intent.state !== "pending") continue;
    const result = await completeContextGovernanceArtifactIntentV1({
      ledger: input.ledger,
      artifacts: input.artifacts,
      runId: input.runId,
      intentId: intent.intentId,
      ...(input.lease === undefined ? {} : { lease: input.lease }),
    });
    if (result.ok) {
      reconciled.push(intent.intentId);
      snapshot = (await input.ledger.readRunLedger(input.runId)) ?? snapshot;
      continue;
    }
    lastFailure.set(intent.intentId, {
      code: result.code,
      message: result.message.slice(0, 200),
    });
    if (Date.parse(intent.abandonAfter) <= now.getTime()) {
      const current = await input.ledger.readRunLedger(input.runId);
      if (current === null) continue;
      const currentIntent = (current.ledger.artifactIntents ?? []).find(
        (candidate) => candidate.intentId === intent.intentId,
      );
      if (currentIntent?.state !== "pending") continue;
      const abandonedIntent: RunLedgerArtifactIntentV1 = {
        ...currentIntent,
        state: "abandoned",
        updatedAt: now.toISOString(),
        abandonedAt: now.toISOString(),
      };
      const nextLedger: RunLedgerV1 = {
        ...current.ledger,
        artifactIntents: (current.ledger.artifactIntents ?? []).map((candidate) =>
          candidate.intentId === intent.intentId ? abandonedIntent : candidate,
        ),
        commitId: `${current.ledger.commitId}:artifact-abandon:${intent.intentId}`,
        revision: current.ledger.revision + 1,
        updatedAt: now.toISOString(),
      };
      const committed = await commitLedger(
        input.ledger,
        current,
        nextLedger,
        [],
        "abandon",
        input.lease,
      );
      if (committed.ok) abandoned.push(intent.intentId);
    }
  }
  const final = await input.ledger.readRunLedger(input.runId);
  const pending = (final?.ledger.artifactIntents ?? [])
    .filter((intent) => intent.state === "pending")
    .map((intent) => intent.intentId);
  return {
    ok: true,
    reconciled,
    abandoned,
    pending,
    failures: pending.flatMap((intentId) => {
      const why = lastFailure.get(intentId);
      return why === undefined ? [] : [{ intentId, ...why }];
    }),
    ledger: final?.ledger ?? null,
  };
}

export type ReconcileAllRunActionV1 =
  /** The run holds an unexpired lease: its owner may be running; untouched. */
  | "skipped_live"
  /** Dry run: pending intents were found and nothing was changed. */
  | "reported"
  /** The run's own reconciler ran; see the lists for what it did. */
  | "reconciled"
  | "failed";

export interface ReconcileAllRunResultV1 {
  readonly runId: string;
  readonly action: ReconcileAllRunActionV1;
  readonly pendingBefore: readonly string[];
  readonly reconciled: readonly string[];
  readonly abandoned: readonly string[];
  /** Still pending after this scan. */
  readonly pending: readonly string[];
  readonly leaseExpiresAt: string | null;
  readonly message: string | null;
}

export interface ReconcileAllContextGovernanceArtifactIntentsInputV1 {
  readonly ledger: RunLedgerPort & RunLedgerEnumerationPort;
  readonly artifacts: ArtifactStorePort;
  readonly now?: () => Date;
  /**
   * Fences the writes. The store checks a lease against the run it writes, so
   * the scan takes a short lease on each run it finishes and gives it back.
   * Without it only the ledger's own revision transition guards the writes.
   */
  readonly leases?: {
    readonly store: Pick<RuntimeStorePort, "acquireLease" | "releaseLease">;
    readonly ownerId: string;
    readonly ttlMs?: number;
  };
  /** Report the runs that need work and change nothing. */
  readonly dryRun?: boolean;
  readonly pageSize?: number;
  /** Runs this process owns; they are never scanned. */
  readonly excludeRunIds?: readonly string[];
}

export interface ReconcileAllContextGovernanceArtifactIntentsResultV1 {
  /** Ledgers looked at, with or without pending intents. */
  readonly scanned: number;
  /** Only runs with pending intents are listed. */
  readonly runs: readonly ReconcileAllRunResultV1[];
}

/**
 * Finish what crashed owners left pending, across every stored run.
 *
 * The per-run reconciler is unchanged; this only decides which runs to hand
 * it. A run whose store lease has not expired is skipped: its owner may be
 * mid-write, and a scan must not move a live run's ledger revision under it.
 * A crashed owner's lease stays until it expires, so such a run becomes
 * eligible only after that. An unreadable expiry counts as live.
 *
 * Because the scan holds a lease on a run only while it works on it, a second
 * scan that reaches the same run meanwhile sees a live lease and skips it.
 *
 * A run whose intents could not be finished this time (a replaced lease fences
 * every write, a store error) is reported as `failed` with the reason, not as
 * done.
 */
export async function reconcileAllContextGovernanceArtifactIntentsV1(
  input: ReconcileAllContextGovernanceArtifactIntentsInputV1,
): Promise<ReconcileAllContextGovernanceArtifactIntentsResultV1> {
  const now = (input.now ?? (() => new Date()))();
  const excluded = new Set(input.excludeRunIds ?? []);
  const runs: ReconcileAllRunResultV1[] = [];
  let scanned = 0;
  let after: string | undefined;
  for (;;) {
    const page = await input.ledger.listRunLedgers({
      ...(after === undefined ? {} : { after }),
      ...(input.pageSize === undefined ? {} : { limit: input.pageSize }),
    });
    for (const entry of page.entries) {
      if (excluded.has(entry.runId)) continue;
      scanned += 1;
      if (entry.pendingArtifactIntentIds.length === 0) continue;
      const expiry =
        entry.leaseExpiresAt === null ? null : Date.parse(entry.leaseExpiresAt);
      const live =
        entry.leaseExpiresAt !== null &&
        (expiry === null || Number.isNaN(expiry) || expiry > now.getTime());
      const base = {
        runId: entry.runId,
        pendingBefore: entry.pendingArtifactIntentIds,
        leaseExpiresAt: entry.leaseExpiresAt,
      };
      if (live) {
        runs.push({
          ...base,
          action: "skipped_live",
          reconciled: [],
          abandoned: [],
          pending: entry.pendingArtifactIntentIds,
          message: null,
        });
        continue;
      }
      if (input.dryRun === true) {
        runs.push({
          ...base,
          action: "reported",
          reconciled: [],
          abandoned: [],
          pending: entry.pendingArtifactIntentIds,
          message: null,
        });
        continue;
      }
      let lease: RuntimeStoreLeaseProof | undefined;
      try {
        if (input.leases !== undefined) {
          const token = crypto.randomUUID();
          const acquired = await input.leases.store.acquireLease({
            partition: `context-governance-reconcile:${entry.runId}`,
            runId: entry.runId,
            ownerId: input.leases.ownerId,
            ttlMs: input.leases.ttlMs ?? 5 * 60_000,
            idempotencyKey: `pactile-reconcile-lease:${entry.runId}:${token}`,
            requestHash: runtimeRequestHashV1("context-governance-reconcile-lease", {
              runId: entry.runId,
              ownerId: input.leases.ownerId,
              token,
            }),
          });
          lease = {
            partition: acquired.value.partition,
            leaseId: acquired.value.leaseId,
            ownerId: acquired.value.ownerId,
            epoch: acquired.value.epoch,
          };
        }
        const result = await reconcileContextGovernanceArtifactIntentsV1({
          ledger: input.ledger,
          artifacts: input.artifacts,
          runId: entry.runId,
          now: () => now,
          ...(lease === undefined ? {} : { lease }),
        });
        const firstFailure = result.failures[0];
        runs.push({
          ...base,
          action: result.ok && firstFailure === undefined ? "reconciled" : "failed",
          reconciled: result.reconciled,
          abandoned: result.abandoned,
          pending: result.pending,
          message: !result.ok
            ? "the run's RunLedger could not be read"
            : firstFailure === undefined
              ? null
              : `${firstFailure.code}: ${firstFailure.message}`,
        });
      } catch (error) {
        runs.push({
          ...base,
          action: "failed",
          reconciled: [],
          abandoned: [],
          pending: entry.pendingArtifactIntentIds,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      } finally {
        if (lease !== undefined && input.leases !== undefined) {
          try {
            await input.leases.store.releaseLease({
              leaseId: lease.leaseId,
              ownerId: lease.ownerId,
              epoch: lease.epoch,
              idempotencyKey: `pactile-reconcile-lease-release:${lease.leaseId}`,
              requestHash: runtimeRequestHashV1("context-governance-reconcile-lease-release", {
                leaseId: lease.leaseId,
              }),
            });
          } catch {
            // A lease that cannot be released simply expires.
          }
        }
      }
    }
    if (page.next === null) return { scanned, runs };
    after = page.next;
  }
}

export function artifactIntentIdV1(
  runId: string,
  logicalOperationId: string,
): string {
  return `artifact-intent-${fingerprintPactileContractV1({
    domain: "pactile-artifact-intent-v1",
    runId,
    logicalOperationId,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
}

/**
 * A record embeds `createdAt`, so the plan of a retry built with a later clock
 * would differ from the plan an earlier attempt already made durable. A retry
 * of the same logical operation therefore builds its records with the
 * `createdAt` of the existing intent; a genuinely different request still
 * produces a different plan and conflicts.
 */
export async function priorArtifactIntentCreatedAtV1(
  ledger: RunLedgerPort,
  runId: string,
  intentId: string,
): Promise<string | null> {
  try {
    const snapshot = await ledger.readRunLedger(runId);
    return (
      snapshot?.ledger.artifactIntents?.find(
        (intent) => intent.intentId === intentId,
      )?.createdAt ?? null
    );
  } catch {
    return null;
  }
}