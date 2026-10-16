import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

/**
 * Login could not verify the credential it stored. `rejected`: the provider answered and refused the credential.
 * `unavailable`: no usable answer (network failure, timeout, server error), so nothing is known about the credential.
 */
export class CredentialVerificationError extends Error {
	readonly reason: "rejected" | "unavailable";

	constructor(reason: "rejected" | "unavailable", message: string) {
		super(message);
		this.name = "CredentialVerificationError";
		this.reason = reason;
	}
}

export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}

/**
 * Prioritized ordering for login provider selection.
 * CLIProxyAPI is placed first, followed by mainstream providers.
 */
export const LOGIN_PROVIDER_PRIORITY: Record<string, number> = {
	cliproxyapi: 0,
	anthropic: 1,
	openai: 2,
	deepseek: 3,
	google: 4,
	"kimi-coding": 5,
	xai: 6,
	openrouter: 7,
	"github-copilot": 8,
	"zai-coding-cn": 9,
	zai: 10,
	"qwen-token-plan-cn": 11,
	"qwen-token-plan": 12,
	mistral: 13,
	"llama.cpp": 14,
	meta: 15,
	"google-vertex": 16,
	azure: 17,
	"amazon-bedrock": 18,
	"minimax-cn": 19,
	minimax: 20,
	"moonshotai-cn": 21,
	moonshotai: 22,
};

export function compareLoginProviders(a: { id: string; name: string }, b: { id: string; name: string }): number {
	const priorityA = LOGIN_PROVIDER_PRIORITY[a.id.toLowerCase()] ?? 100;
	const priorityB = LOGIN_PROVIDER_PRIORITY[b.id.toLowerCase()] ?? 100;
	if (priorityA !== priorityB) {
		return priorityA - priorityB;
	}
	return a.name.localeCompare(b.name);
}
