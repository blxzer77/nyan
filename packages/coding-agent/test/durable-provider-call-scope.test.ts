import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@ny4n/ai/compat";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@ny4n/chord/context";
import type { HookApi } from "@ny4n/durable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createExtensionHost } from "../src/core/durable/extension-host.ts";
import { createDurableServices } from "../src/core/durable/services.ts";
import type { InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";

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

describe("provider call scope", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-scope-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-scope-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	/**
	 * Two provider calls interleave: the first starts and finishes while the second is still waiting. The handler reads
	 * `ctx.model` before and after its await. A shared variable restores the outer value when the first call ends, so
	 * the second call reads the wrong model and its signal is lost.
	 */
	test("concurrent provider calls each see their own model and signal", async () => {
		const first = getModel("anthropic", "claude-sonnet-4-5");
		if (first === undefined) throw new Error("the catalog has no claude-sonnet-4-5");
		const second = { ...first, id: "second-model" };
		const observed: { before: string | undefined; after: string | undefined; signal: AbortSignal | undefined }[] = [];
		const probe: InlineExtension = (pi) => {
			pi.on("before_provider_request", async (_event, ctx) => {
				const before = ctx.model?.id;
				await new Promise((resolve) => setTimeout(resolve, before === "second-model" ? 30 : 5));
				observed.push({ before, after: ctx.model?.id, signal: ctx.signal });
				return undefined;
			});
		};
		const services = await createDurableServices({
			cwd,
			agentDir,
			resources: {},
			extensionFactories: [probe],
			projectTrustContext: { ...headless, cwd },
		});
		const host = createExtensionHost({
			services,
			cwd,
			agentModel: () => undefined,
			abort: () => {},
			compact: () => {},
			onExtensionError: () => {},
		});
		const member = host.providerHooks.beforeProviderRequest;
		if (member === undefined) throw new Error("no before_provider_request member was registered");

		const firstCall = new AbortController();
		const secondCall = new AbortController();
		const api = {} as HookApi;
		await Promise.all([
			member({ payload: {}, model: first }, api, withAbortSignal(firstCall.signal, BACKGROUND_CONTEXT)),
			member({ payload: {}, model: second }, api, withAbortSignal(secondCall.signal, BACKGROUND_CONTEXT)),
		]);

		expect(observed).toHaveLength(2);
		const byModel = new Map(observed.map((entry) => [entry.before, entry]));
		const forFirst = byModel.get(first.id);
		const forSecond = byModel.get("second-model");
		expect(forFirst?.after).toBe(first.id);
		expect(forFirst?.signal).toBe(firstCall.signal);
		expect(forSecond?.after).toBe("second-model");
		expect(forSecond?.signal).toBe(secondCall.signal);
	});
});
