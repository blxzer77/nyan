import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { evaluate, parseImpact, readPolicy, resolveJobs } from "./ci-gate.mjs";

const script = join(resolve(import.meta.dirname), "ci-gate.mjs");

/** The committed policy: the subprocess cases judge what the workflow actually hands the gate. */
const committed = readPolicy().pullRequest;
const allJobs = [...committed.required, ...Object.keys(committed.conditionalRequired ?? {})];
const flags = [...new Set(Object.values(committed.conditionalRequired ?? {}))];

/** A small policy of the same shape, for the cases that need a job the repository does not have. */
const sample = {
	pullRequest: {
		required: ["policy", "static"],
		conditionalRequired: { "windows-smoke": "windows_required" },
		advisory: ["ai-review"],
	},
};

/** The results map the workflow builds, every job present, with the given statuses applied on top. */
function results(statuses = {}) {
	const map = Object.fromEntries(allJobs.map((job) => [job, "success"]));
	for (const [job, status] of Object.entries(statuses)) {
		if (status === null) delete map[job];
		else map[job] = status;
	}
	return JSON.stringify(map);
}

/** An impact map with every flag `false` unless named. */
function impact(trueFlags = []) {
	return JSON.stringify(Object.fromEntries(flags.map((flag) => [flag, trueFlags.includes(flag) ? "true" : "false"])));
}

/** Runs the gate as the workflow does: a real process, a real exit code, the output it prints. */
function runGate({ results: resultsArgument, impact: impactArgument } = {}) {
	const env = { ...process.env };
	delete env.CI_GATE_RESULTS;
	delete env.CI_GATE_IMPACT;
	if (resultsArgument !== undefined) env.CI_GATE_RESULTS = resultsArgument;
	if (impactArgument !== undefined) env.CI_GATE_IMPACT = impactArgument;
	return spawnSync(process.execPath, [script], { encoding: "utf8", env });
}

test("the committed policy describes the workflow the gate expects", () => {
	const jobs = new Set([...committed.required, ...Object.keys(committed.conditionalRequired ?? {})]);
	for (const job of ["policy", "prepare", "static", "node-tests", "bun-tests", "supply-chain"]) {
		assert.ok(jobs.has(job), `${job} must stay required`);
	}
	// `deep-gate` is conditional: it runs only when the impact analysis asks for deep testing.
	assert.equal(committed.required.includes("deep-gate"), false);
	// The gate rejects an impact map that lacks a flag, so every conditional job needs its own flag name: two jobs
	// sharing one flag would be selected together and checked separately.
	assert.equal(flags.length, Object.keys(committed.conditionalRequired ?? {}).length, "one flag per conditional job");
});

test("the gate exits 0 when every required job succeeded", () => {
	const result = runGate({ results: results(), impact: impact() });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), `All ${committed.required.length} required CI checks passed.`);
	assert.equal(result.stderr, "");
});

test("the gate exits 1 and names a failing required job", () => {
	const result = runGate({ results: results({ static: "failure" }), impact: impact() });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /Required CI checks did not pass:\n- static: failure/);
});

test("the gate exits 1 when a required job is missing from the results", () => {
	// A job deleted from the workflow but left in policy.json used to pass: `evaluate` only walked the keys it was
	// given, so a required job that produced no result was indistinguishable from one that passed.
	const result = runGate({ results: results({ static: null }), impact: impact() });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /These required checks produced no result at all: static/);
	assert.match(result.stderr, /- static: no result \(a required job is not in the results map\)/);
});

test("the gate exits 1 when a conditional job the impact analysis selected has no result", () => {
	const result = runGate({ results: results({ "windows-smoke": null }), impact: impact(["windows_required"]) });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /produced no result at all: windows-smoke/);
});

test("the gate exits 1 when CI_GATE_IMPACT is absent", () => {
	const result = runGate({ results: results() });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^::error::CI_GATE_IMPACT is required/);
});

test("the gate exits 1 when the policy job reported no impact outputs", () => {
	// This is what `needs.policy.outputs.<flag>` becomes when the policy job did not run: defined, and empty.
	const empty = JSON.stringify(Object.fromEntries(flags.map((flag) => [flag, ""])));
	const result = runGate({ results: results(), impact: empty });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^::error::CI_GATE_IMPACT is incomplete \(not "true" or "false": /);
	assert.match(result.stderr, /the policy job did not report its impact outputs/);
});

