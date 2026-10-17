#!/usr/bin/env node

const raw = process.env.CI_GATE_RESULTS;
if (!raw) throw new Error("CI_GATE_RESULTS is required");

const results = JSON.parse(raw);
const required = new Set(JSON.parse(process.env.CI_GATE_REQUIRED ?? "[]"));
const advisory = new Set(JSON.parse(process.env.CI_GATE_ADVISORY ?? "[]"));
const failures = [];
const warnings = [];

for (const [job, status] of Object.entries(results)) {
	if (required.has(job)) {
		if (status !== "success") failures.push(`${job}: ${status}`);
		continue;
	}
	if (advisory.has(job) && status !== "success" && status !== "skipped") {
		warnings.push(`${job}: ${status}`);
	}
}

for (const warning of warnings) console.warn(`::warning::Advisory check did not pass: ${warning}`);
if (failures.length > 0) {
	console.error("Required CI checks did not pass:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log("All required CI checks passed.");
