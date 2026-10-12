/**
 * Load-time compatibility for extensions written against Pi.
 *
 * A Pi extension imports the host from `@earendil-works/pi-*` (older ones from `@mariozechner/pi-*`) and declares its
 * resources in a `pi` field of package.json. Nyan's host modules are the same code under other names, so an extension
 * that only uses the host API needs nothing but those two names mapped:
 *
 * - `withPiAliases` adds the Pi import specifiers next to the Nyan ones, pointing at the same module or file.
 * - `readNyanManifest` falls back to the `pi` field when a package has no `nyan` field.
 *
 * This is a compatibility layer, not part of Nyan's own naming: Nyan code, docs and packages use `@ny4n/*` and `nyan`.
 * It does not cover an extension that builds `~/.pi/agent`, reads `PI_*`, or `piConfig` itself; such an extension keeps
 * looking at Pi's directory. See .agents/notes/implemented/architecture/2026-10-13-pi-extension-compatibility.md.
 */

/** Pi package name for each Nyan host package, by the name that follows `@ny4n/`. */
const PI_PACKAGE_FOR: Record<string, string> = {
	"coding-agent": "pi-coding-agent",
	tui: "pi-tui",
	ai: "pi-ai",
	"agent-core": "pi-agent-core",
};

const PI_SCOPES = ["@earendil-works", "@mariozechner"] as const;

/** The Pi import specifiers that name the same module as `nyanSpecifier`, or none for a specifier that is not a host module. */
export function piSpecifiersFor(nyanSpecifier: string): string[] {
	const match = /^@ny4n\/([^/]+)(\/.*)?$/.exec(nyanSpecifier);
	const piPackage = match ? PI_PACKAGE_FOR[match[1]] : undefined;
	if (!match || !piPackage) return [];
	return PI_SCOPES.map((scope) => `${scope}/${piPackage}${match[2] ?? ""}`);
}

/**
 * Return the entries with each `@ny4n/*` host entry followed by its Pi names. The order is kept (a more specific
 * specifier stays before its package root, which path-prefix matching needs), and the original entries are untouched.
 */
export function withPiAliases<T>(entries: Record<string, T>): Record<string, T> {
	const result: Record<string, T> = {};
	for (const [specifier, value] of Object.entries(entries)) {
		result[specifier] = value;
		for (const piSpecifier of piSpecifiersFor(specifier)) result[piSpecifier] = value;
	}
	return result;
}
