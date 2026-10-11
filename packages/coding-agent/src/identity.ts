/**
 * Product identity owned by Nyan's product shell.
 *
 * `cliName` is the executable and the prefix of the environment variables
 * (`NYAN_CODING_AGENT_DIR`), `displayName` is what the user reads in titles, and
 * `configDirName` is the per-user and per-project directory. A package may override
 * them through the `nyanConfig` field of its package.json.
 */
export const PRODUCT_IDENTITY = {
	cliName: "nyan",
	displayName: "Nyan",
	configDirName: ".nyan",
} as const;

export type ConfiguredProductIdentity = {
	readonly appName: string;
	readonly appTitle: string;
	readonly configDirName: string;
};

/** Resolve package-level overrides over the product defaults. */
export function resolveConfiguredProductIdentity(config: {
	readonly name?: string;
	readonly configDir?: string;
}): ConfiguredProductIdentity {
	return {
		appName: config.name ?? PRODUCT_IDENTITY.cliName,
		appTitle: config.name ?? PRODUCT_IDENTITY.displayName,
		configDirName: config.configDir ?? PRODUCT_IDENTITY.configDirName,
	};
}
