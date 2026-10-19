import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	durableBoundaryEntriesToLegacy,
	legacyBoundaryEntriesToDurable,
} from "../src/core/durable/extension-adapter.ts";
import {
	dispatchDurableExtensionCommand,
	getDurableExtensionCommands,
} from "../src/core/durable/extension-commands.ts";
import { createExtensionHost } from "../src/core/durable/extension-host.ts";
import { openDurable } from "../src/core/durable/runtime.ts";
import { createDurableServices } from "../src/core/durable/services.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { persistPausePreference } from "../src/extensions/cliproxyapi/pause.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createTestUiContext } from "./suite/harness.ts";

/**
 * The durable path's extension host against a loopback stand-in for CLIProxyAPI. The stand-in records each request body
 * and answers `/v1/responses` with a short valid Responses stream (HTTP 200), so the provider adapter reports the response
 * and its frames. An HTTP error would not do: the Responses adapter never calls `onResponse` for a status it throws on.
 * The probe extension is an inline factory that records the events it receives. No real proxy, no credentials.
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

const answerStream = [
	{ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } },
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{
		type: "response.content_part.added",
		item_id: "msg_1",
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "", annotations: [] },
	},
	{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
	{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "ok" },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			object: "response",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	},
]
	.map((event) => `data: ${JSON.stringify(event)}\n\n`)
	.join("");

interface Stub {
	readonly baseUrl: string;
	readonly bodies: string[];
	readonly managementRequests: number;
	failNextResponse(): void;
	close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
	const bodies: string[] = [];
	let managementRequests = 0;
	let failNextResponse = false;
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			if (request.url?.startsWith("/v0/management/auth-files")) {
				managementRequests += 1;
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "rejected" }));
				return;
			}
			if (request.url?.startsWith("/v1/models")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ id: "deepseek-flash", slug: "deepseek-flash" }] }));
				return;
			}
			bodies.push(body);
			if (failNextResponse) {
				failNextResponse = false;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`data: ${JSON.stringify({
						type: "response.failed",
						response: {
							status: "failed",
							error: { code: "stream_error", message: "closed network connection" },
						},
					})}\n\n`,
				);
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"x-codex-primary-used-percent": "42",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-after-seconds": "3600",
			});
			response.end(answerStream);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		bodies,
		get managementRequests() {
			return managementRequests;
		},
		failNextResponse() {
			failNextResponse = true;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

vi.setConfig({ testTimeout: 120_000 });

describe("durable extension host", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let stub: Stub;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-host-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-host-cwd-"));
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		stub = await startStub();
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CLIPROXYAPI_BASE_URL", stub.baseUrl);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "probe-key-not-real");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await stub.close();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	/** Built-ins first, so `cliproxyapi` is registered; then the probe. Each factory run is counted. */
	function probe(record: string[], onLoad: () => void, configure: (pi: ExtensionAPI) => void): InlineExtension {
		return (pi) => {
			onLoad();
			pi.on("session_start", (event) => {
				record.push(`session_start:${event.reason}`);
			});
			pi.on("session_shutdown", (event) => {
				record.push(`session_shutdown:${event.reason}`);
			});
			configure(pi);
		};
	}

	async function seedCatalog(): Promise<void> {
		const first = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await vi.waitFor(
				() => {
					expect(first.modelRuntime.getModel("cliproxyapi", "deepseek-flash")).toBeDefined();
				},
				{ timeout: 10_000 },
			);
		} finally {
			await first.close();
		}
	}

	test("round-trips custom boundary proposals and refuses compaction drafts", () => {
		const errors: string[] = [];
		const legacy = durableBoundaryEntriesToLegacy(
			[{ kind: "custom", data: { marker: true } }],
			undefined,
			(message) => errors.push(message),
		);
		expect(legacy).toEqual([{ type: "custom", customType: "custom", data: { marker: true } }]);
		expect(legacyBoundaryEntriesToDurable(legacy ?? [], undefined, (message) => errors.push(message))).toEqual([
			{ kind: "custom", data: { marker: true } },
		]);
		expect(
			durableBoundaryEntriesToLegacy([{ kind: "compaction", data: {} }], undefined, (message) =>
				errors.push(message),
			),
		).toBeUndefined();
		expect(errors).toEqual(["compaction boundary drafts are owned by the durable compaction task"]);
	});

	test("a before_provider_request change reaches the provider, and the after_provider_response status is seen", async () => {
		await seedCatalog();
		const statuses: number[] = [];
		const frameProviders: string[] = [];
		const durable = await openDurable({
			cwd,
			extensionFactories: [
				...builtInExtensions,
				probe(
					[],
					() => {},
					(pi) => {
						pi.on("before_provider_request", (event) => {
							return { ...(event.payload as Record<string, unknown>), nyanProbe: "PAYLOAD-MARK" };
						});
						pi.on("after_provider_response", (event) => {
							statuses.push(event.status);
						});
						pi.on("provider_stream_event", (event) => {
							frameProviders.push(event.provider);
						});
					},
				),
			],
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			const settled = await durable.controller.submitAndWait("hi", "followUp");
			expect(settled).toMatchObject({ status: "done" });
			expect(stub.bodies.length).toBeGreaterThan(0);
			expect(stub.bodies[0]).toContain("PAYLOAD-MARK");
			expect(durable.view.current().notices.map((notice) => notice.message)).toEqual([]);
			expect(statuses).toContain(200);
			// Every stream frame reaches the handler, tagged with the provider it came from.
			expect(frameProviders.length).toBeGreaterThan(0);
			expect(new Set(frameProviders)).toEqual(new Set(["cliproxyapi"]));
		} finally {
			await durable.close();
		}
	});

	// A5: CPA sees response status and parses forwarded quota headers through its telemetry hub.
	test("response quota headers reach the CPA quota command", async () => {
		await seedCatalog();
		const notices: string[] = [];
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		durable.extensionHost.runner.setUIContext(
			createTestUiContext({ notify: (message) => notices.push(message) }),
			"tui",
		);
		try {
			expect(await durable.controller.submitAndWait("hi", "followUp")).toMatchObject({ status: "done" });
			expect(await dispatchDurableExtensionCommand(durable.extensionHost.runner, "/cpa-quota")).toBe(true);
			expect(notices.some((message) => message.includes("42% used"))).toBe(true);
		} finally {
			await durable.close();
		}
	});

	// A8: one terminal provider assistant message produces one CPA request record.
	test("CPA publishes one request record for one terminal assistant", async () => {
		await seedCatalog();
		const requests: unknown[] = [];
		const durable = await openDurable({
			cwd,
			extensionFactories: [
				...builtInExtensions,
				(pi) => {
					pi.events.on("cliproxyapi:request", (record) => requests.push(record));
				},
			],
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			expect(await durable.controller.submitAndWait("hi", "followUp")).toMatchObject({ status: "done" });
			expect(requests).toHaveLength(1);
		} finally {
			await durable.close();
		}
	});

	test("session_start and session_shutdown reach the extension, with the reason of each", async () => {
		const record: string[] = [];
		const durable = await openDurable({
			cwd,
			extensionFactories: [
				probe(
					record,
					() => {},
					() => {},
				),
			],
			projectTrustContext: { ...headless, cwd },
		});
		await durable.close("quit");
		expect(record).toEqual(["session_start:startup", "session_shutdown:quit"]);
	});

	test("before_agent_start injects a message and changes the system prompt once", async () => {
		await seedCatalog();
		let starts = 0;
		let entryCount = 0;
		const durable = await openDurable({
			cwd,
			extensionFactories: [
				...builtInExtensions,
				probe(
					[],
					() => {},
					(pi) => {
						pi.on("before_agent_start", () => {
							starts += 1;
							return {
								systemPrompt: "MARKER-BEFORE-AGENT-START",
								message: { customType: "probe", content: "MARKER-INJECTED", display: false },
							};
						});
						pi.on("agent_end", (_event, ctx) => {
							entryCount = ctx.sessionManager.getEntries().length;
						});
					},
				),
			],
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			const settled = await durable.controller.submitAndWait("hi", "followUp");
			expect(settled).toMatchObject({ status: "done" });
			expect(starts).toBe(1);
			expect(entryCount).toBeGreaterThan(0);
			expect(stub.bodies.at(-1)).toContain("MARKER-BEFORE-AGENT-START");
			expect(stub.bodies.at(-1)).toContain("MARKER-INJECTED");
		} finally {
			await durable.close();
		}
	});

	test("an error thrown by an extension handler is shown as a notice, not dropped", async () => {
		await seedCatalog();
		const durable = await openDurable({
			cwd,
			extensionFactories: [
				...builtInExtensions,
				probe(
					[],
					() => {},
					(pi) => {
						pi.on("before_provider_request", () => {
							throw new Error("PROBE-HANDLER-FAILURE");
						});
					},
				),
			],
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await durable.controller.submitAndWait("hi", "followUp");
			const messages = durable.view.current().notices.map((notice) => notice.message);
			expect(messages.some((message) => message.includes("PROBE-HANDLER-FAILURE"))).toBe(true);
		} finally {
			await durable.close();
		}
	});

	test("a reopen with the same services does not load the extensions again", async () => {
		let loads = 0;
		const record: string[] = [];
		const factories: InlineExtension[] = [
			probe(
				record,
				() => {
					loads += 1;
				},
				() => {},
			),
		];
		const first = await openDurable({
			cwd,
			extensionFactories: factories,
			projectTrustContext: { ...headless, cwd },
		});
		await first.close("new");
		const second = await openDurable({
			cwd,
			extensionFactories: factories,
			services: first.services,
			projectTrustContext: { ...headless, cwd },
		});
		try {
			expect(second.services).toBe(first.services);
			expect(second.modelRuntime).toBe(first.modelRuntime);
			expect(loads).toBe(1);
			// Each session still gets its own start and shutdown.
			expect(record).toEqual(["session_start:startup", "session_shutdown:new", "session_start:startup"]);
		} finally {
			await second.close();
		}
	});

	test("dispatches durable extension commands with the bound UI context", async () => {
		const calls: string[] = [];
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: {},
			extensionFactories: [
				(pi) => {
					pi.registerCommand("probe", {
						description: "Probe command",
						handler: async (args, ctx) => {
							calls.push(`${args}:${ctx.hasUI}`);
							ctx.ui.notify("command ran");
						},
					});
				},
			],
			projectTrustContext: { ...headless, cwd },
		});
		const host = createExtensionHost({
			services,
			cwd,
			agentModel: () => undefined,
			abort: () => {},
			compact: () => {},
			onExtensionError: (error) => calls.push(`error:${error.error}`),
			installTools: () => {},
			isIdle: () => true,
		});
		const notices: string[] = [];
		host.runner.setUIContext(createTestUiContext({ notify: (message) => notices.push(message) }), "tui");

		expect(getDurableExtensionCommands(host.runner).map((command) => command.invocationName)).toEqual(["probe"]);
		expect(await dispatchDurableExtensionCommand(host.runner, "/probe one two")).toBe(true);
		expect(await dispatchDurableExtensionCommand(host.runner, "/missing")).toBe(false);
		expect(calls).toEqual(["one two:true"]);
		expect(notices).toEqual(["command ran"]);
	});

	test("with no handler for a provider event, the host installs no hook members", async () => {
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: { noExtensions: true },
			extensionFactories: [],
			projectTrustContext: { ...headless, cwd },
		});
		const host = createExtensionHost({
			services,
			cwd,
			agentModel: () => undefined,
			abort: () => {},
			compact: () => {},
			onExtensionError: () => {},
			installTools: () => {},
			isIdle: () => true,
		});
		expect(host.adapter.hooks ?? []).toHaveLength(0);
	});

	// A7: one transient stream error is normalized at message_end and the durable run retries once.
	test("normalizes a transient CPA stream error and retries once", async () => {
		await seedCatalog();
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } }),
		);
		stub.failNextResponse();
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			expect(await durable.controller.submitAndWait("hi", "followUp")).toMatchObject({ status: "done" });
			expect(stub.bodies).toHaveLength(2);
			const assistants = durable.view
				.current()
				.conversation.entries.filter((entry) => entry.kind === "nyan.assistant");
			expect(assistants).toHaveLength(2);
			expect(assistants[0]?.model?.[0]).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("network error: stream_error: closed network connection"),
			});
			expect(assistants[1]?.model?.[0]).toMatchObject({ stopReason: "stop" });
		} finally {
			await durable.close();
		}
	});

	// A2: the pause gate of CLIProxyAPI runs in `before_provider_request` and blocks before the provider is called.
	test("while paused no provider request is sent, and continuing sends exactly one", async () => {
		await seedCatalog();
		persistPausePreference(agentDir, true);
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await durable.controller.submit("hi", "followUp");
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(stub.bodies).toHaveLength(0);
			persistPausePreference(agentDir, false);
			await vi.waitFor(() => expect(stub.bodies).toHaveLength(1), { timeout: 5_000 });
		} finally {
			persistPausePreference(agentDir, false);
			await durable.close();
		}
	});

	// A3: an abort while the gate waits ends the run with no request and leaves no timer behind.
	test("aborting a paused request ends the run unanswered and leaves no timer behind", async () => {
		await seedCatalog();
		persistPausePreference(agentDir, true);
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			const timersBefore = countTimers();
			const submission = durable.controller.submitAndWait("hi", "followUp");
			await new Promise((resolve) => setTimeout(resolve, 600));
			await durable.controller.abort();
			const settled = await submission;
			expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(stub.bodies).toHaveLength(0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(countTimers()).toBeLessThanOrEqual(timersBefore);
		} finally {
			persistPausePreference(agentDir, false);
			await durable.close();
		}
	});

	// A11: reopening with the same services is the core of RPC new_session's extension-lifetime guarantee.
	test("a rejected quota key is not polled again after reopening with the same services", async () => {
		await seedCatalog();
		vi.stubEnv("CLIPROXYAPI_MANAGEMENT_KEY", "rejected-management-key");
		const first = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		await vi.waitFor(() => expect(stub.managementRequests).toBe(1), { timeout: 5_000 });
		await first.close();

		const second = await openDurable({
			cwd,
			services: first.services,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(stub.managementRequests).toBe(1);
		} finally {
			await second.close();
		}
	});

	// A4: the pending submission belongs to its caller; close rejects its waiter, and reopen recovers the durable run.
	test("a paused request closes with an owned rejection and resumes once after reopen", async () => {
		await seedCatalog();
		persistPausePreference(agentDir, true);
		const first = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		const submission = first.controller.submitAndWait("hi", "followUp").catch((error: unknown) => error);
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(stub.bodies).toHaveLength(0);
		await first.close("quit");
		await expect(submission).resolves.toMatchObject({ message: "Harness is closed" });

		const second = await openDurable({
			cwd,
			continueSession: true,
			services: first.services,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			persistPausePreference(agentDir, false);
			await vi.waitFor(() => expect(stub.bodies).toHaveLength(1), { timeout: 5_000 });
			expect(
				second.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.assistant"),
			).toHaveLength(1);
		} finally {
			persistPausePreference(agentDir, false);
			await second.close();
		}
	});
});

function countTimers(): number {
	return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}
