#!/usr/bin/env node
/**
 * Run the package test suites under Bun.
 *
 * Usage:
 *   node scripts/test-bun.mjs [package]...
 *
 * Needs `bun` on PATH and a built workspace (`npm run build`): cross-package imports resolve
 * to dist. Only packages whose suites pass on Bun are listed; add a package here once its
 * Bun-only failures are fixed. vitest suites run with `bun --bun` so the test workers use Bun
 * rather than Node; packages/tui uses node:test, which `bun test` runs directly.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const SUITES = {
	agent: ["--bun", vitestBin, "--run"],
	chord: ["--bun", vitestBin, "--run"],
	client: ["--bun", vitestBin, "--run"],
	codemode: ["--bun", vitestBin, "--run"],
	durable: ["--bun", vitestBin, "--run"],
	ai: ["--bun", vitestBin, "--run"],
	mcp: ["--bun", vitestBin, "--run"],
	protocol: ["--bun", vitestBin, "--run"],
	server: ["--bun", vitestBin, "--run"],
	telemetry: ["--bun", vitestBin, "--run"],
	tui: ["test", "test/"],
};

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in SUITES));
if (unknown.length > 0) {
	console.error(`Unknown package ${unknown.join(", ")}. Valid: ${Object.keys(SUITES).join(", ")}`);
	process.exit(1);
}

const failed = [];
for (const name of requested.length > 0 ? requested : Object.keys(SUITES)) {
	console.log(`\n==> ${name} (bun ${SUITES[name].join(" ")})`);
	const result = spawnSync("bun", SUITES[name], { cwd: join(repoRoot, "packages", name), stdio: "inherit" });
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
