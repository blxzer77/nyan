import { defineExtension, type PromptInput, section } from "@ny4n/durable";
import { getAgentDir } from "../../config.ts";
import { loadProjectContextFiles, type ResourceLoader } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkills, type Skill } from "../../core/skills.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../../core/tools/write.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** nyan's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "cwd"] as const;

/** What the prompt takes from the resources of one directory. */
interface PromptResources {
	readonly contextFiles: { path: string; content: string }[];
	readonly skills: Skill[];
	/** The loader's system prompt override and appended text; the session's own directory only. */
	readonly customPrompt?: string;
	readonly appendSystemPrompt?: string;
}

/**
 * nyan's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. For the session's directory the resource loader supplies context files, skills, and the
 * system prompt options, exactly as the legacy path reads them. Other directories load their own context files and
 * skills once, like nyan at startup.
 */
export function createNyanPrompt(settings: SettingsManager, fallbackCwd: string, loader?: ResourceLoader) {
	const loaded = new Map<string, PromptResources>();
	const load = (cwd: string): PromptResources => {
		if (cwd === fallbackCwd && loader !== undefined) {
			const appendSystemPrompt = loader.getAppendSystemPrompt();
			return {
				contextFiles: loader.getAgentsFiles().agentsFiles,
				skills: loader.getSkills().skills,
				customPrompt: loader.getSystemPrompt(),
				appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt.join("\n\n") : undefined,
			};
		}
		let found = loaded.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
			};
			loaded.set(cwd, found);
		}
		return found;
	};
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			...load(cwd),
		});
	};
	return defineExtension({
		name: "nyan-prompt",
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
