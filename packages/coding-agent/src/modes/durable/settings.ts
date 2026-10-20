import type { ThinkingLevel } from "@ny4n/agent-core";
import type { Model, Transport } from "@ny4n/ai";
import type { Component, ScrollViewScrollbar, WheelScrollLines } from "@ny4n/tui";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import { agentOf, type DurableController, type DurableView } from "../../core/durable/runtime.ts";
import { configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { getAvailableThemes, SYSTEM_THEME_NAME, type TerminalTheme } from "../../ui/theme/theme.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../interactive/components/settings-selector.ts";

/**
 * What a settings change does to the running durable TUI. The parts of a settings change that are not stored in nyan's
 * settings — the theme, the padding, the scrollbar — are applied through this port, so the settings code stays free of
 * terminal objects.
 */
export interface DurableSettingsUi {
	/** The theme selection the item shows, which may be a light/dark pair or the system theme. */
	themeSelection(): string;
	terminalTheme(): TerminalTheme;
	/** Apply a theme setting now. */
	setTheme(setting: string): void;
	/** Show a theme without saving it. */
	previewTheme(setting: string): void;
	setOutputPad(padding: 0 | 1): void;
	/** How many completion rows the editor shows at once. */
	setAutocompleteMaxVisible(maxVisible: number): void;
	setEditorPaddingX(padding: number): void;
	setShowImages(show: boolean): void;
	setImageWidthCells(width: number): void;
	setHardwareCursor(enabled: boolean): void;
	setClearOnShrink(enabled: boolean): void;
	setScrollbar(mode: ScrollViewScrollbar): void;
	setCopyOnSelect(enabled: boolean): void;
	setWheelScrollLines(lines: WheelScrollLines): void;
}

/** Everything `/settings` reads and writes. */
export interface DurableSettingsDeps {
	readonly settings: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	/** The session shown now; a reopen replaces it, so the view is read on every use. */
	readonly view: () => DurableView;
	readonly controller: DurableController;
	readonly ui: DurableSettingsUi;
}

/** The model the shown conversation talks to, as the shared settings items expect it. */
function currentModel(deps: DurableSettingsDeps): Model<any> | undefined {
	const agent = agentOf(deps.view().conversation);
	if (agent.model === undefined) return undefined;
	return deps.modelRuntime.getModel(agent.model.provider, agent.model.modelId);
}

/** The settings dialog's values, from nyan's settings and the session shown now. */
export function durableSettingsConfig(deps: DurableSettingsDeps): SettingsConfig {
	const settings = deps.settings;
	const queues = deps.controller.getQueueModes();
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	return {
		autoCompact: deps.controller.getAutoCompaction(),
		defaultModel: provider !== undefined && modelId !== undefined ? `${provider}/${modelId}` : "not set",
		currentModel: currentModel(deps),
		availableDefaultModels: deps.modelRuntime.getAvailableSnapshot(),
		showImages: settings.getShowImages(),
		imageWidthCells: settings.getImageWidthCells(),
		autoResizeImages: settings.getImageAutoResize(),
		blockImages: settings.getBlockImages(),
		enableSkillCommands: settings.getEnableSkillCommands(),
		steeringMode: queues.steeringMode,
		followUpMode: queues.followUpMode,
		transport: settings.getTransport() as Transport,
		httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
		cacheWarmingMode: settings.getCacheWarmingMode(),
		thinkingLevel: settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
		availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
		modelThinkingLevels: settings.getAllModelThinkingLevels(),
		currentTheme: deps.ui.themeSelection() || SYSTEM_THEME_NAME,
		terminalTheme: deps.ui.terminalTheme(),
		availableThemes: getAvailableThemes(),
		hideThinkingBlock: settings.getHideThinkingBlock(),
		mermaidRenderingMode: settings.getMermaidRenderingMode(),
		showCacheMissNotices: settings.getShowCacheMissNotices(),
		collapseChangelog: settings.getCollapseChangelog(),
		enableInstallTelemetry: settings.getEnableInstallTelemetry(),
		doubleEscapeAction: settings.getDoubleEscapeAction(),
		treeFilterMode: settings.getTreeFilterMode(),
		showHardwareCursor: settings.getShowHardwareCursor(),
		editorPaddingX: settings.getEditorPaddingX(),
		outputPad: settings.getOutputPad(),
		autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
		quietStartup: settings.getQuietStartup(),
		defaultProjectTrust: settings.getDefaultProjectTrust(),
		clearOnShrink: settings.getClearOnShrink(),
		showTerminalProgress: settings.getShowTerminalProgress(),
		tuiMode: settings.getTuiMode(),
		fullscreenExitOutput: settings.getFullscreenExitOutput(),
		fullscreenScrollbar: settings.getFullscreenScrollbar(),
		fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
		warnings: settings.getWarnings(),
	};
}

/**
 * Apply one settings change: store it, and apply it to the running session or TUI where the durable path has an
 * equivalent. A setting that only the legacy TUI consumes is stored and takes effect there; the durable TUI reads the
 * ones it honors from the same manager.
 */
export function durableSettingsCallbacks(deps: DurableSettingsDeps): Omit<SettingsCallbacks, "onCancel"> {
	const settings = deps.settings;
	const applyThinking = (level: ThinkingLevel): void => {
		void deps.controller.setThinking(level);
	};
	return {
		onAutoCompactChange: (enabled) => void deps.controller.setAutoCompaction(enabled),
		onShowImagesChange: (enabled) => {
			settings.setShowImages(enabled);
			deps.ui.setShowImages(enabled);
		},
		onImageWidthCellsChange: (width) => {
			settings.setImageWidthCells(width);
			deps.ui.setImageWidthCells(width);
		},
		onAutoResizeImagesChange: (enabled) => settings.setImageAutoResize(enabled),
		onBlockImagesChange: (blocked) => settings.setBlockImages(blocked),
		onEnableSkillCommandsChange: (enabled) => settings.setEnableSkillCommands(enabled),
		onSteeringModeChange: (mode) => void deps.controller.setSteeringMode(mode),
		onFollowUpModeChange: (mode) => void deps.controller.setFollowUpMode(mode),
		onTransportChange: (transport) => settings.setTransport(transport),
		onHttpIdleTimeoutMsChange: (timeoutMs) => {
			settings.setHttpIdleTimeoutMs(timeoutMs);
			configureHttpDispatcher(timeoutMs);
		},
		onCacheWarmingModeChange: (mode) => settings.setCacheWarmingMode(mode),
		onModelThinkingLevelChange: (provider, modelId, level) => {
			settings.setModelThinkingLevel(provider, modelId, level);
			const current = agentOf(deps.view().conversation).model;
			if (current?.provider === provider && current.modelId === modelId) applyThinking(level);
		},
		onModelThinkingLevelRemove: (provider, modelId) => {
			settings.removeModelThinkingLevel(provider, modelId);
			const current = agentOf(deps.view().conversation).model;
			if (current?.provider === provider && current.modelId === modelId) {
				applyThinking(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
			}
		},
		onDefaultModelChange: (provider, modelId) => settings.setDefaultModelAndProvider(provider, modelId),
		onThemeChange: (setting) => {
			settings.setTheme(setting);
			deps.ui.setTheme(setting);
		},
		onThemePreview: (setting) => deps.ui.previewTheme(setting),
		onHideThinkingBlockChange: (hidden) => settings.setHideThinkingBlock(hidden),
		onMermaidRenderingModeChange: (mode) => settings.setMermaidRenderingMode(mode),
		onShowCacheMissNoticesChange: (shown) => settings.setShowCacheMissNotices(shown),
		onCollapseChangelogChange: (collapsed) => settings.setCollapseChangelog(collapsed),
		onEnableInstallTelemetryChange: (enabled) => settings.setEnableInstallTelemetry(enabled),
		onDoubleEscapeActionChange: (action) => settings.setDoubleEscapeAction(action),
		onTreeFilterModeChange: (mode) => settings.setTreeFilterMode(mode),
		onShowHardwareCursorChange: (enabled) => {
			settings.setShowHardwareCursor(enabled);
			deps.ui.setHardwareCursor(enabled);
		},
		onEditorPaddingXChange: (padding) => {
			settings.setEditorPaddingX(padding);
			deps.ui.setEditorPaddingX(padding);
		},
		onOutputPadChange: (padding) => {
			settings.setOutputPad(padding);
			deps.ui.setOutputPad(padding);
		},
		onAutocompleteMaxVisibleChange: (maxVisible) => {
			settings.setAutocompleteMaxVisible(maxVisible);
			deps.ui.setAutocompleteMaxVisible(maxVisible);
		},
		onQuietStartupChange: (quiet) => settings.setQuietStartup(quiet),
		onDefaultProjectTrustChange: (trust) => settings.setDefaultProjectTrust(trust),
		onClearOnShrinkChange: (enabled) => {
			settings.setClearOnShrink(enabled);
			deps.ui.setClearOnShrink(enabled);
		},
		onShowTerminalProgressChange: (enabled) => settings.setShowTerminalProgress(enabled),
		onTuiModeChange: (mode) => settings.setTuiMode(mode),
		onFullscreenExitOutputChange: (output) => settings.setFullscreenExitOutput(output),
		onFullscreenScrollbarChange: (mode) => {
			settings.setFullscreenScrollbar(mode);
			deps.ui.setScrollbar(mode);
		},
		onFullscreenCopyOnSelectChange: (enabled) => {
			settings.setFullscreenCopyOnSelect(enabled);
			deps.ui.setCopyOnSelect(enabled);
		},
		onFullscreenWheelScrollLinesChange: (lines) => {
			settings.setFullscreenWheelScrollLines(lines);
			deps.ui.setWheelScrollLines(lines);
		},
		onWarningsChange: (warnings) => settings.setWarnings(warnings),
	};
}

/** The settings dialog, with focus on its list and `onClose` when it is dismissed. */
export function durableSettingsDialog(
	deps: DurableSettingsDeps,
	onClose: () => void,
): { readonly component: SettingsSelectorComponent; readonly focus: Component } {
	const selector = new SettingsSelectorComponent(durableSettingsConfig(deps), {
		...durableSettingsCallbacks(deps),
		onCancel: onClose,
	});
	return { component: selector, focus: selector.getSettingsList() };
}
