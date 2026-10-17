import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@ny4n/ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	AuthCommandError,
	formatAuthCommandError,
	isAuthCommandHelp,
	parseAuthCommand,
	validateAuthCommandArgs,
} from "../src/cli/auth-command.ts";
import { runAuthLogin } from "../src/cli/auth-login.ts";
import { readStoredCredential } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, InlineExtension, ProviderConfig } from "../src/core/extensions/types.ts";

const created: string[] = [];
afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nyan-auth-login-"));
	created.push(dir);
	return dir;
}

/** Captures what the login flow writes, so prompts never reach the test's real stdout. */
function collectingOutput(): { stream: Writable; text: () => string } {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk));
			callback();
		},
	});
	return { stream, text: () => chunks.join("") };
}

/** Registers one provider whose OAuth login the test drives through the legacy extension callbacks. */
function oauthFactory(
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	/** When set, the provider can list its own models, which login uses to verify the credential. */
	refreshModels?: NonNullable<ProviderConfig["refreshModels"]>,
): InlineExtension {
	return (api) => {
		api.registerProvider("test-prov", {
			name: "Test Provider",
			baseUrl: "http://127.0.0.1:1234",
			// Needed only when refreshModels returns models, which requires a resolvable api.
			api: "openai-responses",
			models: [],
			...(refreshModels ? { refreshModels } : {}),
			oauth: {
				name: "Test Provider",
				login,
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
	};
}

describe("formatAuthCommandError", () => {
	it("names the phase that failed instead of hiding the cause", () => {
		expect(formatAuthCommandError("login", new Error("Invalid API key"))).toBe("Login failed: Invalid API key");
		expect(formatAuthCommandError("api_key", new Error("fetch failed"))).toBe(
			"Failed to resolve credential: fetch failed",
		);
		expect(formatAuthCommandError("check", new Error("boom"))).toBe("Auth check failed: boom");
	});

	it("shows an AuthCommandError as written, without a second prefix", () => {
		expect(formatAuthCommandError("login", new AuthCommandError("Login cancelled"))).toBe("Login cancelled");
		expect(formatAuthCommandError("login", new AuthCommandError('Unknown provider "x".'))).toBe(
			'Unknown provider "x".',
		);
	});

	it("falls back to the phase when the error says nothing", () => {
		expect(formatAuthCommandError("login", new Error("   "))).toBe("Login failed");
		expect(formatAuthCommandError("login", "string failure")).toBe("Login failed: string failure");
	});
});

describe("login interaction", () => {
	it("refuses to prompt without a terminal, naming the fix, instead of hanging", async () => {
		const cwd = tempDir();
		const output = collectingOutput();
		await expect(
			runAuthLogin(parseArgs([]), {
				cwd,
				agentDir: join(cwd, "agent"),
				extensionFactories: [oauthFactory(async () => ({ refresh: "r", access: "a", expires: 0 }))],
				// no ask: the flow would read the terminal, which this test does not have
				output: output.stream,
			}),
		).rejects.toThrow(/needs an interactive terminal.*auth\.json/su);
	});

	it("re-asks until a selection is one of the offered numbers", async () => {
		let selected: string | undefined;
		const factory = oauthFactory(async (callbacks) => {
			selected = await callbacks.onSelect({
				message: "Pick a method",
				options: [
					{ id: "first", label: "First" },
					{ id: "second", label: "Second" },
				],
			});
			return { refresh: "r", access: "a", expires: Date.now() + 100000 };
		});
		const { output, queries } = await loginWithInput(["nonsense\n", "9\n", "2\n"], factory);
		expect(selected).toBe("second");
		expect(output).toContain("Enter a number between 1 and 2.");
		expect(queries).toHaveLength(3);
	});

	it("treats a placeholder as a hint, never as the answer", async () => {
		let entered: string | undefined;
		const factory = oauthFactory(async (callbacks) => {
			// No allowEmpty, so an empty answer is accepted as empty rather than replaced by the hint.
			entered = await callbacks.onPrompt({ message: "API key", placeholder: "sk-..." });
			return { refresh: "r", access: entered || "none", expires: Date.now() + 100000 };
		});
		const { queries } = await loginWithInput(["\n"], factory);
		// The trap this replaces: an empty answer used to become the literal "sk-..." and be sent as the key.
		expect(entered).toBe("");
		expect(queries[0]).toContain("[sk-...]");
	});

	it("keeps a typed answer and trims it", async () => {
		let entered: string | undefined;
		const factory = oauthFactory(async (callbacks) => {
			entered = await callbacks.onPrompt({ message: "API key", placeholder: "sk-..." });
			return { refresh: "r", access: entered || "none", expires: Date.now() + 100000 };
		});
		await loginWithInput(["  sk-real  \n"], factory);
		expect(entered).toBe("sk-real");
	});

	it("propagates the provider's own failure message", async () => {
		const factory = oauthFactory(async () => {
			throw new Error("Invalid API key");
		});
		await expect(loginWithInput([], factory)).rejects.toThrow("Invalid API key");
	});

	it("honors an extension's allowEmpty: false by asking again", async () => {
		let entered: string | undefined;
		const factory = oauthFactory(async (callbacks) => {
			entered = await callbacks.onPrompt({ message: "API key", placeholder: "sk-...", allowEmpty: false });
			return { refresh: "r", access: entered || "none", expires: Date.now() + 100000 };
		});
		const { output, queries } = await loginWithInput(["\n", "   \n", "sk-real\n"], factory);
		expect(entered).toBe("sk-real");
		expect(queries).toHaveLength(3);
		expect(output).toContain("An answer is required.");
	});

	it("requires an answer to the manual code prompt", async () => {
		let code: string | undefined;
		const factory = oauthFactory(async (callbacks) => {
			code = await callbacks.onManualCodeInput?.();
			return { refresh: "r", access: code || "none", expires: Date.now() + 100000 };
		});
		const { queries } = await loginWithInput(["\n", "abc123\n"], factory);
		expect(code).toBe("abc123");
		expect(queries).toHaveLength(2);
	});
});

describe("api key login method", () => {
	it("explains the login flow instead of refusing the method for a provider that has OAuth", async () => {
		await expect(
			loginWithInput(
				[],
				oauthFactory(async () => ({ refresh: "r", access: "a", expires: Date.now() + 100000 })),
				{ method: "api_key" },
			),
		).rejects.toThrow(
			'Provider "Test Provider" has no API key method here. Run nyan login test-prov without --method to use its login flow.',
		);
	});
});

/** Runs a login against an injected answer source, which needs no terminal. */
async function loginWithInput(
	lines: string[],
	factory: InlineExtension,
	options: { args?: string[]; method?: "oauth" | "api_key"; seedAuth?: Record<string, unknown> } = {},
): Promise<{ output: string; queries: string[] }> {
	const cwd = tempDir();
	const output = collectingOutput();
	const queries: string[] = [];
	let next = 0;
	if (options.seedAuth) {
		mkdirSync(join(cwd, "agent"), { recursive: true });
		writeFileSync(join(cwd, "agent", "auth.json"), JSON.stringify(options.seedAuth));
	}
	await runAuthLogin(parseArgs(options.args ?? ["--provider", "test-prov"]), {
		cwd,
		agentDir: join(cwd, "agent"),
		extensionFactories: [factory],
		method: options.method ?? "oauth",
		ask: (query) => {
			queries.push(query);
			// Asking again is how a required prompt behaves, so an under-provisioned test must fail loudly here
			// instead of being answered with an empty line forever.
			if (next >= lines.length) {
				throw new Error(`login asked more questions than the test answers: ${query}`);
			}
			return lines[next++] ?? "";
		},
		output: output.stream,
	});
	return { output: output.text(), queries };
}

describe("login verifies the stored credential", () => {
	type RefreshModels = NonNullable<ProviderConfig["refreshModels"]>;
	const loggedIn: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials> = async () => ({
		refresh: "r",
		access: "a",
		expires: Date.now() + 100_000,
	});
	const oneModel: RefreshModels = async () => [
		{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		},
	];

	it("uses the provider's own model refresh, which authenticates with the new credential", async () => {
		let networkRefreshes = 0;
		const factory = oauthFactory(loggedIn, async (context) => {
			// The post-login synchronization refreshes with the cache only, so counting network refreshes counts
			// the verification itself.
			if (!context.allowNetwork) return [];
			networkRefreshes++;
			context.reportCredentialVerdict?.("verified");
			return oneModel(context);
		});
		const { output } = await loginWithInput([], factory);
		expect(networkRefreshes).toBe(1);
		expect(output).toContain("Logged in to Test Provider. Verified: 1 model(s) available.");
	});

	it("reports a rejected credential instead of claiming success", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("rejected");
			throw new Error("401 Invalid API key");
		});
		await expect(loginWithInput([], factory)).rejects.toThrow(
			/Logged in to Test Provider, but the credential could not be verified: 401 Invalid API key/su,
		);
		// The credential is still stored, so the message says so rather than implying nothing happened.
		await expect(loginWithInput([], factory)).rejects.toThrow(/The credential is stored/su);
	});

	it("names the cause of a failure that happens before verification can run", async () => {
		// Failing even from the cache aborts the post-login synchronization, whose default message is
		// "Credential login committed ... but local synchronization failed" and explains nothing.
		const factory = oauthFactory(loggedIn, async () => {
			throw new Error("catalog cache is unreadable");
		});
		await expect(loginWithInput([], factory)).rejects.toThrow(
			/Logged in to Test Provider, but the credential could not be verified: catalog cache is unreadable/su,
		);
	});

	it("reports a provider that accepts the credential but lists no models as verified, without claiming a model", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("verified");
			return [];
		});
		const { output } = await loginWithInput([], factory);
		expect(output).toContain(
			"Logged in to Test Provider. The provider accepted the credential, but lists no models.",
		);
		expect(output).not.toContain("Verified:");
	});

	it("a provider that completes without reporting a verdict is verified, as a refresh that completes always was", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			return [];
		});
		const { output } = await loginWithInput([], factory);
		expect(output).toContain(
			"Logged in to Test Provider. The provider accepted the credential, but lists no models.",
		);
		expect(output).not.toContain("was not verified");
	});

	it("does not call a verification that threw without a verdict rejected", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			throw new Error("fetch failed");
		});
		const { output } = await loginWithInput([], factory);
		expect(output).toContain(
			"Logged in to Test Provider. The credential is stored and was not verified: fetch failed",
		);
	});

	it("ends an unverified login with the outcome line, after the advice that precedes it", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			throw new Error("fetch failed");
		});
		const { output } = await loginWithInput([], factory);
		const lines = output.trimEnd().split("\n");
		expect(lines.at(-1)).toContain("was not verified: fetch failed");
		expect(output.indexOf("again once the provider is reachable")).toBeLessThan(output.indexOf("was not verified"));
	});

	it("ends a verified login with the outcome line, after a refresh error that came after the verdict", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("verified");
			throw new Error("publish failed");
		});
		const { output } = await loginWithInput([], factory);
		const lines = output.trimEnd().split("\n");
		expect(output).toContain("The model refresh reported an error: publish failed");
		expect(lines.at(-1)).toMatch(/accepted the credential|Verified:/);
	});

	it("says it was not verified when the provider cannot be checked without a request", async () => {
		// Anthropic and other built-in providers declare no refreshModels, so nothing is spent to verify them.
		const { output } = await loginWithInput([], oauthFactory(loggedIn));
		expect(output).toContain("Logged in to Test Provider. The credential is stored and was not verified.");
		expect(output).not.toContain("Verified:");
	});

	it("fails when the provider refuses the credential, and says the credential is kept", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("rejected");
			throw new Error("models request failed: 401 Unauthorized");
		});
		await expect(loginWithInput([], factory)).rejects.toThrow(
			/could not be verified: models request failed: 401 Unauthorized.*The credential is stored/su,
		);
	});

	it("reports a provider that did not answer as stored and unverified, never as verified", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("unavailable");
			throw new Error("fetch failed");
		});
		const { output } = await loginWithInput([], factory);
		expect(output).toContain(
			"Logged in to Test Provider. The credential is stored and was not verified: fetch failed",
		);
		expect(output).not.toContain("Verified:");
	});

	it("says the stored credential was replaced when a rejected key fails verification", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("rejected");
			throw new Error("models request failed: 401 Unauthorized");
		});
		await expect(
			loginWithInput([], factory, { seedAuth: { "test-prov": { type: "api_key", key: "previous-key" } } }),
		).rejects.toThrow(/401 Unauthorized.*replaced the previously stored credential, which is not restored/su);
	});

	it("says the stored credential was replaced when the provider does not answer", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("unavailable");
			throw new Error("fetch failed");
		});
		const { output } = await loginWithInput([], factory, {
			seedAuth: { "test-prov": { type: "api_key", key: "previous-key" } },
		});
		expect(output).toContain("replaced the previously stored credential, which is not restored");
	});

	it("does not claim a replacement when nothing was stored before the login", async () => {
		const factory = oauthFactory(loggedIn, async (context) => {
			if (!context.verifyCredential) return [];
			context.reportCredentialVerdict?.("rejected");
			throw new Error("models request failed: 401 Unauthorized");
		});
		const error = await loginWithInput([], factory).catch((caught: unknown) => caught);
		expect(String(error)).toContain("The credential is stored. Correct it");
		expect(String(error)).not.toContain("replaced");
	});
});

