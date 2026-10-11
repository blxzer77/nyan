#!/usr/bin/env node

/**
 * Set one version on every workspace package, then bring the internal dependency ranges and both lockfiles in line.
 *
 *   npm run version:set -- 1.2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error("Usage: npm run version:set -- <major.minor.patch[-prerelease]>");
	process.exit(1);
}

const generated = join("coding-agent", "install-lock");
for (const directory of findPackageDirectories("packages")) {
	if (directory.endsWith(generated)) continue;
	const path = join(directory, "package.json");
	const text = readFileSync(path, "utf8");
	const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
	if (next !== text) writeFileSync(path, next);
}

const run = (args) => execNpmSync(args, { stdio: "inherit" });
execNpmSync(["exec", "--", "node", "scripts/sync-versions.js"], { stdio: "inherit" });
run(["install", "--package-lock-only", "--ignore-scripts"]);
run(["run", "install-lock:coding-agent"]);
console.log(`All workspace packages are at ${version}.`);
