import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@ny4n/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { routeDurableInput } from "../src/core/durable/commands.ts";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import {
	createDurableAutocompleteProvider,
	type DurableAutocompleteSources,
	durableAutocompleteCommands,
	UNAVAILABLE_DESCRIPTION,
} from "../src/modes/durable/autocomplete.ts";
import { type DurableSessionOwner, tuiof } from "../src/modes/durable/session-owner.ts";
import { durableAutocompleteSourcesOf } from "../src/modes/durable/tui.ts";
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
	it("offers exactly the router's commands, so no offered name becomes a prompt", () => {
		const commands = durableAutocompleteCommands(sourcesWithoutModels());
		// The completion surface, written out: a command added to or dropped from the router fails this list.
		expect(commands.map((command) => command.name)).toEqual([
			"tasks",
			"agents",
			"model",
			"compact",
			"new",
			"resume",
			"name",
			"session",
			"fork",
			"clone",
			"quit",
			"export",
			"copy",
			"changelog",
			"settings",
			"thinking",
			"scoped-models",
			"import",
			"share",
			"bug",
			"hotkeys",
			"trust",
			"login",
			"logout",
			"reload",
			"tree",
		]);
		for (const command of commands) {
			const route = routeDurableInput(`/${command.name}`);
			expect(route.kind === "command" || route.kind === "unsupported").toBe(true);
		}
	});

	it("carries the legacy argument hint, and describes the two commands it can only refuse as unavailable", () => {
		const byName = new Map(durableAutocompleteCommands(sourcesWithoutModels()).map((c) => [c.name, c]));
		expect(byName.get("model")?.argumentHint).toBe("<provider/model>");
		expect(byName.get("import")?.description).toBe(UNAVAILABLE_DESCRIPTION);
		expect(byName.get("tree")?.description).toBe(UNAVAILABLE_DESCRIPTION);
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
		// The built-in `/quit` is the only one offered: the extension's `ext-quit` would lose the dispatch to it.
		expect(commands.filter((command) => command.name === "quit")).toHaveLength(1);
		expect(byName.get("quit")?.description).toBe(`Quit ${APP_NAME}`);
		expect(byName.has("ext-quit")).toBe(false);
	});

	it("offers each of two extensions that register one name under its own invocation name", () => {
		const handler = async (): Promise<void> => {};
		const commands = durableAutocompleteCommands(
			sourcesWithoutModels({
				extensionCommands: [
					{
						name: "shared",
						invocationName: "shared:1",
						sourceInfo: { path: "/ext/one.ts", source: "local", scope: "user", origin: "top-level" },
						handler,
					},
					{
						name: "shared",
						invocationName: "shared:2",
						sourceInfo: { path: "/ext/two.ts", source: "local", scope: "user", origin: "top-level" },
						handler,
					},
				],
			}),
		);
		expect(commands.filter((command) => command.name.startsWith("shared")).map((command) => command.name)).toEqual([
			"shared:1",
			"shared:2",
		]);
	});

	it("does not let a prompt template hide an extension command of the same name", () => {
		const commands = durableAutocompleteCommands(
			sourcesWithoutModels({
				promptTemplates: [template("hello", "A template")],
				extensionCommands: [
					{
						name: "hello",
						invocationName: "hello",
						description: "Say hello",
						sourceInfo: { path: "/ext/hello.ts", source: "local", scope: "user", origin: "top-level" },
						handler: async () => {},
					},
				],
			}),
		);
		// The extension answers the name first, so its own entry is the one the completion may keep.
		expect(commands.filter((command) => command.name === "hello").map((command) => command.description)).toEqual([
			"Say hello",
		]);
	});

	it("offers no /thinking level when no model is selected, which the command reports itself", async () => {
		const provider = createDurableAutocompleteProvider(sourcesWithoutModels());
		expect(await suggestions(provider, "/thinking ")).toBeNull();
	});

	it("completes no `@` path without an fd to list them", async () => {
		const provider = createDurableAutocompleteProvider(sourcesWithoutModels());
		expect(await suggestions(provider, "look at @al")).toBeNull();
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

	/** The sources `runDurableTui` installs, built from the open the session owner hands it. */
	function sourcesOf(
		current: DurableSessionOwner,
		scoped: readonly string[] | null = null,
	): DurableAutocompleteSources {
		return durableAutocompleteSourcesOf(
			() => tuiof(current.current),
			() => scoped,
		);
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

describe("durable autocomplete paths", () => {
	it.skipIf(process.platform === "win32")(
		"offers a nested path only once the tool check handed the provider an fd",
		async () => {
			// A directory walk of the base directory finds a top-level file; only fd searches below it, so a nested path is
			// what separates "no fd yet" from "fd found". The fake stands in for the real binary, which the start may still
			// be downloading.
			const cwd = await mkdtemp(join(tmpdir(), "nyan-tui-fd-"));
			await writeFile(join(cwd, "alpha.txt"), "x");
			await mkdir(join(cwd, "nested"), { recursive: true });
			await writeFile(join(cwd, "nested", "beta.txt"), "x");
			const fakeFd = join(cwd, "fd-under-test");
			await writeFile(fakeFd, "#!/usr/bin/env node\nconsole.log('nested/beta.txt');\n");
			await chmod(fakeFd, 0o755);
			const sources = sourcesWithoutModels({ cwd });
			expect((await suggestions(createDurableAutocompleteProvider(sources, null), "@bet"))?.items ?? []).toEqual([]);
			const offered = await suggestions(createDurableAutocompleteProvider(sources, fakeFd), "@bet");
			expect(offered?.items.map((item) => item.value)).toEqual(["@nested/beta.txt"]);
		},
	);
});
