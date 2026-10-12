import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import {
	binaryAssetName,
	binaryPlatform,
	cleanupBinaryUpdateLeftovers,
	ENV_RELEASE_BASE_URL,
	findSha256,
	releaseBaseUrl,
	updateBinaryInstall,
} from "../src/utils/binary-update.ts";

const platformName = binaryPlatform();
const asset = binaryAssetName(platformName);
const exe = platformName.startsWith("windows-") ? "nyan.exe" : "nyan";
const baseUrl = "https://releases.test/download";

let work: string;
let installDir: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "nyan-binary-update-"));
	installDir = join(work, "install");
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

/** A release folder: the executable, package.json, and the given files. */
function writeRelease(root: string, version: string, files: Record<string, string> = {}): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
	writeFileSync(join(root, exe), `executable ${version}`);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), content);
	}
}

/** Pack a release folder the way scripts/build-binaries.mjs does: a nyan/ folder in a tar.gz, or the files at a zip's root. */
function pack(contentDir: string, archivePath: string): void {
	if (platformName.startsWith("windows-")) {
		const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		const result = spawnSync(bsdtar, ["-a", "-cf", archivePath, "-C", contentDir, "."]);
		expect(result.status).toBe(0);
		return;
	}
	const parent = join(work, "pack-parent");
	rmSync(parent, { recursive: true, force: true });
	mkdirSync(parent);
	renameSync(contentDir, join(parent, "nyan"));
	const result = spawnSync("tar", ["-czf", archivePath, "-C", parent, "nyan"]);
	expect(result.status).toBe(0);
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/** Serve a release's archive and checksums from memory. */
function releaseFetch(version: string, archive: Buffer, sums?: string) {
	const assets = new Map<string, Buffer>([
		[`${baseUrl}/nyan-v${version}/${asset}`, archive],
		[`${baseUrl}/nyan-v${version}/SHA256SUMS`, Buffer.from(sums ?? `${sha256(archive)}  ${asset}\n`)],
	]);
	return async (url: string): Promise<Response> => {
		const body = assets.get(url);
		return body ? new Response(Uint8Array.from(body)) : new Response("", { status: 404 });
	};
}

function archiveOf(version: string, files: Record<string, string>): Buffer {
	const content = join(work, `release-${version}`);
	writeRelease(content, version, files);
	const archivePath = join(work, `archive-${version}`);
	pack(content, archivePath);
	return readFileSync(archivePath);
}

function readInstalled(name: string): string {
	return readFileSync(join(installDir, name), "utf8");
}

function stageDirs(): string[] {
	return readdirSync(installDir).filter((entry) => entry.startsWith(".nyan-update-"));
}

describe("asset names", () => {
	it("names the archive after the platform", () => {
		expect(binaryAssetName("linux-x64")).toBe("nyan-linux-x64.tar.gz");
		expect(binaryAssetName("darwin-arm64")).toBe("nyan-darwin-arm64.tar.gz");
		expect(binaryAssetName("windows-x64")).toBe("nyan-windows-x64.zip");
	});

	it("maps Node platform and architecture to the release platform", () => {
		expect(binaryPlatform("win32", "arm64")).toBe("windows-arm64");
		expect(binaryPlatform("darwin", "x64")).toBe("darwin-x64");
		expect(() => binaryPlatform("freebsd", "x64")).toThrow(/no nyan release binary for freebsd-x64/);
		expect(() => binaryPlatform("linux", "ia32")).toThrow(/linux-ia32/);
	});
});

describe("releaseBaseUrl", () => {
	it("defaults to this repository's GitHub releases", () => {
		expect(releaseBaseUrl({})).toBe("https://github.com/blxzer77/nyan/releases/download");
	});

	it("takes an https override and drops a trailing slash", () => {
		expect(releaseBaseUrl({ [ENV_RELEASE_BASE_URL]: "https://mirror.example/nyan/" })).toBe(
			"https://mirror.example/nyan",
		);
	});

	it("accepts plain http only for loopback", () => {
		expect(releaseBaseUrl({ [ENV_RELEASE_BASE_URL]: "http://127.0.0.1:8080" })).toBe("http://127.0.0.1:8080");
		expect(releaseBaseUrl({ [ENV_RELEASE_BASE_URL]: "http://localhost:9" })).toBe("http://localhost:9");
		expect(() => releaseBaseUrl({ [ENV_RELEASE_BASE_URL]: "http://mirror.example" })).toThrow(/must be an https URL/);
	});

	it("rejects a value that is not a URL", () => {
		expect(() => releaseBaseUrl({ [ENV_RELEASE_BASE_URL]: "not a url" })).toThrow(/not a URL/);
	});
});

describe("findSha256", () => {
	const hash = "a".repeat(64);
	const other = "b".repeat(64);

	it("finds the entry for an exact file name", () => {
		const sums = `${other}  nyan-linux-x64.tar.gz\n${hash.toUpperCase()}  nyan-windows-x64.zip\n`;
		expect(findSha256(sums, "nyan-windows-x64.zip")).toBe(hash);
		expect(findSha256(sums, "nyan-linux-x64.tar.gz")).toBe(other);
	});

	it("does not match a file name by suffix, and ignores malformed lines", () => {
		expect(
			findSha256(`${hash}  other-nyan-linux-x64.tar.gz\nnot a checksum line\n`, "nyan-linux-x64.tar.gz"),
		).toBeUndefined();
	});

	it("reads the binary-mode marker and CRLF line endings", () => {
		expect(findSha256(`${hash} *nyan-linux-x64.tar.gz\r\n`, "nyan-linux-x64.tar.gz")).toBe(hash);
	});
});

describe("updateBinaryInstall", () => {
	beforeEach(() => {
		writeRelease(installDir, "1.0.0", {
			"docs/a.md": "old a",
			"docs/gone.md": "only in 1.0.0",
			"user-note.txt": "mine",
		});
	});

	it("replaces the release files, keeps files the archive does not have, and leaves no stage folder", async () => {
		const archive = archiveOf("1.1.0", { "docs/a.md": "new a", "docs/b.md": "new b" });

		await updateBinaryInstall({
			version: "1.1.0",
			installDir,
			platformName,
			baseUrl,
			fetchAsset: releaseFetch("1.1.0", archive),
		});

		expect(JSON.parse(readInstalled("package.json")).version).toBe("1.1.0");
		expect(readInstalled(exe)).toBe("executable 1.1.0");
		expect(readInstalled("docs/a.md")).toBe("new a");
		expect(readInstalled("docs/b.md")).toBe("new b");
		expect(readInstalled("user-note.txt")).toBe("mine");
		expect(existsSync(join(installDir, "docs", "gone.md"))).toBe(true);
		expect(stageDirs()).toEqual([]);
		expect(existsSync(join(installDir, ".nyan-update.lock"))).toBe(false);
	});

	it("changes nothing when the checksum does not match", async () => {
		const archive = archiveOf("1.1.0", { "docs/a.md": "new a" });
		const wrong = `${"0".repeat(64)}  ${asset}\n`;

		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: releaseFetch("1.1.0", archive, wrong),
			}),
		).rejects.toThrow(/does not match SHA256SUMS/);

		expect(JSON.parse(readInstalled("package.json")).version).toBe("1.0.0");
		expect(readInstalled("docs/a.md")).toBe("old a");
		expect(stageDirs()).toEqual([]);
	});

	it("refuses a release whose SHA256SUMS does not list the asset", async () => {
		const archive = archiveOf("1.1.0", {});
		const unrelated = `${sha256(archive)}  nyan-other-platform.tar.gz\n`;

		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: releaseFetch("1.1.0", archive, unrelated),
			}),
		).rejects.toThrow(/does not list/);
		expect(JSON.parse(readInstalled("package.json")).version).toBe("1.0.0");
	});

	it("explains that the binaries may not be attached yet when the release has none", async () => {
		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: async () => new Response("", { status: 404 }),
			}),
		).rejects.toThrow(/has no SHA256SUMS yet/);
		expect(stageDirs()).toEqual([]);
	});

	it("refuses an archive that holds another version than the one requested", async () => {
		const archive = archiveOf("1.2.0", {});

		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: releaseFetch("1.1.0", archive),
			}),
		).rejects.toThrow(/not @ny4n\/coding-agent@1\.1\.0/);
		expect(JSON.parse(readInstalled("package.json")).version).toBe("1.0.0");
		expect(readInstalled(exe)).toBe("executable 1.0.0");
	});

	it("refuses a folder that did not come from a release archive", async () => {
		rmSync(join(installDir, "package.json"));
		const archive = archiveOf("1.1.0", {});

		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: releaseFetch("1.1.0", archive),
			}),
		).rejects.toThrow(/not an extracted nyan release folder/);
		expect(readInstalled(exe)).toBe("executable 1.0.0");
	});

	it("rejects a malformed version before touching anything", async () => {
		await expect(updateBinaryInstall({ version: "../1.1.0", installDir, platformName, baseUrl })).rejects.toThrow(
			/Invalid release version/,
		);
	});

	it("puts every swapped file back when placing the executable fails", async () => {
		const archive = archiveOf("1.1.0", { "docs/a.md": "new a", "docs/b.md": "new b" });
		// Only the first attempt fails; the rollback renames the same path back.
		let failed = false;
		const failOnExecutable: typeof renameSync = (from, to) => {
			if (!failed && String(to) === join(installDir, exe)) {
				failed = true;
				throw new Error("simulated: executable is busy");
			}
			renameSync(from, to);
		};

		await expect(
			updateBinaryInstall({
				version: "1.1.0",
				installDir,
				platformName,
				baseUrl,
				fetchAsset: releaseFetch("1.1.0", archive),
				rename: failOnExecutable,
			}),
		).rejects.toThrow(/installation was restored.*simulated: executable is busy/s);

		expect(JSON.parse(readInstalled("package.json")).version).toBe("1.0.0");
		expect(readInstalled(exe)).toBe("executable 1.0.0");
		expect(readInstalled("docs/a.md")).toBe("old a");
		expect(existsSync(join(installDir, "docs", "b.md"))).toBe(false);
		expect(stageDirs()).toEqual([]);
	});
});

describe("cleanupBinaryUpdateLeftovers", () => {
	it("removes stage folders and nothing else", () => {
		writeRelease(installDir, "1.0.0", { "docs/a.md": "a" });
		mkdirSync(join(installDir, ".nyan-update-abc123", "old"), { recursive: true });
		writeFileSync(join(installDir, ".nyan-update-abc123", "old", exe), "stale executable");

		cleanupBinaryUpdateLeftovers(installDir);

		expect(stageDirs()).toEqual([]);
		expect(readInstalled("docs/a.md")).toBe("a");
		expect(readInstalled(exe)).toBe("executable 1.0.0");
	});

	it("does nothing for a folder that does not exist", () => {
		expect(() => cleanupBinaryUpdateLeftovers(join(work, "missing"))).not.toThrow();
	});
});
