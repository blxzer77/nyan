#!/usr/bin/env node

/**
 * Fetch the two command-line tools the suites need, as static binaries, so no CI job runs `apt-get`.
 *
 *   node scripts/fetch-ci-tools.mjs [--out <dir>]
 *
 * Every job that runs `find` or `grep` through the coding-agent tools resolves `rg` and `fd` on `PATH`
 * (`packages/coding-agent/src/utils/tools-manager.ts`). Under `NYAN_OFFLINE` a missing binary is not downloaded,
 * so the tool reports itself unavailable and its tests fail. The hosted Ubuntu image ships neither.
 *
 * Installing them with apt costs 8 to 46 s per job, and 30 jobs per run carried that step. Both projects publish
 * a statically linked musl build, so one download in `prepare` serves every job through the workspace archive.
 *
 * The version and the sha256 of each archive are pinned here, and `{version}` and `{arch}` fill in the URL and the
 * path inside the archive: the version is written once per tool, so a bump cannot leave one of the three places
 * pointing at the previous release. A digest mismatch fails the run: this downloads an executable that the whole suite
 * then trusts.
 *
 * An existing binary under `--out` is reused only when it runs and reports the pinned version. File existence used to
 * be enough, which silently reused a truncated or older binary, or one built for another CPU. A probe is also given a
 * timeout: a binary that hangs is not an answer either, and waiting on it would stall the job instead of failing it.
 *
 * Every failure is one message and exit code 1, whether it came from the environment, the download or the tool itself.
 * The exported functions throw instead of exiting, so importing one cannot end the caller's process.
 *
 * `NYAN_CI_TOOLS_MANIFEST` overrides the pinned table with a JSON file of the same shape. It exists for
 * `scripts/fetch-ci-tools.test.mjs` (a stubbed archive cannot carry the digest of the real release); production never
 * sets it.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Pinned releases. `sha256` is the digest of the archive, taken from the download verified below. */
export const TOOLS = {
	rg: {
		version: "15.2.0",
		url: "https://github.com/BurntSushi/ripgrep/releases/download/{version}/ripgrep-{version}-{arch}-unknown-linux-musl.tar.gz",
		sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
		// Both tarballs nest everything under one directory.
		archiveBinary: "ripgrep-{version}-{arch}-unknown-linux-musl/rg",
	},
	fd: {
		version: "10.5.0",
		url: "https://github.com/sharkdp/fd/releases/download/v{version}/fd-v{version}-{arch}-unknown-linux-musl.tar.gz",
		sha256: "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
		// fd's tarball nests everything under one directory.
		archiveBinary: "fd-v{version}-{arch}-unknown-linux-musl/fd",
	},
};

/** Only the hosts the CI jobs run on. A platform this does not cover keeps its own install step. */
const ARCHES = { x64: "x86_64", arm64: "aarch64" };

/** How long a `--version` probe may take before the binary is treated as one that does not run. */
const PROBE_TIMEOUT_MS = 5_000;

function expand(template, values) {
	return template.replaceAll("{version}", values.version).replaceAll("{arch}", values.arch);
}

function digest(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

/** The first line of a `--version` run, which is the line that carries the version number. */
function firstLine(result) {
	return (result.stdout ?? "").split("\n")[0];
}

/** Why a run gave no usable answer. `stderr` is absent when the process could not be started at all. */
function describeFailure(result) {
	if (result.error) return result.error.message;
	return (result.stderr ?? "").trim() || `exit status ${result.status}`;
}

/** The first line `<path> --version` prints, or undefined when it is missing, does not run or does not answer. */
function reportedVersion(path) {
	if (!existsSync(path)) return undefined;
	const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
	if (result.error || result.status !== 0) return undefined;
	return firstLine(result);
}

/** True when a reported version line names `version` exactly: a token match, so "15.2.0" cannot match "15.2.01". */
function reportsVersion(first, version) {
	return first !== undefined && first.split(/\s+/).includes(version);
}

export function loadTools(env = process.env) {
	const path = env.NYAN_CI_TOOLS_MANIFEST;
	if (path === undefined || path === "") return TOOLS;
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	for (const [name, tool] of Object.entries(parsed)) {
		// The name becomes a file name under `--out`, so it must not be one that leaves that directory.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
			throw new Error(`the tool manifest ${path} names an unusable tool: ${JSON.stringify(name)}`);
		}
		for (const field of ["version", "url", "archiveBinary", "sha256"]) {
			if (typeof tool?.[field] !== "string" || tool[field] === "") {
				throw new Error(`the tool manifest ${path} has no ${field} for ${name}`);
			}
		}
	}
	if (Object.keys(parsed).length === 0) throw new Error(`the tool manifest ${path} names no tools`);
	return parsed;
}

