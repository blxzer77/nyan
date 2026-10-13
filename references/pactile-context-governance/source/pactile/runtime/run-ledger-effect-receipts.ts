import type {
  PactileEffectAdmissionResultV1,
  PactileEffectCompletionResultV1,
  PactileEffectIntentV1,
  PactileEffectReceiptPort,
  PactileEffectResultSummaryV1,
  PactileEffectStatusV1,
} from "../agent/effects/contract.js";
import {
  runtimeRequestHashV1,
  type RuntimeStoreLeaseProof,
} from "./store-port.js";
import type {
  EffectLedgerEntryV1,
  RunLedgerPort,
  RunLedgerSnapshot,
  RunLedgerV1,
} from "./run-ledger.js";

export interface PactileRunLedgerEffectReceiptOptionsV1 {
  readonly ledger: RunLedgerPort;
  /** Current ledger snapshot. Re-read is performed before each transition. */
  readonly initialLedger: RunLedgerV1;
  readonly attemptId: string;
  readonly turnId: string;
  readonly lease?: RuntimeStoreLeaseProof;
  readonly now?: () => Date;
}

function terminalStatus(
  status: PactileEffectStatusV1,
): EffectLedgerEntryV1["status"] {
  return status === "succeeded"
    ? "success"
    : status === "failed"
      ? "failure"
      : "unknown";
}

function validIdentity(
  intent: PactileEffectIntentV1,
  ledger: RunLedgerV1,
  attemptId: string,
  turnId: string,
): boolean {
  return (
    intent.runId === ledger.runId &&
    intent.toolCallId.trim().length > 0 &&
    intent.toolName.trim().length > 0 &&
    intent.requestHash.startsWith("sha256:") &&
    attemptId.trim().length > 0 &&
    turnId.trim().length > 0 &&
    Number.isSafeInteger(intent.operationEpoch) &&
    intent.operationEpoch > 0
  );
}

function nextLedger(
  ledger: RunLedgerV1,
  operationId: string,
  updatedAt: string,
): RunLedgerV1 {
  return {
    ...ledger,
    commitId: `${ledger.commitId}:effect:${operationId}:${ledger.revision + 1}`,
    effectOperationIds: ledger.effectOperationIds.includes(operationId)
      ? ledger.effectOperationIds
      : [...ledger.effectOperationIds, operationId],
    revision: ledger.revision + 1,
    updatedAt,
  };
}

function failure(
  code:
    | "effect_admission_failed"
    | "effect_receipt_failed"
    | "effect_receipt_unknown"
    | "effect_unknown"
    | "effect_already_completed",
  message: string,
): PactileEffectAdmissionResultV1 | PactileEffectCompletionResultV1 {
  return { ok: false, code, message, replayPolicy: "no_automatic_replay" } as
    | PactileEffectAdmissionResultV1
    | PactileEffectCompletionResultV1;
}

/**
 * Thin EffectGateway seam: effect intent and terminal receipt are committed
 * through the same RunLedger port. It never executes a tool or replays an
 * unknown effect.
 */
export class PactileRunLedgerEffectReceiptPort implements PactileEffectReceiptPort {
  readonly #ledger: RunLedgerPort;
  readonly #attemptId: string;
  readonly #turnId: string;
  readonly #lease: RuntimeStoreLeaseProof | undefined;
  readonly #now: () => Date;
  #state: RunLedgerV1;
  #effectsKnown = true;

  constructor(options: PactileRunLedgerEffectReceiptOptionsV1) {
    this.#ledger = options.ledger;
    this.#state = options.initialLedger;
    this.#attemptId = options.attemptId;
    this.#turnId = options.turnId;
    this.#lease = options.lease;
    this.#now = options.now ?? (() => new Date());
  }

  effectsKnown(): boolean {
    return this.#effectsKnown;
  }

