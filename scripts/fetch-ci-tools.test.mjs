import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { loadTools, TOOLS } from "./fetch-ci-tools.mjs";

const script = join(resolve(import.meta.dirname), "fetch-ci-tools.mjs");
const ARCHES = { x64: "x86_64", arm64: "aarch64" };
const arch = ARCHES[process.arch];
// The fixture archives hold a POSIX shell script, which is the tool these tests run; Windows cannot execute one.
const supported = {
	skip:
		process.platform === "win32"
			? "a POSIX shell script cannot run on win32"
			: arch === undefined
				? `no pinned build for cpu ${process.arch}`
				: false,
};

const directories = [];

function temporaryDirectory(prefix) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A stand-in for a release download: one URL per name, and a 404 for anything else. */
async function startServer(files, { status = 200 } = {}) {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(request.url);
		const body = files[request.url];
		if (body === undefined || status !== 200) {
			response.writeHead(status === 200 ? 404 : status).end();
			return;
		}
		response.writeHead(200).end(body);
	});
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((closed) => server.close(closed)),
	};
}

/** Builds a tarball shaped like the real release: `<name>-<version>-<arch>/<name>`, holding a script. */
function archiveFor(name, version, { body = `#!/bin/sh\necho "${name} ${version}"\n` } = {}) {
	const work = temporaryDirectory(`nyan-ci-tools-${name}-`);
	const folder = `${name}-${version}-${String(arch)}`;
	mkdirSync(join(work, folder), { recursive: true });
	writeFileSync(join(work, folder, name), body, { mode: 0o755 });
	const path = join(work, `${name}.tar.gz`);
	const tar = spawnSync("tar", ["-czf", path, "-C", work, folder], { encoding: "utf8" });
	assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
	return readFileSync(path);
}

/** Writes the manifest the script reads through `NYAN_CI_TOOLS_MANIFEST`. */
function manifestFor(tools) {
	const path = join(temporaryDirectory("nyan-ci-tools-manifest-"), "tools.json");
	writeFileSync(path, JSON.stringify(tools));
	return path;
}

/** A manifest entry for a fake release served by `base`. */
function entryFor(name, version, base, { sha256, archive = archiveFor(name, version) } = {}) {
	return {
		version,
		url: `${base}/${name}.tar.gz`,
		archiveBinary: `${name}-${version}-{arch}/${name}`,
		sha256: sha256 ?? createHash("sha256").update(archive).digest("hex"),
	};
}

/** Runs the script as a process. Async, because the stub download server lives in this process. */
function run(args, env) {
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
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

/** An installed fake tool that reports `version`, or runs `body` instead when a case needs a different behaviour. */
function installTool(outDir, name, version, { body = `#!/bin/sh\necho "${name} ${version}"\n` } = {}) {
	mkdirSync(outDir, { recursive: true });
	const path = join(outDir, name);
	writeFileSync(path, body, { mode: 0o755 });
	return path;
}

test("an installed tool at the pinned version is reused without downloading", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	installTool(out, "rg", "9.9.9");
	const server = await startServer({});
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.equal(result.stdout.trim(), `${out} already holds rg at the pinned versions; nothing to do`);
		assert.deepEqual(server.requests, [], "the pinned version was accepted without asking the network");
	} finally {
		await server.close();
	}
});

test("a truncated binary is fetched again", supported, async () => {
	// File existence used to be the whole test, so a half-written download was reused as a working tool.
	const out = temporaryDirectory("nyan-ci-tools-out-");
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "rg"), "not an executable\n", { mode: 0o755 });
	const server = await startServer({ "/rg.tar.gz": archiveFor("rg", "9.9.9") });
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.match(result.stdout, new RegExp(`^${out}/rg: missing or does not run; fetching it again$`, "m"));
		assert.match(result.stdout, new RegExp(`^rg 9\\.9\\.9: ${out}/rg \\(rg 9\\.9\\.9\\)$`, "m"));
		assert.deepEqual(server.requests, ["/rg.tar.gz"]);
		assert.equal(installedVersion(join(out, "rg")), "rg 9.9.9");
	} finally {
		await server.close();
	}
});

test("an older binary is fetched again", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	installTool(out, "rg", "1.0.0");
	const server = await startServer({ "/rg.tar.gz": archiveFor("rg", "9.9.9") });
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.match(result.stdout, new RegExp(`^${out}/rg: reports "rg 1\\.0\\.0", not 9\\.9\\.9; fetching it again$`, "m"));
		assert.equal(installedVersion(join(out, "rg")), "rg 9.9.9");
	} finally {
		await server.close();
	}
});

test("only the tool that is out of date is fetched again", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	installTool(out, "rg", "9.9.9");
	installTool(out, "fd", "1.0.0");
	const server = await startServer({ "/fd.tar.gz": archiveFor("fd", "9.9.9") });
	try {
		const manifest = manifestFor({
			rg: entryFor("rg", "9.9.9", server.url),
			fd: entryFor("fd", "9.9.9", server.url),
		});
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.deepEqual(server.requests, ["/fd.tar.gz"]);
		assert.equal(installedVersion(join(out, "fd")), "fd 9.9.9");
	} finally {
		await server.close();
	}
});

