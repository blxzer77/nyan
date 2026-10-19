import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";

const sandboxes: CodemodeSandbox[] = [];

afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("worker wasm lifecycle", () => {
	it("terminates a worker running a synchronous wasm loop on timeout", async () => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);
		const started = performance.now();

		const result = await sandbox.execute("while (true) {}", { timeoutMs: 200 });

		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("interrupts a worker running a wasm microtask loop on abort", async () => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(new Error("user cancelled")), 100);
		const started = performance.now();

		try {
			const result = await sandbox.execute("while (true) await null", {
				signal: controller.signal,
				timeoutMs: 5_000,
			});

			expect(result).toMatchObject({ ok: false, error: { kind: "aborted", message: "user cancelled" } });
			expect(performance.now() - started).toBeLessThan(5_000);
		} finally {
			clearTimeout(abortTimer);
		}
	});
});
