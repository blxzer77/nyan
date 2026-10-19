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
 * The version and the sha256 of each archive are pinned here. A mismatch fails the run: this downloads an
 * executable that the whole suite then trusts.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Pinned releases. `sha256` is the digest of the archive, taken from the download verified below. */
export const TOOLS = {
	rg: {
		version: "15.2.0",
		url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-{arch}-unknown-linux-musl.tar.gz",
		sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
		// Both tarballs nest everything under one directory.
		archiveBinary: "ripgrep-15.2.0-{arch}-unknown-linux-musl/rg",
	},
	fd: {
		version: "10.5.0",
		url: "https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-{arch}-unknown-linux-musl.tar.gz",
		sha256: "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
		// fd's tarball nests everything under one directory.
		archiveBinary: "fd-v10.5.0-{arch}-unknown-linux-musl/fd",
	},
};

/** Only the hosts the CI jobs run on. A platform this does not cover keeps its own install step. */
const ARCHES = { x64: "x86_64", arm64: "aarch64" };

function fail(message) {
	console.error(message);
	process.exit(1);
}

function digest(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function extract(archive, name, destination) {
	const result = spawnSync("tar", ["-xzf", archive, "-C", destination, name], { encoding: "utf8" });
	if (result.status !== 0) {
		fail(`tar could not extract ${name} from ${archive}: ${result.stderr.trim()}`);
	}
}

export async function fetchTools(outDir, { arch = process.arch } = {}) {
	const archName = ARCHES[arch];
	if (!archName) fail(`no pinned build for cpu ${arch}; this script covers x64 and arm64 Linux only`);

	mkdirSync(outDir, { recursive: true });
	const work = mkdtempSync(join(tmpdir(), "nyan-ci-tools-"));
	try {
		for (const [name, tool] of Object.entries(TOOLS)) {
			const target = join(outDir, name);
			const response = await fetch(tool.url.replace("{arch}", archName));
			if (!response.ok) fail(`could not download ${name}: HTTP ${response.status} for ${tool.url.replace("{arch}", archName)}`);
			const body = Buffer.from(await response.arrayBuffer());
			const actual = digest(body);
			if (actual !== tool.sha256) {
				fail(`${name} archive digest is ${actual}, expected ${tool.sha256}; refusing to install it`);
			}
			const archive = join(work, `${name}.tar.gz`);
			writeFileSync(archive, body);
			extract(archive, tool.archiveBinary.replace("{arch}", archName), work);
			copyFileSync(join(work, tool.archiveBinary.replace("{arch}", archName)), target);
			chmodSync(target, 0o755);

			const version = spawnSync(target, ["--version"], { encoding: "utf8" });
			if (version.status !== 0) fail(`${name} does not run after installation: ${version.stderr.trim()}`);
			console.log(`${name} ${tool.version}: ${target} (${version.stdout.split("\n")[0]})`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex === -1 ? join(process.cwd(), ".ci", "bin") : process.argv[outIndex + 1];
if (!outDir) fail("--out needs a directory");

const alreadyThere = Object.keys(TOOLS).every((name) => existsSync(join(outDir, name)));
if (alreadyThere) {
	console.log(`${outDir} already holds rg and fd; nothing to do`);
} else {
	await fetchTools(outDir);
}
