import { Type, type Static } from "typebox";

import { PACTILE_TOOL_OUTCOME_KNOWN_KEY_V1 } from "../effects/contract.js";
import type { AgentTool, AgentToolResult } from "../pi/types.js";

export const PACTILE_MEMORY_READ_TOOL_NAME_V1 = "memory_read" as const;

export interface PactileMemoryReadFactV1 {
  readonly factId: string;
  readonly statement: string;
  readonly tags: readonly string[];
  readonly factHash: string;
}

export interface PactileMemoryReadSummaryV1 {
  readonly summaryId: string;
  readonly statement: string;
  readonly derivedFrom: readonly string[];
}

/** How the Host recorded the operation; the Agent only reports it. */
export type PactileMemoryReadRecordingV1 =
  | "recorded"
  | "not_representable"
  | "record_failed"
  | "none";

export type PactileMemoryReadOutcomeV1 =
  | {
      readonly ok: true;
      readonly contextOperationId: string;
      readonly basisRevision: number;
      readonly manifestRevision: number;
      readonly contentHash: string;
      readonly disclosure: {
        readonly path: string;
        readonly fingerprint: string;
        readonly whenToRead: string;
      };
      readonly facts: readonly PactileMemoryReadFactV1[];
      readonly summaries: readonly PactileMemoryReadSummaryV1[];
    }
  | {
      readonly ok: false;
      readonly contextOperationId: string;
      /** Where it stopped: refused input, refused read, or an unbound record. */
      readonly stage: "input" | "read" | "record";
      readonly code: string;
      readonly message: string;
      readonly recording: PactileMemoryReadRecordingV1;
    };

/**
 * The Host-owned side of `memory_read`. The Host fixes scope, scope key,
 * lease and run identity; the model supplies only the basis revision and the
 * disclosure acknowledgement. The Host also decides how the operation is
 * recorded, so a failure to record is reported rather than hidden.
 */
export interface PactileGovernedMemoryReadPortV1 {
  read(input: {
    readonly toolCallId: string;
    readonly basisRevision: number;
    readonly acknowledgeDisclosure: boolean;
    readonly signal?: AbortSignal;
  }): Promise<PactileMemoryReadOutcomeV1>;
}

export const PACTILE_MEMORY_READ_PARAMETERS_V1 = Type.Object(
  {
    basisRevision: Type.Integer({
      minimum: 0,
      description:
        "The basisRevision named by the compaction disclosure that points at the memory.",
    }),
    acknowledgeDisclosure: Type.Boolean({
      description:
        "Set true only after reading the disclosure (path, fingerprint, whenToRead). Facts are never returned without it.",
    }),
  },
  { additionalProperties: false },
);

export type PactileMemoryReadParametersV1 = Static<
  typeof PACTILE_MEMORY_READ_PARAMETERS_V1
>;

export interface PactileMemoryReadToolDetailsV1 {
  readonly contextOperationId: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly recording: PactileMemoryReadRecordingV1;
  /**
   * Present on a refusal whose outcome is fully known and recorded. A read
   * that could not be recorded is left out, so its effect stays unknown.
   */
  readonly [PACTILE_TOOL_OUTCOME_KNOWN_KEY_V1]?: true;
}

function render(outcome: PactileMemoryReadOutcomeV1): AgentToolResult<PactileMemoryReadToolDetailsV1> {
  if (!outcome.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `memory_read refused at ${outcome.stage}: ${outcome.code}`,
            outcome.message,
            outcome.recording === "record_failed"
              ? "The read could not be recorded; it will not be retried automatically."
              : "No memory facts were returned. This refusal is not retried automatically.",
          ].join("\n"),
        },
      ],
      details: {
        contextOperationId: outcome.contextOperationId,
        ok: false,
        code: outcome.code,
        recording: outcome.recording,
        ...(outcome.recording === "record_failed"
          ? {}
          : { [PACTILE_TOOL_OUTCOME_KNOWN_KEY_V1]: true as const }),
      },
    };
  }
  const lines = [
    `memory_read ok: basisRevision ${String(outcome.basisRevision)}, manifestRevision ${String(outcome.manifestRevision)}`,
    `disclosure: ${outcome.disclosure.path}`,
    `fingerprint: ${outcome.disclosure.fingerprint}`,
    `whenToRead: ${outcome.disclosure.whenToRead}`,
    `exact facts (${String(outcome.facts.length)}), each bound to the artifact content hash:`,
    ...outcome.facts.map(
      (fact) => `- [${fact.factId}] ${fact.statement} (${fact.factHash})`,
    ),
    `summaries (${String(outcome.summaries.length)}) are derived and are NOT exact facts:`,
    ...outcome.summaries.map(
      (summary) =>
        `- [${summary.summaryId}] ${summary.statement} (from ${summary.derivedFrom.join(", ")})`,
    ),
  ];
  return {
    isError: false,
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      contextOperationId: outcome.contextOperationId,
      ok: true,
      code: null,
      recording: "recorded",
    },
  };
}

/**
 * The model-facing `memory_read` tool. It never reaches the Memory Port or
 * the RunLedger itself; everything goes through the Host port, and a throwing
 * port becomes an error result rather than an unrecorded read.
 */
export function createPactileMemoryReadTool(
  port: PactileGovernedMemoryReadPortV1,
): AgentTool<
  typeof PACTILE_MEMORY_READ_PARAMETERS_V1,
  PactileMemoryReadToolDetailsV1
> {
  return {
    name: PACTILE_MEMORY_READ_TOOL_NAME_V1,
    label: "Read memory",
    description:
      "Read the exact facts that a context compaction externalized to durable memory. Pass the basisRevision from the compaction disclosure and acknowledge the disclosure. Returns hash-bound facts; summaries are not exact facts.",
    parameters: PACTILE_MEMORY_READ_PARAMETERS_V1,
    // Each call writes RunLedger records; keep them ordered.
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      try {
        const outcome = await port.read({
          toolCallId,
          basisRevision: params.basisRevision,
          acknowledgeDisclosure: params.acknowledgeDisclosure,
          ...(signal === undefined ? {} : { signal }),
        });
        return render(outcome);
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "memory_read failed before an outcome was known; it will not be retried automatically.",
            },
          ],
          details: {
            contextOperationId: "",
            ok: false,
            code: "memory_read_port_failed",
            recording: "none",
          },
        };
      }
    },
  };
}
