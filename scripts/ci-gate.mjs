#!/usr/bin/env node

/**
 * Decide whether the merge gate passes.
 *
 * The required job list lives in `.github/quality/policy.json`, not in the workflow: a job name repeated in two places
 * drifts, and this gate is fail-closed, so drift means either a required check silently stops being required or a
 * skipped check turns the gate red for no reason.
 *
 * A job whose scope the impact classifier may drop (`conditionalRequired`) is required only when the classifier
 * selected it. When it is required, `skipped` is a failure: the classifier said the work was needed. When it is not
 * required, a skip is the intended outcome and passing it silently is what makes dynamic skipping safe.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function readPolicy(root = repoRoot) {
	return JSON.parse(readFileSync(join(root, ".github", "quality", "policy.json"), "utf8"));
}

/** Builds the required and advisory job sets for one run. */
export function resolveJobs(policy, impact) {
	const pullRequest = policy.pullRequest ?? {};
	const required = new Set(pullRequest.required ?? []);
	const conditional = pullRequest.conditionalRequired ?? {};
	const selected = [];

	for (const [job, flag] of Object.entries(conditional)) {
		// Impact outputs arrive as the strings "true" and "false"; a JSON flag may be a real boolean.
		const value = impact[flag];
		if (value === true || value === "true") {
			required.add(job);
			selected.push(job);
		}
	}

	return { required, advisory: new Set(pullRequest.advisory ?? []), selected };
}

export function evaluate(results, { required, advisory }) {
	const failures = [];
	const warnings = [];
	const skippedRequired = [];

	for (const [job, status] of Object.entries(results)) {
		if (required.has(job)) {
			if (status === "skipped") skippedRequired.push(job);
			if (status !== "success") failures.push(`${job}: ${status}`);
			continue;
		}
		if (advisory.has(job) && status !== "success" && status !== "skipped") {
			warnings.push(`${job}: ${status}`);
		}
	}

	return { failures, warnings, skippedRequired };
}

function main() {
	const raw = process.env.CI_GATE_RESULTS;
	if (!raw) throw new Error("CI_GATE_RESULTS is required");

	const results = JSON.parse(raw);
	const impact = JSON.parse(process.env.CI_GATE_IMPACT ?? "{}");
	const { required, advisory, selected } = resolveJobs(readPolicy(), impact);
	const { failures, warnings, skippedRequired } = evaluate(results, { required, advisory });

	if (selected.length > 0) console.log(`Conditional checks required by the impact analysis: ${selected.join(", ")}`);
	for (const warning of warnings) console.warn(`::warning::Advisory check did not pass: ${warning}`);
	if (skippedRequired.length > 0) {
		console.error(`These checks were required by the impact analysis but were skipped: ${skippedRequired.join(", ")}`);
	}
	if (failures.length > 0) {
		console.error("Required CI checks did not pass:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`All ${required.size} required CI checks passed.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
