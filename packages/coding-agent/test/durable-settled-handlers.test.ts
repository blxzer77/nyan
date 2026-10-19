import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	InlineExtension,
	ProjectTrustContext,
} from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";

/**
 * `agent_end` and `agent_settled` on the durable path. They run after the run has settled, off the durable Session line,
 * and the host does await them; nothing in close, a session switch, or the next prompt joins that wait, so a handler
 * that never returns delays only its own settle promise (the response of `--print`, `--mode json`, and RPC `prompt`,
 * which await the run as legacy does). The handlers therefore get no `ctx.signal` (legacy's `agent_end` runs inside the
 * run and has one), which `docs/extensions.md` records as a difference.
 *
 * The one thing the wait does own is the staged `before_agent_start` effects. They are cleared when the run settles,
 * before the handlers run, so a prompt that starts while an `agent_end` handler is parked still applies its own
 * injected message and system prompt to its first request.
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

/** A parked `agent_end` handler: the first call waits until `release()` is called, later runs pass through. */
interface Parked {
	entered: boolean;
	release?: () => void;
}

function parkingExtension(
	parked: Parked,
	observed: { agentEnd: (AbortSignal | undefined)[]; agentSettled: (AbortSignal | undefined)[] },
): ExtensionFactory {
	return (pi) => {
		pi.on("agent_settled", (_event, ctx) => {
			observed.agentSettled.push(ctx.signal);
		});
		pi.on("agent_end", async (_event, ctx) => {
			observed.agentEnd.push(ctx.signal);
			if (parked.entered) return;
			parked.entered = true;
			await new Promise<void>((resolve) => {
				parked.release = resolve;
			});
		});
	};
}

function observedSignals(): { agentEnd: (AbortSignal | undefined)[]; agentSettled: (AbortSignal | undefined)[] } {
	return { agentEnd: [], agentSettled: [] };
}

/** Fails a test that hangs instead of reporting a timeout of the whole file. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T | "timeout"> {
	return Promise.race([
		promise,
		new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)).then((value) => {
			if (value === "timeout") console.error(`${label} did not finish within ${ms} ms`);
			return value;
		}),
	]);
}

describe("durable settled handlers", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;
	let exit: MockInstance | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-settled-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-settled-cwd-"));
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
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
		session = await openDurable({
			cwd,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(faux.provider), ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("a parked agent_end handler does not hold close()", async () => {
		const parked: Parked = { entered: false };
		const observed = observedSignals();
		const current = await open(
			[parkingExtension(parked, observed)],
			[() => fauxAssistantMessage([fauxText("done")])],
		);
		void current.controller.submit("go", "followUp");
		await vi.waitFor(() => expect(parked.entered).toBe(true), { timeout: 20_000 });
		// The handler is still parked here; close must not join it.
		const closed = await within(
			current.close("quit").then(() => "closed" as const),
			10_000,
			"close()",
		);
		expect(closed).toBe("closed");
		session = undefined;
		expect(observed.agentEnd).toEqual([undefined]);
		parked.release?.();
	});

	test("a parked agent_end handler does not hold the next prompt", async () => {
		const parked: Parked = { entered: false };
		const observed = observedSignals();
		const current = await open(
			[parkingExtension(parked, observed)],
			[() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])],
		);
		void current.controller.submit("first", "followUp");
		await vi.waitFor(() => expect(parked.entered).toBe(true), { timeout: 20_000 });
		const second = await within(current.controller.submitAndWait("second", "followUp"), 20_000, "the next prompt");
		expect(second).toMatchObject({ status: "done" });
		// The settled handlers have no signal, which `docs/extensions.md` records as a legacy difference.
		expect(observed.agentEnd).toEqual([undefined, undefined]);
		// The first run's agent_settled follows its parked agent_end, so it arrives only once the handler is released.
		parked.release?.();
		await vi.waitFor(() => expect(observed.agentSettled.length).toBe(2), { timeout: 20_000 });
		expect(observed.agentSettled).toEqual([undefined, undefined]);
	});

	test("an RPC new_session does not wait for a parked agent_end handler", async () => {
		const parked: Parked = { entered: false };
		const observed = observedSignals();
		const faux = fauxProvider();
		faux.setResponses([() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])]);
		const model = faux.getModel();
		exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		void runDurableRpc({
			cwd,
			extensionFactories: [
				(pi: ExtensionAPI) => pi.registerProvider(faux.provider),
				parkingExtension(parked, observed),
			],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		await vi.waitFor(() => expect(rpcIo.handler).toBeDefined(), { timeout: 20_000 });
		const send = (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const id = `req-${command.type as string}`;
			rpcIo.handler?.(`${JSON.stringify({ ...command, id })}\n`);
			const answer = vi
				.waitFor(
					() => {
						const response = rpcIo.lines
							.flatMap((line) => line.split("\n"))
							.filter((line) => line.trim().length > 0)
							.map((line) => JSON.parse(line) as Record<string, unknown>)
							.find((record) => record.type === "response" && record.id === id);
						expect(response).toBeDefined();
						return response;
					},
					{ timeout: 20_000 },
				)
				.then((response) => (response as Record<string, unknown>) ?? {});
			return within(answer, 20_000, `RPC ${command.type as string}`).then((response) =>
				response === "timeout" ? { timedOut: true } : response,
			);
		};
		// The prompt's own response waits for the run, as legacy's does; the handler is what parks the run's settle.
		rpcIo.handler?.(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "start" })}\n`);
		await vi.waitFor(() => expect(parked.entered).toBe(true), { timeout: 20_000 });
		// Closing for a new session does not join the settled handler, so this answers while it is still parked.
		await expect(send({ type: "new_session" })).resolves.toMatchObject({ success: true, command: "new_session" });
		expect(parked.entered).toBe(true);
		parked.release?.();
	});
});

/**
 * The staging hand-over, on the durable path with the CLIProxyAPI stand-in: an `agent_end` handler that is still parked
 * must not delay the next prompt's `before_agent_start` effects to that request.
 */
