// Runs the suite a second time with NYAN_DURABLE_DOCUMENT_RETENTION_MS=0, which evicts every unattached document
// right away. `VAR=0 command` is POSIX shell syntax, so `npm test` cannot spell this itself on Windows.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
const result = spawnSync(process.execPath, [join(dirname(vitestPackage), "vitest.mjs"), "--run"], {
	stdio: "inherit",
	env: { ...process.env, NYAN_DURABLE_DOCUMENT_RETENTION_MS: "0" },
});
process.exit(result.status ?? 1);
