#!/usr/bin/env node

// Expands the packages selected by ci-impact.mjs into test jobs. The two large suites are split with
// vitest's own `--shard=i/n`, which partitions files by count: every file lands in exactly one shard, so
// nothing needs a hand-maintained list of files. The counts are the knob. Measured on a 4-vCPU hosted
// runner, the unsplit coding-agent Node suite was the longest job of the run at 187 s.
//
// Each job also names the pool it runs on. Both pools work at the same time: the slowest shards go to the
// six self-hosted slots, which are quicker per core, and everything else to GitHub-hosted runners. A fork
// pull request is never placed on self-hosted, so `selfHostedShards` is ignored for it.
//
// Output (for GITHUB_OUTPUT, or stdout when run outside Actions):
//   node_shards  JSON array of { name, package, shard, runner }; `shard` is "" when the package is not split
//   bun_shards   the same shape for the Bun matrix

import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

export const NODE_SHARD_COUNTS = { "coding-agent": 4, durable: 3 };
export const BUN_SHARD_COUNTS = { "coding-agent": 2, durable: 2 };

export const HOSTED_RUNNER = "ubuntu-latest";
// Kept as an array because `runs-on: ${{ matrix.runner }}` receives the matrix value as-is.
export const SELF_HOSTED_RUNNER = ["self-hosted", "Linux", "X64", "repo-nyan"];

export function parsePackageList(raw, label) {
	if (raw === undefined || raw.trim() === "") throw new Error(`${label} is required (a JSON array of package names)`);
	const value = JSON.parse(raw);
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`${label} must be a JSON array of non-empty package names, got ${raw}`);
	}
	return value;
}

export function expandJobs(packages, shardCounts) {
	const jobs = [];
	for (const name of packages) {
		const count = shardCounts[name] ?? 1;
		if (count === 1) {
			jobs.push({ name, package: name, shard: "" });
			continue;
		}
		for (let index = 1; index <= count; index++) {
			const shard = `${index}/${count}`;
			jobs.push({ name: `${name} ${shard}`, package: name, shard });
		}
	}
	return jobs;
}

/** How long a package's suite takes relative to the others; lower is slower. Measured in run 39049211499. */
const PACKAGE_WEIGHT = { "coding-agent": 0, durable: 1 };

/**
 * Assigns the self-hosted slots to the slowest jobs, then names the pool of every job.
 * Ordering matters: a slot spent on a 30 s package while a 90 s shard waits on hosted is wasted.
 */
export function assignRunners(jobs, selfHostedShards) {
	const ranked = jobs
		.map((job, index) => ({ job, index, weight: PACKAGE_WEIGHT[job.package] ?? 2 }))
		.sort((left, right) => left.weight - right.weight || left.index - right.index);
	const chosen = new Set(ranked.slice(0, Math.max(0, selfHostedShards)).map((entry) => entry.index));
	return jobs.map((job, index) => ({ ...job, runner: chosen.has(index) ? SELF_HOSTED_RUNNER : HOSTED_RUNNER }));
}

function main() {
	const nodeJobs = expandJobs(parsePackageList(process.env.NODE_PACKAGES, "NODE_PACKAGES"), NODE_SHARD_COUNTS);
	const bunJobs = expandJobs(parsePackageList(process.env.BUN_PACKAGES, "BUN_PACKAGES"), BUN_SHARD_COUNTS);
	const internal = process.env.INTERNAL_PR === "true";
	const raw = process.env.SELF_HOSTED_SHARDS;
	const requested = raw === undefined || raw.trim() === "" ? 0 : Number(raw);
	if (!Number.isSafeInteger(requested) || requested < 0) {
		throw new Error(`SELF_HOSTED_SHARDS must be a non-negative integer, got ${raw}`);
	}
	if (!internal && requested > 0) {
		console.log("fork pull request: every job stays on GitHub-hosted runners, SELF_HOSTED_SHARDS ignored");
	}
	const slots = internal ? requested : 0;
	// The slowest job of a run is a Node shard, so the slots are handed out to Node jobs first; Bun jobs get
	// whatever is left over.
	const nodeSlots = Math.min(slots, nodeJobs.length);
	const nodeShards = JSON.stringify(assignRunners(nodeJobs, nodeSlots));
	const bunShards = JSON.stringify(assignRunners(bunJobs, slots - nodeSlots));

	const output = process.env.GITHUB_OUTPUT;
	if (output) {
		appendFileSync(output, `node_shards=${nodeShards}\nbun_shards=${bunShards}\n`);
	} else {
		console.log(
			JSON.stringify(
				{
					node_shards: assignRunners(nodeJobs, nodeSlots),
					bun_shards: assignRunners(bunJobs, slots - nodeSlots),
				},
				null,
				2,
			),
		);
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
