#!/usr/bin/env node
/**
 * Compile the nyan CLI into standalone Bun executables and pack one release archive per platform.
 *
 * Usage:
 *   node scripts/build-binaries.mjs [--platform <name>]... [--out <dir>]
 *
 * Run `npm run build` (or `npm run build:offline`) first: the executables embed
 * packages/coding-agent/dist/bun/cli.js, and the archives carry the built export templates.
 * Requires `bun` on PATH, `tar`, and `zip` for the Windows archives. Bun cross-compiles every
 * target from one host. The archives carry the packages/tui native prebuilds that are present
 * when the script runs, so the release workflow downloads the freshly built ones first.
 *
 * Output in <dir> (default packages/coding-agent/binaries):
 *   nyan-<platform>.tar.gz (a nyan/ directory) for darwin and linux, nyan-<platform>.zip for windows,
 *   and SHA256SUMS.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "packages", "coding-agent");

function parseArgs(argv) {
	const platforms = [];
	let out = join(agentDir, "binaries");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = argv[i + 1];
		if ((arg === "--platform" || arg === "--out") && !value) throw new Error(`${arg} needs a value`);
		if (arg === "--platform") {
			if (!PLATFORMS.includes(value)) throw new Error(`Unknown platform ${value}. Valid: ${PLATFORMS.join(", ")}`);
			platforms.push(value);
			i++;
		} else if (arg === "--out") {
			out = resolve(value);
			i++;
		} else {
			throw new Error(`Unknown option ${arg}`);
		}
	}
	return { platforms: platforms.length > 0 ? platforms : PLATFORMS, out };
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function copyFiles(fromDir, toDir, filter) {
	mkdirSync(toDir, { recursive: true });
	for (const name of readdirSync(fromDir)) {
		if (filter(name)) cpSync(join(fromDir, name), join(toDir, name));
	}
}

function buildPlatform(platform, out) {
	const isWindows = platform.startsWith("windows-");
	// x64 targets use Bun's baseline build so the executable runs on CPUs without AVX2.
	const target = `bun-${platform}${platform.endsWith("-x64") ? "-baseline" : ""}`;
	const stage = join(out, platform, "nyan");
	mkdirSync(stage, { recursive: true });

	// Bun embeds worker scripts only when they are explicit entrypoints, at their path relative to
	// the common directory of all entrypoints; the runtime resolves the codemode worker as
	// ./src/extensions/codemode/worker.ts. Disabling bunfig.toml and .env autoload keeps a project's
	// preload scripts and env files out of the executable's startup.
	run(
		"bun",
		[
			"build",
			"--compile",
			"--no-compile-autoload-bunfig",
			"--no-compile-autoload-dotenv",
			`--target=${target}`,
			"./dist/bun/cli.js",
			"./src/utils/image-resize-worker.ts",
			"./src/extensions/codemode/worker.ts",
			"--outfile",
			join(stage, isWindows ? "nyan.exe" : "nyan"),
		],
		agentDir,
	);

	// config.ts resolves these next to the executable when it runs as a Bun binary.
	for (const file of ["package.json", "README.md", "CHANGELOG.md"]) cpSync(join(agentDir, file), join(stage, file));
	cpSync(
		join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
		join(stage, "photon_rs_bg.wasm"),
	);
	copyFiles(join(agentDir, "src", "ui", "theme"), join(stage, "theme"), (name) => name.endsWith(".json"));
	copyFiles(join(agentDir, "src", "modes", "interactive", "assets"), join(stage, "assets"), () => true);
	cpSync(join(agentDir, "dist", "core", "export-html"), join(stage, "export-html"), { recursive: true });
	cpSync(join(agentDir, "docs"), join(stage, "docs"), { recursive: true });
	cpSync(join(agentDir, "examples"), join(stage, "examples"), { recursive: true });

	// packages/tui looks for native/<os>/prebuilds/<os>-<arch> next to process.execPath.
	const nativePlatform = platform.replace(/^windows-/, "win32-");
	const nativeOs = nativePlatform.split("-")[0];
	const nativeFrom = join(repoRoot, "packages", "tui", "native", nativeOs, "prebuilds", nativePlatform);
	if (!existsSync(nativeFrom)) throw new Error(`Missing native prebuilds: ${nativeFrom}`);
	cpSync(nativeFrom, join(stage, "native", nativeOs, "prebuilds", nativePlatform), { recursive: true });

	const archive = `nyan-${platform}.${isWindows ? "zip" : "tar.gz"}`;
	if (isWindows) {
		// The Windows archive holds the files at its root, so Expand-Archive into a folder gives nyan.exe there.
		run("zip", ["-qr", join(out, archive), "."], stage);
	} else {
		run("tar", ["-czf", join(out, archive), "nyan"], join(out, platform));
	}
	return archive;
}

const OUTPUT_MARKER = ".nyan-binaries";

/** Clear `out` for a fresh build. The removal is recursive, so it only touches an empty directory or one this script made. */
function prepareOutputDirectory(out) {
	if (repoRoot === out || repoRoot.startsWith(`${out}${sep}`)) {
		throw new Error(`--out ${out} is the repository or one of its parents; refusing to delete it.`);
	}
	if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, OUTPUT_MARKER))) {
		throw new Error(
			`--out ${out} is not empty and was not created by this script (no ${OUTPUT_MARKER} file); refusing to delete it. Use a new or empty directory.`,
		);
	}
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, OUTPUT_MARKER), "Created by scripts/build-binaries.mjs; the script may clear this directory.\n");
}

function main() {
	const { platforms, out } = parseArgs(process.argv.slice(2));
	if (!existsSync(join(agentDir, "dist", "bun", "cli.js"))) {
		throw new Error("packages/coding-agent/dist/bun/cli.js is missing. Run `npm run build` first.");
	}
	prepareOutputDirectory(out);

	const archives = platforms.map((platform) => {
		console.log(`==> ${platform}`);
		return buildPlatform(platform, out);
	});
	const sums = archives.map(
		(archive) => `${createHash("sha256").update(readFileSync(join(out, archive))).digest("hex")}  ${archive}`,
	);
	writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
	console.log(`\nArchives in ${out}:\n${archives.map((archive) => `  ${archive}`).join("\n")}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
