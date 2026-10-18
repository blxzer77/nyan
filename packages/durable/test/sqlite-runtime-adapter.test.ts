import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@ny4n/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../src/storage/sqlite/index.ts";
import { NodeSqliteDatabase, openNodeSqliteStorage, openRuntimeSqliteDatabase } from "../src/storage/sqlite/node.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

// The same assertions run on Node (node:sqlite) and on Bun (bun:sqlite, through src/storage/sqlite/bun.ts), so a
// difference between the two bindings that the storage could notice fails on one of them. The expected errors are the
// ones node:sqlite throws; the Bun adapter reproduces them.

const isBun = typeof process.versions.bun === "string";
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

async function open(path = ":memory:", options?: { busyTimeoutMs?: number; walAutoCheckpointPages?: number }) {
	const database = await openRuntimeSqliteDatabase(path, options);
	databases.push(database);
	return database;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nyan-durable-sqlite-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function table(database: SqliteDatabase): Promise<void> {
	await database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, s TEXT, b BLOB, r REAL)");
}

describe("the SQLite adapter for this runtime", () => {
	it("is bun:sqlite under Bun and node:sqlite otherwise", async () => {
		const database = await open();

		expect(database.constructor.name).toBe(isBun ? "BunSqliteDatabase" : "NodeSqliteDatabase");
		if (!isBun) expect(database).toBeInstanceOf(NodeSqliteDatabase);
	});

	describe("integers", () => {
		it("returns an INTEGER inside the safe range as a number", async () => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, Number.MAX_SAFE_INTEGER);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 2, Number.MIN_SAFE_INTEGER);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 3, 0);

			const rows = await database.all<{ id: number; n: number }>("SELECT id, n FROM t ORDER BY id");

			expect(rows).toEqual([
				{ id: 1, n: 9007199254740991 },
				{ id: 2, n: -9007199254740991 },
				{ id: 3, n: 0 },
			]);
			for (const row of rows) expect(typeof row.n).toBe("number");
		});

		it("returns computed integers (count, sum) as numbers", async () => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 4);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 2, 5);

			const row = await database.get<{ c: number; s: number; a: number }>(
				"SELECT count(*) AS c, sum(n) AS s, avg(n) AS a FROM t",
			);

			expect(row).toEqual({ c: 2, s: 9, a: 4.5 });
		});

		it.each([
			["2^53", 2n ** 53n],
			["2^53 + 1", 2n ** 53n + 1n],
			["-2^53", -(2n ** 53n)],
			["-2^53 - 1", -(2n ** 53n) - 1n],
			["int64 max", INT64_MAX],
		])("throws a RangeError instead of rounding %s when it is read", async (_label, value) => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, value);

			const get = database.get("SELECT n FROM t WHERE id = 1");
			const all = database.all("SELECT n FROM t");

			await expect(get).rejects.toMatchObject({
				name: "RangeError",
				message: `Value is too large to be represented as a JavaScript number: ${value}`,
			});
			await expect(all).rejects.toBeInstanceOf(RangeError);
		});

		it("never loses precision on int64 min, whether the binding throws or returns the double", async () => {
			// -2^63 is exactly representable as a double, and node:sqlite's rule for that one value depends on the Node
			// version: 24.3.0 throws a RangeError, a newer 24.x in CI returns -9223372036854775808. This adapter throws, like
			// 24.3.0. What both must do is keep the value exact rather than round it.
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, INT64_MIN);

			const outcome = await database.get<{ n: number }>("SELECT n FROM t").then(
				(row) => row,
				(error: unknown) => error,
			);
			if (outcome instanceof Error) {
				expect(outcome).toMatchObject({
					name: "RangeError",
					message: `Value is too large to be represented as a JavaScript number: ${INT64_MIN}`,
				});
			} else {
				// The double is exactly -2^63, so converting it back gives the stored integer, not a rounded one.
				expect(BigInt(outcome.n)).toBe(INT64_MIN);
			}
		});

		it("reads the exact text of an integer that is too large to read as a number", async () => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 2n ** 53n + 1n);

			expect(await database.get("SELECT CAST(n AS TEXT) AS n FROM t")).toEqual({ n: "9007199254740993" });
		});

		it("binds a bigint inside int64 without change", async () => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 5n);
			await database.run("INSERT INTO t (id, s) VALUES (?, ?)", 2, INT64_MAX);
			await database.run("INSERT INTO t (id, s) VALUES (?, ?)", 3, INT64_MIN);
			await database.run("INSERT INTO t (id, s) VALUES (?, ?)", 4, 2n ** 53n + 1n);

			expect(await database.get("SELECT n FROM t WHERE id = 1")).toEqual({ n: 5 });
			const text = await database.all<{ s: string }>("SELECT CAST(s AS TEXT) AS s FROM t WHERE id > 1 ORDER BY id");
			expect(text.map((row) => row.s)).toEqual(["9223372036854775807", "-9223372036854775808", "9007199254740993"]);
		});

		it.each([
			["int64 max + 1", INT64_MAX + 1n],
			["int64 min - 1", INT64_MIN - 1n],
			["2^64 + 5", 2n ** 64n + 5n],
		])("throws a TypeError instead of wrapping %s around when it is bound", async (_label, value) => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 7);

			const expected = { name: "TypeError", message: "BigInt value is too large to bind." };
			await expect(database.run("INSERT INTO t (id, n) VALUES (?, ?)", 2, value)).rejects.toMatchObject(expected);
			await expect(database.get("SELECT ? AS n", value)).rejects.toMatchObject(expected);
			await expect(database.all("SELECT ? AS n", value)).rejects.toMatchObject(expected);
			await expect(
				database.transaction((transaction) => transaction.run("INSERT INTO t (id, n) VALUES (?, ?)", 3, value)),
			).rejects.toMatchObject(expected);
			// Nothing was written, and the connection still works.
			expect(await database.all("SELECT id FROM t")).toEqual([{ id: 1 }]);
		});

		it("keeps next_id as TEXT, so an id above the safe range survives a round trip", async () => {
			const database = await open();
			await database.exec("CREATE TABLE m (next_id TEXT NOT NULL, next_seq INTEGER NOT NULL) STRICT");
			await database.run("INSERT INTO m (next_id, next_seq) VALUES (?, ?)", "2", 1);
			await database.run("UPDATE m SET next_id = ?, next_seq = ?", "9007199254740993", 7);

			expect(await database.get("SELECT next_id, next_seq FROM m")).toEqual({
				next_id: "9007199254740993",
				next_seq: 7,
			});
		});
	});

	describe("rows and values", () => {
		it("returns undefined, not null, when get finds no row", async () => {
			const database = await open();
			await table(database);

			expect(await database.get("SELECT * FROM t WHERE id = 99")).toBeUndefined();
			expect(await database.all("SELECT * FROM t WHERE id = 99")).toEqual([]);
		});

		it("keeps a NULL inside a row as null", async () => {
			const database = await open();
			await table(database);
			await database.run("INSERT INTO t (id) VALUES (?)", 1);

			const row = await database.get<Record<string, unknown>>("SELECT id, n, s, b, r FROM t WHERE id = 1");

			expect(row).toEqual({ id: 1, n: null, s: null, b: null, r: null });
			expect(row?.n).toBeNull();
			expect(await database.all("SELECT n, s FROM t")).toEqual([{ n: null, s: null }]);
			expect(await database.get("SELECT NULL AS v")).toEqual({ v: null });
		});

		it("round-trips text, blobs, fractions and whole numbers in a REAL column", async () => {
			const database = await open();
			await table(database);
			await database.run(
				"INSERT INTO t (id, s, b, r) VALUES (?, ?, ?, ?)",
				1,
				"héllo",
				new Uint8Array([1, 2, 3]),
				2.5,
			);
			await database.run("INSERT INTO t (id, r) VALUES (?, ?)", 2, 5);

			const first = await database.get<{ s: string; b: Uint8Array; r: number }>(
				"SELECT s, b, r FROM t WHERE id = 1",
			);
			expect(first?.s).toBe("héllo");
			expect(Array.from(first?.b ?? [])).toEqual([1, 2, 3]);
			expect(first?.b).toBeInstanceOf(Uint8Array);
			expect(first?.r).toBe(2.5);
			expect(await database.get("SELECT r FROM t WHERE id = 2")).toEqual({ r: 5 });
		});

		it("runs several statements in one exec", async () => {
			const database = await open();

			await database.exec("CREATE TABLE a (x INTEGER); CREATE TABLE b (x INTEGER); INSERT INTO a VALUES (1);");

			expect(await database.all("SELECT name FROM sqlite_master WHERE name IN ('a', 'b') ORDER BY name")).toEqual([
				{ name: "a" },
				{ name: "b" },
			]);
		});

		it("reuses a statement for the same SQL text with different bindings", async () => {
			const database = await open();
			await table(database);
			for (const id of [1, 2, 3]) await database.run("INSERT INTO t (id, n) VALUES (?, ?)", id, id * 10);

			const first = await database.get("SELECT n FROM t WHERE id = ?", 1);
			const third = await database.get("SELECT n FROM t WHERE id = ?", 3);
			const missing = await database.get("SELECT n FROM t WHERE id = ?", 9);

			expect([first, third, missing]).toEqual([{ n: 10 }, { n: 30 }, undefined]);
		});
	});

	describe("connection settings", () => {
		it("applies the default busy timeout, journal mode, synchronous level and checkpoint threshold", async () => {
			const directory = await temporaryDirectory();
			const database = await open(join(directory, "settings.sqlite"));

			expect(await database.get("PRAGMA busy_timeout")).toEqual({ timeout: 5000 });
			expect(await database.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
			expect(await database.get("PRAGMA synchronous")).toEqual({ synchronous: 1 });
			expect(await database.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 1000 });
		});

		it("applies the options it is given, including a checkpoint threshold of 0", async () => {
			const directory = await temporaryDirectory();
			const database = await open(join(directory, "options.sqlite"), {
				busyTimeoutMs: 1234,
				walAutoCheckpointPages: 0,
			});

			expect(await database.get("PRAGMA busy_timeout")).toEqual({ timeout: 1234 });
			expect(await database.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 0 });
		});

		it("creates the missing parent directories of the database file", async () => {
			const directory = await temporaryDirectory();
			const path = join(directory, "a", "b", "session.sqlite");

			await open(path);

			expect(existsSync(path)).toBe(true);
		});
	});

	describe("transactions", () => {
		it("commits what the callback wrote and returns its result", async () => {
			const database = await open();
			await table(database);

			const result = await database.transaction(async (transaction) => {
				await transaction.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 11);
				return (await transaction.get<{ n: number }>("SELECT n FROM t WHERE id = 1"))?.n;
			});

			expect(result).toBe(11);
			expect(await database.all("SELECT id, n FROM t")).toEqual([{ id: 1, n: 11 }]);
		});

		it("rolls back and rejects with the callback's own error", async () => {
			const database = await open();
			await table(database);
			const failure = new Error("stop");

			await expect(
				database.transaction(async (transaction) => {
					await transaction.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 11);
					throw failure;
				}),
			).rejects.toBe(failure);

			expect(await database.all("SELECT id FROM t")).toEqual([]);
		});

		it("makes a transaction handle unusable after the callback settles", async () => {
			const database = await open();
			await table(database);
			let handle: Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0] | undefined;
			await database.transaction(async (transaction) => {
				handle = transaction;
			});

			await expect(handle?.run("INSERT INTO t (id) VALUES (1)")).rejects.toThrow("no longer active");
		});

		it("takes the write lock at BEGIN, so a second connection cannot start a writer", async () => {
			const directory = await temporaryDirectory();
			const path = join(directory, "lock.sqlite");
			const holder = await open(path);
			const other = await open(path, { busyTimeoutMs: 0 });
			await table(holder);
			const release = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const held = holder.transaction(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			try {
				// A reader is not blocked; a writer is, before it has written anything.
				expect(await other.get("SELECT count(*) AS c FROM t")).toEqual({ c: 0 });
				await expect(other.transaction(async () => {})).rejects.toThrow(/database is locked/);
			} finally {
				release.resolve();
				await held;
			}
			await expect(other.transaction(async () => {})).resolves.toBeUndefined();
		});

		it("waits for the busy timeout before it gives up on a lock", async () => {
			const directory = await temporaryDirectory();
			const path = join(directory, "busy.sqlite");
			const holder = await open(path);
			const other = await open(path, { busyTimeoutMs: 300 });
			await table(holder);
			const release = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const held = holder.transaction(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			const started = performance.now();
			try {
				await expect(other.transaction(async () => {})).rejects.toThrow(/database is locked/);
			} finally {
				release.resolve();
				await held;
			}

			expect(performance.now() - started).toBeGreaterThanOrEqual(200);
		});
	});

	describe("close", () => {
		it("can be called twice", async () => {
			const database = await open();

			await database.close();
			await expect(database.close()).resolves.toBeUndefined();
		});

		it("lets the same process delete the session directory afterwards", async () => {
			// On Windows under Bun, node:sqlite left the -shm and -wal files locked here (EBUSY).
			const directory = await temporaryDirectory();
			const database = await open(join(directory, "session.sqlite"));
			await table(database);
			await database.run("INSERT INTO t (id, n, s) VALUES (?, ?, ?)", 1, 2, "x");
			await database.get("SELECT n FROM t WHERE id = ?", 1);
			await database.all("SELECT * FROM t");
			await database.transaction(async (transaction) => {
				await transaction.run("UPDATE t SET n = ? WHERE id = ?", 3, 1);
			});

			await database.close();
			await rm(directory, { recursive: true });

			expect(existsSync(directory)).toBe(false);
		});

		it("lets the same process delete the directory of a closed durable storage", async () => {
			const directory = await temporaryDirectory();
			const storage = await openNodeSqliteStorage(join(directory, "sessions", "session.sqlite"));
			await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
			await storage.entry(ROOT_CONVERSATION_ID as never, BACKGROUND_CONTEXT);

			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { recursive: true });

			expect(existsSync(directory)).toBe(false);
		});

		it("lets the same process delete the directory after a failed transaction and a failed bind", async () => {
			const directory = await temporaryDirectory();
			const database = await open(join(directory, "failures.sqlite"));
			await table(database);
			await expect(
				database.transaction(async (transaction) => {
					await transaction.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 1);
					throw new Error("stop");
				}),
			).rejects.toThrow("stop");
			await expect(database.run("INSERT INTO t (id, n) VALUES (?, ?)", 2, INT64_MAX + 1n)).rejects.toThrow(
				TypeError,
			);

			await database.close();
			await rm(directory, { recursive: true });

			expect(existsSync(directory)).toBe(false);
		});
	});
});

