#!/usr/bin/env node

/**
 * Update a copy of an extracted release binary from a local mock release, then check that the replaced binary runs.
 *
 *   node scripts/smoke-test-binary-update.mjs <path to the extracted nyan binary> <platform, e.g. linux-x64>
 *
 * The mock release is the same folder with a higher version in package.json, packed the way scripts/build-binaries.mjs
 * packs it, served from 127.0.0.1 together with a release feed and SHA256SUMS. The binary updates itself from there with
 * `nyan update --self`, so the run covers what a user does: on Windows it replaces the executable that is running.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const NEW_VERSION = "99.0.0";
const TIMEOUT_MS = 120_000;

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})\n${result.stderr}`);
	}
	return result.stdout;
}

function pack(platform, releaseRoot, archivePath) {
	if (platform.startsWith("windows-")) {
		// Git Bash puts GNU tar first on PATH, which cannot write zip files; Windows ships bsdtar.
		run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", archivePath, "-C", releaseRoot, "."]);
	} else {
		run("tar", ["-czf", archivePath, "-C", dirname(releaseRoot), basename(releaseRoot)]);
	}
}

function runBinary(binary, args, env, cwd) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${binary} ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolveRun({ code, stdout, stderr });
		});
	});
}

async function main() {
	const [binaryArg, platform] = process.argv.slice(2);
	if (!binaryArg || !platform || process.argv.length !== 4) {
		throw new Error("Usage: node scripts/smoke-test-binary-update.mjs <nyan-binary> <platform>");
	}
	const sourceBinary = resolve(binaryArg);
	const exeName = basename(sourceBinary);
	const work = mkdtempSync(join(tmpdir(), "nyan-binary-update-smoke-"));
	let server;
	try {
		// The copy that updates itself, and the release that replaces it.
		const install = join(work, "install");
		cpSync(dirname(sourceBinary), install, { recursive: true });
		const releaseRoot = join(work, "release", "nyan");
		cpSync(dirname(sourceBinary), releaseRoot, { recursive: true });
		const packageJsonPath = join(releaseRoot, "package.json");
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		const oldVersion = JSON.parse(readFileSync(join(install, "package.json"), "utf8")).version;
		manifest.version = NEW_VERSION;
		writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const asset = `nyan-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`;
		const archivePath = join(work, asset);
		pack(platform, releaseRoot, archivePath);
		const archive = readFileSync(archivePath);
		const sums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`;

		const requests = [];
		server = createServer((request, response) => {
			requests.push(request.url);
			const routes = {
				"/latest": ["application/json", JSON.stringify({ version: NEW_VERSION })],
				[`/download/nyan-v${NEW_VERSION}/${asset}`]: ["application/octet-stream", archive],
				[`/download/nyan-v${NEW_VERSION}/SHA256SUMS`]: ["text/plain", sums],
			};
			const route = routes[request.url ?? ""];
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": route[0], "content-length": Buffer.byteLength(route[1]) }).end(route[1]);
		});
		await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const origin = `http://127.0.0.1:${server.address().port}`;

		const home = join(work, "home");
		const cwd = join(work, "cwd");
		mkdirSync(home);
		mkdirSync(cwd);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NYAN_CODING_AGENT_DIR: join(work, "agent"),
			NYAN_LATEST_VERSION_URL: `${origin}/latest`,
			NYAN_RELEASE_BASE_URL: `${origin}/download`,
		};
		delete env.NYAN_OFFLINE;
		delete env.NYAN_SKIP_VERSION_CHECK;

		const installedBinary = join(install, exeName);
		const before = await runBinary(installedBinary, ["--version"], env, cwd);
		if (before.code !== 0 || before.stdout.trim() !== oldVersion) {
			throw new Error(`Before the update --version printed ${JSON.stringify(before.stdout.trim())}, expected ${oldVersion}\n${before.stderr}`);
		}

		const update = await runBinary(installedBinary, ["update", "--self"], env, cwd);
		if (update.code !== 0 || !update.stdout.includes(`to ${NEW_VERSION}`)) {
			throw new Error(`nyan update --self failed (exit ${update.code}, requests ${JSON.stringify(requests)})\nstdout:\n${update.stdout}\nstderr:\n${update.stderr}`);
		}

		const after = await runBinary(installedBinary, ["--version"], env, cwd);
		if (after.code !== 0 || after.stdout.trim() !== NEW_VERSION) {
			throw new Error(`After the update --version printed ${JSON.stringify(after.stdout.trim())}, expected ${NEW_VERSION}\n${after.stderr}`);
		}
		// Only Windows keeps the old executable until the next start; elsewhere nothing is left behind.
		const leftovers = readdirSync(install).filter((entry) => entry.startsWith(".nyan-update"));
		if (process.platform !== "win32" && leftovers.length > 0) throw new Error(`Update left ${leftovers.join(", ")} in the install folder`);
		if (!existsSync(join(install, "docs"))) throw new Error("The update removed the docs folder");

		console.log(`NYAN_BINARY_UPDATE_SMOKE_OK ${oldVersion} -> ${NEW_VERSION} (${platform}, leftovers: ${leftovers.length})`);
	} finally {
		server?.close();
		rmSync(work, { recursive: true, force: true, maxRetries: 3 });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
