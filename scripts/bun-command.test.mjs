import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveBunExecutable } from "./bun-command.mjs";

// Bun ships a `bun.cmd` shim on Windows, which `spawnSync` refuses to launch without `shell: true`
// (CVE-2024-27980), and the shell would concatenate arguments instead of escaping them.
test("resolves Bun's real executable on Windows", (t) => {
	if (process.platform !== "win32") {
		t.skip("Windows-only resolution: other platforms spawn the bare `bun` name");
		return;
	}

	const prefix = mkdtempSync(join(tmpdir(), "nyan-bun-command-"));
	const originalPath = process.env.PATH;
	try {
		const wrapped = join(prefix, "node_modules", "bun", "bin", "bun.exe");
		mkdirSync(join(prefix, "node_modules", "bun", "bin"), { recursive: true });
		writeFileSync(wrapped, "");
		// A `bun.cmd` beside the prefix is what the installer leaves behind.
		writeFileSync(join(prefix, "bun.cmd"), "@echo off\r\n");

		process.env.PATH = prefix;
		assert.equal(resolveBunExecutable(), wrapped, "resolves the wrapped bun.exe named by the shim");
	} finally {
		process.env.PATH = originalPath;
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("falls back to the bare name when no shim wraps an executable", () => {
	if (process.platform !== "win32") return;

	const prefix = mkdtempSync(join(tmpdir(), "nyan-bun-command-empty-"));
	const originalPath = process.env.PATH;
	try {
		process.env.PATH = `${prefix}${delimiter}${prefix}`;
		assert.equal(resolveBunExecutable(), "bun");
	} finally {
		process.env.PATH = originalPath;
		rmSync(prefix, { recursive: true, force: true });
	}
});