describe("auth login command parser", () => {
	it("parses auth login with flags", () => {
		const cmd = parseAuthCommand(["auth", "login", "--provider", "cliproxyapi", "--method", "oauth"]);
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("login");
		expect(cmd?.args).toEqual(["--provider", "cliproxyapi"]);
		expect(cmd?.method).toBe("oauth");
	});

	it("parses auth login with positional provider", () => {
		const cmd = parseAuthCommand(["auth", "login", "cliproxyapi"]);
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("login");
		expect(cmd?.args).toEqual(["--provider", "cliproxyapi"]);
	});

	it("parses direct login command", () => {
		const cmd = parseAuthCommand(["login", "CLIProxyAPI"]);
		expect(cmd).toBeDefined();
		expect(cmd?.kind).toBe("login");
		expect(cmd?.args).toEqual(["--provider", "CLIProxyAPI"]);
	});

	it("detects login help flags", () => {
		expect(isAuthCommandHelp(["auth", "login", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["login", "--help"])).toBe(true);
		expect(isAuthCommandHelp(["auth", "help"])).toBe(true);
	});

	it("validates login args allowing omitted provider for interactive selection", () => {
		const parsedWithProvider = parseArgs(["--provider", "cliproxyapi"]);
		expect(validateAuthCommandArgs(parsedWithProvider, "login")).toEqual({
			provider: "cliproxyapi",
			model: undefined,
		});

		const parsedEmpty = parseArgs([]);
		expect(validateAuthCommandArgs(parsedEmpty, "login")).toEqual({
			provider: undefined,
			model: undefined,
		});
	});

	it("rejects invalid method options", () => {
		expect(() => parseAuthCommand(["auth", "login", "--method", "invalid"])).toThrow(
			'--method must be either "oauth" or "api_key"',
		);
	});

	it("runs login flow and persists credentials for a specified provider", async () => {
		const cwd = tempDir();
		const agentDir = join(cwd, "agent");

		let loginInvoked = false;
		const testFactory = (api: ExtensionAPI) => {
			api.registerProvider("test-prov", {
				name: "Test Provider",
				baseUrl: "http://127.0.0.1:1234",
				models: [],
				oauth: {
					name: "Test Provider",
					login: async () => {
						loginInvoked = true;
						return {
							refresh: "ref-1",
							access: "acc-1",
							expires: Date.now() + 100000,
						};
					},
					refreshToken: async (c) => c,
					getApiKey: (c) => c.access,
				},
			});
		};

		const parsed = parseArgs(["--provider", "test-prov"]);
		await runAuthLogin(parsed, {
			cwd,
			agentDir,
			extensionFactories: [testFactory],
			method: "oauth",
			output: collectingOutput().stream,
		});

		expect(loginInvoked).toBe(true);
		const saved = readStoredCredential("test-prov", join(agentDir, "auth.json"));
		expect(saved).toBeDefined();
		expect(saved?.type).toBe("oauth");
		if (saved?.type === "oauth") {
			expect(saved.access).toBe("acc-1");
		}
	});
});
