import { join } from "node:path";
import type { AgentMessage } from "@ny4n/agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@ny4n/ai";
import type { AttachedReplicatedState } from "@ny4n/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@ny4n/chord/context";
import {
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryId,
	type EntryRecord,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
	type Submission,
	type TaskGraph,
	UsageDoc,
	type UserInput,
	watchEvents,
} from "@ny4n/durable";
import { openNodeSqliteStorage } from "@ny4n/durable/storage/sqlite/node";
import { getAgentDir } from "../../config.ts";
import type { Theme } from "../../ui/theme/theme.ts";
import type { AgentSessionRuntimeDiagnostic } from "../agent-session-services.ts";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import type {
	ExtensionError,
	ExtensionMode,
	InlineExtension,
	InputSource,
	ProjectTrustContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../extensions/types.ts";
import { type BashExecutionMessage, bashExecutionToText } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "../prompt-templates.ts";
import type { ReadonlySessionManager, SessionEntry, SessionTreeNode } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import type { BashOperations } from "../tools/bash.ts";
import { addWarmUsage, DurableCacheWarmer } from "./cache-warmer.ts";
import { createExtensionHost, type ExtensionHost } from "./extension-host.ts";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	ExecutionEnvs,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { createDurableModelRuntime } from "./model-runtime-adapter.ts";
import { createDurableServices, type DurableResourceOptions, type DurableServices } from "./services.ts";
import { createDurableSessionOps, type DurableSessionOps, type ForkOutcome } from "./session-ops.ts";
import { openSessionDirectory, selectSession } from "./sessions.ts";
import { DurableStartupError } from "./startup-error.ts";
import { Subagent } from "./subagent.ts";

const context = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	/** The first user message, for a subagent its task. */
	readonly title?: string;
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	/** The conversation shown and talked to. */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** The live task graph while the task panel is open. */
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the TUI may ask for. */
export interface DurableController {
	/** Prompt when idle; otherwise steer or queue a follow-up. */
	submit(text: string, whenBusy: "steer" | "followUp", options?: SubmitInputOptions): Promise<void>;
	/** Admit one headless input and wait for its durable terminal settlement. */
	submitAndWait(
		content: UserInput,
		whenBusy: "steer" | "followUp",
		options?: SubmitInputOptions,
	): Promise<SubmitOutcome>;
	compact(instructions: string | undefined): Promise<void>;
	setThinking(level: ModelThinkingLevel): Promise<void>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setAutoRetry(enabled: boolean): Promise<void>;
	/**
	 * Runs a bash command and records its result. `operations` replaces the local execution, as an extension's
	 * `user_bash` operations do.
	 */
	executeBash(
		command: string,
		excludeFromContext: boolean,
		onChunk?: (chunk: string) => void,
		operations?: BashOperations,
	): Promise<BashResult>;
	/** Records a bash result an extension ran itself, as legacy `recordBashResult` does. */
	recordBashResult(command: string, result: BashResult, excludeFromContext: boolean): Promise<void>;
	abortBash(): void;
	getAutoCompaction(): boolean;
	getAutoRetry(): boolean;
	getQueueModes(): { readonly steeringMode: "all" | "one-at-a-time"; readonly followUpMode: "all" | "one-at-a-time" };
	abort(): Promise<void>;
	/** Stop waiting to retry the model request, as legacy `abort_retry`: the run ends with the error it failed on. */
	abortRetry(): Promise<void>;
	cycleThinking(): Promise<void>;
	/**
	 * Choose the model. `source` is what the `model_select` event reports: a picker or command sets it, and the model
	 * cycle reports `cycle`, as legacy distinguishes the two.
	 */
	setModel(model: ModelRef, source?: "set" | "cycle"): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. */
	switchConversation(id: ConversationId): Promise<void>;
}

/** Where a submitted input came from, as the `input` handlers see it. */
export interface SubmitInputOptions {
	readonly source?: InputSource;
}

/**
 * What became of one submitted input. `handled` means an `input` handler took it, so nothing was submitted and there is
 * no settlement to wait for.
 */
export type SubmitOutcome =
	| { readonly handled: true }
	| { readonly handled: false; readonly settled: SettledSubmissionRecord };

export interface DurableModelSelection {
	readonly provider?: string;
	readonly modelId: string;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
	/** Open this exact existing durable session directory instead of selecting by cwd. */
	readonly sessionDirectory?: string;
	/** Override the lifecycle event emitted after opening a session. */
	readonly sessionStartEvent?: SessionStartEvent;
	/**
	 * Leave the session's `session_start` to the caller: it must call `startSession()` on the result. A caller that
	 * replaces another session defers the start until the one being left has shut down, so an extension never sees a new
	 * session's start followed by the old session's shutdown.
	 */
	readonly deferSessionStart?: boolean;
	/** Attach the durable event stream for a headless adapter. */
	readonly eventStream?: boolean;
	readonly model?: DurableModelSelection;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly apiKey?: string;
	/** The resource flags of the command line, read by the resource loader. */
	readonly resources?: DurableResourceOptions;
	readonly extensionFactories?: readonly InlineExtension[];
	readonly extensionFlagValues?: Map<string, boolean | string>;
	/**
	 * Services of an earlier open in this process. Extensions are loaded once per process, so a reopen (RPC `new_session`)
	 * passes the services it got from the first open.
	 */
	readonly services?: DurableServices;
	/** Asks about project trust. Without it, undecided trust stays untrusted and nothing is asked. */
	readonly projectTrustContext?: ProjectTrustContext;
	/**
	 * Receives each warning when the session is not interactive. Interactive sessions show warnings as notices instead.
	 */
	readonly onDiagnostic?: (diagnostic: AgentSessionRuntimeDiagnostic) => void;
	/**
	 * Settings applied over the loaded ones before the session opens, as the legacy path applies `--use-theme` to its startup
	 * manager. The interactive TUI reads the theme from the same manager, so the override reaches it.
	 */
	readonly settingsOverrides?: Partial<Settings>;
}

/** Trust is never asked for, and undecided project trust stays untrusted. */
function headlessTrustContext(cwd: string): ProjectTrustContext {
	const mode: ExtensionMode = "print";
	return {
		cwd,
		mode,
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	readonly modelRuntime: ModelRuntime;
	readonly events?: AgentEventStream;
	/** nyan's settings, for the TUI's theme and terminal capabilities. */
	readonly settings: SettingsManager;
	readonly themes: readonly Theme[];
	readonly promptTemplates: readonly PromptTemplate[];
	/** The extension host for this open; modes bind their UI context before accepting input. */
	readonly extensionHost: ExtensionHost;
	/** The services this open used; pass them to a later open in the same process. */
	readonly services: DurableServices;
	/** Present when `deferSessionStart` was set: emit this session's `session_start`, once, now. */
	readonly startSession?: () => Promise<void>;
	/** Session-wide product operations: queue clearing, entries, export, and the display name. */
	readonly sessionOps: DurableSessionOps;
	/**
	 * Events of another conversation, for an adapter whose controller moved to one (RPC `fork` and `clone`). The caller
	 * stops the stream it replaces, and the returned one when it is done. Requires `eventStream`.
	 */
	readonly eventsOf: (conversationId: ConversationId) => Promise<AgentEventStream>;
	/**
	 * Calls `listener` with every extension handler failure, which the RPC adapter publishes as `extension_error`. The
	 * notice is shown as well. Returns the unsubscribe.
	 */
	onExtensionError(listener: (error: ExtensionError) => void): () => void;
	/** Ends the session: `session_shutdown` with `reason` (default "quit"), then the storage is closed. */
	close(reason?: SessionShutdownEvent["reason"]): Promise<void>;
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["nyan.agent"] ?? {}) as AgentState;
}

/** A subagent's task: the oldest user message of its conversation. The main conversation needs no title. */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, context))!;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "nyan.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
}

