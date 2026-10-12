/**
 * `process.exitCode` for tests that run on Node and on Bun.
 *
 * Bun cannot clear a reported exit code: assigning `undefined` keeps the previous number (Node clears it), the property
 * is not configurable, and it cannot be deleted. Tests therefore clear it by assigning 0, and ask for a failure instead
 * of for `undefined`. Nothing in the product depends on clearing it; only tests do.
 */

/** Clear a previously reported failure, so the next command starts from a successful exit code. */
export function clearExitCode(): void {
	process.exitCode = 0;
}

/** True when the process would exit non-zero. `undefined` and 0 both mean success. */
export function exitCodeReportsFailure(): boolean {
	return (process.exitCode ?? 0) !== 0;
}
