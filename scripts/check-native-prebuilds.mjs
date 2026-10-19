#!/usr/bin/env node

/**
 * Check the committed `packages/tui` prebuilds are structurally valid for the platform they claim to target.
 *
 *   node scripts/check-native-prebuilds.mjs [--platform linux|darwin|win32] [--load]
 *
 * The release workflow rebuilds these on each platform and publishes the fresh ones; the committed copies exist so a
 * source checkout runs without a toolchain. Nothing verified them, so a rebuild that produced nothing, or produced a
 * file for the wrong platform, would only be noticed by a user.
 *
 * What this checks, without a toolchain and on any host:
 *
 *   - the file exists and is not empty,
 *   - its magic bytes match the platform it is filed under (ELF, Mach-O, PE),
 *   - with `--load`, the file for *this* host loads and exports the clipboard entry points. Loading another
 *     platform's binary is not possible and is not attempted.
 *
 * Byte-identical output is deliberately not required: two toolchains legitimately produce different binaries, and a
 * comparison would fail for a reason that says nothing about whether the module works.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeRoot = join(repoRoot, "packages", "tui", "native");

/** Every prebuild the published package ships. A missing one is a broken install for that platform. */
const EXPECTED = [
	{ platform: "linux", arch: "x64", file: "linux/prebuilds/linux-x64/linux-platform-x11.node" },
	{ platform: "linux", arch: "arm64", file: "linux/prebuilds/linux-arm64/linux-platform-x11.node" },
	{ platform: "darwin", arch: "x64", file: "darwin/prebuilds/darwin-x64/darwin-platform.node" },
	{ platform: "darwin", arch: "arm64", file: "darwin/prebuilds/darwin-arm64/darwin-platform.node" },
	{ platform: "win32", arch: "x64", file: "win32/prebuilds/win32-x64/win32-platform.node" },
	{ platform: "win32", arch: "arm64", file: "win32/prebuilds/win32-arm64/win32-platform.node" },
];

const MAGIC = {
	linux: [0x7f, 0x45, 0x4c, 0x46], // ELF
	darwin: [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit, little endian
	win32: [0x4d, 0x5a], // MZ
};

const args = process.argv.slice(2);
const platformIndex = args.indexOf("--platform");
const only = platformIndex === -1 ? undefined : args[platformIndex + 1];
const load = args.includes("--load");

if (only !== undefined && !["linux", "darwin", "win32"].includes(only)) {
	console.error(`--platform must be linux, darwin or win32, got ${only}`);
	process.exit(2);
}

if (!existsSync(nativeRoot)) {
	console.error(`${nativeRoot} does not exist; this script must run inside the repository`);
	process.exit(1);
}

const failures = [];
const checked = [];

for (const entry of EXPECTED) {
	if (only !== undefined && entry.platform !== only) continue;
	const path = join(nativeRoot, entry.file);
	if (!existsSync(path)) {
		failures.push(`${entry.file}: missing`);
		continue;
	}
	const size = statSync(path).size;
	if (size === 0) {
		failures.push(`${entry.file}: empty`);
		continue;
	}
	const head = readFileSync(path, { encoding: null }).subarray(0, 4);
	const expected = MAGIC[entry.platform];
	const matches = expected.every((byte, index) => head[index] === byte);
	if (!matches) {
		failures.push(
			`${entry.file}: magic ${[...head].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")} does not match ${entry.platform}`,
		);
		continue;
	}
	checked.push(`${entry.file} (${size} bytes)`);
}

// Only the host's own binary can be loaded; the others are cross-compiled and checked structurally above.
if (load) {
	const host = EXPECTED.find((entry) => entry.platform === process.platform && entry.arch === process.arch);
	if (host === undefined) {
		console.log(`no prebuild for this host (${process.platform}-${process.arch}); skipping the load check`);
	} else {
		try {
			const addon = createRequire(import.meta.url)(join(nativeRoot, host.file));
			const missing = ["getText", "getImage"].filter((name) => typeof addon[name] !== "function");
			if (missing.length > 0) failures.push(`${host.file}: loads but does not export ${missing.join(", ")}`);
			else checked.push(`${host.file} loads and exports getText and getImage`);
		} catch (error) {
			failures.push(`${host.file}: does not load: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

for (const line of checked) console.log(`ok ${line}`);
if (failures.length > 0) {
	console.error(`\n${failures.length} prebuild check(s) failed:`);
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${checked.length} prebuild(s) passed.`);
