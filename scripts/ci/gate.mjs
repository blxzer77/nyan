#!/usr/bin/env node
// Merge gate (docs/nyan/cicd.md §4.7). Pure judgement: it reads the job
// results and the impact flags the workflow passes in, and exits non-zero
// unless every required job succeeded.
//
// The required list comes from policy.json, never from a copy here, so a job
// renamed in the workflow but not in the policy (or vice versa) fails loudly
// instead of silently passing.
//
// Inputs (env):
//   CI_GATE_RESULTS  {"policy":"success","build":"success",...}
//   CI_GATE_IMPACT   {"docs_only":"true","windows_required":"false"}
//
// Local dry run:
//   CI_GATE_RESULTS='{"policy":"success"}' CI_GATE_IMPACT='{"docs_only":"true"}' node scripts/ci/gate.mjs

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(readFileSync(resolve(root, ".github/quality/policy.json"), "utf8"));

function parse(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`gate: ${name} is not valid JSON: ${error.message}`);
    return null;
  }
}

const results = parse("CI_GATE_RESULTS");
const impact = parse("CI_GATE_IMPACT");

if (results === null) {
  console.error("gate: CI_GATE_RESULTS missing or invalid; refusing to pass");
  process.exit(1);
}
// Missing impact is treated as "nothing is skippable" (fail closed), not as
// an error: results alone then decide.
const docsOnly = impact?.docs_only === "true";
const windowsRequired = impact?.windows_required !== "false";

const failures = [];

// policy itself has no allowed skip: without impact outputs the conditional
// jobs cannot be judged, so a skipped policy is a failure even on docs-only.
if (results.policy !== "success") {
  failures.push(`policy: ${results.policy ?? "missing"}`);
}

for (const job of policy.pullRequest?.required ?? []) {
  if (job === "policy") continue;
  const result = results[job];
  if (result === "success") continue;
  // docs-only may skip the work jobs; any other skip (e.g. an `if` typo) does
  // not pass.
  if (docsOnly && result === "skipped") continue;
  failures.push(`${job}: ${result ?? "missing"}`);
}

for (const [job, flag] of Object.entries(policy.pullRequest?.conditionalRequired ?? {})) {
  const required = flag === "windows_required" ? windowsRequired : true;
  const result = results[job];
  if (required) {
    if (result !== "success") failures.push(`${job}: ${result ?? "missing"} (required)`);
  } else if (result !== "success" && result !== "skipped") {
    // Not required, but a failed conditional job still means something broke.
    failures.push(`${job}: ${result ?? "missing"} (failed while not required)`);
  }
}

if (failures.length > 0) {
  console.error("Merge gate: FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Merge gate: PASS");
