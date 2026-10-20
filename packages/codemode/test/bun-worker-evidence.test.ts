import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox, type CodemodeTool } from "../src/index.ts";

/**
 * Evidence that a worker is really gone, not that it merely stopped answering.
 *
 * A script that spins forever cannot end its own execution: `while (true) {}` never yields to the
 * event loop, and `while (true) await null` never settles. Both cases therefore end only when the
 * host terminates the worker. Two facts prove that here, and neither is a wall-clock guess:
 *
 * 1. The script calls a host tool first, so the worker is known to be running the script (and the
 *    deadline or the abort is triggered only after that call, never while the worker starts up).
 * 2. `onWorkerStarted` hands back a promise that resolves when that worker's own `exit` event
 *    fires, so the test waits for the worker to be gone instead of measuring how long a call took.
 */

/** How long a test may wait for that `exit` event before the test fails instead of hanging. */
const EXIT_BUDGET_MS = 20_000;
/** A deadline long enough that the worker's start-up cannot be mistaken for it, and short enough to keep the test quick. */
const DEADLINE_MS = 2_000;
/** A hang guard for the whole execution, far above the deadline: it never decides anything by itself. */
const SETTLE_GUARD_MS = 30_000;

const sandboxes: CodemodeSandbox[] = [];

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

type Gate = {
	/** The tool the script calls before it starts spinning. */
	readonly tool: CodemodeTool;
	/** Resolves when the script reached that call, so the worker is running it. */
	readonly reached: Promise<void>;
	/** Whether the call arrived; a settled execution that never reached it proves nothing. */
	reachedCall(): boolean;
};

/** A host tool the script calls once, which tells the test the worker is running the script. */
function gate(): Gate {
	let reached = false;
	let arrive: () => void = () => {};
	const arrived = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	return {
		tool: {
			name: "gate",
			execute: () => {
				reached = true;
				arrive();
			},
		},
		reached: arrived,
		reachedCall: () => reached,
	};
}

/** Wait for a worker's own `exit` event; reject rather than hang when it never comes. */
async function awaitExit(exited: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`the worker had not exited ${EXIT_BUDGET_MS} ms after its script settled`)),
			EXIT_BUDGET_MS,
		);
	});
	try {
		await Promise.race([exited, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Record each worker's `exit` promise as it starts. */
function exits(): { collect: (exited: Promise<void>) => void; last(): Promise<void> } {
	const seen: Promise<void>[] = [];
	return {
		collect: (exited) => seen.push(exited),
		last: () => {
			const exited = seen.at(-1);
			if (exited === undefined) throw new Error("no worker was started");
			return exited;
		},
	};
}

describe("worker wasm lifecycle", () => {
	it("terminates the worker that spins in wasm until the deadline", async () => {
		const started = gate();
		const workers = exits();
		const sandbox = new CodemodeSandbox({
			timeoutMs: DEADLINE_MS,
			onWorkerStarted: workers.collect,
			tools: [started.tool],
		});
		sandboxes.push(sandbox);
		const began = performance.now();

		const pending = sandbox.execute("await tools.gate(); while (true) {}", { timeoutMs: DEADLINE_MS });
		const result = await pending;

		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		// The script ran: without this the run could have timed out before the worker did anything.
		expect(started.reachedCall()).toBe(true);
		// The deadline is what ended it: a shorter path would have settled below it.
		expect(performance.now() - began).toBeGreaterThanOrEqual(DEADLINE_MS);
		expect(performance.now() - began).toBeLessThan(SETTLE_GUARD_MS);
		// And the spinning worker is gone, not merely unresponsive.
		await awaitExit(workers.last());
	});

	it("terminates the worker that spins in the microtask queue until the caller aborts", async () => {
		const started = gate();
		const workers = exits();
		const controller = new AbortController();
		const sandbox = new CodemodeSandbox({ onWorkerStarted: workers.collect, tools: [started.tool] });
		sandboxes.push(sandbox);

		const pending = sandbox.execute("await tools.gate(); while (true) await null", {
			signal: controller.signal,
			timeoutMs: SETTLE_GUARD_MS,
		});
		// Abort only once the script is in its loop, so the interrupt is what a running worker meets.
		const early = await Promise.race([started.reached.then(() => undefined), pending]);
		expect(early).toBeUndefined();
		controller.abort(new Error("user cancelled"));

		const result = await pending;
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "user cancelled" } });
		expect(started.reachedCall()).toBe(true);
		await awaitExit(workers.last());
	});
});
