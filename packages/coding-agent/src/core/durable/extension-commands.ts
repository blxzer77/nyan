import type { ExtensionRunner } from "../extensions/runner.ts";
import type { ResolvedCommand } from "../extensions/types.ts";

/** Return the extension commands visible to a durable mode. */
export function getDurableExtensionCommands(runner: ExtensionRunner): readonly ResolvedCommand[] {
	return runner.getRegisteredCommands();
}

/**
 * Execute an extension slash command using the same parsing and error boundary as the legacy session.
 * Returns false when the input is not a registered extension command, so built-ins and normal prompts keep
 * their existing handling.
 */
export async function dispatchDurableExtensionCommand(runner: ExtensionRunner, text: string): Promise<boolean> {
	if (!text.startsWith("/")) return false;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
	const command = runner.getCommand(commandName);
	if (command === undefined) return false;

	try {
		await command.handler(args, runner.createCommandContext());
	} catch (error) {
		runner.emitError({
			extensionPath: `command:${commandName}`,
			event: "command",
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
	return true;
}
