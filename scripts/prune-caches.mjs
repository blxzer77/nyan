#!/usr/bin/env node

/**
 * Prune the GitHub Actions caches, so 10 GB of quota does not slowly fill with entries nobody will reuse.
 *
 *   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/prune-caches.mjs [--max-age-days 14] [--max-bytes 7e9] [--dry-run]
 *
 * GitHub already evicts an entry after 7 days without access and evicts oldest-first above the limit. This is the
 * cheaper middle ground: `main`'s entries are the ones a new branch restores from, and they are the ones a flood of
 * pull-request entries pushes out first. So the order is
 *
 *   1. delete anything not accessed within `--max-age-days`,
 *   2. then delete the oldest remaining entries that are not on the default branch until the total is under
 *      `--max-bytes`,
 *   3. never delete an entry on the default branch that was accessed in the last day.
 *
 * The run prints what it did, and the workflow copies that into the job summary.
 */

const { GITHUB_REPOSITORY, GH_TOKEN } = process.env;
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
};

const dryRun = args.includes("--dry-run");
const maxAgeDays = Number(option("--max-age-days", "14"));
const maxBytes = Number(option("--max-bytes", String(7 * 1024 ** 3)));
const branch = option("--branch", "main");

if (!GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is required");
if (!GH_TOKEN) throw new Error("GH_TOKEN is required");

const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/caches`;
const headers = {
	Accept: "application/vnd.github+json",
	Authorization: `Bearer ${GH_TOKEN}`,
	"X-GitHub-Api-Version": "2022-11-28",
};

async function listCaches() {
	const caches = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`${api}?per_page=100&page=${page}`, { headers });
		if (!response.ok) throw new Error(`listing caches failed: HTTP ${response.status} ${await response.text()}`);
		const body = await response.json();
		caches.push(...body.actions_caches);
		if (body.actions_caches.length < 100) return caches;
	}
}

async function deleteCache(id) {
	const response = await fetch(`${api}/${id}`, { method: "DELETE", headers });
	// 404 means something else already deleted it, which is the same outcome.
	if (!response.ok && response.status !== 404) {
		throw new Error(`deleting cache ${id} failed: HTTP ${response.status}`);
	}
}

const human = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

const caches = await listCaches();
const now = Date.now();
const total = caches.reduce((sum, cache) => sum + cache.size_in_bytes, 0);
console.log(`caches: ${caches.length}, ${human(total)}`);

const onDefaultBranch = (cache) => cache.ref === `refs/heads/${branch}`;
const ageDays = (cache) => (now - Date.parse(cache.last_accessed_at)) / 86_400_000;

// Refuse to act on an implausible listing: an empty page here would delete nothing, but a partial one would misjudge
// the total, and the whole point is to keep the quota predictable.
if (caches.length === 0) {
	console.log("no caches to prune");
	process.exit(0);
}

const doomed = caches.filter((cache) => ageDays(cache) > maxAgeDays);
let freed = doomed.reduce((sum, cache) => sum + cache.size_in_bytes, 0);
let remaining = total - freed;

if (remaining > maxBytes) {
	const byAge = (left, right) => Date.parse(left.last_accessed_at) - Date.parse(right.last_accessed_at);
	// Branch and pull-request entries first: they are scoped to a ref nobody restores from again. `main`'s entry is
	// what a new branch restores, so it is only touched when dropping every other entry was not enough.
	const offDefaultBranch = caches
		.filter((cache) => !doomed.includes(cache) && !onDefaultBranch(cache))
		.sort(byAge);
	const defaultBranch = caches
		.filter((cache) => !doomed.includes(cache) && onDefaultBranch(cache) && ageDays(cache) > 1)
		.sort(byAge);
	for (const cache of [...offDefaultBranch, ...defaultBranch]) {
		if (remaining <= maxBytes) break;
		doomed.push(cache);
		freed += cache.size_in_bytes;
		remaining -= cache.size_in_bytes;
	}
}

console.log(`${dryRun ? "would delete" : "deleting"} ${doomed.length} of ${caches.length} caches, ${human(freed)}`);
for (const cache of doomed) {
	console.log(`  ${cache.key} (${cache.ref}, ${human(cache.size_in_bytes)}, last used ${ageDays(cache).toFixed(1)} d ago)`);
}

if (!dryRun) {
	for (const cache of doomed) await deleteCache(cache.id);
}

console.log(
	`${dryRun ? "dry run complete" : "pruned"}: ${caches.length} -> ${caches.length - doomed.length} caches, ` +
		`${human(total)} -> ${human(remaining)} (limit ${human(maxBytes)}, age limit ${maxAgeDays} d)`,
);