test("a download the server refuses fails the run", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	const server = await startServer({});
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /^could not download rg: HTTP 404 for .*\/rg\.tar\.gz$/m);
	} finally {
		await server.close();
	}
});

test("an archive whose digest does not match the pin is refused", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	const server = await startServer({ "/rg.tar.gz": archiveFor("rg", "9.9.9") });
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url, { sha256: "0".repeat(64) }) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			new RegExp(`^rg archive digest is [0-9a-f]{64}, expected ${"0".repeat(64)}; refusing to install it$`, "m"),
		);
		assert.equal(installedVersionIfPresent(join(out, "rg")), undefined, "nothing was installed");
	} finally {
		await server.close();
	}
});

test("a manifest without a pinned digest is refused", supported, async () => {
	const out = temporaryDirectory("nyan-ci-tools-out-");
	const server = await startServer({});
	try {
		const manifest = manifestFor({ rg: { version: "9.9.9", url: `${server.url}/rg.tar.gz`, archiveBinary: "x" } });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /^the tool manifest .* has no sha256 for rg$/m);
	} finally {
		await server.close();
	}
});

test("a version probe that hangs is treated as not running instead of blocking the job", supported, async () => {
	// `--out` holds whatever was there before, including a binary from an interrupted download. Without a timeout the
	// probe blocked until the whole `prepare` job timed out; now it gives up and fetches the tool again.
	const out = temporaryDirectory("nyan-ci-tools-out-");
	installTool(out, "rg", "unused", { body: "#!/bin/sh\nsleep 30\n" });
	const server = await startServer({ "/rg.tar.gz": archiveFor("rg", "9.9.9") });
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		const output = `${result.stdout}${result.stderr}`;
		assert.equal(result.status, 0, output);
		assert.match(result.stdout, new RegExp(`^${out}/rg: missing or does not run; fetching it again$`, "m"));
		assert.equal(installedVersion(join(out, "rg")), "rg 9.9.9");
	} finally {
		await server.close();
	}
});

test("a binary that hangs after installation fails with a message, not an empty one", supported, async () => {
	// A probe that times out leaves `status` null and `stderr` empty, so the failure was reported as
	// "rg does not run after installation: " with nothing after it. `reportedVersion` already reports why.
	const out = temporaryDirectory("nyan-ci-tools-out-");
	const archive = archiveFor("rg", "9.9.9", { body: "#!/bin/sh\nsleep 30\n" });
	const server = await startServer({ "/rg.tar.gz": archive });
	try {
		const manifest = manifestFor({ rg: entryFor("rg", "9.9.9", server.url, { archive }) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /^rg does not run after installation: spawnSync .* ETIMEDOUT$/m);
	} finally {
		await server.close();
	}
});

test("a manifest whose tool name is a path is refused", supported, async () => {
	// The name becomes `join(outDir, name)` and the target of a chmod, so `../..` would write outside `--out`.
	const out = temporaryDirectory("nyan-ci-tools-out-");
	const server = await startServer({});
	try {
		const manifest = manifestFor({ "../../escape": entryFor("rg", "9.9.9", server.url) });
		const result = await run(["--out", out], { NYAN_CI_TOOLS_MANIFEST: manifest });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /^the tool manifest .* names an unusable tool: "\.\.\/\.\.\/escape"$/m);
		assert.deepEqual(server.requests, [], "nothing was downloaded for a manifest that cannot be used");
	} finally {
		await server.close();
	}
});

test("the manifest rules can be asserted in process, not only through the script", () => {
	// The module used to run its CLI body on import and to end the process on an invalid manifest, so the validation
	// could only be observed as the exit code of a subprocess. Importing it now runs nothing.
	assert.deepEqual(loadTools({}), TOOLS);
	assert.throws(
		() => loadTools({ NYAN_CI_TOOLS_MANIFEST: manifestFor({ rg: { version: "9.9.9" } }) }),
		/the tool manifest .* has no url for rg/,
	);
	assert.throws(
		() =>
			loadTools({
				NYAN_CI_TOOLS_MANIFEST: manifestFor({ "../escape": entryFor("rg", "9.9.9", "http://127.0.0.1") }),
			}),
		/names an unusable tool: "\.\.\/escape"/,
	);
	assert.throws(() => loadTools({ NYAN_CI_TOOLS_MANIFEST: manifestFor({}) }), /names no tools/);
});

/** The first line an installed fake tool prints, which is the version the script compares. */
function installedVersion(path) {
	const result = spawnSync(path, ["--version"], { encoding: "utf8" });
	assert.equal(result.status, 0, `running ${path} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function installedVersionIfPresent(path) {
	return existsSync(path) ? installedVersion(path) : undefined;
}
