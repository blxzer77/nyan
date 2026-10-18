import { DatabaseSync } from "node:sqlite";

/**
 * A synchronous connection that a test opens next to the storage under test, to look at or damage the database file.
 *
 * It is shaped like the part of `DatabaseSync` the tests use. On Node it is a `DatabaseSync`. On Bun it is a `bun:sqlite`
 * database that finalizes every statement it prepared when it closes: a `node:sqlite` connection cannot do that, and on
 * Windows the statements it leaves behind keep the `-shm` and `-wal` files locked, so the test's cleanup fails with EBUSY.
 */
export interface SqliteInspectorStatement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteInspector {
	exec(sql: string): void;
	prepare(sql: string): SqliteInspectorStatement;
	close(): void;
}

export function openInspector(path: string, options: { readOnly?: boolean } = {}): SqliteInspector {
	if (typeof process.versions.bun !== "string") {
		const database = new DatabaseSync(path, options);
		return {
			exec: (sql) => database.exec(sql),
			prepare: (sql) => database.prepare(sql) as SqliteInspectorStatement,
			close: () => database.close(),
		};
	}
	const bunSqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
	// An options object without `readonly: true` leaves out Bun's default open flags (SQLITE_MISUSE), so it is passed only then.
	const database =
		options.readOnly === true ? new bunSqlite.Database(path, { readonly: true }) : new bunSqlite.Database(path);
	const statements: Array<InstanceType<typeof bunSqlite.Statement>> = [];
	return {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => {
			const statement = database.prepare(sql);
			statements.push(statement);
			return statement;
		},
		close: () => {
			try {
				for (const statement of statements) statement.finalize();
			} finally {
				database.close();
			}
		},
	};
}
