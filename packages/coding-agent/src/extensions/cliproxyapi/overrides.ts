/**
 * Declarative model overrides.
 *
 * CLIProxyAPI's catalog is derived from whatever upstream client metadata the
 * operator configured, so a single field can be missing, generic, or simply
 * wrong for the route behind it. Editing the extension source or hand-patching
 * the cached catalog is not maintainable, and the cache is rewritten on every
 * refresh anyway.
 *
 * This module reads `cliproxyapi-overrides.json` and applies it on top of the
 * freshly fetched catalog, so a correction survives every refresh.
 *
 * Precedence: `models[id]` > last matching entry of `patterns` > catalog value.
 */

import { readFileSync } from "node:fs";
import { loadConfig, overridesPath, writeJsonAtomic } from "./config.ts";
import { log } from "./log.ts";
import type { Cost, CostTier } from "./pricing.ts";

/** nyan thinking levels, in the order the UI cycles through them. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/** How to pick a context window from a catalog entry with both fields. */
export type ContextWindowSource = "context_window" | "max_context_window";

/** Where unlisted models come from once their grace period ends. */
export type UnlistedPolicy = "drop" | "retain";

export interface OverrideDefaults {
	/** Which catalog field feeds nyan's `contextWindow`. Default `context_window`. */
	contextWindowSource?: ContextWindowSource;
	/** Applied when the catalog has no usable context window. */
	contextWindow?: number;
	/** Applied when the catalog has no usable output limit. */
	maxTokens?: number;
	/** Hide models with `visibility: "hide"` in the catalog. Default true. */
	respectVisibility?: boolean;
	/**
	 * Keep a model that vanished from the catalog for this long before dropping it.
	 * Guards against a transient upstream catalog blip. Default 24h; `0` drops immediately.
	 */
	unlistedGraceMs?: number;
	/** What happens after the grace period. Default `drop`. */
	unlistedPolicy?: UnlistedPolicy;
	/** Fetch models.dev rates. Default true. */
	pricing?: boolean;
}

export interface ModelOverride {
	name?: string;
	/** Absolute context window in tokens. */
	contextWindow?: number;
	/** Maximum output tokens. */
	maxTokens?: number;
	reasoning?: boolean;
	/** nyan thinking levels this model actually supports. Others are marked unsupported. */
	thinkingLevels?: string[];
	/** Raw escape hatch: maps nyan thinking levels to provider values (null = unsupported). */
	thinkingLevelMap?: ThinkingLevelMap;
	input?: Array<"text" | "image">;
	/** USD per million tokens. */
	cost?: Partial<Cost>;
	/** Override the models.dev lookup id. */
	pricingModelId?: string;
	/** Whether CLIProxyAPI advertises a priority service tier for this model. */
	fast?: boolean;
	/** Never drop this model when it leaves the catalog, and never warn about it. */
	pin?: boolean;
	/** Hide this model from the picker. */
	hidden?: boolean;
	/** Show a model the catalog marks `visibility: "hide"`. */
	show?: boolean;
	headers?: Record<string, string>;
	samplingParams?: Record<string, unknown>;
}

export interface OverridePattern extends ModelOverride {
	/** Regular expression tested against the model id. */
	match: string;
}

export interface OverridesFile {
	defaults?: OverrideDefaults;
	/** Keyed by exact model id (case-insensitive). */
	models?: Record<string, ModelOverride>;
	/** Applied in order; a later matching pattern overrides an earlier one. */
	patterns?: OverridePattern[];
}

export interface CompiledOverrides {
	defaults: Required<
		Pick<
			OverrideDefaults,
			"contextWindowSource" | "respectVisibility" | "unlistedGraceMs" | "unlistedPolicy" | "pricing"
		>
	> &
		OverrideDefaults;
	models: Map<string, ModelOverride>;
	patterns: Array<{ source: OverridePattern; regex: RegExp }>;
	/** Non-fatal problems worth surfacing through `/cpa-doctor`. */
	problems: string[];
	path: string;
	found: boolean;
}

export const DEFAULT_UNLISTED_GRACE_MS = 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalNumber(value: unknown, field: string, problems: string[]): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		problems.push(`${field} must be a positive number; got ${JSON.stringify(value)}`);
		return undefined;
	}
	return value;
}

function optionalBoolean(value: unknown, field: string, problems: string[]): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		problems.push(`${field} must be a boolean; got ${JSON.stringify(value)}`);
		return undefined;
	}
	return value;
}

function optionalString(value: unknown, field: string, problems: string[]): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !value.trim()) {
		problems.push(`${field} must be a non-empty string; got ${JSON.stringify(value)}`);
		return undefined;
	}
	return value.trim();
}

