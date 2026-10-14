import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve the Bun executable to hand to `spawnSync`.
 *
 * On Windows, `spawnSync("bun", ...)` fails with ENOENT. Bun installs a `bun.cmd` shim, and Node
 * refuses to launch a `.cmd` without `shell: true` (CVE-2024-27980). Enabling the shell is not an
 * option here: it concatenates arguments instead of escaping them, so a path containing a space
 * splits into two. Measured with a script path like `C:/Users/x/.nyan y/vitest.mjs`, `shell: true`
 * reports `error: Module not found "C:/Users/x/.nyan"`.
 *
 * Resolve the `bun.exe` the shim wraps instead, so arguments stay an array. The shim installed by
 * npm, nvm and Bun's own installer is `<prefix>/bun.cmd`, which runs
 * `<prefix>/node_modules/bun/bin/bun.exe`. Linux and macOS use the bare name.
 */
export function resolveBunExecutable() {
	if (process.platform !== "win32") return "bun";

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const entry of pathEntries) {
		const wrapped = join(entry, "node_modules", "bun", "bin", "bun.exe");
		if (existsSync(wrapped)) return wrapped;
	}

	return "bun";
}
