import type { Api, Model } from "@ny4n/ai";
import type { Component } from "@ny4n/tui";
import { resolveModelScopeFromModels } from "../../core/model-resolver.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	type ModelsCallbacks,
	type ModelsConfig,
	ScopedModelsSelectorComponent,
} from "../interactive/components/scoped-models-selector.ts";

/** Every enabled model, or the ordered list the user chose; `null` is "every model". */
export type ScopedModelIds = readonly string[] | null;

export interface DurableScopedModelsDeps {
	readonly settings: SettingsManager;
	/** The models available now, which the dialog toggles and orders. */
	readonly models: () => readonly Model<Api>[];
	/**
	 * The set `/model` filters with and the model cycle walks. The durable controller has no session-scoped models, so
	 * the TUI holds the set and the dialog changes it in place; the settings are what a later start reads.
	 */
	readonly apply: (ids: ScopedModelIds) => void;
}

/**
 * The enabled model ids from nyan's settings, resolved against the models available now. A pattern that matches nothing
 * is kept as it was written, as legacy's picker keeps it, so the user can see and remove it.
 */
export function enabledModelIds(
	patterns: readonly string[] | undefined,
	models: readonly Model<any>[],
): string[] | null {
	if (patterns === undefined || patterns.length === 0) return null;
	const resolved = resolveModelScopeFromModels([...patterns], models);
	const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
	for (const diagnostic of resolved.diagnostics) {
		if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
	}
	return ids;
}

/** The next settings value for a selection the dialog reported: every model enabled is the same as no filter. */
export function enabledModelPatterns(ids: ScopedModelIds, models: readonly Model<any>[]): string[] | undefined {
	if (ids === null) return undefined;
	const allIds = models.map((model) => `${model.provider}/${model.id}`);
	const everyModel = ids.length === allIds.length && ids.every((id) => allIds.includes(id));
	return everyModel ? undefined : [...ids];
}

/**
 * `/scoped-models`: the same selector the legacy TUI shows, over the models this session can use. A change applies to
 * the running TUI at once; saving it writes `enabledModels`, which is what the next start reads.
 */
export function scopedModelsDialog(
	deps: DurableScopedModelsDeps,
	onClose: () => void,
): { readonly component: ScopedModelsSelectorComponent; readonly focus: Component } {
	const models = [...deps.models()];
	const callbacks: ModelsCallbacks = {
		onChange: (ids) => deps.apply(ids),
		onPersist: (ids) => deps.settings.setEnabledModels(enabledModelPatterns(ids, models)),
		onCancel: onClose,
	};
	const config: ModelsConfig = {
		allModels: models,
		enabledModelIds: enabledModelIds(deps.settings.getEnabledModels(), models),
	};
	const selector = new ScopedModelsSelectorComponent(config, callbacks);
	return { component: selector, focus: selector };
}
