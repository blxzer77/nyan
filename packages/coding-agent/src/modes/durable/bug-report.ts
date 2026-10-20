import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@ny4n/ai";
import type { SelectItem } from "@ny4n/tui";
import {
	assembleBugReport,
	BUG_REPORT_DISCLAIMER,
	BUG_REPORT_TRANSCRIPT_NOTE,
	type BugReportBundle,
	bugReportArchiveFileName,
	generateBugReportSummary,
	writeBugReportArchive,
} from "../../core/bug-report.ts";
import { readCrashLog } from "../../core/crash-log.ts";
import type { DurableController, DurableView } from "../../core/durable/runtime.ts";
import { agentOf } from "../../core/durable/runtime.ts";
import type { DurableSessionOps } from "../../core/durable/session-ops.ts";
import type { Extension } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { checkGistAuth, createGist } from "../../core/session-share.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

/**
 * `/share` and `/bug` on the durable TUI. The session-independent halves (the gist upload and the report archive) are in
 * `core/`; this module is the dialog glue and the durable session they run against. Both flows are here rather than in
 * the command layer so the command layer only dispatches them.
 */

/** What `/bug` reads from the process beside the session. Absent where an embedding owns no model runtime. */
export interface DurableBugReportEnvironment {
	readonly modelRuntime: ModelRuntime;
	readonly settings: SettingsManager;
	readonly extensions: readonly Extension[];
	readonly extensionErrors: ReadonlyArray<{ path: string; error: string }>;
}

