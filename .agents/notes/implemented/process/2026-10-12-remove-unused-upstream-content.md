# Agent Note: Remove upstream content Nyan does not use

Status: implemented

## Problem

The Pi v1.1.0 tree carried artifacts that only make sense inside the upstream project: its release history, links to its issue tracker, data migrations from its older layouts, its author's analysis scripts and planning notes, a third-party GPL game, two packages nothing consumed, and a hosted gateway product. Keeping them costs review time, makes `rg pi` noisy, and for the gateway sends users toward a service Nyan does not operate.

## Decision

Delete what no Nyan source path reaches. Git history keeps all of it, and each group is its own commit so any of it can be reverted.

| Removed | Why it is safe |
| --- | --- |
| Every `CHANGELOG.md` and its packaging entries | Pi's release history up to v1.1.0. The coding agent now has a Nyan changelog that starts at 1.0.0; see [the changelog note](2026-10-12-coding-agent-changelog.md) |
| Links to upstream issues and pull requests in comments and docs | They point at a tracker Nyan does not own; the surrounding comment still states the reason |
| `migrations.ts`, its call sites, and the tests that exercised only it | Migrated Pi's older auth, session, keybinding and header layouts; Nyan has no older layout |
| `scripts/` analysis tools (stats, cost, tool and read/edit stats, session transcripts, WSL repro, import rewriting) and `migrate-sessions.sh` | Written for the upstream author's session logs; unreferenced |
| `chord/PLANNING.md`, `durable/docs/pico-v5-handoff.md` | Upstream planning and port notes |
| `examples/extensions/doom-overlay` | Third-party GPL source plus a wasm binary shipped as an example |
| The Bun standalone binary (restored the same day as a release asset; see [Bun standalone binaries](2026-10-12-bun-standalone-binaries.md)): `build:binary`, `copy-binary-assets`, `src/bun/`, the `bun-binary` install method and its asset, worker, Photon and update branches | Nyan is distributed through npm only and its releases carry no binary, so the update hint pointed at downloads that do not exist. `@ny4n/ai/bun-oauth` and the Bun sandbox environment fallback in `@ny4n/ai` stay: they are public library behavior for applications that compile `@ny4n/ai` themselves |
| `CONTRIBUTING.md` | The root `AGENTS.md` holds the repository rules; a second copy drifted from it |
| `packages/env` (remote execution client and Rust daemon) and `packages/evals` (Pi documentation evals) | No workspace package or source path imports either; removing them also removes the Rust toolchain from CI |
| The Radius cluster: provider, OAuth flow, `nyan-messages` API, login selector, MCP offer, bug-report upload, experimental relay transport and `--auth-token` options | A hosted gateway product of the upstream company; the code could only talk to a gateway Nyan does not run |
| Package `author` fields naming Pi's authors | Replaced by `Nyan`. `LICENSE` keeps the original copyright notice, which the MIT license requires |

Kept on purpose: `LICENSE`, `.agents/upstream/pi-v1.1.0.json` (provenance), the optional features that call a service only when the operator configures one (installer API, share viewer, model catalog overlay, MCP client metadata), and the extension, MCP, durable and experimental code that Nyan sources reach.

Recorded consequences for tests: `radius`, `nyan-messages`, relay, migration and the credential-refresh regression for Radius are deleted with their code; `session-share` falls back to a gist only; `/bug` writes a zip only.

## Alternatives considered

**Keep the Radius cluster and only neutralize its host.** Done first (see [no default hosted services](../architecture/2026-10-11-no-default-hosted-services.md)); the follow-up removal was chosen because a provider, relay and login flow with no gateway behind them is dead code that still has to compile, be tested and be documented.

**Delete the optional hosted-service clients too.** Not done: they contain no upstream address, are off by default, and a future Nyan service could use them. They are listed in the hosted services note.

**Rewrite history to drop the files.** Rejected: provenance matters more than a smaller repository.

## Consequences

Twelve workspace packages remain. `rg` for Pi-specific vocabulary returns provenance only. A fork that wants remote execution environments or the evaluation harness restores `packages/env` or `packages/evals` from the commit before this change.

## Verification

`npm run check`, `npm run build:offline` and the `ai`, `durable` and `coding-agent` suites. The failures left at the time were the Windows baseline recorded in the productization note; they were fixed afterwards, and the full suite now passes on Windows and in CI on Ubuntu.
