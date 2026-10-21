import * as crypto from "node:crypto";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@ny4n/agent-core";
import { getSupportedThinkingLevels } from "@ny4n/ai";
import type { AgentEventStream, AgentState, ConversationId, LiveState, UsageState } from "@ny4n/durable";
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
import { applySessionSetup, type DurableSessionSetup } from "./session-setup.ts";

export type DurableRpcOptions = OpenDurableOptions & {
	/** `--name` and `--fork`, applied before the first command is read. */
	readonly setup?: DurableSessionSetup;
};

/** Run the durable product path with the JSON-lines RPC protocol. */
export async function runDurableRpc(options: DurableRpcOptions): Promise<never> {
	takeOverStdout();
	let durable = await openDurable({ ...options, eventStream: true });
	let eventAdapter: DurableJsonEventAdapter;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	let detachInput = (): void => {};

	const output = (value: unknown): void => writeRawStdout(serializeJsonLine(value));
	let detachExtensionErrors = (): void => {};
	/**
	 * Publish a failed extension handler as `extension_error`, as the legacy RPC mode does; a notice stays as well. A
	 * reopened session binds its own listener, so the one it replaces is dropped first.
	 */
	const bindExtensionErrors = (source: OpenDurableResult): void => {
		detachExtensionErrors();
		detachExtensionErrors = source.onExtensionError((error) =>
			output({
				type: "extension_error",
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			}),
		);
	};
	bindExtensionErrors(durable);
	// `--name` and `--fork` are applied before anything reads the session, so `get_state` reports the name the command
	// line asked for and every prompt goes to the forked conversation.
	await applySessionSetup(durable, options.setup);
	/**
	 * The dialogs the client has been asked and has not answered. Each one names the method it asks for, so a response
	 * shaped for another dialog cannot be mistaken for its answer, and carries the way to settle it with its default
	 * when the session it belongs to goes away.
	 */
	const pendingExtensionRequests = new Map<string, PendingExtensionDialog>();

	/**
	 * Answer every dialog still waiting, with the default its dialog would give on a timeout, and forget its id. Called
	 * before the session an extension command is running against is closed or replaced: the command continues instead of
	 * waiting forever, and a response the client sends afterwards answers nothing.
	 */
	const settlePendingDialogs = (): void => {
		const waiting = [...pendingExtensionRequests.values()];
		pendingExtensionRequests.clear();
		for (const dialog of waiting) dialog.settle();
	};

	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: ExtensionDialogRequest,
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
				method: request.method,
				resolve: (response) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
				settle: () => {
					cleanup();
					resolve(defaultValue);
				},
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

	/**
	 * Bind this mode's dialogs to one open. The extension runner is built per open, so a session the RPC mode replaces or
	 * switches to needs its own binding: an unbound runner reports `ctx.hasUI === false` and answers every dialog
	 * unanswered, which is what a reopened session saw.
	 */
	const bindUIContext = (source: OpenDurableResult): void => {
		source.extensionHost.runner.setUIContext(createExtensionUIContext(), "rpc");
	};
	bindUIContext(durable);
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

	let stream: AgentEventStream | undefined;
	/** Listen to the events of `conversationId`, or of the conversation this open started with. */
	const bindEvents = async (conversationId?: ConversationId): Promise<void> => {
		const previous = stream;
		stream = conversationId === undefined ? durable.events : await durable.eventsOf(conversationId);
		if (stream === undefined) throw new Error("Durable RPC mode did not acquire an event stream");
		// A fork moves the adapter to another conversation: the stream it leaves is this adapter's to stop. The stream an
		// open hands back is the runtime's, and closing the open stops it.
		if (previous !== undefined && previous !== stream) await previous.stop();
		eventAdapter = new DurableJsonEventAdapter(
			() => messagesOf(durable),
			() => durable.sessionOps.queueTexts(),
		);
		const events = stream;
		events.start(async (batch) => {
			for (const event of await eventAdapter.translate(batch)) output(event);
			await waitForRawStdoutBackpressure();
		});
	};
	await bindEvents();

	/** Show and talk to the conversation a fork or a clone created, and follow its events. */
	const moveTo = async (conversationId: ConversationId): Promise<void> => {
		await durable.controller.switchConversation(conversationId);
		await bindEvents(conversationId);
	};

	const replaceSession = async (continueSession: boolean): Promise<void> => {
		// The services outlive the replaced session: extensions load once per process, not once per session.
		const services = durable.services;
		settlePendingDialogs();
		await durable.close(continueSession ? "resume" : "new");
		durable = await openDurable({ ...options, continueSession, services, eventStream: true });
		sessionName = await durable.sessionOps.getSessionName();
		bindExtensionErrors(durable);
		bindUIContext(durable);
		await bindEvents();
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
				const content =
					command.images === undefined
						? command.message
						: [{ type: "text" as const, text: command.message }, ...command.images];
				void dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message).then((handled) => {
					if (handled) return output(success(id, "prompt", { disposition: "handled" }));
					return durable.controller
						.submitAndWait(content, command.streamingBehavior ?? "steer", { source: "rpc" })
						.then(
							(outcome) =>
								output(success(id, "prompt", { disposition: outcome.handled ? "handled" : "started" })),
							(error) => output(failure(id, "prompt", error instanceof Error ? error.message : String(error))),
						);
				});
				return undefined;
			}
			case "steer": {
				if (await dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message)) {
					return success(id, "steer", { disposition: "handled" });
				}
				const outcome = await durable.controller.submitAndWait(
					command.images === undefined
						? command.message
						: [{ type: "text" as const, text: command.message }, ...command.images],
					"steer",
					{ source: "rpc" },
				);
				return success(id, "steer", { disposition: outcome.handled ? "handled" : "queued" });
			}
			case "follow_up": {
				if (await dispatchDurableExtensionCommand(durable.extensionHost.runner, command.message)) {
					return success(id, "follow_up", { disposition: "handled" });
				}
				const outcome = await durable.controller.submitAndWait(
					command.images === undefined
						? command.message
						: [{ type: "text" as const, text: command.message }, ...command.images],
					"followUp",
					{ source: "rpc" },
				);
				return success(id, "follow_up", { disposition: outcome.handled ? "handled" : "queued" });
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
				await durable.controller.abortRetry();
				return success(id, "abort_retry");
			case "bash": {
				// A `user_bash` handler answers with operations to run the command through, or with a finished result; a
				// sandbox extension that answers must not fall through to this process's shell (legacy RPC mode).
				const handled = await durable.extensionHost.runner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: durable.view.current().session.cwd,
				});
				if (handled?.result !== undefined) {
					await durable.controller.recordBashResult(
						command.command,
						handled.result,
						command.excludeFromContext ?? false,
					);
					return success(id, "bash", handled.result);
				}
				const result = await durable.controller.executeBash(
					command.command,
					command.excludeFromContext ?? false,
					(delta) => output({ type: "bash_execution_update", ...(id === undefined ? {} : { id }), delta }),
					handled?.operations,
				);
				return success(id, "bash", result);
			}
			case "abort_bash":
				durable.controller.abortBash();
				return success(id, "abort_bash");
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
				output({ type: "session_info_changed", name: sessionName });
				return success(id, "set_session_name");
			case "export_html": {
				const path = await durable.sessionOps.exportHtml(command.outputPath);
				return success(id, "export_html", { path });
			}
			case "fork": {
				const forked = await durable.sessionOps.fork(command.entryId);
				if (forked.cancelled) return success(id, "fork", { cancelled: true });
				await moveTo(forked.conversationId);
				return success(id, "fork", { text: forked.text, cancelled: false });
			}
			case "clone": {
				const cloned = await durable.sessionOps.clone();
				if (cloned.cancelled) return success(id, "clone", { cancelled: true });
				await moveTo(cloned.conversationId);
				return success(id, "clone", { cancelled: false });
			}
			case "get_fork_messages":
				return success(id, "get_fork_messages", {
					messages: (await durable.sessionOps.forkMessages()).map((message) => ({ ...message })),
				});
			case "get_tree": {
				const tree = await durable.sessionOps.tree();
				return success(id, "get_tree", { tree: tree.tree, leafId: tree.leafId });
			}
			case "switch_session": {
				const previous = durable;
				const previousSessionFile = state().sessionFile;
				const targetDirectory = command.sessionPath;
				const targetSessionFile = join(resolve(targetDirectory), "session.sqlite");
				const before = await durable.extensionHost.beforeSwitch(targetSessionFile);
				if (before.cancelled) return success(id, "switch_session", { cancelled: true });

				// Open and lock the target before closing the current session. The original remains intact when opening the
				// target fails (bad path, missing cwd, or an existing lock).
				const reopenOptions: OpenDurableOptions = {
					...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
					...(options.resources === undefined ? {} : { resources: options.resources }),
					...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
					...(options.extensionFlagValues === undefined
						? {}
						: { extensionFlagValues: options.extensionFlagValues }),
					...(options.projectTrustContext === undefined
						? {}
						: { projectTrustContext: options.projectTrustContext }),
					...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
					...(options.settingsOverrides === undefined ? {} : { settingsOverrides: options.settingsOverrides }),
				};
				const next: OpenDurableResult = await openDurable({
					...reopenOptions,
					sessionDirectory: targetDirectory,
					sessionStartEvent: {
						type: "session_start",
						reason: "resume",
						previousSessionFile,
					},
					services: previous.services,
					eventStream: true,
				});
				try {
					// The dialogs of the session being left are answered with their default: the client asked to move on, and the
					// commands waiting on them would otherwise hold the close below.
					settlePendingDialogs();
					await previous.close("resume");
				} catch (error) {
					await next.close().catch(() => {});
					throw error;
				}
				durable = next;
				sessionName = await durable.sessionOps.getSessionName();
				bindExtensionErrors(durable);
				bindUIContext(durable);
				await bindEvents();
				return success(id, "switch_session", { cancelled: false });
			}
		}
	};

	const shutdown = async (exitCode = 0, signal?: NodeJS.Signals): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) cleanup();
		detachInput();
		process.stdin.pause();
		killTrackedDetachedChildren();
		settlePendingDialogs();
		await stream?.stop();
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
				const refusal = answerDialog(parsed as RpcExtensionUIResponse, pendingExtensionRequests);
				if (refusal !== undefined) {
					output(refusal);
					await waitForRawStdoutBackpressure();
				}
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

