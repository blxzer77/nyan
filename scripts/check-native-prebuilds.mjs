#!/usr/bin/env node

/**
 * Check the committed `packages/tui` prebuilds are structurally valid for the platform they claim to target.
 *
 *   node scripts/check-native-prebuilds.mjs [--platform linux|darwin|win32] [--root <dir>] [--load]
 *
 * The release workflow rebuilds these on each platform and publishes the fresh ones; the committed copies exist so a
 * source checkout runs without a toolchain. Nothing verified them, so a rebuild that produced nothing, or produced a
 * file for the wrong platform, would only be noticed by a user.
 *
 * What this checks, without a toolchain and on any host:
 *
 *   - the file exists and is not empty,
 *   - its magic bytes match the platform it is filed under (ELF, Mach-O, PE),
 *   - its header names the CPU architecture of the directory it is filed under: `e_machine` in an ELF header,
 *     `cputype` in a Mach-O header, `Machine` in a PE's COFF header. A valid x64 binary filed under `arm64/` used to
 *     pass on its magic alone and would only fail on a user's machine,
 *   - with `--load`, the file for *this* host loads and exports the clipboard entry points. Loading another
 *     platform's binary is not possible and is not attempted.
 *
 * `--root` checks a different prebuild tree; the tests use it to build one failure at a time in a temporary directory.
 *
 * Byte-identical output is deliberately not required: two toolchains legitimately produce different binaries, and a
 * comparison would fail for a reason that says nothing about whether the module works.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

/** The machine field each object format uses for an architecture. */
const MACHINES = {
	x64: { linux: 0x3e, darwin: 0x01000007, win32: 0x8664 },
	arm64: { linux: 0xb7, darwin: 0x0100000c, win32: 0xaa64 },
};

const args = process.argv.slice(2);
const platformIndex = args.indexOf("--platform");
const only = platformIndex === -1 ? undefined : args[platformIndex + 1];
const rootIndex = args.indexOf("--root");
const nativeRoot = rootIndex === -1 ? join(repoRoot, "packages", "tui", "native") : args[rootIndex + 1];
const load = args.includes("--load");

if (only !== undefined && !["linux", "darwin", "win32"].includes(only)) {
	console.error(`--platform must be linux, darwin or win32, got ${only}`);
	process.exit(2);
}

if (nativeRoot === undefined) {
	console.error("--root needs a directory");
	process.exit(2);
}

if (!existsSync(nativeRoot)) {
	console.error(`${nativeRoot} does not exist; this script must run inside the repository`);
	process.exit(1);
}

/** The architecture the object header names, or undefined when the header is too short to carry one. */
function machineOf(buffer, platform) {
	if (platform === "linux") {
		// ELF: e_ident[16] then e_type (2) and e_machine (2).
		return buffer.length < 0x14 ? undefined : buffer.readUInt16LE(0x12);
	}
	if (platform === "darwin") {
		// Mach-O: magic (4) then cputype (4). The accepted magic is the 64-bit little-endian one.
		return buffer.length < 8 ? undefined : buffer.readUInt32LE(4);
	}
	// PE: the DOS header holds the offset of the COFF header at 0x3c, whose Machine field follows the "PE\0\0"
	// signature.
	if (buffer.length < 0x40) return undefined;
	const coff = buffer.readUInt32LE(0x3c);
	return coff + 6 > buffer.length ? undefined : buffer.readUInt16LE(coff + 4);
}

const hex = (value) => `0x${value.toString(16)}`;

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
	const buffer = readFileSync(path);
	const expected = MAGIC[entry.platform];
	const matches = expected.every((byte, index) => buffer[index] === byte);
	if (!matches) {
		const head = buffer.subarray(0, 4);
		failures.push(
			`${entry.file}: magic ${[...head].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")} does not match ${entry.platform}`,
		);
		continue;
	}
	const machine = machineOf(buffer, entry.platform);
	const expectedMachine = MACHINES[entry.arch][entry.platform];
	if (machine !== expectedMachine) {
		failures.push(
			`${entry.file}: ${entry.platform} machine ${machine === undefined ? "is missing from the header" : hex(machine)} is not ${entry.arch} (expected ${hex(expectedMachine)})`,
		);
		continue;
	}
	checked.push(`${entry.file} (${size} bytes, ${entry.platform} ${entry.arch})`);
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
