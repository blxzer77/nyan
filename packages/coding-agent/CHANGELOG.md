# Changelog

User-visible changes to `@ny4n/coding-agent`, the `nyan` CLI. `/changelog` shows this file, and Nyan shows the new sections once after an update. Releases are tagged `nyan-vX.Y.Z`.

## [Unreleased]

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
