import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { metaOAuth } from "./auth/oauth/meta.ts";
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "./auth/oauth/openrouter.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/**
 * Register every OAuth flow statically, for a bundle that cannot load them lazily, such as an application
 * compiled into a Bun executable. Nyan's own npm distribution loads them lazily and does not call this.
 */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiChatGPT: () => openaiChatGPTOAuth,
		githubCopilot: () => githubCopilotOAuth,
		openrouter: () => openRouterOAuth,
		kimiCoding: () => kimiCodingOAuth,
		meta: () => metaOAuth,
		xai: () => xaiOAuth,
	});
}
