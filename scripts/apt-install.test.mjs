// Tests for .github/scripts/apt-install.sh with a stub `sudo` on PATH. Unix only: the script is bash.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, ".github", "scripts", "apt-install.sh");
const directories = [];

after(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/**
 * Runs the script with a stub `sudo`. `failures` says how the stub's apt-get fails: `updateLock` and `installLock`
 * count the calls that report a held lock, `updateNetwork` the calls that report a transient network error, and
 * `updateOther` makes every update fail with an error that is not retried.
 */
function run(failures) {
	const directory = mkdtempSync(join(tmpdir(), "apt-install-test-"));
	directories.push(directory);
	const calls = join(directory, "calls.txt");
	writeFileSync(calls, "");
	const stub = join(directory, "sudo");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			'echo "$4" >> "$FAKE_CALLS"',
			'count() { grep -c "^$1\\$" "$FAKE_CALLS"; }',
			'if [ "$4" = "update" ]; then',
			'  n=$(count update)',
			'  if [ "$n" -le "$FAKE_UPDATE_LOCK" ]; then echo "E: Could not get lock /var/lib/apt/lists/lock"; exit 100; fi',
			'  if [ "$n" -le "$FAKE_UPDATE_LOCK_PLUS_NETWORK" ]; then echo "E: Failed to fetch http://mirror/Packages"; exit 100; fi',
			'  if [ "$FAKE_UPDATE_OTHER" = "1" ]; then echo "E: Something else broke"; exit 100; fi',
			"fi",
			'if [ "$4" = "install" ]; then',
			'  n=$(count install)',
			'  if [ "$n" -le "$FAKE_INSTALL_LOCK" ]; then echo "E: Unable to acquire the dpkg frontend lock"; exit 100; fi',
			"fi",
			"echo ok",
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);
	const result = spawnSync("bash", [script, "pkg1", "pkg2"], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${directory}:${process.env.PATH}`,
			APT_RETRY_DELAY: "0",
			FAKE_CALLS: calls,
			FAKE_UPDATE_LOCK: String(failures.updateLock ?? 0),
			FAKE_UPDATE_LOCK_PLUS_NETWORK: String((failures.updateLock ?? 0) + (failures.updateNetwork ?? 0)),
			FAKE_INSTALL_LOCK: String(failures.installLock ?? 0),
			FAKE_UPDATE_OTHER: failures.updateOther ? "1" : "0",
		},
	});
	const commands = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
	return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: commands };
}

const unix = { skip: process.platform === "win32" ? "bash script" : false };

describe("apt-install.sh", unix, () => {
	test("retries a held apt lock on the index and then succeeds", () => {
		const result = run({ updateLock: 2 });
		assert(result.status === 0, result.output);
		assert(result.calls.join(",") === "update,update,update,install", result.calls.join(","));
	});

	test("does not repeat a successful index refresh when the install is retried", () => {
		const result = run({ installLock: 2 });
		assert(result.status === 0, result.output);
		assert(result.calls.join(",") === "update,install,install,install", result.calls.join(","));
	});

	test("retries a transient network error the same way", () => {
		const result = run({ updateNetwork: 1 });
		assert(result.status === 0, result.output);
		assert(result.calls.length === 3, result.calls.join(","));
	});

	test("gives up after the attempt limit with a message, not a silent success", () => {
		const result = run({ updateLock: 100 });
		assert(result.status === 1, `status ${result.status}`);
		assert(result.calls.length === 8, `calls ${result.calls.length}`);
		assert(result.output.includes("still busy or unreachable"), result.output);
	});

	test("stops at once on an apt error that is not a lock or a network error", () => {
		const result = run({ updateOther: true });
		assert(result.status === 100, `status ${result.status}`);
		assert(result.calls.length === 1, result.calls.join(","));
	});
});

function assert(condition, message) {
	if (!condition) throw new Error(message);
}
