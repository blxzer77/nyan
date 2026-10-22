import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = join(resolve(import.meta.dirname), "prune-caches.mjs");
const GIB = 1024 ** 3;

/**
 * A stand-in for `/repos/{owner}/{repo}/actions/caches`.
 *
 * The script is tested as a process: what it asks the API for and what it prints is the contract, so the API is the
 * only thing faked, and it is faked at its own boundary (HTTP) rather than inside the script.
 */
async function startApi({ caches, deleteStatus = () => 204 }) {
	const requests = [];
	const server = createServer((request, response) => {
		const page = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("page") ?? "1");
		requests.push({ method: request.method, url: request.url });
		if (request.method === "DELETE") {
			const id = Number(request.url.split("/").at(-1));
			response.writeHead(deleteStatus(id)).end();
			return;
		}
		const entries = caches.filter((_, index) => Math.floor(index / 100) === page - 1).slice(0, 100);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ total_count: caches.length, actions_caches: entries }));
	});
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		deletes: () => requests.filter((entry) => entry.method === "DELETE").map((entry) => Number(entry.url.split("/").at(-1))),
		close: () => new Promise((closed) => server.close(closed)),
	};
}

/** A cache entry. `ageDays` is how long ago it was last accessed, which is what every rule keys on. */
function cache(id, { key = `cache-${id}`, branch = "main", size = GIB, ageDays = 2 } = {}) {
	const lastAccessed = new Date(Date.now() - ageDays * 86_400_000).toISOString();
	const createdAt = new Date(Date.now() - (ageDays + 5) * 86_400_000).toISOString();
	return {
		id,
		key,
		ref: `refs/heads/${branch}`,
		size_in_bytes: size,
		created_at: createdAt,
		last_accessed_at: lastAccessed,
	};
}

/** Runs the script as a process. Async on purpose: the stub API lives in this process, and a blocked event loop
 * could never answer it. */
function run(args, api) {
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, ...args], {
			env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "token", GITHUB_API_URL: api.url },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("close", (status) => {
			clearTimeout(timer);
			done({ status, stdout, stderr });
		});
	});
}

test("lists every page and deletes what is older than the age limit", async () => {
	// 101 entries, so the first page is full and the script has to ask for a second one.
	const caches = [cache(1, { ageDays: 20 }), ...Array.from({ length: 99 }, (_, index) => cache(100 + index, { ageDays: 20 }))];
	caches.push(cache(300, { ageDays: 1 }));
	const api = await startApi({ caches });
	try {
		const result = await run(["--branch", "main", "--max-age-days", "14", "--max-bytes", String(200 * GIB)], api);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^caches: 101, 101\.00 GB$/m);
		assert.match(result.stdout, /^deleting 100 of 101 caches, 100\.00 GB$/m);
		assert.deepEqual(
			api.requests.filter((entry) => entry.method === "GET").map((entry) => entry.url),
			["/repos/owner/repo/actions/caches?per_page=100&page=1", "/repos/owner/repo/actions/caches?per_page=100&page=2"],
		);
		assert.equal(api.deletes().length, 100);
		assert.equal(api.deletes().includes(300), false, "the entry accessed yesterday is kept");
	} finally {
		await api.close();
	}
});

test("--dry-run reports what it would delete and deletes nothing", async () => {
	const api = await startApi({ caches: [cache(1, { ageDays: 20 }), cache(2, { ageDays: 30 })] });
	try {
		const result = await run(["--branch", "main", "--max-age-days", "14", "--dry-run"], api);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /^would delete 2 of 2 caches, 2\.00 GB$/m);
		assert.match(result.stdout, /^dry run complete: 2 -> 0 caches, 2\.00 GB -> 0\.00 GB \(limit .*age limit 14 d\)$/m);
		assert.deepEqual(api.deletes(), []);
	} finally {
		await api.close();
	}
});

test("the default branch is protected: its entries go last, and a recently used one never goes", async () => {
	const caches = [
		cache(1, { branch: "topic", size: GIB, ageDays: 5 }),
		cache(2, { branch: "main", size: GIB, ageDays: 3 }),
		cache(3, { branch: "main", size: GIB, ageDays: 0.1 }),
	];

	// Nothing is over the age limit here; the squeeze is the size budget, so only the off-default entry has to go.
	const api = await startApi({ caches });
	try {
		const result = await run(["--branch", "main", "--max-bytes", String(2.5 * GIB)], api);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(api.deletes(), [1]);
	} finally {
		await api.close();
	}

	// With no budget at all, the default branch's stale entry goes too, and the one used today still stays.
	const strict = await startApi({ caches });
	try {
		const result = await run(["--branch", "main", "--max-bytes", "0"], strict);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(strict.deletes(), [1, 2]);
		assert.match(result.stdout, /pruned: 3 -> 1 caches, 3\.00 GB -> 1\.00 GB/);
	} finally {
		await strict.close();
	}
});

