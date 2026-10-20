import { getSupportedThinkingLevels } from "@ny4n/ai";
import { setKeybindings } from "@ny4n/tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { agentOf } from "../src/core/durable/runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import type { DurableCommandProduct } from "../src/modes/durable/commands.ts";
import { enabledModelIds, enabledModelPatterns } from "../src/modes/durable/scoped-models.ts";
import type { DurableSessionOwner } from "../src/modes/durable/session-owner.ts";
import {
	type DurableSettingsUi,
	durableSettingsCallbacks,
	durableSettingsConfig,
} from "../src/modes/durable/settings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/ui/theme/theme.ts";
import { commandsOf, headless, screen, TuiHarness } from "./durable-tui-harness.ts";

/**
 * The settings, account, and toolkit commands of the durable TUI, driven against a real durable session and the real
 * settings manager. A dialog is asserted through the component the command presents and the effect of driving it; the
 * parts of a settings change that reach the terminal are recorded by a `DurableSettingsUi` double, which is the one
 * boundary these tests fake.
 */

/** Records what a settings change asked the terminal to do. */
class RecordingSettingsUi implements DurableSettingsUi {
	readonly calls: string[] = [];
	theme = "system";
	terminal: "dark" | "light" = "dark";

	themeSelection(): string {
		return this.theme;
	}

	terminalTheme(): "dark" | "light" {
		return this.terminal;
	}

	setTheme(setting: string): void {
		this.theme = setting;
		this.calls.push(`theme:${setting}`);
	}

	previewTheme(setting: string): void {
		this.calls.push(`preview:${setting}`);
	}

	setOutputPad(padding: 0 | 1): void {
		this.calls.push(`outputPad:${padding}`);
	}

	setEditorPaddingX(padding: number): void {
		this.calls.push(`editorPaddingX:${padding}`);
	}

	setShowImages(show: boolean): void {
		this.calls.push(`showImages:${show}`);
	}

	setImageWidthCells(width: number): void {
		this.calls.push(`imageWidthCells:${width}`);
	}

	setHardwareCursor(enabled: boolean): void {
		this.calls.push(`hardwareCursor:${enabled}`);
	}

	setClearOnShrink(enabled: boolean): void {
		this.calls.push(`clearOnShrink:${enabled}`);
	}

	setScrollbar(mode: "auto" | "always" | "hidden"): void {
		this.calls.push(`scrollbar:${mode}`);
	}

	setCopyOnSelect(enabled: boolean): void {
		this.calls.push(`copyOnSelect:${enabled}`);
	}

	setWheelScrollLines(lines: number | "auto"): void {
		this.calls.push(`wheel:${lines}`);
	}
}

