# Nyan current-state architecture

**Snapshot date:** 2026-10-12  
**Source baseline:** Pi Agent v1.1.0, commit `abe508e1b89912adde45528136c3221eb69acdd7` (record: [`.agents/upstream/pi-v1.1.0.json`](../../.agents/upstream/pi-v1.1.0.json)), synced to upstream `cdaf6c227` ([record](../../.agents/upstream/pi-sync-1-cdaf6c227.json))  
**Evidence status:** measured on the working tree with the commands below, on Windows 11 with Node 24. The `Nyan CI` workflow runs on every push to `main` and has succeeded on each so far: Ubuntu build, check and the full test suite, Windows build and check, the dependency audit and MCP conformance. Release 1.0.0 was published from tag `nyan-v1.0.0` by the release workflow, and the published `@ny4n/coding-agent@1.0.0` was installed from the registry into an empty directory and run on Windows. Nothing has been run by hand on macOS or Linux; the workflows built the native modules there.

This document states current behavior. Decisions and their reasons are in [`.agents/notes/`](../../.agents/notes/); the enforced policy is [`layers.json`](layers.json).

## Evidence

```text
npm run check               lint, typecheck, pinned/runtime deps, relative imports, architecture,
                            entry-graph budgets, install lock, browser smoke
npm run build:offline       clean dist for all packages
node scripts/check-architecture-layers.mjs    layers, stability, entries, module layers, cycles
```

`npm test` passes on Windows: every package suite reports no failures (`coding-agent` 2677 passed, `ai` 1303, `durable` 1145 in each of its two runs, `codemode` 176, `tui` and the root script tests included). Tests that cannot apply on Windows are skipped with a stated reason in the test file: the Unix-domain-socket transport (the client rejects it and the listener publishes sockets with `link(2)`), Ctrl-Z suspend, file permission bits, and two checks that need a home directory with no `.agents/skills` above the temp dir. `ai` skips 865 live-provider tests that need credentials.

## Repository shape

```text
.agents/       governance: notes (lifecycle), skills, upstream source record
.github/       CI
.husky/        local Git hooks
docs/          current-state documentation and the layer policy
packages/      12 workspace packages (Node/TypeScript)
scripts/       workspace checks and build helpers
```

The root `build` is an explicit sequence, not a graph scheduler:

```text
chord -> tui -> telemetry -> codemode -> mcp -> ai -> durable
      -> agent -> protocol -> client -> server -> coding-agent
```

## Packages, layers and stability

Instability `I = Ce / (Ca + Ce)` is computed by the architecture check from source imports; every dependency edge runs to an equal or lower value. Twelve packages remain; `env` and `evals` were removed as unused.

| Layer | Package | Responsibility | Depends on | I |
| --- | --- | --- | --- | --- |
| foundation | `@ny4n/chord` | Composition runtime, services, replicated state, RPC, plugins | — | 0.00 |
| foundation | `@ny4n/telemetry` | Vendor-neutral telemetry contracts | — | 0.00 |
| capabilities | `@ny4n/tui` | Terminal rendering and input widgets | — | 0.00 |
| capabilities | `@ny4n/codemode` | QuickJS/WASI tool sandbox | — | 0.00 |
| capabilities | `@ny4n/mcp` | MCP client, OAuth, testing helpers | — | 0.00 |
| model | `@ny4n/ai` | Providers, catalog, authentication, streams, cost | telemetry | 0.25 |
| agent-core | `@ny4n/agent-core` | Agent state, loop, tool calls | `ai/contracts` | 0.50 |
| durable-runtime | `@ny4n/durable` | Durable conversations, tasks, documents, storage, recovery | chord, `ai/contracts` + `ai/utils` | 0.67 |
| transport | `@ny4n/protocol` | Transport-neutral CBOR envelopes and framing | chord | 0.25 |
| transport | `@ny4n/client` | Remote-session client | chord, protocol | 0.67 |
| transport | `@ny4n/server` | Local session server and transports | chord, protocol | 0.67 |
| product-shell | `@ny4n/coding-agent` | CLI, SDK, sessions, modes, extensions, tools | chord, agent, ai, codemode, mcp, tui, durable, client, protocol, server | 1.00 |

`coding-agent` is the only composition root for the runtime layers. `@ny4n/durable` is a dev dependency of it because the `experimental/` tree that imports it is source-only and excluded from the build.

## Package entry points

