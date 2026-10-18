import { afterEach, describe, expect, test, vi } from "vitest";
import { codemodeWorkersInFlight } from "../src/core/codemode-workers.ts";
import { createCodemodeSandbox } from "../src/core/durable/native-tools.ts";

/**
 * The durable codemode sandbox shares the process's worker slots with the legacy codemode: two scripts may hold a worker
 * at once, and a third is refused until one exits. The limit is kept as it is; the refusal is not queued.
 */

// The sandbox has no timers: a script that holds its worker does so with work. The loop takes a few hundred ms in QuickJS.
const SLOW = "let total = 0; for (let i = 0; i < 3000000; i++) total += i; text(String(total));";

describe("durable codemode worker slots", () => {
	afterEach(async () => {
		// A test ends when its workers have exited, so the next one starts with every slot free.
		await vi.waitFor(() => expect(codemodeWorkersInFlight()).toBe(0), { timeout: 15_000 });
	});

	test("two scripts run at once; a third is refused while both still hold their workers", async () => {
		const sandbox = createCodemodeSandbox();
		try {
			const settled = await Promise.allSettled([
				sandbox.execute(SLOW, {}),
				sandbox.execute(SLOW, {}),
				sandbox.execute(SLOW, {}),
			]);
			const [first, second, third] = settled;
			expect(first.status === "fulfilled" && first.value.ok).toBe(true);
			expect(second.status === "fulfilled" && second.value.ok).toBe(true);
			const refused = third.status === "rejected" ? String(third.reason) : JSON.stringify(third.value);
			expect(refused).toContain("Codemode worker limit reached");
		} finally {
			await sandbox.close();
		}
	});

	test("a script runs again once the workers of earlier scripts have exited", async () => {
		const sandbox = createCodemodeSandbox();
		try {
			await Promise.allSettled([sandbox.execute(SLOW, {}), sandbox.execute(SLOW, {})]);
			await vi.waitFor(() => expect(codemodeWorkersInFlight()).toBe(0), { timeout: 15_000 });
			const again = await sandbox.execute("text('again');", {});
			expect(again.ok).toBe(true);
		} finally {
			await sandbox.close();
		}
	});
});
