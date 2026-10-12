# Agent Note: Bun standalone binaries

Status: implemented

## Problem

Installing Nyan from npm needs Node.js 22.19 or newer. The owner wants releases that run without a Node installation. The Bun binary path inherited from Pi had just been removed because no release carried a binary ([remove unused upstream content](2026-10-12-remove-unused-upstream-content.md)), so the update hint pointed at downloads that did not exist.

## Decision

Restore the Bun binary path and make every release carry the binaries, so the hint and the downloads exist together.

- `packages/coding-agent/src/bun/` and the `bun-binary` branches in `config.ts`, the codemode worker, internal processes, image resizing and Photon come back unchanged from before their removal.
- `scripts/build-binaries.mjs` replaces Pi's shell script and the `build:binary` package script: one Node script cross-compiles the six targets (Linux, macOS and Windows on x64 and arm64; x64 uses Bun's baseline build) from one host, stages the assets the binary reads beside its executable (`package.json`, `README.md`, `CHANGELOG.md`, `theme/`, `assets/`, `export-html/`, `docs/`, `examples/`, the Photon wasm and the matching `packages/tui` native prebuilds), and writes `nyan-<platform>.tar.gz` (a `nyan/` folder) or `nyan-<platform>.zip` and `SHA256SUMS`.
- `release.yml` builds the binaries on Ubuntu with the native prebuilds from `native.yml`, smoke-tests linux-x64, linux-arm64, darwin-arm64 and windows-x64 on matching runners (`--help`, `--version`, and `scripts/smoke-test-codemode-binary.mjs`, which drives the codemode worker through a local mock model), and publishes to npm only after every smoke test passes. The GitHub release step uploads the archives; a re-run replaces them.

## Alternatives considered

**Keep the binary out and point users at npm.** Rejected by the owner's request for a Bun-packaged release.

**Compile each target on its own runner.** Not needed: Bun cross-compiles, and the runners still execute each archive in the smoke job.

**Publish binaries from a separate workflow after npm.** Rejected: an npm release without its binaries would make the update hint wrong again; one workflow gates both.

## Consequences

A binary does not update itself; `nyan` in a binary prints the releases page instead of an update command. Archives are about 32 to 46 MB each. The binary reads its assets from beside the executable, so moving `nyan` out of the extracted folder breaks themes, docs and the native helpers.

## Verification

In a Linux cloud session with Bun 1.4.2: `npm run build:offline`, then `node scripts/build-binaries.mjs` built all six archives. The extracted linux-x64 binary printed `--version` (1.0.1) and `--help`, passed the codemode smoke test, and started the interactive TUI. The other platforms were not run here; the release workflow's smoke job runs them.
