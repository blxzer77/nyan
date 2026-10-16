/**
 * Runtime detection for code that must also load in a browser bundle.
 *
 * This module imports nothing and touches no Node built-in. Each call re-reads `process.versions`, so the result
 * matches the inline checks it replaces and a test can inject or hide the Bun marker.
 */

/** True under Node.js or Bun. Bun reports `process.versions.node` too, so this means "not a browser". */
export function isNodeLikeRuntime(): boolean {
	return typeof process !== "undefined" && Boolean(process.versions?.node || process.versions?.bun);
}

/**
 * True only under Bun. This tests truthiness, as the inline checks it replaced did. The same-named function in
 * `packages/coding-agent/src/runtime.ts` tests `typeof ... === "string"`; the two differ only for an empty
 * `process.versions.bun`, which Bun does not report.
 */
export function runningUnderBun(): boolean {
	return typeof process !== "undefined" && Boolean(process.versions?.bun);
}
