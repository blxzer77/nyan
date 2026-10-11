import { compare, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getNyanUserAgent } from "./nyan-user-agent.ts";

/**
 * Where the latest release comes from. By default the npm registry answers for this package's `latest` dist-tag.
 * `NYAN_LATEST_VERSION_URL` replaces it with a feed that answers `{ version, packageName?, note? }`, and
 * `NYAN_NPM_REGISTRY` points the default lookup at another registry.
 */
export const ENV_LATEST_VERSION_URL = "NYAN_LATEST_VERSION_URL";
export const ENV_NPM_REGISTRY = "NYAN_NPM_REGISTRY";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

function latestVersionUrl(): string {
	const feed = process.env[ENV_LATEST_VERSION_URL]?.trim();
	if (feed) return feed;
	const registry = (process.env[ENV_NPM_REGISTRY]?.trim() || DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
	return `${registry}/${PACKAGE_NAME.replace("/", "%2F")}/latest`;
}
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestNyanRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestNyanRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestNyanRelease | undefined> {
	if (process.env.NYAN_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		latestVersionUrl(),
		{
			headers: {
				"User-Agent": getNyanUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestNyanVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestNyanRelease(currentVersion, options))?.version;
}

export async function checkForNewNyanVersion(currentVersion: string): Promise<LatestNyanRelease | undefined> {
	if (process.env.NYAN_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestNyanRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
