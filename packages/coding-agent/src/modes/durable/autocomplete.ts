import { getSupportedThinkingLevels } from "@ny4n/ai";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type SlashCommand,
} from "@ny4n/tui";
import { DURABLE_TUI_COMMANDS, type DurableTuiCommand } from "../../core/durable/commands.ts";
import type { ResolvedCommand } from "../../core/extensions/index.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { PromptTemplate } from "../../core/prompt-templates.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { getModelSearchText } from "../interactive/model-search.ts";

/** The model the conversation runs, whose thinking levels `/thinking` offers. */
export interface DurableAutocompleteModel {
	readonly provider: string;
	readonly modelId: string;
}

/** What the durable TUI offers as `/` completions, and where its `@` paths resolve. */
export interface DurableAutocompleteSources {
	/** The session's working directory: `@` paths are relative to it, as legacy resolves them. */
	readonly cwd: string;
	readonly modelRuntime?: ModelRuntime;
	/** The models `/model` offers: the scoped set, or every one the session can use when null. */
	scopedModelIds(): readonly string[] | null;
	/** The conversation's current model; `/thinking` offers the levels it supports. */
	currentModel(): DurableAutocompleteModel | undefined;
	readonly promptTemplates: readonly PromptTemplate[];
	/** The commands extensions registered; each one is offered under its invocation name. */
	readonly extensionCommands?: readonly ResolvedCommand[];
}

/** The commands only the durable TUI has, so the legacy table has no description for them. */
const DURABLE_ONLY_DESCRIPTIONS: Record<"tasks" | "agents", string> = {
	tasks: "Show or hide the task panel",
	agents: "Switch to another agent conversation",
};

/**
 * One `/` command of the durable TUI, described as legacy describes it. The list is `DURABLE_TUI_COMMANDS`, the same
 * list the router reads: a name offered here is a name that never becomes a prompt.
 */
function durableCommand(name: DurableTuiCommand): SlashCommand {
	const description =
		name === "tasks" || name === "agents"
			? DURABLE_ONLY_DESCRIPTIONS[name]
			: BUILTIN_SLASH_COMMANDS.find((command) => command.name === name)?.description;
	return { name, ...(description === undefined ? {} : { description }) };
}

/**
 * The `/model` arguments: the models this session offers as `provider/id`, filtered as the picker filters them, so the
 * completion inserts the same reference a typed argument would.
 */
function modelArgumentCompletions(sources: DurableAutocompleteSources, prefix: string): AutocompleteItem[] | null {
	const available = sources.modelRuntime?.getAvailableSnapshot() ?? [];
	const scoped = sources.scopedModelIds();
	const models =
		scoped === null ? available : available.filter((model) => scoped.includes(`${model.provider}/${model.id}`));
	return fuzzyAutocompleteItems(models, prefix, getModelSearchText, (model) => ({
		value: `${model.provider}/${model.id}`,
		label: model.id,
		description: model.provider,
	}));
}

/** The `/thinking` arguments: the levels the conversation's model supports, which is `off` alone for a model without it. */
function thinkingArgumentCompletions(sources: DurableAutocompleteSources, prefix: string): AutocompleteItem[] | null {
	const current = sources.currentModel();
	const model = current === undefined ? undefined : sources.modelRuntime?.getModel(current.provider, current.modelId);
	const levels = model === undefined ? ["off"] : getSupportedThinkingLevels(model);
	return fuzzyAutocompleteItems(
		levels,
		prefix,
		(level) => level,
		(level) => ({ value: level, label: level }),
	);
}

function fuzzyAutocompleteItems<T>(
	items: readonly T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter([...items], prefix, getSearchText);
	return filtered.length === 0 ? null : filtered.map(toItem);
}

/**
 * The commands the durable TUI completes: the ones it answers, the prompt templates it expands, and the commands
 * extensions registered. Legacy's filtering applies, so an extension command whose name is a built-in is not offered
 * beside it. Skill commands are left out: this path does not expand `/skill:<name>` yet, and offering one would send its
 * text to the model unexpanded.
 */
export function durableAutocompleteCommands(sources: DurableAutocompleteSources): SlashCommand[] {
	const commands = DURABLE_TUI_COMMANDS.map(durableCommand);
	for (const command of commands) {
		if (command.name === "model")
			command.getArgumentCompletions = (prefix) => modelArgumentCompletions(sources, prefix);
		else if (command.name === "thinking")
			command.getArgumentCompletions = (prefix) => thinkingArgumentCompletions(sources, prefix);
	}
	const taken = new Set(commands.map((command) => command.name));
	for (const template of sources.promptTemplates) {
		if (taken.has(template.name)) continue;
		taken.add(template.name);
		commands.push({
			name: template.name,
			description: template.description,
			...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
		});
	}
	for (const command of sources.extensionCommands ?? []) {
		if (taken.has(command.name)) continue;
		taken.add(command.name);
		commands.push({
			name: command.invocationName,
			...(command.description === undefined ? {} : { description: command.description }),
			...(command.getArgumentCompletions === undefined
				? {}
				: { getArgumentCompletions: command.getArgumentCompletions }),
		});
	}
	return commands;
}

/**
 * The editor's completions on the durable path: `/` commands with their arguments, and `@` paths from `fdPath`.
 * `fdPath` is null until the tool check finds or installs `fd`, where only the commands complete.
 */
export function createDurableAutocompleteProvider(
	sources: DurableAutocompleteSources,
	fdPath: string | null = null,
): AutocompleteProvider {
	return new CombinedAutocompleteProvider(durableAutocompleteCommands(sources), sources.cwd, fdPath);
}