- **Executable:** `nyan` (`@ny4n/coding-agent` → `dist/bundle/cli.js`). There is no `pi` alias. `@ny4n/ai` ships a separate `nyan-ai` login helper. Nyan is distributed through npm only; there is no standalone binary build. `node scripts/nyan-source.mjs` runs the CLI from the sources.
- **Library entries:** each package declares its public subpaths in `exports`; the check rejects imports outside them. Notable subpaths: `@ny4n/ai/contracts` (provider-neutral types, `ModelRuntime`, transcript and stream helpers), `@ny4n/ai/utils/*`, `@ny4n/coding-agent/{rpc-entry,client,experimental/plugin}`.
- **Stable model boundary:** `agent` and `durable` use `@ny4n/ai/contracts`; `coding-agent` hands `durable` a five-operation `ModelRuntime` port (`createDurableModelRuntime`), not the provider runtime.

## Module layers inside packages

| Package | Layers, lowest first | Notable rule |
| --- | --- | --- |
| `ai` | contracts → auth-contracts → infra / catalog → api / auth → registry → providers → facade | the contract (`types.ts`, `schemas/`, `utils/`) imports no adapter; adapters import no registry |
| `durable` | core → session / storage → harness → tools → images / testing → facade | two type-only exceptions (below); the run lifecycle has no import cycle |
| `coding-agent` | base → ui → core → extensions → modes → cli → entry | the headless `core` imports no `modes`, `cli` or terminal presentation outside `ui` |

Static runtime import cycles are forbidden and none exist (`cycles.known` is empty). The `durable` run lifecycle was untangled by [starting a task from its reference](../../.agents/notes/implemented/architecture/2026-10-11-durable-run-lifecycle-cycle.md). Recorded exceptions, all in `layers.json`:

- `durable/types.ts` and `durable/entries.ts` import harness types (type-only);
- `coding-agent/core/extensions/virtual-modules.ts` imports the package's public barrel.

## Product identity

`packages/coding-agent/src/identity.ts` owns the identity (`cliName` `nyan`, `displayName` `Nyan`, `configDirName` `.nyan`); `config.ts` derives `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME` and the `NYAN_CODING_AGENT_DIR` / `NYAN_CODING_AGENT_SESSION_DIR` variables from it, and a package may override them through `nyanConfig`.

Renamed: executable, `@ny4n/*` packages, `NYAN_*` variables, `~/.nyan/agent` and `.nyan/`, the package manifest field `nyan` and keyword `nyan-package`, `nyan.*` document, entry and wire identifiers, `nyan-messages` API id, TUI cursor marker, daemon handshake, identifiers and file names. Details and the exclusions (provenance, third parties, `Math.PI`) are in the [productization note](../../.agents/notes/implemented/architecture/2026-10-11-nyan-productization.md).

Still referring to Pi, by design: the `upstream` remote and the manifests under `.agents/upstream/`, the release link in `README.md`, and the notes that describe the fork. The changelogs and the links to upstream issues and pull requests are removed. The governance files taken verbatim from `origin/main` (`CLAUDE.md`, the per-package `AGENTS.md`, three skills) still describe the Pi layout and are not reconciled with this tree.

## External services

Nyan includes no default address for any hosted service. The installer, share viewer, model catalog and MCP client metadata are configured with `NYAN_INSTALLER_API_BASE`, `NYAN_SHARE_VIEWER_URL`, `NYAN_CATALOG_BASE_URL` and `NYAN_MCP_CLIENT_METADATA_URL`; without them the feature is off or reports the missing variable. The version check asks the npm registry for this package's `latest` (`NYAN_LATEST_VERSION_URL` / `NYAN_NPM_REGISTRY` override it). The Radius gateway, its relay and its provider, the install ping, the installer migration hint and the Earendil announcement are removed. See [no default hosted services](../../.agents/notes/implemented/architecture/2026-10-11-no-default-hosted-services.md).

## Known limits

- Version 1.0.0 of the twelve public packages is on npm under `@ny4n` (`@ny4n/coding-agent` provides the `nyan` command) and `main` on `blxzer77/nyan` is this tree. Release tags are `nyan-vX.Y.Z`; the plain `vX.Y.Z` tags are Pi's.
- The native prebuilds committed in the repository (`packages/tui/native/*/prebuilds`) predate the rename; the release workflow rebuilds them per platform and the published packages carry the rebuilt ones. Only the Windows x64 module has been exercised on a machine; the other five were built by the workflow and not run.
- Publishing needs the `NPM_TOKEN` repository secret (an npm token with publish rights to `@ny4n`). Package versions on npm cannot be replaced: a fix is a new version.
- The hosted Windows CI job builds and runs `npm run check` but not the test suite; the suite has only been run on one Windows machine.
- `npm run build` in `ai` runs `generate-models`, which fetches the public model catalogs from the network; the generator no longer includes a Radius catalog, so the aggregator lists one provider fewer than Pi v1.1.0.
- Experimental and example code stays candidate code until verified through a Nyan entry path.
