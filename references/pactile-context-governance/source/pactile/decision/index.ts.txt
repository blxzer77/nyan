/** Decision contracts and provider composition; no provider is invoked on import. */
export * from "./contract.js";
export { createDecisionProviderRegistryV1 } from "./provider-registry.js";
export { createRuleDecisionProviderV1 } from "./rule-provider.js";
export {
  PI_MODEL_THINKING_LEVELS_V1,
  projectPiModelCatalogV1,
  selectModelProfilesV1,
} from "./model-catalog.js";
export type {
  ModelAvailabilityV1,
  ModelKindV1,
  PiModelCatalogEntryV1,
  ModelCatalogSnapshotV1,
  ModelProfileV1,
  ModelSelectionRequestV1,
  ModelSelectionV1,
} from "./model-catalog.js";