test("the default branch is the branch it was told about, not a hardcoded main", async () => {
	// A repository whose default branch is `develop`: its entries are the protected ones.
	const caches = [cache(1, { branch: "develop", ageDays: 0.1 }), cache(2, { branch: "main", ageDays: 5 })];
	const api = await startApi({ caches });
	try {
		const result = await run(["--branch", "develop", "--max-bytes", "0"], api);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(api.deletes(), [2], "main is an ordinary branch here, and it is the only one dropped");
	} finally {
		await api.close();
	}
});

test("a delete the API rejects fails the run", async () => {
	const api = await startApi({
		caches: [cache(7, { ageDays: 20 }), cache(8, { ageDays: 20 })],
		deleteStatus: (id) => (id === 7 ? 500 : 204),
	});
	try {
		const result = await run(["--branch", "main", "--max-age-days", "14"], api);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /deleting cache 7 failed: HTTP 500/);
		assert.deepEqual(api.deletes(), [7], "the run stops at the first refusal instead of reporting success");
	} finally {
		await api.close();
	}
});

test("an empty listing is a no-op, not a failure", async () => {
	const api = await startApi({ caches: [] });
	try {
		const result = await run(["--branch", "main"], api);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "caches: 0, 0.00 GB\nno caches to prune");
	} finally {
		await api.close();
	}
});

test("an unusable limit is refused instead of silently pruning nothing", async () => {
	// The reported defect: `--max-age-days foo` made every age comparison false and every size comparison false, so
	// the run reported success while doing nothing. A negative budget could delete almost everything instead.
	const api = await startApi({ caches: [cache(1, { ageDays: 20 })] });
	try {
		for (const [args, message] of [
			[["--branch", "main", "--max-age-days", "foo"], /--max-age-days must be a finite, non-negative number, got "foo"/],
			[["--branch", "main", "--max-bytes", "-1"], /--max-bytes must be a finite, non-negative number, got "-1"/],
			[["--branch", "main", "--max-bytes", "Infinity"], /--max-bytes must be a finite, non-negative number/],
			[["--branch", "main", "--max-age-days"], /--max-age-days needs a value/],
		]) {
			const result = await run(args, api);
			assert.equal(result.status, 2, `${args.join(" ")} must be refused`);
			assert.match(result.stderr, message);
		}
		assert.deepEqual(api.requests, [], "nothing was read, let alone deleted");
	} finally {
		await api.close();
	}
});

test("a blank limit is refused instead of becoming a limit of zero", async () => {
	// `Number("")` and `Number("  ")` are 0, which passed a finite and non-negative check. `--max-bytes "$MAX_BYTES"`
	// with an unset variable then meant "no budget at all" and the run deleted every entry the rules allow, and a blank
	// `--max-age-days` marked everything older than this second as past the limit.
	const api = await startApi({ caches: [cache(1, { ageDays: 20 }), cache(2, { branch: "topic", ageDays: 0.1 })] });
	try {
		for (const [args, message] of [
			[["--branch", "main", "--max-bytes", ""], /--max-bytes must be a finite, non-negative number, got ""/],
			[["--branch", "main", "--max-age-days", "  "], /--max-age-days must be a finite, non-negative number, got "  "/],
		]) {
			const result = await run(args, api);
			assert.equal(result.status, 2, `${JSON.stringify(args)} must be refused`);
			assert.match(result.stderr, message);
		}
		assert.deepEqual(api.requests, [], "nothing was read, let alone deleted");
	} finally {
		await api.close();
	}
});

test("a run without --branch is refused", async () => {
	const api = await startApi({ caches: [cache(1, { ageDays: 20 })] });
	try {
		const result = await run(["--max-age-days", "14"], api);

		assert.equal(result.status, 2);
		assert.match(result.stderr, /--branch is required: pass the repository's default branch/);
		assert.deepEqual(api.requests, []);
	} finally {
		await api.close();
	}
});
