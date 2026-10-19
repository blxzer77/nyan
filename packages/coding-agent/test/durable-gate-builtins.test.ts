import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getDurableExtensionCommands } from "../src/core/durable/extension-commands.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";
import { settlement } from "./durable-submission.ts";

/**
 * The N2 gate's claim that the shipped extensions reach functional parity on the durable path. Each built-in's behaviour
 * has its own test file (`durable-builtin-run-events`, `durable-mcp`, `durable-extension-host`, `durable-codemode`,
 * `durable-tool-search`); this file pins the surface they all share: which built-ins load, which providers they register,
 * and which commands the durable modes offer.
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

describe("durable path built-in extension surface", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-gate-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-gate-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	async function open(): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses([() => fauxAssistantMessage([fauxText("done")])]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [...builtInExtensions, provider],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("every built-in loads with the surface its durable modes offer", async () => {
		const current = await open();
		// `codemode` and `tool-search` are the built-ins the durable path replaces with its own native tools; the other
		// four load as they are.
		const loaded = current.services.resourceLoader
			.getExtensions()
			.extensions.map((extension) => extension.path)
			.filter((path) => path.startsWith("builtin:"));
		expect(loaded.sort()).toEqual(["builtin:cliproxyapi", "builtin:herdr", "builtin:llama.cpp", "builtin:mcp"]);

		// The providers they register reach the durable model runtime, which is what makes `--provider` resolve.
		const providers = current.modelRuntime.getProviders().map((provider) => provider.id);
		expect(providers).toContain(LLAMA_PROVIDER_ID);
		expect(providers).toContain("cliproxyapi");

		// RPC `get_commands` and the durable TUI's slash dispatch read this list, so it is the extension command surface.
		const commands = getDurableExtensionCommands(current.extensionHost.runner)
			.map((command) => command.invocationName)
			.sort();
		expect(commands).toEqual([
			"continue",
			"cpa-doctor",
			"cpa-hide",
			"cpa-models",
			"cpa-overrides",
			"cpa-pin",
			"cpa-quota",
			"cpa-refresh",
			"cpa-show",
			"cpa-usage",
			"fast",
			"llama",
			"mcp",
			"pause",
		]);
		expect((await settlement(current.controller.submitAndWait("hi", "followUp"))).status).toBe("done");
	});
});
