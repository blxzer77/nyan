import { type OpenDurableOptions, type OpenDurableResult, openDurable } from "../../core/durable/runtime.ts";
import { runDurableTui } from "./tui.ts";

export interface DurableInteractiveOptions extends OpenDurableOptions {
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