function parseThinkingLevels(raw: unknown, prefix: string, problems: string[]): string[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw)) {
		problems.push(`${prefix}.thinkingLevels must be an array of strings`);
		return undefined;
	}
	const parsed: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string" && entry.trim()) {
			parsed.push(entry.trim().toLowerCase());
		} else {
			problems.push(`${prefix}.thinkingLevels contains a non-string entry`);
		}
	}
	return parsed;
}

function parseThinkingLevelMap(raw: unknown, prefix: string, problems: string[]): ThinkingLevelMap | undefined {
	const source = asRecord(raw);
	if (!source) {
		if (raw !== undefined) {
			problems.push(`${prefix}.thinkingLevelMap must be an object`);
		}
		return undefined;
	}
	const map: ThinkingLevelMap = {};
	for (const [key, value] of Object.entries(source)) {
		const lowerKey = key.toLowerCase() as PiThinkingLevel;
		if (!PI_THINKING_LEVELS.includes(lowerKey)) {
			problems.push(
				`${prefix}.thinkingLevelMap key "${key}" is not a recognized thinking level (${PI_THINKING_LEVELS.join(", ")})`,
			);
			continue;
		}
		if (value === null || typeof value === "string") {
			map[lowerKey] = value;
		} else {
			problems.push(`${prefix}.thinkingLevelMap["${key}"] must be a string or null`);
		}
	}
	return map;
}

function parseCostTiers(raw: unknown, prefix: string, problems: string[]): CostTier[] | undefined {
	if (!Array.isArray(raw)) {
		if (raw !== undefined) {
			problems.push(`${prefix}.cost.tiers must be an array`);
		}
		return undefined;
	}
	const tiers: CostTier[] = [];
	for (let index = 0; index < raw.length; index++) {
		const tier = asRecord(raw[index]);
		if (!tier) {
			problems.push(`${prefix}.cost.tiers[${index}] must be an object`);
			continue;
		}
		const inputTokensAbove = optionalNumber(
			tier.inputTokensAbove,
			`${prefix}.cost.tiers[${index}].inputTokensAbove`,
			problems,
		);
		if (inputTokensAbove === undefined) {
			continue;
		}
		tiers.push({
			input: typeof tier.input === "number" ? tier.input : 0,
			output: typeof tier.output === "number" ? tier.output : 0,
			cacheRead: typeof tier.cacheRead === "number" ? tier.cacheRead : 0,
			cacheWrite: typeof tier.cacheWrite === "number" ? tier.cacheWrite : 0,
			inputTokensAbove,
		});
	}
	return tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
}

function parseCost(raw: unknown, prefix: string, problems: string[]): Partial<Cost> | undefined {
	const source = asRecord(raw);
	if (!source) {
		if (raw !== undefined) {
			problems.push(`${prefix}.cost must be an object`);
		}
		return undefined;
	}
	const cost: Partial<Cost> = {};
	if (typeof source.input === "number") cost.input = source.input;
	if (typeof source.output === "number") cost.output = source.output;
	if (typeof source.cacheRead === "number") cost.cacheRead = source.cacheRead;
	if (typeof source.cacheWrite === "number") cost.cacheWrite = source.cacheWrite;
	const tiers = parseCostTiers(source.tiers, prefix, problems);
	if (tiers && tiers.length > 0) {
		cost.tiers = tiers;
	}
	return Object.keys(cost).length > 0 ? cost : undefined;
}

function parseInputModalities(raw: unknown, prefix: string, problems: string[]): Array<"text" | "image"> | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw)) {
		problems.push(`${prefix}.input must be an array`);
		return undefined;
	}
	const input: Array<"text" | "image"> = [];
	for (const entry of raw) {
		const normalized = typeof entry === "string" ? entry.trim().toLowerCase() : "";
		if (normalized === "text" || normalized === "image") {
			if (!input.includes(normalized)) {
				input.push(normalized);
			}
		} else {
			problems.push(`${prefix}.input contains unsupported modality "${String(entry)}" (allowed: text, image)`);
		}
	}
	return input.length > 0 ? input : undefined;
}

