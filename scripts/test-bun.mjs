#!/usr/bin/env node
/**
 * Run the package test suites under Bun.
 *
 * Usage:
 *   node scripts/test-bun.mjs [package]...
 *
 * Needs `bun` on PATH and a built workspace (`npm run build`): cross-package imports resolve
 * to dist. Every workspace package is listed; a suite that fails here is a difference between the runtimes to fix,
 * not a package to drop. vitest suites run with `bun --bun` so the test workers use Bun
 * rather than Node; packages/tui uses node:test, which `bun test` runs directly.
 *
 * On Windows the script resolves Bun's real `bun.exe` instead of the `bun.cmd` shim; see
 * `bun-command.mjs` for why the shell is not a substitute.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable } from "./bun-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const bun = resolveBunExecutable();

const SUITES = {
	agent: ["--bun", vitestBin, "--run"],
	chord: ["--bun", vitestBin, "--run"],
	client: ["--bun", vitestBin, "--run"],
	codemode: ["--bun", vitestBin, "--run"],
	"coding-agent": ["--bun", vitestBin, "--run"],
	durable: ["--bun", vitestBin, "--run"],
	ai: ["--bun", vitestBin, "--run"],
	mcp: ["--bun", vitestBin, "--run"],
	protocol: ["--bun", vitestBin, "--run"],
	server: ["--bun", vitestBin, "--run"],
	telemetry: ["--bun", vitestBin, "--run"],
	tui: ["test", "test/"],
};

const shardArgument = process.argv.slice(2).find((arg) => arg.startsWith("--shard="));
const shard = shardArgument === undefined ? undefined : shardArgument.slice("--shard=".length);
if (shard !== undefined && !/^\d+\/\d+$/.test(shard)) {
	console.error(`--shard must look like 1/4, got ${shard}`);
	process.exit(1);
}
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--shard="));
const unknown = requested.filter((name) => !(name in SUITES));
if (unknown.length > 0) {
	console.error(`Unknown package ${unknown.join(", ")}. Valid: ${Object.keys(SUITES).join(", ")}`);
	process.exit(1);
}

const failed = [];
for (const name of requested.length > 0 ? requested : Object.keys(SUITES)) {
	// tui runs node:test, which has no shard option. Refuse rather than run every test while claiming a shard.
	if (shard !== undefined && name === "tui") {
		console.error("tui uses node:test, which does not support --shard");
		process.exit(1);
	}
	const args = shard === undefined ? SUITES[name] : [...SUITES[name], `--shard=${shard}`];
	console.log(`\n==> ${name} (bun ${args.join(" ")})`);
	const result = spawnSync(bun, args, { cwd: join(repoRoot, "packages", name), stdio: "inherit" });
	if (result.error) {
		console.error(`bun could not start: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) failed.push(name);
}

if (failed.length > 0) {
	console.error(`\nFailed under Bun: ${failed.join(", ")}`);
	process.exit(1);
}
