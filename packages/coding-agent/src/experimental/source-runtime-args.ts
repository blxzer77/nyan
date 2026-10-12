/**
 * The runtime arguments that let a child process run this package's TypeScript sources.
 *
 * Node strips the types itself but does not apply the workspace aliases from tsconfig.json, so it preloads the source
 * resolver. `--import` takes a module specifier, and a raw path breaks on Windows drives and on `#`, `?`, or `%`.
 * Bun reads the tsconfig `paths` on its own, and its `--import` is a different option, so it needs nothing.
 */
export function sourceRuntimeArgs(): string[] {
	if (typeof process.versions.bun === "string") return [];
	return ["--import", new URL("source-resolver.ts", import.meta.url).href];
}
