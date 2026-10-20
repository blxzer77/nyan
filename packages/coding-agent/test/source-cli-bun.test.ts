import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";

const temporaryHomes: string[] = [];
const sourceCli = resolve(__dirname, "../../../scripts/nyan-source.mjs");

/** A `models.json` that makes one provider answerable without a credential or a network. */
const offlineProvider = {
	providers: {
		audit: {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "audit",
			models: [{ id: "audit-model" }],
		},
	},
};

function runSourceCli(args: string[], options: { readonly models?: unknown } = {}) {
	const home = mkdtempSync(join(tmpdir(), "nyan-source-cli-"));
	temporaryHomes.push(home);
	const agentDir = join(home, ".nyan", "agent");
	mkdirSync(agentDir, { recursive: true });
	if (options.models !== undefined) {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(options.models));
	}
	return spawnSync(process.execPath, [sourceCli, ...args], {
		cwd: home,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NYAN_CODING_AGENT_DIR: agentDir,
			NYAN_OFFLINE: "1",
		},
	});
}

afterEach(() => {
	for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("source CLI", () => {
	it("runs --version under the current runtime", () => {
		const result = runSourceCli(["--version"]);

		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});

	it("runs offline --list-models under the current runtime", () => {
		const result = runSourceCli(["--list-models"], { models: offlineProvider });

		expect(result.error, result.stderr).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		// The table and the configured model, not just a successful exit: a silently empty list passed this test before.
		expect(result.stdout.split("\n")[0]).toMatch(/^provider\s+model\s+context\s+max-out\s+thinking\s+images$/);
		expect(result.stdout).toMatch(/^audit\s+audit-model\s/m);
	});

	it("says where to log in when --list-models has no provider at all", () => {
		const result = runSourceCli(["--list-models"]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("No models available");
		expect(result.stdout).toContain("docs/providers.md");
	});
});