function parseModelOverride(raw: unknown, prefix: string, problems: string[]): ModelOverride | undefined {
	const source = asRecord(raw);
	if (!source) {
		if (raw !== undefined) {
			problems.push(`${prefix} must be an object`);
		}
		return undefined;
	}

	const override: ModelOverride = {
		name: optionalString(source.name, `${prefix}.name`, problems),
		contextWindow: optionalNumber(source.contextWindow, `${prefix}.contextWindow`, problems),
		maxTokens: optionalNumber(source.maxTokens, `${prefix}.maxTokens`, problems),
		reasoning: optionalBoolean(source.reasoning, `${prefix}.reasoning`, problems),
		thinkingLevels: parseThinkingLevels(source.thinkingLevels, prefix, problems),
		thinkingLevelMap: parseThinkingLevelMap(source.thinkingLevelMap, prefix, problems),
		input: parseInputModalities(source.input, prefix, problems),
		cost: parseCost(source.cost, prefix, problems),
		pricingModelId: optionalString(source.pricingModelId, `${prefix}.pricingModelId`, problems),
		fast: optionalBoolean(source.fast, `${prefix}.fast`, problems),
		pin: optionalBoolean(source.pin, `${prefix}.pin`, problems),
		hidden: optionalBoolean(source.hidden, `${prefix}.hidden`, problems),
		show: optionalBoolean(source.show, `${prefix}.show`, problems),
		headers: asRecord(source.headers) as Record<string, string> | undefined,
		samplingParams: asRecord(source.samplingParams),
	};

	if (override.hidden && override.show) {
		problems.push(`${prefix} declares both hidden and show; hidden takes precedence`);
	}

	return override;
}

export function compileOverrides(raw: OverridesFile | undefined, path: string, found: boolean): CompiledOverrides {
	const problems: string[] = [];
	const defaultsRaw = raw?.defaults;

	let contextWindowSource: ContextWindowSource = "context_window";
	if (defaultsRaw?.contextWindowSource !== undefined) {
		if (
			defaultsRaw.contextWindowSource === "context_window" ||
			defaultsRaw.contextWindowSource === "max_context_window"
		) {
			contextWindowSource = defaultsRaw.contextWindowSource;
		} else {
			problems.push(
				`defaults.contextWindowSource must be "context_window" or "max_context_window"; got ${JSON.stringify(defaultsRaw.contextWindowSource)}`,
			);
		}
	}

	let unlistedPolicy: UnlistedPolicy = "drop";
	if (defaultsRaw?.unlistedPolicy !== undefined) {
		if (defaultsRaw.unlistedPolicy === "drop" || defaultsRaw.unlistedPolicy === "retain") {
			unlistedPolicy = defaultsRaw.unlistedPolicy;
		} else {
			problems.push(
				`defaults.unlistedPolicy must be "drop" or "retain"; got ${JSON.stringify(defaultsRaw.unlistedPolicy)}`,
			);
		}
	}

	const unlistedGraceMs =
		defaultsRaw?.unlistedGraceMs !== undefined &&
		typeof defaultsRaw.unlistedGraceMs === "number" &&
		Number.isFinite(defaultsRaw.unlistedGraceMs) &&
		defaultsRaw.unlistedGraceMs >= 0
			? defaultsRaw.unlistedGraceMs
			: DEFAULT_UNLISTED_GRACE_MS;

	const defaults: CompiledOverrides["defaults"] = {
		contextWindowSource,
		contextWindow: optionalNumber(defaultsRaw?.contextWindow, "defaults.contextWindow", problems),
		maxTokens: optionalNumber(defaultsRaw?.maxTokens, "defaults.maxTokens", problems),
		respectVisibility:
			optionalBoolean(defaultsRaw?.respectVisibility, "defaults.respectVisibility", problems) ?? true,
		unlistedGraceMs,
		unlistedPolicy,
		pricing: optionalBoolean(defaultsRaw?.pricing, "defaults.pricing", problems) ?? true,
	};

	const models = new Map<string, ModelOverride>();
	for (const [id, modelRaw] of Object.entries(raw?.models ?? {})) {
		const parsed = parseModelOverride(modelRaw, `models["${id}"]`, problems);
		if (parsed) {
			models.set(id.trim().toLowerCase(), parsed);
		}
	}

	const patterns: CompiledOverrides["patterns"] = [];
	for (let index = 0; index < (raw?.patterns ?? []).length; index++) {
		const patternRaw = raw!.patterns![index];
		const prefix = `patterns[${index}]`;
		const match = optionalString(patternRaw?.match, `${prefix}.match`, problems);
		if (!match) {
			continue;
		}
		try {
			const regex = new RegExp(match, "i");
			const parsed = parseModelOverride(patternRaw, prefix, problems);
			if (parsed) {
				patterns.push({ source: { ...parsed, match }, regex });
			}
		} catch (error) {
			problems.push(`${prefix}.match is not a valid regular expression: ${String(error)}`);
		}
	}

	return { defaults, models, patterns, problems, path, found };
}