describe("durable before_agent_start staging across a parked agent_end", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let stub: Stub;
	let session: OpenDurableResult | undefined;

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
		close(): Promise<void>;
	}

	async function startStub(): Promise<Stub> {
		const bodies: string[] = [];
		const server: Server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				if (request.url?.startsWith("/v0/management/auth-files")) {
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
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(answerStream);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		return {
			baseUrl: `http://127.0.0.1:${port}`,
			bodies,
			close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		};
	}

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-staging-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-staging-cwd-"));
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
		await session?.close();
		session = undefined;
		vi.unstubAllEnvs();
		await stub.close();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	async function seedCatalog(): Promise<void> {
		const first = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await vi.waitFor(() => expect(first.modelRuntime.getModel("cliproxyapi", "deepseek-flash")).toBeDefined(), {
				timeout: 10_000,
			});
		} finally {
			await first.close();
		}
	}

	test("a parked agent_end handler does not delay the next prompt's injected message", async () => {
		await seedCatalog();
		const parked: Parked = { entered: false };
		let prompts = 0;
		const turnSignals: (AbortSignal | undefined)[] = [];
		const probe: InlineExtension = (pi) => {
			pi.on("before_agent_start", () => {
				prompts += 1;
				return { message: { customType: "probe.inject", content: `INJECTED-${prompts}`, display: false } };
			});
			pi.on("turn_end", (_event, ctx) => {
				turnSignals.push(ctx.signal);
			});
			parkingExtension(parked, observedSignals())(pi);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [...builtInExtensions, probe],
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		void session.controller.submit("first", "followUp");
		await vi.waitFor(() => expect(parked.entered).toBe(true), { timeout: 20_000 });
		expect(stub.bodies.at(-1)).toContain("INJECTED-1");
		// The first run's settle is still parked; the second prompt's effects must still reach its own first request.
		await session.controller.submitAndWait("second", "followUp");
		expect(stub.bodies.at(-1)).toContain("INJECTED-2");
		expect(turnSignals).toHaveLength(2);
		for (const signal of turnSignals) expect(signal).toBeInstanceOf(AbortSignal);
		parked.release?.();
	});
});
