/**
 * Runtime identity for the coding-agent package.
 *
 * Keep this module free of package, filesystem, and provider concerns so lower
 * layers can select runtime-specific capabilities without importing config.ts.
 */
export type RuntimeKind = "bun-binary" | "bun" | "bundled-node" | "node";

/** Detect if we're running as a Bun compiled binary. */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect Bun at module load; callers that need test-time re-reading use runningUnderBun(). */
export const isBunRuntime = !!process.versions.bun;

/** Detect the esbuild-bundled Node.js distribution. */
declare const NYAN_BUNDLED_NODE: boolean;
export const isBundledNode = typeof NYAN_BUNDLED_NODE !== "undefined" && NYAN_BUNDLED_NODE;

/** Read the Bun marker each time so tests can exercise both runtime branches. */
export function runningUnderBun(): boolean {
	return typeof process.versions.bun === "string";
}

/**
 * Format the runtime label used in diagnostics and outbound user-agent metadata.
 *
 * This keeps the truthiness test of the inline expressions it replaced, so an empty `process.versions.bun` yields a
 * `node/` label and the user agent does not change. `runningUnderBun()` keeps its own `typeof` test; the two differ
 * only for an empty marker, which Bun does not report.
 */
export function getRuntimeLabel(): string {
	const bunVersion = process.versions.bun;
	return bunVersion ? `bun/${bunVersion}` : `node/${process.version}`;
}

export interface RuntimeFlags {
	bunBinary: boolean;
	bundledNode: boolean;
	bunRuntime: boolean;
}

/** Resolve runtime identity with Bun binaries first, then bundled Node, Bun, and unbundled Node. */
export function resolveRuntimeKind(flags: RuntimeFlags): RuntimeKind {
	if (flags.bunBinary) return "bun-binary";
	if (flags.bundledNode) return "bundled-node";
	return flags.bunRuntime ? "bun" : "node";
}

/** Return the runtime identity without importing package configuration or I/O helpers. */
export function getRuntimeKind(): RuntimeKind {
	return resolveRuntimeKind({
		bunBinary: isBunBinary,
		bundledNode: isBundledNode,
		bunRuntime: runningUnderBun(),
	});
}
