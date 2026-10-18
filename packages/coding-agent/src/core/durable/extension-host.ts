import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Model } from "@ny4n/ai";
import type { Extension, GenerationHooks } from "@ny4n/durable";
import { ExtensionRunner } from "../extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionError,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../extensions/types.ts";
import { ModelRegistry } from "../model-registry.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import {
	createHookAdapter,
	createProviderHooks,
	type ProviderCall,
	type ProviderCallScope,
} from "./extension-adapter.ts";
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
}

/** One open's view of the loaded extensions: a runner bound to this open, and the hook adapter it feeds. */
export interface ExtensionHost {
	readonly runner: ExtensionRunner;
	/** The provider-call members, bound to this open's runner. Tests call them directly; the adapter carries them. */
	readonly providerHooks: Partial<GenerationHooks>;
	/** Install in the registry; carries no members when no loaded extension handles a provider event. */
	readonly adapter: Extension;
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
		refreshTools: () => unavailable("pi.refreshTools"),
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
	runner.onError(options.onExtensionError);

	return {
		runner,
		providerHooks,
		adapter: createHookAdapter(providerHooks),
		start: (reason) => runner.emit({ type: "session_start", reason }).then(() => undefined),
		shutdown: (reason) => runner.emit({ type: "session_shutdown", reason }).then(() => undefined),
	};
}
