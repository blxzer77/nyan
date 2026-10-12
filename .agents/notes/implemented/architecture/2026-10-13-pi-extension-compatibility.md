# Agent Note: Pi extension compatibility

Status: implemented

## Problem

The productization removed every Pi name from Nyan, including the module aliases that let an extension written for Pi import the host ([productization](2026-10-11-nyan-productization.md)). The cost showed up as soon as the owner moved a real Pi setup to Nyan. Six of the seven installed Pi extension packages and the local extension that was tried failed to load with `Cannot find module '@earendil-works/pi-coding-agent'` (or `pi-tui`, `pi-ai`), and the packages' `pi` manifest field was ignored. Nothing in those extensions needed Pi: the host modules are the same code under other names, and a mechanical rename of imports and manifest, applied to a copy of each package, made all of them load. Each installation would have needed that conversion again after every reinstall or update, for every package the owner wants from the Pi ecosystem.

## Decision

Nyan maps two Pi names at extension load time, and nothing else (`src/core/extensions/pi-compat.ts`):

- **Imports.** `withPiAliases()` adds `@earendil-works/pi-coding-agent|pi-tui|pi-ai|pi-agent-core` and the same names under `@mariozechner/` next to the `@ny4n/*` entries, subpaths included, pointing at the identical module or file. It wraps both resolution tables of the extension loader: `VIRTUAL_MODULES` (source, the Node bundle, and the Bun binary) and the dist aliases of the unbundled Node build.
- **Manifest.** `readNyanManifest()` reads the `pi` field when a package has no `nyan` field. The `nyan` field wins when both exist.

Nyan's own code, docs, packages and persisted data keep the Nyan names. Nothing else changes: Nyan still reads no `~/.pi`, `.pi/`, `PI_*`, `piConfig`, or Pi session identifiers, and has no `pi` executable.

## Alternatives considered

**Export `PI_CODING_AGENT_DIR` and `PI_PACKAGE_DIR` to extensions as well.** Rejected for now. It would let extensions that find the agent directory themselves (`pi-mcp-adapter`) read `~/.nyan/agent`, but environment variables cannot be scoped to the extension: the `bash` tool's child processes would inherit them, and Nyan would start to define `PI_*` as an interface. Revisit if more extensions need it.

**A conversion command that rewrites Pi packages into Nyan form.** Rejected as the main path. It leaves the original package untouched on the registry, so every install and update needs the conversion again, and it patches third-party code. It stays available as a manual option for an extension the mapping does not cover.

**Keep refusing Pi extensions.** This was the earlier decision. It protected the rule that Nyan has one identity, but the price was that a user could not use the extensions they already had.

## Consequences

An extension that only uses the host API loads as it is. An extension that locates the agent directory itself keeps using Pi's: unconverted `pi-mcp-adapter` computes `~/.pi/agent` (checked), and so would any extension that joins `.pi` or reads `piConfig` or `PI_*`. The Pi API can also differ from Nyan's wherever Nyan changed it; loading an extension does not show that it behaves correctly. A host module that Nyan renames or removes now has two names to keep consistent, which `withPiAliases` does by construction, since the Pi names are derived from the Nyan list.

The AGENTS.md rule changed from "do not add Pi compatibility" to "the mapping at load time, nothing wider". A change that adds a Pi directory, variable, or command name needs a new note.

## Verification

- `test/pi-compat.test.ts` (12 tests): the specifier mapping, that every Pi name resolves to the identical module as its Nyan name in `VIRTUAL_MODULES`, the manifest fallback and precedence, and loading real extension files (one file, and a package with only a `pi` field) through the loader. With the aliases removed three of them fail, and with the manifest fallback removed three others fail.
- On Windows, the seven entry points of the owner's installed Pi extensions (`pi-open-tui`, `rpiv-ask-user-question`, `rpiv-i18n`, `pi-btw`, `pi-mcp-adapter`, `pi-cliproxyapi`, and a local `tailscale-model-services.ts`) were loaded unmodified from `~/.pi` with the new Node bundle and with a Bun binary compiled from the same tree. All seven loaded in both. The released 1.1.0 binary, used as a control, failed on six of them.
- Not verified: the behavior of those extensions after loading (interactive UI, dialogs, MCP connections), and the unbundled Node alias table (`getAliases`) was not exercised separately; it is built from the same helper.