export function loadOverrides(agentDir: string): CompiledOverrides {
	const config = loadConfig(agentDir);
	const targetPath = overridesPath(agentDir, config);
	let raw: string;
	try {
		raw = readFileSync(targetPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return compileOverrides(undefined, targetPath, false);
		}
		log.warn(`failed to read overrides file: ${String(error)}`);
		return compileOverrides(undefined, targetPath, false);
	}

	try {
		const parsed = JSON.parse(raw) as OverridesFile;
		return compileOverrides(parsed, targetPath, true);
	} catch (error) {
		const message = `overrides file at ${targetPath} is not valid JSON: ${String(error)}`;
		log.warn(message);
		const compiled = compileOverrides(undefined, targetPath, true);
		compiled.problems.push(message);
		return compiled;
	}
}

export function mergeModelOverrides(...overrides: Array<ModelOverride | undefined>): ModelOverride {
	const merged: ModelOverride = {};
	for (const override of overrides) {
		if (!override) {
			continue;
		}
		if (override.name !== undefined) merged.name = override.name;
		if (override.contextWindow !== undefined) merged.contextWindow = override.contextWindow;
		if (override.maxTokens !== undefined) merged.maxTokens = override.maxTokens;
		if (override.reasoning !== undefined) merged.reasoning = override.reasoning;
		if (override.thinkingLevels !== undefined) merged.thinkingLevels = override.thinkingLevels;
		if (override.thinkingLevelMap !== undefined) {
			merged.thinkingLevelMap = { ...merged.thinkingLevelMap, ...override.thinkingLevelMap };
		}
		if (override.input !== undefined) merged.input = override.input;
		if (override.cost !== undefined) merged.cost = { ...merged.cost, ...override.cost };
		if (override.pricingModelId !== undefined) merged.pricingModelId = override.pricingModelId;
		if (override.fast !== undefined) merged.fast = override.fast;
		if (override.pin !== undefined) merged.pin = override.pin;
		if (override.hidden !== undefined) merged.hidden = override.hidden;
		if (override.show !== undefined) merged.show = override.show;
		if (override.headers !== undefined) merged.headers = { ...merged.headers, ...override.headers };
		if (override.samplingParams !== undefined) {
			merged.samplingParams = { ...merged.samplingParams, ...override.samplingParams };
		}
	}
	return merged;
}

export function resolveOverride(compiled: CompiledOverrides, modelId: string): ModelOverride | undefined {
	const matchingPatterns = compiled.patterns.filter(({ regex }) => regex.test(modelId)).map(({ source }) => source);
	const exact = compiled.models.get(modelId.trim().toLowerCase());
	if (matchingPatterns.length === 0 && !exact) {
		return undefined;
	}
	return mergeModelOverrides(...matchingPatterns, exact);
}

export function buildThinkingLevelMap(allowed: string[]): ThinkingLevelMap {
	const normalized = allowed.map((level) => level.trim().toLowerCase()).filter(Boolean);
	const allows = (level: string): boolean => normalized.includes(level);

	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		if (allows(level)) {
			map[level] = level;
		} else if (level === "off" && allows("none")) {
			map.off = "none";
		} else {
			map[level] = null;
		}
	}
	return map;
}

export function readOverridesFile(path: string): OverridesFile {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as OverridesFile;
	} catch {
		return {};
	}
}

export function saveOverridesFile(path: string, content: OverridesFile): void {
	writeJsonAtomic(path, content);
}

export function updateModelOverride(
	path: string,
	modelId: string,
	mutator: (current: ModelOverride) => ModelOverride | undefined,
): OverridesFile {
	const file = readOverridesFile(path);
	const models: Record<string, ModelOverride> = { ...(file.models ?? {}) };

	const existingKey = Object.keys(models).find((key) => key.toLowerCase() === modelId.toLowerCase());
	const key = existingKey ?? modelId;
	const current = models[key] ?? {};
	const updated = mutator({ ...current });

	if (!updated || Object.keys(updated).length === 0) {
		delete models[key];
	} else {
		models[key] = updated;
	}

	const nextFile: OverridesFile = { ...file, models };
	saveOverridesFile(path, nextFile);
	return nextFile;
}

export function buildStarterOverrides(modelIds: string[]): OverridesFile {
	const models: Record<string, ModelOverride> = {};
	for (const id of modelIds) {
		models[id] = { pin: true };
	}
	return {
		defaults: {
			contextWindowSource: "context_window",
			unlistedGraceMs: DEFAULT_UNLISTED_GRACE_MS,
			unlistedPolicy: "drop",
			pricing: true,
		},
		models,
	};
}