test("the gate exits 1 when an impact flag is missing", () => {
	const partial = JSON.parse(impact());
	delete partial[flags[0]];
	const result = runGate({ results: results(), impact: JSON.stringify(partial) });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^::error::CI_GATE_IMPACT is incomplete \(missing /);
});

test("the gate exits 1 when CI_GATE_RESULTS is absent", () => {
	const result = runGate({ impact: impact() });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^::error::CI_GATE_RESULTS is required/);
});

test("the gate exits 1 when the selected conditional job was skipped", () => {
	const result = runGate({ results: results({ "windows-smoke": "skipped" }), impact: impact(["windows_required"]) });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /required by the impact analysis but were skipped: windows-smoke/);
	assert.match(result.stderr, /- windows-smoke: skipped/);
});

test("the gate exits 0 when an unselected conditional job was skipped", () => {
	const result = runGate({ results: results({ "windows-smoke": "skipped" }), impact: impact() });

	assert.equal(result.status, 0, result.stderr);
});

test("a conditional job is not required when the impact analysis did not select it", () => {
	const { required, selected } = resolveJobs(sample, { windows_required: "false" });
	assert.equal(required.has("windows-smoke"), false);
	assert.equal(required.has("static"), true);
	assert.deepEqual(selected, []);
});

test("a conditional job is required when the impact analysis selected it, including as a real boolean", () => {
	const { required, selected } = resolveJobs(sample, { windows_required: true });
	assert.equal(required.has("windows-smoke"), true);
	assert.deepEqual(selected, ["windows-smoke"]);
});

test("a required job that produced no result is a failure, never a pass", () => {
	const { required } = resolveJobs(sample, { windows_required: "false" });
	const { failures, missing } = evaluate(
		{ policy: "success", "windows-smoke": "skipped" },
		{ required, advisory: new Set() },
	);
	assert.deepEqual(missing, ["static"]);
	assert.deepEqual(failures, ["static: no result (a required job is not in the results map)"]);
});

test("a failing required job fails the gate and names the status", () => {
	const { required } = resolveJobs(sample, { windows_required: "false" });
	const { failures } = evaluate({ policy: "success", static: "failure" }, { required, advisory: new Set() });
	assert.deepEqual(failures, ["static: failure"]);
});

test("a skipped conditional job fails only when the impact analysis required it", () => {
	const required = resolveJobs(sample, { windows_required: "true" });
	const skipped = resolveJobs(sample, { windows_required: "false" });
	const map = { policy: "success", static: "success", "windows-smoke": "skipped" };

	const selected = evaluate(map, { required: required.required, advisory: new Set() });
	assert.deepEqual(selected.skippedRequired, ["windows-smoke"]);
	assert.deepEqual(selected.failures, ["windows-smoke: skipped"]);

	const unselected = evaluate(map, { required: skipped.required, advisory: new Set() });
	assert.deepEqual(unselected.failures, []);
});

test("an advisory job that fails warns without failing the run", () => {
	const { required } = resolveJobs(sample, { windows_required: "false" });
	const { failures, warnings } = evaluate(
		{ policy: "success", static: "success", "ai-review": "failure" },
		{ required, advisory: new Set(sample.pullRequest.advisory) },
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(warnings, ["ai-review: failure"]);
});

test("an impact map must carry every flag the policy reads, as \"true\" or \"false\"", () => {
	assert.throws(() => parseImpact(undefined, sample), /CI_GATE_IMPACT is required: without the impact analysis/);
	assert.throws(() => parseImpact("", sample), /CI_GATE_IMPACT is required/);
	assert.throws(() => parseImpact("not json", sample), /CI_GATE_IMPACT is not JSON/);
	assert.throws(() => parseImpact("[]", sample), /must be a JSON object/);
	assert.throws(() => parseImpact('{"mcp_required":"true"}', sample), /missing windows_required/);
	assert.throws(
		() => parseImpact('{"windows_required":"yes"}', sample),
		/not "true" or "false": windows_required="yes"/,
	);
	assert.deepEqual(parseImpact('{"windows_required":"false"}', sample), { windows_required: "false" });
});
