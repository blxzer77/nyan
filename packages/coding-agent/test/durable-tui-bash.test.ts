import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { BashResult } from "../src/core/bash-executor.ts";
import type { OpenDurableResult } from "../src/core/durable/runtime.ts";
import { openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { runUserBash, type UserBashRun } from "../src/modes/durable/bash.ts";
import { settlement } from "./durable-submission.ts";

/**
 * A user's `!` command on the durable path, as the TUI runs it: the `user_bash` handlers first, then the durable
 * executor, and the result written as a `bashExecution` entry. The run drives a real session; only the card it draws
 * into is replaced by a recorder, because a card is terminal output.
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

describe("durable TUI user bash", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;
	let chunks: string[];
	let finished: BashResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-bash-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-bash-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("NYAN_OFFLINE", "1");
		chunks = [];
		finished = undefined;
		session = undefined;
	});

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
		vi.unstubAllEnvs();
		const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
		await Promise.all([rm(home, options), rm(cwd, options)]);
	});

	async function open(extension?: InlineExtension): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses([() => fauxAssistantMessage([fauxText("answered")])]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: extension === undefined ? [provider] : [provider, extension],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	/** Run one command the way the TUI does, with a recorder in place of the card. */
	async function run(
		current: OpenDurableResult,
		command: string,
		excludeFromContext = false,
		overrides: { readonly execute?: UserBashRun["execute"] } = {},
	): Promise<Awaited<ReturnType<typeof runUserBash>>> {
		return runUserBash({
			command,
			excludeFromContext,
			cwd,
			extensionHost: current.extensionHost,
			execute:
				overrides.execute ??
				((text, excluded, onChunk, operations) =>
					current.controller.executeBash(text, excluded, onChunk, operations)),
			record: (text, result, excluded) => current.controller.recordBashResult(text, result, excluded),
			view: {
				append: (chunk) => {
					chunks.push(chunk);
				},
				finish: (result) => {
					finished = result;
				},
			},
		});
	}

	/** The `bashExecution` entries the conversation holds, with the messages the model sees for each. */
	function bashEntries(current: OpenDurableResult): {
		readonly data: Record<string, unknown>;
		readonly model: readonly { readonly role: string; readonly content: unknown }[];
	}[] {
		return current.view
			.current()
			.conversation.entries.filter((entry) => entry.kind === "bashExecution")
			.map((entry) => ({
				data: (entry.data ?? {}) as Record<string, unknown>,
				model: (entry.model ?? []) as readonly { role: string; content: unknown }[],
			}));
	}

	test("a command runs, streams its output, and is recorded for the model", async () => {
		const current = await open();

		const outcome = await run(current, "printf 'bash-ok\\n'");

		expect(outcome).toEqual({ status: "ran" });
		expect(finished?.exitCode).toBe(0);
		expect(chunks.join("")).toBe("bash-ok\n");
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({
			command: "printf 'bash-ok\\n'",
			output: "bash-ok\n",
			exitCode: 0,
			cancelled: false,
			excludeFromContext: false,
		});
		// A `!` command is part of the context: its entry carries the user message the model reads.
		expect(entry?.model).toEqual([expect.objectContaining({ role: "user" })]);
	});

	test("!! keeps the command out of the model context", async () => {
		const current = await open();

		expect(await run(current, "printf 'hidden\\n'", true)).toEqual({ status: "ran" });

		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ excludeFromContext: true, output: "hidden\n" });
		// Nothing reaches the model: the entry carries no message.
		expect(entry?.model).toEqual([]);
	});

	test("a command that fails records its exit code", async () => {
		const current = await open();

		expect(await run(current, "exit 3")).toEqual({ status: "ran" });

		expect(finished?.exitCode).toBe(3);
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ command: "exit 3", exitCode: 3 });
	});

	test("a user_bash result replaces the execution and is recorded as it is", async () => {
		// The command would write to the shell if it ran; the extension's answer is what must be recorded and shown.
		const extension: InlineExtension = (pi) => {
			pi.on("user_bash", () => ({
				result: { output: "from the extension\n", exitCode: 9, cancelled: false, truncated: false },
			}));
		};
		const current = await open(extension);

		const outcome = await run(current, "printf 'should not run\\n'");

		expect(outcome).toEqual({ status: "ran" });
		expect(finished).toEqual({ output: "from the extension\n", exitCode: 9, cancelled: false, truncated: false });
		expect(chunks.join("")).toBe("from the extension\n");
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ output: "from the extension\n", exitCode: 9 });
	});

	test("user_bash operations run the command through them instead of this process's shell", async () => {
		const seen: string[] = [];
		const extension: InlineExtension = (pi) => {
			pi.on("user_bash", (event) => {
				seen.push(event.command);
				return {
					operations: {
						exec: async (command: string) => {
							seen.push(`exec:${command}`);
							return { exitCode: 7 };
						},
					},
				};
			});
		};
		const current = await open(extension);

		expect(await run(current, "printf 'through ops\\n'")).toEqual({ status: "ran" });

		expect(seen).toEqual(["printf 'through ops\\n'", "exec:printf 'through ops\\n'"]);
		expect(finished?.exitCode).toBe(7);
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ exitCode: 7 });
	});

	test("a user_bash handler that throws runs nothing", async () => {
		const extension: InlineExtension = (pi) => {
			pi.on("user_bash", () => {
				throw new Error("the sandbox is unavailable");
			});
		};
		const current = await open(extension);

		const outcome = await run(current, "printf 'never\\n'");

		expect(outcome).toEqual({ status: "extension-failed" });
		expect(finished).toBeUndefined();
		expect(chunks).toEqual([]);
		expect(bashEntries(current)).toEqual([]);
		// The user reads why nothing ran: the runner reports the handler it could not complete, and the session keeps
		// that report among the notices the interface shows. Nothing else on this path reports it, so the notice is
		// the only failure notice the TUI has; `inline:1` is the provider extension and `inline:2` this one.
		expect(current.view.current().notices.map((notice) => [notice.level, notice.message])).toEqual([
			["error", "Extension <inline:2> failed on user_bash: the sandbox is unavailable"],
		]);
	});

	test("a command with no output finishes with an empty result", async () => {
		const current = await open();

		expect(await run(current, "printf ''")).toEqual({ status: "ran" });

		expect(finished).toEqual({ output: "", exitCode: 0, cancelled: false, truncated: false });
		expect(chunks).toEqual([]);
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ command: "printf ''", output: "", exitCode: 0, cancelled: false });
	});

	test("output past the limit is truncated, and the full output is kept for reading", async () => {
		const current = await open();
		const command = "node -e \"process.stdout.write('x'.repeat(200000))\"";

		expect(await run(current, command)).toEqual({ status: "ran" });

		expect(finished?.truncated).toBe(true);
		// A truncated result names the file holding everything, and the file holds everything.
		const path = finished?.fullOutputPath;
		expect(path).toBeDefined();
		const full = await readFile(path ?? "", "utf8");
		expect(full.length).toBe(200_000);
		await rm(path ?? "", { force: true });
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ truncated: true, command });
	});

	test("a cancelled command keeps the output it produced and is recorded as cancelled", async () => {
		const current = await open();

		const running = run(current, "printf 'before\\n'; sleep 30; printf 'after\\n'");
		// Abort once output arrives, as escape does in the TUI.
		await new Promise<void>((resolve) => {
			const poll = setInterval(() => {
				if (chunks.length === 0) return;
				clearInterval(poll);
				current.controller.abortBash();
				resolve();
			}, 20);
		});

		expect(await running).toEqual({ status: "ran" });
		expect(finished?.cancelled).toBe(true);
		expect(finished?.output).toContain("before");
		expect(finished?.output).not.toContain("after");
		const [entry] = bashEntries(current);
		expect(entry?.data).toMatchObject({ cancelled: true });
	});

	test("an executor that throws leaves the card for the caller to report", async () => {
		const current = await open();

		// runUserBash does not swallow a failed execution: the TUI's caller reports it and abandons the card, so the
		// failure reaches the user instead of leaving a card spinning.
		await expect(
			run(current, "printf 'never\\n'", false, {
				execute: async () => {
					throw new Error("spawn /bin/bash ENOENT");
				},
			}),
		).rejects.toThrow("spawn /bin/bash ENOENT");

		expect(finished).toBeUndefined();
		expect(bashEntries(current)).toEqual([]);
	});

	test("a recorded command is answered by the model on the next prompt", async () => {
		const current = await open();
		await run(current, "printf 'visible\\n'");

		expect((await settlement(current.controller.submitAndWait("what did it print?", "followUp"))).status).toBe(
			"done",
		);

		// The command is part of the context the next request carries; the answer arrived on top of it.
		const [entry] = bashEntries(current);
		expect(JSON.stringify(entry?.model)).toContain("visible");
		// The positional prompt entry durable keeps for the request is a `system` message; the conversation's own
		// messages are the command, the question, and the answer.
		const roles = current.view
			.current()
			.conversation.entries.flatMap((candidate) => candidate.model ?? [])
			.map((message) => message.role)
			.filter((role) => role !== "system");
		expect(roles).toEqual(["user", "user", "assistant"]);
	});
});