describe("durable TUI settings and account commands", () => {
	const harness = new TuiHarness();
	const ui = new RecordingSettingsUi();

	beforeEach(async () => {
		await harness.start();
		// The dialogs read the active keybindings for their keys, as the running TUI does.
		setKeybindings(KeybindingsManager.create());
		// The shared dialogs render the active theme, which the running TUI initializes before the first frame.
		initTheme();
	});

	afterEach(async () => {
		await harness.stop();
	});

	/** A session whose model supports thinking, which `/thinking` needs. */
	async function openThinking(): Promise<DurableSessionOwner> {
		return await harness.open(undefined, { models: [{ id: "faux-thinker", reasoning: true }] });
	}

	/** The product surface the TUI hands its commands, over the session it holds now. */
	function productOf(
		owner: DurableSessionOwner,
		overrides: { readonly setScopedModels?: (ids: readonly string[] | null) => void } = {},
	): DurableCommandProduct {
		return {
			settings: owner.current.settings,
			modelRuntime: owner.current.modelRuntime,
			// Only the login dialogs draw on the terminal; the flows these tests drive do not open one.
			tui: {} as never,
			settingsUi: ui,
			keybindings: KeybindingsManager.create(),
			getScopedModels: () => null,
			setScopedModels: overrides.setScopedModels ?? (() => {}),
		};
	}

	function settingsDeps(owner: DurableSessionOwner) {
		return {
			settings: owner.current.settings,
			modelRuntime: owner.current.modelRuntime,
			view: () => owner.current.view.current(),
			controller: owner.current.controller,
			ui,
		};
	}

	test("/thinking sets the level of the current model and reports it", async () => {
		const owner = await openThinking();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));
		const model = owner.current.modelRuntime.getAvailableSnapshot()[0];
		if (model === undefined) throw new Error("the faux provider registered no model");
		const target = getSupportedThinkingLevels(model)[2];
		if (target === undefined) throw new Error("the faux model reports no third thinking level");

		await commands.run("thinking", target);

		expect(agentOf(owner.current.view.current().conversation).thinkingLevel).toBe(target);
		expect(screenState.notices).toEqual([`Thinking level: ${target}`]);
		expect(screenState.presented).toEqual([]);
	});

	test("/thinking refuses a level the model does not have and leaves the level alone", async () => {
		const owner = await openThinking();
		const before = agentOf(owner.current.view.current().conversation).thinkingLevel;
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));
		const model = owner.current.modelRuntime.getAvailableSnapshot()[0];
		if (model === undefined) throw new Error("the faux provider registered no model");

		await commands.run("thinking", "ludicrous");

		expect(screenState.notices).toEqual([
			`Unknown thinking level "ludicrous". Available levels: ${getSupportedThinkingLevels(model).join(", ")}.`,
		]);
		expect(agentOf(owner.current.view.current().conversation).thinkingLevel).toBe(before);
	});

	test("/thinking without an argument presents the level selector and applies its choice", async () => {
		const owner = await openThinking();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("thinking", "");

		const selector = screenState.presented[0];
		expect(selector).toBeInstanceOf(ThinkingSelectorComponent);
		if (!(selector instanceof ThinkingSelectorComponent)) throw new Error("no thinking selector");
		selector.getSelectList().setSelectedIndex(2);
		selector.handleInput("\r");

		const model = owner.current.modelRuntime.getAvailableSnapshot()[0];
		if (model === undefined) throw new Error("the faux provider registered no model");
		const expected = getSupportedThinkingLevels(model)[2];
		// The level is committed through the durable controller, which settles it asynchronously.
		await vi.waitFor(() => {
			expect(agentOf(owner.current.view.current().conversation).thinkingLevel).toBe(expected);
		});
		expect(screenState.notices).toEqual([`Thinking level: ${expected}`]);
		expect(screenState.presented).toEqual([]);
	});

	test("/settings presents the shared settings dialog over this session's state", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("settings", "");

		expect(screenState.presented[0]).toBeInstanceOf(SettingsSelectorComponent);
	});

	test("/settings changes reach the session, nyan's settings, and the terminal", async () => {
		const owner = await harness.open();
		const deps = settingsDeps(owner);
		const callbacks = durableSettingsCallbacks(deps);

		callbacks.onAutoCompactChange(false);
		callbacks.onSteeringModeChange("all");
		callbacks.onFollowUpModeChange("one-at-a-time");
		callbacks.onOutputPadChange(0);
		callbacks.onEditorPaddingXChange(3);
		callbacks.onModelThinkingLevelChange("faux", "faux-1", "high");
		callbacks.onThemeChange("light");
		// The queue modes are committed through the durable controller, which settles them asynchronously.
		await vi.waitFor(() => {
			expect(owner.current.controller.getAutoCompaction()).toBe(false);
			expect(owner.current.controller.getQueueModes()).toEqual({
				steeringMode: "all",
				followUpMode: "one-at-a-time",
			});
		});
		expect(owner.current.settings.getOutputPad()).toBe(0);
		expect(owner.current.settings.getEditorPaddingX()).toBe(3);
		expect(owner.current.settings.getAllModelThinkingLevels()).toEqual({ "faux/faux-1": "high" });
		expect(owner.current.settings.getThemeSetting()).toBe("light");
		expect(ui.calls).toEqual(["outputPad:0", "editorPaddingX:3", "theme:light"]);
		// The dialog reads the same values back, so a reopened item shows what was stored.
		expect(durableSettingsConfig(deps).outputPad).toBe(0);
		expect(durableSettingsConfig(deps).editorPaddingX).toBe(3);
	});

	test("/settings saves the default model the picker cannot save (Decision #36)", async () => {
		const owner = await harness.open();
		const callbacks = durableSettingsCallbacks(settingsDeps(owner));

		callbacks.onDefaultModelChange?.("faux", "faux-1");

		expect(owner.current.settings.getDefaultProvider()).toBe("faux");
		expect(owner.current.settings.getDefaultModel()).toBe("faux-1");
		expect(durableSettingsConfig(settingsDeps(owner)).defaultModel).toBe("faux/faux-1");
	});

	test("/scoped-models presents the picker and applies the enabled set to the TUI", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const applied: Array<readonly string[] | null> = [];
		const commands = await commandsOf(
			owner,
			screenState,
			productOf(owner, { setScopedModels: (ids) => applied.push(ids) }),
		);

		await commands.run("scoped-models", "");

		const selector = screenState.presented[0];
		expect(selector).toBeInstanceOf(ScopedModelsSelectorComponent);
		if (!(selector instanceof ScopedModelsSelectorComponent)) throw new Error("no scoped-model picker");
		// The first model is enabled to begin with, so toggling it turns the selection into "none enabled".
		selector.handleInput("\r");

		expect(applied).toEqual([[]]);
	});

	test("the scoped set comes from the settings and is stored back as patterns", async () => {
		const owner = await harness.open(undefined, { models: [{ id: "faux-a" }, { id: "faux-b" }] });
		const models = owner.current.modelRuntime.getAvailableSnapshot();
		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual(["faux/faux-a", "faux/faux-b"]);

		expect(enabledModelIds(undefined, models)).toBeNull();
		expect(enabledModelIds([], models)).toBeNull();
		expect(enabledModelIds(["faux/*"], models)).toEqual(["faux/faux-a", "faux/faux-b"]);
		// A pattern that matches nothing is kept as written, so it can be removed from the picker.
		expect(enabledModelIds(["gone/missing", "faux/faux-b"], models)).toEqual(["faux/faux-b", "gone/missing"]);

		expect(enabledModelPatterns(null, models)).toBeUndefined();
		expect(enabledModelPatterns([], models)).toEqual([]);
		// Every model enabled is the same as no filter, which is what a later start reads.
		expect(enabledModelPatterns(["faux/faux-a", "faux/faux-b"], models)).toBeUndefined();
		expect(enabledModelPatterns(["faux/faux-b"], models)).toEqual(["faux/faux-b"]);
	});

	test("/trust stores the decision where the next start reads it", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("trust", "");

		const selector = screenState.presented[0];
		expect(selector).toBeInstanceOf(TrustSelectorComponent);
		if (!(selector instanceof TrustSelectorComponent)) throw new Error("no trust selector");
		// The first option trusts this project and everything above it.
		selector.handleInput("\r");

		const store = new ProjectTrustStore(getAgentDir());
		const entry = store.getEntry(harness.cwd);
		expect(entry?.decision).toBe(true);
		expect(screenState.notices).toEqual(["Saved trust decision: trusted. Restart nyan for this to take effect."]);
		expect(screenState.presented).toEqual([]);
	});

	test("/reload reopens the same session with freshly loaded extensions", async () => {
		let loads = 0;
		const owner = await harness.open(undefined, {
			extraFactories: [
				() => {
					loads += 1;
				},
			],
		});
		expect(loads).toBe(1);
		await harness.say(owner, "keep me");
		const directory = owner.current.view.current().session.directory;
		const entriesBefore = owner.current.view.current().conversation.entries.map((entry) => entry.id);
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("reload", "");

		expect(loads).toBe(2);
		expect(harness.events).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
		const reloaded = owner.current.view.current();
		expect(reloaded.session.directory).toBe(directory);
		expect(reloaded.conversation.entries.map((entry) => entry.id)).toEqual(entriesBefore);
		expect(screenState.notices).toEqual([
			"Reloaded keybindings, extensions, skills, prompts, themes, and context files",
		]);
	});

	test("/hotkeys renders the keys this TUI binds", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("hotkeys", "");

		const markdown = screenState.markdown ?? "";
		expect(markdown.startsWith("# Keyboard Shortcuts")).toBe(true);
		expect(markdown).toContain("**Editing**");
		expect(markdown).toContain("| Send message |");
		expect(markdown).toContain("| Abort the answer, or cancel a running bash command |");
		expect(markdown).toContain("| Slash commands |");
		// A key that only the legacy TUI binds is not listed here as working.
		expect(markdown).not.toContain("Copy selection or last assistant message");
	});

	test("/logout reports that there is nothing stored, without touching the auth file", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("logout", "");

		expect(screenState.notices).toEqual([
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		]);
		expect(screenState.presented).toEqual([]);
	});

	test("/login names a provider it does not have, and cancels at the picker", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("login", "no-such-provider");
		expect(screenState.notices).toEqual(['No provider matches "no-such-provider".']);

		// The command waits for the user's choice, so the picker is driven while it runs.
		const running = commands.run("login", "");
		const picker = screenState.presented[0];
		expect(picker).toBeInstanceOf(OAuthSelectorComponent);
		if (!(picker instanceof OAuthSelectorComponent)) throw new Error("no provider picker");
		picker.handleInput("\x1b");
		await running;

		expect(screenState.notices).toEqual(['No provider matches "no-such-provider".', "Login cancelled"]);
		expect(screenState.presented).toEqual([]);
	});

	test("a caller without the product surface reports the commands it cannot run", async () => {
		const owner = await harness.open();
		const screenState = screen();
		const commands = await commandsOf(owner, screenState);

		for (const name of ["settings", "thinking", "scoped-models", "trust", "login", "logout", "hotkeys"] as const) {
			await commands.run(name, "");
		}

		expect(screenState.notices).toEqual([
			"/settings is not available in this mode.",
			"/thinking is not available in this mode.",
			"/scoped-models is not available in this mode.",
			"/trust is not available in this mode.",
			"/login is not available in this mode.",
			"/logout is not available in this mode.",
			"/hotkeys is not available in this mode.",
		]);
		expect(screenState.presented).toEqual([]);
	});

	test("the session outlives a failed reload, with the services that were loaded", async () => {
		// A factory that throws only on its second load makes the fresh open fail after the session was closed.
		let loads = 0;
		const owner = await harness.open(undefined, {
			extraFactories: [
				() => {
					loads += 1;
					if (loads === 2) throw new Error("broken extension");
				},
			],
		});
		await harness.say(owner, "keep me");
		const directory = owner.current.view.current().session.directory;
		const entriesBefore = owner.current.view.current().conversation.entries.map((entry) => entry.id);
		const screenState = screen();
		const commands = await commandsOf(owner, screenState, productOf(owner));

		await commands.run("reload", "");

		expect(screenState.notices).toHaveLength(1);
		expect(screenState.notices[0]).toMatch(/^Reload failed: .*broken extension$/u);
		const restored = owner.current.view.current();
		expect(restored.session.directory).toBe(directory);
		expect(restored.conversation.entries.map((entry) => entry.id)).toEqual(entriesBefore);
		// The session put back is the live one, not a closed copy of it: it still takes a prompt and records the answer.
		await harness.say(owner, "still here");
		expect(
			owner.current.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.user"),
		).toHaveLength(2);
		void headless;
	});
});
