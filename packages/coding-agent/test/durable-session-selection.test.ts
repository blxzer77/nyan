import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import {
	type DurableSessionEntry,
	DurableSessionError,
	findSessionDirectory,
	listSessionDirectory,
	MEMORY_SESSION_DATABASE,
	readSessionMetadata,
	selectSession,
	setDurableSessionStore,
	writeSessionMetadata,
} from "../src/core/durable/sessions.ts";
import { DurableStartupError } from "../src/core/durable/startup-error.ts";
import type { ExtensionAPI, InlineExtension, ProjectTrustContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionSelection, type SessionSelection } from "../src/main.ts";
import { applySessionSetup } from "../src/modes/durable/session-setup.ts";
import { settlement } from "./durable-submission.ts";

/**
 * Decision #25: the seven session-selection flags address durable sessions. The store tests pin where a session is
 * created, whether it is written at all, and where its name lives; the resolution tests pin which session a flag opens
 * and which flags keep the compatibility route.
 */

const SESSION_DIRECTORY = /^\d{13}-[0-9a-f-]{36}$/u;

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

let home: string;
let agentDir: string;
let cwd: string;
let storeRoot: string;
let session: OpenDurableResult | undefined;

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "nyan-selection-home-")));
	agentDir = join(home, ".nyan", "agent");
	cwd = join(home, "project");
	storeRoot = join(home, "shared-store");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(async () => {
	await session?.close();
	session = undefined;
	setDurableSessionStore({});
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A session directory holding a database placeholder: enough for the store scans, not for opening one. */
async function seedSession(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "session.sqlite"), "placeholder");
}

/** The per-directory store of `cwd` under `root`: the parent a session there is created in. */
async function seededStore(): Promise<string> {
	const location = await selectSession(cwd, false, { root: storeRoot });
	const store = dirname(location.directory);
	await location.release();
	// The store itself is what the test wants; the session that created it is not part of the expectation.
	await rm(location.directory, { recursive: true, force: true });
	return store;
}

/** A real durable session with one answered turn, so it has a user message to fork from. */
async function openAnsweredSession(): Promise<{ open: OpenDurableResult; entryId: string }> {
	const faux = fauxProvider();
	faux.setResponses([() => fauxAssistantMessage([fauxText("first answer")])]);
	const model = faux.getModel();
	const provider: InlineExtension = (api: ExtensionAPI) => {
		api.registerProvider(faux.provider);
	};
	session = await openDurable({
		cwd,
		extensionFactories: [provider],
		model: { provider: model.provider, modelId: model.id },
		projectTrustContext: { ...headless, cwd },
	});
	expect((await settlement(session.controller.submitAndWait("go", "followUp"))).status).toBe("done");
	const entries = await session.sessionOps.entries(undefined);
	const user = entries.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (user === undefined) throw new Error("the session has no user entry");
	return { open: session, entryId: user.id };
}

function resolved(selection: SessionSelection) {
	if (selection.kind !== "durable") throw new Error(`expected a durable selection, got ${selection.kind}`);
	return selection.selection;
}

describe("the durable store", () => {
	test("writes a new session below the given root with the layout unchanged", async () => {
		const location = await selectSession(cwd, false, { root: storeRoot });
		try {
			// The root holds one `<hash of the cwd>/<timestamp>-<uuid>/` store, whether or not it was the default one.
			const [hash] = relative(storeRoot, location.directory).split("/");
			expect(hash).toMatch(/^[0-9a-f]{24}$/u);
			expect(basename(location.directory)).toMatch(SESSION_DIRECTORY);
			expect(location.database).toBe(join(location.directory, "session.sqlite"));
			expect(await readSessionMetadata(location.directory)).toEqual({ cwd: await realpath(cwd) });
			// Nothing is written to the agent directory's own store.
			expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);
		} finally {
			await location.release();
		}
	});

	test("keeps an ephemeral session in memory and writes no directory", async () => {
		const location = await selectSession(cwd, false, { memory: true });

		expect(location.database).toBe(MEMORY_SESSION_DATABASE);
		expect(location.created).toBe(true);
		expect(location.id).toMatch(SESSION_DIRECTORY);
		// A `--no-session` run leaves no session directory, no database, and no store root behind.
		expect(existsSync(location.directory)).toBe(false);
		expect(existsSync(join(agentDir, "sessions-durable"))).toBe(false);

		await location.release();
		expect(existsSync(location.directory)).toBe(false);
	});

	test("keeps an ephemeral session's display name only while it runs", async () => {
		const location = await selectSession(cwd, false, { memory: true });

		await writeSessionMetadata(location.directory, { cwd, name: "ephemeral run" });
		expect(await readSessionMetadata(location.directory)).toEqual({ cwd, name: "ephemeral run" });

		await location.release();
		expect(await readSessionMetadata(location.directory)).toEqual({});
		expect(existsSync(location.directory)).toBe(false);
	});

	test("lists a store's sessions newest first and skips directories no session started in", async () => {
		const store = await seededStore();
		await seedSession(join(store, "9000000000000-11111111-1111-4111-8111-111111111111"));
		await seedSession(join(store, "9999999999999-22222222-2222-4222-8222-222222222222"));
		await writeSessionMetadata(join(store, "9999999999999-22222222-2222-4222-8222-222222222222"), {
			cwd,
			name: "newest",
		});
		await mkdir(join(store, "not-a-session"));

		const sessions = await listSessionDirectory(cwd, { root: storeRoot });

		expect(sessions.map((entry) => entry.id)).toEqual([
			"9999999999999-22222222-2222-4222-8222-222222222222",
			"9000000000000-11111111-1111-4111-8111-111111111111",
		]);
		expect(sessions[0]?.name).toBe("newest");
		expect(sessions[1]?.name).toBeUndefined();
		expect(sessions[0]?.created.toISOString()).toBe(new Date(9_999_999_999_999).toISOString());
	});

	test("finds a session by exact id and by a prefix only one session carries", async () => {
		const store = await seededStore();
		const older = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		const newer = join(store, "9100000000000-22222222-2222-4222-8222-222222222222");
		await seedSession(older);
		await seedSession(newer);

		expect((await findSessionDirectory(basename(newer), cwd, { root: storeRoot }))?.directory).toBe(newer);
		expect((await findSessionDirectory("9100000000000", cwd, { root: storeRoot }))?.directory).toBe(newer);
		expect(await findSessionDirectory("0000", cwd, { root: storeRoot })).toBeUndefined();
	});

	test("refuses a prefix two sessions carry instead of guessing", async () => {
		const store = await seededStore();
		await seedSession(join(store, "9000000000000-11111111-1111-4111-8111-111111111111"));
		await seedSession(join(store, "9000000000001-22222222-2222-4222-8222-222222222222"));

		const failure = findSessionDirectory("900000000000", cwd, { root: storeRoot });
		await expect(failure).rejects.toBeInstanceOf(DurableSessionError);
		await expect(failure).rejects.toThrow(
			"[DURABLE_SESSION_AMBIGUOUS] More than one durable session starts with 900000000000",
		);
	});
});

