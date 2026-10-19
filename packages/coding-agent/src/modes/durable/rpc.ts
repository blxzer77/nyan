import * as crypto from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "@ny4n/agent-core";
import { getSupportedThinkingLevels } from "@ny4n/ai";
import type { AgentState, LiveState, UsageState } from "@ny4n/durable";
import { dispatchDurableExtensionCommand, getDurableExtensionCommands } from "../../core/durable/extension-commands.ts";
import { type OpenDurableOptions, type OpenDurableResult, openDurable } from "../../core/durable/runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { type Theme, theme } from "../../ui/theme/theme.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "../rpc/rpc-types.ts";
import { DurableJsonEventAdapter } from "./json-events.ts";

export type DurableRpcOptions = OpenDurableOptions;

/** Run the durable product path with the JSON-lines RPC protocol. */
export async function runDurableRpc(options: DurableRpcOptions): Promise<never> {
	takeOverStdout();
	let durable = await openDurable({ ...options, eventStream: true });
	let eventAdapter: DurableJsonEventAdapter;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let detachInput = (): void => {};

	const output = (value: unknown): void => writeRawStdout(serializeJsonLine(value));
	const pendingExtensionRequests = new Map<
		string,
		{
			resolve: (response: RpcExtensionUIResponse) => void;
			reject: (error: Error) => void;
		}
	>();

	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: RpcExtensionUIRequest,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		return new Promise((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = (): void => {
				if (timeout !== undefined) clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(request.id);
			};
			const onAbort = (): void => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined)
				timeout = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			pendingExtensionRequests.set(request.id, {
				resolve: (response) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output(request);
		});
	}

	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "select",
					title,
					options,
					timeout: opts?.timeout,
				},
				(response) =>
					("cancelled" in response && response.cancelled) || !("value" in response) ? undefined : response.value,
			),
		confirm: (title, message, opts) =>
			createDialogPromise(
				opts,
				false,
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "confirm",
					title,
					message,
					timeout: opts?.timeout,
				},
				(response) =>
					("cancelled" in response && response.cancelled) || !("confirmed" in response)
						? false
						: response.confirmed,
			),
		input: (title, placeholder, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "input",
					title,
					placeholder,
					timeout: opts?.timeout,
				},
				(response) =>
					("cancelled" in response && response.cancelled) || !("value" in response) ? undefined : response.value,
			),
		notify: (message, type) =>
			output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType: type }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) =>
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			}),
		setWorkingMessage: (_message?: string) => {},
		setWorkingVisible: (_visible: boolean) => {},
		setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
		setHiddenThinkingLabel: (_label?: string) => {},
		setWidget: (_key: string, _content: unknown, _options?: ExtensionWidgetOptions) => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => output({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title }),
		custom: async () => {
			throw new Error("Extension custom UI components are not available on the durable RPC path yet");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not available on the durable RPC path yet" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	});

	durable.extensionHost.runner.setUIContext(createExtensionUIContext(), "rpc");
	const success = (id: string | undefined, command: string, data?: object | null): RpcResponse =>
		({
			...(id === undefined ? {} : { id }),
			type: "response",
			command,
			success: true,
			...(data === undefined ? {} : { data }),
		}) as RpcResponse;
	const failure = (id: string | undefined, command: string, message: string): RpcResponse => ({
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: false,
		error: message,
	});

	const messagesOf = (source: OpenDurableResult): AgentMessage[] =>
		source.view.current().conversation.entries.flatMap((entry) => (entry.model ?? []) as AgentMessage[]);

	// The display name lives beside the session database, so a reopen reads the name of the session it opened.
	let sessionName = await durable.sessionOps.getSessionName();

	const bindEvents = (): void => {
		const events = durable.events;
		if (events === undefined) throw new Error("Durable RPC mode did not acquire an event stream");
		eventAdapter = new DurableJsonEventAdapter(() => messagesOf(durable));
		events.start(async (batch) => {
			for (const event of eventAdapter.translate(batch)) output(event);
			await waitForRawStdoutBackpressure();
		});
	};
	bindEvents();

	const replaceSession = async (continueSession: boolean): Promise<void> => {
		// The services outlive the replaced session: extensions load once per process, not once per session.
		const services = durable.services;
		await durable.close(continueSession ? "resume" : "new");
		durable = await openDurable({ ...options, continueSession, services, eventStream: true });
		sessionName = await durable.sessionOps.getSessionName();
		bindEvents();
	};

	const state = (): RpcSessionState => {
		const view = durable.view.current();
		const agent = (view.conversation.docs["nyan.agent"] ?? {}) as AgentState;
		const live = (view.conversation.docs["nyan.live"] ?? {}) as LiveState;
		const inbox = (view.conversation.docs["nyan.inbox"] ?? { items: [] }) as unknown as {
			readonly items: readonly unknown[];
		};
		const model =
			agent.model === undefined
				? undefined
				: durable.modelRuntime.getModel(agent.model.provider, agent.model.modelId);
		const modes = durable.controller.getQueueModes();
		return {
			...(model === undefined ? {} : { model }),
			thinkingLevel: agent.thinkingLevel ?? "off",
			isStreaming: live.run !== undefined || live.generation !== undefined,
			isCompacting: (live.compactions ?? []).length > 0,
			steeringMode: modes.steeringMode,
			followUpMode: modes.followUpMode,
			sessionFile: join(view.session.directory, "session.sqlite"),
			sessionId: view.session.id,
			autoCompactionEnabled: durable.controller.getAutoCompaction(),
			messageCount: view.conversation.entries.reduce((count, entry) => count + (entry.model?.length ?? 0), 0),
			pendingMessageCount: inbox.items.length,
			...(sessionName === undefined ? {} : { sessionName }),
		};
	};

	const getAssistantText = (): string | null => {
		const assistant = [...messagesOf(durable)].reverse().find((message) => message.role === "assistant");
		return assistant === undefined ? null : textOfMessage(assistant);
	};

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		switch (command.type) {
			case "prompt": {
				const expandedMessage = durable.controller.expandPrompt(command.message);
				const content =
					command.images === undefined
						? expandedMessage
						: [{ type: "text" as const, text: expandedMessage }, ...command.images];
				void dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message).then((handled) => {
					if (handled) return output(success(id, "prompt", { disposition: "handled" }));
					return durable.controller.submitAndWait(content, command.streamingBehavior ?? "steer").then(
						() => output(success(id, "prompt", { disposition: "started" })),
						(error) => output(failure(id, "prompt", error instanceof Error ? error.message : String(error))),
					);
				});
				return undefined;
			}
			case "steer": {
				if (await dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message)) {
					return success(id, "steer", { disposition: "handled" });
				}
				const expandedSteerMessage = durable.controller.expandPrompt(command.message);
				await durable.controller.submitAndWait(
					command.images === undefined
						? expandedSteerMessage
						: [{ type: "text" as const, text: expandedSteerMessage }, ...command.images],
					"steer",
				);
				return success(id, "steer", { disposition: "queued" });
			}
			case "follow_up": {
				if (await dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message)) {
					return success(id, "follow_up", { disposition: "handled" });
				}
				const expandedFollowUpMessage = durable.controller.expandPrompt(command.message);
				await durable.controller.submitAndWait(
					command.images === undefined
						? expandedFollowUpMessage
						: [{ type: "text" as const, text: expandedFollowUpMessage }, ...command.images],
					"followUp",
				);
				return success(id, "follow_up", { disposition: "queued" });
			}
			case "abort":
				await durable.controller.abort();
				return success(id, "abort");
			case "clear_queue": {
				const cleared = await durable.sessionOps.clearQueue();
				return success(id, "clear_queue", { steering: cleared.steering, followUp: cleared.followUp });
			}
			case "new_session":
				await replaceSession(false);
				return success(id, "new_session", { cancelled: false });
			case "get_state":
				return success(id, "get_state", state());
			case "set_model": {
				const model = durable.modelRuntime.getModel(command.provider, command.modelId);
				if (model === undefined)
					return failure(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				await durable.controller.setModel({ provider: command.provider, modelId: command.modelId });
				return success(id, "set_model", model);
			}
			case "cycle_model": {
				const models = durable.modelRuntime.getAvailableSnapshot();
				const current = (durable.view.current().conversation.docs["nyan.agent"] ?? {}) as AgentState;
				const index =
					current.model === undefined
						? -1
						: models.findIndex(
								(model) => model.provider === current.model?.provider && model.id === current.model?.modelId,
							);
				const model = models[(index + 1) % Math.max(models.length, 1)];
				if (model === undefined) return success(id, "cycle_model", null);
				await durable.controller.setModel({ provider: model.provider, modelId: model.id });
				return success(id, "cycle_model", { model, thinkingLevel: state().thinkingLevel, isScoped: false });
			}
			case "get_available_models":
				return success(id, "get_available_models", { models: durable.modelRuntime.getAvailableSnapshot() });
			case "set_thinking_level":
				await durable.controller.setThinking(command.level);
				return success(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const current = state();
				if (current.model === undefined) return success(id, "cycle_thinking_level", null);
				const levels = getSupportedThinkingLevels(current.model);
				const next = levels[(levels.indexOf(current.thinkingLevel) + 1) % levels.length];
				if (next === undefined) return success(id, "cycle_thinking_level", null);
				await durable.controller.setThinking(next);
				return success(id, "cycle_thinking_level", { level: next });
			}
			case "get_available_thinking_levels": {
				const current = state();
				return success(id, "get_available_thinking_levels", {
					levels: current.model === undefined ? [] : getSupportedThinkingLevels(current.model),
				});
			}
			case "set_steering_mode":
				await durable.controller.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			case "set_follow_up_mode":
				await durable.controller.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			case "compact":
				await durable.controller.compact(command.customInstructions);
				return success(id, "compact", {});
			case "set_auto_compaction":
				await durable.controller.setAutoCompaction(command.enabled);
				return success(id, "set_auto_compaction");
			case "set_auto_retry":
				await durable.controller.setAutoRetry(command.enabled);
				return success(id, "set_auto_retry");
			case "abort_retry":
				return failure(id, "abort_retry", "Durable RPC does not expose retry-only cancellation yet");
			case "get_last_assistant_text":
				return success(id, "get_last_assistant_text", { text: getAssistantText() });
			case "get_messages":
				return success(id, "get_messages", { messages: messagesOf(durable) });
			case "get_commands": {
				const commands: RpcSlashCommand[] = getDurableExtensionCommands(durable.extensionHost.runner).map(
					(command) => ({
						name: command.invocationName,
						description: command.description,
						source: "extension" as const,
						sourceInfo: command.sourceInfo,
					}),
				);
				commands.push(
					...durable.promptTemplates.map((template) => ({
						name: template.name,
						description: template.description,
						source: "prompt" as const,
						sourceInfo: template.sourceInfo,
					})),
				);
				return success(id, "get_commands", { commands });
			}
			case "get_session_stats": {
				const messages = messagesOf(durable);
				const usage = ((durable.view.current().conversation.docs["nyan.usage"] ?? {}) as UsageState).models ?? {};
				const totals = Object.values(usage).reduce(
					(total, item) => ({
						input: total.input + item.input,
						output: total.output + item.output,
						cacheRead: total.cacheRead + item.cacheRead,
						cacheWrite: total.cacheWrite + item.cacheWrite,
						totalTokens: total.totalTokens + item.totalTokens,
						cost: total.cost + item.cost.total,
					}),
					{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
				);
				return success(id, "get_session_stats", {
					sessionFile: state().sessionFile,
					sessionId: state().sessionId,
					userMessages: messages.filter((message) => message.role === "user").length,
					assistantMessages: messages.filter((message) => message.role === "assistant").length,
					toolCalls: messages
						.filter((message) => message.role === "assistant")
						.reduce((count, message) => count + toolCallCount(message), 0),
					toolResults: messages.filter((message) => message.role === "toolResult").length,
					totalMessages: messages.length,
					tokens: totals,
					cost: totals.cost,
				});
			}
			case "get_entries": {
				const entries = await durable.sessionOps.entries(command.since);
				return success(id, "get_entries", { entries: entries.entries, leafId: entries.leafId });
			}
			case "set_session_name":
				sessionName = await durable.sessionOps.setSessionName(command.name);
				return success(id, "set_session_name");
			case "export_html": {
				const path = await durable.sessionOps.exportHtml(command.outputPath);
				return success(id, "export_html", { path });
			}
			case "switch_session":
			case "fork":
			case "clone":
			case "get_fork_messages":
			case "get_tree":
			case "bash":
			case "abort_bash":
				return failure(id, command.type, `Command ${command.type} is not available on the durable RPC path yet`);
		}
	};

	const shutdown = async (exitCode = 0, signal?: NodeJS.Signals): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) cleanup();
		detachInput();
		process.stdin.pause();
		killTrackedDetachedChildren();
		await durable.close();
		if (signal !== "SIGTERM") await waitForRawStdoutBackpressure();
		await flushRawStdout();
		process.exit(exitCode);
	};

	const handleLine = async (line: string): Promise<void> => {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			output(
				failure(
					undefined,
					"parse",
					`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
			output(failure(undefined, "parse", "RPC command must be a JSON object with a type"));
			return;
		}
		try {
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"type" in parsed &&
				parsed.type === "extension_ui_response"
			) {
				const response = parsed as RpcExtensionUIResponse;
				pendingExtensionRequests.get(response.id)?.resolve(response);
				return;
			}
			const response = await handleCommand(parsed as RpcCommand);
			if (response !== undefined) output(response);
			await waitForRawStdoutBackpressure();
		} catch (error) {
			const record = parsed as Record<string, unknown>;
			output(
				failure(
					typeof record.id === "string" ? record.id : undefined,
					parsed.type,
					error instanceof Error ? error.message : String(error),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const registerSignal = (signal: NodeJS.Signals, exitCode: number): void => {
		const handler = () => void shutdown(exitCode, signal);
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	};
	registerSignal("SIGTERM", 143);
	if (process.platform !== "win32") registerSignal("SIGHUP", 129);
	process.stdin.on("end", () => void shutdown());
	detachInput = attachJsonlLineReader(process.stdin, (line) => void handleLine(line));
	return new Promise(() => {});
}

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

function isToolCallPart(value: unknown): value is { readonly type: "toolCall" } {
	return typeof value === "object" && value !== null && "type" in value && value.type === "toolCall";
}

function textOfMessage(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("");
}

function toolCallCount(message: AgentMessage): number {
	if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) return 0;
	return message.content.filter(isToolCallPart).length;
}
