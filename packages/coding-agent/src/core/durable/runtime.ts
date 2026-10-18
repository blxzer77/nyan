import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@ny4n/ai";
import type { AttachedReplicatedState } from "@ny4n/chord";
import { BACKGROUND_CONTEXT } from "@ny4n/chord/context";
import {
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
	type Submission,
	type TaskGraph,
	type UserInput,
	watchEvents,
} from "@ny4n/durable";
import { openNodeSqliteStorage } from "@ny4n/durable/storage/sqlite/node";
import { getAgentDir } from "../../config.ts";
import type { AgentSessionRuntimeDiagnostic } from "../agent-session-services.ts";
import type { ExtensionMode, InlineExtension, ProjectTrustContext, SessionShutdownEvent } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
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
import { selectSession } from "./sessions.ts";
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
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	/** Admit one headless input and wait for its durable terminal settlement. */
	submitAndWait(content: UserInput, whenBusy: "steer" | "followUp"): Promise<SettledSubmissionRecord>;
	compact(instructions: string | undefined): Promise<void>;
	setThinking(level: ModelThinkingLevel): Promise<void>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setAutoRetry(enabled: boolean): Promise<void>;
	getAutoCompaction(): boolean;
	getAutoRetry(): boolean;
	getQueueModes(): { readonly steeringMode: "all" | "one-at-a-time"; readonly followUpMode: "all" | "one-at-a-time" };
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. */
	switchConversation(id: ConversationId): Promise<void>;
}

export interface DurableModelSelection {
	readonly provider?: string;
	readonly modelId: string;
}

/** Thrown when the durable path cannot start because an extension or a resource is broken; it lists each error. */
export class DurableStartupError extends Error {
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];

	constructor(diagnostics: readonly AgentSessionRuntimeDiagnostic[]) {
		super(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		this.name = "DurableStartupError";
		this.diagnostics = diagnostics;
	}
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
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
	/** The services this open used; pass them to a later open in the same process. */
	readonly services: DurableServices;
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
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false);
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
		const durableModelRuntime = createDurableModelRuntime(modelRuntime);
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
		const host: ExtensionHost = createExtensionHost({
			services,
			cwd: location.cwd,
			agentModel: () => {
				const ref = agentOf(state.conversation).model;
				return ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			},
			abort: () => void controller.abort(),
			compact: () => void controller.compact(undefined).catch(fail),
			onExtensionError: (error) =>
				notice("error", `Extension ${error.extensionPath} failed on ${error.event}: ${error.error}`),
			installTools: (extension) => registry.install(extension),
			isIdle: () => activeRuns === 0,
		});
		registry.install(host.adapter);

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
			if (apiKeyModel === undefined) throw new Error("--api-key requires a selected model");
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

		let state: DurableView = {
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
		let unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
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
			activeRuns += 1;
			return submission
				.wait(context)
				.then(async (settled) => {
					activeRuns -= 1;
					await host.settled(isAborted(settled));
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
		const controller: DurableController = {
			submit: (text, whenBusy) =>
				command(async () => {
					await host.beforePrompt(text);
					watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context));
				}),
			submitAndWait: async (content, whenBusy) => {
				await host.beforePrompt(content);
				const submission = await current.submit({ type: "input", content, whenBusy }, context);
				return settle(submission);
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
			setThinking: (level) => command(async () => current.configure({ thinkingLevel: level }, context)),
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
			getAutoCompaction: () => queueModes.compactionEnabled ?? settingsManager.getCompactionSettings().enabled,
			getAutoRetry: () => queueModes.retryEnabled ?? settingsManager.getRetrySettings().enabled,
			getQueueModes: () => ({
				steeringMode: queueModes.steeringMode ?? settingsManager.getSteeringMode(),
				followUpMode: queueModes.followUpMode ?? settingsManager.getFollowUpMode(),
			}),
			// Not queued: it waits until the conversation is idle.
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
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
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
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
		await host.start(location.created ? "startup" : "resume");
		// Recovered work from an interrupted turn continues now.
		harness.resume();

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
			services,
			close(reason = "quit") {
				closing ??= (async () => {
					unsubscribe();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						await host.shutdown(reason);
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
