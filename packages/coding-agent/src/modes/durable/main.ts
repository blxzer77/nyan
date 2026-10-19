import { dispatchDurableExtensionCommand } from "../../core/durable/extension-commands.ts";
import { type OpenDurableOptions, type OpenDurableResult, openDurable } from "../../core/durable/runtime.ts";
import { runDurableTui } from "./tui.ts";

export interface DurableInteractiveOptions extends OpenDurableOptions {
	readonly initialMessage?: string;
}

export async function runDurableInteractive(options: DurableInteractiveOptions): Promise<void> {
	const durable: OpenDurableResult = await openDurable(options);
	try {
		if (options.initialMessage !== undefined) {
			const handled = await dispatchDurableExtensionCommand(durable.extensionHost.runner, options.initialMessage);
			if (!handled) await durable.controller.submit(options.initialMessage, "steer");
		}
		await runDurableTui(durable.view, durable.controller, durable.settings, durable.extensionHost);
	} finally {
		await durable.close();
	}
}
