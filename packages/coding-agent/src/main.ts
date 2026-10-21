/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { statSync } from "node:fs";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@ny4n/ai";
import { setCapabilityOverrides } from "@ny4n/tui";
import chalk from "chalk";
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
	registerExtensionProviders,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	formatAuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { runAuthLogin } from "./cli/auth-login.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import type { OpenDurableOptions } from "./core/durable/runtime.ts";
import {
	type DurableSessionEntry,
	DurableSessionError,
	type DurableSessionStore,
	durableSessionStoreRoot,
	findSessionDirectory,
	hasDurableSession,
	listSessionDirectory,
	setDurableSessionStore,
} from "./core/durable/sessions.ts";
import { DurableStartupError } from "./core/durable/startup-error.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { loadMcpCommand } from "./extensions/mcp/cli.lazy.ts";
import { runDurableJson } from "./modes/durable/json.ts";
import { runDurableInteractive } from "./modes/durable/main.ts";
import { runDurablePrint } from "./modes/durable/print.ts";
import { runDurableRpc } from "./modes/durable/rpc.ts";
import type { DurableSessionSetup } from "./modes/durable/session-setup.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isBunBinary } from "./runtime.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./ui/theme/theme.ts";
import { validateThemeJson } from "./ui/theme/theme-schema.ts";
import { cleanupBinaryUpdateLeftovers } from "./utils/binary-update.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

