import type { AssistantMessage, ImageContent } from "@ny4n/ai";
import type { UserInput } from "@ny4n/durable";
import { dispatchDurableExtensionCommand } from "../../core/durable/extension-commands.ts";
import { type OpenDurableOptions, openDurable } from "../../core/durable/runtime.ts";
import { flushRawStdout, writeRawStdout } from "../../core/output-guard.ts";

export interface DurablePrintOptions extends OpenDurableOptions {
	readonly initialMessage?: string;
	readonly initialImages?: ImageContent[];
	readonly messages?: readonly string[];
}

/** Run the durable product path in the text-only print mode. */
export async function runDurablePrint(options: DurablePrintOptions): Promise<number> {
	const durable = await openDurable(options);
	try {
		let lastAnswer: AssistantMessage | undefined;
		const submit = async (content: UserInput): Promise<void> => {
			const commandText = typeof content === "string" ? content : content.find((part) => part.type === "text")?.text;
			if (
				commandText !== undefined &&
				(await dispatchDurableExtensionCommand(durable.extensionHost.runner, commandText))
			) {
				return;
			}
			const outcome = await durable.controller.submitAndWait(content, "followUp");
			// An `input` handler took the prompt: nothing was submitted, and there is no answer to wait for.
			if (outcome.handled) return;
			const { settled } = outcome;
			if (settled.status !== "done") {
				throw new Error(
					settled.status === "unanswered" ? `Input was not answered: ${settled.reason}` : "Input did not settle",
				);
			}
			const answer = durable.view.current().conversation.entries.find((entry) => entry.id === settled.answer)
				?.model?.[0];
			if (answer?.role !== "assistant") {
				throw new Error("Durable input settled without an assistant answer");
			}
			lastAnswer = answer;
		};

		if (options.initialMessage !== undefined || options.initialImages !== undefined) {
			const content =
				options.initialImages === undefined
					? (options.initialMessage ?? "")
					: [{ type: "text" as const, text: options.initialMessage ?? "" }, ...options.initialImages];
			await submit(content);
		}
		for (const message of options.messages ?? []) await submit(message);

		if (lastAnswer === undefined) return 0;
		if (lastAnswer.stopReason === "error" || lastAnswer.stopReason === "aborted") {
			console.error(lastAnswer.errorMessage ?? `Request ${lastAnswer.stopReason}`);
			return 1;
		}
		for (const content of lastAnswer.content) {
			if (content.type === "text") writeRawStdout(`${content.text}\n`);
		}
		if (lastAnswer.stopReason === "length") {
			console.error("Response was truncated: the model reached its output token limit.");
			return 1;
		}
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		await durable.close();
		await flushRawStdout();
	}
}
