/**
 * `NODE_OPTIONS=--use-system-ca` makes Node trust the operating system certificate store. Bun does not read
 * `NODE_OPTIONS`. It has its own switches, which have to be set before the process starts (setting a variable from
 * inside the process, even before the first request, changes nothing; measured on Bun 1.4.3, Windows x64):
 *
 * - `--use-system-ca` as an argument to `bun`, or in `BUN_OPTIONS`,
 * - `NODE_USE_SYSTEM_CA=1` (or `true`; `0` leaves it off).
 *
 * In the standalone executable the program's own arguments are not Bun's, so only the two variables work there.
 * `NODE_EXTRA_CA_CERTS` works the same on Node and on Bun and needs no switch.
 *
 * A machine configured for Node therefore silently loses its system store under Bun. This tells the user once.
 */

const FLAG = "--use-system-ca";

function hasFlag(options: string | undefined): boolean {
	return options?.split(/\s+/).includes(FLAG) ?? false;
}

function systemStoreEnabledForBun(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
	const variable = env.NODE_USE_SYSTEM_CA?.trim().toLowerCase();
	return variable === "1" || variable === "true" || hasFlag(env.BUN_OPTIONS) || execArgv.includes(FLAG);
}

/** True when `NODE_OPTIONS` asks for the system store and none of Bun's own switches does. */
export function systemCaIgnoredByBun(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
	return hasFlag(env.NODE_OPTIONS) && !systemStoreEnabledForBun(env, execArgv);
}

export const SYSTEM_CA_IGNORED_MESSAGE =
	"NODE_OPTIONS=--use-system-ca does not enable the OS certificate store under Bun or compiled Bun binaries. " +
	"Set NODE_USE_SYSTEM_CA=1, use BUN_OPTIONS=--use-system-ca, or set NODE_EXTRA_CA_CERTS to a CA file.";

let warned = false;

/** Warn once per process when Bun ignores the system-store request. `warn` is injectable for tests. */
export function warnIfSystemCaIgnoredByBun(
	env: NodeJS.ProcessEnv = process.env,
	execArgv: readonly string[] = process.execArgv,
	warn: (message: string) => void = (message) => console.warn(`Warning: ${message}`),
): void {
	if (warned || !systemCaIgnoredByBun(env, execArgv)) return;
	warned = true;
	warn(SYSTEM_CA_IGNORED_MESSAGE);
}

/** Exported for tests. */
export function resetSystemCaWarningForTests(): void {
	warned = false;
}
