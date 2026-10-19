import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { settlement } from "./durable-submission.ts";

/**
 * A fork's extension lifecycle. Legacy replaces the session, so it emits `session_before_fork` (cancellable), then
 * `session_shutdown` with reason `fork`, then `session_start` with the new session file. A durable fork makes a new
 * conversation inside the same session, so the file is unchanged; the events still bracket the move, which is what lets
 * an extension rebuild its state for the conversation the controller talks to.
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

describe("durable fork lifecycle", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-fork-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-fork-cwd-"));
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

	/** Opens a session whose probe records every lifecycle event as `event:fields`. */
	async function open(records: string[], cancel: () => boolean): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses([
			() => fauxAssistantMessage([fauxText("first")]),
			() => fauxAssistantMessage([fauxText("second")]),
		]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		const probe: InlineExtension = (pi) => {
			pi.on("session_before_fork", (event) => {
				records.push(`session_before_fork:${event.entryId}:${event.position}`);
				return cancel() ? { cancel: true } : undefined;
			});
			pi.on("session_shutdown", (event) => {
				records.push(`session_shutdown:${event.reason}`);
			});
			pi.on("session_start", (event, ctx) => {
				records.push(
					`session_start:${event.reason}:${event.previousSessionFile ?? ""}:${String(ctx.sessionManager.getLeafId())}`,
				);
			});
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, probe],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	async function firstUserEntryId(current: OpenDurableResult): Promise<string> {
		const entries = await current.sessionOps.entries(undefined);
		const user = entries.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (user === undefined) throw new Error("the session has no user entry");
		return user.id;
	}

	test("a fork asks first, then shuts the session down and starts the forked conversation", async () => {
		const records: string[] = [];
		const current = await open(records, () => false);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		expect(records).toEqual(["session_start:startup::null"]);
		const entryId = await firstUserEntryId(current);
		const sessionFile = join(current.view.current().session.directory, "session.sqlite");

		const forked = await current.sessionOps.fork(entryId);
		if (forked.cancelled) throw new Error("the fork was cancelled");
		// The question comes before the fork, and the shutdown after it; the start waits for the move.
		expect(records).toEqual([
			"session_start:startup::null",
			`session_before_fork:${entryId}:before`,
			"session_shutdown:fork",
		]);
		await current.controller.switchConversation(forked.conversationId);
		const forkedLeaf = String(current.view.current().conversation.entries.at(-1)?.id);
		// A durable fork keeps the session file, so the start names the file it came from (Decision #24).
		expect(records).toEqual([
			"session_start:startup::null",
			`session_before_fork:${entryId}:before`,
			"session_shutdown:fork",
			`session_start:fork:${sessionFile}:${forkedLeaf}`,
		]);
		expect((await settlement(current.controller.submitAndWait("again", "followUp"))).status).toBe("done");
	});

	test("a cancelled fork forks nothing and keeps the session as it was", async () => {
		const records: string[] = [];
		const current = await open(records, () => true);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		const entryId = await firstUserEntryId(current);
		const conversations = current.view.current().conversations;

		expect(await current.sessionOps.fork(entryId)).toEqual({ cancelled: true });
		expect(records).toEqual(["session_start:startup::null", `session_before_fork:${entryId}:before`]);
		expect(current.view.current().conversations).toEqual(conversations);
		// The conversation the user talks to is still the original one, and it still answers.
		expect((await settlement(current.controller.submitAndWait("after", "followUp"))).status).toBe("done");
		expect(records).toEqual(["session_start:startup::null", `session_before_fork:${entryId}:before`]);
	});

	test("a clone asks about the newest entry with position at, and can be cancelled", async () => {
		const records: string[] = [];
		const current = await open(records, () => true);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		const entries = await current.sessionOps.entries(undefined);

		expect(await current.sessionOps.clone()).toEqual({ cancelled: true });
		expect(records).toEqual(["session_start:startup::null", `session_before_fork:${String(entries.leafId)}:at`]);
	});

	test("the fork is asked about before the entry is validated, as legacy does", async () => {
		const records: string[] = [];
		const current = await open(records, () => true);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");

		expect(await current.sessionOps.fork("no-such-entry")).toEqual({ cancelled: true });
		expect(records).toEqual(["session_start:startup::null", "session_before_fork:no-such-entry:before"]);

		// Without a handler that cancels, the invalid entry is refused after the question and nothing is forked.
		await current.close();
		session = undefined;
		records.length = 0;
		const unfiltered = await open(records, () => false);
		await expect(unfiltered.sessionOps.fork("no-such-entry")).rejects.toThrow("Entry not found: no-such-entry");
		expect(records).toEqual(["session_start:startup::null", "session_before_fork:no-such-entry:before"]);
	});
});
