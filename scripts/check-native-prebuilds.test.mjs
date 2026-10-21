import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const script = join(resolve(import.meta.dirname), "check-native-prebuilds.mjs");

/** The layout the published package ships. Repeated here on purpose: the test fails if a path moves. */
const FILES = [
	{ platform: "linux", arch: "x64", file: "linux/prebuilds/linux-x64/linux-platform-x11.node" },
	{ platform: "linux", arch: "arm64", file: "linux/prebuilds/linux-arm64/linux-platform-x11.node" },
	{ platform: "darwin", arch: "x64", file: "darwin/prebuilds/darwin-x64/darwin-platform.node" },
	{ platform: "darwin", arch: "arm64", file: "darwin/prebuilds/darwin-arm64/darwin-platform.node" },
	{ platform: "win32", arch: "x64", file: "win32/prebuilds/win32-x64/win32-platform.node" },
	{ platform: "win32", arch: "arm64", file: "win32/prebuilds/win32-arm64/win32-platform.node" },
];

const roots = [];

function temporaryRoot() {
	const root = mkdtempSync(join(tmpdir(), "nyan-prebuilds-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An ELF header (6 machine fields are all this file format needs to be read as x64 or arm64). */
function elf(arch) {
	const buffer = Buffer.alloc(256);
	Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).copy(buffer, 0);
	buffer.writeUInt16LE(0x0003, 0x10); // e_type: ET_DYN
	buffer.writeUInt16LE(arch === "x64" ? 0x3e : 0xb7, 0x12);
	return buffer;
}

function macho(arch) {
	const buffer = Buffer.alloc(256);
	Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(buffer, 0);
	buffer.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
	return buffer;
}

function pe(arch) {
	const buffer = Buffer.alloc(512);
	Buffer.from([0x4d, 0x5a]).copy(buffer, 0);
	buffer.writeUInt32LE(0x80, 0x3c); // e_lfanew
	buffer.write("PE\0\0", 0x80, "latin1");
	buffer.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x84);
	return buffer;
}

const BUILDERS = { linux: elf, darwin: macho, win32: pe };

/** Writes one prebuild of the given arch spelling, so a file can be wrong in exactly one way. */
function writePrebuild(root, entry, bytes) {
	const path = join(root, entry.file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	return path;
}

function completeTree(mutate = () => {}) {
	const root = temporaryRoot();
	for (const entry of FILES) writePrebuild(root, entry, BUILDERS[entry.platform](entry.arch));
	mutate(root);
	return root;
}

function run(args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("a complete, consistent tree passes", () => {
	const result = run(["--root", completeTree()]);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim().split("\n").at(-1), "6 prebuild(s) passed.");
	assert.match(result.stdout, /^ok linux\/prebuilds\/linux-arm64\/linux-platform-x11\.node \(\d+ bytes, linux arm64\)$/m);
});

test("a missing prebuild fails and names the file", () => {
	const root = completeTree((directory) => rmSync(join(directory, FILES[2].file)));
	const result = run(["--root", root]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /1 prebuild check\(s\) failed:/);
	assert.match(result.stderr, /- darwin\/prebuilds\/darwin-x64\/darwin-platform\.node: missing/);
});

test("an empty prebuild fails", () => {
	const root = completeTree((directory) => writeFileSync(join(directory, FILES[0].file), ""));
	const result = run(["--root", root]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /- linux\/prebuilds\/linux-x64\/linux-platform-x11\.node: empty/);
});

test("a file whose magic matches another platform fails", () => {
	// An ELF filed under win32: the format is wrong before the architecture is even meaningful.
	const root = completeTree((directory) => writeFileSync(join(directory, FILES[4].file), elf("x64")));
	const result = run(["--root", root]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /- win32\/prebuilds\/win32-x64\/win32-platform\.node: magic 7f 45 4c 46 does not match win32/);
});

test("a valid binary for the wrong architecture fails", () => {
	// The reported defect: an x64 ELF in the arm64 directory passed on its magic alone, and the addon published for
	// that platform could not be loaded.
	const root = completeTree((directory) => writeFileSync(join(directory, FILES[1].file), elf("x64")));
	const result = run(["--root", root]);

	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/- linux\/prebuilds\/linux-arm64\/linux-platform-x11\.node: linux machine 0x3e is not arm64 \(expected 0xb7\)/,
	);
});

test("the Mach-O and PE architecture fields are read too", () => {
	const machoRoot = completeTree((directory) => writeFileSync(join(directory, FILES[2].file), macho("arm64")));
	const machoResult = run(["--root", machoRoot]);
	assert.equal(machoResult.status, 1);
	assert.match(
		machoResult.stderr,
		/- darwin\/prebuilds\/darwin-x64\/darwin-platform\.node: darwin machine 0x100000c is not x64 \(expected 0x1000007\)/,
	);

	const peRoot = completeTree((directory) => writeFileSync(join(directory, FILES[5].file), pe("x64")));
	const peResult = run(["--root", peRoot]);
	assert.equal(peResult.status, 1);
	assert.match(
		peResult.stderr,
		/- win32\/prebuilds\/win32-arm64\/win32-platform\.node: win32 machine 0x8664 is not arm64 \(expected 0xaa64\)/,
	);
});

test("--platform checks only that platform, so a cross-compiled tree passes on a host that has one", () => {
	const root = temporaryRoot();
	for (const entry of FILES.filter((candidate) => candidate.platform === "linux")) {
		writePrebuild(root, entry, BUILDERS.linux(entry.arch));
	}

	const filtered = run(["--root", root, "--platform", "linux"]);
	assert.equal(filtered.status, 0, filtered.stderr);
	assert.equal(filtered.stdout.trim().split("\n").at(-1), "2 prebuild(s) passed.");

	const all = run(["--root", root]);
	assert.equal(all.status, 1);
	assert.match(all.stderr, /4 prebuild check\(s\) failed:/);
});

test("--load fails when the host's own prebuild does not load", () => {
	const host = FILES.find((entry) => entry.platform === process.platform && entry.arch === process.arch);
	if (host === undefined) {
		// Only the host's own file is loaded; on a platform without one the script says so and this cannot be reached.
		const result = run(["--root", completeTree(), "--load"]);
		assert.match(result.stdout, /no prebuild for this host .* skipping the load check/);
		return;
	}
	// A structurally valid header with nothing behind it: magic and machine pass, the loader does not.
	const root = completeTree((directory) => writeFileSync(join(directory, host.file), BUILDERS[host.platform](host.arch)));
	const result = run(["--root", root, "--load", "--platform", host.platform]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, new RegExp(`- ${host.file}: does not load: `));
});

test("an unknown platform and a missing root fail with a usage error", () => {
	const unknown = run(["--platform", "freebsd", "--root", completeTree()]);
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /--platform must be linux, darwin or win32, got freebsd/);

	const missing = run(["--root", join(temporaryRoot(), "nope")]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /does not exist; this script must run inside the repository/);
});

test("the committed prebuilds pass, which is the check the release depends on", () => {
	const result = run([]);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim().split("\n").at(-1), "6 prebuild(s) passed.");
});
