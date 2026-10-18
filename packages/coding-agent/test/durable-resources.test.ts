import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { openDurable } from "../src/core/durable/runtime.ts";
import { createDurableServices } from "../src/core/durable/services.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

/**
 * The durable path with the resource flags, against a loopback stand-in for CLIProxyAPI. The stand-in lists one model
 * and answers every other request with HTTP 500, so a run ends unanswered after its request has reached it: the
 * request body shows what the model was sent. No real proxy, no credentials.
 */

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

interface Stub {
	readonly baseUrl: string;
	readonly bodies: string[];
	close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
	const bodies: string[] = [];
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			if (request.url?.startsWith("/v1/models")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ id: "deepseek-flash", slug: "deepseek-flash" }] }));
				return;
			}
			bodies.push(body);
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "stand-in: no upstream" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		bodies,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// Each open loads the built-in extensions and a session; the sending test opens four.
vi.setConfig({ testTimeout: 120_000 });

describe("durable path resources", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let stub: Stub;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-durable-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-durable-cwd-"));
		await mkdir(agentDir, { recursive: true });
		// Retries would only repeat the stand-in's 500.
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		stub = await startStub();
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CLIPROXYAPI_BASE_URL", stub.baseUrl);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "probe-key-not-real");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await stub.close();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	/**
	 * Open once without a model, so the extension's catalog refresh writes the cache and registers the models; later
	 * opens then resolve them as `--provider` does. Without a cache the first open has no models at all.
	 */
	async function seedCatalog(): Promise<void> {
		const first = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
		});
		try {
			await vi.waitFor(
				() => {
					expect(first.modelRuntime.getModel("cliproxyapi", "deepseek-flash")).toBeDefined();
				},
				{ timeout: 10_000 },
			);
		} finally {
			await first.close();
		}
	}

	test("resolves --provider cliproxyapi on the durable path, and the request reaches the provider", async () => {
		await seedCatalog();
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
		});
		try {
			expect(durable.view.current().conversation.docs["nyan.agent"]).toMatchObject({
				model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			});
			const settled = await durable.controller.submitAndWait("hi", "followUp");
			expect(settled).toMatchObject({ status: "unanswered" });
			expect(stub.bodies.length).toBeGreaterThan(0);
			expect(stub.bodies[0]).toContain("deepseek-flash");
		} finally {
			await durable.close();
		}
	});

	test("sends the project context file, skills, and the system prompt the flags select", async () => {
		await writeFile(join(cwd, "AGENTS.md"), "MARKER-CONTEXT-XYZ");
		const skillDir = join(agentDir, "skills", "probe-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: probe-skill\ndescription: MARKER-SKILL-QQ\n---\nbody\n");
		await seedCatalog();

		const send = async (resources: Record<string, unknown>): Promise<string> => {
			const durable = await openDurable({
				cwd,
				extensionFactories: builtInExtensions,
				model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
				projectTrustContext: { ...headless, cwd },
				resources,
			});
			try {
				await durable.controller.submitAndWait("hi", "followUp");
			} finally {
				await durable.close();
			}
			return stub.bodies.at(-1) ?? "";
		};

		const withDefaults = await send({});
		expect(withDefaults).toContain("MARKER-CONTEXT-XYZ");
		expect(withDefaults).toContain("MARKER-SKILL-QQ");

		const withoutContext = await send({ noContextFiles: true });
		expect(withoutContext).not.toContain("MARKER-CONTEXT-XYZ");
		expect(withoutContext).toContain("MARKER-SKILL-QQ");

		const withoutSkills = await send({ noSkills: true });
		expect(withoutSkills).toContain("MARKER-CONTEXT-XYZ");
		expect(withoutSkills).not.toContain("MARKER-SKILL-QQ");

		const withSystemPrompt = await send({ systemPrompt: "MARKER-SYSTEM-ABC" });
		expect(withSystemPrompt).toContain("MARKER-SYSTEM-ABC");
		expect(withSystemPrompt).not.toContain("expert coding assistant");
	});

	test("loads the built-in extensions without errors, and --no-mcp leaves out MCP", async () => {
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: {},
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
		});
		expect(services.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
		const paths = services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
		for (const name of ["cliproxyapi", "codemode", "tool-search", "mcp", "herdr"]) {
			expect(
				paths.some((path) => path.includes(name)),
				name,
			).toBe(true);
		}

		const withoutMcp = await createDurableServices({
			cwd,
			agentDir,
			resources: { noMcp: true },
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
		});
		const pathsWithoutMcp = withoutMcp.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
		expect(pathsWithoutMcp.some((path) => path.includes("mcp"))).toBe(false);
	});

	test("registers a provider an extension adds after loading with the model runtime", async () => {
		// A catalog refresh or a login registers after the load, which the legacy path binds to the model runtime.
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: {},
			extensionFactories: [],
			projectTrustContext: { ...headless, cwd },
		});
		const register = vi.spyOn(services.modelRuntime, "registerProvider").mockImplementation(() => {});
		const runtime = services.resourceLoader.getExtensions().runtime;
		runtime.registerProvider("probe-late", {
			baseUrl: "http://127.0.0.1:1",
			api: "openai-completions",
			models: [],
		} as never);
		expect(register).toHaveBeenCalledWith("probe-late", expect.anything());
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	test("keeps a project's extensions off until its trust is decided, and loads them once trusted", async () => {
		await mkdir(join(cwd, ".nyan", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".nyan", "extensions", "probe-project.ts"), "export default function () {}\n");
		const loaded = async (): Promise<string[]> => {
			const services = await createDurableServices({
				cwd,
				agentDir,
				resources: {},
				extensionFactories: [],
				projectTrustContext: { ...headless, cwd },
			});
			return services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
		};

		expect((await loaded()).some((path) => path.includes("probe-project"))).toBe(false);

		new ProjectTrustStore(agentDir).set(cwd, true);
		expect((await loaded()).some((path) => path.includes("probe-project"))).toBe(true);
	});

	test("--append-system-prompt text reaches the request", async () => {
		await seedCatalog();
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			model: { provider: "cliproxyapi", modelId: "deepseek-flash" },
			projectTrustContext: { ...headless, cwd },
			resources: { appendSystemPrompt: ["MARKER-APPEND-QZ"] },
		});
		try {
			await durable.controller.submitAndWait("hi", "followUp");
			expect(stub.bodies.length).toBeGreaterThan(0);
			expect(stub.bodies[0]).toContain("MARKER-APPEND-QZ");
		} finally {
			await durable.close();
		}
	});

	test("an invalid settings file is reported as a diagnostic, not dropped", async () => {
		await writeFile(join(agentDir, "settings.json"), "{ not json");
		const seen: string[] = [];
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
			onDiagnostic: (diagnostic) => seen.push(diagnostic.message),
		});
		await durable.close();
		expect(seen.some((message) => message.includes("Invalid settings file"))).toBe(true);
	});

	test("settingsOverrides apply to the session's settings, which the TUI reads for the theme", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "from-file" }));
		const durable = await openDurable({
			cwd,
			extensionFactories: builtInExtensions,
			projectTrustContext: { ...headless, cwd },
			settingsOverrides: { theme: "from-flag" },
		});
		try {
			expect(durable.settings.getThemeSetting()).toBe("from-flag");
		} finally {
			await durable.close();
		}
	});
});
