import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PauseController, persistPausePreference, waitForPauseToEnd } from "../src/extensions/cliproxyapi/pause.ts";

describe("pause gate and abort", () => {
	let agentDir: string;

	afterEach(async () => {
		vi.useRealTimers();
		if (agentDir !== undefined) await rm(agentDir, { recursive: true, force: true });
	});

	test("an abort releases a waiting pause at once, without waiting for the next poll", async () => {
		agentDir = await mkdtemp(join(tmpdir(), "nyan-pause-"));
		persistPausePreference(agentDir, true);
		vi.useFakeTimers();
		const controller = new AbortController();
		let state = "pending";
		const wait = waitForPauseToEnd(agentDir, new PauseController(true), controller.signal).then(
			() => {
				state = "resolved";
			},
			() => {
				state = "rejected";
			},
		);
		// Nothing advances the fake clock: only the abort can settle the wait.
		controller.abort(new Error("request aborted"));
		for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
		expect(state).toBe("rejected");
		await wait;
	});

	test("a wait with no signal still ends when the pause setting is cleared", async () => {
		agentDir = await mkdtemp(join(tmpdir(), "nyan-pause-"));
		persistPausePreference(agentDir, true);
		const wait = waitForPauseToEnd(agentDir, new PauseController(true));
		persistPausePreference(agentDir, false);
		await expect(wait).resolves.toBeUndefined();
	});

	test("a signal that is already aborted rejects before the setting is read", async () => {
		agentDir = await mkdtemp(join(tmpdir(), "nyan-pause-"));
		persistPausePreference(agentDir, false);
		await expect(waitForPauseToEnd(agentDir, new PauseController(false), AbortSignal.abort("gone"))).rejects.toBe(
			"gone",
		);
	});
});
