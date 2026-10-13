import {
  fingerprintPactileContractV1,
  PACTILE_LOGICAL_ID_PATTERN,
} from "../shared/validation.js";
import type {
  RuntimeStoreEffectReceipt,
  RuntimeStoreJsonValue,
  RuntimeStoreLeaseProof,
  RuntimeStorePort,
} from "./store-port.js";
import type {
  PactileEffectAdmissionResultV1,
  PactileEffectCompletionResultV1,
  PactileEffectIntentV1,
  PactileEffectLeaseProofV1,
  PactileEffectReceiptPort,
  PactileEffectResultSummaryV1,
  PactileEffectStatusV1,
} from "../agent/effects/contract.js";

function asRuntimeLease(
  value: PactileEffectLeaseProofV1 | undefined,
): RuntimeStoreLeaseProof | undefined {
  return value === undefined ? undefined : { ...value };
}

function safeText(value: string, label: string): string {
  if (!PACTILE_LOGICAL_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase Pactile logical id`);
  }
  return value;
}

function effectIdFor(runId: string, toolCallId: string): string {
  return `effect-${fingerprintPactileContractV1({
    domain: "pactile-agent-effect-v1",
    runId,
    toolCallId,
  }).slice("sha256:".length, "sha256:".length + 40)}`;
}

function effectMutationHash(
  operation: string,
  intent: PactileEffectIntentV1,
  status?: PactileEffectStatusV1,
): string {
  return fingerprintPactileContractV1({
    domain: "pactile-agent-effect-mutation-v1",
    operation,
    intent,
    status: status ?? null,
  });
}

function toRuntimeSummary(
  summary: PactileEffectResultSummaryV1,
): RuntimeStoreJsonValue {
  return {
    isError: summary.isError,
    contentHash: summary.contentHash,
    detailsHash: summary.detailsHash,
    durationMs: summary.durationMs,
  };
}

function errorRecord(code: string | undefined): {
  readonly code: string;
  readonly message: string;
  readonly details: null;
} | null {
  return code === undefined
    ? null
    : { code: code.slice(0, 128), message: "Pactile tool effect did not complete exactly", details: null };
}

export interface PactileRuntimeEffectReceiptOptionsV1 {
  readonly store: RuntimeStorePort;
  readonly runId: string;
  readonly operationEpoch: number;
  readonly lease?: PactileEffectLeaseProofV1;
}

/** RuntimeStore-backed effect intent/receipt adapter for the native Agent. */
export class PactileRuntimeEffectReceiptPort implements PactileEffectReceiptPort {
  readonly #store: RuntimeStorePort;
  readonly #runId: string;
  readonly #operationEpoch: number;
  readonly #lease?: PactileEffectLeaseProofV1;
  #effectsKnown = true;

  constructor(options: PactileRuntimeEffectReceiptOptionsV1) {
    this.#store = options.store;
    this.#runId = safeText(options.runId, "runId");
    if (!Number.isSafeInteger(options.operationEpoch) || options.operationEpoch < 1) {
      throw new TypeError("operationEpoch must be a positive safe integer");
    }
    this.#operationEpoch = options.operationEpoch;
    this.#lease = options.lease;
  }

  effectsKnown(): boolean {
    return this.#effectsKnown;
  }

  async begin(input: PactileEffectIntentV1): Promise<PactileEffectAdmissionResultV1> {
    if (!this.validIntent(input)) {
      this.#effectsKnown = false;
      return {
        ok: false,
        code: "effect_admission_failed",
        message: "effect intent does not match the active Pactile run",
        replayPolicy: "no_automatic_replay",
      };
    }
    const prior = await this.#store.getEffect(input.effectId);
    if (prior !== null) {
      if (prior.status === "succeeded") {
        return {
          ok: false,
          code: "effect_already_completed",
          message: "effect already has an exact terminal receipt; automatic replay is disabled",
          replayPolicy: "no_automatic_replay",
        };
      }
      this.#effectsKnown = false;
      return {
        ok: false,
        code: "effect_unknown",
        message: "effect has a pending or unknown receipt; reconciliation is required before replay",
        replayPolicy: "no_automatic_replay",
      };
    }
    const receipt: RuntimeStoreEffectReceipt = {
      schemaVersion: 1,
      effectId: input.effectId,
      runId: input.runId,
      status: "pending",
      assurance: "assurance_unknown",
      result: null,
      error: null,
      requestHash: input.requestHash,
      recordedAt: new Date().toISOString(),
    };
    try {
      await this.#store.putEffect({
        idempotencyKey: `pactile-effect-begin:${input.effectId}`,
        requestHash: effectMutationHash("begin", input),
        receipt,
        lease: asRuntimeLease(input.lease ?? this.#lease),
      });
      return { ok: true, replay: false, intent: input };
    } catch {
      this.#effectsKnown = false;
      return {
        ok: false,
        code: "effect_admission_failed",
        message: "effect intent could not be durably admitted",
        replayPolicy: "no_automatic_replay",
      };
    }
  }

  async complete(input: {
    readonly intent: PactileEffectIntentV1;
    readonly status: PactileEffectStatusV1;
    readonly result: PactileEffectResultSummaryV1;
    readonly errorCode?: string;
  }): Promise<PactileEffectCompletionResultV1> {
    if (!this.validIntent(input.intent)) {
      this.#effectsKnown = false;
      return {
        ok: false,
        code: "effect_receipt_failed",
        message: "effect completion does not match the active Pactile run",
        replayPolicy: "no_automatic_replay",
      };
    }
    if (input.status === "unknown") this.#effectsKnown = false;
    const receipt: RuntimeStoreEffectReceipt = {
      schemaVersion: 1,
      effectId: input.intent.effectId,
      runId: input.intent.runId,
      status: input.status,
      assurance: input.status === "succeeded" ? "assurance_exact" : "assurance_unknown",
      result: toRuntimeSummary(input.result),
      error: errorRecord(input.errorCode),
      requestHash: input.intent.requestHash,
      recordedAt: new Date().toISOString(),
    };
    try {
      await this.#store.putEffect({
        idempotencyKey: `pactile-effect-complete:${input.intent.effectId}:${input.status}`,
        requestHash: effectMutationHash("complete", input.intent, input.status),
        receipt,
        lease: asRuntimeLease(input.intent.lease ?? this.#lease),
      });
      return { ok: true, status: input.status };
    } catch {
      this.#effectsKnown = false;
      return {
        ok: false,
        code: "effect_receipt_failed",
        message: "effect terminal receipt could not be durably recorded",
        replayPolicy: "no_automatic_replay",
      };
    }
  }

  private validIntent(input: PactileEffectIntentV1): boolean {
    return (
      input.runId === this.#runId &&
      input.operationEpoch === this.#operationEpoch &&
      input.effectId === effectIdFor(input.runId, input.toolCallId) &&
      input.requestHash.startsWith("sha256:") &&
      input.toolName.trim().length > 0
    );
  }
}

export function pactileEffectIntentV1(input: {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly operationEpoch: number;
  readonly lease?: PactileEffectLeaseProofV1;
}): PactileEffectIntentV1 {
  const effectId = effectIdFor(input.runId, input.toolCallId);
  return Object.freeze({
    runId: input.runId,
    effectId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    requestHash: fingerprintPactileContractV1({
      domain: "pactile-agent-effect-request-v1",
      runId: input.runId,
      effectId,
      toolName: input.toolName,
      args: input.args,
    }),
    operationEpoch: input.operationEpoch,
    ...(input.lease === undefined ? {} : { lease: input.lease }),
  });
}
