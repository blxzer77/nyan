/**
 * Self-update for the standalone release binary.
 *
 * A release archive unpacks to a folder: the `nyan` executable plus the files it reads from beside itself (package.json,
 * themes, docs, native modules). Updating means replacing that folder's files with those of the newer archive.
 *
 * Ownership and failure guarantees:
 * - The archive comes from the release's own download folder (`NYAN_RELEASE_BASE_URL`, default this repository's GitHub
 *   releases) and must match the SHA256 listed in that release's `SHA256SUMS`. The checksum catches a damaged or
 *   truncated download; it does not authenticate the release, because both files come from the same place.
 * - Nothing in the install folder changes until the archive is downloaded, verified, unpacked, and its package.json
 *   names this package at the requested version.
 * - Each file is renamed into a backup folder before the new one takes its place, which also works for the running
 *   executable on Windows. If any step fails, the files already swapped are put back. A process killed mid-swap can
 *   leave a mix of old and new files; `nyan update --force` repairs that.
 * - Backups are deleted afterwards. The running executable cannot be deleted on Windows, so the stage folder stays
 *   until the next start, which removes it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME, PACKAGE_NAME, VERSION } from "../config.ts";
import { spawnProcessSync } from "./child-process.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getNyanUserAgent } from "./nyan-user-agent.ts";

export const ENV_RELEASE_BASE_URL = "NYAN_RELEASE_BASE_URL";
const DEFAULT_RELEASE_BASE_URL = "https://github.com/blxzer77/nyan/releases/download";
export const RELEASES_PAGE_URL = "https://github.com/blxzer77/nyan/releases/latest";
const STAGE_PREFIX = ".nyan-update-";
const LOCK_NAME = ".nyan-update.lock";
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** The platform part of a release asset name, such as `linux-x64` or `windows-arm64`. */
export function binaryPlatform(platform: string = process.platform, arch: string = process.arch): string {
	const os = platform === "win32" ? "windows" : platform === "darwin" || platform === "linux" ? platform : undefined;
	if (!os || (arch !== "x64" && arch !== "arm64")) {
		throw new Error(`There is no ${APP_NAME} release binary for ${platform}-${arch}.`);
	}
	return `${os}-${arch}`;
}

export function binaryAssetName(platformName: string): string {
	return `nyan-${platformName}.${platformName.startsWith("windows-") ? "zip" : "tar.gz"}`;
}

function executableName(platformName: string): string {
	return platformName.startsWith("windows-") ? "nyan.exe" : "nyan";
}

/** The folder URL that holds the assets of releases. Plain http is accepted only for loopback (tests and mirrors). */
export function releaseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = (env[ENV_RELEASE_BASE_URL]?.trim() || DEFAULT_RELEASE_BASE_URL).replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${ENV_RELEASE_BASE_URL} is not a URL: ${raw}`);
	}
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(`${ENV_RELEASE_BASE_URL} must be an https URL (http is allowed only for localhost): ${raw}`);
	}
	return raw;
}

/** The SHA256 listed for `fileName` in the text of a `SHA256SUMS` file, in `sha256sum` format. */
export function findSha256(sums: string, fileName: string): string | undefined {
	for (const line of sums.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
		if (match && match[2] === fileName) return match[1].toLowerCase();
	}
	return undefined;
}

export type FetchAsset = (url: string) => Promise<Response>;

function defaultFetchAsset(url: string): Promise<Response> {
	return fetchWithRetry(
		url,
		{ headers: { "User-Agent": getNyanUserAgent(VERSION) } },
		{ maxRetries: 2, timeoutMs: DOWNLOAD_TIMEOUT_MS },
	);
}

async function download(fetchAsset: FetchAsset, url: string, version: string, label: string): Promise<Buffer> {
	const response = await fetchAsset(url);
	if (response.status === 404) {
		throw new Error(
			`Release ${version} has no ${label} yet (${url}). Binaries are attached after the npm release; retry in a few minutes or download from ${RELEASES_PAGE_URL}.`,
		);
	}
	if (!response.ok) throw new Error(`Could not download ${label} from ${url}: HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

