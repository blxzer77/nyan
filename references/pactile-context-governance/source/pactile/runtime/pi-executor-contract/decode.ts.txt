import { RUN_TERMINAL_STATUSES } from "../../agent/lifecycle-bridge.js";
import {
  type ContractDecoderV1,
  childPathV1,
  decodeFingerprintV1,
  decodeLogicalIdV1,
  decodeRelativePosixPathV1,
  decodeSchemaVersionV1,
  decodeTimestampV1,
} from "../../shared/validation.js";
import type {
  PiExecutorRunResultV1,
} from "./types.js";
import {
  PI_EXECUTOR_ATTEMPT_DISPOSITIONS_V1,
  PI_EXECUTOR_BINDING_OUTCOMES_V1,
  PI_EXECUTOR_BINDING_REASONS_V1,
  PI_EXECUTOR_HOST_KINDS_V1,
  PI_EXECUTOR_PI_STATUSES_V1,
  PI_EXECUTOR_REASON_CODES_V1,
  PI_EXECUTOR_RUN_OUTCOMES_V1,
} from "./types.js";

const PI_EXECUTOR_RUN_RESULT_KEYS_V1 = [
  "schemaVersion",
  "resultId",
  "workItemId",
  "blockId",
  "runId",
  "requestId",
  "requestHash",
  "piSessionId",
  "piOperationId",
  "epoch",
  "semanticFingerprint",
  "repositoryRoot",
  "hostWorkspaceRoot",
  "baseSha",
  "writeSet",
  "observedWriteSet",
  "bindingOutcome",
  "bindingReason",
  "hostKind",
  "hostBound",
  "piStatus",
  "outcome",
  "reason",
  "retryable",
  "nativeReceiptAuthoritative",
  "terminalStatus",
  "terminalReceiptId",
  "terminalEffectsKnown",
  "evidenceAccepted",
  "gateAccepted",
  "settled",
  "workItemCompleted",
  "idempotencyKey",
  "attemptDisposition",
  "supersedesResultId",
  "envelopeFingerprints",
  "envelopeErrorCount",
  "createdAt",
] as const;

function decodeNullableTextV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decoder.string(value, path, { nonEmpty: true });
}

function decodeNullableEnumV1<T extends string>(
  value: unknown,
  values: readonly T[],
  decoder: ContractDecoderV1,
  path: string,
): T | null {
  if (value === null) return null;
  return decoder.enumValue(value, values, path);
}

function decodeNullableBooleanV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): boolean | null {
  if (value === null) return null;
  return decoder.boolean(value, path);
}

function decodeRunResultWriteSetV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string[] {
  return decoder.array(value, path, (item, itemPath) =>
    decodeRelativePosixPathV1(item, decoder, itemPath),
  );
}

