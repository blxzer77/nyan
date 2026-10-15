import type { ModelThinkingLevel } from "@ny4n/ai";
import { type DurableModelSelection, type OpenDurableResult, openDurable } from "../../core/durable/runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { runDurableTui } from "./tui.ts";

export interface DurableInteractiveOptions {
	readonly cwd: string;
	readonly continueSession: boolean;
	readonly settingsManager: SettingsManager;
	readonly model?: DurableModelSelection;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly apiKey?: string;
	readonly initialMessage?: string;
}

export async function runDurableInteractive(options: DurableInteractiveOptions): Promise<void> {
	const durable: OpenDurableResult = await openDurable(options);
	try {
		if (options.initialMessage !== undefined) {
			await durable.controller.submit(options.initialMessage, "steer");
		}
		await runDurableTui(durable.view, durable.controller, durable.settings);
	} finally {
		await durable.close();
	}
}
