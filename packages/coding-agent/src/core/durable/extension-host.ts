import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage, ThinkingLevel } from "@ny4n/agent-core";
import type { Api, ImageContent, Model, UserMessage } from "@ny4n/ai";
import type { CodemodeSandbox } from "@ny4n/codemode";
import type { AgentEvent, Extension, GenerationHooks, ToolHooks, UserInput } from "@ny4n/durable";
import { ExtensionRunner } from "../extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionMode,
	ExtensionToolContext,
	InputSource,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolInfo,
} from "../extensions/types.ts";

import { ModelRegistry } from "../model-registry.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import {
	type BeforeRequestEffects,
	createCompactionHooks,
	createHookAdapter,
	createProviderHooks,
	createToolHooks,
	inProviderCall,
	type ProviderCall,
	type ProviderCallScope,
} from "./extension-adapter.ts";
import {
	type BridgedTool,
	isActiveByDefault,
	type ToolBridge,
	toDurableTool,
	toolsExtension,
} from "./extension-tools.ts";
import {
	CODEMODE_EXTENSION_NAME,
	CODEMODE_TOOL_NAME,
	codemodeExtension,
	codemodeNamespaces,
	createCodemodeSandbox,
	inactiveExtension,
	NATIVE_TOOL_INFOS,
	TOOL_SEARCH_EXTENSION_NAME,
	TOOL_SEARCH_TOOL_NAME,
	toolSearchExtension,
} from "./native-tools.ts";
import type { DurableServices } from "./services.ts";

/** Thrown by a Nyan API the durable path does not connect yet. Handlers that call it fail visibly, not silently. */
function unavailable(api: string): never {
	throw new Error(`${api} is not connected on the durable path yet`);
}

export interface ExtensionHostOptions {
	/** Created once per process and shared by every open: extension instances and their state live here. */
	readonly services: DurableServices;
	readonly cwd: string;
	/** The invocation mode extensions read as `ctx.mode`; the TUI binds its own context later. Defaults to `print`. */
	readonly mode?: ExtensionMode;
	readonly sessionManager?: ReadonlySessionManager;
	/** The agent's model, used when no provider call is in flight. */
	readonly agentModel: () => Model<Api> | undefined;
	readonly abort: () => void;
	readonly compact: () => void;
	/** Errors thrown by extension handlers; the caller shows them. Without a listener they would vanish. */
	readonly onExtensionError: (error: ExtensionError) => void;
	/**
	 * Installs the bridged tools in the session's registry. Called after `session_start` and whenever the runner refreshes
	 * its tools (`registerTool` after load, such as an MCP server that connects later).
	 */
	readonly installTools: (extension: Extension) => void;
	/** Whether no run is in flight; `ctx.isIdle()` and extensions that wait for idle read it. */
	readonly isIdle: () => boolean;
}

/** One open's view of the loaded extensions: a runner bound to this open, and the hook adapter it feeds. */
export interface ExtensionHost {
	readonly runner: ExtensionRunner;
	/** The provider-call members, bound to this open's runner. Tests call them directly; the adapter carries them. */
	readonly providerHooks: Partial<GenerationHooks>;
	/** The tool-event members: `tool_call` (beforeTool) and `tool_result` (afterTool). */
	readonly toolHooks: Partial<ToolHooks>;
	/** Emits the terminal run event before `agent_settled`. */
	settled(aborted: boolean, messages: readonly AgentMessage[]): Promise<void>;
	modelSelected(
		model: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void>;
	thinkingSelected(level: ThinkingLevel, previousLevel: ThinkingLevel): Promise<void>;
	/** Install in the registry; carries no members when no loaded extension handles a provider event. */
	readonly adapter: Extension;
	/** Whether a loaded extension handles `agent_start` or `turn_start`, which only the committed stream publishes. */
	readonly runEvents: boolean;
	/**
	 * Emits `agent_start` and `turn_start` for one batch of committed events, in order. The batch comes from a watch on
	 * the active conversation, so a fork or a conversation switch moves it with the controller.
	 */
	agentEvents(events: readonly AgentEvent[]): Promise<void>;
	/**
	 * The `input` handlers for one submitted input, before skill and prompt-template expansion. Undefined when a handler
	 * took the input and nothing is submitted; otherwise the input to submit, transformed when a handler asked for it.
	 */
	input(
		content: UserInput,
		options: { readonly source?: InputSource; readonly streamingBehavior?: "steer" | "followUp" },
	): Promise<UserInput | undefined>;
	/** Runs `before_agent_start` once for the submitted prompt and stages its message/system-prompt effects. */
	beforePrompt(content: UserInput): Promise<void>;
	/** Asks the extension whether a fork may start; a cancelled answer means it does not. */
	beforeFork(entryId: string, position: "before" | "at"): Promise<{ readonly cancelled: boolean }>;
	beforeSwitch(targetSessionFile: string): Promise<{ readonly cancelled: boolean }>;
	start(event: SessionStartEvent): Promise<void>;
	shutdown(reason: SessionShutdownEvent["reason"]): Promise<void>;
	/**
	 * Retire this open's bindings: the runner refuses every context afterwards, so a reference kept from a closed open
	 * fails instead of acting on a session that is gone. The extensions stay loaded for the next open, which builds its
	 * own host.
	 */
	retire(): Promise<void>;
}

/**
 * The durable path's ExtensionRunner. It is built per open, because it is bound to that open's controller, but the
 * extensions it runs are the ones `services` loaded, so a second open does not load them again.
 *
 * Connected: session lifecycle, before-agent-start effects, provider hooks, stream/tool/boundary/compaction hooks,
 * agent settlement, model/thinking selection, tools, commands, UI binding, and the read-only session facade.
 */
export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
	// Per provider call, not per host: see ProviderCallScope.
	const calls: ProviderCallScope = new AsyncLocalStorage<ProviderCall>();
	const loaded = options.services.resourceLoader.getExtensions();

