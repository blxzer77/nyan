#!/usr/bin/env node

// Expands the packages selected by ci-impact.mjs into test jobs. The two large suites are split with
// vitest's own `--shard=i/n`, which partitions files by count: every file lands in exactly one shard, so
// nothing needs a hand-maintained list of files. The counts are the knob. Measured on a 4-vCPU hosted
// runner, the unsplit coding-agent Node suite was the longest job of the run at 187 s.
//
// Output (for GITHUB_OUTPUT, or stdout when run outside Actions):
//   node_shards  JSON array of { name, package, shard }; `shard` is "" when the package is not split
//   bun_shards   the same shape for the Bun matrix

import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";

export const NODE_SHARD_COUNTS = { "coding-agent": 4, durable: 3 };
export const BUN_SHARD_COUNTS = { "coding-agent": 2, durable: 2 };

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

function main() {
	const nodeJobs = expandJobs(parsePackageList(process.env.NODE_PACKAGES, "NODE_PACKAGES"), NODE_SHARD_COUNTS);
	const bunJobs = expandJobs(parsePackageList(process.env.BUN_PACKAGES, "BUN_PACKAGES"), BUN_SHARD_COUNTS);
	const nodeShards = JSON.stringify(nodeJobs);
	const bunShards = JSON.stringify(bunJobs);

	const output = process.env.GITHUB_OUTPUT;
	if (output) {
		appendFileSync(output, `node_shards=${nodeShards}\nbun_shards=${bunShards}\n`);
	} else {
		console.log(JSON.stringify({ node_shards: nodeJobs, bun_shards: bunJobs }, null, 2));
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
