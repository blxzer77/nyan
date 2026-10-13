import { persistRecordArtifactV1 } from "./context-governance-artifacts.js";
import {
  artifactIntentIdV1,
  persistContextGovernanceArtifactIntentV1,
  plannedArtifactBindingV1,
  priorArtifactIntentCreatedAtV1,
} from "./context-governance-artifact-intents.js";
import type {
  ArtifactStoreBindingV1,
  ArtifactStorePort,
} from "../agent/memory/artifact-store.js";
import type {
  RuntimeStoreJsonObject,
  RuntimeStoreLeaseProof,
} from "./store-port.js";
import { runtimeRequestHashV1 } from "./store-port.js";
import {
  bindContextGovernanceReceiptV1,
  type ContextGovernanceReceiptBindingV1,
} from "./context-governance-receipts.js";
import {
  type EffectLedgerEntryV1,
  type RunLedgerPort,
  type RunLedgerV1,
} from "./run-ledger.js";

export interface PersistContextGovernanceReceiptInputV1 {
  readonly ledger: RunLedgerPort;
  readonly artifacts: ArtifactStorePort;
  readonly receipt: RuntimeStoreJsonObject;
  readonly effect: EffectLedgerEntryV1;
  readonly artifactId: string;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
  readonly lease?: RuntimeStoreLeaseProof;
}

export type PersistContextGovernanceReceiptResultV1 =
  | {
      readonly ok: true;
      readonly applied: boolean;
      readonly binding: ContextGovernanceReceiptBindingV1;
      readonly artifact: ArtifactStoreBindingV1;
      readonly ledger: RunLedgerV1;
    }
  | {
      readonly ok: false;
      readonly code:
        | "receipt_invalid"
        | "ledger_effect_missing"
        | "ledger_effect_conflict"
        | "artifact_prepare_failed"
        | "artifact_commit_failed"
        | "ledger_binding_failed";
      readonly message: string;
    };

function failure(
  code: Exclude<
    PersistContextGovernanceReceiptResultV1,
    { readonly ok: true }
  >["code"],
  message: string,
): PersistContextGovernanceReceiptResultV1 {
  return { ok: false, code, message };
}

function sameEffectIdentity(
  left: EffectLedgerEntryV1,
  right: EffectLedgerEntryV1,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId &&
    left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId &&
    left.operationEpoch === right.operationEpoch &&
    left.inputHash === right.inputHash
  );
}

function hasPayloadBinding(entry: EffectLedgerEntryV1): boolean {
  return (
    typeof entry.payloadType === "string" &&
    typeof entry.payloadHash === "string" &&
    typeof entry.payloadArtifactRef === "string"
  );
}

function ledgerWithReceiptBinding(
  ledger: RunLedgerV1,
  operationId: string,
  now: string,
): RunLedgerV1 {
  return {
    ...ledger,
    commitId: `${ledger.commitId}:context-receipt:${operationId}:${ledger.revision + 1}`,
    revision: ledger.revision + 1,
    updatedAt: now,
  };
}

/**
 * Persist one already-terminal runtime CDR/CAR payload as an immutable
 * artifact, then bind its typed payload metadata to the same RunLedger effect.
 * This is a producer seam; it does not execute compaction or settle a Kernel run.
 */
