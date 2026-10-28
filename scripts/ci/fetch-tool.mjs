#!/usr/bin/env node
// Download and verify one pinned tool from .github/quality/tools.lock.json
// (docs/nyan/cicd.md §6.2). The sha256 is checked before anything is
// extracted or executed, so a moved release asset fails the job.
//
// Usage: node scripts/ci/fetch-tool.mjs <tool> [--dest <dir>]
// Prints the absolute path of the executable.
//
// The asset key defaults to x86_64-unknown-linux-musl; pass --asset to use
// another architecture entry.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lock = JSON.parse(readFileSync(resolve(root, ".github/quality/tools.lock.json"), "utf8"));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const toolName = process.argv[2];
if (!toolName || toolName.startsWith("--")) {
  console.error(`usage: fetch-tool.mjs <tool> [--asset <triple>] [--dest <dir>]`);
  process.exit(1);
}

const tool = lock.tools?.[toolName];
if (!tool) {
  console.error(`fetch-tool: ${toolName} is not in tools.lock.json`);
  process.exit(1);
}

const asset = arg("asset") ?? "x86_64-unknown-linux-musl";
const entry = tool.assets?.[asset];
if (!entry) {
  console.error(`fetch-tool: ${toolName} has no asset for ${asset}`);
  process.exit(1);
}

const dest = resolve(arg("dest") ?? join(tmpdir(), "nyan-ci-tools", toolName));
execFileSync("mkdir", ["-p", dest]);

const archive = join(dest, "asset.tar.gz");
const response = await fetch(entry.url, { redirect: "follow" });
if (!response.ok) {
  console.error(`fetch-tool: ${entry.url} -> HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
writeFileSync(archive, bytes);

const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== entry.sha256) {
  console.error(`fetch-tool: sha256 mismatch for ${toolName}\n  expected ${entry.sha256}\n  actual   ${digest}`);
  process.exit(1);
}

// `tar` is on every runner; a Node tar implementation would be a dependency.
execFileSync("tar", ["-xzf", archive, "-C", dest]);
const binary = resolve(dest, entry.binary);
statSync(binary);
chmodSync(binary, 0o755);
rmSync(archive);
console.log(binary);
