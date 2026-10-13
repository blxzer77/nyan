import { fingerprintPactileContractV1 } from "../../shared/validation.js";
import type { AgentToolResult } from "../pi/types.js";

export type PactileEffectStatusV1 = "succeeded" | "failed" | "unknown";

export interface PactileEffectLeaseProofV1 {
  readonly partition: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly epoch: number;
}

export interface PactileEffectIntentV1 {
  readonly runId: string;
  readonly effectId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requestHash: string;
  readonly operationEpoch: number;
  readonly lease?: PactileEffectLeaseProofV1;
}

export interface PactileEffectResultSummaryV1 {
  readonly isError: boolean;
  readonly contentHash: string;
  readonly detailsHash: string;
  readonly durationMs: number | null;
}

export type PactileEffectAdmissionResultV1 =
  | { readonly ok: true; readonly replay: false; readonly intent: PactileEffectIntentV1 }
  | {
      readonly ok: false;
      readonly code:
        | "effect_already_completed"
        | "effect_unknown"
        | "effect_admission_failed";
      readonly message: string;
      readonly replayPolicy: "no_automatic_replay";
    };

export type PactileEffectCompletionResultV1 =
  | { readonly ok: true; readonly status: PactileEffectStatusV1 }
  | {
      readonly ok: false;
      readonly code: "effect_receipt_unknown" | "effect_receipt_failed";
      readonly message: string;
      readonly replayPolicy: "no_automatic_replay";
    };

export function createPactileEffectIntentV1(input: {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly operationEpoch: number;
  readonly lease?: PactileEffectLeaseProofV1;
}): PactileEffectIntentV1 {
  const effectId = `effect-${fingerprintPactileContractV1({
    domain: "pactile-agent-effect-v1",
    runId: input.runId,
    toolCallId: input.toolCallId,
  }).slice("sha256:".length, "sha256:".length + 40)}`;
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

export interface PactileEffectReceiptPort {
  /** Durable admission. A prior pending/unknown effect must never be replayed. */
  begin(input: PactileEffectIntentV1): Promise<PactileEffectAdmissionResultV1>;
  /** Durable terminal receipt. Unknown is intentionally conservative. */
  complete(input: {
    readonly intent: PactileEffectIntentV1;
    readonly status: PactileEffectStatusV1;
    readonly result: PactileEffectResultSummaryV1;
    readonly errorCode?: string;
  }): Promise<PactileEffectCompletionResultV1>;
  /** False after any effect whose outcome cannot be proven exact. */
  effectsKnown(): boolean;
}

/**
 * A tool whose error result describes a refusal it fully understands (nothing
 * unrecorded happened) marks it with this key in `details`. The effect then
 * completes as `failed` instead of the conservative `unknown`. Tools that
 * throw, or that cannot vouch for their side effects, never carry it.
 */
export const PACTILE_TOOL_OUTCOME_KNOWN_KEY_V1 = "pactileOutcomeKnown" as const;

export function isPactileKnownToolFailureV1(
  result: AgentToolResult<unknown>,
): boolean {
  const details = result.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as Record<string, unknown>)[PACTILE_TOOL_OUTCOME_KNOWN_KEY_V1] ===
      true
  );
}

/** Create a secret-safe result summary without persisting tool payloads. */
export function summarizePactileToolResultV1(
  result: AgentToolResult<unknown>,
  isError: boolean,
  durationMs: number | undefined,
  hash: (value: unknown) => string,
): PactileEffectResultSummaryV1 {
  return Object.freeze({
    isError,
    contentHash: hash(result.content ?? []),
    detailsHash: hash(result.details ?? null),
    durationMs: durationMs ?? null,
  });
}
