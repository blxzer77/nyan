#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapshotDir = join(repoRoot, ".ci", "model-data");
const destinationDir = join(repoRoot, "packages", "ai", "src", "providers", "data");
const lockPath = join(repoRoot, ".ci", "model-data.lock.json");

function usage() {
	console.log(`Usage: node scripts/ci-model-data.mjs [--restore|--verify|--write-lock]`);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotFiles(directory) {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(`Model-data snapshot directory does not exist: ${directory}`);
	}

	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile()) continue;
		const path = join(directory, entry.name);
		files.push({ file: entry.name, sha256: sha256File(path) });
	}
	if (!files.some((entry) => entry.file === ".manifest.json")) {
		throw new Error(`Model-data snapshot is missing ${join(directory, ".manifest.json")}`);
	}
	return files;
}

function snapshotHash(files) {
	const hash = createHash("sha256");
	for (const entry of files) hash.update(`${entry.file}\0${entry.sha256}\n`);
	return hash.digest("hex");
}

function readLock() {
	if (!existsSync(lockPath)) throw new Error(`Missing model-data lock: ${lockPath}`);
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	if (lock.schemaVersion !== 1 || typeof lock.snapshotHash !== "string") {
		throw new Error(`Invalid model-data lock: ${lockPath}`);
	}
	return lock;
}

function inspectSnapshot(directory, expectedLock) {
	const files = snapshotFiles(directory);
	const actualHash = snapshotHash(files);
	if (expectedLock && actualHash !== expectedLock.snapshotHash) {
		throw new Error(`Model-data snapshot hash mismatch: expected ${expectedLock.snapshotHash}, got ${actualHash}`);
	}

	const manifest = JSON.parse(readFileSync(join(directory, ".manifest.json"), "utf8"));
	if (manifest.schemaVersion !== 6) {
		throw new Error(`Unsupported model-data manifest schema: ${manifest.schemaVersion}`);
	}
	return { files, snapshotHash: actualHash, manifest };
}

function validateInstalled() {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", join(repoRoot, "packages", "ai", "scripts", "check-model-data.ts")], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function restore() {
	const lock = readLock();
	inspectSnapshot(snapshotDir, lock);
	rmSync(destinationDir, { recursive: true, force: true });
	mkdirSync(destinationDir, { recursive: true });
	cpSync(snapshotDir, destinationDir, { recursive: true });
	validateInstalled();
	console.log(`Restored fixed model-data snapshot ${lock.snapshot} (${lock.snapshotHash}).`);
}

function writeLock() {
	const files = snapshotFiles(snapshotDir);
	const manifest = JSON.parse(readFileSync(join(snapshotDir, ".manifest.json"), "utf8"));
	const lock = {
		schemaVersion: 1,
		snapshot: process.env.NYAN_MODEL_DATA_SNAPSHOT ?? "local",
		generatedAt: manifest.generatedAt,
		source: process.env.NYAN_MODEL_DATA_SOURCE ?? "repository snapshot",
		snapshotHash: snapshotHash(files),
		manifestHash: sha256File(join(snapshotDir, ".manifest.json")),
		files,
	};
	writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
	console.log(`Wrote ${relative(repoRoot, lockPath)} for snapshot ${lock.snapshot}.`);
}

const command = process.argv[2] ?? "--restore";
if (!["--restore", "--verify", "--write-lock", "--help", "-h"].includes(command)) {
	usage();
	process.exit(2);
}
if (command === "--help" || command === "-h") {
	usage();
	process.exit(0);
}
if (command === "--write-lock") writeLock();
else if (command === "--verify") {
	inspectSnapshot(snapshotDir, readLock());
	if (existsSync(destinationDir)) validateInstalled();
	console.log("Fixed model-data snapshot is valid.");
} else restore();
