import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PauseController, persistPausePreference, waitForPauseToEnd } from "../src/extensions/cliproxyapi/pause.ts";

/**
 * The pause wait keeps its timer referenced, so a paused request keeps a print run alive. That is deliberate. An abort
 * must still leave nothing behind: the timer is cleared, and a process whose wait was aborted exits by itself.
 */
describe("pause wait and abort", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "nyan-pause-exit-"));
		persistPausePreference(agentDir, true);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await rm(agentDir, { recursive: true, force: true });
	});

	test("an abort clears the pause timer", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const wait = waitForPauseToEnd(agentDir, new PauseController(true), controller.signal);
		const settled = wait.then(
			() => "resolved",
			() => "rejected",
		);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort(new Error("request aborted"));
		expect(vi.getTimerCount()).toBe(0);
		await expect(settled).resolves.toBe("rejected");
	});

	test("a Node process whose pause wait was aborted exits on its own", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const moduleUrl = pathToFileURL(join(here, "..", "src", "extensions", "cliproxyapi", "pause.ts")).href;
		const script = [
			`import(${JSON.stringify(moduleUrl)}).then(async (pause) => {`,
			"  const controller = new AbortController();",
			`  const wait = pause.waitForPauseToEnd(${JSON.stringify(agentDir)}, new pause.PauseController(true), controller.signal);`,
			'  setTimeout(() => controller.abort(new Error("request aborted")), 50);',
			"  await wait.catch(() => undefined);",
			'  console.log("settled");',
			"});",
		].join("\n");
		const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
		expect(run.error).toBeUndefined();
		expect(run.status).toBe(0);
		expect(run.stdout.trim()).toBe("settled");
	});
});