	const sessionManager: ReadonlySessionManager = {
		getCwd: () => options.cwd,
		getSessionDir: () => unavailable("ctx.sessionManager.getSessionDir"),
		getSessionId: () => unavailable("ctx.sessionManager.getSessionId"),
		getSessionFile: () => unavailable("ctx.sessionManager.getSessionFile"),
		getLeafId: () => unavailable("ctx.sessionManager.getLeafId"),
		getLeafEntry: () => unavailable("ctx.sessionManager.getLeafEntry"),
		getEntry: () => unavailable("ctx.sessionManager.getEntry"),
		getLabel: () => unavailable("ctx.sessionManager.getLabel"),
		getBranch: () => unavailable("ctx.sessionManager.getBranch"),
		buildContextEntries: () => unavailable("ctx.sessionManager.buildContextEntries"),
		buildSessionProjection: () => unavailable("ctx.sessionManager.buildSessionProjection"),
		getHeader: () => unavailable("ctx.sessionManager.getHeader"),
		getEntries: () => unavailable("ctx.sessionManager.getEntries"),
		getTree: () => unavailable("ctx.sessionManager.getTree"),
		getSessionName: () => unavailable("ctx.sessionManager.getSessionName"),
	};

	let activeBeforeRequestEffects: BeforeRequestEffects | undefined;
	let activeEffectsHandedOut = false;
	const queuedBeforeRequestEffects: BeforeRequestEffects[] = [];
	/**
	 * The effects for one request. A prompt submitted while the run is in flight stages its own effects behind the
	 * current ones, and the request that carries that prompt is the next one, so a slot that was already handed out
	 * gives way to the queue. Without that, a steer's message and system prompt were missing from the request that
	 * carried it and reached the next run's first request instead (Decision #39).
	 */
	const takeBeforeRequestEffects = (): BeforeRequestEffects | undefined => {
		if (activeEffectsHandedOut) {
			const next = queuedBeforeRequestEffects.shift();
			if (next !== undefined) activeBeforeRequestEffects = next;
		}
		activeEffectsHandedOut = activeBeforeRequestEffects !== undefined;
		return activeBeforeRequestEffects;
	};

