import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	Type,
} from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import type { InlineExtension, ProjectTrustContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runDurableJson } from "../src/modes/durable/json.ts";
import { runDurableRpc } from "../src/modes/durable/rpc.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

/**
 * The N2 gate's event-type parity: `--mode json` and `--mode rpc` publish the same event types on the durable path as
 * on the legacy path. `docs/json.md` is the published vocabulary, and Decisions #18 and #21 keep every streamed event,
 * including `message_update`, the tool events, and the thinking-level events.
 *
 * Each scenario runs twice with the same extensions and the same faux provider: once through the legacy runtime that
 * `main.ts` hands to `runPrintMode`/`runRpcMode`, once through `runDurableJson`/`runDurableRpc`. The comparison is of
 * event types and RPC response commands, not of order or field values; the field checks that guard a fix are separate.
 * A difference that remains is asserted exactly, with its reason, so a new one fails the test.
 *
 * The provider is paced (`tokensPerSecond`) because the durable path commits a streamed partial at most every
 * `progress.partialIntervalMs` (100 ms): with an unthrottled provider the model answers between two commits, so durable
 * publishes no `message_update` at all while legacy publishes one per provider event.
 */

const io = vi.hoisted(() => ({
	lines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		io.lines.push(line);
	},
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	flushRawStdout: vi.fn(async () => {}),
}));

vi.mock("../src/ui/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		io.lineHandler = onLine;
		return () => {
			io.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type Record_ = Record<string, unknown>;

function records(): Record_[] {
	return io.lines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record_);
}

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

const toolParams = Type.Object({ text: Type.String() });

/** A tool that reports one partial result, which both paths publish with the same arguments and content. */
function probeTool(): ToolDefinition<typeof toolParams> {
	return {
		name: "probe",
		label: "Probe",
		description: "Echoes its input, reporting two partial results first.",
		parameters: toolParams,
		execute: async (_id, args, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: `partial ${args.text}` }], details: undefined });
			return { content: [{ type: "text", text: `probed ${args.text}` }], details: undefined };
		},
	};
}

interface ExtensionPackOptions {
	readonly tool?: boolean;
	readonly boundaryCustomMessage?: boolean;
	readonly boundaryCustomEntry?: boolean;
	readonly command?: boolean;
	readonly throwsOnTurnEnd?: boolean;
	/** Answers `user_bash` with operations that record the sandbox's own output. */
	readonly sandboxBash?: boolean;
	/** Answers `user_bash` with a finished result, so the command never runs. */
	readonly answeredBash?: boolean;
}

function extensionPack(options: ExtensionPackOptions): InlineExtension {
	return (pi) => {
		if (options.tool === true) pi.registerTool(probeTool());
		if (options.sandboxBash === true) {
			pi.on("user_bash", () => ({
				operations: {
					exec: async (command: string, _cwd: string, exec: { onData: (data: Buffer) => void }) => {
						exec.onData(Buffer.from(`sandboxed: ${command}\n`));
						return { exitCode: 0 };
					},
				},
			}));
		}
		if (options.answeredBash === true) {
			pi.on("user_bash", () => ({
				result: { output: "answered by the extension\n", exitCode: 0, cancelled: false, truncated: false },
			}));
		}
		if (options.command === true) {
			pi.registerCommand("probe", {
				description: "Probe command",
				handler: async (_args, ctx) => {
					ctx.ui.notify("command ran");
				},
			});
		}
		if (options.throwsOnTurnEnd === true) {
			pi.on("turn_end", () => {
				throw new Error("probe handler failure");
			});
		}
		if (options.boundaryCustomEntry === true) {
			let turns = 0;
			pi.on("turn_end", () => {
				turns += 1;
				if (turns !== 1) return;
				return {
					entries: [{ type: "custom" as const, customType: "probe.marker", data: { seen: 1 } }],
					continue: true,
				};
			});
		}
		if (options.boundaryCustomMessage === true) {
			let turns = 0;
			pi.on("turn_end", () => {
				turns += 1;
				if (turns !== 1) return;
				return {
					entries: [
						{ type: "custom_message" as const, customType: "probe.reminder", content: "remember", display: true },
					],
					continue: true,
				};
			});
		}
	};
}

