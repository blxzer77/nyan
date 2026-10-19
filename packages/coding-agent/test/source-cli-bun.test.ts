import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";

const temporaryHomes: string[] = [];
const sourceCli = resolve(__dirname, "../../../scripts/nyan-source.mjs");

function runSourceCli(...args: string[]) {
	const home = mkdtempSync(join(tmpdir(), "nyan-source-cli-"));
	temporaryHomes.push(home);
	return spawnSync(process.execPath, [sourceCli, ...args], {
		cwd: home,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NYAN_CODING_AGENT_DIR: join(home, ".nyan", "agent"),
			NYAN_OFFLINE: "1",
		},
	});
}

afterEach(() => {
	for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("source CLI", () => {
	it("runs --version under the current runtime", () => {
		const result = runSourceCli("--version");

		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("runs offline --list-models under the current runtime", () => {
		const result = runSourceCli("--list-models");

		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).not.toContain("Export named 'registerHooks' not found");
	});
});
