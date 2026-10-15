import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
			await writeFile(created.database, "placeholder");
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

	test("continues the newest valid session directory and ignores unrelated entries", async () => {
		const created = await selectSession(cwd, false);
		await created.release();
		const root = dirname(created.directory);
		const older = join(root, "9000000000000-11111111-1111-4111-8111-111111111111");
		const newer = join(root, "9999999999999-22222222-2222-4222-8222-222222222222");
		await mkdir(older);
		await mkdir(newer);
		await writeFile(join(older, "session.sqlite"), "placeholder");
		await mkdir(join(newer, "nested-empty"));
		await mkdir(join(root, "not-a-session"));

		const continued = await selectSession(cwd, true);
		try {
			expect(continued.directory).toBe(older);
			expect(continued.created).toBe(false);
		} finally {
			await continued.release();
		}
	});
});
