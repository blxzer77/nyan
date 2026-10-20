import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@ny4n/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DURABLE_TUI_COMMANDS, routeDurableInput } from "../src/core/durable/commands.ts";
import { agentOf } from "../src/core/durable/runtime.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import {
	createDurableAutocompleteProvider,
	type DurableAutocompleteSources,
	durableAutocompleteCommands,
} from "../src/modes/durable/autocomplete.ts";
import type { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import { TuiHarness } from "./durable-tui-harness.ts";

/** Sources for a session that has no model runtime: the command list alone. */
function sourcesWithoutModels(overrides: Partial<DurableAutocompleteSources> = {}): DurableAutocompleteSources {
	return {
		cwd: "/work",
		scopedModelIds: () => null,
		currentModel: () => undefined,
		promptTemplates: [],
		...overrides,
	};
}

function template(name: string, description: string, argumentHint?: string): PromptTemplate {
	return {
		name,
		description,
		...(argumentHint === undefined ? {} : { argumentHint }),
		content: "body",
		sourceInfo: {
			path: `/prompts/${name}.md`,
			source: "local",
			scope: "user",
			origin: "top-level",
			baseDir: "/prompts",
		},
		filePath: `/prompts/${name}.md`,
	};
}

/** The suggestions the provider offers for one editor line, with the cursor at its end. */
async function suggestions(
	provider: AutocompleteProvider,
	line: string,
): Promise<{ readonly items: AutocompleteItem[]; readonly prefix: string } | null> {
	return await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

describe("durable autocomplete commands", () => {
	it("offers every command the router answers, so no offered name becomes a prompt", () => {
		const commands = durableAutocompleteCommands(sourcesWithoutModels());
		expect(commands.map((command) => command.name)).toEqual([...DURABLE_TUI_COMMANDS]);
		for (const command of commands) {
			expect(routeDurableInput(`/${command.name}`).kind).not.toBe("prompt");
		}
	});

	it("describes the commands from the legacy table and the two only this path has", () => {
		const commands = new Map(durableAutocompleteCommands(sourcesWithoutModels()).map((c) => [c.name, c]));
		expect(commands.get("resume")?.description).toBe("Resume a different session");
		expect(commands.get("tasks")?.description).toBe("Show or hide the task panel");
		expect(commands.get("agents")?.description).toBe("Switch to another agent conversation");
	});

	it("appends the prompt templates with their argument hint, and skips a name a built-in owns", () => {
		const commands = durableAutocompleteCommands(
			sourcesWithoutModels({
				promptTemplates: [template("review", "Review the change", "<path>"), template("model", "Duplicate")],
			}),
		);
		const byName = new Map(commands.map((command) => [command.name, command]));
		expect(byName.get("review")?.description).toBe("Review the change");
		expect(byName.get("review")?.argumentHint).toBe("<path>");
		// The built-in `/model` keeps its own entry: a template cannot shadow a command that never reaches the model.
		expect(byName.get("model")?.description).toBe("Select model (opens selector UI)");
		expect(commands.filter((command) => command.name === "model")).toHaveLength(1);
	});

	it("offers an extension command under its invocation name and skips one a built-in name owns", () => {
		const handler = async (): Promise<void> => {};
		const commands = durableAutocompleteCommands(
			sourcesWithoutModels({
				extensionCommands: [
					{
						name: "hello",
						invocationName: "hello",
						description: "Say hello",
						sourceInfo: { path: "/ext/hello.ts", source: "local", scope: "user", origin: "top-level" },
						handler,
					},
					{
						name: "quit",
						invocationName: "ext-quit",
						sourceInfo: { path: "/ext/quit.ts", source: "local", scope: "user", origin: "top-level" },
						handler,
					},
				],
			}),
		);
		const byName = new Map(commands.map((command) => [command.name, command]));
		expect(byName.get("hello")?.description).toBe("Say hello");
		expect(byName.has("quit")).toBe(true);
		expect(byName.has("ext-quit")).toBe(false);
	});

	it("offers `off` alone for /thinking when no model is selected", async () => {
		const provider = createDurableAutocompleteProvider(sourcesWithoutModels());
		expect(await suggestions(provider, "/thinking ")).toEqual({
			items: [{ value: "off", label: "off" }],
			prefix: "",
		});
	});

	it("offers nothing for /model when the session has no models", async () => {
		const provider = createDurableAutocompleteProvider(sourcesWithoutModels());
		expect(await suggestions(provider, "/model ")).toBeNull();
	});

	it("completes a command name from `/` and filters it as it is typed", async () => {
		const provider = createDurableAutocompleteProvider(sourcesWithoutModels());
		const all = await suggestions(provider, "/");
		expect(all?.prefix).toBe("/");
		expect(all?.items.map((item) => item.value)).toContain("resume");
		const filtered = await suggestions(provider, "/resu");
		expect(filtered?.items.map((item) => item.value)).toEqual(["resume"]);
	});
});

describe("durable autocomplete against a real session", () => {
	const harness = new TuiHarness();

	beforeEach(async () => {
		await harness.start();
	});

	afterEach(async () => {
		await harness.stop();
	});

	/** The sources the TUI builds: the open session's models, conversation, templates, and extension commands. */
	function sourcesOf(
		current: DurableSessionOwner,
		scoped: readonly string[] | null = null,
	): DurableAutocompleteSources {
		return {
			cwd: current.current.view.current().session.cwd,
			modelRuntime: current.current.modelRuntime,
			scopedModelIds: () => scoped,
			currentModel: () => agentOf(current.current.view.current().conversation).model,
			promptTemplates: current.current.promptTemplates,
			extensionCommands: current.current.extensionHost.runner.getRegisteredCommands(),
		};
	}

	it("completes a built-in, the prompt template a session loaded, and a registered extension command", async () => {
		const prompts = join(harness.agentDir, "prompts");
		await mkdir(prompts, { recursive: true });
		await writeFile(
			join(prompts, "review.md"),
			"---\ndescription: Review the change\nargument-hint: <path>\n---\nReview it.\n",
		);
		const extension: InlineExtension = (pi) => {
			pi.registerCommand("hello", { description: "Say hello", handler: async () => {} });
		};
		const current = await harness.open(undefined, { extraFactories: [extension] });
		const items = (await suggestions(createDurableAutocompleteProvider(sourcesOf(current)), "/"))?.items ?? [];
		const byValue = new Map(items.map((item) => [item.value, item.description]));
		expect(byValue.get("resume")).toBe("Resume a different session");
		expect(byValue.get("review")).toBe("<path> — Review the change");
		expect(byValue.get("hello")).toBe("Say hello");
	});

	it("completes the session's models as provider/id and filters them by prefix", async () => {
		const current = await harness.open();
		const provider = createDurableAutocompleteProvider(sourcesOf(current));
		expect(await suggestions(provider, "/model ")).toEqual({
			items: [{ value: "faux/faux-1", label: "faux-1", description: "faux" }],
			prefix: "",
		});
		expect(await suggestions(provider, "/model fa")).toEqual({
			items: [{ value: "faux/faux-1", label: "faux-1", description: "faux" }],
			prefix: "fa",
		});
		expect(await suggestions(provider, "/model zzz")).toBeNull();
	});

	it("offers only a scoped model, and the levels the current model supports", async () => {
		const current = await harness.open(undefined, { models: [{ id: "faux-1", reasoning: true }] });
		const scoped = createDurableAutocompleteProvider(sourcesOf(current, ["faux/faux-1"]));
		expect((await suggestions(scoped, "/model "))?.items.map((item) => item.value)).toEqual(["faux/faux-1"]);
		const unscoped = createDurableAutocompleteProvider(sourcesOf(current, ["other/model"]));
		expect(await suggestions(unscoped, "/model ")).toBeNull();
		expect((await suggestions(scoped, "/thinking "))?.items.map((item) => item.value)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
		expect((await suggestions(scoped, "/thinking hi"))?.items.map((item) => item.value)).toEqual(["high"]);
	});
});
