import { pathToFileURL } from "node:url";

/**
 * The arguments that make the current runtime run `modulePath` before the main script, for tests that start a child
 * process with `process.execPath`. Node spells this `--import <url>`; Bun's `--import` is a different option, and its
 * `--preload <path>` is the same thing.
 */
export function preloadArgs(modulePath: string): string[] {
	return process.versions.bun ? ["--preload", modulePath] : ["--import", pathToFileURL(modulePath).href];
}
