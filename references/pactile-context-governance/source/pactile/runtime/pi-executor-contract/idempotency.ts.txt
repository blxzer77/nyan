import { fingerprintPactileContractV1 } from "../../shared/validation.js";
import { requireTextV1, requireWriteSetV1 } from "./helpers.js";
import type { PiExecutorIdempotencyInputV1 } from "./types.js";

/**
 * Deterministic, order-insensitive key over the full dispatch identity.
 *
 * The frozen write set is treated as a set: a reordered declaration of the
 * same paths is the same request, while any added, removed or rewritten path
 * produces a different key and therefore a different Run Result.
 */
export function piExecutorIdempotencyKeyV1(
  input: PiExecutorIdempotencyInputV1,
): string {
  const epoch = input.epoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new TypeError("epoch must be a non-negative safe integer");
  }
  const writeSet = requireWriteSetV1(input.writeSet, "writeSet");
  return fingerprintPactileContractV1({
    workItemId: requireTextV1(input.workItemId, "workItemId"),
    blockId: requireTextV1(input.blockId, "blockId"),
    requestId: requireTextV1(input.requestId, "requestId"),
    requestHash: requireTextV1(input.requestHash, "requestHash"),
    piSessionId: requireTextV1(input.piSessionId, "piSessionId"),
    piOperationId: requireTextV1(input.piOperationId, "piOperationId"),
    epoch,
    semanticFingerprint: requireTextV1(
      input.semanticFingerprint,
      "semanticFingerprint",
    ),
    baseSha: requireTextV1(input.baseSha, "baseSha").toLowerCase(),
    writeSet: [...writeSet].sort((left, right) => left.localeCompare(right)),
  });
}