export async function persistContextGovernanceReceiptV1(
  input: PersistContextGovernanceReceiptInputV1,
): Promise<PersistContextGovernanceReceiptResultV1> {
  let binding: ContextGovernanceReceiptBindingV1;
  try {
    binding = bindContextGovernanceReceiptV1({
      receipt: input.receipt,
      effect: input.effect,
    });
  } catch (error) {
    return failure(
      "receipt_invalid",
      error instanceof Error ? error.message : "context receipt is invalid",
    );
  }
  const receiptRecord = input.receipt as Record<string, unknown>;
  if (
    input.scopeKey !== input.effect.runId ||
    receiptRecord.runId !== input.effect.runId ||
    receiptRecord.attemptId !== input.effect.attemptId ||
    receiptRecord.turnId !== input.effect.turnId ||
    receiptRecord.operationEpoch !== input.effect.operationEpoch
  ) {
    return failure(
      "ledger_effect_conflict",
      "context receipt identity does not match the RunLedger effect",
    );
  }
  if (input.effect.status === "intent") {
    return failure(
      "ledger_effect_conflict",
      "context receipt requires a terminal RunLedger effect",
    );
  }

  const snapshot = await input.ledger.readRunLedger(input.effect.runId);
  if (snapshot === null) {
    return failure("ledger_effect_missing", "RunLedger does not exist");
  }
  const current = snapshot.effects.find(
    (entry) => entry.operationId === input.effect.operationId,
  );
  if (current === undefined) {
    return failure(
      "ledger_effect_missing",
      "RunLedger effect operationId is missing",
    );
  }
  if (
    !sameEffectIdentity(current, input.effect) ||
    current.status !== input.effect.status
  ) {
    return failure(
      "ledger_effect_conflict",
      "RunLedger effect identity or status does not match the receipt",
    );
  }
  if (
    hasPayloadBinding(current) &&
    (current.payloadType !== binding.schemaId ||
      current.payloadHash !== binding.receiptHash)
  ) {
    return failure(
      "ledger_effect_conflict",
      "RunLedger effect is already bound to a different context receipt",
    );
  }

  // A durable plan comes first: the intent records the artifact and the
  // effect binding before any artifact bytes exist, so a crash in between is
  // owned by a pending intent and finished by the reconciler. An effect that
  // an earlier release bound without an intent keeps the older adoption path.
  const intentId = artifactIntentIdV1(
    input.effect.runId,
    `receipt:${current.operationId}`,
  );
  const priorCreatedAt = await priorArtifactIntentCreatedAtV1(
    input.ledger,
    input.effect.runId,
    intentId,
  );
  if (priorCreatedAt !== null || !hasPayloadBinding(current)) {
    const createdAt = priorCreatedAt ?? (binding.receipt.createdAt as string);
    const record = { ...input.receipt, createdAt } as RuntimeStoreJsonObject;
    try {
      bindContextGovernanceReceiptV1({ receipt: record, effect: input.effect });
    } catch (error) {
      return failure(
        "receipt_invalid",
        error instanceof Error ? error.message : "context receipt is invalid",
      );
    }
    const planned = plannedArtifactBindingV1({
      artifactId: input.artifactId,
      scopeKey: input.scopeKey,
      version: input.version,
      basisRevision: input.basisRevision,
      record,
    });
    const bound = await persistContextGovernanceArtifactIntentV1({
      ledger: input.ledger,
      artifacts: input.artifacts,
      intentId,
      runId: input.effect.runId,
      records: [
        {
          artifactId: input.artifactId,
          scopeKey: input.scopeKey,
          version: input.version,
          basisRevision: input.basisRevision,
          record,
        },
      ],
      contextOperations: [],
      effectBindings: [
        {
          operationId: current.operationId,
          payloadType: binding.schemaId,
          payloadHash: binding.receiptHash,
          payloadArtifactRef: planned.storageRef,
        },
      ],
      now: createdAt,
      abandonAfter: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
      ...(input.lease === undefined ? {} : { lease: input.lease }),
    });
    if (!bound.ok) {
      return failure(
        bound.code === "ledger_missing"
          ? "ledger_effect_missing"
          : bound.code === "ledger_conflict" || bound.code === "intent_abandoned"
            ? "ledger_effect_conflict"
            : bound.code === "intent_invalid"
              ? "receipt_invalid"
              : bound.code,
        bound.message,
      );
    }
    return {
      ok: true,
      applied: bound.applied,
      binding,
      artifact: bound.artifacts[0] ?? planned,
      ledger: bound.ledger,
    };
  }

  // Artifact-first. `createdAt` is not part of the receipt hashes, so a retry
  // with a later timestamp adopts the artifact an earlier attempt committed.
  const persisted = await persistRecordArtifactV1({
    artifacts: input.artifacts,
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    artifactId: input.artifactId,
    createdAt: binding.receipt.createdAt as string,
    build: (createdAt) => ({ ...input.receipt, createdAt }),
    validate: (receipt) => {
      bindContextGovernanceReceiptV1({ receipt, effect: input.effect });
    },
  });
  if (!persisted.ok) {
    return failure(
      persisted.code === "record_invalid" ? "receipt_invalid" : persisted.code,
      persisted.message,
    );
  }
  const committed = { identity: persisted.binding };

  const payloadType = binding.schemaId;
  const payloadHash = binding.receiptHash;
  const payloadArtifactRef = committed.identity.storageRef;
  if (
    hasPayloadBinding(current) &&
    (current.payloadArtifactRef !== payloadArtifactRef ||
      current.payloadType !== payloadType ||
      current.payloadHash !== payloadHash)
  ) {
    return failure(
      "ledger_effect_conflict",
      "RunLedger effect payload binding conflicts with the artifact",
    );
  }
  if (hasPayloadBinding(current)) {
    return {
      ok: true,
      applied: false,
      binding,
      artifact: committed.identity,
      ledger: snapshot.ledger,
    };
  }

  const nextEffect: EffectLedgerEntryV1 = {
    ...current,
    payloadType,
    payloadHash,
    payloadArtifactRef,
  };
  const now = new Date().toISOString();
  const nextLedger = ledgerWithReceiptBinding(
    snapshot.ledger,
    current.operationId,
    now,
  );
  try {
    const result = await input.ledger.commitRunLedger({
      idempotencyKey: `pactile-ledger-context-receipt:${current.operationId}:${payloadHash}`,
      requestHash: runtimeRequestHashV1("run-ledger.context-receipt", {
        ledger: nextLedger,
        effect: nextEffect,
        payloadType,
        payloadHash,
        payloadArtifactRef,
      }),
      ledger: nextLedger,
      effects: [nextEffect],
      ...(input.lease === undefined ? {} : { lease: input.lease }),
    });
    return {
      ok: true,
      applied: result.applied,
      binding,
      artifact: committed.identity,
      ledger: result.ledger,
    };
  } catch (error) {
    return failure(
      "ledger_binding_failed",
      error instanceof Error
        ? error.message
        : "RunLedger payload binding failed",
    );
  }
}
