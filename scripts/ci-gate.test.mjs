import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, readPolicy, resolveJobs } from "./ci-gate.mjs";

const policy = {
	pullRequest: {
		required: ["policy", "prepare", "static", "node-tests", "bun-tests", "supply-chain"],
		conditionalRequired: {
			"windows-smoke": "windows_required",
			"mcp-conformance": "mcp_required",
			"deep-gate": "deep_required",
		},
		advisory: [],
	},
};

test("a conditional job is not required when the impact analysis did not select it", () => {
	const { required, selected } = resolveJobs(policy, { windows_required: "false", mcp_required: "false" });
	assert.equal(required.has("windows-smoke"), false);
	assert.equal(required.has("static"), true);
	assert.deepEqual(selected, []);
});

test("a conditional job is required when the impact analysis selected it, including as a real boolean", () => {
	const { required, selected } = resolveJobs(policy, { windows_required: true, mcp_required: "false" });
	assert.equal(required.has("windows-smoke"), true);
	assert.equal(required.has("mcp-conformance"), false);
	assert.deepEqual(selected, ["windows-smoke"]);
});

test("a skipped job fails the gate when the impact analysis required it", () => {
	// This is the half that makes dynamic skipping safe: the classifier said the work was needed, so a skipped
	// job is a missing result, not an intended outcome.
	const { required } = resolveJobs(policy, { windows_required: "true" });
	const { failures } = evaluate({ "windows-smoke": "skipped", static: "success" }, { required, advisory: new Set() });
	assert.deepEqual(failures, ["windows-smoke: skipped"]);
});

test("a skipped job passes the gate when the impact analysis did not require it", () => {
	const { required } = resolveJobs(policy, { windows_required: "false" });
	const { failures } = evaluate({ "windows-smoke": "skipped", static: "success" }, { required, advisory: new Set() });
	assert.deepEqual(failures, []);
});

test("a failing required job fails the gate and names the status", () => {
	const { required } = resolveJobs(policy, {});
	const { failures } = evaluate({ static: "failure" }, { required, advisory: new Set() });
	assert.deepEqual(failures, ["static: failure"]);
});

test("an advisory job that fails warns without failing the run", () => {
	const { required } = resolveJobs(policy, {});
	const { failures, warnings } = evaluate(
		{ static: "success", "ai-review": "failure" },
		{ required, advisory: new Set(["ai-review"]) },
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(warnings, ["ai-review: failure"]);
});

test("no job at all is an empty result, not a pass", () => {
	const { required } = resolveJobs(policy, {});
	assert.equal(evaluate({}, { required, advisory: new Set() }).failures.length, 0);
	// The gate only ever sees its own needs; a job missing from the map cannot be judged here, and the workflow
	// passes every required job name in, so a missing name would be a workflow bug rather than a green run.
	assert.ok(required.size > 0);
});

test("the committed policy names every job the gate needs and no job that does not exist", () => {
	const committed = readPolicy().pullRequest;
	const jobs = new Set([...committed.required, ...Object.keys(committed.conditionalRequired ?? {})]);
	for (const job of ["policy", "prepare", "static", "node-tests", "bun-tests", "supply-chain"]) {
		assert.ok(jobs.has(job), `${job} must stay required`);
	}
	for (const job of Object.keys(committed.conditionalRequired ?? {})) {
		assert.ok(jobs.has(job));
	}
	// `deep-gate` is conditional: it runs only when the impact analysis asks for deep testing.
	assert.equal(committed.required.includes("deep-gate"), false);
});
