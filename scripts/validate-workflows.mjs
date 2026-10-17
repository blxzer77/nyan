#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowsDir = join(repoRoot, ".github", "workflows");
const errors = [];

function visit(value, path, file) {
	if (Array.isArray(value)) {
		value.forEach((entry, index) => visit(entry, `${path}[${index}]`, file));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		const current = `${path}.${key}`;
		if (key === "uses" && typeof entry === "string" && !entry.startsWith("./")) {
			const at = entry.lastIndexOf("@");
			const reference = at >= 0 ? entry.slice(at + 1) : "";
			if (!/^[0-9a-f]{40}$/.test(reference)) {
				errors.push(`${file}:${current} must pin an external action to a 40-character commit SHA: ${entry}`);
			}
		}
		visit(entry, current, file);
	}
}

for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml")).sort()) {
	const path = join(workflowsDir, name);
	let document;
	try {
		document = parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${name}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
		continue;
	}
	if (!document || typeof document !== "object" || !document.jobs || typeof document.jobs !== "object") {
		errors.push(`${name}: top-level jobs is required`);
		continue;
	}
	if (!document.permissions) errors.push(`${name}: top-level permissions is required`);
	visit(document, name, name);
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log("All GitHub workflows parse successfully and external actions are SHA-pinned.");
