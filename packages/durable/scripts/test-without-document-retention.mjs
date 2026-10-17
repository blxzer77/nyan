// Runs the suite a second time with NYAN_DURABLE_DOCUMENT_RETENTION_MS=0, which evicts every unattached document
// right away. `VAR=0 command` is POSIX shell syntax, so `npm test` cannot spell this itself on Windows.
//
// Arguments are forwarded to vitest. The suite runs twice, and CI shards pass `--shard=i/n`: without forwarding, the
// shard would select files in the first pass only and run the whole retention pass on every shard.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const vitestPackage = createRequire(import.meta.url).resolve("vitest/package.json");
const result = spawnSync(process.execPath, [join(dirname(vitestPackage), "vitest.mjs"), "--run", ...process.argv.slice(2)], {
	stdio: "inherit",
	env: { ...process.env, NYAN_DURABLE_DOCUMENT_RETENTION_MS: "0" },
});
process.exit(result.status ?? 1);
