#!/usr/bin/env node
// Release preflight (docs/nyan/cicd.md §8.1): the tag must name the version in
// Cargo.toml. Pre-release suffixes only compare the X.Y.Z core, so
// `nyan-v0.3.0-rc.1` is valid while Cargo.toml says 0.3.0.
//
// Usage: node scripts/ci/check-version.mjs <tag> [--package path/to/Cargo.toml]
// Exit 0 on match, 1 on mismatch or a malformed tag.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function argValue(index) {
  return process.argv[index + 1];
}

const tag = process.argv[2];
if (!tag || tag.startsWith("--")) {
  console.error("usage: check-version.mjs <tag> [--package <Cargo.toml>]");
  process.exit(1);
}

const packageIndex = process.argv.indexOf("--package");
const manifestPath = packageIndex === -1 ? resolve(root, "Cargo.toml") : resolve(argValue(packageIndex));

const policy = JSON.parse(readFileSync(resolve(root, ".github/quality/policy.json"), "utf8"));
const prefix = policy.release?.tagPrefix ?? "nyan-v";

const tagMatch = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+][0-9A-Za-z.-]+)?$`).exec(tag);
if (!tagMatch) {
  console.error(`check-version: tag ${JSON.stringify(tag)} does not match ${prefix}X.Y.Z[-suffix]`);
  process.exit(1);
}

const manifest = readFileSync(manifestPath, "utf8");
// The package's own version is the first `version = "..."` under [package];
// dependency tables come later and use different keys, but a member manifest
// could theoretically repeat it. Anchoring on the [package] section is the
// least surprising rule.
const section = /^\[package\]\s*$([\s\S]*?)^\[/m.exec(manifest);
if (!section) {
  console.error(`check-version: no [package] section in ${manifestPath}`);
  process.exit(1);
}
const versionMatch = /^\s*version\s*=\s*"([^"]+)"/m.exec(section[1]);
if (!versionMatch) {
  console.error(`check-version: no version field in ${manifestPath}`);
  process.exit(1);
}

const manifestVersion = versionMatch[1];
const manifestCore = manifestVersion.replace(/(?:[-+].*)$/, "");
const tagCore = `${tagMatch[1]}.${tagMatch[2]}.${tagMatch[3]}`;

if (tagCore !== manifestCore) {
  console.error(
    `check-version: tag ${tag} (core ${tagCore}) != Cargo.toml version ${manifestVersion} (core ${manifestCore})`,
  );
  process.exit(1);
}

console.log(`check-version: ${tag} matches ${manifestVersion}`);
