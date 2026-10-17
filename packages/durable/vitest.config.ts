import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./test/setup-document-retention.ts"],
		// test/tools-images.test.ts asserts that preparing an image on a worker thread keeps the event loop free within
		// 100ms. On a shared CI runner the default pool (one worker per core) saturates every core, which inflates that
		// measurement past the budget even though the worker behaves correctly. Bound the pool in CI so the assertion
		// keeps measuring the worker instead of the runner's scheduler.
		maxWorkers: process.env.CI ? 2 : undefined,
		// The durable suites drive real timers and SQLite I/O. A contended shared runner turns an occasional slow tick into
		// a five-second timeout, so give CI the same headroom a slower workstation would implicitly get.
		testTimeout: process.env.CI ? 15_000 : 5_000,
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@ny4n\/durable$/, replacement: durableSrcIndex },
			{ find: /^@ny4n\/durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
