# Agent Note: Bun standalone binaries

Status: implemented

## Problem

Installing Nyan from npm needs Node.js 22.19 or newer. The owner wants releases that run without a Node installation. The Bun binary path inherited from Pi had just been removed because no release carried a binary ([remove unused upstream content](2026-10-12-remove-unused-upstream-content.md)), so the update hint pointed at downloads that did not exist.

## Decision

Restore the Bun binary path and make every release carry the binaries, so the hint and the downloads exist together.

- `packages/coding-agent/src/bun/` and the `bun-binary` branches in `config.ts`, the codemode worker, internal processes, image resizing and Photon come back unchanged from before their removal.
- `scripts/build-binaries.mjs` replaces Pi's shell script and the `build:binary` package script: one Node script cross-compiles the six targets (Linux, macOS and Windows on x64 and arm64; x64 uses Bun's baseline build) from one host, stages the assets the binary reads beside its executable (`package.json`, `README.md`, `CHANGELOG.md`, `theme/`, `assets/`, `export-html/`, `docs/`, `examples/`, the Photon wasm and the matching `packages/tui` native prebuilds), and writes `nyan-<platform>.tar.gz` (a `nyan/` folder) or `nyan-<platform>.zip` and `SHA256SUMS`.
- `release.yml` builds the binaries on Ubuntu with the native prebuilds from `native.yml`, smoke-tests linux-x64, linux-arm64, darwin-arm64 and windows-x64 on matching runners (`--help`, `--version`, and `scripts/smoke-test-codemode-binary.mjs`, which drives the codemode worker through a local mock model), and publishes to npm only after every smoke test passes. The GitHub release step uploads the archives; a re-run replaces them.

- `nyan update` in a binary updates it in place (`src/utils/binary-update.ts`): it downloads `nyan-<platform>` and `SHA256SUMS` from the release (`NYAN_RELEASE_BASE_URL`, default this repository's GitHub releases; https, or http for localhost), checks the SHA256, unpacks next to the install, checks that the package.json inside names this package at the requested version, then swaps file by file. Each file is renamed into a backup folder first, which also works for the running executable on Windows, and a failure puts the swapped files back. The install folder must carry the package.json from a release archive, so a lone copied executable is never overwritten. An older stage folder that Windows could not delete is removed at the next start.

## Alternatives considered

**Update by running an installer script.** Needs a hosted installer service, which Nyan does not run (see [no default hosted services](../architecture/2026-10-11-no-default-hosted-services.md)). The archive on the release page is the only thing the binary needs.

**Replace the whole folder in one rename.** On Windows a folder holding the running executable or a loaded native module cannot be renamed, so files are swapped one by one.

**Keep the binary out and point users at npm.** Rejected by the owner's request for a Bun-packaged release.

**Compile each target on its own runner.** Not needed: Bun cross-compiles, and the runners still execute each archive in the smoke job.

**Publish binaries from a separate workflow after npm.** Rejected: an npm release without its binaries would make the update hint wrong again; one workflow gates both.

## Consequences

The checksum comes from the same release as the archive, so it detects a damaged download but does not authenticate the release; there is no signing key. The binaries are not signed or notarized, so macOS and Windows may warn on first run (the quickstart says how to proceed). An update interrupted by a kill can leave a mix of old and new files; `nyan update --force` repairs it. The binary assets are attached after the npm packages, so a user can see a new version a few minutes before `nyan update` can fetch it; the error says so. Archives are about 32 to 46 MB each. The binary reads its assets from beside the executable, so moving `nyan` out of the extracted folder breaks themes, docs and the native helpers.

## Verification

In a Linux cloud session with Bun 1.4.2: `npm run build:offline`, then `node scripts/build-binaries.mjs` built all six archives. The extracted linux-x64 binary printed `--version` (1.0.1) and `--help`, passed the codemode smoke test, and started the interactive TUI. The other platforms were not run here; the release workflow's smoke job runs them.
