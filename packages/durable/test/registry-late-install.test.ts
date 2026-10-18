import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, type Models, Type } from "@ny4n/ai";
import { getCurrentTools } from "@ny4n/ai/utils/transcript";
import { defineExtension, defineTool, MemoryStorage, type Registry } from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";

/**
 * Spec 7.5 (same-name replacement) and the bridge's assumption: an extension installed after the Harness opens is
 * offered to the model in the next request, a reinstall under the same name replaces the earlier tools, and an
 * install during a run is offered from the run's next request. The request's tools are the declarations the Harness
 * puts in the messages (`getCurrentTools`), recorded through a wrapper around `Models.streamSimple`.
 */

type Offer = readonly { readonly name: string; readonly description: string }[];

function recordingModels(setup: ChatSetup, offers: Offer[]): Models {
	const original = setup.models.streamSimple.bind(setup.models);
	return Object.assign(Object.create(setup.models) as Models, {
		streamSimple: (...args: Parameters<Models["streamSimple"]>) => {
			const [, requestContext] = args;
			offers.push(
				getCurrentTools(requestContext.messages).map((tool) => ({
					name: tool.name,
					description: tool.description,
				})),
			);
			return original(...args);
		},
	});
}

/** One extension with one tool, `${name}_tool`, described by `description`. */
function toolExtension(name: string, description: string) {
	return defineExtension({
		name,
		tools: [
			defineTool({
				name: `${name}_tool`,
				description,
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
			}),
		],
	});
}

async function say(root: Awaited<ReturnType<typeof openChat>>["root"], content: string): Promise<string> {
	const submission = await root.submit({ type: "input", content, whenBusy: "followUp" }, context);
	return (await submission.wait(context)).status;
}

describe("tools installed after the Harness opens", () => {
	it("are offered in the next request, and a reinstall under the same name replaces the earlier tools", async () => {
		const setup = chatSetup();
		const offers: Offer[] = [];
		setup.faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const { root } = await openChat(new MemoryStorage(), { ...setup, models: recordingModels(setup, offers) });
		expect(offers).toHaveLength(0);

		setup.registry.install(toolExtension("late", "first version"));
		expect(await say(root, "a")).toBe("done");
		expect(offers.at(-1)).toEqual([{ name: "late_tool", description: "first version" }]);

		setup.registry.install(toolExtension("late", "second version"));
		expect(await say(root, "b")).toBe("done");
		expect(offers.at(-1)).toEqual([{ name: "late_tool", description: "second version" }]);
	});

	it("an install during a run is offered from that run's next request", async () => {
		const setup = chatSetup();
		const offers: Offer[] = [];
		const registry: Registry = setup.registry;
		registry.install(toolExtension("early", "early version"));
		setup.faux.setResponses([
			(): AssistantMessage => {
				// While the first request is in flight, a server connects and registers its tools.
				registry.install(toolExtension("mid", "mid version"));
				return fauxAssistantMessage([fauxToolCall("early_tool", {}, { id: "c1" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { root } = await openChat(new MemoryStorage(), { ...setup, models: recordingModels(setup, offers) });
		expect(await say(root, "go")).toBe("done");
		expect(offers[0]?.map((tool) => tool.name)).toEqual(["early_tool"]);
		expect(offers.at(-1)?.map((tool) => tool.name)).toEqual(["early_tool", "mid_tool"]);
	});
});
