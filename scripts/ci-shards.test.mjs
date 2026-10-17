import assert from "node:assert/strict";
import { test } from "node:test";
import { expandJobs, parsePackageList } from "./ci-shards.mjs";

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

test("the order of packages is kept and only counted packages expand", () => {
	const jobs = expandJobs(["coding-agent", "root", "tui"], { "coding-agent": 2 });
	assert.deepEqual(
		jobs.map((job) => job.name),
		["coding-agent 1/2", "coding-agent 2/2", "root", "tui"],
	);
});

test("every shard of a split package appears exactly once", () => {
	const jobs = expandJobs(["coding-agent"], { "coding-agent": 4 });
	assert.deepEqual(
		jobs.map((job) => job.shard),
		["1/4", "2/4", "3/4", "4/4"],
	);
});

test("an empty or missing package list is an error, not an empty matrix", () => {
	assert.throws(() => parsePackageList(undefined, "NODE_PACKAGES"), /NODE_PACKAGES is required/);
	assert.throws(() => parsePackageList("  ", "NODE_PACKAGES"), /NODE_PACKAGES is required/);
});

test("a malformed package list is rejected", () => {
	assert.throws(() => parsePackageList('{"a":1}', "BUN_PACKAGES"), /BUN_PACKAGES must be a JSON array/);
	assert.throws(() => parsePackageList('["ai", ""]', "BUN_PACKAGES"), /non-empty package names/);
	assert.throws(() => parsePackageList("[ai", "BUN_PACKAGES"), SyntaxError);
});
