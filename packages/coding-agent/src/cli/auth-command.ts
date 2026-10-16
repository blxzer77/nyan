import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token" | "login";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
	method?: "oauth" | "api_key";
}

export class AuthCommandError extends Error {}

/**
 * Message for a failed auth command.
 *
 * `AuthCommandError` already carries text written for the user, so it is shown as is. Anything else is
 * unexpected — a cancelled login, a provider refusing the key, a network failure — and naming the phase
 * that failed is more useful than the generic sentence it used to be reported as.
 */
export function formatAuthCommandError(kind: AuthCommandKind, error: unknown): string {
	const message = error instanceof Error ? error.message.trim() : String(error).trim();
	if (error instanceof AuthCommandError) return message;
	const phase =
		kind === "login" ? "Login failed" : kind === "check" ? "Auth check failed" : "Failed to resolve credential";
	return message ? `${phase}: ${message}` : phase;
}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
	login: `${APP_NAME} auth login [--provider <provider>] [--method <oauth|api_key>]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check"
		? "auth check"
		: kind === "api_key"
			? "auth print-api-key"
			: kind === "bearer_token"
				? "auth print-bearer-token"
				: "auth login";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	if (args[0] === "login" && (args[1] === "help" || args.includes("--help") || args.includes("-h"))) {
		return true;
	}
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`Usage:
  nyan auth login [--provider <provider>] [--method <oauth|api_key>]
  nyan auth print-api-key [--provider <provider>] [--model <model>]
  nyan auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  nyan auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands inspect and manage provider credentials. "login" starts an interactive login flow. "check" tests provider readiness. Checks refresh expired OAuth credentials by default; --no-refresh prevents this. --credentials emits the credential, or includes it in JSON output.`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth" && args[0] !== "login") return undefined;

	const isDirectLogin = args[0] === "login";
	const rawKind = isDirectLogin ? "login" : args[1];
	const kind =
		rawKind === "check"
			? "check"
			: rawKind === "print-api-key"
				? "api_key"
				: rawKind === "print-bearer-token"
					? "bearer_token"
					: rawKind === "login"
						? "login"
						: undefined;
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth login", "${APP_NAME} auth print-api-key", "${APP_NAME} auth print-bearer-token", or "${APP_NAME} auth check".`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	let method: "oauth" | "api_key" | undefined;
	const startIndex = isDirectLogin ? 1 : 2;
	for (let index = startIndex; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--min-expiry") {
			if (kind !== "bearer_token")
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--method" || arg === "--auth-type") {
			if (kind !== "login") throw new AuthCommandError(`${arg} is only supported by auth login`);
			const value = args[++index]?.toLowerCase();
			if (value !== "oauth" && value !== "api_key") {
				throw new AuthCommandError(`${arg} must be either "oauth" or "api_key"`);
			}
			method = value;
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		if (kind === "login" && !arg.startsWith("-") && !commandArgs.includes("--provider")) {
			commandArgs.push("--provider", arg);
			continue;
		}
		commandArgs.push(arg);
	}

	return {
		kind,
		args: commandArgs,
		json,
		credentials,
		noRefresh,
		...(minExpiryMs !== undefined ? { minExpiryMs } : {}),
		...(method ? { method } : {}),
	};
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	if (kind === "login") {
		return { provider, model };
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	return { provider, model };
}
