#!/usr/bin/env node

/**
 * Prune the GitHub Actions caches, so 10 GB of quota does not slowly fill with entries nobody will reuse.
 *
 *   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/prune-caches.mjs --branch main
 *     [--max-age-days 14] [--max-bytes 7e9] [--dry-run]
 *
 * GitHub already evicts an entry after 7 days without access and evicts oldest-first above the limit. This is the
 * cheaper middle ground: the default branch's entries are the ones a new branch restores from, and they are the ones
 * a flood of pull-request entries pushes out first. So the order is
 *
 *   1. delete anything not accessed within `--max-age-days`,
 *   2. then delete the oldest remaining entries that are not on the default branch until the total is under
 *      `--max-bytes`,
 *   3. never delete an entry on the default branch that was accessed in the last day.
 *
 * `--branch` has no default: the caller knows the repository's default branch (the workflow passes
 * `github.event.repository.default_branch`), and a guess of "main" on a repository that renamed it would treat the
 * real default branch as an ordinary one and delete its entries first.
 *
 * The run prints what it did, and the workflow copies that into the job summary.
 */

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		fail(`${name} needs a value`);
	}
	return value;
};

function fail(message) {
	console.error(message);
	process.exit(2);
}

/** A finite, non-negative number of a command-line option; NaN would silently disable the limit it configures. */
function numberOption(name, fallback) {
	const raw = option(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		fail(`${name} must be a finite, non-negative number, got ${JSON.stringify(raw)}`);
	}
	return value;
}

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GH_TOKEN = process.env.GH_TOKEN;
const GITHUB_API_URL = process.env.GITHUB_API_URL ?? "https://api.github.com";

const dryRun = args.includes("--dry-run");
const maxAgeDays = numberOption("--max-age-days", 14);
const maxBytes = numberOption("--max-bytes", 7 * 1024 ** 3);
const branch = option("--branch");

if (!GITHUB_REPOSITORY) fail("GITHUB_REPOSITORY is required");
if (!GH_TOKEN) fail("GH_TOKEN is required");
if (!branch) fail("--branch is required: pass the repository's default branch");

const api = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/caches`;
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
	// Branch and pull-request entries first: they are scoped to a ref nobody restores from again. The default branch's
	// entry is what a new branch restores, so it is only touched when dropping every other entry was not enough.
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
