#!/usr/bin/env node

/**
 * Set one version on every workspace package, then bring the internal dependency ranges and both lockfiles in line.
 * For a release version (no pre-release suffix) the coding-agent changelog's `## [Unreleased]` entries move under
 * the new version; the step fails if there are none.
 *
 *   npm run version:set -- 1.2.0
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG_PATH, releaseDate, stampChangelog } from "./changelog-release.mjs";
import { execNpmSync } from "./npm-command.mjs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error("Usage: npm run version:set -- <major.minor.patch[-prerelease]>");
	process.exit(1);
}

// Stamp the changelog first: it is the step that can refuse, and nothing has been written yet when it does.
if (!version.includes("-")) {
	const changelog = readFileSync(CHANGELOG_PATH, "utf8");
	let stamped;
	try {
		stamped = stampChangelog(changelog, version, releaseDate());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	if (stamped !== changelog) writeFileSync(CHANGELOG_PATH, stamped);
}

// Only the packages npm treats as workspace members take the release version. Fixtures such as the example plugin carry
// their own, and tests assert on them. The generated install-lock package is versioned by its generator.
function workspaceDirectories() {
	const { workspaces } = JSON.parse(readFileSync("package.json", "utf8"));
	return workspaces.flatMap((pattern) =>
		pattern.endsWith("/*")
			? readdirSync(pattern.slice(0, -2), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(pattern.slice(0, -2), entry.name))
			: [pattern],
	);
}

for (const directory of workspaceDirectories()) {
	const path = join(directory, "package.json");
	if (!existsSync(path)) continue;
	const text = readFileSync(path, "utf8");
	const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
	if (next !== text) writeFileSync(path, next);
}

const run = (args) => execNpmSync(args, { stdio: "inherit" });
execNpmSync(["exec", "--", "node", "scripts/sync-versions.js"], { stdio: "inherit" });
run(["install", "--package-lock-only", "--ignore-scripts"]);
run(["run", "install-lock:coding-agent"]);
console.log(`All workspace packages are at ${version}.`);
