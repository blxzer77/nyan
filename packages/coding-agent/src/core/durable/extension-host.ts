import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, ImageContent, Model } from "@ny4n/ai";
import type { Extension, GenerationHooks, ToolHooks, UserInput } from "@ny4n/durable";
import { ExtensionRunner } from "../extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionError,
	ExtensionToolContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../extensions/types.ts";
import { ModelRegistry } from "../model-registry.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import {
	createHookAdapter,
	createProviderHooks,
	createToolHooks,
	inProviderCall,
	type ProviderCall,
	type ProviderCallScope,
} from "./extension-adapter.ts";
import { type BridgedTool, type ToolBridge, toDurableTool, toolsExtension } from "./extension-tools.ts";
import type { DurableServices } from "./services.ts";

/** Thrown by a Nyan API the durable path does not connect yet. Handlers that call it fail visibly, not silently. */
function unavailable(api: string): never {
	throw new Error(`${api} is not connected on the durable path yet`);
}

export interface ExtensionHostOptions {
	/** Created once per process and shared by every open: extension instances and their state live here. */
	readonly services: DurableServices;
	readonly cwd: string;
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
}

/** One open's view of the loaded extensions: a runner bound to this open, and the hook adapter it feeds. */
export interface ExtensionHost {
	readonly runner: ExtensionRunner;
	/** The provider-call members, bound to this open's runner. Tests call them directly; the adapter carries them. */
	readonly providerHooks: Partial<GenerationHooks>;
	/** The tool-event members: `tool_call` (beforeTool) and `tool_result` (afterTool). */
	readonly toolHooks: Partial<ToolHooks>;
	/** Install in the registry; carries no members when no loaded extension handles a provider event. */
	readonly adapter: Extension;
	/**
	 * Runs `before_agent_start` for a prompt before it is submitted, so the servers a run lists are connected. MCP waits for
	 * its direct servers here, as legacy does, so the first request declares their tools. Only the wait is applied: the
	 * handlers' message and system-prompt changes are not, until the batch that connects `before_agent_start` fully.
	 */
	beforePrompt(content: UserInput): Promise<void>;
	start(reason: SessionStartEvent["reason"]): Promise<void>;
	shutdown(reason: SessionShutdownEvent["reason"]): Promise<void>;
}

/**
 * The durable path's ExtensionRunner. It is built per open, because it is bound to that open's controller, but the
 * extensions it runs are the ones `services` loaded, so a second open does not load them again.
 *
 * Connected: `session_start`, `session_shutdown`, `after_provider_response`, `provider_stream_event`,
 * `before_provider_request`, `before_provider_headers`, `message_end` (assistant), and the provider registrations.
 * Not connected: the session API, tools, commands, prompt-state actions, and UI. Each one throws when a handler calls it.
 * `isIdle` and `isProjectTrusted` are not tracked yet: `isIdle` answers true, `isProjectTrusted` answers false.
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

	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		options.cwd,
		sessionManager,
		new ModelRegistry(options.services.modelRuntime),
	);

	const actions: ExtensionActions = {
		sendMessage: () => unavailable("pi.sendMessage"),
		sendUserMessage: () => unavailable("pi.sendUserMessage"),
		appendEntry: () => unavailable("pi.appendEntry"),
		setSessionName: () => unavailable("pi.setSessionName"),
		getSessionName: () => unavailable("pi.getSessionName"),
		setLabel: () => unavailable("pi.setLabel"),
		getActiveTools: () => unavailable("pi.getActiveTools"),
		getAllTools: () => unavailable("pi.getAllTools"),
		getSettings: () => options.services.settingsManager.getSettings(),
		setActiveTools: () => unavailable("pi.setActiveTools"),
		refreshTools: () => syncTools(),
		// Slash commands have no entry point on the durable path yet; RPC `get_commands` also answers none.
		getCommands: () => [],
		setModel: () => unavailable("pi.setModel"),
		getThinkingLevel: () => unavailable("pi.getThinkingLevel"),
		setThinkingLevel: () => unavailable("pi.setThinkingLevel"),
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => calls.getStore()?.model ?? options.agentModel(),
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => false,
		getSignal: () => calls.getStore()?.signal,
		abort: () => options.abort(),
		hasPendingMessages: () => false,
		shutdown: () => unavailable("ctx.shutdown"),
		getContextUsage: () => undefined,
		compact: () => options.compact(),
		getSystemPrompt: () => unavailable("ctx.getSystemPrompt"),
	};

	runner.bindCore(actions, contextActions);
	const providerHooks = createProviderHooks(runner, calls);
	const toolHooks = createToolHooks(runner);
	// A tool call runs in its own call scope, so `ctx.signal` and `ctx.model` inside a tool belong to that call.
	const bridge: ToolBridge = {
		run: <T>(signal: AbortSignal | undefined, execute: (context: ExtensionToolContext) => Promise<T>) =>
			inProviderCall(calls, undefined, signal, () => execute(toolContext())),
	};
	// `ctx.executeTool` and `ctx.tools` belong to codemode (batch 2b). Until then a tool that calls them fails visibly.
	function toolContext(): ExtensionToolContext {
		return Object.assign(runner.createContext(), {
			tools: [],
			executeTool: async () => unavailable("ctx.executeTool"),
		});
	}
	/** Installs the runner's current tools; the registry replaces the earlier set of this extension by name. */
	function syncTools(): void {
		const tools: BridgedTool[] = [];
		for (const { definition } of runner.getAllRegisteredTools()) {
			const registration = toDurableTool(definition, bridge);
			if (registration !== undefined) tools.push({ definition, registration });
		}
		options.installTools(toolsExtension(tools));
	}
	runner.onError(options.onExtensionError);

	return {
		runner,
		providerHooks,
		toolHooks,
		adapter: createHookAdapter(providerHooks, toolHooks),
		start: (reason) =>
			runner.emit({ type: "session_start", reason }).then(() => {
				syncTools();
			}),
		shutdown: (reason) => runner.emit({ type: "session_shutdown", reason }).then(() => undefined),
		beforePrompt: async (content) => {
			const images = Array.isArray(content)
				? content.filter((block): block is ImageContent => block.type === "image")
				: [];
			const prompt =
				typeof content === "string"
					? content
					: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt, ...(images.length === 0 ? {} : { images }) },
				{ cwd: options.cwd },
			);
		},
	};
}
