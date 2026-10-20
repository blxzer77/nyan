import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import { sourceRuntimeArgs } from "../src/experimental/source-runtime-args.ts";
import cliproxyApiExtension from "../src/extensions/cliproxyapi/index.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

const PREFIX = "[nyan-cliproxyapi]";
const temporaryRoots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An agent directory with no CLIProxyAPI settings, credentials, or cache. */
function temporaryAgentDir(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "nyan-cpa-unconfigured-")));
	temporaryRoots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

/** Every line the extension writes while `run` executes, on the channels its logger uses. */
async function captureExtensionOutput(run: () => void | Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const record =
		(stream: string) =>
		(...args: unknown[]): void => {
			lines.push(`${stream} ${args.map((value) => String(value)).join(" ")}`);
		};
	vi.spyOn(console, "info").mockImplementation(record("info"));
	vi.spyOn(console, "warn").mockImplementation(record("warn"));
	await run();
	return lines;
}

function selectModel(extension: Extension, provider: string, id: string): void {
	const ctx = { hasUI: false, model: { provider, id } } as unknown as ExtensionContext;
	for (const handler of extension.handlers.get("model_select") ?? []) {
		void handler({ type: "model_select", model: { provider, id }, previousModel: undefined, source: "set" }, ctx);
	}
}

describe("CLIProxyAPI without a configuration", () => {
	it("says nothing when the extension loads", async () => {
		const agentDir = temporaryAgentDir();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "");
		vi.stubEnv("CLIPROXYAPI_QUIET", "");

		const lines = await captureExtensionOutput(async () => {
			await loadExtensionFromFactory(
				cliproxyApiExtension,
				agentDir,
				createEventBus(),
				createExtensionRuntime(),
				"builtin:cliproxyapi",
			);
		});

		expect(lines.filter((line) => line.includes(PREFIX))).toEqual([]);
	});

	it("reports the missing configuration once the provider is selected", async () => {
		const agentDir = temporaryAgentDir();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "");
		vi.stubEnv("CLIPROXYAPI_QUIET", "");
		const extension = await loadExtensionFromFactory(
			cliproxyApiExtension,
			agentDir,
			createEventBus(),
			createExtensionRuntime(),
			"builtin:cliproxyapi",
		);

		const lines = await captureExtensionOutput(() => {
			selectModel(extension, "anthropic", "claude-sonnet-4-5");
			selectModel(extension, "cliproxyapi", "gpt-5");
			selectModel(extension, "cliproxyapi", "gpt-5");
		});

		expect(lines).toEqual([
			"warn [nyan-cliproxyapi] not configured. Run /login CLIProxyAPI or /login cliproxyapi, " +
				`or set ${join(agentDir, "cliproxyapi.json")} / CLIPROXYAPI_API_KEY.`,
		]);
	});

	it("says nothing when the provider is selected with a configured key", async () => {
		const agentDir = temporaryAgentDir();
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CLIPROXYAPI_API_KEY", "sk-configured");
		vi.stubEnv("CLIPROXYAPI_QUIET", "");
		const extension = await loadExtensionFromFactory(
			cliproxyApiExtension,
			agentDir,
			createEventBus(),
			createExtensionRuntime(),
			"builtin:cliproxyapi",
		);

		const lines = await captureExtensionOutput(() => selectModel(extension, "cliproxyapi", "gpt-5"));

		// The contract is silence: any line the extension prints here would be a startup notice the user did not ask for.
		expect(lines).toEqual([]);
	});
});

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCli(agentDir: string, cwd: string, args: readonly string[]): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [...sourceRuntimeArgs(), cliPath, ...args], {
			cwd,
			env: { ...process.env, HOME: join(agentDir, ".."), [ENV_AGENT_DIR]: agentDir, NYAN_OFFLINE: "1" },
			// Both channels: a notice written to stdout would be just as unwanted as one on stderr.
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

describe("the nyan CLI without CLIProxyAPI", () => {
	it.each([
		["durable", ["-p", "hi"]],
		["legacy", ["--name", "legacy-run", "-p", "hi"]],
	])("says nothing about it on the %s path", async (_path, args) => {
		const agentDir = temporaryAgentDir();
		const cwd = join(agentDir, "..", "project");
		mkdirSync(cwd, { recursive: true });

		// The run has no provider in this home, so it stops before a request; the extension must not have spoken.
		const result = await runCli(agentDir, cwd, args);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain(PREFIX);
		expect(result.stdout).not.toContain(PREFIX);
	});
});
