import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@ny4n/chord/context";
import type { HookApi } from "@ny4n/durable";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createExtensionHost } from "../src/core/durable/extension-host.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import { createDurableServices } from "../src/core/durable/services.ts";
import type {
	ExtensionAPI,
	InlineExtension,
	ProjectTrustContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";
import { settlement } from "./durable-submission.ts";

/**
 * `ctx.signal` on the durable path. Legacy passes `agent.signal`, which is set for the whole run, to every handler it
 * runs; the durable adapter used to set a scope only around the provider and tool calls, so a boundary, context,
 * `message_end`, or `session_before_compact` handler read `undefined` and could not cooperate with an abort. Every
 * handler that runs inside a run now sees the run's signal, and responding to it is what lets `close()`, `abort`, and
 * `new_session` finish when a handler is waiting.
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

const rpcIo = vi.hoisted(() => ({
	lines: [] as string[],
	handler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.lines.push(line);
	},
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	flushRawStdout: vi.fn(async () => {}),
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.handler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const probeTool: ToolDefinition = {
	name: "probe_tool",
	label: "probe_tool",
	description: "A probe tool",
	parameters: Type.Object({}),
	execute: async (_id, _params, _signal, onUpdate) => {
		onUpdate?.({ content: [{ type: "text", text: "PARTIAL-OUTPUT" }], details: undefined });
		return { content: [{ type: "text", text: "TOOL-RESULT" }], details: undefined };
	},
};

describe("durable handler signal", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;
	let exit: MockInstance | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-signal-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-signal-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		rpcIo.lines = [];
		rpcIo.handler = undefined;
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
		if (exit !== undefined) {
			process.stdin.emit("end");
			await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20_000 });
			exit.mockRestore();
			process.stdin.removeAllListeners("end");
			exit = undefined;
		}
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
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

	/**
	 * Each durable hook member that calls an extension handler runs it in the hook context's scope, so the handler reads
	 * the context's `abortSignal` as `ctx.signal` and `ctx.model` falls back to the agent's model. Called directly, so
	 * the identity of the signal is asserted, not just that one exists.
	 */
	test("every hook member hands its handler the hook context's signal", async () => {
		const seen = new Map<string, AbortSignal | undefined>();
		const record =
			(name: string) =>
			(_event: unknown, ctx: { signal?: AbortSignal }): undefined => {
				seen.set(name, ctx.signal);
				return undefined;
			};
		const probe: InlineExtension = (pi) => {
			pi.registerTool(probeTool);
			pi.on("context", record("context"));
			pi.on("turn_end", record("turn_end"));
			pi.on("agent_before_settle", record("agent_before_settle"));
			pi.on("message_end", record("message_end"));
			pi.on("message_update", record("message_update"));
			pi.on("tool_call", record("tool_call"));
			pi.on("tool_result", record("tool_result"));
			pi.on("tool_execution_update", record("tool_execution_update"));
			pi.on("before_provider_request", record("before_provider_request"));
			pi.on("before_provider_headers", record("before_provider_headers"));
			pi.on("after_provider_response", record("after_provider_response"));
			pi.on("provider_stream_event", record("provider_stream_event"));
		};
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: {},
			extensionFactories: [probe],
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
		const generation = host.providerHooks;
		const tools = host.toolHooks;
		const call = new AbortController();
		const context = withAbortSignal(call.signal, BACKGROUND_CONTEXT);
		const api = {} as HookApi;
		const model = fauxProvider().getModel();
		const assistant = fauxAssistantMessage([fauxText("direct")]);

		await generation.transformConversation?.({ messages: [] }, api, context);
		await generation.onBoundary?.(
			{ kind: "turn_end", assistant, toolResults: [], entries: [], continue: false },
			api,
			context,
		);
		await generation.onBoundary?.(
			{ kind: "settle", assistant, toolResults: [], entries: [], continue: false },
			api,
			context,
		);
		await generation.rewriteMessage?.(assistant, api, context);
		await generation.beforeProviderRequest?.({ payload: {}, model }, api, context);
		await generation.beforeProviderHeaders?.({ headers: {}, model }, api, context);
		await generation.afterProviderResponse?.({ status: 200, headers: {}, model }, api, context);
		await generation.onProviderStreamEvent?.({ data: {}, model }, api, context);
		await generation.onStreamEvent?.(
			{ event: { type: "done", reason: "stop", message: assistant }, attempt: 0 },
			api,
			context,
		);
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "probe_tool", arguments: {} };
		await tools.beforeTool?.(toolCall, api, context);
		await tools.onToolUpdate?.({ call: toolCall, output: "PARTIAL-OUTPUT" }, api, context);
		await tools.afterTool?.(toolCall, { output: [] }, api, context);

		expect([...seen.keys()].sort()).toEqual(
			[
				"after_provider_response",
				"agent_before_settle",
				"before_provider_headers",
				"before_provider_request",
				"context",
				"message_end",
				"message_update",
				"provider_stream_event",
				"tool_call",
				"tool_execution_update",
				"tool_result",
				"turn_end",
			].sort(),
		);
		for (const [name, signal] of seen) expect(signal, name).toBe(call.signal);
	});

	/**
	 * The same claim on a real session: the provider, stream, tool, and boundary handlers of one run each read a signal,
	 * and it is the run's (not aborted before the run ends).
	 */
	test("a real run hands every handler a live signal", async () => {
		const seen: { event: string; signal: AbortSignal | undefined; aborted: boolean }[] = [];
		const record =
			(event: string) =>
			(_e: unknown, ctx: { signal?: AbortSignal }): undefined => {
				seen.push({ event, signal: ctx.signal, aborted: ctx.signal?.aborted ?? true });
				return undefined;
			};
		const current = await open(
			[
				(pi) => {
					pi.registerTool(probeTool);
					pi.on("context", record("context"));
					pi.on("turn_end", record("turn_end"));
					pi.on("agent_before_settle", record("agent_before_settle"));
					pi.on("message_end", record("message_end"));
					pi.on("message_update", record("message_update"));
					pi.on("tool_call", record("tool_call"));
					pi.on("tool_result", record("tool_result"));
					pi.on("tool_execution_update", record("tool_execution_update"));
					pi.on("before_provider_request", record("before_provider_request"));
					pi.on("before_provider_headers", record("before_provider_headers"));
					pi.on("after_provider_response", record("after_provider_response"));
				},
			],
			[
				() =>
					fauxAssistantMessage([fauxToolCall("probe_tool", {}, { id: "probe-call" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("done")]),
			],
		);
		await expect(settlement(current.controller.submitAndWait("go", "followUp"))).resolves.toMatchObject({
			status: "done",
		});

		const events = new Set(seen.map((entry) => entry.event));
		// The faux provider calls no request-body callback, so `before_provider_request` is covered by the direct test.
		for (const event of [
			"after_provider_response",
			"agent_before_settle",
			"before_provider_headers",
			"context",
			"message_end",
			"message_update",
			"tool_call",
			"tool_execution_update",
			"tool_result",
			"turn_end",
		])
			expect(events.has(event), event).toBe(true);
		// The run had not ended when its handlers ran, so every one of them saw a live signal.
		expect(seen.filter((entry) => entry.signal === undefined).map((entry) => entry.event)).toEqual([]);
		expect(seen.filter((entry) => entry.aborted).map((entry) => entry.event)).toEqual([]);
	});

	test("session_before_compact handlers read the run's signal", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		let observed: { signal: AbortSignal | undefined; aborted: boolean } | undefined;
		const current = await open(
			[
				(pi) => {
					pi.on("session_before_compact", (event, ctx) => {
						observed = { signal: ctx.signal, aborted: ctx.signal?.aborted ?? true };
						return {
							compaction: {
								summary: "SIGNAL-SUMMARY",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: 0,
							},
						};
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])],
		);
		await current.controller.submitAndWait("first", "followUp");
		await current.controller.submitAndWait("second", "followUp");
		await current.controller.compact(undefined);
		await vi.waitFor(() => expect(observed).toBeDefined(), { timeout: 20_000 });
		expect(observed?.signal).toBeInstanceOf(AbortSignal);
		// The compaction task ends after the handler returns, which aborts its signal; it was live while the handler ran.
		expect(observed?.aborted).toBe(false);
	});

	/** A turn_end handler that waits for its own `ctx.signal` and reports when it was released. */
	function waitingBoundary(observed: { signal?: AbortSignal; released: boolean }): InlineExtension {
		return (pi) => {
			pi.on("turn_end", async (_event, ctx) => {
				observed.signal = ctx.signal;
				const signal = ctx.signal;
				if (signal === undefined) return;
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				observed.released = true;
			});
		};
	}

	test("close releases a boundary handler that waits for the run's signal", async () => {
		const observed = { released: false } as { signal?: AbortSignal; released: boolean };
		const first = await open([waitingBoundary(observed)], [() => fauxAssistantMessage([fauxText("done")])]);
		const running = first.controller.submitAndWait("go", "followUp").catch((error: unknown) => error);
		await vi.waitFor(() => expect(observed.signal).toBeDefined(), { timeout: 20_000 });
		// Before the fix this waited until the handler returned on its own, which it never does.
		await first.close("quit");
		expect(observed.released).toBe(true);
		expect(observed.signal?.aborted).toBe(true);
		await expect(running).resolves.toMatchObject({ message: "Harness is closed" });
		session = undefined;
	});

	test("abort releases a boundary handler that waits for the run's signal", async () => {
		const observed = { released: false } as { signal?: AbortSignal; released: boolean };
		const current = await open([waitingBoundary(observed)], [() => fauxAssistantMessage([fauxText("done")])]);
		const running = settlement(current.controller.submitAndWait("go", "followUp"));
		await vi.waitFor(() => expect(observed.signal).toBeDefined(), { timeout: 20_000 });
		current.controller.abort();
		await expect(running).resolves.toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(observed.released).toBe(true);
	});

	test("an RPC new_session releases a boundary handler that waits for the run's signal", async () => {
		const observed = { released: false } as { signal?: AbortSignal; released: boolean };
		const faux = fauxProvider();
		faux.setResponses([() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi) => {
			pi.registerProvider(faux.provider);
		};
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		void runDurableRpc({
			cwd,
			extensionFactories: [provider, waitingBoundary(observed)],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 20_000 });
		const send = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const id = `req-${command.type as string}`;
			rpcIo.handler?.(`${JSON.stringify({ ...command, id })}\n`);
			let response: Record<string, unknown> | undefined;
			await vi.waitFor(
				() => {
					response = rpcIo.lines
						.flatMap((line) => line.split("\n"))
						.filter((line) => line.trim().length > 0)
						.map((line) => JSON.parse(line) as Record<string, unknown>)
						.find((record) => record.type === "response" && record.id === id);
					expect(response).toBeDefined();
				},
				{ timeout: 20_000 },
			);
			return response as Record<string, unknown>;
		};
		// The prompt's response waits for the run, which the parked handler holds open.
		rpcIo.handler?.(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "start" })}\n`);
		await vi.waitFor(() => expect(observed.signal).toBeDefined(), { timeout: 20_000 });
		// Closing for a new session joins the run, so this only answers once the handler let go.
		await expect(send({ type: "new_session" })).resolves.toMatchObject({ success: true, command: "new_session" });
		expect(observed.released).toBe(true);
	});
});
