import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { AuthEvent, AuthPrompt, AuthType, Provider } from "@ny4n/ai";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import { createAgentSessionServices } from "../core/agent-session-services.ts";
import { compareLoginProviders } from "../core/auth-guidance.ts";
import { readStoredCredential } from "../core/auth-storage.ts";
import type { InlineExtension } from "../core/extensions/types.ts";
import { CredentialSynchronizationError } from "../core/model-runtime.ts";
import { openBrowser } from "../utils/open-browser.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, validateAuthCommandArgs } from "./auth-command.ts";

function askQuestion(rl: Interface, query: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) return Promise.reject(new AuthCommandError("Login cancelled"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(new AuthCommandError("Login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		rl.question(query, (answer) => {
			signal?.removeEventListener("abort", onAbort);
			resolve(answer);
		});
	});
}

function resolveProvider(providers: readonly Provider[], ref: string): Provider | undefined {
	const normalized = ref.trim().toLowerCase();
	return (
		providers.find((p) => p.id.toLowerCase() === normalized) ??
		providers.find((p) => p.name.toLowerCase() === normalized)
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Told when a verification failure has replaced the stored credential, which the login does not restore. */
const REPLACED_CREDENTIAL_NOTICE = "The new login replaced the previously stored credential, which is not restored.";

/**
 * Says what happened, what was kept, and what to do, rather than only that it failed. The login commits the key before it
 * verifies it, so a failed verification has already replaced any credential that was stored, and the message says so.
 */
function credentialNotVerified(provider: Provider, detail: string, replacedStored: boolean): AuthCommandError {
	const kept = replacedStored ? `${REPLACED_CREDENTIAL_NOTICE} ` : "The credential is stored. ";
	return new AuthCommandError(
		`Logged in to ${provider.name}, but the credential could not be verified: ${detail}\n` +
			`${kept}Correct it and run ${APP_NAME} login ${provider.id} again.`,
	);
}

/** 1-based answer to a 0-based index, or undefined when it is not one of `count` numbers. */
function parseIndex(raw: string, count: number): number | undefined {
	if (!/^\d+$/u.test(raw)) return undefined;
	const index = Number.parseInt(raw, 10) - 1;
	return index < count ? index : undefined;
}

/** Only the answer source and the message sink are injectable; everything else comes from the environment. */
export interface AuthLoginOptions {
	agentDir?: string;
	cwd?: string;
	extensionFactories?: InlineExtension[];
	method?: "oauth" | "api_key";
	/** Answers questions instead of reading the terminal, so no terminal is needed. */
	ask?: (query: string, signal?: AbortSignal) => string | Promise<string>;
	/** Where prompts and messages are written. Defaults to `process.stdout`. */
	output?: NodeJS.WritableStream;
	/** Whether the terminal may be used for questions. Defaults to whether stdin is a terminal. */
	isInteractive?: boolean;
}

export async function runAuthLogin(args: Args, options: AuthLoginOptions = {}): Promise<void> {
	const { provider: cliProvider } = validateAuthCommandArgs(args, "login");
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();

	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		resourceLoaderOptions: {
			extensionFactories: options.extensionFactories,
		},
	});
	const modelRuntime = services.modelRuntime;
	const providers = modelRuntime.getProviders().slice().sort(compareLoginProviders);

	const output = options.output ?? process.stdout;
	const isInteractive = options.isInteractive ?? process.stdin.isTTY === true;
	let rl: Interface | undefined;
	const write = (line = ""): void => {
		output.write(`${line}\n`);
	};
	/**
	 * The terminal is created on the first question, so a provider that never prompts needs none. Without a
	 * terminal there is no answer to wait for and waiting would look like a hang, so say what to do instead.
	 */
	const ask = async (query: string, signal?: AbortSignal): Promise<string> => {
		if (options.ask) return options.ask(query, signal);
		if (!isInteractive) {
			throw new AuthCommandError(
				`${APP_NAME} login needs an interactive terminal to ask for credentials. ` +
					`Set the provider's environment variable instead, or write the credential to ${join(agentDir, "auth.json")}.`,
			);
		}
		rl ??= createInterface({ input: process.stdin, output });
		return askQuestion(rl, query, signal);
	};
	/** Read a 1-based choice, re-asking until it is one of the offered numbers. */
	const readIndex = async (
		query: string,
		count: number,
		choiceOptions: { emptyDefault?: number; signal?: AbortSignal } = {},
	): Promise<number> => {
		for (;;) {
			const raw = (await ask(query, choiceOptions.signal)).trim();
			if (raw === "" && choiceOptions.emptyDefault !== undefined) return choiceOptions.emptyDefault;
			const index = parseIndex(raw, count);
			if (index !== undefined) return index;
			write(chalk.dim(`Enter a number between 1 and ${count}.`));
		}
	};
	const abortController = new AbortController();
	const onSigInt = () => {
		abortController.abort();
	};
	process.on("SIGINT", onSigInt);

	try {
		let provider: Provider | undefined;
		if (cliProvider) {
			provider = resolveProvider(providers, cliProvider);
			if (!provider) {
				const available = providers.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
				throw new AuthCommandError(`Unknown provider "${cliProvider}". Available providers:\n${available}`);
			}
		} else {
			if (providers.length === 0) {
				throw new AuthCommandError("No providers are available to log in.");
			}
			write(chalk.bold("\nSelect a provider to log in:"));
			for (let i = 0; i < providers.length; i++) {
				const p = providers[i]!;
				write(`  ${String(i + 1).padStart(2)}. ${p.name} ${chalk.dim(`(${p.id})`)}`);
			}
			const index = await readIndex(`\nEnter number (1-${providers.length}): `, providers.length, {
				signal: abortController.signal,
			});
			provider = providers[index]!;
		}

		const hasOAuth = Boolean(provider.auth.oauth);
		const hasApiKey = Boolean(provider.auth.apiKey);
		if (!hasOAuth && !hasApiKey) {
			throw new AuthCommandError(`Provider "${provider.name}" does not support login.`);
		}

		let authType: AuthType;
		if (options.method) {
			if (options.method === "oauth" && !hasOAuth) {
				throw new AuthCommandError(`Provider "${provider.name}" does not support OAuth login.`);
			}
			if (options.method === "api_key" && !hasApiKey) {
				// Only reached for a provider with OAuth: the check above refuses one with neither method.
				throw new AuthCommandError(
					`Provider "${provider.name}" has no API key method here. Run ${APP_NAME} login ${provider.id} without --method to use its login flow.`,
				);
			}
			authType = options.method;
		} else if (hasOAuth && hasApiKey) {
			const oauthLabel = provider.auth.oauth?.loginLabel ?? "Sign in with an account (OAuth)";
			write(chalk.bold(`\nAuthentication methods for ${provider.name}:`));
			write(`  1. ${oauthLabel}`);
			write("  2. API key");
			// An empty answer keeps the previous default of the first method.
			const methodIndex = await readIndex("\nEnter choice (1-2) [1]: ", 2, {
				emptyDefault: 0,
				signal: abortController.signal,
			});
			authType = methodIndex === 1 ? "api_key" : "oauth";
		} else {
			authType = hasOAuth ? "oauth" : "api_key";
		}

		const promptHandler = async (prompt: AuthPrompt): Promise<string> => {
			if (abortController.signal.aborted) {
				throw new AuthCommandError("Login cancelled");
			}
			if (prompt.type === "select") {
				if (prompt.options.length === 0) {
					throw new AuthCommandError(`${prompt.message}: the provider offered no options to choose from.`);
				}
				write(`\n${prompt.message}`);
				for (let i = 0; i < prompt.options.length; i++) {
					const opt = prompt.options[i]!;
					write(`  ${i + 1}. ${opt.label}${opt.description ? ` (${opt.description})` : ""}`);
				}
				const index = await readIndex(`Enter choice (1-${prompt.options.length}): `, prompt.options.length, {
					signal: prompt.signal ?? abortController.signal,
				});
				return prompt.options[index]!.id;
			}
			const placeholderHint = prompt.placeholder ? ` [${prompt.placeholder}]` : "";
			for (;;) {
				const ans = await ask(`${prompt.message}${placeholderHint}: `, prompt.signal ?? abortController.signal);
				// The placeholder is a hint, as it is in the interactive dialog. Substituting it here would answer for
				// the user: CLIProxyAPI asks for its API key with `placeholder: "sk-..."`, so Enter would send that
				// literal string as the key.
				const trimmed = ans.trim();
				if (trimmed !== "" || prompt.allowEmpty !== false) return trimmed;
				// A required answer is asked again here rather than returned empty, so every consumer behaves the same.
				write(chalk.dim("An answer is required."));
			}
		};

		const notifyHandler = (event: AuthEvent): void => {
			switch (event.type) {
				case "auth_url":
					write(`\nOpen this URL in your browser:\n${chalk.cyan(event.url)}`);
					if (event.instructions) write(chalk.yellow(event.instructions));
					openBrowser(event.url);
					break;
				case "device_code":
					write(`\nOpen this URL in your browser:\n${chalk.cyan(event.verificationUri)}`);
					write(chalk.bold(`Enter code: ${event.userCode}`));
					openBrowser(event.verificationUri);
					break;
				case "info":
				case "progress":
					write(chalk.dim(event.message));
					break;
			}
		};

		// A provider that cannot even restore its own model list fails inside the post-login synchronization, whose
		// own message names neither the cause nor what to do. Its `cause` is the provider's failure, so report that.
		// Read before the login writes the key: a failed verification replaces whatever is stored here.
		const replacedStored = readStoredCredential(provider.id, join(agentDir, "auth.json")) !== undefined;
		try {
			await modelRuntime.login(
				provider.id,
				authType,
				{
					signal: abortController.signal,
					prompt: promptHandler,
					notify: notifyHandler,
				},
				{ getDeviceId: () => services.settingsManager.getOrCreateDeviceId() },
			);
		} catch (error) {
			if (error instanceof CredentialSynchronizationError) {
				throw credentialNotVerified(provider, describeError(error.cause), replacedStored);
			}
			throw error;
		}

		write(chalk.dim(`\nCredentials saved to ${join(agentDir, "auth.json")}`));

		if (!provider.refreshModels) {
			// A provider that cannot list its own models can only be exercised with an inference request, which costs
			// tokens, so none is made here and the credential is reported as stored rather than verified.
			write(chalk.green(`Logged in to ${provider.name}. The credential is stored and was not verified.`));
			return;
		}

		// The provider's own model refresh authenticates with the credential just stored, so its outcome is the
		// verification: a rejected credential fails here instead of at the first request.
		write(chalk.dim(`Verifying the credential and refreshing models for ${provider.name}...`));
		// The verification flag makes the provider fetch now, authenticate with the credential just stored, and report a
		// verdict. Nothing else about this refresh is inferred from its options.
		const refreshed = await modelRuntime
			.refresh({
				providers: [provider.id],
				allowNetwork: true,
				force: true,
				verifyCredential: true,
				signal: abortController.signal,
			})
			.catch((error: unknown): never => {
				throw credentialNotVerified(provider, describeError(error), replacedStored);
			});
		if (refreshed.aborted) throw new AuthCommandError("Login cancelled");
		// The provider's verdict is the discriminant; the error text is only for display.
		const verdict = refreshed.verdicts?.get(provider.id);
		const failure = refreshed.errors.get(provider.id);
		if (verdict === "unavailable") {
			// No answer is not a refusal: the credential is kept, and a list of zero models is never reported as verified.
			const detail = failure?.message ?? "the provider gave no usable answer";
			write(chalk.yellow(`Logged in to ${provider.name}. The credential is stored and was not verified: ${detail}`));
			if (replacedStored) {
				write(chalk.yellow(REPLACED_CREDENTIAL_NOTICE));
			}
			write(chalk.dim(`Run ${APP_NAME} login ${provider.id} again once the provider is reachable to verify it.`));
			return;
		}
		if (verdict === "rejected" || failure) {
			throw credentialNotVerified(
				provider,
				failure?.message ?? "the provider refused the credential",
				replacedStored,
			);
		}

		const models = modelRuntime.getModels(provider.id);
		write(chalk.green(`Logged in to ${provider.name}. Verified: ${models.length} model(s) available.`));
	} finally {
		rl?.close();
		process.off("SIGINT", onSigInt);
	}
}
