/**
 * Cost lookup.
 *
 * CLIProxyAPI reports exact token counts per response but no price, so rates come
 * from a catalog. Precedence is: explicit override > models.dev > zero.
 *
 * models.dev rates are USD per million tokens, which is exactly what nyan's model
 * `cost` fields expect.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_FETCH_TIMEOUT_MS = 8_000;

export const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface CostTier {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Apply this tier when total input-side usage exceeds this threshold. */
	inputTokensAbove: number;
}

export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
}

export interface CostEntry {
	providerId: string;
	modelId: string;
	standard: Cost;
	fast?: Cost;
}

export interface CostCatalog {
	/** Lowercased id (and namespace-stripped id) -> entries. */
	exact: Map<string, CostEntry[]>;
	/** Alphanumeric-only id -> entries. Used as a last-resort match. */
	normalized: Map<string, CostEntry[]>;
}

export function emptyCostCatalog(): CostCatalog {
	return { exact: new Map(), normalized: new Map() };
}

/** Whether a cost carries any non-zero rate. */
export function costHasRates(cost: Cost): boolean {
	if (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0) {
		return true;
	}
	return (cost.tiers ?? []).some(
		(tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
	);
}

interface ModelsDevCostPayload {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
	tiers?: unknown;
	context_over_200k?: unknown;
}

interface ModelsDevModelPayload {
	cost?: ModelsDevCostPayload;
	experimental?: { modes?: Record<string, { cost?: ModelsDevCostPayload } | undefined> };
}

const NAMESPACE_PREFIX =
	/^(openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta|alibaba|qwen|xiaomi|stepfun|tencent|baidu|bytedance|z-ai|zai|amazon|meta-llama)[/:.]/i;

/**
 * Vendor preference per model family. Used to disambiguate when several providers
 * publish the same model id at different prices.
 */
const FAMILY_PREFERENCES: Array<{ pattern: RegExp; providers: string[] }> = [
	{ pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/, providers: ["openai", "openai-codex", "opencode"] },
	{ pattern: /^claude-/, providers: ["anthropic"] },
	{ pattern: /^(?:gemini-|gemma-)/, providers: ["google", "google-vertex"] },
	{ pattern: /^grok-/, providers: ["xai"] },
	{ pattern: /^deepseek-/, providers: ["deepseek"] },
	{ pattern: /^glm-/, providers: ["zhipuai", "z-ai"] },
	{ pattern: /^(?:kimi-|moonshot-)/, providers: ["moonshotai"] },
	{ pattern: /^minimax-/, providers: ["minimax"] },
	{ pattern: /^step-/, providers: ["stepfun"] },
	{ pattern: /^qwen-/, providers: ["alibaba", "qwen"] },
	{ pattern: /^mistral-/, providers: ["mistral"] },
	{ pattern: /^llama-/, providers: ["meta"] },
];

/** Known proxy-only ids whose billable base model differs from the id. */
const PRICE_ALIASES: Record<string, string[]> = {
	"gemini-pro-agent": ["gemini-3.1-pro-preview"],
	"gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
	"gemini-3.6-flash-high": ["gemini-3.6-flash"],
	"gemini-3-flash-agent": ["gemini-3.5-flash"],
	"grok-composer-2.5-fast": ["grok-4.3"],
	"grok-3-mini": ["xai/grok-3-mini"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRate(source: Record<string, unknown>, key: keyof Cost, fallback: number): number {
	const rawKey = key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key;
	return finiteNumber(source[key] ?? source[rawKey]) ?? fallback;
}

export function parseModelsDevCost(raw: ModelsDevCostPayload | undefined): Cost | undefined {
	const source = asRecord(raw);
	if (!source) {
		return undefined;
	}
	const input = finiteNumber(source.input);
	const output = finiteNumber(source.output);
	if (input === undefined && output === undefined) {
		return undefined;
	}

	const cost: Cost = {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: readRate(source, "cacheRead", 0),
		cacheWrite: readRate(source, "cacheWrite", 0),
	};

	const tiers = new Map<number, CostTier>();
	const addTier = (rawTier: unknown, fallbackThreshold?: number): void => {
		const tierSource = asRecord(rawTier);
		if (!tierSource) {
			return;
		}
		const descriptor = asRecord(tierSource.tier);
		const threshold =
			finiteNumber(descriptor?.above) ??
			finiteNumber(descriptor?.tokens_above) ??
			finiteNumber(descriptor?.input_tokens_above) ??
			fallbackThreshold;
		if (threshold === undefined || threshold <= 0) {
			return;
		}
		tiers.set(threshold, {
			input: readRate(tierSource, "input", cost.input),
			output: readRate(tierSource, "output", cost.output),
			cacheRead: readRate(tierSource, "cacheRead", cost.cacheRead),
			cacheWrite: readRate(tierSource, "cacheWrite", cost.cacheWrite),
			inputTokensAbove: threshold,
		});
	};

	if (Array.isArray(source.tiers)) {
		for (const tier of source.tiers) {
			addTier(tier);
		}
	} else if (asRecord(source.tiers)) {
		for (const [threshold, tier] of Object.entries(asRecord(source.tiers)!)) {
			addTier(tier, Number(threshold));
		}
	}
	if (source.context_over_200k) {
		addTier(source.context_over_200k, 200_000);
	}

	if (tiers.size > 0) {
		cost.tiers = [...tiers.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	}
	return cost;
}

export function normalizeModelId(id: string): string {
	return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function stripNamespace(id: string): string {
	return id.replace(NAMESPACE_PREFIX, "");
}

export function buildCostCatalog(providersPayload: Record<string, unknown>): CostCatalog {
	const exact = new Map<string, CostEntry[]>();
	const normalized = new Map<string, CostEntry[]>();

	const addEntry = (key: string, entry: CostEntry): void => {
		const bucket = exact.get(key) ?? [];
		bucket.push(entry);
		exact.set(key, bucket);

		const normKey = normalizeModelId(key);
		if (normKey) {
			const normBucket = normalized.get(normKey) ?? [];
			normBucket.push(entry);
			normalized.set(normKey, normBucket);
		}
	};

	for (const [providerId, providerRaw] of Object.entries(providersPayload)) {
		const provider = asRecord(providerRaw);
		const models = asRecord(provider?.models);
		if (!models) {
			continue;
		}

		for (const [modelId, modelRaw] of Object.entries(models)) {
			const model = modelRaw as ModelsDevModelPayload | undefined;
			const standard = parseModelsDevCost(model?.cost);
			if (!standard) {
				continue;
			}
			const fast = parseModelsDevCost(model?.experimental?.modes?.fast?.cost);
			const entry: CostEntry = { providerId, modelId, standard, ...(fast ? { fast } : {}) };

			const lowerId = modelId.toLowerCase();
			addEntry(lowerId, entry);

			const stripped = stripNamespace(lowerId);
			if (stripped !== lowerId) {
				addEntry(stripped, entry);
			}

			const scoped = `${providerId.toLowerCase()}/${lowerId}`;
			addEntry(scoped, entry);
		}
	}

	return { exact, normalized };
}

function pickPreferredEntry(entries: CostEntry[], modelId: string): CostEntry | undefined {
	if (entries.length === 1) {
		return entries[0];
	}

	for (const { pattern, providers } of FAMILY_PREFERENCES) {
		if (pattern.test(modelId)) {
			for (const preferred of providers) {
				const match = entries.find((entry) => entry.providerId === preferred);
				if (match) {
					return match;
				}
			}
		}
	}

	const first = entries[0]!;
	const allSame = entries.every(
		(entry) =>
			entry.standard.input === first.standard.input &&
			entry.standard.output === first.standard.output &&
			entry.standard.cacheRead === first.standard.cacheRead &&
			entry.standard.cacheWrite === first.standard.cacheWrite,
	);
	return allSame ? first : undefined;
}

export function matchCost(
	modelId: string,
	catalog: CostCatalog,
	options: { override?: Cost; fast?: boolean } = {},
): Cost {
	if (options.override) {
		return options.override;
	}

	const candidates = [modelId, ...(PRICE_ALIASES[modelId] ?? []), stripNamespace(modelId)];
	for (const candidate of candidates) {
		const exact = catalog.exact.get(candidate.toLowerCase());
		if (exact && exact.length > 0) {
			const picked = pickPreferredEntry(exact, candidate);
			if (picked) {
				return options.fast && picked.fast ? picked.fast : picked.standard;
			}
		}
	}

	const normMatch = catalog.normalized.get(normalizeModelId(modelId));
	if (normMatch && normMatch.length > 0) {
		const picked = pickPreferredEntry(normMatch, modelId);
		if (picked) {
			return options.fast && picked.fast ? picked.fast : picked.standard;
		}
	}

	return ZERO_COST;
}

export function computeCost(
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
	cost: Cost,
): number {
	const input = usage.input || 0;
	const output = usage.output || 0;
	const cacheRead = usage.cacheRead || 0;
	const cacheWrite = usage.cacheWrite || 0;

	let rate: Cost = cost;
	const totalInputSide = input + cacheRead;
	if (cost.tiers && cost.tiers.length > 0) {
		for (const tier of cost.tiers) {
			if (totalInputSide > tier.inputTokensAbove) {
				rate = tier;
			}
		}
	}

	const total =
		(input * rate.input + output * rate.output + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite) /
		1_000_000;
	return Number(total.toFixed(6));
}

export function modelsDevCachePath(agentDir: string): string {
	return join(agentDir, "models-dev-cache.json");
}

export function isModelsDevCacheFresh(timestamp: number, now = Date.now()): boolean {
	return now - timestamp < MODELS_DEV_CACHE_TTL_MS;
}

export function readModelsDevCache(
	agentDir: string,
): { timestamp: number; providers: Record<string, unknown> } | undefined {
	try {
		const content = readFileSync(modelsDevCachePath(agentDir), "utf8");
		const parsed = JSON.parse(content) as { timestamp?: unknown; providers?: unknown };
		if (
			typeof parsed.timestamp === "number" &&
			parsed.providers &&
			typeof parsed.providers === "object" &&
			!Array.isArray(parsed.providers)
		) {
			return { timestamp: parsed.timestamp, providers: parsed.providers as Record<string, unknown> };
		}
	} catch {
		// Cache read failure is non-fatal: returns undefined so the caller fetches.
	}
	return undefined;
}

export function writeModelsDevCache(
	agentDir: string,
	providers: Record<string, unknown>,
	timestamp = Date.now(),
): void {
	try {
		const path = modelsDevCachePath(agentDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ timestamp, providers }), "utf8");
	} catch (error) {
		log.warn(`failed to write models.dev cache: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function fetchModelsDevCatalog(
	agentDir: string,
	options: { signal?: AbortSignal } = {},
): Promise<{ timestamp: number; providers: Record<string, unknown> } | undefined> {
	const timeout = AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	try {
		const response = await fetch(MODELS_DEV_URL, { signal, headers: { accept: "application/json" } });
		if (!response.ok) {
			log.warn(`models.dev returned HTTP ${response.status}`);
			return undefined;
		}
		const providers = (await response.json()) as Record<string, unknown>;
		if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
			return undefined;
		}
		const timestamp = Date.now();
		writeModelsDevCache(agentDir, providers, timestamp);
		return { timestamp, providers };
	} catch (error) {
		if (options.signal?.aborted) {
			return undefined;
		}
		log.debug(`models.dev fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
