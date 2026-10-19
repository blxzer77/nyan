import type { AssistantMessage, ImageContent } from "@ny4n/ai";
import type { UserInput } from "@ny4n/durable";
import { dispatchDurableExtensionCommand } from "../../core/durable/extension-commands.ts";
import { type OpenDurableOptions, openDurable } from "../../core/durable/runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../../core/output-guard.ts";
import { DurableJsonEventAdapter } from "./json-events.ts";

export interface DurableJsonOptions extends OpenDurableOptions {
	readonly initialMessage?: string;
	readonly initialImages?: ImageContent[];
	readonly messages?: readonly string[];
}

/** Run the durable product path with the published JSONL event stream. */
export async function runDurableJson(options: DurableJsonOptions): Promise<number> {
	const durable = await openDurable({ ...options, eventStream: true });
	try {
		const events = durable.events;
		if (events === undefined) throw new Error("Durable JSON mode did not acquire an event stream");
		const adapter = new DurableJsonEventAdapter(() =>
			durable.view.current().conversation.entries.flatMap((entry) => entry.model ?? []),
		);
		const session = durable.view.current().session;
		writeRawStdout(
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: session.id,
				timestamp: new Date().toISOString(),
				cwd: session.cwd,
			})}\n`,
		);
		events.start(async (batch) => {
			for (const event of adapter.translate(batch)) writeRawStdout(`${JSON.stringify(event)}\n`);
			await waitForRawStdoutBackpressure();
		});

		const submit = async (content: UserInput): Promise<AssistantMessage | undefined> => {
			const commandText = typeof content === "string" ? content : content.find((part) => part.type === "text")?.text;
			if (
				commandText !== undefined &&
				(await dispatchDurableExtensionCommand(durable.extensionHost.runner, commandText))
			) {
				return undefined;
			}
			const outcome = await durable.controller.submitAndWait(content, "followUp");
			// An `input` handler took the prompt: nothing was submitted, so there is no answer.
			if (outcome.handled) return undefined;
			const { settled } = outcome;
			if (settled.status !== "done") {
				throw new Error(
					settled.status === "unanswered" ? `Input was not answered: ${settled.reason}` : "Input did not settle",
				);
			}
			const answer = durable.view.current().conversation.entries.find((entry) => entry.id === settled.answer)
				?.model?.[0];
			if (answer?.role !== "assistant") throw new Error("Durable input settled without an assistant answer");
			return answer;
		};

		let lastAnswer: AssistantMessage | undefined;
		if (options.initialMessage !== undefined || options.initialImages !== undefined) {
			const content =
				options.initialImages === undefined
					? (options.initialMessage ?? "")
					: [{ type: "text" as const, text: options.initialMessage ?? "" }, ...options.initialImages];
			lastAnswer = await submit(content);
		}
		for (const message of options.messages ?? []) lastAnswer = await submit(message);
		if (lastAnswer?.stopReason === "error" || lastAnswer?.stopReason === "aborted") return 1;
		if (lastAnswer?.stopReason === "length") return 1;
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		await durable.close();
		await flushRawStdout();
	}
}