	const turnCounter = { value: 0 };
	// `turn_start` is numbered from the committed stream: `run_start` resets it and every committed `turn_end`
	// advances it, so the index counts the turns this run has completed, as legacy's `_turnIndex` does.
	let streamedTurns = 0;
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		options.cwd,
		options.sessionManager ?? sessionManager,
		new ModelRegistry(options.services.modelRuntime),
	);
	// The mode is known when the session opens, its UI context only when the mode binds it. Extensions read `ctx.mode` from
	// `session_start` on, and the built-in `herdr` integration reports only in a TUI session.
	runner.setUIContext(undefined, options.mode ?? "print");

	const actions: ExtensionActions = {
		sendMessage: () => unavailable("pi.sendMessage"),
		sendUserMessage: () => unavailable("pi.sendUserMessage"),
		appendEntry: () => unavailable("pi.appendEntry"),
		setSessionName: () => unavailable("pi.setSessionName"),
		getSessionName: () => unavailable("pi.getSessionName"),
		setLabel: () => unavailable("pi.setLabel"),
		getActiveTools: () => [...activeTools],
		getAllTools: () => toolInfos(),
		getSettings: () => options.services.settingsManager.getSettings(),
		setActiveTools: (names) => {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
			syncTools();
		},
		refreshTools: () => syncTools(),
		getCommands: () =>
			runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension" as const,
				sourceInfo: command.sourceInfo,
			})),
		setModel: () => unavailable("pi.setModel"),
		getThinkingLevel: () => unavailable("pi.getThinkingLevel"),
		setThinkingLevel: () => unavailable("pi.setThinkingLevel"),
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => calls.getStore()?.model ?? options.agentModel(),
		getScopedModels: () => [],
		isIdle: () => options.isIdle(),
		isProjectTrusted: () => options.services.projectTrusted,
		getSignal: () => calls.getStore()?.signal,
		abort: () => options.abort(),
		hasPendingMessages: () => false,
		shutdown: () => unavailable("ctx.shutdown"),
		getContextUsage: () => undefined,
		compact: () => options.compact(),
		getSystemPrompt: () => unavailable("ctx.getSystemPrompt"),
	};

	runner.bindCore(actions, contextActions);
	const providerHooks = createProviderHooks(
		runner,
		calls,
		runner.hasHandlers("before_agent_start") ? takeBeforeRequestEffects : undefined,
		options.sessionManager ?? sessionManager,
		(message) => options.onExtensionError({ extensionPath: "durable:boundary", event: "turn_end", error: message }),
		turnCounter,
	);
	const toolHooks = createToolHooks(runner, calls);
	const compactionHooks = createCompactionHooks(
		runner,
		calls,
		(message) =>
			options.onExtensionError({
				extensionPath: "durable:compaction",
				event: "session_before_compact",
				error: message,
			}),
		options.agentModel,
	);
	// A tool call runs in its own call scope, so `ctx.signal` and `ctx.model` inside a tool belong to that call.
	const bridge: ToolBridge = {
		run: <T>(signal: AbortSignal | undefined, execute: (context: ExtensionToolContext) => Promise<T>) =>
			inProviderCall(calls, undefined, signal, () => execute(toolContext())),
	};
	// `ctx.executeTool` and `ctx.tools` belong to codemode (batch 2b). Until then a tool that calls them fails visibly.
	// The active set, as legacy keeps it: a tool enters it on first registration when it is active by default, and
	// `setActiveTools()` replaces it. A tool that is not active is deferred here.
	const activeTools = new Set<string>();
	const seenTools = new Set<string>();
	function toolContext(): ExtensionToolContext {
		return Object.assign(runner.createContext(), {
			tools: [],
			executeTool: async () => unavailable("ctx.executeTool"),
		});
	}
	// The durable codemode sandbox: created on first activation, closed with the session.
	let codemodeSandbox: CodemodeSandbox | undefined;
	/** The runner's tools as `getAllTools()` reports them, then the native tools that no runner tool shadows. */
	function toolInfos(): ToolInfo[] {
		const registered = runner.getAllRegisteredTools();
		const names = new Set(registered.map(({ definition }) => definition.name));
		return [
			...registered.map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				reachesTools: definition.reachesTools,
				exposure: definition.exposure ?? "direct",
				namespace: definition.namespace,
				annotations: definition.annotations,
				sourceInfo,
			})),
			...NATIVE_TOOL_INFOS.filter((info) => !names.has(info.name)),
		];
	}
	function inlineBudget(): number | undefined {
		const budget = options.services.settingsManager.getSettings().codemode?.inlineBudget;
		return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
	}
	/**
	 * Installs the native tools for their active state. An inactive one is replaced by an empty extension of its name, so
	 * the model is not offered it and the registry holds nothing of it.
	 */
	function syncNative(): void {
		const namespaces = codemodeNamespaces(
			runner
				.getAllRegisteredTools()
				.flatMap(({ definition }) => (definition.namespace === undefined ? [] : [definition.namespace])),
		);
		if (activeTools.has(CODEMODE_TOOL_NAME)) {
			codemodeSandbox ??= createCodemodeSandbox();
			options.installTools(codemodeExtension(codemodeSandbox, namespaces, inlineBudget()));
		} else {
			options.installTools(inactiveExtension(CODEMODE_EXTENSION_NAME));
		}
		options.installTools(
			activeTools.has(TOOL_SEARCH_TOOL_NAME) ? toolSearchExtension() : inactiveExtension(TOOL_SEARCH_EXTENSION_NAME),
		);
	}

	/** Installs the runner's current tools; the registry replaces the earlier set of this extension by name. */
	function syncTools(): void {
		const tools: BridgedTool[] = [];
		for (const { definition } of runner.getAllRegisteredTools()) {
			if (!seenTools.has(definition.name)) {
				seenTools.add(definition.name);
				if (isActiveByDefault(definition)) activeTools.add(definition.name);
			}
			const registration = toDurableTool(definition, bridge, activeTools.has(definition.name));
			if (registration !== undefined) tools.push({ definition, registration });
		}
		options.installTools(toolsExtension(tools));
		syncNative();
	}
	runner.onError(options.onExtensionError);

	return {
		runner,
		providerHooks,
		toolHooks,
		adapter: createHookAdapter(providerHooks, toolHooks, compactionHooks),
		get runEvents() {
			return runner.hasHandlers("agent_start") || runner.hasHandlers("turn_start");
		},
		agentEvents: async (events) => {
			for (const event of events) {
				if (event.type === "run_start") {
					streamedTurns = 0;
					if (runner.hasHandlers("agent_start")) await runner.emit({ type: "agent_start" });
				} else if (event.type === "turn_end") {
					streamedTurns += 1;
				} else if (event.type === "turn_start") {
					if (!runner.hasHandlers("turn_start")) continue;
					await runner.emit({ type: "turn_start", turnIndex: streamedTurns, timestamp: Date.now() });
				}
			}
		},
		input: async (content, options) => {
			if (!runner.hasHandlers("input")) return content;
			const images = Array.isArray(content)
				? content.filter((part): part is ImageContent => part.type === "image")
				: undefined;
			const text =
				typeof content === "string"
					? content
					: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const result = await runner.emitInput(
				text,
				images,
				options.source ?? "interactive",
				options.streamingBehavior,
			);
			if (result.action === "handled") return undefined;
			if (result.action !== "transform") return content;
			const nextImages = result.images === undefined || result.images.length === 0 ? undefined : result.images;
			return nextImages === undefined ? result.text : [{ type: "text", text: result.text }, ...nextImages];
		},
		beforeFork: async (entryId, position) => {
			const result = await runner.emit({ type: "session_before_fork", entryId, position });
			return { cancelled: result?.cancel === true };
		},
		beforeSwitch: async (targetSessionFile) => {
			const result = await runner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile });
			return { cancelled: result?.cancel === true };
		},
		start: (event) =>
			runner.emit(event).then(() => {
				syncTools();
			}),
		settled: async (aborted, messages) => {
			// Cleared before the handlers, because they may wait: a new prompt can start while a settled handler is parked,
			// and its `before_agent_start` effects must not queue behind this run's already applied ones.
			activeBeforeRequestEffects = undefined;
			activeEffectsHandedOut = false;
			await runner.emit({ type: "agent_end", messages: [...messages] });
			await runner.emit({ type: "agent_settled", aborted });
		},
		shutdown: (reason) =>
			runner.emit({ type: "session_shutdown", reason }).then(async () => {
				await codemodeSandbox?.close();
			}),
		retire: async () => {
			// The extensions are shared with the next open; only this runner was bound to the session that closed.
			runner.retire();
			// `shutdown` already closed the sandbox. Retiring a host that never shut down must not keep a worker alive either.
			await codemodeSandbox?.close();
			codemodeSandbox = undefined;
		},
		beforePrompt: async (content) => {
			turnCounter.value = 0;
			const images = Array.isArray(content)
				? content.filter((block): block is ImageContent => block.type === "image")
				: [];
			const prompt =
				typeof content === "string"
					? content
					: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const result = await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt, ...(images.length === 0 ? {} : { images }) },
				{ cwd: options.cwd },
			);
			const messages: UserMessage[] = result.messages.map((message) => ({
				role: "user",
				content: message.content,
				timestamp: Date.now(),
			}));
			const effects: BeforeRequestEffects = {
				systemPrompt: result.systemPrompt,
				messages,
				messagesApplied: false,
			};
			if (activeBeforeRequestEffects === undefined) activeBeforeRequestEffects = effects;
			else queuedBeforeRequestEffects.push(effects);
		},
		modelSelected: (model, previousModel, source) =>
			runner.emit({ type: "model_select", model, previousModel, source }).then(() => undefined),
		thinkingSelected: (level, previousLevel) =>
			runner.emit({ type: "thinking_level_select", level, previousLevel }).then(() => undefined),
	};
}