  async begin(
    input: PactileEffectIntentV1,
  ): Promise<PactileEffectAdmissionResultV1> {
    const snapshot = await this.snapshot();
    if (
      snapshot === null ||
      !validIdentity(input, snapshot.ledger, this.#attemptId, this.#turnId)
    ) {
      this.#effectsKnown = false;
      return failure(
        "effect_admission_failed",
        "effect intent does not match the active RunLedger",
      ) as PactileEffectAdmissionResultV1;
    }
    const prior = snapshot.effects.find(
      (entry) => entry.operationId === input.effectId,
    );
    if (prior !== undefined) {
      return failure(
        prior.status === "success"
          ? "effect_already_completed"
          : "effect_unknown",
        prior.status === "success"
          ? "effect already has an exact terminal receipt"
          : "effect has a prior intent or non-exact receipt",
      ) as PactileEffectAdmissionResultV1;
    }
    const createdAt = this.#now().toISOString();
    const entry: EffectLedgerEntryV1 = {
      schemaVersion: 1,
      operationId: input.effectId,
      runId: input.runId,
      attemptId: this.#attemptId,
      turnId: this.#turnId,
      toolCallId: input.toolCallId,
      operationEpoch: input.operationEpoch,
      inputHash: input.requestHash,
      status: "intent",
      receiptId: null,
      idempotencyKey: `pactile-ledger-effect:${input.effectId}`,
      createdAt,
      completedAt: null,
    };
    const ledger = nextLedger(snapshot.ledger, input.effectId, createdAt);
    try {
      const result = await this.#ledger.commitRunLedger({
        idempotencyKey: `pactile-ledger-intent:${input.effectId}:${ledger.revision}`,
        requestHash: runtimeRequestHashV1("run-ledger.effect-intent", {
          ledger,
          entry,
        }),
        ledger,
        effects: [entry],
        ...(this.#lease === undefined ? {} : { lease: this.#lease }),
      });
      this.#state = result.ledger;
      return { ok: true, replay: false, intent: input };
    } catch {
      this.#effectsKnown = false;
      return failure(
        "effect_admission_failed",
        "effect intent could not be durably committed to RunLedger",
      ) as PactileEffectAdmissionResultV1;
    }
  }

  async complete(input: {
    readonly intent: PactileEffectIntentV1;
    readonly status: PactileEffectStatusV1;
    readonly result: PactileEffectResultSummaryV1;
    readonly errorCode?: string;
  }): Promise<PactileEffectCompletionResultV1> {
    const snapshot = await this.snapshot();
    if (
      snapshot === null ||
      !validIdentity(
        input.intent,
        snapshot.ledger,
        this.#attemptId,
        this.#turnId,
      )
    ) {
      this.#effectsKnown = false;
      return failure(
        "effect_receipt_failed",
        "effect completion does not match the active RunLedger",
      ) as PactileEffectCompletionResultV1;
    }
    const prior = snapshot.effects.find(
      (entry) => entry.operationId === input.intent.effectId,
    );
    if (prior === undefined) {
      this.#effectsKnown = false;
      return failure(
        "effect_receipt_unknown",
        "effect intent is absent from RunLedger",
      ) as PactileEffectCompletionResultV1;
    }
    if (prior.status !== "intent") {
      this.#effectsKnown = false;
      return failure(
        "effect_receipt_unknown",
        "effect already has a terminal or unknown receipt",
      ) as PactileEffectCompletionResultV1;
    }
    const completedAt = this.#now().toISOString();
    const entry: EffectLedgerEntryV1 = {
      ...prior,
      status: terminalStatus(input.status),
      completedAt,
    };
    const ledger = nextLedger(
      snapshot.ledger,
      input.intent.effectId,
      completedAt,
    );
    try {
      const result = await this.#ledger.commitRunLedger({
        idempotencyKey: `pactile-ledger-receipt:${input.intent.effectId}:${ledger.revision}`,
        requestHash: runtimeRequestHashV1("run-ledger.effect-receipt", {
          ledger,
          entry,
          result: input.result,
          errorCode: input.errorCode ?? null,
        }),
        ledger,
        effects: [entry],
        ...(this.#lease === undefined ? {} : { lease: this.#lease }),
      });
      this.#state = result.ledger;
      if (input.status === "unknown") this.#effectsKnown = false;
      return { ok: true, status: input.status };
    } catch {
      this.#effectsKnown = false;
      return failure(
        "effect_receipt_failed",
        "effect terminal receipt could not be committed to RunLedger",
      ) as PactileEffectCompletionResultV1;
    }
  }

  async snapshot(): Promise<RunLedgerSnapshot | null> {
    const snapshot = await this.#ledger.readRunLedger(this.#state.runId);
    if (snapshot !== null) this.#state = snapshot.ledger;
    return snapshot;
  }
}
