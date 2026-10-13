import {
  type PactileContractParseResultV1,
  definePactileContractSchemaV1,
} from "../../shared/validation.js";
import { decodePiExecutorRunResultV1 } from "./decode.js";

export * from "./types.js";
export { piExecutorEvidenceWriteSetV1 } from "./helpers.js";
export { piExecutorIdempotencyKeyV1 } from "./idempotency.js";
export {
  admitRepositoryWorkspace,
  rejectMissingWorkspaceBinding,
  validatePiExecutorBindingV1,
} from "./binding.js";
export { planPiExecutorAttemptV1 } from "./attempt.js";
export { decidePiExecutorOutcomeV1, piExecutorRejectionDecisionV1 } from "./outcome.js";
export { buildPiExecutorRunResultV1 } from "./result.js";

export const piExecutorRunResultV1Schema = definePactileContractSchemaV1(
  "PiExecutorRunResultV1",
  decodePiExecutorRunResultV1,
);

export function parsePiExecutorRunResultV1(
  input: unknown,
): PactileContractParseResultV1<import("./types.js").PiExecutorRunResultV1> {
  return piExecutorRunResultV1Schema.parse(input);
}
