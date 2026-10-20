import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@ny4n/ai";
import { type Harness, LiveDoc, MemoryStorage, type TaskId } from "@ny4n/durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addSection } from "./harness-support.ts";
import { context } from "./session-support.ts";

/**
 * `Conversation.stopRetry()`: the durable stand-in for legacy `abort_retry`. The `retry` phase of the generation waits
 * for the backoff with `runtime.retrySleep`, under a controller this request cancels on its own, so a stop ends the wait
 * (and the run) at once while an abort of the task still ends it as aborted.
 */

const ERROR_503 = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
/** Longer than any test waits, so the backoff can only end by a stop request, never by the clock. */
const LONG_BACKOFF_MS = 60_000;

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nyan-durable-stop-retry-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Settings that retry a retryable error after a backoff no test would wait out. */
function longBackoff(setup: ChatSetup): void {
	setup.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: LONG_BACKOFF_MS };
}

async function runTaskId(harness: Harness): Promise<TaskId> {
	const live = await harness.snapshot(LiveDoc, 1 as never, context);
	return live!.run!.taskId;
}

describe("stop retry", () => {
	it("ends a retry wait at once with the error the stopped attempt failed on", async () => {
		const setup = chatSetup();
		addSection(setup.registry, "preamble", () => "p", { tag: false });
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		// A pinned clock: the backoff deadline is `clock + LONG_BACKOFF_MS`, and no timer can reach it during the test.
		setup.now = () => 1_000;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const values: { retry?: { error: string } }[] = [];
		harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "document" && change.record.kind === "nyan.live" && change.value !== null) {
					values.push((change.value as { generation?: { retry?: { error: string } } }).generation ?? {});
				}
			}
		});
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => values.some((value) => value.retry?.error === "503 Service Unavailable"));

		const started = Date.now();
		expect(await root.stopRetry()).toBe(true);
		const settledAt = Date.now();
		const settled = await submission.wait(context);

		// The wait ended without the clock reaching the deadline, and without the backoff elapsing in real time either.
		expect(setup.now()).toBe(1_000);
		expect(settledAt - started).toBeLessThan(LONG_BACKOFF_MS / 10);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 Service Unavailable" });
		expect(setup.faux.state.callCount).toBe(1);
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.state).toMatchObject({
			outcome: {
				status: "failed",
				error: { message: "503 Service Unavailable", detail: { reason: "model_error" } },
			},
		});
		// The failed attempt stays the last entry, as when retries run out.
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual([
			"nyan.user",
			"nyan.system",
			"nyan.assistant",
		]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("still ends as aborted when the task is aborted during the retry wait", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.retry !== undefined);

		await root.abort(context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.state).toMatchObject({ outcome: { status: "aborted" } });
		// An abort is not a stopped retry: no stop request was needed.
		expect(await root.stopRetry()).toBe(false);
		await harness.close(context);
	});

	it("does nothing when no retry is waiting", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		expect(await root.stopRetry()).toBe(false);
		expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
		// Idle and after a completed run no request is waiting either, and the session keeps working.
		expect(await root.stopRetry()).toBe(false);
		expect((await (await root.submit({ type: "input", content: "again" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	it("resumes the retry wait after a restart, and a new request stops it", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		addSection(setup.registry, "preamble", () => "p", { tag: false });
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.retry !== undefined,
		);
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);
		expect(setup.faux.state.callCount).toBe(1);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		const resumed = await opened.harness.getTask(taskId, context);
		// The request was never written: the reopened task waits out the backoff again.
		expect(resumed?.state).toMatchObject({ status: "pending", checkpoint: { phase: "retry", until: 61_000 } });
		opened.harness.resume();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(setup.faux.state.callCount).toBe(1);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({ checkpoint: { phase: "retry" } });

		expect(await opened.root.stopRetry()).toBe(true);
		const settled = await (await opened.harness.submission(submission.id, context))!.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 Service Unavailable" });
		await opened.harness.close(context);
	});

	it("keeps a request taken before the wait starts and ends the run when it does", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.retry !== undefined,
		);
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		// The reopened task is pending in its retry phase, so the request is taken before any wait exists.
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({ status: "pending" });
		expect(await opened.root.stopRetry()).toBe(true);
		const settled = await (await opened.harness.submission(submission.id, context))!.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 Service Unavailable" });
		expect(setup.faux.state.callCount).toBe(1);
		await opened.harness.close(context);
	});

	it("takes repeated requests for one pending retry and ends it once", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.retry !== undefined,
		);
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		// The phase is still recorded as `retry` and no wait has started, so each request answers for it; the mark is one.
		expect(await opened.root.stopRetry()).toBe(true);
		expect(await opened.root.stopRetry()).toBe(true);
		opened.harness.resume();
		const settled = await (await opened.harness.submission(submission.id, context))!.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 Service Unavailable" });
		expect(setup.faux.state.callCount).toBe(1);
		const task = (await opened.harness.commit((tx) => tx.scanTasks({ conversationId: opened.root.id }, 10), context))
			.items[0];
		expect(task?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "failed", error: { message: "503 Service Unavailable" } },
		});

		// The requests were consumed with that phase: the next retry of the conversation waits, and a new request ends it.
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		const next = await opened.root.submit({ type: "input", content: "again" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.generation?.retry !== undefined,
		);
		expect(setup.faux.state.callCount).toBe(2);
		expect(await opened.root.stopRetry()).toBe(true);
		expect(await next.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "model_error",
			detail: "503 Service Unavailable",
		});
		expect(setup.faux.state.callCount).toBe(2);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({ status: "terminal" });
		await opened.harness.close(context);
	});

	it("ends as aborted when an abort mark lands with the stop request", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.retry !== undefined);
		const taskId = await runTaskId(harness);

		// An abort of the run and a stop of the retry, with the abort mark's commit already on the line: the stop's commit
		// meets the mark and fails, so the run ends the way the abort handler ends it, never as a failed request.
		const marked = harness.abortTask(taskId, context);
		const stopped = root.stopRetry();
		expect(await marked).toBe("marked");
		expect(await stopped).toBe(true);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.state).toMatchObject({ outcome: { status: "aborted" } });
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	it("ends as aborted when the abort mark commits after the stop request", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.retry !== undefined);
		const taskId = await runTaskId(harness);

		// The request cancels the wait first, but its commit is queued behind the abort mark's, which is already requested.
		const stopped = root.stopRetry();
		const marked = harness.abortTask(taskId, context);
		expect(await stopped).toBe(true);
		expect(await marked).toBe("marked");
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.state).toMatchObject({ outcome: { status: "aborted" } });
		await harness.close(context);
	});

	it("faults a retry phase that recorded no error instead of naming one", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		longBackoff(setup);
		setup.now = () => 1_000;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.retry !== undefined);
		const taskId = await runTaskId(harness);
		// Only a persisted state that lost the record reaches this: the commit that parked the retry writes it.
		await root.commit(async (tx) => {
			delete (await tx.doc(LiveDoc, root.id)).generation;
		}, context);

		const message = `Task ${taskId} stopped a retry phase that recorded no error`;
		expect(await root.stopRetry()).toBe(true);
		expect(await submission.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "faulted",
			detail: message,
		});
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "faulted", error: { message } },
		});
		await harness.close(context);
	});
});
