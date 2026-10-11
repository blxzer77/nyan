import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
	Usage,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** The type of a model. Models without `type` are chat models. */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** Runtime-checked model type narrowing, including legacy chat models without `type`. */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** Rejects classifier images for models whose catalog entry does not accept image input. */
export function assertClassifierInputSupported(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
): void {
	if (context.images?.length && !model.input.includes("image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
	}
}

export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * Non-chat models never match, even when their api id equals `api`.
 */
export function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi> {
	return isModelType(model, "chat") && model.api === api;
}

export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing their type, id, and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	if (!a || !b) return false;
	return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
