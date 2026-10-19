import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type {
	ExtensionAPI,
	InlineExtension,
	ProjectTrustContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { settlement } from "./durable-submission.ts";

/**
 * `agent_start` and `turn_start` on the durable path. Durable publishes them only as committed events (`run_start` and
 * `turn_start`), so the host watches the active conversation and forwards them in order. A run starts with
 * `agent_start` and numbers its turns from zero; the watch follows the conversation the controller moves to.
 */

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

const params = Type.Object({});
const noop: ToolDefinition<typeof params> = {
	name: "noop",
	label: "noop",
	description: "answers at once",
	parameters: params,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

const toolCall = () => fauxAssistantMessage([fauxToolCall("noop", {}, { id: "call-1" })], { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

describe("durable run events", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-run-events-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-run-events-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	async function open(factories: InlineExtension[], responses: FauxResponseStep[]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("a run reports agent_start and numbers its turns from zero", async () => {
		const seen: string[] = [];
		const current = await open(
			[
				(pi) => {
					pi.registerTool(noop);
					pi.on("agent_start", () => {
						seen.push("agent_start");
					});
					pi.on("turn_start", (event) => {
						seen.push(`turn_start:${event.turnIndex}`);
					});
				},
			],
			// One run with a tool round, then a second run: the second one numbers its turns from zero again.
			[() => toolCall(), () => answer("first"), () => answer("second")],
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 10_000 });
		expect((await settlement(current.controller.submitAndWait("again", "followUp"))).status).toBe("done");
		await vi.waitFor(() => expect(seen).toHaveLength(5), { timeout: 10_000 });
		expect(seen).toEqual(["agent_start", "turn_start:0", "turn_start:1", "agent_start", "turn_start:0"]);
	});

	test("the run events follow the conversation a fork moved the controller to", async () => {
		const seen: string[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("agent_start", () => {
						seen.push("agent_start");
					});
					pi.on("turn_start", (event) => {
						seen.push(`turn_start:${event.turnIndex}`);
					});
				},
			],
			[() => answer("first"), () => answer("second")],
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		await vi.waitFor(() => expect(seen).toEqual(["agent_start", "turn_start:0"]), { timeout: 10_000 });

		const entries = await current.sessionOps.entries(undefined);
		const user = entries.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(user).toBeDefined();
		const forked = await current.sessionOps.fork(user?.id ?? "");
		if (forked.cancelled) throw new Error("the fork was cancelled");
		await current.controller.switchConversation(forked.conversationId);
		expect((await settlement(current.controller.submitAndWait("in the fork", "followUp"))).status).toBe("done");
		// Without the watch moving to the fork, the new conversation's run would publish nothing here.
		await vi.waitFor(() => expect(seen).toHaveLength(4), { timeout: 10_000 });
		expect(seen.slice(2)).toEqual(["agent_start", "turn_start:0"]);
	});
});
