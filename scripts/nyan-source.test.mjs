import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const script = join(resolve(import.meta.dirname), "nyan-source.mjs");
const version = JSON.parse(readFileSync(join(resolve(import.meta.dirname, ".."), "packages", "coding-agent", "package.json"), "utf8")).version;

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

const homes = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * Runs the source entry point as a real process in a temporary HOME.
 *
 * Nothing here touches the operator's `~/.nyan`, and NYAN_OFFLINE keeps the run from reaching a provider.
 */
function runSourceCli(arguments_, { models } = {}) {
	const home = mkdtempSync(join(tmpdir(), "nyan-source-cli-"));
	homes.push(home);
	const agentDir = join(home, ".nyan", "agent");
	mkdirSync(agentDir, { recursive: true });
	if (models !== undefined) writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
	return spawnSync(process.execPath, [script, ...arguments_], {
		cwd: home,
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NYAN_CODING_AGENT_DIR: agentDir,
			NYAN_OFFLINE: "1",
		},
	});
}

test("the script starts the CLI on Node and reports the package version", () => {
	const result = runSourceCli(["--version"]);

	assert.equal(result.error, undefined, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), version);
});

test("the CLI lists a configured provider, so the workspace aliases were resolved", () => {
	const result = runSourceCli(["--list-models"], { models: offlineProvider });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout.split("\n")[0], /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/);
	assert.match(result.stdout, /^audit\s+audit-model\s/m);
});

test("the CLI still answers with no provider configured", () => {
	const result = runSourceCli(["--list-models"]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^No models available\./m);
});

test("the exit code is the CLI's, not a failed import", () => {
	// A resolver that is installed too late fails at import time: the run would die before the CLI parses anything,
	// with a module-resolution error and a non-zero code. Reaching the CLI's own message is what proves the order.
	const result = runSourceCli(["--nope"]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^Error: Unknown option: --nope$/m);
	assert.equal(result.stdout, "");
});