describe("session selection", () => {
	const options = (
		overrides: { pick?: (sessions: readonly DurableSessionEntry[]) => Promise<string | undefined> } = {},
	) => ({
		cwd,
		appMode: "interactive" as const,
		legacySessionDir: undefined,
		storeRoot,
		...overrides,
	});

	test("--session opens the durable session directory it names", async () => {
		const store = await seededStore();
		const directory = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		await seedSession(directory);

		const selection = resolved(await resolveSessionSelection(parseArgs(["--session", directory]), options()));

		expect(selection.directory).toBe(directory);
		expect(selection.continueSession).toBe(false);
		expect(selection.store).toEqual({ root: storeRoot });
	});

	test("--session keeps a JSONL file on the compatibility route", async () => {
		expect(await resolveSessionSelection(parseArgs(["--session", "/old/a.jsonl"]), options())).toEqual({
			kind: "compatibility",
		});
		// A file that is not a `.jsonl` session keeps the compatibility route's own validation of it.
		const other = join(cwd, "not-a-session.log");
		await writeFile(other, "not a session\n");
		expect(await resolveSessionSelection(parseArgs(["--session", other]), options())).toEqual({
			kind: "compatibility",
		});
		// An empty value names no session, so it gets the compatibility route's own message for it.
		expect(await resolveSessionSelection(parseArgs(["--session", ""]), options())).toEqual({
			kind: "compatibility",
		});
	});

	test("--session resolves a durable id, and leaves an unknown one to the compatibility route", async () => {
		const store = await seededStore();
		const directory = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		await seedSession(directory);

		expect(
			resolved(await resolveSessionSelection(parseArgs(["--session", "9000000000000"]), options())).directory,
		).toBe(directory);
		expect(await resolveSessionSelection(parseArgs(["--session", "no-such-id"]), options())).toEqual({
			kind: "compatibility",
		});
	});

	test("--session-id opens the session with that id and names an id no store holds", async () => {
		const store = await seededStore();
		const directory = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		await seedSession(directory);
		const id = basename(directory);

		expect(resolved(await resolveSessionSelection(parseArgs(["--session-id", id]), options())).directory).toBe(
			directory,
		);

		const unknown = resolveSessionSelection(parseArgs(["--session-id", "no-such-id"]), options());
		await expect(unknown).rejects.toBeInstanceOf(DurableSessionError);
		await expect(unknown).rejects.toThrow("[DURABLE_SESSION_NOT_FOUND] No durable session has the id no-such-id");
	});

	test("--session-id keeps a legacy id on the compatibility route", async () => {
		const legacy = SessionManager.create(cwd, undefined, { id: "legacy-id" });
		legacy.appendMessage({ role: "user", content: "from the legacy session", timestamp: Date.now() });

		expect(await resolveSessionSelection(parseArgs(["--session-id", "legacy-id"]), options())).toEqual({
			kind: "compatibility",
		});
	});

	test("--name carries the trimmed value, and an empty name clears", async () => {
		expect(resolved(await resolveSessionSelection(parseArgs(["--name", "  named  "]), options())).name).toBe("named");
		expect(resolved(await resolveSessionSelection(parseArgs(["--name", ""]), options())).name).toBe("");
		expect(resolved(await resolveSessionSelection(parseArgs(["hi"]), options())).name).toBeUndefined();
	});

	test("--session-dir and --no-session decide the store", async () => {
		const withRoot = resolved(await resolveSessionSelection(parseArgs(["--session-dir", storeRoot]), options()));
		expect(withRoot.store).toEqual({ root: storeRoot });

		const ephemeral = resolved(await resolveSessionSelection(parseArgs(["--no-session"]), options()));
		// An ephemeral run writes to no store, so the root it carries changes nothing.
		expect(ephemeral.store).toEqual({ root: storeRoot, memory: true });
		expect(ephemeral.directory).toBeUndefined();
		expect(ephemeral.continueSession).toBe(false);
	});

	test("--resume opens the session the picker returns, and nothing when it is cancelled", async () => {
		const store = await seededStore();
		const older = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		await seedSession(older);
		const picked: string[] = [];

		const chosen = expanded(
			await resolveSessionSelection(
				parseArgs(["--resume"]),
				options({
					pick: async (sessions) => {
						picked.push(...sessions.map((entry) => entry.directory));
						return older;
					},
				}),
			),
		);
		expect(picked).toContain(older);
		expect(chosen.directory).toBe(older);

		expect(await resolveSessionSelection(parseArgs(["--resume"]), options({ pick: async () => undefined }))).toEqual({
			kind: "cancelled",
		});
	});

	test("--resume without a durable session, or outside the interactive mode, keeps the compatibility picker", async () => {
		const pick = async () => undefined;
		expect(await resolveSessionSelection(parseArgs(["--resume"]), options({ pick }))).toEqual({
			kind: "compatibility",
		});
		const store = await seededStore();
		expect(existsSync(store)).toBe(true);
		expect(
			await resolveSessionSelection(parseArgs(["--resume"]), {
				...options({ pick }),
				appMode: "print",
			}),
		).toEqual({ kind: "compatibility" });
	});

	test("--fork alone forks inside this directory's newest durable session", async () => {
		const store = await seededStore();
		const older = join(store, "9000000000000-11111111-1111-4111-8111-111111111111");
		const newer = join(store, "9100000000000-22222222-2222-4222-8222-222222222222");
		await seedSession(older);
		await seedSession(newer);

		const selection = resolved(await resolveSessionSelection(parseArgs(["--fork", "7"]), options()));

		expect(selection.directory).toBe(newer);
		expect(selection.forkAt).toBe("7");

		await mkdir(join(home, "empty-project"), { recursive: true });
		const none = resolveSessionSelection(parseArgs(["--fork", "7"]), {
			...options(),
			cwd: join(home, "empty-project"),
			storeRoot: join(home, "empty-store"),
		});
		await expect(none).rejects.toThrow("[DURABLE_SESSION_NOT_FOUND] No durable session exists for");
	});

	test("--fork and --continue fork inside the session --continue opens", async () => {
		const store = await seededStore();
		await seedSession(join(store, "9000000000000-11111111-1111-4111-8111-111111111111"));

		const selection = resolved(await resolveSessionSelection(parseArgs(["--continue", "--fork", "3"]), options()));

		expect(selection.continueSession).toBe(true);
		expect(selection.forkAt).toBe("3");
	});
});