/** The dialogs a flow asks for; `DurableCommandUi` satisfies it. */
export interface DurableReportDialogs {
	select(title: string, items: readonly SelectItem[], description?: string): Promise<string | undefined>;
	/** One line of text; undefined when the user cancelled. */
	input(title: string, description: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** The answers a selector offers, as the port takes them. */
function options(...values: string[]): SelectItem[] {
	return values.map((value) => ({ value, label: value }));
}

/** The open session `/bug` describes. */
export interface DurableBugReportSession {
	readonly view: DurableView;
	readonly controller: DurableController;
	readonly sessionOps: DurableSessionOps;
}

/** Share the open session as a private gist, as legacy `/share` does: the HTML export, uploaded with `gh`. */
export async function shareDurableSession(ui: DurableReportDialogs, sessionOps: DurableSessionOps): Promise<void> {
	const auth = checkGistAuth();
	if (!auth.ready) {
		ui.notify(auth.message, "error");
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), "nyan-share-"));
	try {
		const html = join(directory, "session.html");
		try {
			await sessionOps.exportHtml(html);
		} catch (error) {
			ui.notify(`Failed to export session: ${messageOf(error)}`, "error");
			return;
		}
		ui.notify("Creating gist...");
		let gist: Awaited<ReturnType<typeof createGist>>;
		try {
			gist = await createGist(html);
		} catch (error) {
			ui.notify(messageOf(error), "error");
			return;
		}
		if (gist.previewUrl !== undefined) ui.notify(`Share URL: ${gist.previewUrl}`);
		ui.notify(`Gist: ${gist.gistUrl}`);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/** Run the `/bug` flow: consent, optional summary, then a zip archive in the working directory. */
export async function reportDurableBug(
	ui: DurableReportDialogs,
	session: DurableBugReportSession,
	environment: DurableBugReportEnvironment,
): Promise<void> {
	const model = currentModel(session, environment);
	const hint = await ui.input("Report a bug", `${BUG_REPORT_DISCLAIMER}\n\nWhat went wrong? (optional)`);
	if (hint === undefined) return ui.notify("Bug report cancelled");
	const transcript = await ui.select(
		"Include the session transcript?",
		options("Yes, include the transcript", "No"),
		BUG_REPORT_TRANSCRIPT_NOTE,
	);
	if (transcript === undefined) return ui.notify("Bug report cancelled");
	const includeSession = transcript !== "No";
	let summary: string | undefined;
	if (!includeSession) {
		const answer = await ui.select(
			`Attach a summary written by ${model?.name ?? "the current model"} instead?`,
			options("Yes, generate a summary", "No"),
			`The transcript is sent to ${model?.provider ?? "your provider"} with your credentials and tokens. Only the generated summary is attached; the transcript stays on your machine.`,
		);
		if (answer === undefined) return ui.notify("Bug report cancelled");
		if (answer !== "No") {
			ui.notify(`Writing summary with ${model?.name ?? "the current model"}...`);
			try {
				summary = await writeSummary(session, environment, model, hint.trim() || undefined);
			} catch (error) {
				ui.notify(`Failed to write bug report summary: ${messageOf(error)}`, "error");
				return;
			}
		}
	}
	const description = hint.trim();
	const delivery = await ui.select(
		"Bug report",
		options("Export as Zip", "Cancel"),
		`Description: ${description.length === 0 ? "none" : description}\nTranscript: ${includeSession ? "included" : "not included"}\nSummary: ${summary === undefined ? "none" : `written by ${model?.name ?? "the current model"}`}\n\nExport writes a zip archive to the current directory.`,
	);
	if (delivery === undefined || delivery === "Cancel") return ui.notify("Bug report cancelled");

	let bundle: BugReportBundle;
	try {
		bundle = await buildBundle(session, environment, {
			hint: description.length === 0 ? undefined : description,
			includeSession,
			summary,
			model,
		});
	} catch (error) {
		ui.notify(`Failed to build bug report: ${messageOf(error)}`, "error");
		return;
	}
	const archivePath = join(process.cwd(), bugReportArchiveFileName(bundle.metadata.id));
	try {
		await writeBugReportArchive(bundle, archivePath);
	} catch (error) {
		ui.notify(`Failed to write bug report: ${messageOf(error)}`, "error");
		return;
	}
	ui.notify(`Bug report exported to: ${archivePath}`);
	ui.notify(`Report ID: ${bundle.metadata.id}`);
}

async function buildBundle(
	session: DurableBugReportSession,
	environment: DurableBugReportEnvironment,
	options: {
		readonly hint?: string;
		readonly includeSession: boolean;
		readonly summary?: string;
		readonly model?: Model<Api>;
	},
): Promise<BugReportBundle> {
	const view = session.view;
	const { entries } = await session.sessionOps.entries(undefined);
	return assembleBugReport({
		...(options.hint === undefined ? {} : { hint: options.hint }),
		// The diagnostics read the legacy entry shapes, which `get_entries` maps from the durable store.
		session: { getSessionId: () => view.session.id, getEntries: () => entries },
		cwd: view.session.cwd,
		includeSession: options.includeSession,
		includeSummary: options.summary !== undefined,
		// The messages a legacy session would hold: the durable store also keeps a positional prompt entry.
		messageCount: entries.filter((entry) => entry.type === "message").length,
		...(options.model === undefined ? {} : { model: options.model }),
		modelRuntime: environment.modelRuntime,
		thinkingLevel: agentOf(view.conversation).thinkingLevel ?? "off",
		extensions: environment.extensions,
		extensionErrors: environment.extensionErrors,
		globalSettings: environment.settings.getGlobalSettings(),
		projectSettings: environment.settings.getProjectSettings(),
		crashes: readCrashLog(),
		sessionJsonl: options.includeSession ? await sessionJsonl(session) : undefined,
		...(options.summary === undefined ? {} : { summary: options.summary }),
	});
}

/** The transcript as the legacy JSONL the report carries: durable exports the same mapping to a temporary file. */
async function sessionJsonl(session: DurableBugReportSession): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nyan-bug-report-"));
	try {
		const file = await session.sessionOps.exportJsonl(join(directory, "session.jsonl"));
		return await readFile(file, "utf8");
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * The report a model writes when the transcript is not shared. The request goes through the same model runtime the
 * session's own requests use, so it is authenticated exactly as they are.
 */
async function writeSummary(
	session: DurableBugReportSession,
	environment: DurableBugReportEnvironment,
	model: Model<Api> | undefined,
	hint: string | undefined,
): Promise<string> {
	if (model === undefined) throw new Error("No model selected");
	const messages = session.view.conversation.entries.flatMap((entry) => entry.model ?? []);
	return await generateBugReportSummary({
		messages,
		...(hint === undefined ? {} : { hint }),
		model,
		thinkingLevel: agentOf(session.view.conversation).thinkingLevel ?? "off",
		signal: new AbortController().signal,
		streamFn: (requestModel, context, options) =>
			environment.modelRuntime.streamSimple(requestModel, context, options),
		retry: environment.settings.getRetrySettings(),
		sessionId: session.view.session.id,
	});
}

function currentModel(
	session: DurableBugReportSession,
	environment: DurableBugReportEnvironment,
): Model<Api> | undefined {
	const agent = agentOf(session.view.conversation);
	return agent.model === undefined
		? undefined
		: environment.modelRuntime.getModel(agent.model.provider, agent.model.modelId);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