/**
 * One dialog the RPC mode is waiting to have answered. `method` is what the request asked for, and it decides which
 * responses answer it: the protocol puts no method on a response, so its shape is what identifies its dialog.
 */
interface PendingExtensionDialog {
	readonly method: "select" | "confirm" | "input";
	readonly resolve: (response: RpcExtensionUIResponse) => void;
	readonly reject: (error: Error) => void;
	readonly settle: () => void;
}

/** The dialog methods the client answers; `notify`, `setStatus`, and the others are one-way. */
type ExtensionDialogRequest = Extract<RpcExtensionUIRequest, { readonly method: "select" | "confirm" | "input" }>;

/**
 * Hand one `extension_ui_response` to the dialog it names. A response whose shape answers a different dialog (a
 * `confirmed` where a `select` was asked) is refused with a failure line instead of being coerced into the dialog's
 * default and read as an answer, and the dialog stays open for the answer it does ask for. Returns the failure to
 * report, or `undefined` when the response was delivered or names nothing this mode is waiting for.
 */
function answerDialog(
	response: RpcExtensionUIResponse,
	pending: ReadonlyMap<string, PendingExtensionDialog>,
): RpcResponse | undefined {
	const dialog = pending.get(response.id);
	if (dialog === undefined) return undefined;
	if (!answersDialog(response, dialog.method)) {
		return {
			type: "response",
			command: "extension_ui_response",
			success: false,
			error: `Response for ${response.id} does not answer a ${dialog.method} dialog`,
		};
	}
	dialog.resolve(response);
	return undefined;
}

function answersDialog(response: RpcExtensionUIResponse, method: PendingExtensionDialog["method"]): boolean {
	if ("cancelled" in response && response.cancelled) return true;
	return method === "confirm" ? "confirmed" in response : "value" in response;
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
