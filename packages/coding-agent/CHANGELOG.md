# Changelog

User-visible changes to `@ny4n/coding-agent`, the `nyan` CLI. `/changelog` shows this file, and Nyan shows the new sections once after an update. Releases are tagged `nyan-vX.Y.Z`.

## [Unreleased]

### Added

- Extensions and packages written for Pi load as they are. Imports of `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai` and `pi-agent-core` (and the same names under `@mariozechner/`) resolve to Nyan's host modules, and a package's `pi` manifest field is read when it has no `nyan` field. Nyan still does not read `~/.pi` or `PI_*` variables, so an extension that locates the agent directory itself keeps using Pi's. See [Packages and extensions written for Pi](docs/packages.md#packages-and-extensions-written-for-pi).

### Fixed

- In the standalone executable, `httpIdleTimeoutMs` takes effect. Before, a response that stalled before its headers or in the middle of its body was never given up on, whatever the setting. Proxy variables were already honored by Bun's fetch; the standalone executable now uses that fetch with an idle-timeout wrapper and no longer installs undici. A plain-HTTP origin behind an HTTP proxy is requested in forward-proxy form there instead of through a CONNECT tunnel; HTTPS origins still use a tunnel.

## [1.1.0] - 2026-10-12

### Added

- Each GitHub release attaches standalone `nyan` executables built with Bun for Linux, macOS and Windows on x64 and arm64, with a `SHA256SUMS` file. They need no Node.js installation. Extract the archive and run `nyan`, or `nyan.exe` on Windows, from the extracted folder; it reads its themes, docs and native helpers from beside the executable. `nyan update` updates a binary in place: it downloads the archive for your platform from the release, checks it against `SHA256SUMS`, and replaces the files in the extracted folder. `NYAN_RELEASE_BASE_URL` points it at a mirror.

## [1.0.1] - 2026-10-12

### Fixed

- `/changelog` and the "What's New" notice after an update show Nyan's release notes again, and the changelog link in the update notice resolves.
- Links in changelog entries point at Nyan's `nyan-vX.Y.Z` release tags. They used to point at the plain `vX.Y.Z` tags, which in this repository are Pi's.

## [1.0.0] - 2026-10-12

First release of Nyan, forked from [Pi](https://github.com/earendil-works/pi) v1.1.0 and synced with Pi up to commit `cdaf6c227`.

### Breaking Changes

- The executable is `nyan` and the package is `@ny4n/coding-agent`. There is no `pi` alias.
- Environment variables use the `NYAN_` prefix, the user directory is `~/.nyan/agent`, and the project directory is `.nyan/`. Nyan does not read `~/.pi`, `.pi/`, or `PI_*`, and does not migrate Pi's data.
- Nyan packages declare their resources under a `nyan` manifest field and use the `nyan-package` keyword. Extensions import `@ny4n/*`; the `@mariozechner/pi-*` and `@earendil-works/pi-*` import aliases for Pi extensions are gone.

### Changed

- Nyan makes no request to a hosted service unless the operator configures one. The installer, the `/share` viewer, the model catalog overlay, and MCP client metadata (`clientRegistration: "cimd"`) need `NYAN_INSTALLER_API_BASE`, `NYAN_SHARE_VIEWER_URL`, `NYAN_CATALOG_BASE_URL`, or `NYAN_MCP_CLIENT_METADATA_URL`; without them the feature is off or fails with an error that names the variable. Without a viewer, `/share` prints the gist URL only.
- The version check asks the npm registry for the `latest` dist-tag of `@ny4n/coding-agent`. `NYAN_LATEST_VERSION_URL` or `NYAN_NPM_REGISTRY` redirects it, and `NYAN_SKIP_VERSION_CHECK` or `NYAN_OFFLINE` turns it off.
- `/bug` writes a local zip file and uploads nothing.
- Settings, models, keybindings, and themes have JSON schemas in `schemas/`, usable for editor validation through `$schema`.

### Removed

- The Radius gateway: its provider, login flow, MCP offer, bug-report upload, and relay transport.
- The install-reporting ping and the `/dementedelves` announcement.
- The `doom-overlay` example extension.

### Fixed

- On Windows, resource patterns written by the configuration selector use `/`, so they match.
