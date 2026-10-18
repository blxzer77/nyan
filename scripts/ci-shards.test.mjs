import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assignRunners,
	HOSTED_RUNNER,
	SELF_HOSTED_RUNNER,
	expandJobs,
	parsePackageList,
} from "./ci-shards.mjs";

test("a package without a count is one job with no shard", () => {
	assert.deepEqual(expandJobs(["ai"], {}), [{ name: "ai", package: "ai", shard: "" }]);
});

test("a counted package expands to one job per shard, named by shard", () => {
	assert.deepEqual(expandJobs(["durable"], { durable: 3 }), [
		{ name: "durable 1/3", package: "durable", shard: "1/3" },
		{ name: "durable 2/3", package: "durable", shard: "2/3" },
		{ name: "durable 3/3", package: "durable", shard: "3/3" },
	]);
});

test("the self-hosted slots go to the slowest jobs, not the first ones", () => {
	const jobs = expandJobs(["ai", "coding-agent", "durable"], { "coding-agent": 2, durable: 2 });
	const assigned = assignRunners(jobs, 3);
	// ai is listed first but is the cheapest package, so it stays on a hosted runner.
	assert.equal(assigned.find((job) => job.package === "ai").runner, HOSTED_RUNNER);
	const selfHosted = assigned.filter((job) => job.runner === SELF_HOSTED_RUNNER).map((job) => job.name);
	assert.deepEqual(selfHosted, ["coding-agent 1/2", "coding-agent 2/2", "durable 1/2"]);
});

test("zero self-hosted slots leaves every job on a hosted runner", () => {
	const jobs = expandJobs(["coding-agent"], { "coding-agent": 4 });
	assert.ok(assignRunners(jobs, 0).every((job) => job.runner === HOSTED_RUNNER));
});

test("more slots than jobs does not invent jobs", () => {
	const jobs = expandJobs(["ai", "chord"], {});
	const assigned = assignRunners(jobs, 10);
	assert.equal(assigned.length, 2);
	assert.ok(assigned.every((job) => job.runner === SELF_HOSTED_RUNNER));
});

test("assignRunners keeps every field of the job it was given", () => {
	const jobs = [{ name: "coding-agent 2/4", package: "coding-agent", shard: "2/4" }];
	assert.deepEqual(assignRunners(jobs, 1), [{ ...jobs[0], runner: SELF_HOSTED_RUNNER }]);
});

test("the order of packages is kept and only counted packages expand", () => {
	assert.deepEqual(
		expandJobs(["ai", "durable", "chord"], { durable: 2, "coding-agent": 4 }).map((job) => job.name),
		["ai", "durable 1/2", "durable 2/2", "chord"],
	);
});

test("an empty or missing package list is an error, not an empty matrix", () => {
	assert.throws(() => parsePackageList("", "NODE_PACKAGES"), /required/);
	assert.throws(() => parsePackageList(undefined, "NODE_PACKAGES"), /required/);
});

test("a malformed package list is rejected", () => {
	assert.throws(() => parsePackageList('{"a":1}', "NODE_PACKAGES"), /JSON array/);
	assert.throws(() => parsePackageList('["ok",""]', "NODE_PACKAGES"), /non-empty/);
});
