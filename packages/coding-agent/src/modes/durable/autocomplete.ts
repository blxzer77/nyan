import { getSupportedThinkingLevels } from "@ny4n/ai";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type SlashCommand,
} from "@ny4n/tui";
import { DURABLE_TUI_COMMANDS, type DurableTuiCommand, pendingCommandMessage } from "../../core/durable/commands.ts";
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

/** How the completion describes a command this build recognizes but can only refuse. */
export const UNAVAILABLE_DESCRIPTION = "Not available on a durable session; running it says why";

/**
 * One `/` command of the durable TUI, described as legacy describes it. The list is `DURABLE_TUI_COMMANDS`, the same
 * list the router reads: a name offered here is a name that never becomes a prompt. A command the router only refuses
 * is described as unavailable rather than as the legacy command it cannot be.
 */
function durableCommand(name: DurableTuiCommand): SlashCommand {
	if (name === "tasks" || name === "agents") return { name, description: DURABLE_ONLY_DESCRIPTIONS[name] };
	if (pendingCommandMessage(name) !== undefined) return { name, description: UNAVAILABLE_DESCRIPTION };
	const builtin = BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
	return {
		name,
		...(builtin?.description === undefined ? {} : { description: builtin.description }),
		...(builtin?.argumentHint === undefined ? {} : { argumentHint: builtin.argumentHint }),
	};
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

/**
 * The `/thinking` arguments: the levels the conversation's model supports, which is `off` alone for a model without it.
 * Nothing is offered without a model to read them from: `/thinking` says so itself, and a completion must not claim a
 * level that command refuses to set.
 */
function thinkingArgumentCompletions(sources: DurableAutocompleteSources, prefix: string): AutocompleteItem[] | null {
	const current = sources.currentModel();
	const model = current === undefined ? undefined : sources.modelRuntime?.getModel(current.provider, current.modelId);
	if (model === undefined) return null;
	return fuzzyAutocompleteItems(
		getSupportedThinkingLevels(model),
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
 * The commands the durable TUI completes, in the order one submission is routed through them: the commands it answers,
 * then the commands extensions registered, then the prompt templates it expands. A name a router command owns is never
 * offered twice, because the router answers it first. Two extensions may register one name, so each is offered under its
 * own invocation name. Skill commands are left out: this path does not expand `/skill:<name>` yet, and offering one would
 * send its text to the model unexpanded.
 */
export function durableAutocompleteCommands(sources: DurableAutocompleteSources): SlashCommand[] {
	const commands = DURABLE_TUI_COMMANDS.map(durableCommand);
	for (const command of commands) {
		if (command.name === "model")
			command.getArgumentCompletions = (prefix) => modelArgumentCompletions(sources, prefix);
		else if (command.name === "thinking")
			command.getArgumentCompletions = (prefix) => thinkingArgumentCompletions(sources, prefix);
	}
	// The router answers its own names before anything else, so those are the ones nothing else may take.
	const taken = new Set<string>(DURABLE_TUI_COMMANDS);
	for (const command of sources.extensionCommands ?? []) {
		// Only a router name hides an extension command: a submission offers the extension the name before a template.
		if (taken.has(command.name) || taken.has(command.invocationName)) continue;
		taken.add(command.invocationName);
		commands.push({
			name: command.invocationName,
			...(command.description === undefined ? {} : { description: command.description }),
			...(command.getArgumentCompletions === undefined
				? {}
				: { getArgumentCompletions: command.getArgumentCompletions }),
		});
	}
	for (const template of sources.promptTemplates) {
		if (taken.has(template.name)) continue;
		taken.add(template.name);
		commands.push({
			name: template.name,
			description: template.description,
			...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
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
