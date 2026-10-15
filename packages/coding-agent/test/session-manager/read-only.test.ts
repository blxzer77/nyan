import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const LEGACY_SESSION = [
	JSON.stringify({
		type: "session",
		version: 2,
		id: "legacy-session",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/project",
	}),
	JSON.stringify({
		type: "message",
		id: "legacy-entry",
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "old prompt" }], timestamp: 1 },
	}),
	"",
].join("\n");

describe("read-only legacy sessions", () => {
	let directory: string;
	let file: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "nyan-legacy-session-"));
		file = join(directory, "session.jsonl");
		await writeFile(file, LEGACY_SESSION, "utf8");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("does not migrate or append to the source JSONL file", async () => {
		const session = SessionManager.open(file, undefined, undefined, { readOnly: true });

		session.appendMessage({ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() });

		expect(session.isReadOnly()).toBe(true);
		expect(session.isPersisted()).toBe(false);
		expect(session.getHeader()?.version).toBe(3);
		expect(await readFile(file, "utf8")).toBe(LEGACY_SESSION);
	});
});
