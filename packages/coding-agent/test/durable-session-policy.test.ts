import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { selectSession } from "../src/core/durable/sessions.ts";

describe("durable session policy", () => {
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "nyan-durable-agent-"));
		cwd = await mkdtemp(join(tmpdir(), "nyan-durable-cwd-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	test("creates and continues the newest session below sessions-durable", async () => {
		const created = await selectSession(cwd, false);
		try {
			expect(created.directory).toContain(join(agentDir, "sessions-durable"));
			expect(created.database).toBe(join(created.directory, "session.sqlite"));
		} finally {
			await created.release();
		}

		const continued = await selectSession(cwd, true);
		try {
			expect(continued.directory).toBe(created.directory);
			expect(continued.created).toBe(false);
		} finally {
			await continued.release();
		}
	});
});