function extractArchive(archivePath: string, destination: string, platformName: string): void {
	let command = "tar";
	let args = ["-xzf", archivePath, "-C", destination];
	if (platformName.startsWith("windows-")) {
		// Git Bash puts GNU tar first on PATH, and it cannot read zip files; Windows ships bsdtar here.
		const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		if (existsSync(bsdtar)) {
			command = bsdtar;
			args = ["-xf", archivePath, "-C", destination];
		} else {
			command = "powershell.exe";
			args = [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Expand-Archive -LiteralPath $env:NYAN_UPDATE_ARCHIVE -DestinationPath $env:NYAN_UPDATE_DESTINATION -Force",
			];
		}
	}
	const result = spawnProcessSync(command, args, {
		encoding: "utf8",
		env: { ...process.env, NYAN_UPDATE_ARCHIVE: archivePath, NYAN_UPDATE_DESTINATION: destination },
	});
	if (result.error) throw new Error(`Could not run ${command} to unpack the update: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`${command} could not unpack the update (exit ${result.status}): ${result.stderr?.trim() ?? ""}`);
	}
}

/** Relative paths of every file under `root`, with the executable last so it is replaced after its assets. */
function listFiles(root: string, executable: string, dir = root): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(root, executable, path));
		else files.push(relative(root, path));
	}
	return dir === root
		? [...files.filter((file) => file !== executable), ...files.filter((file) => file === executable)]
		: files;
}

function readPackageJson(dir: string): { name?: string; version?: string } | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
	} catch {
		return undefined;
	}
}

/** Replace the files of `installDir` with those of `newRoot`, undoing the swap if any step fails. */
function swapFiles(
	newRoot: string,
	installDir: string,
	backupDir: string,
	files: string[],
	rename: typeof renameSync,
): void {
	const placed: string[] = [];
	const moved: Array<{ target: string; backup: string }> = [];
	try {
		for (const file of files) {
			const target = join(installDir, file);
			mkdirSync(dirname(target), { recursive: true });
			if (existsSync(target)) {
				const backup = join(backupDir, file);
				mkdirSync(dirname(backup), { recursive: true });
				rename(target, backup);
				moved.push({ target, backup });
			}
			rename(join(newRoot, file), target);
			placed.push(target);
		}
	} catch (error) {
		for (const path of placed.reverse()) rmSync(path, { force: true });
		for (const { target, backup } of moved.reverse()) {
			try {
				rename(backup, target);
			} catch {
				// Leave the backup in place; the error below says the install needs repair.
			}
		}
		throw new Error(
			`Could not replace ${APP_NAME} files; the installation was restored where possible. Run \`${APP_NAME} update --force\` or download ${RELEASES_PAGE_URL}. ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export interface BinaryUpdateOptions {
	version: string;
	/** Folder of the extracted release that holds the running executable. */
	installDir?: string;
	platformName?: string;
	fetchAsset?: FetchAsset;
	/** The base URL of the release folders; defaults to `NYAN_RELEASE_BASE_URL` or this repository's releases. */
	baseUrl?: string;
	/** Replaces `fs.renameSync`; tests use it to make a swap fail. */
	rename?: typeof renameSync;
}

/** Download the release archive for `version`, verify it, and replace the install folder's files with its contents. */
export async function updateBinaryInstall(options: BinaryUpdateOptions): Promise<void> {
	const { version } = options;
	if (!RELEASE_VERSION_RE.test(version)) throw new Error(`Invalid release version: ${version}`);
	const platformName = options.platformName ?? binaryPlatform();
	const installDir = options.installDir ?? dirname(process.execPath);
	const fetchAsset = options.fetchAsset ?? defaultFetchAsset;
	const rename = options.rename ?? renameSync;
	const executable = executableName(platformName);
	const asset = binaryAssetName(platformName);
	const releaseUrl = `${options.baseUrl ?? releaseBaseUrl()}/nyan-v${version}`;

	// Only a folder that came from a release archive is replaced, never a bare executable someone copied elsewhere.
	if (readPackageJson(installDir)?.name !== PACKAGE_NAME) {
		throw new Error(
			`${installDir} is not an extracted ${APP_NAME} release folder (no ${PACKAGE_NAME} package.json beside the executable). Download ${RELEASES_PAGE_URL} and extract it.`,
		);
	}
	try {
		accessSync(installDir, constants.W_OK);
	} catch {
		throw new Error(`${installDir} is not writable. Run the update with permission to write there.`);
	}

	let releaseLock: (() => Promise<void>) | undefined;
	try {
		releaseLock = await lockfile.lock(installDir, { realpath: false, lockfilePath: join(installDir, LOCK_NAME) });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error(`Another ${APP_NAME} update is already running.`);
		}
		throw error;
	}

	const stageDir = join(installDir, `${STAGE_PREFIX}${randomUUID().slice(0, 8)}`);
	try {
		mkdirSync(stageDir, { recursive: true });
		const [sums, archive] = await Promise.all([
			download(fetchAsset, `${releaseUrl}/SHA256SUMS`, version, "SHA256SUMS"),
			download(fetchAsset, `${releaseUrl}/${asset}`, version, asset),
		]);
		const expected = findSha256(sums.toString("utf8"), asset);
		if (!expected) throw new Error(`SHA256SUMS of release ${version} does not list ${asset}.`);
		const actual = createHash("sha256").update(archive).digest("hex");
		if (actual !== expected) {
			throw new Error(
				`${asset} does not match SHA256SUMS (expected ${expected}, got ${actual}). Nothing was changed.`,
			);
		}

		const archivePath = join(stageDir, asset);
		const extractDir = join(stageDir, "new");
		writeFileSync(archivePath, archive);
		mkdirSync(extractDir);
		extractArchive(archivePath, extractDir, platformName);
		rmSync(archivePath, { force: true });

		// The tar archives hold a nyan/ folder; the zip holds its files at the root. Match a file, not a
		// directory: the tar's nyan/ folder has the same name as the Unix executable.
		const newRoot = [extractDir, join(extractDir, "nyan")].find(
			(dir) => statSync(join(dir, executable), { throwIfNoEntry: false })?.isFile() === true,
		);
		if (!newRoot) throw new Error(`${asset} does not contain ${executable}.`);
		const newPackage = readPackageJson(newRoot);
		if (newPackage?.name !== PACKAGE_NAME || newPackage.version !== version) {
			throw new Error(
				`${asset} holds ${newPackage?.name ?? "no package.json"}@${newPackage?.version ?? "?"}, not ${PACKAGE_NAME}@${version}. Nothing was changed.`,
			);
		}

		swapFiles(newRoot, installDir, join(stageDir, "old"), listFiles(newRoot, executable), rename);
	} finally {
		// The old executable cannot be deleted while it runs on Windows; the next start removes the leftover.
		try {
			rmSync(stageDir, { recursive: true, force: true });
		} catch {
			// cleanupBinaryUpdateLeftovers() retries at the next start.
		}
		await releaseLock?.();
	}
}

/** Remove stage folders an earlier update could not delete, unless an update is running now. */
export function cleanupBinaryUpdateLeftovers(installDir: string): void {
	try {
		if (lockfile.checkSync(installDir, { realpath: false, lockfilePath: join(installDir, LOCK_NAME) })) return;
		for (const entry of readdirSync(installDir)) {
			if (!entry.startsWith(STAGE_PREFIX)) continue;
			const path = join(installDir, entry);
			if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
		}
	} catch {
		// Best effort: a leftover folder costs disk space and nothing else.
	}
}
