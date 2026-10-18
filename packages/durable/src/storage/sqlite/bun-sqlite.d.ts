// The part of Bun's built-in `bun:sqlite` that `bun.ts` uses. Bun's own types are not a dependency of this package.
declare module "bun:sqlite" {
	export class Statement {
		run(...params: unknown[]): unknown;
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
		/** Read INTEGER values as `bigint`, whatever their size. */
		safeIntegers(enabled?: boolean): this;
		/** Release the statement. A statement that is not finalized keeps the database's files locked on Windows. */
		finalize(): void;
	}

	export class Database {
		constructor(filename?: string, options?: { readonly?: boolean });
		exec(sql: string): void;
		prepare(sql: string): Statement;
		close(): void;
	}
}
