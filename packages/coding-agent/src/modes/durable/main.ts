import { dispatchDurableExtensionCommand } from "../../core/durable/extension-commands.ts";
import type { OpenDurableOptions } from "../../core/durable/runtime.ts";
import { DurableSessionOwner } from "./session-owner.ts";
import { runDurableTui } from "./tui.ts";

export interface DurableInteractiveOptions extends OpenDurableOptions {
	readonly initialMessage?: string;
}

export async function runDurableInteractive(options: DurableInteractiveOptions): Promise<void> {
	const owner = await DurableSessionOwner.open(options);
	try {
		if (options.initialMessage !== undefined) {
			const handled = await dispatchDurableExtensionCommand(
				owner.current.extensionHost.runner,
				options.initialMessage,
			);
			if (!handled) await owner.current.controller.submit(options.initialMessage, "steer");
		}
		const open = owner.current;
		await runDurableTui(open.view, open.controller, open.settings, open.extensionHost, open.themes, {
			open: owner.tui,
			reopen: (request) => owner.reopen(request),
		});
	} finally {
		await owner.close();
	}
}
