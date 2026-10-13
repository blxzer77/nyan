export const DECISION_THINKING_LEVELS_V1 = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiModelThinkingLevelV1 = (typeof DECISION_THINKING_LEVELS_V1)[number];

export const DECISION_SCOPES_V1 = ["model_route", "tile_select", "planning", "compaction"] as const;
export type DecisionScopeV1 = (typeof DECISION_SCOPES_V1)[number];
export const DECISION_PROVIDER_KINDS_V1 = ["rule", "model", "external"] as const;
export type DecisionProviderKindV1 = (typeof DECISION_PROVIDER_KINDS_V1)[number];
export const DECISION_AUTONOMY_LEVELS_V1 = ["advice", "select", "operate"] as const;
export type DecisionAutonomyLevelV1 = (typeof DECISION_AUTONOMY_LEVELS_V1)[number];

export interface DecisionProviderDescriptorV1 {
  readonly id: string;
  readonly kind: DecisionProviderKindV1;
  readonly scopes: readonly DecisionScopeV1[];
  readonly autonomyLevels: readonly DecisionAutonomyLevelV1[];
  readonly priority: number;
}
export interface DecisionRequestV1 {
  readonly scope: DecisionScopeV1;
  readonly autonomy: DecisionAutonomyLevelV1;
  readonly candidateProfileIds: readonly string[];
  readonly requestedThinkingLevel?: PiModelThinkingLevelV1 | null;
  readonly requestedServiceVariant?: string | null;
  /** Bounded facts only; transcripts and credentials stay outside this contract. */
  readonly taskFacts: Readonly<Record<string, string | number | boolean | null>>;
}
export interface DecisionAdviceV1 {
  readonly selectedProfileId: string | null;
  readonly thinkingLevel: PiModelThinkingLevelV1 | null;
  readonly serviceVariant: string | null;
  readonly route: "selected" | "needs_review";
  readonly rationaleCodes: readonly string[];
}
export interface DecisionProviderV1 {
  descriptor(): DecisionProviderDescriptorV1;
  decide(request: DecisionRequestV1): DecisionAdviceV1 | Promise<DecisionAdviceV1>;
}
export interface DecisionReceiptV1 {
  readonly decisionId: string;
  readonly requestHash: string;
  readonly providerId: string | null;
  readonly scope: DecisionScopeV1;
  readonly advice: DecisionAdviceV1;
}
export interface DecisionResultV1 {
  readonly receipt: DecisionReceiptV1;
  readonly advice: DecisionAdviceV1;
}
export interface DecisionProviderRegistryV1 {
  register(provider: DecisionProviderV1): void;
  list(): readonly DecisionProviderDescriptorV1[];
  decide(request: DecisionRequestV1): Promise<DecisionResultV1>;
}