const text =
	(answer: string): FauxResponseStep =>
	() =>
		fauxAssistantMessage([fauxText(answer)]);
const failure =
	(message: string): FauxResponseStep =>
	() =>
		fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
const toolCall =
	(name: string, args: Record<string, string>): FauxResponseStep =>
	() =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const typeNames = (records_: Record_[]): string[] =>
	records_
		.map((record) => (record.type === "response" ? `response:${String(record.command)}` : String(record.type)))
		.filter((name) => name !== "session");

const ofType = (records_: Record_[], type: string): Record_[] => records_.filter((record) => record.type === type);

/**
 * A faux provider both paths register through an extension. It is paced so a streamed answer spans at least one durable
 * partial commit, and it reports one token at a time so both paths see every delta.
 */
function pacedFaux(responses: FauxResponseStep[], tokensPerSecond = 20): FauxProviderHandle {
	const faux = fauxProvider({
		models: [{ id: "faux-1", reasoning: true }],
		tokensPerSecond,
		tokenSize: { min: 1, max: 1 },
	});
	faux.setResponses(responses);
	return faux;
}

const providerExtension =
	(faux: FauxProviderHandle): InlineExtension =>
	(pi) => {
		pi.registerProvider(faux.provider);
	};

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	readonly stdinEnd: NodeListener[];
	readonly signals: Map<NodeJS.Signals, NodeListener[]>;
}

/** The listeners a mode registers, so a stopped mode leaves the test process as it found it. */
function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

/** One running RPC mode, driven over the captured stdin and stdout. */
interface RpcTarget {
	mark(): number;
	since(mark: number): Record_[];
	send(command: Record_): Promise<Record_>;
	sendLater(command: Record_): Promise<string>;
	waitForResponse(id: string): Promise<Record_>;
	waitFor(mark: number, type: string): Promise<void>;
	waitIdle(): Promise<void>;
	stop(): Promise<void>;
}

let requests = 0;

function target(status: () => Promise<Record_>, stopMode: () => Promise<void>): RpcTarget {
	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		await stopMode();
	};
	const handler = (): ((line: string) => void) | undefined => io.lineHandler;
	const sendLater = async (command: Record_): Promise<string> => {
		const id = `req-${++requests}`;
		await vi.waitFor(() => expect(handler()).toBeDefined(), { timeout: 20_000 });
		handler()?.(`${JSON.stringify({ ...command, id })}\n`);
		return id;
	};
	const waitForResponse = async (id: string): Promise<Record_> => {
		let found: Record_ | undefined;
		await vi.waitFor(
			() => {
				found = records().find((record) => record.type === "response" && record.id === id);
				expect(found).toBeDefined();
			},
			{ timeout: 20_000 },
		);
		return found as Record_;
	};
	return {
		mark: () => records().length,
		since: (mark) => records().slice(mark),
		send: async (command) => waitForResponse(await sendLater(command)),
		sendLater,
		waitForResponse,
		async waitFor(mark, type) {
			await vi.waitFor(
				() =>
					expect(
						records()
							.slice(mark)
							.some((record) => record.type === type),
					).toBe(true),
				{
					timeout: 20_000,
				},
			);
		},
		async waitIdle() {
			await vi.waitFor(
				async () => {
					const state = (await status()).data as Record_;
					expect(state.isStreaming).toBe(false);
				},
				{ timeout: 20_000 },
			);
		},
		stop,
	};
}

interface OpenOptions {
	readonly pack: InlineExtension;
	readonly responses: FauxResponseStep[];
	readonly settings?: Record<string, unknown>;
	/** Paced provider speed, in tokens per second. */
	readonly tokensPerSecond?: number;
}