export function decodePiExecutorRunResultV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): PiExecutorRunResultV1 {
  const record = decoder.object(value, path, PI_EXECUTOR_RUN_RESULT_KEYS_V1);
  const schemaVersion = decodeSchemaVersionV1(record, decoder, path);
  const resultId = decodeLogicalIdV1(
    decoder.required(record, "resultId", path),
    decoder,
    childPathV1(path, "resultId"),
  );
  const workItemId = decodeLogicalIdV1(
    decoder.required(record, "workItemId", path),
    decoder,
    childPathV1(path, "workItemId"),
  );
  const blockId = decodeLogicalIdV1(
    decoder.required(record, "blockId", path),
    decoder,
    childPathV1(path, "blockId"),
  );
  const runId = decodeNullableTextV1(
    decoder.required(record, "runId", path),
    decoder,
    childPathV1(path, "runId"),
  );
  const requestId = decodeLogicalIdV1(
    decoder.required(record, "requestId", path),
    decoder,
    childPathV1(path, "requestId"),
  );
  const requestHash = decodeNullableTextV1(
    decoder.required(record, "requestHash", path),
    decoder,
    childPathV1(path, "requestHash"),
  );
  const piSessionId = decodeLogicalIdV1(
    decoder.required(record, "piSessionId", path),
    decoder,
    childPathV1(path, "piSessionId"),
  );
  const piOperationId = decodeLogicalIdV1(
    decoder.required(record, "piOperationId", path),
    decoder,
    childPathV1(path, "piOperationId"),
  );
  const epoch = decoder.integer(
    decoder.required(record, "epoch", path),
    childPathV1(path, "epoch"),
    { min: 0 },
  );
  const semanticFingerprint = decoder.string(
    decoder.required(record, "semanticFingerprint", path),
    childPathV1(path, "semanticFingerprint"),
    { nonEmpty: true },
  );
  // Product identity may be unknown on a rejected attempt (an explicit empty
  // string), but must be present once the binding was admitted. A Run Result
  // must never invent a repository root it did not observe.
  const repositoryRoot = decoder.string(
    decoder.required(record, "repositoryRoot", path),
    childPathV1(path, "repositoryRoot"),
  );
  const hostWorkspaceRoot = decodeNullableTextV1(
    decoder.required(record, "hostWorkspaceRoot", path),
    decoder,
    childPathV1(path, "hostWorkspaceRoot"),
  );
  const baseSha = decoder.string(
    decoder.required(record, "baseSha", path),
    childPathV1(path, "baseSha"),
  );
  const writeSetPath = childPathV1(path, "writeSet");
  const writeSet = decodeRunResultWriteSetV1(
    decoder.required(record, "writeSet", path),
    decoder,
    writeSetPath,
  );
  const observedWriteSetPath = childPathV1(path, "observedWriteSet");
  const observedWriteSet = decodeRunResultWriteSetV1(
    decoder.required(record, "observedWriteSet", path),
    decoder,
    observedWriteSetPath,
  );
  const allowedWriteSet = new Set(writeSet);
  const outOfSetObservations: number[] = [];
  observedWriteSet.forEach((entry, index) => {
    if (!allowedWriteSet.has(entry)) outOfSetObservations.push(index);
  });

  const bindingOutcome = decodeNullableEnumV1(
    decoder.required(record, "bindingOutcome", path),
    PI_EXECUTOR_BINDING_OUTCOMES_V1,
    decoder,
    childPathV1(path, "bindingOutcome"),
  );
  const bindingReasonPath = childPathV1(path, "bindingReason");
  const bindingReason = decodeNullableEnumV1(
    decoder.required(record, "bindingReason", path),
    PI_EXECUTOR_BINDING_REASONS_V1,
    decoder,
    bindingReasonPath,
  );
  if (bindingOutcome !== "rejected") {
    for (const index of outOfSetObservations) {
      decoder.issue(
        "conflict",
        `${observedWriteSetPath}[${index}]`,
        "observed path is outside the frozen write set",
      );
    }
  }
  if (bindingOutcome === "rejected" && bindingReason === null) {
    decoder.issue("required", bindingReasonPath, "is required for a rejected binding");
  }
  if (bindingOutcome === "admitted" && bindingReason !== null) {
    decoder.issue("conflict", bindingReasonPath, "must be null for an admitted binding");
  }

  const hostKind = decodeNullableEnumV1(
    decoder.required(record, "hostKind", path),
    PI_EXECUTOR_HOST_KINDS_V1,
    decoder,
    childPathV1(path, "hostKind"),
  );
  const hostBound = decoder.boolean(
    decoder.required(record, "hostBound", path),
    childPathV1(path, "hostBound"),
  );
  const piStatus = decodeNullableEnumV1(
    decoder.required(record, "piStatus", path),
    PI_EXECUTOR_PI_STATUSES_V1,
    decoder,
    childPathV1(path, "piStatus"),
  );
  const outcome = decoder.enumValue(
    decoder.required(record, "outcome", path),
    PI_EXECUTOR_RUN_OUTCOMES_V1,
    childPathV1(path, "outcome"),
  );
  const reason = decoder.enumValue(
    decoder.required(record, "reason", path),
    PI_EXECUTOR_REASON_CODES_V1,
    childPathV1(path, "reason"),
  );
  const retryable = decoder.boolean(
    decoder.required(record, "retryable", path),
    childPathV1(path, "retryable"),
  );
  const nativeReceiptAuthoritative = decoder.boolean(
    decoder.required(record, "nativeReceiptAuthoritative", path),
    childPathV1(path, "nativeReceiptAuthoritative"),
  );
  const terminalStatus = decodeNullableEnumV1(
    decoder.required(record, "terminalStatus", path),
    RUN_TERMINAL_STATUSES,
    decoder,
    childPathV1(path, "terminalStatus"),
  );
  const terminalReceiptId = decodeNullableTextV1(
    decoder.required(record, "terminalReceiptId", path),
    decoder,
    childPathV1(path, "terminalReceiptId"),
  );
  const terminalEffectsKnown = decodeNullableBooleanV1(
    decoder.required(record, "terminalEffectsKnown", path),
    decoder,
    childPathV1(path, "terminalEffectsKnown"),
  );
  if (
    terminalReceiptId !== null &&
    (terminalStatus === null || terminalEffectsKnown === null)
  ) {
    decoder.issue(
      "conflict",
      path,
      "a terminal receipt requires its status and effectsKnown facts",
    );
  }
  const evidenceAccepted = decoder.boolean(
    decoder.required(record, "evidenceAccepted", path),
    childPathV1(path, "evidenceAccepted"),
  );
  const gateAccepted = decoder.boolean(
    decoder.required(record, "gateAccepted", path),
    childPathV1(path, "gateAccepted"),
  );
  const settled = decoder.boolean(
    decoder.required(record, "settled", path),
    childPathV1(path, "settled"),
  );
  const workItemCompleted = decoder.literal(
    decoder.required(record, "workItemCompleted", path),
    false,
    childPathV1(path, "workItemCompleted"),
  );
  const idempotencyKey = decodeFingerprintV1(
    decoder.required(record, "idempotencyKey", path),
    decoder,
    childPathV1(path, "idempotencyKey"),
  );
  const attemptDisposition = decoder.enumValue(
    decoder.required(record, "attemptDisposition", path),
    PI_EXECUTOR_ATTEMPT_DISPOSITIONS_V1,
    childPathV1(path, "attemptDisposition"),
  );
  const supersedesResultId = decodeNullableTextV1(
    decoder.required(record, "supersedesResultId", path),
    decoder,
    childPathV1(path, "supersedesResultId"),
  );
  const envelopeFingerprintsPath = childPathV1(path, "envelopeFingerprints");
  const envelopeFingerprints = decoder.array(
    decoder.required(record, "envelopeFingerprints", path),
    envelopeFingerprintsPath,
    (item, itemPath) => decodeFingerprintV1(item, decoder, itemPath),
  );
  const envelopeErrorCount = decoder.integer(
    decoder.required(record, "envelopeErrorCount", path),
    childPathV1(path, "envelopeErrorCount"),
    { min: 0 },
  );
  const createdAt = decodeTimestampV1(
    decoder.required(record, "createdAt", path),
    decoder,
    childPathV1(path, "createdAt"),
  );

  if (outcome === "result_submitted") {
    const native =
      bindingOutcome === "admitted" &&
      hostBound &&
      hostKind === "native" &&
      piStatus === "settled" &&
      nativeReceiptAuthoritative &&
      terminalStatus !== null &&
      terminalEffectsKnown === true &&
      evidenceAccepted &&
      gateAccepted &&
      runId !== null &&
      requestHash !== null;
    if (!native) {
      decoder.issue(
        "policy-violation",
        path,
        "result_submitted requires an admitted native Pi run with a settled receipt, a terminal fact with known effects, accepted evidence, an accepted gate, a request hash and a run id",
      );
    }
  }

  // An admitted binding must carry the product identity it was admitted
  // against; only a refused attempt may leave those facts blank.
  if (bindingOutcome === "admitted") {
    if (repositoryRoot.length === 0) {
      decoder.issue(
        "required",
        childPathV1(path, "repositoryRoot"),
        "is required once the workspace binding was admitted",
      );
    }
    if (baseSha.length === 0) {
      decoder.issue(
        "required",
        childPathV1(path, "baseSha"),
        "is required once the workspace binding was admitted",
      );
    }
  }

  // A rejected attempt is the only shape allowed to report `rejected`; every
  // other outcome requires either an admitted binding or a host attempt.
  if (outcome === "rejected" && runId !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "runId"),
      "a rejected attempt cannot claim a Run id",
    );
  }
  if (outcome === "rejected" && reason === "none") {
    decoder.issue(
      "required",
      childPathV1(path, "reason"),
      "a rejected attempt must record why it stopped",
    );
  }
  if (outcome === "result_submitted" && reason !== "none") {
    decoder.issue(
      "conflict",
      childPathV1(path, "reason"),
      "a submitted result carries no failure reason",
    );
  }
  if (nativeReceiptAuthoritative && outcome !== "result_submitted") {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "nativeReceiptAuthoritative"),
      "only a submitted native result may claim native receipt authority",
    );
  }
  if (settled && !nativeReceiptAuthoritative) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "settled"),
      "a settlement receipt requires an authoritative native result",
    );
  }

  return {
    schemaVersion,
    resultId,
    workItemId,
    blockId,
    runId,
    requestId,
    requestHash: requestHash ?? "",
    piSessionId,
    piOperationId,
    epoch,
    semanticFingerprint,
    repositoryRoot,
    hostWorkspaceRoot,
    baseSha,
    writeSet,
    observedWriteSet,
    bindingOutcome,
    bindingReason,
    hostKind,
    hostBound,
    piStatus,
    outcome,
    reason,
    retryable,
    nativeReceiptAuthoritative,
    terminalStatus,
    terminalReceiptId,
    terminalEffectsKnown,
    evidenceAccepted,
    gateAccepted,
    settled,
    workItemCompleted,
    idempotencyKey,
    attemptDisposition,
    supersedesResultId,
    envelopeFingerprints,
    envelopeErrorCount,
    createdAt,
  };
}