describe.runIf(isBun)("bun:sqlite adapter internals", () => {
	afterEach(() => vi.restoreAllMocks());

	it("finalizes every cached statement when it closes, whatever the platform", async () => {
		// The Windows file lock is the visible effect; this checks the cause on every platform.
		const { Statement } = await import("bun:sqlite");
		const finalize = vi.spyOn(Statement.prototype, "finalize");
		const database = await open();
		await table(database);
		await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 1);
		await database.get("SELECT n FROM t WHERE id = ?", 1);
		await database.all("SELECT * FROM t");
		await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 2, 2);
		finalize.mockClear();

		await database.close();

		// Three distinct SQL texts were prepared; the PRAGMA and CREATE TABLE went through exec.
		expect(finalize).toHaveBeenCalledTimes(3);
	});

	it("prepares a statement once per SQL text, in a transaction as well", async () => {
		const { Database } = await import("bun:sqlite");
		const database = await open();
		await table(database);
		const prepare = vi.spyOn(Database.prototype, "prepare");

		for (const id of [1, 2, 3]) await database.run("INSERT INTO t (id, n) VALUES (?, ?)", id, id);
		await database.get("SELECT n FROM t WHERE id = ?", 1);
		await database.get("SELECT n FROM t WHERE id = ?", 2);
		await database.transaction(async (transaction) => {
			await transaction.run("INSERT INTO t (id, n) VALUES (?, ?)", 4, 4);
			await transaction.get("SELECT n FROM t WHERE id = ?", 4);
		});

		expect(prepare.mock.calls.map((call) => call[0])).toEqual([
			"INSERT INTO t (id, n) VALUES (?, ?)",
			"SELECT n FROM t WHERE id = ?",
		]);
	});

	it("still closes the connection when finalizing a statement throws", async () => {
		const { Statement, Database } = await import("bun:sqlite");
		const database = await open();
		await table(database);
		await database.run("INSERT INTO t (id, n) VALUES (?, ?)", 1, 1);
		const close = vi.spyOn(Database.prototype, "close");
		vi.spyOn(Statement.prototype, "finalize").mockImplementation(() => {
			throw new Error("finalize failed");
		});

		await expect(database.close()).rejects.toThrow("finalize failed");

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("refuses a checkpoint threshold or busy timeout that is not a non-negative integer", async () => {
		await expect(open(":memory:", { walAutoCheckpointPages: -1 })).rejects.toThrow(RangeError);
		await expect(open(":memory:", { busyTimeoutMs: 1.5 })).rejects.toThrow(RangeError);
		await expect(open(":memory:", { walAutoCheckpointPages: Number.NaN })).rejects.toThrow(RangeError);
	});
});