/** The text of a user entry, as a one-line title. */
function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location =
		options.sessionDirectory === undefined
			? await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false)
			: await openSessionDirectory(options.sessionDirectory);
	const envs = new ExecutionEnvs(location.cwd);
	let harness: Harness | undefined;
	try {
		// Only the first open of a process creates services, so its diagnostics and errors are reported once.
		const fresh = options.services === undefined;
		const services =
			options.services ??
			(await createDurableServices({
				cwd: location.cwd,
				agentDir: getAgentDir(),
				resources: options.resources ?? {},
				extensionFactories: options.extensionFactories ?? [],
				extensionFlagValues: options.extensionFlagValues,
				projectTrustContext: options.projectTrustContext ?? headlessTrustContext(location.cwd),
			}));
		if (fresh) {
			const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (errors.length > 0) throw new DurableStartupError(errors);
		}
		if (options.settingsOverrides !== undefined) services.settingsManager.applyOverrides(options.settingsOverrides);
		const { modelRuntime, settingsManager } = services;
		// Cache warming starts from the request durable's generation task actually sends, so the refresh reuses that
		// request's model, messages, thinking level, provider session, and request transforms.
		let cacheWarmer: DurableCacheWarmer | undefined;
		/** The transcript and model the warm run stands on, recorded when its request was sent. */
		let warmBasis: { conversationId: ConversationId; entryIds: EntryId[] } | undefined;
		const durableModelRuntime = createDurableModelRuntime(modelRuntime, {
			onSessionRequest: (model, context, options) => {
				warmBasis = { conversationId: current.id, entryIds: currentView?.entries.map((entry) => entry.id) ?? [] };
				cacheWarmer?.start({ model, context, options: options ?? {} });
			},
		});
		configureHarnessHttp(settingsManager);
		const queueModes: {
			steeringMode?: "all" | "one-at-a-time";
			followUpMode?: "all" | "one-at-a-time";
			compactionEnabled?: boolean;
			retryEnabled?: boolean;
		} = {};
		const settings = createHarnessSettings(settingsManager, queueModes);
		const registry = createCodingRegistry(settingsManager, location.cwd, services.resourceLoader);
		registry.install(Subagent);
		// Installed before the Harness opens: its members are read when the Harness starts a request.
		// Runs in flight: `ctx.isIdle()` answers false while one is.
		let activeRuns = 0;
		// The conversation a fork created, until the controller moves to it and its `session_start` is emitted.
		let forkConversation: ConversationId | undefined;
		let currentView: ConversationView | undefined;
		let currentState: DurableView | undefined;
		let state!: DurableView;
		const legacyEntries = (): SessionEntry[] => {
			const result: SessionEntry[] = [];
			let parentId: string | null = null;
			for (const entry of currentView?.entries ?? []) {
				const messages = entry.model ?? [];
				if (messages.length === 0) {
					const id = String(entry.id);
					result.push({
						type: "custom",
						id,
						parentId,
						timestamp: new Date(0).toISOString(),
						customType: entry.kind,
						...(entry.data === undefined ? {} : { data: entry.data }),
					});
					parentId = id;
					continue;
				}
				for (const message of messages) {
					// Durable entry ids are exposed to extension boundary events so proposals can be validated and mapped back
					// without inventing a second identity. Durable model entries are one message each in the active view.
					const id = String(entry.id);
					result.push({
						type: "message",
						id,
						parentId,
						timestamp: new Date(0).toISOString(),
						message,
					});
					parentId = id;
				}
			}
			return result;
		};
		const sessionManager: ReadonlySessionManager = {
			getCwd: () => location.cwd,
			getSessionDir: () => location.directory,
			getSessionId: () => location.id,
			getSessionFile: () => join(location.directory, "session.sqlite"),
			getLeafId: () => legacyEntries().at(-1)?.id ?? null,
			getLeafEntry: () => legacyEntries().at(-1),
			getEntry: (id) => legacyEntries().find((entry) => entry.id === id),
			getLabel: () => undefined,
			getBranch: () => legacyEntries(),
			buildContextEntries: () => legacyEntries(),
			buildSessionProjection: () => {
				const entries = legacyEntries();
				return {
					entries: entries.map((entry) => ({
						sourceEntry: entry,
						messages: entry.type === "message" ? [entry.message] : [],
					})),
					messages: entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
					thinkingLevel:
						currentState === undefined ? "off" : (agentOf(currentState.conversation).thinkingLevel ?? "off"),
					model: currentState === undefined ? null : (agentOf(currentState.conversation).model ?? null),
				};
			},
			getHeader: () => null,
			getEntries: () => legacyEntries(),
			getTree: () => {
				const entries = legacyEntries();
				const nodes: SessionTreeNode[] = [];
				for (const entry of entries) nodes.push({ entry, children: [] });
				for (let index = 1; index < nodes.length; index++) nodes[index - 1]!.children.push(nodes[index]!);
				return nodes.length === 0 ? [] : [nodes[0]!];
			},
			getSessionName: () => undefined,
		};
		// Extension failures reach the RPC adapter as `extension_error` as well as the view's notices.
		const extensionErrorListeners = new Set<(error: ExtensionError) => void>();
		const host: ExtensionHost = createExtensionHost({
			sessionManager,
			services,
			cwd: location.cwd,
			mode: options.projectTrustContext?.mode ?? "print",
			agentModel: () => {
				const ref = agentOf(state.conversation).model;
				return ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			},
			abort: () => void controller.abort(),
			compact: () => void controller.compact(undefined).catch(fail),
			onExtensionError: (error) => {
				notice("error", `Extension ${error.extensionPath} failed on ${error.event}: ${error.error}`);
				for (const listener of extensionErrorListeners) listener(error);
			},
			installTools: (extension) => registry.install(extension),
			isIdle: () => activeRuns === 0,
		});
		registry.install(host.adapter);

		cacheWarmer = new DurableCacheWarmer({
			models: modelRuntime,
			getMode: () => settingsManager.getCacheWarmingMode(),
			decide: (event) => host.runner.emitCacheWarmingDecision(event),
			promptTokens: () => {
				const messages = (currentView?.entries ?? []).flatMap((entry) => entry.model ?? []);
				for (let index = messages.length - 1; index >= 0; index--) {
					const message = messages[index]!;
					if (message.role !== "assistant") continue;
					return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
				}
				return 0;
			},
			isCurrent: (request) => {
				const basis = warmBasis;
				if (basis === undefined || basis.conversationId !== current.id) return false;
				const ref = agentOf(state.conversation).model;
				if (ref === undefined || ref.provider !== request.model.provider || ref.modelId !== request.model.id) {
					return false;
				}
				// Entry ids are durable's stable identity: an appended entry keeps the request's prefix, a compaction or a
				// branch change does not.
				const entries = currentView?.entries ?? [];
				return basis.entryIds.every((id, index) => entries[index]?.id === id);
			},
			recordUsage: async (model, usage) => {
				const conversationId = current.id;
				try {
					await opened.commit(async (tx) => {
						const problem = addWarmUsage(
							(await tx.doc(UsageDoc, conversationId)).models,
							`${model.provider}/${model.id}`,
							usage,
						);
						if (problem !== undefined) {
							report(new Error(`A cache refresh's usage was not recorded: ${problem}`));
						}
					}, context);
				} catch (error) {
					report(new Error("A cache refresh completed but its usage could not be recorded", { cause: error }));
				}
			},
			report: (message) => notice("warning", message),
		});

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: durableModelRuntime,
				registry,
				settings,
				env: envs.env,
				onReport: (error) => report(error),
			},
			context,
		);
		const initial =
			options.model === undefined && location.created
				? await findInitialAgentModel(settingsManager, modelRuntime)
				: options.model === undefined
					? undefined
					: await findInitialAgentModel(settingsManager, modelRuntime, {
							provider: options.model.provider,
							model: options.model.modelId,
						});
		const initialThinking = options.thinkingLevel ?? initial?.thinkingLevel;
		const root = await harness.root(context, {
			agent: {
				cwd: location.cwd,
				...(location.created && initial?.model === undefined ? {} : { model: initial?.model }),
				...(location.created && initialThinking === undefined ? {} : { thinkingLevel: initialThinking }),
			},
		});
		if (!location.created && (initial?.model !== undefined || initialThinking !== undefined)) {
			await root.configure(
				{
					...(initial?.model === undefined ? {} : { model: initial.model }),
					...(initialThinking === undefined ? {} : { thinkingLevel: initialThinking }),
				},
				context,
			);
		}
		const configuredAgent = await root.agent(context);
		const apiKeyModel = initial?.model ?? configuredAgent.model;
		if (options.apiKey !== undefined) {
			if (apiKeyModel === undefined) {
				throw new DurableStartupError([{ type: "error", message: "--api-key requires a selected model" }]);
			}
			await modelRuntime.setRuntimeApiKey(apiKeyModel.provider, options.apiKey);
		}
		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);
		const events = options.eventStream === true ? await watchEvents(opened, root.id, context) : undefined;
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
		const models = (): ModelSummary[] =>
			modelRuntime.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			}));

		state = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		// Commit listeners and Chord frames call this on the Session line; rendering runs afterwards, once per burst.
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			currentState = state;
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		for (const diagnostic of fresh ? services.diagnostics : []) {
			if (diagnostic.type === "error") continue;
			if (options.onDiagnostic !== undefined) options.onDiagnostic(diagnostic);
			else notice(diagnostic.type === "info" ? "info" : "warning", diagnostic.message);
		}
		currentView = conversation.value;
		// The read-only session facade reads the conversation the controller talks to, so every view of one follows the move.
		const followConversation = (value: ConversationView): void => {
			currentView = value;
			update({ conversation: value });
		};
		let unsubscribe = conversation.subscribe(followConversation);
		// Subagents appear as their conversations are created. A commit listener only records; it calls no Session API.
		const unsubscribeCommits = harness.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
				} else if (change.type === "entry" && change.value.kind === "nyan.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		let queue = Promise.resolve();
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const isAborted = (settled: SettledSubmissionRecord): boolean =>
			settled.status === "unanswered" && settled.reason === "aborted";
		// `agent_settled` follows every run that ends, whatever its outcome: the quota poll and usage summary wait for it.
		const settle = (submission: Submission): Promise<SettledSubmissionRecord> => {
			const startingMessageCount = state.conversation.entries.reduce(
				(count, entry) => count + (entry.model?.length ?? 0),
				0,
			);
			activeRuns += 1;
			return submission
				.wait(context)
				.then(async (settled) => {
					activeRuns -= 1;
					const messages = state.conversation.entries
						.flatMap((entry) => (entry.model ?? []) as AgentMessage[])
						.slice(startingMessageCount);
					// `streaming` warming ends with the run it belongs to; `idle` warming continues under its own horizon.
					cacheWarmer?.onAgentSettled();
					await host.settled(isAborted(settled), messages);
					return settled;
				})
				.catch((error: unknown) => {
					activeRuns -= 1;
					throw error;
				});
		};
		const watchAnswer = (submission: Submission): void => {
			void settle(submission).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined)
				throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		/** Legacy's skill and prompt-template expansion, applied to the text of an input. */
		const expandInput = (content: UserInput): UserInput => {
			const prompts = services.resourceLoader.getPrompts().prompts;
			return typeof content === "string"
				? expandPromptTemplate(content, prompts)
				: content.map((part) =>
						part.type === "text" ? { ...part, text: expandPromptTemplate(part.text, prompts) } : part,
					);
		};
		const isStreaming = (): boolean => {
			const live = state.conversation.docs["nyan.live"] as
				| { readonly run?: unknown; readonly generation?: unknown }
				| undefined;
			return live?.run !== undefined || live?.generation !== undefined;
		};
		/**
		 * Legacy's input pipeline, in its order: the `input` handlers first, then skill and prompt-template expansion.
		 * Undefined when a handler took the input, so the submission does not happen.
		 */
		const prepareInput = async (
			content: UserInput,
			whenBusy: "steer" | "followUp",
			options: SubmitInputOptions | undefined,
		): Promise<UserInput | undefined> => {
			const transformed = await host.input(content, {
				...(options?.source === undefined ? {} : { source: options.source }),
				...(isStreaming() ? { streamingBehavior: whenBusy } : {}),
			});
			return transformed === undefined ? undefined : expandInput(transformed);
		};
		// `agent_start` and `turn_start` reach extensions only through the committed stream, which the built-in `herdr` and
		// `mcp` integrations read. One watch follows the conversation the controller talks to, so a fork or a switch moves it.
		let runEvents: AgentEventStream | undefined;
		const watchRunEvents = async (conversationId: ConversationId): Promise<void> => {
			const previous = runEvents;
			runEvents = undefined;
			if (previous !== undefined) await previous.stop();
			if (!host.runEvents) return;
			const stream = await watchEvents(opened, conversationId, context);
			runEvents = stream;
			stream.start((events) => host.agentEvents(events));
		};
		const bashAbortControllers = new Set<AbortController>();
		/**
		 * Write a finished bash run as a `bashExecution` entry: its data always, its output for the model unless it is
		 * excluded. `conversationId` is the one the command started in, so a switch meanwhile cannot take the record.
		 */
		const recordBashResult = async (
			conversationId: ConversationId,
			command: string,
			result: BashResult,
			excludeFromContext: boolean,
		): Promise<void> => {
			const timestamp = Date.now();
			const message: BashExecutionMessage = {
				role: "bashExecution",
				command,
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
				timestamp,
				excludeFromContext,
			};
			try {
				await opened.commit(
					(tx) =>
						tx.appendEntry(conversationId, {
							kind: "bashExecution",
							data: {
								command,
								output: result.output,
								exitCode: result.exitCode ?? null,
								cancelled: result.cancelled,
								truncated: result.truncated,
								excludeFromContext,
								...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
							},
							...(excludeFromContext
								? {}
								: {
										model: [
											{
												role: "user" as const,
												content: bashExecutionToText(message),
												timestamp,
											},
										],
									}),
						}),
					context,
				);
			} catch (error) {
				throw new Error("Bash completed but its result could not be recorded", { cause: error });
			}
		};
		const executeBash = async (
			command: string,
			excludeFromContext: boolean,
			onChunk?: (chunk: string) => void,
			customOperations?: BashOperations,
		): Promise<BashResult> => {
			const abortController = new AbortController();
			bashAbortControllers.add(abortController);
			const conversationId = current.id;
			const cwd = state.session.cwd;
			try {
				const environment = envs.env({ conversationId, cwd, read: opened });
				const operations: BashOperations = {
					exec: async (shellCommand, shellCwd, options) => {
						const result = await environment.exec(
							shellCommand,
							{
								cwd: shellCwd,
								onOutput: (text) => options.onData(Buffer.from(text)),
							},
							withAbortSignal(options.signal ?? abortController.signal, context),
						);
						if (!result.ok) throw result.error;
						return { exitCode: result.value.exitCode };
					},
				};
				const result = await executeBashWithOperations(command, cwd, customOperations ?? operations, {
					signal: abortController.signal,
					onChunk,
				});
				await recordBashResult(conversationId, command, result, excludeFromContext);
				return result;
			} finally {
				bashAbortControllers.delete(abortController);
			}
		};
		const controller: DurableController = {
			submit: async (text, whenBusy, options) => {
				await command(async () => {
					const prepared = await prepareInput(text, whenBusy, options);
					if (prepared === undefined) return;
					await host.beforePrompt(prepared);
					watchAnswer(await current.submit({ type: "input", content: prepared, whenBusy }, context));
				});
			},
			submitAndWait: async (content, whenBusy, options) => {
				const prepared = await prepareInput(content, whenBusy, options);
				if (prepared === undefined) return { handled: true };
				await host.beforePrompt(prepared);
				const submission = await current.submit({ type: "input", content: prepared, whenBusy }, context);
				return { handled: false, settled: await settle(submission) };
			},
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					// Report the outcome once it is known; the status line shows the compaction meanwhile.
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							// A summary written while busy is a submission: placed now, queued, or dropped as stale.
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else
							notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			setThinking: (level) =>
				command(async () => {
					const previousLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ thinkingLevel: level }, context);
					await host.thinkingSelected(level, previousLevel);
				}),
			setSteeringMode: (mode) =>
				command(async () => {
					queueModes.steeringMode = mode;
				}),
			setFollowUpMode: (mode) =>
				command(async () => {
					queueModes.followUpMode = mode;
				}),
			setAutoCompaction: (enabled) =>
				command(async () => {
					queueModes.compactionEnabled = enabled;
				}),
			setAutoRetry: (enabled) =>
				command(async () => {
					queueModes.retryEnabled = enabled;
				}),
			executeBash,
			recordBashResult: (command, result, excludeFromContext) =>
				recordBashResult(current.id, command, result, excludeFromContext),
			abortBash: () => {
				for (const abortController of bashAbortControllers) abortController.abort();
			},
			getAutoCompaction: () => queueModes.compactionEnabled ?? settingsManager.getCompactionSettings().enabled,
			getAutoRetry: () => queueModes.retryEnabled ?? settingsManager.getRetrySettings().enabled,
			getQueueModes: () => ({
				steeringMode: queueModes.steeringMode ?? settingsManager.getSteeringMode(),
				followUpMode: queueModes.followUpMode ?? settingsManager.getFollowUpMode(),
			}),
			// Not queued: it waits until the conversation is idle.
			abort: () => current.abort(context).catch(fail),
			// Not queued either: it ends the wait of a retry that is already running.
			abortRetry: async () => {
				await current.stopRetry().catch(fail);
			},
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
					await host.thinkingSelected(next, level);
				}),
			setModel: (ref, source) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const previousRef = agentOf(state.conversation).model;
					const previousModel =
						previousRef === undefined
							? undefined
							: modelRuntime.getModel(previousRef.provider, previousRef.modelId);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					cacheWarmer?.cancel("model changed");
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
					await host.modelSelected(model, previousModel, source ?? "set");
				}),
			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
				}),
			switchConversation: (id) =>
				command(async () => {
					// The forked conversation's transcript is not the warmed request's prefix.
					cacheWarmer?.cancel("conversation switched");
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe(followConversation);
					await watchRunEvents(next.id);
					// The fork's `session_start` follows the move, so an extension that rebuilds state sees the new conversation.
					const forked = forkConversation === id;
					forkConversation = undefined;
					if (forked) {
						// A durable fork keeps this session's file; only the conversation it makes changes.
						await host.start({
							type: "session_start",
							reason: "fork",
							previousSessionFile: join(state.session.directory, "session.sqlite"),
						});
					}
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		// The task panel starts open; /tasks hides it.
		await controller.toggleTasks();
		const sessionStartEvent = options.sessionStartEvent ?? {
			type: "session_start" as const,
			reason: location.created ? "startup" : "resume",
		};
		if (options.deferSessionStart !== true) await host.start(sessionStartEvent);
		await watchRunEvents(root.id);
		// Recovered work from an interrupted turn continues now.
		harness.resume();

		// A fork keeps this session's file, so its `session_start` reports the same file as the session it came from; the
		// conversation the controller moves to is what differs (Decision #24, Decision #31).
		const recordFork = (outcome: ForkOutcome): ForkOutcome => {
			forkConversation = outcome.cancelled ? undefined : outcome.conversationId;
			return outcome;
		};
		const productOps = createDurableSessionOps({
			harness: opened,
			conversation: () => current,
			session: () => state.session,
			context,
			forkLifecycle: {
				beforeFork: (entryId, position) => host.beforeFork(entryId, position),
				shutdown: (reason) => host.shutdown(reason),
			},
		});
		const sessionOps: DurableSessionOps = {
			...productOps,
			fork: async (at) => recordFork(await productOps.fork(at)),
			clone: async () => recordFork(await productOps.clone()),
		};

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			modelRuntime,
			...(events === undefined ? {} : { events }),
			settings: settingsManager,
			themes: services.resourceLoader.getThemes().themes,
			promptTemplates: services.resourceLoader.getPrompts().prompts,
			extensionHost: host,
			services,
			sessionOps,
			...(options.deferSessionStart === true
				? {
						startSession: async () => {
							await host.start(sessionStartEvent);
						},
					}
				: {}),
			eventsOf: async (conversationId) => {
				if (options.eventStream !== true) throw new Error("This open has no event stream");
				return watchEvents(opened, conversationId, context);
			},
			onExtensionError: (listener) => {
				extensionErrorListeners.add(listener);
				return () => extensionErrorListeners.delete(listener);
			},
			close(reason = "quit") {
				closing ??= (async () => {
					// No timer and no request survive a closed session.
					cacheWarmer?.cancel("session closed");
					unsubscribe();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						await host.shutdown(reason);
						await runEvents?.stop();
						await events?.stop();
						// Close writes no outcome: a running turn resumes with --continue.
						await opened.close(context);
						await envs.cleanup(context);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}
