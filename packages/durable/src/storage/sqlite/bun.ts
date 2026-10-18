import type { Database, Statement } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import type { NodeSqliteStorageOptions } from "./node.ts";
import { SerialOperationQueue } from "./serial-queue.ts";

/**
 * `SqliteDatabase` adapter backed by Bun's built-in `bun:sqlite`, used instead of `node:sqlite` under Bun (see
 * `openRuntimeSqliteDatabase` in `node.ts`). Loaded only under Bun.
 *
 * Why not `node:sqlite` on Bun: on Windows its `close()` leaves a WAL database's `-shm` and `-wal` files locked while a
 * prepared statement is not finalized, and it has no way to finalize one. This adapter keeps its own statement cache and
 * finalizes every cached statement before it closes the connection, so the process that closed a session can delete the
 * session directory.
 *
 * The two SQLite bindings differ where the durable storage can notice, and the adapter makes `bun:sqlite` behave like
 * `node:sqlite` there, so one test suite describes both:
 * - A `bigint` that does not fit in a signed 64-bit integer throws a `TypeError` when bound. `bun:sqlite` would wrap it
 *   around and store a different number.
 * - INTEGER values are read as `number` when they are safe integers and throw a `RangeError` otherwise. `bun:sqlite`
 *   would round them to a double. The statements read with `safeIntegers(true)` so no precision is lost before the check.
 * - `get` returns `undefined` for no row, where `bun:sqlite` returns `null`. A NULL inside a row stays `null`.
 * Not made alike: the `name` and `code` of SQLite errors (nothing branches on them), and the prototype of a row object.
 * A `number` binds as INTEGER here when it is whole and as REAL under `node:sqlite`; the durable tables are STRICT with
 * INTEGER and TEXT columns, which take either without loss.
 */

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

type TransactionScope = { active: boolean };

function withCode<E extends Error>(error: E, code: string): E {
	return Object.assign(error, { code });
}

/** A `bigint` outside int64 is refused, as `node:sqlite` refuses it. */
function bindValue(value: SqliteValue): SqliteValue {
	if (typeof value === "bigint" && (value < INT64_MIN || value > INT64_MAX)) {
		throw withCode(new TypeError("BigInt value is too large to bind."), "ERR_INVALID_ARG_VALUE");
	}
	return value;
}

function readValue(value: unknown): unknown {
	if (typeof value !== "bigint") return value;
	if (value > MAX_SAFE || value < MIN_SAFE) {
		throw withCode(
			new RangeError(`Value is too large to be represented as a JavaScript number: ${value}`),
			"ERR_OUT_OF_RANGE",
		);
	}
	return Number(value);
}

/** Convert the INTEGER values of a row read with `safeIntegers(true)`. A NULL stays `null`. */
function readRow<T extends object>(row: T): T {
	const columns = row as Record<string, unknown>;
	for (const key of Object.keys(columns)) columns[key] = readValue(columns[key]);
	return row;
}

abstract class BunSqliteExecutor implements SqliteExecutor {
	protected readonly database: Database;
	protected readonly statements: Map<string, Statement>;

	constructor(database: Database, statements: Map<string, Statement>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params.map(bindValue));
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => {
			const row = this.statement(sql).get(...params.map(bindValue));
			// Only "no row" becomes undefined: a row is an object, and its NULL columns stay null.
			return row === null || row === undefined ? undefined : readRow(row as T);
		});
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => {
			const rows = this.statement(sql).all(...params.map(bindValue)) as T[];
			for (const row of rows) readRow(row);
			return rows;
		});
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): Statement {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql).safeIntegers(true);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class BunSqliteTransaction extends BunSqliteExecutor {
	private readonly scope: TransactionScope;

	constructor(database: Database, statements: Map<string, Statement>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}

	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;

	constructor(database: Database) {
		super(database, new Map());
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				try {
					// Every cached statement is finalized before the connection closes, or the files stay locked on Windows.
					for (const statement of this.statements.values()) statement.finalize();
				} finally {
					this.statements.clear();
					this.database.close();
				}
			}
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

function nonNegativeInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer, received ${String(value)}`);
	}
	return value;
}

/** Open and configure a `bun:sqlite`-backed database facade with the same settings as the Node one. */
export async function openBunSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteDatabase> {
	const checkpointPages = nonNegativeInteger(
		"walAutoCheckpointPages",
		options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES,
	);
	const timeout = nonNegativeInteger("busyTimeoutMs", options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const { Database } = await import("bun:sqlite");
	const adapter = new BunSqliteDatabase(new Database(path));
	try {
		// Before anything that takes a lock: `node:sqlite` applies its `timeout` option when it opens.
		await adapter.exec(`PRAGMA busy_timeout = ${timeout}`);
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		throw error;
	}
}
