#!/usr/bin/env node

/**
 * Publish the public workspace packages in dependency order.
 *
 *   node scripts/publish-packages.mjs [--dry-run] [--tag <dist-tag>] [--expect-version <x.y.z>]
 *
 * - Every public package must carry the same version (lockstep); `--expect-version` also pins it to a release tag.
 * - Packages publish after the workspace packages they depend on.
 * - A package version that is already on the registry is skipped, so a failed release can be re-run. A dry run packs it
 *   with `npm pack --dry-run` instead (the tarball contents are still checked): npm refuses to publish over a
 *   published version even as a dry run.
 * - Nothing is rebuilt here; run the build first. `--dry-run` runs `npm publish --dry-run`, which packs each tarball.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const distTag = option("--tag");
const expectedVersion = option("--expect-version");

function fail(message) {
	console.error(message);
	process.exit(1);
}

const packages = findPackageDirectories("packages")
	.filter((directory) => !directory.endsWith(join("coding-agent", "install-lock")))
	.map((directory) => ({ directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }))
	.filter(({ manifest }) => manifest.private !== true);

const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
	fail(`Public packages must share one version, found: ${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(", ")}`);
}
const [version] = versions;
if (expectedVersion !== undefined && version !== expectedVersion) {
	fail(`Packages are at ${version} but the release is ${expectedVersion}.`);
}

const names = new Set(packages.map(({ manifest }) => manifest.name));
const dependsOn = (manifest) =>
	[...new Set(["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {})))].filter(
		(name) => names.has(name),
	);

const ordered = [];
const visiting = new Set();
const visit = (pkg) => {
	if (ordered.includes(pkg)) return;
	if (visiting.has(pkg)) fail(`Dependency cycle at ${pkg.manifest.name}`);
	visiting.add(pkg);
	for (const name of dependsOn(pkg.manifest)) visit(packages.find(({ manifest }) => manifest.name === name));
	visiting.delete(pkg);
	ordered.push(pkg);
};
for (const pkg of packages) visit(pkg);

function onRegistry(name, wanted) {
	// A dry run must not wait through npm's default retries when the registry cannot be reached; no answer counts as not
	// published, the same as a 404.
	const viewArgs = ["view", `${name}@${wanted}`, "version", "--json", ...(dryRun ? ["--fetch-retries=0"] : [])];
	try {
		return execNpmSync(viewArgs, { encoding: "utf8", stdio: "pipe" }).trim().length > 0;
	} catch {
		// 404: the version (or the package) has not been published yet.
		return false;
	}
}

console.log(`${dryRun ? "Dry run: " : ""}publishing ${ordered.length} packages at ${version}`);
for (const { directory, manifest } of ordered) {
	const published = onRegistry(manifest.name, version);
	if (published && !dryRun) {
		console.log(`  ${manifest.name}@${version} is already published, skipping`);
		continue;
	}
	if (published) {
		console.log(`  ${manifest.name}@${version} already published; packed only`);
		try {
			execNpmSync(["pack", resolve(directory), "--dry-run", "--ignore-scripts"], { stdio: "inherit" });
		} catch {
			fail(`npm pack failed for ${manifest.name}`);
		}
		continue;
	}
	// An absolute path: npm reads a bare `packages/x` as the GitHub shorthand user/repo, which only Windows' backslashes avoid.
	const publishArgs = ["publish", resolve(directory), "--access", "public", "--ignore-scripts"];
	if (distTag) publishArgs.push("--tag", distTag);
	if (dryRun) publishArgs.push("--dry-run");
	else if (process.env.GITHUB_ACTIONS === "true") publishArgs.push("--provenance");
	console.log(`  ${manifest.name}@${version}`);
	try {
		execNpmSync(publishArgs, { stdio: "inherit" });
	} catch {
		fail(`npm publish failed for ${manifest.name}`);
	}
}
console.log(dryRun ? "Dry run complete." : "Published.");
