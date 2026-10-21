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
 *
 * Fail-closed on both sides of the decision:
 *
 *   - a required job that is absent from `results` fails. The workflow builds `results` from the job names it knows,
 *     so a job deleted from the workflow while staying required here would otherwise be judged as nothing at all, and
 *     nothing at all is a pass.
 *   - every impact flag the policy reads must be present and be "true" or "false". A missing policy output used to
 *     arrive as an absent flag, which read as "not selected" and silently dropped the conditional checks.
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

/**
 * Reads the impact analysis the `policy` job produced.
 *
 * `raw` is the JSON handed in through `CI_GATE_IMPACT`, whose values are workflow outputs: a job that did not run
 * leaves its outputs empty, so "" is what a missing flag looks like unless it is rejected here.
 */
export function parseImpact(raw, policy) {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error("CI_GATE_IMPACT is required: without the impact analysis the conditional checks cannot be judged");
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`CI_GATE_IMPACT is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`CI_GATE_IMPACT must be a JSON object, got ${JSON.stringify(parsed)}`);
	}
	const missing = [];
	const malformed = [];
	for (const flag of new Set(Object.values(policy.pullRequest?.conditionalRequired ?? {}))) {
		const value = parsed[flag];
		if (value === undefined) missing.push(flag);
		else if (value !== "true" && value !== "false") malformed.push(`${flag}=${JSON.stringify(value)}`);
	}
	if (missing.length > 0 || malformed.length > 0) {
		const problems = [
			missing.length > 0 ? `missing ${missing.join(", ")}` : "",
			malformed.length > 0 ? `not "true" or "false": ${malformed.join(", ")}` : "",
		].filter(Boolean);
		throw new Error(
			`CI_GATE_IMPACT is incomplete (${problems.join("; ")}): the policy job did not report its impact outputs`,
		);
	}
	return parsed;
}

/**
 * Judges one run.
 *
 * `required` is authoritative in both directions: a required job must be present in `results` and must be a success.
 * A job the gate does not know about is ignored, because the gate only judges the list the policy gives it.
 */
export function evaluate(results, { required, advisory }) {
	const failures = [];
	const warnings = [];
	const skippedRequired = [];
	const missing = [];

	for (const job of required) {
		if (!Object.hasOwn(results, job)) {
			missing.push(job);
			failures.push(`${job}: no result (a required job is not in the results map)`);
			continue;
		}
		const status = results[job];
		if (status === "skipped") skippedRequired.push(job);
		if (status !== "success") failures.push(`${job}: ${status}`);
	}

	for (const [job, status] of Object.entries(results)) {
		if (required.has(job)) continue;
		if (advisory.has(job) && status !== "success" && status !== "skipped") {
			warnings.push(`${job}: ${status}`);
		}
	}

	return { failures, warnings, skippedRequired, missing };
}

function main() {
	const raw = process.env.CI_GATE_RESULTS;
	if (!raw) throw new Error("CI_GATE_RESULTS is required");

	const results = JSON.parse(raw);
	if (results === null || typeof results !== "object" || Array.isArray(results)) {
		throw new Error(`CI_GATE_RESULTS must be a JSON object, got ${JSON.stringify(results)}`);
	}
	const policy = readPolicy();
	const impact = parseImpact(process.env.CI_GATE_IMPACT, policy);
	const { required, advisory, selected } = resolveJobs(policy, impact);
	const { failures, warnings, skippedRequired, missing } = evaluate(results, { required, advisory });

	if (selected.length > 0) console.log(`Conditional checks required by the impact analysis: ${selected.join(", ")}`);
	for (const warning of warnings) console.warn(`::warning::Advisory check did not pass: ${warning}`);
	if (skippedRequired.length > 0) {
		console.error(`These checks were required by the impact analysis but were skipped: ${skippedRequired.join(", ")}`);
	}
	if (missing.length > 0) {
		console.error(`These required checks produced no result at all: ${missing.join(", ")}`);
	}
	if (failures.length > 0) {
		console.error("Required CI checks did not pass:");
		for (const failure of failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`All ${required.size} required CI checks passed.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
