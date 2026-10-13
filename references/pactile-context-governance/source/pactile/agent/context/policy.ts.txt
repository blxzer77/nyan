export const CONTEXT_MEMORY_POLICY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONTEXT_MEMORY_POLICY_V1 = Object.freeze({
  maskCapTokens: 100_000,
  keep: 3,
  clearAtLeastPercent: 0.05,
});

export type ContextSurgeryActionV1 = "continue" | "mask" | "compact" | "blocked";
export type ContextSurgeryAssuranceV1 = "assurance_exact" | "assurance_unknown";
export type DurableExternalizationStatusV1 = "absent" | "pending" | "durable" | "unknown";

export interface ContextMemoryPolicyConfigV1 {
  readonly maskCapTokens?: number;
  readonly keep?: number;
  /** Retained for Pi compatibility; its percentage behavior is unverified. */
  readonly clearAtLeastPercent?: number;
}

export interface DurableExternalizationV1 {
  readonly status: DurableExternalizationStatusV1;
  readonly path: string | null;
  readonly fingerprint: string | null;
  readonly disclosed: boolean;
  readonly whenToRead: string | null;
}

export interface ContextSurgeryInputV1 {
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly reserveTokens: number;
  /** Tool-result payload that can be masked while its index stays present. */
  readonly maskableToolResultTokens: number;
  readonly externalization?: DurableExternalizationV1 | null;
}

export interface ContextSurgeryDecisionV1 {
  readonly schemaVersion: typeof CONTEXT_MEMORY_POLICY_SCHEMA_VERSION;
  readonly action: ContextSurgeryActionV1;
  readonly assurance: ContextSurgeryAssuranceV1;
  readonly reason:
    | "below_threshold"
    | "mask_first"
    | "compression_allowed"
    | "externalization_missing"
    | "externalization_not_durable"
    | "disclosure_missing"
    | "disclosure_invalid";
  readonly maskThreshold: number;
  readonly compressionThreshold: number;
  readonly keep: number;
  readonly clearAtLeastPercent: number;
  readonly disclosure: { readonly path: string; readonly fingerprint: string; readonly whenToRead: string } | null;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function validateExternalization(value: DurableExternalizationV1 | null | undefined): DurableExternalizationV1 | null {
  if (value === undefined || value === null) return null;
  const statuses: readonly DurableExternalizationStatusV1[] = ["absent", "pending", "durable", "unknown"];
  if (!statuses.includes(value.status)) throw new TypeError("externalization.status is invalid");
  if (value.path !== null && typeof value.path !== "string") throw new TypeError("externalization.path must be a string or null");
  if (value.fingerprint !== null && typeof value.fingerprint !== "string") throw new TypeError("externalization.fingerprint must be a string or null");
  if (typeof value.disclosed !== "boolean") throw new TypeError("externalization.disclosed must be boolean");
  if (value.whenToRead !== null && typeof value.whenToRead !== "string") throw new TypeError("externalization.whenToRead must be a string or null");
  return Object.freeze({ ...value });
}

function disclosure(value: DurableExternalizationV1 | null): ContextSurgeryDecisionV1["disclosure"] {
  if (value?.status !== "durable" || !value.disclosed || value.path === null || value.path.trim() === "" || value.fingerprint === null || value.fingerprint.trim() === "" || value.whenToRead === null || value.whenToRead.trim() === "") return null;
  return Object.freeze({ path: value.path.trim(), fingerprint: value.fingerprint.trim(), whenToRead: value.whenToRead.trim() });
}

export function decideContextSurgeryV1(input: ContextSurgeryInputV1, config: ContextMemoryPolicyConfigV1 = {}): ContextSurgeryDecisionV1 {
  const contextTokens = nonNegativeInteger(input.contextTokens, "contextTokens");
  const contextWindow = nonNegativeInteger(input.contextWindow, "contextWindow");
  const reserveTokens = nonNegativeInteger(input.reserveTokens, "reserveTokens");
  const maskable = nonNegativeInteger(input.maskableToolResultTokens, "maskableToolResultTokens");
  if (contextWindow === 0) throw new TypeError("contextWindow must be positive");
  if (reserveTokens >= contextWindow) throw new TypeError("reserveTokens must be less than contextWindow");
  const maskCapTokens = config.maskCapTokens ?? DEFAULT_CONTEXT_MEMORY_POLICY_V1.maskCapTokens;
  const keep = config.keep ?? DEFAULT_CONTEXT_MEMORY_POLICY_V1.keep;
  const clearAtLeastPercent = config.clearAtLeastPercent ?? DEFAULT_CONTEXT_MEMORY_POLICY_V1.clearAtLeastPercent;
  nonNegativeInteger(maskCapTokens, "maskCapTokens");
  nonNegativeInteger(keep, "keep");
  if (!Number.isFinite(clearAtLeastPercent) || clearAtLeastPercent < 0 || clearAtLeastPercent > 1) throw new TypeError("clearAtLeastPercent must be between 0 and 1");
  const externalization = validateExternalization(input.externalization);
  const maskThreshold = Math.min(maskCapTokens, Math.floor(contextWindow / 2));
  const compressionThreshold = contextWindow - reserveTokens;
  const common = { schemaVersion: CONTEXT_MEMORY_POLICY_SCHEMA_VERSION, maskThreshold, compressionThreshold, keep, clearAtLeastPercent } as const;
  if (contextTokens < maskThreshold) return Object.freeze({ ...common, action: "continue", assurance: "assurance_exact", reason: "below_threshold", disclosure: disclosure(externalization) });
  if (contextTokens < compressionThreshold) {
    if (maskable > 0) return Object.freeze({ ...common, action: "mask", assurance: "assurance_exact", reason: "mask_first", disclosure: disclosure(externalization) });
    return Object.freeze({ ...common, action: "continue", assurance: "assurance_exact", reason: "below_threshold", disclosure: disclosure(externalization) });
  }
  if (maskable > 0) return Object.freeze({ ...common, action: "mask", assurance: "assurance_exact", reason: "mask_first", disclosure: disclosure(externalization) });
  if (externalization === null || externalization.status === "absent") return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason: "externalization_missing", disclosure: null });
  if (externalization.status !== "durable") return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason: "externalization_not_durable", disclosure: null });
  const exposed = disclosure(externalization);
  if (exposed === null) {
    const reason = externalization.disclosed ? "disclosure_invalid" : "disclosure_missing";
    return Object.freeze({ ...common, action: "blocked", assurance: "assurance_unknown", reason, disclosure: null });
  }
  return Object.freeze({ ...common, action: "compact", assurance: "assurance_exact", reason: "compression_allowed", disclosure: exposed });
}