/** The message both session paths print when `--provider` arrives without `--model`. */
function providerRequiresModelMessage(provider: string): string {
	return `--provider requires --model (for example: --provider ${provider} --model <pattern>)`;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

/**
 * The durable product path accepts the common new-session flags. Session selection is not one of them: the flags are
 * resolved against the stores before either runtime starts (`resolveSessionSelection`), so a flag that names a durable
 * session reaches this path and one that names a JSONL file keeps the compatibility route.
 */
export function canRunDurableProductPath(parsed: Args, allowMultipleMessages = false): boolean {
	return (
		parsed.help !== true &&
		parsed.listModels === undefined &&
		parsed.models === undefined &&
		parsed.tools === undefined &&
		parsed.excludeTools === undefined &&
		parsed.noTools !== true &&
		parsed.noBuiltinTools !== true &&
		// Resource and extension flags are handled by the durable ResourceLoader and prompt/template bridge.
		parsed.tuiMode === undefined &&
		parsed.fileArgs.length === 0 &&
		(allowMultipleMessages || parsed.messages.length <= 1)
	);
}

/**
 * Whether the directory has a legacy JSONL session, which `--continue` reopens when it has no durable one. A read-only
 * probe: the manager writes no session file. The legacy store's own directory may be created by its lookup, never a
 * session, and the durable store is left untouched.
 */
function legacySessionExists(cwd: string, sessionDir: string | undefined): boolean {
	return SessionManager.continueRecent(cwd, sessionDir, { readOnly: true }).getSessionFile() !== undefined;
}

/** What `--continue` continues: the directory's durable session, its legacy JSONL session, or nothing (a new session). */
export type ContinueRoute = "durable" | "legacy" | "new";

/**
 * Decision #32: `--continue` continues the directory's newest durable session; a directory that has only a legacy
 * JSONL session reopens that one read-only on the compatibility route, with the notice the legacy route already prints
 * for `--resume`; a directory with neither starts a new durable session, as 1.3.0 started a new session.
 */
export async function resolveContinueRoute(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	store: DurableSessionStore = {},
): Promise<ContinueRoute> {
	if (parsed.continue !== true) return "new";
	// A durable session wins: the durable store is this release's store, and legacy is only the fallback.
	if (await hasDurableSession(cwd, store)) return "durable";
	return legacySessionExists(cwd, sessionDir) ? "legacy" : "new";
}

/** Prints one warning or error from the durable path's startup, as the legacy path prints its startup diagnostics. */
function printDurableDiagnostic(diagnostic: AgentSessionRuntimeDiagnostic): void {
	reportDiagnostics([diagnostic]);
}

/**
 * The durable session the session-selection flags open, and the store they open it in. `directory` names an existing
 * session; without it the run selects by working directory (new, or the newest one to continue).
 */
export interface DurableSessionSelection {
	readonly directory?: string;
	readonly continueSession: boolean;
	readonly store: DurableSessionStore;
	/** The trimmed `--name` value; an empty string clears the stored name. */
	readonly name?: string;
	/** The user-message entry `--fork` names, forked inside the session this run opens. */
	readonly forkAt?: string;
}

/**
 * What a run opens: a durable session, the compatibility route (legacy JSONL sessions and the flags it still owns), or
 * nothing because the user cancelled the resume picker.
 */
export type SessionSelection =
	| { readonly kind: "durable"; readonly selection: DurableSessionSelection }
	| { readonly kind: "compatibility" }
	| { readonly kind: "cancelled" };

export interface SessionSelectionOptions {
	readonly cwd: string;
	readonly appMode: AppMode;
	/** Where the compatibility route looks for JSONL sessions: `--session-dir`, the environment, or the setting. */
	readonly legacySessionDir: string | undefined;
	/** The store root `--session-dir` names. The environment and the setting never move the durable store. */
	readonly storeRoot?: string;
	/** The picker `--resume` shows; a mode that has no terminal keeps the compatibility picker. */
	readonly pick?: (sessions: readonly DurableSessionEntry[]) => Promise<string | undefined>;
}

const COMPATIBILITY: SessionSelection = { kind: "compatibility" };

/** Whether the value names a JSONL session file, which the compatibility route opens read-only. */
function isSessionFilePath(value: string): boolean {
	return value.endsWith(".jsonl");
}

/** Whether the value is a path rather than a session id. */
function isPathArgument(value: string): boolean {
	return value.includes("/") || value.includes("\\");
}

/** What is at `path`, without failing on a path that does not exist. */
function pathKind(path: string): "directory" | "file" | "missing" {
	try {
		return statSync(path).isDirectory() ? "directory" : "file";
	} catch {
		return "missing";
	}
}

/**
 * Decision #25: the session-selection flags address durable sessions.
 *
 * `--session` opens the durable session directory, or the durable session with that id, it names; `--session-id` opens
 * the session with that exact id; `--resume` lists this working directory's durable sessions; `--fork` forks inside the
 * session the other flags selected; `--session-dir` and `--no-session` decide the store; `--name` names the session.
 *
 * Three things keep the compatibility route, because there the answer is a JSONL file rather than a durable session: a
 * `--session` value that names a JSONL file or an id only the legacy store holds, a `--resume` outside the interactive
 * mode or in a directory with no durable session yet, and the flags Decision #32 already routes there.
 */
export async function resolveSessionSelection(
	parsed: Args,
	options: SessionSelectionOptions,
): Promise<SessionSelection> {
	const { cwd, appMode, legacySessionDir, storeRoot, pick } = options;
	const store: DurableSessionStore = {
		...(storeRoot === undefined ? {} : { root: storeRoot }),
		...(parsed.noSession === true ? { memory: true } : {}),
	};
	const name = parsed.name === undefined ? undefined : (normalizeSessionName(parsed.name) ?? "");
	const selected = (selection: {
		readonly directory?: string;
		readonly continueSession?: boolean;
		readonly forkAt?: string;
	}): SessionSelection => ({
		kind: "durable",
		selection: {
			...(selection.directory === undefined ? {} : { directory: selection.directory }),
			continueSession: selection.continueSession === true,
			store,
			...(name === undefined ? {} : { name }),
			...(selection.forkAt === undefined ? {} : { forkAt: selection.forkAt }),
		},
	});

	// `--help` and `--list-models` report the runtime, not a conversation: the compatibility path opens the in-memory
	// session they need, so a session id that names nothing is not a failure for them.
	if (parsed.help === true || parsed.listModels !== undefined) return COMPATIBILITY;

	// An ephemeral session writes nothing, so it has no session to select and none to fork from; `main` refuses those
	// combinations before this point rather than letting `--no-session` swallow them.
	if (parsed.noSession === true) return selected({});

	if (parsed.sessionId !== undefined) {
		const found = await findSessionDirectory(parsed.sessionId, cwd, store);
		if (found !== undefined) return selected({ directory: found.directory, forkAt: parsed.fork });
		// An id the durable store does not hold keeps opening its JSONL session read-only, as it did before 1.4.0.
		if (SessionManager.findById(cwd, parsed.sessionId, legacySessionDir) !== undefined) return COMPATIBILITY;
		throw new DurableSessionError(
			"DURABLE_SESSION_NOT_FOUND",
			`No durable session has the id ${parsed.sessionId} (${durableSessionStoreRoot(store)})`,
		);
	}

	if (parsed.session !== undefined) {
		const value = parsed.session;
		// An empty value names nothing; the compatibility route answers it with the message it already has.
		if (value.length > 0) {
			const target = resolvePath(value, cwd);
			const kind = pathKind(target);
			// A directory is a durable session. A file is a JSONL session, whose own validation is the compatibility
			// route's, so a file that is not a session keeps the error it has always given. A path that does not exist
			// names a durable session directory and gets the named error for one; anything else is an id.
			if (kind === "directory") return selected({ directory: target, forkAt: parsed.fork });
			if (kind === "missing" && !isSessionFilePath(value)) {
				if (isPathArgument(value)) return selected({ directory: target, forkAt: parsed.fork });
				const found = await findSessionDirectory(value, cwd, store);
				if (found !== undefined) return selected({ directory: found.directory, forkAt: parsed.fork });
			}
		}
		// A JSONL file, a legacy id, and an id neither store holds get the compatibility route's own answer.
		return COMPATIBILITY;
	}

	if (parsed.resume === true) {
		// The picker needs a terminal; the modes that have none keep the compatibility picker.
		if (appMode !== "interactive" || pick === undefined) return COMPATIBILITY;
		const sessions = await listSessionDirectory(cwd, store);
		// A directory with no durable session yet keeps the compatibility picker, where its JSONL sessions are listed.
		if (sessions.length === 0) return COMPATIBILITY;
		const chosen = await pick(sessions);
		return chosen === undefined ? { kind: "cancelled" } : selected({ directory: chosen, forkAt: parsed.fork });
	}

	if (parsed.continue === true) {
		const route = await resolveContinueRoute(parsed, cwd, legacySessionDir, store);
		if (route === "legacy") return COMPATIBILITY;
		return selected({ continueSession: route === "durable", forkAt: parsed.fork });
	}

	if (parsed.fork !== undefined) {
		// `--fork` alone forks inside this directory's newest durable session, which is the session `--continue` opens.
		const newest = (await listSessionDirectory(cwd, store))[0];
		if (newest === undefined) {
			throw new DurableSessionError("DURABLE_SESSION_NOT_FOUND", `No durable session exists for ${cwd}`);
		}
		return selected({ directory: newest.directory, forkAt: parsed.fork });
	}

	return selected({});
}

/**
 * Runs one durable command. A broken extension or resource stops it with each error printed, as the legacy path does.
 *
 * A failed start sets the exit code and returns rather than exiting the process: `main` is exported to embedders and
 * reused by the experimental CLI, so ending the process here would end theirs. Every caller returns after it, and the
 * CLI exits with the same code it used to.
 */
async function runDurableCommand<T>(run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof DurableStartupError) {
			reportDiagnostics(error.diagnostics);
		} else if (error instanceof DurableSessionError) {
			// A session that cannot be opened is a user-facing condition, not a defect: report it without a stack trace.
			console.error(chalk.red(`Error: ${error.message}`));
		} else {
			throw error;
		}
		process.exitCode = 1;
		return undefined;
	}
}