/** The tools in `tools` that `outDir` does not already hold at the pinned version. */
export function staleTools(outDir, tools = TOOLS) {
	const stale = [];
	for (const [name, tool] of Object.entries(tools)) {
		// One probe per binary: it starts a process, and the reason reported below is built from the same answer.
		const first = reportedVersion(join(outDir, name));
		if (reportsVersion(first, tool.version)) continue;
		stale.push({
			name,
			reason: first === undefined ? "missing or does not run" : `reports "${first}", not ${tool.version}`,
		});
	}
	return stale;
}

function extract(archive, name, destination) {
	const result = spawnSync("tar", ["-xzf", archive, "-C", destination, name], { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`tar could not extract ${name} from ${archive}: ${describeFailure(result)}`);
	}
}

export async function fetchTools(outDir, { arch = process.arch, tools = TOOLS } = {}) {
	const archName = ARCHES[arch];
	if (!archName) throw new Error(`no pinned build for cpu ${arch}; this script covers x64 and arm64 Linux only`);

	mkdirSync(outDir, { recursive: true });
	const work = mkdtempSync(join(tmpdir(), "nyan-ci-tools-"));
	try {
		for (const [name, tool] of Object.entries(tools)) {
			const values = { arch: archName, version: tool.version };
			const url = expand(tool.url, values);
			const target = join(outDir, name);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`could not download ${name}: HTTP ${response.status} for ${url}`);
			const body = Buffer.from(await response.arrayBuffer());
			const actual = digest(body);
			if (actual !== tool.sha256) {
				throw new Error(`${name} archive digest is ${actual}, expected ${tool.sha256}; refusing to install it`);
			}
			const archive = join(work, `${name}.tar.gz`);
			writeFileSync(archive, body);
			const member = expand(tool.archiveBinary, values);
			extract(archive, member, work);
			copyFileSync(join(work, member), target);
			chmodSync(target, 0o755);

			const result = spawnSync(target, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
			if (result.error || result.status !== 0) {
				throw new Error(`${name} does not run after installation: ${describeFailure(result)}`);
			}
			const first = firstLine(result);
			if (!reportsVersion(first, tool.version)) {
				throw new Error(`${name} reports "${first}" after installation, expected ${tool.version}`);
			}
			console.log(`${name} ${tool.version}: ${target} (${first})`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function main() {
	const outIndex = process.argv.indexOf("--out");
	const outDir = outIndex === -1 ? join(process.cwd(), ".ci", "bin") : process.argv[outIndex + 1];
	if (!outDir) throw new Error("--out needs a directory");

	const tools = loadTools();
	const stale = staleTools(outDir, tools);
	if (stale.length === 0) {
		console.log(`${outDir} already holds ${Object.keys(tools).join(", ")} at the pinned versions; nothing to do`);
		return;
	}
	for (const { name, reason } of stale) console.log(`${outDir}/${name}: ${reason}; fetching it again`);
	const wanted = Object.fromEntries(stale.map(({ name }) => [name, tools[name]]));
	await fetchTools(outDir, { tools: wanted });
}

// The script runs only as the entry point: an importer gets the functions above and nothing else, which is what makes
// their exports usable.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
