/**
 * Fast mode: OpenAI's priority service tier.
 *
 * Proxy models are Fast-capable when the catalog advertises a non-empty
 * `service_tiers` array. Native `openai-codex` GPT models are also Fast-capable:
 * their built-in catalog exposes tiered pricing and the same `service_tier: "priority"`
 * request field is accepted by the Codex Responses API.
 *
 * Priority processing bills at a higher rate, so this is off by default.
 */

import type { Model } from "@ny4n/ai";
import { saveConfig } from "./config.ts";
import { log } from "./log.ts";

export const PRIORITY_SERVICE_TIER = "priority";

/** nyan's built-in Codex provider, and the id prefix of its tiered GPT models. */
export const NATIVE_CODEX_PROVIDER = "openai-codex";
const NATIVE_CODEX_FAST_PREFIX = "gpt-";

/** The model shape the Fast checks need: an id plus the provider serving it. */
type Candidate = Pick<Model<any>, "provider"> & { id: string };

export class FastModeController {
	private enabled: boolean;
	private supported = new Set<string>();

	constructor(enabled: boolean) {
		this.enabled = enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/** Replace the set of Fast-capable model ids from the latest catalog. */
	setSupportedModelIds(modelIds: Iterable<string>): void {
		this.supported = new Set(
			Array.from(modelIds, (id) => id.trim())
				.filter(Boolean)
				.map((id) => id.toLowerCase()),
		);
	}

	supportedModelIds(): string[] {
		return [...this.supported].sort();
	}

	isModelSupported(modelId: string): boolean {
		return this.supported.has(modelId.trim().toLowerCase());
	}

	/**
	 * Whether this extension is responsible for Fast on this model at all.
	 *
	 * Native Codex GPT models and models served by `providerId` are ours; a model
	 * from another provider is somebody else's, so Fast says nothing about whether
	 * *it* could be fast. Callers that report to the user need that distinction:
	 * "switch to a Fast-capable model" only makes sense for a foreign model, while
	 * "does not advertise a priority service tier" only makes sense for ours.
	 */
	managesModel(model: Candidate, providerId: string): boolean {
		if (model.provider === NATIVE_CODEX_PROVIDER) {
			return model.id.trim().toLowerCase().startsWith(NATIVE_CODEX_FAST_PREFIX);
		}
		return model.provider === providerId;
	}

	/** Whether Fast applies to this model: native Codex GPT, or a catalog tier. */
	isFastCapableModel(model: Candidate, providerId: string): boolean {
		if (!this.managesModel(model, providerId)) {
			return false;
		}
		return model.provider === NATIVE_CODEX_PROVIDER || this.isModelSupported(model.id);
	}

	/**
	 * What the footer should say about Fast for this model: `on` or `off` when the
	 * model has a priority tier, `undefined` when it has none (nothing to show).
	 */
	stateForModel(model: Candidate, providerId: string): "on" | "off" | undefined {
		if (!this.isFastCapableModel(model, providerId)) {
			return undefined;
		}
		return this.enabled ? "on" : "off";
	}

	/** Whether Fast changes the wire request for this model right now. */
	isEffectiveForModel(model: Candidate, providerId: string): boolean {
		return this.enabled && this.isFastCapableModel(model, providerId);
	}
}

/** Add the priority service tier to a request payload. */
export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	return { ...(payload as Record<string, unknown>), service_tier: PRIORITY_SERVICE_TIER };
}

export function persistFastPreference(agentDir: string, enabled: boolean): void {
	saveConfig(agentDir, { fast: enabled });
	log.debug(`fast preference saved: ${enabled}`);
}
