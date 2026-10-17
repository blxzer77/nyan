import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@ny4n/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { buildProviderRegistration, CatalogController } from "../src/extensions/cliproxyapi/provider.ts";

const PROVIDER_ID = "cliproxyapi";

describe("CLIProxyAPI key that resolves requests", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function runtimeWith(
		registration: Parameters<ModelRuntime["registerProvider"]>[1],
		id = PROVIDER_ID,
	): Promise<{ modelRuntime: ModelRuntime; store: CredentialStore }> {
		dir = mkdtempSync(join(tmpdir(), "nyan-cpa-key-resolve-"));
		const store: CredentialStore = AuthStorage.create(join(dir, "auth.json"));
		const modelRuntime = await ModelRuntime.create({ credentials: store, modelsPath: join(dir, "models.json") });
		modelRuntime.registerProvider(id, registration);
		return { modelRuntime, store };
	}

	function cliproxyRegistration(agentDir: string, apiKey: string | undefined) {
		return buildProviderRegistration({
			pi: {} as unknown as ExtensionAPI,
			agentDir,
			providerId: PROVIDER_ID,
			providerName: "CLIProxyAPI",
			baseUrlInput: "http://127.0.0.1:8317",
			apiKey,
			catalog: new CatalogController(agentDir, PROVIDER_ID),
		});
	}

	it("resolves a stored api_key credential for requests, with no environment key set", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "nyan-cpa-agent-"));
		try {
			const { modelRuntime, store } = await runtimeWith(cliproxyRegistration(agentDir, undefined));
			await store.modify(PROVIDER_ID, async () => ({ type: "api_key", key: "stored-key" }));

			const resolved = await modelRuntime.getAuth(PROVIDER_ID);

			expect(resolved?.auth.apiKey).toBe("stored-key");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("offers one login method: OAuth, with the key only resolving requests", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "nyan-cpa-agent-"));
		try {
			const { modelRuntime } = await runtimeWith(cliproxyRegistration(agentDir, "config-key"));
			const provider = modelRuntime.getProviders().find((p) => p.id === PROVIDER_ID);

			expect(provider?.auth.oauth?.login).toBeTypeOf("function");
			expect(provider?.auth.apiKey).toBeDefined();
			expect(provider?.auth.apiKey?.login).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps resolving the configured key when no login is stored", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "nyan-cpa-agent-"));
		try {
			const { modelRuntime } = await runtimeWith(cliproxyRegistration(agentDir, "config-key"));

			const resolved = await modelRuntime.getAuth(PROVIDER_ID);

			expect(resolved?.auth.apiKey).toBe("config-key");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves the API-key login decision unchanged for providers that do not set the field", async () => {
		// Before the field existed, the login dialog and the CLI offered an API-key login exactly when a key method existed.
		// The decision now reads the key method's login, so the two must agree for every shape that does not set the field.
		const oauth = {
			name: "OAuth",
			login: async () => ({ refresh: "r", access: "a", expires: Date.now() + 60_000 }),
			refreshToken: async (credentials: { access: string; refresh: string; expires: number }) => credentials,
			getApiKey: (credentials: { access: string }) => credentials.access,
		};
		const shapes: Array<{ id: string; registration: Parameters<ModelRuntime["registerProvider"]>[1] }> = [
			{
				id: "key-only",
				registration: {
					name: "Key only",
					baseUrl: "http://127.0.0.1:9",
					api: "openai-completions",
					apiKey: "key",
					models: [],
				},
			},
			{ id: "oauth-only", registration: { name: "OAuth only", oauth } },
			{ id: "oauth-and-key", registration: { name: "OAuth and key", oauth, apiKey: "key" } },
		];
		dir = mkdtempSync(join(tmpdir(), "nyan-cpa-shapes-"));
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath: join(dir, "models.json"),
		});
		for (const shape of shapes) modelRuntime.registerProvider(shape.id, shape.registration);

		for (const shape of shapes) {
			const provider = modelRuntime.getProviders().find((p) => p.id === shape.id);
			const offersApiKeyLogin = Boolean(provider?.auth.apiKey?.login);
			const hadApiKeyMethod = Boolean(provider?.auth.apiKey);
			expect(offersApiKeyLogin, shape.id).toBe(hadApiKeyMethod);
		}
		// The built-in provider composes a login for its key, so it is offered exactly as before.
		const builtin = modelRuntime.getProviders().find((p) => p.id === "anthropic");
		expect(Boolean(builtin?.auth.apiKey?.login)).toBe(Boolean(builtin?.auth.apiKey));
	});
});
