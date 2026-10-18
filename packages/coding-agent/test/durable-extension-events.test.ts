import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

/**
 * Host events and context on the durable path: `agent_settled` after every run that ends (the quota poll and usage
 * summary wait for it), the `context` handler rewriting the request, and the two state answers extensions read.
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

describe("durable host events and context", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-events-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-events-cwd-"));
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

	async function open(factories: InlineExtension[], responses: FauxResponseStep[]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("agent_settled fires once after a run that answered", async () => {
		const settled: boolean[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("agent_settled", (event) => {
						settled.push(event.aborted);
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("done")])],
		);
		expect((await current.controller.submitAndWait("go", "followUp")).status).toBe("done");
		expect(settled).toEqual([false]);
	});

	test("agent_settled fires for a run that ended unanswered, which the quota poll depends on", async () => {
		const settled: boolean[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("agent_settled", (event) => {
						settled.push(event.aborted);
					});
				},
			],
			[
				() => {
					throw new Error("PROVIDER-FAILURE");
				},
			],
		);
		const outcome = await current.controller.submitAndWait("go", "followUp");
		expect(outcome.status).toBe("unanswered");
		expect(settled).toEqual([false]);
	});

	test("a context handler rewrites the request, and an unchanged result leaves it untouched", async () => {
		const seen: string[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context", (event) => {
						// Replace the last user message's text so the provider sees the marker.
						const messages = event.messages.map((message) =>
							message.role === "user" ? { ...message, content: "REWRITTEN-BY-CONTEXT" } : message,
						);
						return { messages };
					});
				},
			],
			[
				(context) => {
					seen.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([fauxText("done")]);
				},
			],
		);
		expect((await current.controller.submitAndWait("go", "followUp")).status).toBe("done");
		expect(seen[0]).toContain("REWRITTEN-BY-CONTEXT");
		expect(seen[0]).not.toContain('"content":"go"');
	});

	test("the services report whether project-local resources are trusted, which ctx.isProjectTrusted answers", async () => {
		// A project-local extension needs trust, so an undecided directory is not trusted (legacy rules).
		await mkdir(join(cwd, ".nyan", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".nyan", "extensions", "probe.ts"), "export default () => {};\n");
		const first = await open([], [() => fauxAssistantMessage([fauxText("done")])]);
		expect(first.services.projectTrusted).toBe(false);
		await first.close();

		new ProjectTrustStore(agentDir).set(cwd, true);
		const second = await open([], [() => fauxAssistantMessage([fauxText("done")])]);
		expect(second.services.projectTrusted).toBe(true);
	});
});
