#!/usr/bin/env node

/**
 * The coding-agent changelog at release time. `npm run version:set` moves the `## [Unreleased]` entries under a
 * heading for the new version; the release workflow checks that the heading exists before it publishes.
 *
 *   node scripts/changelog-release.mjs --check 1.2.0
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.md";

const UNRELEASED = /^## \[Unreleased\][ \t]*$/m;

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the changelog has a `## [version]` section. */
export function hasVersionSection(text, version) {
	return new RegExp(`^## \\[${escapeRegExp(version)}\\]`, "m").test(text);
}

/**
 * Return the changelog with the `## [Unreleased]` entries moved under `## [version] - date` and an empty
 * `## [Unreleased]` above it. A changelog that already has the version is returned unchanged, so the step can run
 * twice. Throws when there is no `## [Unreleased]` section or it has no entries: a release needs its user-visible
 * changes written down first.
 */
export function stampChangelog(text, version, date) {
	if (hasVersionSection(text, version)) return text;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lf = text.replace(/\r\n/g, "\n");
	const match = UNRELEASED.exec(lf);
	if (!match) throw new Error(`${CHANGELOG_PATH} has no "## [Unreleased]" section.`);
	const bodyStart = match.index + match[0].length;
	const next = lf.slice(bodyStart).search(/^## /m);
	const body = next === -1 ? lf.slice(bodyStart) : lf.slice(bodyStart, bodyStart + next);
	if (!/^\s*[-*] /m.test(body)) {
		throw new Error(`${CHANGELOG_PATH} has no entries under "## [Unreleased]"; add the user-visible changes of ${version}.`);
	}
	const stamped = `${lf.slice(0, match.index)}## [Unreleased]\n\n## [${version}] - ${date}${lf.slice(bodyStart)}`;
	return stamped.replace(/\n/g, eol);
}

/** Today's date in UTC, as the changelog headings write it. */
export function releaseDate(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [flag, version] = process.argv.slice(2);
	if (flag !== "--check" || !version) {
		console.error("Usage: node scripts/changelog-release.mjs --check <version>");
		process.exit(1);
	}
	if (!hasVersionSection(readFileSync(CHANGELOG_PATH, "utf8"), version)) {
		console.error(`${CHANGELOG_PATH} has no "## [${version}]" section. Run npm run version:set -- ${version}.`);
		process.exit(1);
	}
	console.log(`${CHANGELOG_PATH} has a section for ${version}.`);
}