/** The selection a durable route resolved; a compatibility answer here is a test defect, not a case. */
function expanded(selection: SessionSelection) {
	if (selection.kind !== "durable") throw new Error(`expected a durable selection, got ${selection.kind}`);
	return selection.selection;
}

describe("--name and --fork apply to the opened session", () => {
	test("the name is stored beside the database and read back from it", async () => {
		const { open } = await openAnsweredSession();

		await applySessionSetup(open, { name: "named by the command line" });
		expect(await open.sessionOps.getSessionName()).toBe("named by the command line");

		await applySessionSetup(open, { name: "" });
		expect(await open.sessionOps.getSessionName()).toBeUndefined();
	});

	test("the fork becomes the conversation the run talks to, labelled afterwards", async () => {
		const { open, entryId } = await openAnsweredSession();
		const before = open.view.current();

		await applySessionSetup(open, { forkAt: entryId });
		const after = open.view.current();
		const forkedId = after.conversation.conversation.id;

		expect(forkedId).not.toBe(before.conversation.conversation.id);
		expect(after.conversations.map((conversation) => conversation.label)).toContain(`fork ${forkedId}`);
		// The fork stops at the user message it was made from: nothing that followed that message came with it.
		expect(after.conversation.entries.length).toBeLessThan(before.conversation.entries.length);
		expect(after.conversation.entries.at(-1)?.kind).toBe("nyan.user");
	});

	test("a fork that cannot happen is one startup message", async () => {
		const { open } = await openAnsweredSession();

		const failure = applySessionSetup(open, { forkAt: "42" });
		await expect(failure).rejects.toBeInstanceOf(DurableStartupError);
		await expect(failure).rejects.toThrow("Entry not found: 42");
	});
});
