#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(repoRoot, "packages");
const allPackages = readdirSync(packageRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(packageRoot, entry.name, "package.json")))
	.map((entry) => entry.name)
	.sort();

const criticalPatterns = [
	/^packages\/(ai|agent|durable|coding-agent|protocol)\//,
	/^package(-lock)?\.json$/,
	/^tsconfig(?:\.|$)/,
	/^biome\.json$/,
	/^scripts\//,
	/^\.github\//,
	/^docs\/architecture\/layers\.json$/,
];
const highPatterns = [
	/^packages\/(tui|mcp|codemode|client|server|chord)\//,
	/^packages\/coding-agent\/schemas\//,
];
const rootTestOnly = ["scripts"];
const ignorable = [/^\.agents\//, /^docs\//, /^README\.md$/, /^ROADMAP\.md$/, /^LICENSE$/, /^SECURITY\.md$/];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

const packageInfo = new Map();
for (const directory of allPackages) {
	const manifest = readJson(join(packageRoot, directory, "package.json"));
	packageInfo.set(directory, {
		directory,
		name: manifest.name,
		dependencies: {
			...manifest.dependencies,
			...manifest.devDependencies,
			...manifest.peerDependencies,
		},
	});
}

const packageByName = new Map([...packageInfo.values()].map((info) => [info.name, info.directory]));
const reverseDependencies = new Map(allPackages.map((name) => [name, new Set()]));
for (const info of packageInfo.values()) {
	for (const dependency of Object.keys(info.dependencies)) {
		const dependencyDirectory = packageByName.get(dependency);
		if (dependencyDirectory) reverseDependencies.get(dependencyDirectory).add(info.directory);
	}
}

function gitNames(base, head) {
	const args = base && head && !/^0+$/.test(base) ? ["diff", "--name-only", `${base}...${head}`, "--"] : ["diff", "--name-only", "HEAD", "--"];
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
		.split(/\r?\n/)
		.map((name) => name.trim())
		.filter(Boolean);
}

function packageForPath(path) {
	const match = /^packages\/([^/]+)(?:\/|$)/.exec(path);
	return match && packageInfo.has(match[1]) ? match[1] : undefined;
}

function expandDependents(changed) {
	const result = new Set(changed);
	const queue = [...changed];
	while (queue.length > 0) {
		const packageName = queue.shift();
		for (const dependent of reverseDependencies.get(packageName) ?? []) {
			if (result.has(dependent)) continue;
			result.add(dependent);
			queue.push(dependent);
		}
	}
	return result;
}

function setOutput(name, value) {
	const output = process.env.GITHUB_OUTPUT;
	if (!output) return;
	writeFileSync(output, `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`, { flag: "a" });
}

const base = process.env.BASE_SHA ?? process.argv[2];
const head = process.env.HEAD_SHA ?? process.argv[3] ?? "HEAD";
const changedFiles = gitNames(base, head);
const changedPackages = new Set();
let fullSuite = false;
let risk = "normal";

for (const path of changedFiles) {
	const packageName = packageForPath(path);
	if (packageName) changedPackages.add(packageName);
	if (criticalPatterns.some((pattern) => pattern.test(path))) risk = "critical";
	else if (risk === "normal" && highPatterns.some((pattern) => pattern.test(path))) risk = "high";

	const known = packageName || ignorable.some((pattern) => pattern.test(path)) || path === "";
	if (!known || criticalPatterns.some((pattern) => pattern.test(path) && !/^packages\//.test(path))) fullSuite = true;
}

if (changedFiles.length === 0 || process.env.GITHUB_EVENT_NAME === "push" || process.env.GITHUB_EVENT_NAME === "merge_group") {
	fullSuite = true;
	risk = "critical";
}
if (changedFiles.some((path) => rootTestOnly.some((directory) => path.startsWith(`${directory}/`)))) {
	changedPackages.add("root");
}

const affectedPackages = fullSuite ? new Set(allPackages) : expandDependents(changedPackages);
const nodePackages = new Set(affectedPackages);
if (fullSuite || changedFiles.some((path) => path.startsWith("scripts/"))) nodePackages.add("root");
if (nodePackages.size === 0) nodePackages.add("root");

const bunPackages = fullSuite ? new Set(allPackages) : new Set(affectedPackages);
if (bunPackages.size === 0) bunPackages.add("agent");

const windowsRequired =
	fullSuite || changedFiles.some((path) => /^(packages\/(tui|coding-agent|client|server|protocol)\/|packages\/.*\/package\.json$)/.test(path));
const mcpRequired = fullSuite || changedFiles.some((path) => /^(packages\/(mcp|coding-agent|client|server|protocol)\/)/.test(path));
const deepRequired = fullSuite || risk === "critical" || risk === "high";

const result = {
	changedFiles,
	changedPackages: [...changedPackages].sort(),
	affectedPackages: [...affectedPackages].sort(),
	nodePackages: [...nodePackages].sort(),
	bunPackages: [...bunPackages].sort(),
	risk,
	fullSuite,
	windowsRequired,
	mcpRequired,
	deepRequired,
};

for (const [key, value] of Object.entries({
	changed_files: result.changedFiles,
	changed_packages: result.changedPackages,
	affected_packages: result.affectedPackages,
	node_packages: result.nodePackages,
	bun_packages: result.bunPackages,
	risk: result.risk,
	full_suite: String(result.fullSuite),
	windows_required: String(result.windowsRequired),
	mcp_required: String(result.mcpRequired),
	deep_required: String(result.deepRequired),
})) setOutput(key, value);

if (process.env.GITHUB_STEP_SUMMARY) {
	writeFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		["## CI impact", `- Risk: **${result.risk}**`, `- Full suite: **${result.fullSuite}**`, `- Changed: ${result.changedPackages.join(", ") || "none"}`, `- Affected: ${result.affectedPackages.join(", ") || "none"}`].join("\n") + "\n",
		{ flag: "a" },
	);
}

console.log(JSON.stringify(result, null, 2));
