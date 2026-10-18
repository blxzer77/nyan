#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--out");
const outputDirectory = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : ".artifacts/packages");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--out requires a directory");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const packages = findPackageDirectories(join(repoRoot, "packages"))
	.map((directory) => ({ directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }))
	.filter(({ manifest }) => manifest.private !== true && !manifest.name?.includes("/examples/"));

const packed = [];
for (const { directory, manifest } of packages) {
	const stdout = execNpmSync(["pack", resolve(directory), "--ignore-scripts", "--json", "--pack-destination", outputDirectory], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "pipe",
	});
	const result = JSON.parse(stdout)[0];
	packed.push({ name: manifest.name, version: manifest.version, filename: result.filename, files: result.files?.length ?? 0 });
}

console.log(JSON.stringify({ outputDirectory, packages: packed }, null, 2));