type RpcScenario = (target: RpcTarget) => Promise<Record_[]>;

interface Comparison {
	readonly name: string;
	readonly legacy: () => Promise<Record_[]>;
	readonly durable: () => Promise<Record_[]>;
	/** Types only one side emits, each with the reason it is expected. A new difference fails the test. */
	readonly onlyLegacy?: readonly string[];
	readonly onlyDurable?: readonly string[];
	readonly check?: (legacy: Record_[], durable: Record_[]) => void;
}

describe("event type parity", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let running: RpcTarget | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-parity-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-parity-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		io.lines = [];
		io.lineHandler = undefined;
		requests = 0;
		running = undefined;
	});

	afterEach(async () => {
		await running?.stop();
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	/** The legacy runtime host that `--mode json` and `--mode rpc` run against, with a paced faux provider. */
	async function openLegacy(options: OpenOptions): Promise<Awaited<ReturnType<typeof createAgentSessionRuntime>>> {
		const faux = pacedFaux(options.responses, options.tokensPerSecond);
		const model = faux.getModel();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: sessionCwd, sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd: sessionCwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(options.settings ?? {}),
				resourceLoaderOptions: {
					extensionFactories: [providerExtension(faux), options.pack],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		return createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd),
		});
	}

	async function durableProvider(options: OpenOptions): Promise<{
		faux: FauxProviderHandle;
		model: { provider: string; modelId: string };
	}> {
		if (options.settings !== undefined) {
			await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings));
		}
		const faux = pacedFaux(options.responses, options.tokensPerSecond);
		const model = faux.getModel();
		return { faux, model: { provider: model.provider, modelId: model.id } };
	}

	async function legacyJson(options: OpenOptions, prompts: string[]): Promise<Record_[]> {
		io.lines = [];
		await runPrintMode(await openLegacy(options), { mode: "json", messages: prompts });
		return records();
	}

	async function durableJson(options: OpenOptions, prompts: string[]): Promise<Record_[]> {
		io.lines = [];
		const { faux, model } = await durableProvider(options);
		await runDurableJson({
			cwd,
			extensionFactories: [providerExtension(faux), options.pack],
			model,
			projectTrustContext: { ...headless, cwd },
			messages: prompts,
		});
		return records();
	}

	/** Start an RPC mode and drive it; `process.exit` and stdin end are how either mode shuts down. */
	async function startRpc(start: () => void): Promise<RpcTarget> {
		io.lines = [];
		io.lineHandler = undefined;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const snapshot = takeListenerSnapshot();
		start();
		await vi.waitFor(() => expect(io.lineHandler).toBeDefined(), { timeout: 20_000 });
		const status = async (): Promise<Record_> => {
			const id = `status-${++requests}`;
			io.lineHandler?.(`${JSON.stringify({ type: "get_state", id })}\n`);
			let response: Record_ | undefined;
			await vi.waitFor(
				() => {
					response = records().find((record) => record.type === "response" && record.id === id);
					expect(response).toBeDefined();
				},
				{ timeout: 20_000 },
			);
			return response as Record_;
		};
		const stopped = target(status, async () => {
			process.stdin.emit("end");
			await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 20_000 });
			exit.mockRestore();
			restoreListeners(snapshot);
		});
		running = stopped;
		return stopped;
	}

	async function openLegacyRpc(options: OpenOptions): Promise<RpcTarget> {
		const runtime = await openLegacy(options);
		return startRpc(() => void runRpcMode(runtime));
	}

	async function openDurableRpc(options: OpenOptions): Promise<RpcTarget> {
		const { faux, model } = await durableProvider(options);
		return startRpc(
			() =>
				void runDurableRpc({
					cwd,
					extensionFactories: [providerExtension(faux), options.pack],
					model,
					projectTrustContext: { ...headless, cwd },
				}),
		);
	}

	function compare(comparison: Comparison): Promise<void> {
		return (async () => {
			const legacy = await comparison.legacy();
			const durable = await comparison.durable();
			const legacyTypes = [...new Set(typeNames(legacy))].sort();
			const durableTypes = [...new Set(typeNames(durable))].sort();
			expect(durableTypes.filter((type) => !legacyTypes.includes(type))).toEqual(
				[...(comparison.onlyDurable ?? [])].sort(),
			);
			expect(legacyTypes.filter((type) => !durableTypes.includes(type))).toEqual(
				[...(comparison.onlyLegacy ?? [])].sort(),
			);
			comparison.check?.(legacy, durable);
		})();
	}

	async function compareRpc(
		name: string,
		scenario: RpcScenario,
		options: OpenOptions,
		extra?: Pick<Comparison, "onlyLegacy" | "onlyDurable" | "check">,
	): Promise<void> {
		await compare({
			name,
			...extra,
			legacy: async () => {
				const legacy = await openLegacyRpc(options);
				try {
					return await scenario(legacy);
				} finally {
					await legacy.stop();
				}
			},
			durable: async () => {
				const durable = await openDurableRpc(options);
				try {
					return await scenario(durable);
				} finally {
					await durable.stop();
				}
			},
		});
	}

	const longAnswer = "this answer is long enough to stream in several chunks";

	test("json: a plain text answer", async () => {
		const options: OpenOptions = { pack: extensionPack({}), responses: [text(longAnswer)] };
		await compare({
			name: "json plain text",
			legacy: () => legacyJson(options, ["say hi"]),
			durable: () => durableJson(options, ["say hi"]),
			check: (legacy, durable) => {
				// Decision #18: the streamed deltas are published, not reduced to the completed message.
				expect(ofType(durable, "message_update").length).toBeGreaterThan(1);
				expect(ofType(legacy, "message_update").length).toBeGreaterThan(1);
			},
		});
	});

	test("json: an answer that finishes within one partial interval", async () => {
		// The provider answers between two partial commits, so durable streams nothing; Decision #31 keeps one
		// `message_update` before `message_end` anyway, because legacy publishes one per provider event.
		const options: OpenOptions = { pack: extensionPack({}), responses: [text("hi")], tokensPerSecond: 0 };
		await compare({
			name: "json fast answer",
			legacy: () => legacyJson(options, ["say hi"]),
			durable: () => durableJson(options, ["say hi"]),
			check: (legacy, durable) => {
				const assistantEnd = durable.findIndex(
					(record) =>
						record.type === "message_end" && (record.message as Record_ | undefined)?.role === "assistant",
				);
				expect(durable[assistantEnd - 1]).toMatchObject({
					type: "message_update",
					assistantMessageEvent: { type: "done", reason: "stop" },
				});
				expect(ofType(durable, "message_update")).toHaveLength(1);
				expect(ofType(legacy, "message_update").length).toBeGreaterThan(0);
			},
		});
	});

	test("json: one tool round with partial results", async () => {
		const options: OpenOptions = {
			pack: extensionPack({ tool: true }),
			responses: [toolCall("probe", { text: "x" }), text(longAnswer)],
		};
		await compare({
			name: "json tool round",
			legacy: () => legacyJson(options, ["use the probe tool"]),
			durable: () => durableJson(options, ["use the probe tool"]),
			check: (legacy, durable) => {
				const partials = (records_: Record_[]): string[] =>
					ofType(records_, "tool_execution_update").map((record) =>
						JSON.stringify({
							args: record.args,
							partialResult: (record.partialResult as Record_).content,
						}),
					);
				// The published `args` and the accumulated `partialResult` of every update, which the durable event
				// carries as a window and as no arguments at all.
				expect(partials(durable)).toEqual(partials(legacy));
				expect(partials(durable)).toEqual([
					'{"args":{"text":"x"},"partialResult":[{"type":"text","text":"partial x"}]}',
				]);
				// `durationMs` is documented as part of the end event; durable records it on the result message.
				const durations = (records_: Record_[]): unknown[] =>
					ofType(records_, "tool_execution_end").map((record) => typeof record.durationMs);
				expect(durations(durable)).toEqual(["number"]);
				expect(durations(durable)).toEqual(durations(legacy));
				// `turn_end.toolResults` names the turn's results, as it does on the legacy path.
				const toolResults = (records_: Record_[]): number[] =>
					ofType(records_, "turn_end").map((record) => (record.toolResults as unknown[]).length);
				expect(toolResults(durable)).toEqual(toolResults(legacy));
				expect(toolResults(durable)).toEqual([1, 0]);
			},
		});
	});

	test("json: a bash tool round that streams output", async () => {
		const options: OpenOptions = {
			pack: extensionPack({}),
			responses: [
				toolCall("bash", { command: "for i in 1 2 3; do echo line$i; sleep 0.1; done" }),
				text(longAnswer),
			],
		};
		await compare({
			name: "json bash tool round",
			legacy: () => legacyJson(options, ["run the command"]),
			durable: () => durableJson(options, ["run the command"]),
			check: (legacy, durable) => {
				const lastText = (records_: Record_[]): string => {
					const updates = ofType(records_, "tool_execution_update");
					const last = updates.at(-1);
					if (last === undefined) return "";
					const result = last.partialResult as { content: { text?: string }[] };
					return result.content.map((part) => part.text ?? "").join("");
				};
				// Durable sends the output as front-trim/append windows; the published `partialResult` is the output so far,
				// as on the legacy path.
				expect(ofType(durable, "tool_execution_update").length).toBeGreaterThan(0);
				expect(lastText(durable)).toBe(lastText(legacy));
				expect(lastText(durable)).toContain("line3");
			},
		});
	});

	test("json: an extension-injected custom message", async () => {
		const options: OpenOptions = {
			pack: extensionPack({ boundaryCustomMessage: true }),
			responses: [text(longAnswer), text(`${longAnswer} again`)],
		};
		await compare({
			name: "json custom message",
			legacy: () => legacyJson(options, ["go"]),
			durable: () => durableJson(options, ["go"]),
			check: (_legacy, durable) => {
				const appended = ofType(durable, "entry_appended");
				expect(appended.map((record) => record.entry)).toEqual([
					expect.objectContaining({
						type: "custom_message",
						customType: "probe.reminder",
						content: "remember",
						display: true,
					}),
				]);
			},
		});
	});

	test("json: an extension-appended custom entry", async () => {
		const options: OpenOptions = {
			pack: extensionPack({ boundaryCustomEntry: true }),
			responses: [text(longAnswer), text(`${longAnswer} again`)],
		};
		await compare({
			name: "json custom entry",
			legacy: () => legacyJson(options, ["go"]),
			durable: () => durableJson(options, ["go"]),
			check: (_legacy, durable) => {
				expect(ofType(durable, "entry_appended").map((record) => record.entry)).toEqual([
					expect.objectContaining({ type: "custom", customType: "probe.marker", data: { seen: 1 } }),
				]);
			},
		});
	});

	test("json: one retryable error and then a retry that answers", async () => {
		const options: OpenOptions = {
			pack: extensionPack({}),
			responses: [failure("503 Service Unavailable"), text("recovered answer")],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		};
		await compare({
			name: "json retry",
			legacy: () => legacyJson(options, ["go"]),
			durable: () => durableJson(options, ["go"]),
			// Legacy appends a `context_edit` entry that omits the failed attempt from the next request, and publishes it
			// as `entry_appended`. Durable keeps the failed attempt in the transcript and leaves it out of the request
			// without an entry, so there is nothing to publish; both send the retry with the same two messages.
			onlyLegacy: ["entry_appended"],
		});
	});

	test("rpc: a prompt that answers", async () => {
		await compareRpc(
			"rpc prompt",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "prompt", message: "hello" });
				await rpc.waitIdle();
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [text(longAnswer)] },
			{
				check: (legacy, durable) => {
					expect(ofType(durable, "message_update").length).toBeGreaterThan(1);
					expect(ofType(legacy, "message_update").length).toBeGreaterThan(1);
				},
			},
		);
	});

	test("rpc: a thinking level change", async () => {
		await compareRpc(
			"rpc thinking level",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "set_thinking_level", level: "high" });
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [] },
			{
				check: (_legacy, durable) => {
					expect(ofType(durable, "thinking_level_changed").map((record) => record.level)).toEqual(["high"]);
				},
			},
		);
	});

	test("rpc: an extension command", async () => {
		await compareRpc(
			"rpc extension command",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "prompt", message: "/probe one" });
				await rpc.waitIdle();
				return rpc.since(mark);
			},
			{ pack: extensionPack({ command: true }), responses: [] },
		);
	});

	test("rpc: abort while the answer streams", async () => {
		await compareRpc(
			"rpc abort",
			async (rpc) => {
				const mark = rpc.mark();
				const prompt = await rpc.sendLater({ type: "prompt", message: "hello" });
				await rpc.waitFor(mark, "message_update");
				await rpc.send({ type: "abort" });
				await rpc.waitForResponse(prompt);
				await rpc.waitIdle();
				return rpc.since(mark);
			},
			{
				pack: extensionPack({}),
				responses: [text(`${longAnswer} and then even more words than that`)],
				tokensPerSecond: 4,
			},
		);
	});

	test("rpc: an extension handler that throws", async () => {
		await compareRpc(
			"rpc extension error",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "prompt", message: "hello" });
				await rpc.waitIdle();
				return rpc.since(mark);
			},
			{ pack: extensionPack({ throwsOnTurnEnd: true }), responses: [text(longAnswer)] },
			{
				check: (legacy, durable) => {
					// The failed handler is published with its own extension path, event, and message, as legacy does; the
					// view's notice stays.
					expect(ofType(durable, "extension_error")).toEqual(ofType(legacy, "extension_error"));
					expect(
						ofType(durable, "extension_error").map((record) => ({ event: record.event, error: record.error })),
					).toEqual([{ event: "turn_end", error: "probe handler failure" }]);
				},
			},
		);
	});

	test("rpc: new_session", async () => {
		await compareRpc(
			"rpc new_session",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "new_session" });
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [] },
		);
	});

	test("rpc: fork at a user message", async () => {
		await compareRpc(
			"rpc fork",
			async (rpc) => {
				await rpc.send({ type: "prompt", message: "first" });
				await rpc.waitIdle();
				const mark = rpc.mark();
				const entries = (await rpc.send({ type: "get_entries" })).data as { entries: Record_[] };
				const user = entries.entries.find((entry) => (entry.message as Record_ | undefined)?.role === "user");
				const forked = await rpc.send({ type: "fork", entryId: String(user?.id) });
				expect(forked.success).toBe(true);
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [text("first answer")] },
		);
	});

	test("rpc: bash", async () => {
		await compareRpc(
			"rpc bash",
			async (rpc) => {
				const mark = rpc.mark();
				const response = await rpc.send({ type: "bash", command: "printf 'hello bash\\n'" });
				expect(response.data).toMatchObject({ output: "hello bash\n", exitCode: 0 });
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [] },
		);
	});

	test("rpc: a queued steer that is cleared", async () => {
		await compareRpc(
			"rpc queue update",
			async (rpc) => {
				const mark = rpc.mark();
				const prompt = await rpc.sendLater({ type: "prompt", message: "hello" });
				await rpc.waitFor(mark, "message_update");
				const steer = await rpc.sendLater({ type: "steer", message: "queued text" });
				await rpc.waitFor(mark, "queue_update");
				const cleared = await rpc.send({ type: "clear_queue" });
				expect(cleared.data).toEqual({ steering: ["queued text"], followUp: [] });
				await rpc.waitForResponse(steer);
				await rpc.waitForResponse(prompt);
				await rpc.waitIdle();
				return rpc.since(mark);
			},
			{
				pack: extensionPack({}),
				responses: [text(`${longAnswer} and then even more words than that`)],
				tokensPerSecond: 4,
			},
			{
				check: (legacy, durable) => {
					const queues = (records_: Record_[]): unknown[] =>
						ofType(records_, "queue_update").map((record) => ({
							steering: record.steering,
							followUp: record.followUp,
						}));
					// The queued text, then the queue the clearing leaves, read from `nyan.inbox`.
					expect(queues(durable)).toEqual([
						{ steering: ["queued text"], followUp: [] },
						{ steering: [], followUp: [] },
					]);
					expect(queues(durable)).toEqual(queues(legacy));
				},
			},
		);
	});

	test("rpc: bash runs through the operations a user_bash handler answers", async () => {
		const marker = join(cwd, "local-shell-ran.txt");
		await compareRpc(
			"rpc user_bash operations",
			async (rpc) => {
				const mark = rpc.mark();
				const response = await rpc.send({ type: "bash", command: `touch ${marker}` });
				expect(response.data).toMatchObject({ output: `sandboxed: touch ${marker}\n`, exitCode: 0 });
				return rpc.since(mark);
			},
			{ pack: extensionPack({ sandboxBash: true }), responses: [] },
		);
		// The handler's operations replaced the local shell, on both paths.
		await expect(access(marker)).rejects.toThrow();
	});

	test("rpc: bash answers with a result a user_bash handler ran itself", async () => {
		const marker = join(cwd, "answered-bash.txt");
		await compareRpc(
			"rpc user_bash result",
			async (rpc) => {
				const mark = rpc.mark();
				const response = await rpc.send({ type: "bash", command: `touch ${marker}` });
				expect(response.data).toEqual({
					output: "answered by the extension\n",
					exitCode: 0,
					cancelled: false,
					truncated: false,
				});
				// The result is recorded as the command's entry, so the next request carries it. Legacy stores it under
				// its own `bashExecution` message role; durable keeps that data on the entry and its model message is the
				// user message the output becomes.
				await rpc.send({ type: "get_entries" });
				return rpc.since(mark);
			},
			{ pack: extensionPack({ answeredBash: true }), responses: [text(longAnswer)] },
			{
				check: (legacy, durable) => {
					const recorded = (records_: Record_[]): (Record_ | undefined)[] => {
						const response = records_.find(
							(record) => record.type === "response" && record.command === "get_entries",
						)?.data as { entries: Record_[] };
						return response.entries.flatMap((entry) =>
							entry.message === undefined ? [] : [entry.message as Record_],
						);
					};
					expect(recorded(legacy)).toEqual([
						expect.objectContaining({ role: "bashExecution", output: "answered by the extension\n" }),
					]);
					expect(recorded(durable)).toEqual([
						expect.objectContaining({
							role: "user",
							content: expect.stringContaining("answered by the extension"),
						}),
					]);
				},
			},
		);
		await expect(access(marker)).rejects.toThrow();
	});

	test("rpc: set_session_name", async () => {
		await compareRpc(
			"rpc set_session_name",
			async (rpc) => {
				const mark = rpc.mark();
				await rpc.send({ type: "set_session_name", name: "a name" });
				return rpc.since(mark);
			},
			{ pack: extensionPack({}), responses: [] },
			{
				check: (_legacy, durable) => {
					expect(ofType(durable, "session_info_changed").map((record) => record.name)).toEqual(["a name"]);
				},
			},
		);
	});
});
