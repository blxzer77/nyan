import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  fingerprintPactileContractV1,
} from "../shared/validation.js";

export const PI_MODEL_THINKING_LEVELS_V1 = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;
export type PiModelThinkingLevelV1 = (typeof PI_MODEL_THINKING_LEVELS_V1)[number];

export const MODEL_AVAILABILITIES_V1 = ["available", "auth", "unavailable"] as const;
export type ModelAvailabilityV1 = (typeof MODEL_AVAILABILITIES_V1)[number];
export const MODEL_KINDS_V1 = ["physical", "virtual"] as const;
export type ModelKindV1 = (typeof MODEL_KINDS_V1)[number];

/** Public, host-neutral facts copied from Pi ModelRuntime/ModelRegistry. */
export interface PiModelCatalogEntryV1 {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string | null;
  readonly kind?: ModelKindV1 | null;
  readonly availability: ModelAvailabilityV1;
  readonly reasoning?: boolean | null;
  /** Pi's thinkingLevelMap: null is unsupported; absent uses provider default. */
  readonly thinkingLevelMap?: Partial<Record<PiModelThinkingLevelV1, string | null>> | null;
  readonly contextWindow?: number | null;
  /** Provider/service speed tier. `fast` is a variant, never an effort level. */
  readonly serviceVariant?: string | null;
  readonly variantAdapterId?: string | null;
}

export interface ModelCatalogSnapshotV1 {
  readonly revision: string;
  readonly profiles: readonly ModelProfileV1[];
}

export interface ModelProfileV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly profileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly modelKind: ModelKindV1;
  readonly availability: ModelAvailabilityV1;
  readonly supportedThinkingLevels: readonly PiModelThinkingLevelV1[];
  readonly contextWindow: number | null;
  readonly serviceVariant: string | null;
  readonly variantAdapterId: string | null;
}

export interface ModelSelectionRequestV1 {
  readonly thinkingLevel?: PiModelThinkingLevelV1 | null;
  readonly serviceVariant?: string | null;
}

export interface ModelSelectionV1 {
  readonly request: ModelSelectionRequestV1;
  readonly candidates: readonly ModelProfileV1[];
  readonly eligible: readonly ModelProfileV1[];
  readonly reason: "none" | "catalog_empty" | "auth_required" | "unavailable" | "thinking_unsupported" | "variant_unavailable";
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function normalizeLevels(entry: PiModelCatalogEntryV1): readonly PiModelThinkingLevelV1[] {
  const map = entry.thinkingLevelMap;
  // A missing map means Pi/provider default behavior, not a declaration that
  // every effort is supported. Keep the selectable set empty until Pi exposes
  // explicit capability facts.
  if (!map) return [];
  return PI_MODEL_THINKING_LEVELS_V1.filter((level) => {
    const mapped = map[level];
    if (mapped === null || mapped === undefined) return false;
    if (typeof mapped !== "string" || mapped.trim() === "") throw new TypeError(`thinkingLevelMap.${level} must be a non-empty string or null`);
    return true;
  });
}
function normalizeVariant(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  return required(value, label);
}
function profileIdentity(entry: Pick<ModelProfileV1, "providerId" | "modelId" | "modelKind" | "serviceVariant" | "variantAdapterId">): string {
  return fingerprintPactileContractV1({
    providerId: entry.providerId,
    modelId: entry.modelId,
    modelKind: entry.modelKind,
    serviceVariant: entry.serviceVariant,
    variantAdapterId: entry.variantAdapterId,
  });
}

export function projectPiModelCatalogV1(entries: readonly PiModelCatalogEntryV1[]): ModelCatalogSnapshotV1 {
  if (!Array.isArray(entries)) throw new TypeError("model catalog must be an array");
  const profiles = entries.map((entry, index): ModelProfileV1 => {
    if (!entry || typeof entry !== "object") throw new TypeError(`model catalog entry #${index} must be an object`);
    const providerId = required(entry.providerId, `entry #${index}.providerId`);
    const modelId = required(entry.modelId, `entry #${index}.modelId`);
    const modelKind = entry.kind ?? "physical";
    if (!MODEL_KINDS_V1.includes(modelKind)) throw new TypeError(`entry #${index}.kind is invalid`);
    if (!MODEL_AVAILABILITIES_V1.includes(entry.availability)) throw new TypeError(`entry #${index}.availability is invalid`);
    const serviceVariant = normalizeVariant(entry.serviceVariant, `entry #${index}.serviceVariant`);
    const variantAdapterId = normalizeVariant(entry.variantAdapterId, `entry #${index}.variantAdapterId`);
    const displayName = entry.displayName ?? modelId;
    if (typeof displayName !== "string" || displayName.trim() === "") throw new TypeError(`entry #${index}.displayName must be a non-empty string`);
    const contextWindow = entry.contextWindow ?? null;
    if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow < 0)) throw new TypeError(`entry #${index}.contextWindow must be a non-negative safe integer`);
    const identity = { providerId, modelId, modelKind, serviceVariant, variantAdapterId } as const;
    return Object.freeze({
      schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
      profileId: `model-profile:${profileIdentity(identity).slice("sha256:".length)}`,
      providerId,
      modelId,
      displayName,
      modelKind,
      availability: entry.availability,
      supportedThinkingLevels: Object.freeze([...normalizeLevels(entry)]),
      contextWindow,
      serviceVariant,
      variantAdapterId,
    });
  }).sort((a, b) => a.profileId.localeCompare(b.profileId));
  const deduped = profiles.filter((profile, index) => index === 0 || profile.profileId !== profiles[index - 1]?.profileId);
  return Object.freeze({
    revision: fingerprintPactileContractV1(deduped),
    profiles: Object.freeze(deduped),
  });
}

export function selectModelProfilesV1(snapshot: ModelCatalogSnapshotV1, request: ModelSelectionRequestV1 = {}): ModelSelectionV1 {
  const thinkingLevel = request.thinkingLevel ?? null;
  if (thinkingLevel !== null && !PI_MODEL_THINKING_LEVELS_V1.includes(thinkingLevel)) throw new TypeError("request.thinkingLevel is invalid");
  const serviceVariant = request.serviceVariant ?? null;
  const candidates = snapshot.profiles.filter((profile) => serviceVariant === null || profile.serviceVariant === serviceVariant);
  const eligible = candidates.filter((profile) => profile.availability === "available" && (thinkingLevel === null || profile.supportedThinkingLevels.includes(thinkingLevel)));
  let reason: ModelSelectionV1["reason"] = "none";
  if (eligible.length === 0) {
    if (snapshot.profiles.length === 0) reason = "catalog_empty";
    else if (candidates.length === 0) reason = "variant_unavailable";
    else if (candidates.some((p) => p.availability === "auth")) reason = "auth_required";
    else if (candidates.some((p) => p.availability === "available" && thinkingLevel !== null && !p.supportedThinkingLevels.includes(thinkingLevel))) reason = "thinking_unsupported";
    else reason = "unavailable";
  }
  return Object.freeze({ request: Object.freeze({ thinkingLevel, serviceVariant }), candidates: Object.freeze(candidates), eligible: Object.freeze(eligible), reason });
}
