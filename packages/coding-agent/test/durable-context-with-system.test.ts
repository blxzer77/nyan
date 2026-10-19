import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@ny4n/agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText, type Message } from "@ny4n/ai";
import { BACKGROUND_CONTEXT } from "@ny4n/chord/context";
import type { HookApi } from "@ny4n/durable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { settlement } from "./durable-submission.ts";

/**
 * The second phase of the request transform on the durable path. `context` runs as durable's `transformConversation`
 * and never sees system messages; `context_with_system` runs in `beforeRequest`, sees the full request, and its output
 * is the request. A handler that changes nothing leaves the request exactly as it was, because replacing it would
 * collapse the positional system entries into one and change the prompt-cache prefix.
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

describe("durable context_with_system", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-cws-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-cws-cwd-"));
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

	/** Opens the session and records the messages of every request. */
	async function open(factories: InlineExtension[], requests: AgentMessage[][]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses([
			(context) => {
				requests.push([...context.messages]);
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);
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

	test("context sees no system messages and context_with_system sees the full request, in that order", async () => {
		const order: string[] = [];
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context", (event) => {
						order.push(`context:${event.messages.some((message) => message.role === "system")}`);
					});
					pi.on("context_with_system", (event) => {
						order.push(`context_with_system:${event.messages.some((message) => message.role === "system")}`);
					});
				},
			],
			requests,
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		expect(order).toEqual(["context:false", "context_with_system:true"]);
		expect(requests[0]?.some((message) => message.role === "system")).toBe(true);
	});

	test("the output of context_with_system is the request, as returned", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context_with_system", (event) => ({
						messages: [...event.messages, { role: "user" as const, content: "CW-ADDED", timestamp: 1 }],
					}));
				},
			],
			requests,
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		const sent = requests[0] ?? [];
		expect(sent.at(-1)).toMatchObject({ role: "user", content: "CW-ADDED" });
		expect(JSON.stringify(sent)).not.toContain("CW-RESTORED");
	});

	test("an unchanged result does not replace the request, a changed one does", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context_with_system", (event) => {
						const added = event.messages.some(
							(message) => message.role === "user" && message.content === "CW-ADDED",
						);
						return {
							messages: added
								? event.messages
								: [...event.messages, { role: "user" as const, content: "CW-ADDED", timestamp: 1 }],
						};
					});
				},
			],
			requests,
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		// The handler ran on the real request, so the base request is the one before the marker it added.
		const request = (requests[0] ?? []).filter(
			(message) => !(message.role === "user" && message.content === "CW-ADDED"),
		);
		const marker = { role: "user" as const, content: "CW-ADDED", timestamp: 1 };
		// A replacement collapses the positional system entries, which changes the prompt-cache prefix, so the member
		// reports nothing when its handlers return what they were given.
		const unchanged = await current.extensionHost.providerHooks.beforeRequest?.(
			{ messages: [...request, marker] as Message[] },
			{} as HookApi,
			BACKGROUND_CONTEXT,
		);
		expect(unchanged).toBeUndefined();

		const changed = await current.extensionHost.providerHooks.beforeRequest?.(
			{ messages: request as Message[] },
			{} as HookApi,
			BACKGROUND_CONTEXT,
		);
		expect(changed?.messages.at(-1)).toEqual(marker);
	});

	test("dropping the leading system message is reported and the handler's output is still used", async () => {
		const requests: AgentMessage[][] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context_with_system", (event) => ({
						messages: event.messages.filter((_message, index) => index !== 0),
					}));
				},
			],
			requests,
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		const messages = current.view.current().notices.map((notice) => notice.message);
		expect(messages.some((message) => message.includes("removed the leading system message"))).toBe(true);
		expect(requests[0]?.[0]?.role).not.toBe("system");
	});
});