/**
 * The durable path's options from the command line: model, resource flags, project trust, extension flags, and the
 * session the selection flags resolved. `selection.continueSession` is the resolved `--continue` decision rather than the
 * raw flag: only the caller knows whether the directory has a durable session to continue (Decision #32).
 */
export function durableOptions(
	parsed: Args,
	cwd: string,
	mode: AppMode,
	settingsManager: SettingsManager,
	extensionFactories: readonly InlineExtension[],
	selection: DurableSessionSelection,
): OpenDurableOptions {
	// The legacy path reports this while it assembles its diagnostics; without the check here the durable path would
	// resolve an empty model id and stop with `Error: Could not resolve model:` and nothing after the colon.
	if (parsed.provider !== undefined && (parsed.model === undefined || parsed.model.length === 0)) {
		throw new DurableStartupError([
			{
				type: "error",
				message: providerRequiresModelMessage(parsed.provider),
			},
		]);
	}
	return {
		cwd,
		continueSession: selection.continueSession,
		...(selection.directory === undefined ? {} : { sessionDirectory: selection.directory }),
		...(parsed.provider === undefined && parsed.model === undefined
			? {}
			: { model: { provider: parsed.provider, modelId: parsed.model ?? "" } }),
		...(parsed.thinking === undefined ? {} : { thinkingLevel: parsed.thinking }),
		...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
		resources: {
			extensionPaths: resolveCliPaths(cwd, parsed.extensions),
			skillPaths: resolveCliPaths(cwd, parsed.skills),
			promptTemplatePaths: resolveCliPaths(cwd, parsed.promptTemplates),
			themePaths: resolveCliPaths(cwd, parsed.themes),
			noExtensions: parsed.noExtensions,
			noMcp: parsed.noMcp,
			noSkills: parsed.noSkills,
			noPromptTemplates: parsed.noPromptTemplates,
			noThemes: parsed.noThemes,
			noContextFiles: parsed.noContextFiles,
			systemPrompt: parsed.systemPrompt,
			appendSystemPrompt: parsed.appendSystemPrompt,
			trustOverride: parsed.projectTrustOverride,
		},
		extensionFactories,
		extensionFlagValues: parsed.unknownFlags,
		// Legacy applies `--use-theme` to its startup manager only in the interactive mode; the durable path does the same.
		...(mode === "interactive" && parsed.useTheme !== undefined
			? { settingsOverrides: { theme: parsed.useTheme } }
			: {}),
		projectTrustContext: createProjectTrustContext({ cwd, mode, settingsManager, hasUI: mode === "interactive" }),
		...(mode === "interactive" ? {} : { onDiagnostic: printDurableDiagnostic }),
	};
}

