import { describe, expect, test, vi } from "vitest";
import { shutdownAfterFork } from "../src/core/durable/session-ops.ts";

/**
 * The extension lifecycle around a fork: `session_shutdown` with reason `fork` runs after the durable fork is committed.
 * A failure there cannot undo the fork, so it is reported and the caller still moves to the new conversation; returning
 * to the previous one would leave the forked conversation unreachable, and a durable conversation cannot be deleted
 * (Decision #40).
 */
describe("shutdown after a fork", () => {
	test("reports a failed shutdown and keeps the fork", async () => {
		const report = vi.fn();
		const host = {
			forkLifecycle: {
				beforeFork: async () => ({ cancelled: false }),
				shutdown: async () => {
					throw new Error("the sandbox could not close");
				},
			},
			report,
		};

		await expect(shutdownAfterFork(host)).resolves.toBeUndefined();

		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0]).toEqual(
			new Error("Extension shutdown after a fork failed: the sandbox could not close"),
		);
	});

	test("says nothing when the shutdown succeeds", async () => {
		const report = vi.fn();
		const host = {
			forkLifecycle: { beforeFork: async () => ({ cancelled: false }), shutdown: async () => {} },
			report,
		};

		await shutdownAfterFork(host);

		expect(report).not.toHaveBeenCalled();
	});

	test("does nothing without an extension lifecycle", async () => {
		const report = vi.fn();

		await expect(shutdownAfterFork({ report })).resolves.toBeUndefined();

		expect(report).not.toHaveBeenCalled();
	});
});
