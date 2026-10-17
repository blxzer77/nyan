import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "publish-packages.mjs");

// A stand-in for npm. `view` answers like the registry for the names in FAKE_PUBLISHED; every other command is
// recorded in FAKE_NPM_LOG and succeeds, unless it is `pack` and FAKE_PACK_FAILS is set.
// CommonJS, because it is written to a file without an extension and to a .js file outside any package.
const fakeNpm = `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "view") {
	const published = (process.env.FAKE_PUBLISHED ?? "").split(",").filter(Boolean);
	if (published.includes(args[1])) { console.log(JSON.stringify("1.0.0")); process.exit(0); }
	process.stderr.write("npm error code E404\\n");
	process.exit(1);
}
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
process.exit(args[0] === "pack" && process.env.FAKE_PACK_FAILS ? 1 : 0);
`;

/** A workspace of two public packages (beta depends on alpha) and a fake npm, then runs the script in it. */
function run(t, args, env = {}) {
	const root = mkdtempSync(join(tmpdir(), "nyan-publish-packages-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, dependencies] of [["alpha", {}], ["beta", { "@test/alpha": "1.0.0" }]]) {
		mkdirSync(join(root, "packages", name), { recursive: true });
		writeFileSync(
			join(root, "packages", name, "package.json"),
			JSON.stringify({ name: `@test/${name}`, version: "1.0.0", dependencies }),
		);
	}
	const bin = join(root, "bin");
	mkdirSync(bin);
	// Windows runs npm through npm_execpath; other platforms look `npm` up on PATH.
	writeFileSync(join(bin, "npm-cli.js"), fakeNpm);
	writeFileSync(join(bin, "npm"), `#!/usr/bin/env node${fakeNpm}`);
	chmodSync(join(bin, "npm"), 0o755);
	const log = join(root, "npm.log");
	writeFileSync(log, "");

	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH}`,
			npm_execpath: join(bin, "npm-cli.js"),
			FAKE_NPM_LOG: log,
			...env,
		},
	});
	const calls = readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.map((call) => ({ command: call[0], target: call[1].split(/[\\/]/).at(-1), flags: call.slice(2) }));
	return { ...result, calls };
}

test("a dry run packs a version that is already published instead of publishing it", (t) => {
	const result = run(t, ["--dry-run"], { FAKE_PUBLISHED: "@test/alpha@1.0.0,@test/beta@1.0.0" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /@test\/alpha@1\.0\.0 already published; packed only/);
	assert.match(result.stdout, /@test\/beta@1\.0\.0 already published; packed only/);
	// Dependency order, and the tarball contents are still checked: pack, never publish.
	assert.deepEqual(
		result.calls.map((call) => [call.command, call.target]),
		[
			["pack", "alpha"],
			["pack", "beta"],
		],
	);
	for (const call of result.calls) {
		assert.ok(call.flags.includes("--dry-run"), "pack runs with --dry-run");
		assert.ok(call.flags.includes("--ignore-scripts"), "pack runs without lifecycle scripts");
	}
});

test("a dry run still dry-run publishes a version that is not on the registry", (t) => {
	const result = run(t, ["--dry-run"], { FAKE_PUBLISHED: "@test/alpha@1.0.0" });

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		result.calls.map((call) => [call.command, call.target]),
		[
			["pack", "alpha"],
			["publish", "beta"],
		],
	);
	assert.ok(result.calls[1].flags.includes("--dry-run"));
	assert.doesNotMatch(result.stdout, /@test\/beta@1\.0\.0 already published/);
});

test("a real run still skips a published version and publishes the rest", (t) => {
	const result = run(t, [], { FAKE_PUBLISHED: "@test/alpha@1.0.0" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /@test\/alpha@1\.0\.0 is already published, skipping/);
	assert.deepEqual(
		result.calls.map((call) => [call.command, call.target]),
		[["publish", "beta"]],
	);
	assert.ok(!result.calls[0].flags.includes("--dry-run"));
});

test("a failing pack fails the dry run and names the package", (t) => {
	const result = run(t, ["--dry-run"], { FAKE_PUBLISHED: "@test/alpha@1.0.0", FAKE_PACK_FAILS: "1" });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /npm pack failed for @test\/alpha/);
	assert.deepEqual(
		result.calls.map((call) => call.command),
		["pack"],
		"stops at the first failure",
	);
});