async function runAuthCommand(args: string[], extensionFactories?: InlineExtension[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind === "login") {
			await runAuthLogin(parsed, { extensionFactories, method: command.method });
			return true;
		}

		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			await registerExtensionProviders(modelRuntime, extensionFactories);
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials, extensionFactories);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		console.error(chalk.red(`Error: ${formatAuthCommandError(command.kind, error)}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	// AgentSession resizes these after extension hooks select the request model.
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): { type: "local"; path: string } | undefined {
	const path = SessionManager.findById(cwd, sessionId, sessionDir);
	return path ? { type: "local", path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs only require reading session headers. Fall back to the full
	// metadata listing for prefix matches.
	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	if (exactLocalMatch) {
		return exactLocalMatch;
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/** One flag cannot be combined with others: report it the way the session id checks do, and end the run. */
function reportFlagConflict(flag: string, conflicts: readonly string[]): void {
	console.error(chalk.red(`Error: ${flag} cannot be combined with ${conflicts.join(", ")}`));
	process.exit(1);
}

/** The flags every route refuses before a store is touched, so nothing is probed for a run that cannot start. */
function validateSessionSelectionFlags(parsed: Args): void {
	// A metadata command opens no conversation, so a session flag cannot make it fail.
	if (parsed.help === true || parsed.listModels !== undefined) return;
	// `--fork` without a value reached the unknown flags, or took the flag after it as its value: an extension could still
	// claim a bare `--fork`, but as a session flag it is incomplete, and forking from nothing is not a run.
	const forkValue = parsed.fork;
	if (forkValue === undefined ? parsed.unknownFlags.has("fork") : forkValue.startsWith("-")) {
		console.error(chalk.red("Error: --fork requires the id of a user message to fork from"));
		console.error(chalk.dim(`Use "${APP_NAME} --help" to see the session flags.`));
		process.exit(1);
	}
	if (parsed.fork !== undefined && parsed.resume === true) reportFlagConflict("--fork", ["--resume"]);
	if (parsed.noSession === true) {
		const conflicts = [
			parsed.continue ? "--continue" : undefined,
			parsed.resume ? "--resume" : undefined,
			parsed.session ? "--session" : undefined,
			parsed.sessionId ? "--session-id" : undefined,
			parsed.fork ? "--fork" : undefined,
		].filter((flag): flag is string => flag !== undefined);
		if (conflicts.length > 0) reportFlagConflict("--no-session", conflicts);
	}
}

/**
 * The compatibility route selects a JSONL session by its own rules, so a `--fork` that names its source cannot also
 * name the session to open.
 */
function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) reportFlagConflict("--fork", conflictingFlags);
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string, readOnly = false): SessionManager {
	try {
		return SessionManager.open(path, sessionDir, undefined, { readOnly });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir, true);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal),
				(onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir, undefined, { readOnly: true });
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir, { readOnly: true });
	}

	if (parsed.sessionId) {
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir, undefined, { readOnly: true });
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message: providerRequiresModelMessage(parsed.provider),
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

/**
 * `--resume` on the durable path: this working directory's durable sessions, newest first. The value is the session
 * directory, which is what opening one needs; a name is what a person recognises, and the creation time separates the
 * sessions that never got one.
 */
async function pickDurableSession(
	settingsManager: SettingsManager,
	sessions: readonly DurableSessionEntry[],
): Promise<string | undefined> {
	return showStartupSelector(
		settingsManager,
		"Resume session:",
		sessions.map((session) => ({
			label: `${session.name ?? "(no name)"} · ${session.created.toLocaleString()}`,
			value: session.directory,
		})),
	);
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	// Commands and startup selectors can load user-authored themes before runtime creation.
	setThemeJsonValidator(validateThemeJson);
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.NYAN_OFFLINE);
	if (offlineMode) {
		process.env.NYAN_OFFLINE = "1";
		process.env.NYAN_SKIP_VERSION_CHECK = "1";
	}

	if (await runAuthCommand(args, extensionFactories)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	if (isBunBinary) {
		cleanupBinaryUpdateLeftovers(getPackageDir());
	}
	cleanupManagedInstall();

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `nyan update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	if (args[0] === "mcp") {
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateSessionSelectionFlags(parsed);
	validateSessionIdFlags(parsed);

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// The session flags are resolved before either runtime starts: they decide which store this run opens, and probing
	// either store leaves no directory behind. A run that cannot open the session it named ends here, with one message.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	const sessionSelection = await runDurableCommand(() =>
		resolveSessionSelection(parsed, {
			cwd,
			appMode,
			legacySessionDir: sessionDir,
			...(parsed.sessionDir === undefined ? {} : { storeRoot: normalizePath(parsed.sessionDir) }),
			...(appMode === "interactive"
				? { pick: (sessions) => pickDurableSession(startupSettingsManager, sessions) }
				: {}),
		}),
	);
	if (sessionSelection === undefined) {
		stopThemeWatcher();
		return;
	}
	if (sessionSelection.kind === "cancelled") {
		console.log(chalk.dim("No session selected"));
		stopThemeWatcher();
		return;
	}
	const durableSelection = sessionSelection.kind === "durable" ? sessionSelection.selection : undefined;
	if (durableSelection === undefined) {
		// The compatibility route keeps its own combination rule for `--fork`, which names the file to fork.
		validateForkFlags(parsed);
	} else {
		// A reopen (`/new`, `/resume`) is the same run, so it writes where the command line said.
		setDurableSessionStore(durableSelection.store);
	}
	const durableSetup: DurableSessionSetup | undefined =
		durableSelection === undefined
			? undefined
			: {
					...(durableSelection.name === undefined ? {} : { name: durableSelection.name }),
					...(durableSelection.forkAt === undefined ? {} : { forkAt: durableSelection.forkAt }),
				};
	if (
		appMode === "interactive" &&
		!parsed.help &&
		parsed.listModels === undefined &&
		durableSelection !== undefined &&
		canRunDurableProductPath(parsed)
	) {
		const initial = await prepareInitialMessage(parsed);
		await runDurableCommand(() =>
			runDurableInteractive({
				...durableOptions(parsed, cwd, "interactive", startupSettingsManager, extensionFactories, durableSelection),
				...(initial.initialMessage === undefined ? {} : { initialMessage: initial.initialMessage }),
				...(durableSetup === undefined ? {} : { setup: durableSetup }),
			}),
		);
		stopThemeWatcher();
		return;
	}

	if (appMode === "rpc" && durableSelection !== undefined && canRunDurableProductPath(parsed, true)) {
		await runDurableCommand(() =>
			runDurableRpc({
				...durableOptions(parsed, cwd, "rpc", startupSettingsManager, extensionFactories, durableSelection),
				...(durableSetup === undefined ? {} : { setup: durableSetup }),
			}),
		);
		return;
	}

	if (appMode === "json" && durableSelection !== undefined && canRunDurableProductPath(parsed, true)) {
		const stdinContent = await readPipedStdin();
		const initial = await prepareInitialMessage(parsed, stdinContent);
		const exitCode = await runDurableCommand(() =>
			runDurableJson({
				...durableOptions(parsed, cwd, "json", startupSettingsManager, extensionFactories, durableSelection),
				...(initial.initialMessage === undefined ? {} : { initialMessage: initial.initialMessage }),
				...(initial.initialImages === undefined ? {} : { initialImages: initial.initialImages }),
				messages: parsed.messages,
				...(durableSetup === undefined ? {} : { setup: durableSetup }),
			}),
		);
		stopThemeWatcher();
		// Undefined means the start failed and already set the exit code.
		if (exitCode !== undefined && exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	if (
		appMode === "print" &&
		parsed.mode !== "json" &&
		durableSelection !== undefined &&
		canRunDurableProductPath(parsed, true)
	) {
		const stdinContent = await readPipedStdin();
		const initial = await prepareInitialMessage(parsed, stdinContent);
		const exitCode = await runDurableCommand(() =>
			runDurablePrint({
				...durableOptions(parsed, cwd, "print", startupSettingsManager, extensionFactories, durableSelection),
				...(initial.initialMessage === undefined ? {} : { initialMessage: initial.initialMessage }),
				...(initial.initialImages === undefined ? {} : { initialImages: initial.initialImages }),
				messages: parsed.messages,
				...(durableSetup === undefined ? {} : { setup: durableSetup }),
			}),
		);
		stopThemeWatcher();
		// Undefined means the start failed and already set the exit code.
		if (exitCode !== undefined && exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager supplied the session
	// directory above, before the `--continue` route was chosen.
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd, {
				readOnly: sessionManager.isReadOnly(),
			});
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (sessionManager.isReadOnly() && sessionManager.getSessionFile() !== undefined) {
		console.error(chalk.yellow("Legacy JSONL session opened read-only; changes will not be written to that file."));
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `Extension package "${path}": ${warning}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	time("resolveModelScope");
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.NYAN_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: NYAN_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!offlineMode && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtime, {
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
