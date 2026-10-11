# Agent Note: Pi-to-Nyan productization

Status: implemented

## Problem

The Pi v1.1.0 fork still presented as Pi everywhere a user, a script, a stored file or a wire peer could see it: the `pi` executable, `@earendil-works/pi-*` package names, `PI_*` environment variables, `~/.pi` and `.pi` directories, `pi.user`-style document and entry identifiers, `pi.dev` links and a Pi-branded README. An earlier plan staged the change (identity seam, then a `pi` compatibility alias, then packages, then data with dual readers) to protect existing installations and stored data.

That protection has no subject. Nyan has published no release, so no Nyan-written data, install or script exists. The only Pi data on a developer machine belongs to Pi, which Nyan does not manage. Keeping legacy names would keep a second product identity alive and make every future change reason about both.

## Decision

Rename everything that is product identity, once, and keep nothing that exists only to read Pi's files:

| Surface | Before | After |
| --- | --- | --- |
| Executable | `pi` | `nyan` (no `pi` alias) |
| Packages | `@earendil-works/pi-*`, `@earendil-works/chord` | `@nyan/*` (`pi-agent-core` → `@nyan/agent-core`) |
| Environment | `PI_*` | `NYAN_*`, including those derived from the CLI name |
| Directories | `~/.pi/agent`, `.pi/` | `~/.nyan/agent`, `.nyan/` |
| Package manifest | `pi` / `piConfig` fields, `pi-package` keyword | `nyan` / `nyanConfig`, `nyan-package` |
| Identifiers | `pi.user`, `pi.tool-result`, `pi.live`, `pi-messages`, TUI marker `\x1b_pi:c`, `PI-ENV` handshake | `nyan.*`, `nyan-messages`, `\x1b_nyan:c`, `NYAN-ENV` |
| Code | `Pi*` / `pi*` identifiers, `pi` extension parameter | `Nyan*` / `nyan*` |
| Files | `pi-user-agent.ts`, `pi-messages.ts`, `pi-manifest.ts`, `pi-logo.ts`, `pi-example-plugin/`, `how-pi-works.md`, `doomgeneric_pi.c` | `nyan-*` equivalents |
| Repository links | `github.com/earendil-works/pi/...` for this repository's files | `github.com/blxzer77/nyan/...` |

The product identity lives in `packages/coding-agent/src/identity.ts` (`cliName`, `displayName`, `configDirName`) and a package may still override it with `nyanConfig`.

Not renamed, on purpose:

- **Provenance.** `.agents/upstream/pi-v1.1.0.json`, the notes that describe the fork, links to upstream issues and pull requests (`github.com/earendil-works/pi/issues/...`), the `upstream` remote, and every `CHANGELOG.md` (release history of Pi up to v1.1.0).
- **Third parties.** `@earendil-works/gondolin` (a dependency) and the `mariozechner.at` source link in a comment.
- **Math.** `Math.PI`.
- **Pi-only compatibility.** The `@mariozechner/pi-*` and `@earendil-works/pi-*` module aliases that let old Pi extensions import the host (`virtual-modules`, extension loader, host-provided package list, vitest aliases) and the legacy theme symbol are deleted instead of renamed: Nyan promises no compatibility with Pi extensions, and an alias named after a package nobody publishes is dead code.
- **Native prebuilds.** The committed `.node` prebuilds and `doom.wasm` were compiled from the pre-rename sources. The native sources now use `NYAN_*` macro names and the X11 selection atom `NYAN_CLIPBOARD`; the macros leave no trace in the binaries and the atom is a private property name, so the prebuilds keep working, but they should be rebuilt on each platform before the next release.

Pi-operated hosts were not renamed to a new domain; see [no default hosted services](2026-10-11-no-default-hosted-services.md). The GitHub URLs assume the fork will be renamed to `blxzer77/nyan`; `origin` still points at `blxzer77/pi`.

## Alternatives considered

**Stage the rename with dual readers and a `pi` alias.** Rejected: it protects data and installs that do not exist and leaves two identities in every persisted format. If Nyan later needs to import a user's Pi history, that is an explicit import command, not a permanent reader.

**Replace text with a plain `s/pi/nyan/`.** Rejected: it breaks `Math.PI`, `api`, `pipe`, upstream issue links and base64 lockfile hashes. The rename is delimiter-aware (a `pi` component bounded by non-alphanumerics, or a camel-case boundary) with explicit protection for provenance spans, then reviewed by token class.

**Choose a different npm scope.** Considered; `@nyan` is the shortest honest name and the scope is one constant in the rename, so changing it later is mechanical. It has not been registered on npm.

## Consequences

Anything that used to be reached by a Pi name now fails instead of falling back: `nyan` does not read `~/.pi`, ignores `PI_*`, and does not load a package that declares only a `pi` manifest. Documentation and tests describe Nyan only; the places that still say Pi are provenance.

A text rename fails in two ways that search does not show, and both were found by running the suites against a baseline:

- **Composed names.** Regex-escaped scope (`@earendil-works\/pi-ai` in the vitest aliases, which silently stopped aliasing), scope and package as separate path segments (`"@earendil-works", "pi-coding-agent"`), a prefix test (`startsWith("@earendil-works/")` in the source runtime's alias loader), a name list mapped into a scope, and a bare label (`writeOutputFile("pi-codemode", ...)`) that a package-name rule turned into a path with a slash. Future scope renames must search for the scope string as well as the package string, and a prose rule must not touch string literals in code.
- **Same word, different meaning.** LaTeX `\pi` and the Greek-letter table in `packages/tui/src/latex.ts` were renamed to `\nyan` and `nyan: "π"`; the tests were renamed with them and still passed, so only a comparison with the unmodified source shows it. Those three files are restored byte for byte. Any future mechanical rename of a short word needs a review of the non-product senses of that word, not only a green suite.

Not done: the logo artwork. `nyan-logo.ts` and `easter-egg-3d.ts` still draw the 4×4-pixel π glyph (the text fallback now reads `Nyan`). A Nyan mark is a design decision, not a rename.

## Verification

Run on a clean `dist` after reinstalling workspace links from the on-disk casing of the directory (`D:\nyan`; links created from `D:\Nyan` made two copies of one module in Vitest and failed two durable tests that have nothing to do with the code).

- `npm run check` passes (lint, typecheck, pinned and runtime dependency checks, relative imports, architecture, entry graphs, install lock, browser smoke).
- `npm run build:offline` passes; `nyan --version` prints `1.1.0` from the built bundle.
- Every package suite was run against an unmodified `git archive` of Pi v1.1.0 built the same way, and failing tests were compared by name after applying the same rename to the baseline names:

  | Suite | Nyan (pass/fail/skip) | Pi v1.1.0 export |
  | --- | --- | --- |
  | agent | 91/0/0 | 91/0/0 |
  | chord | 344/1/0 | 344/1/0 |
  | client | 16/8/3 | 16/8/3 |
  | codemode | 74/0/0 | 74/0/0 |
  | durable | 970/0/7 | 968/2/7 |
  | env | daemon not built | daemon not built |
  | mcp | 42/0/1 | 42/0/1 |
  | protocol | 133/0/0 | 133/0/0 |
  | server | 38/6/0 | 38/6/0 |
  | telemetry | 15/0/0 | 15/0/0 |
  | ai | 1316/1/865 | 1316/1/865 |
  | coding-agent | 2670/56/55 | 2665/61/55 |
  | tui (node:test) | 1037 tests, same 3 failures | same |
  | root scripts (`npm run test:scripts`) | 23/23 | 40/41 (release-script tests were removed with the scripts) |

  The failures that remain are the Windows baseline (Unix sockets, path separators, the environment daemon not built, TUI path assertions, remote model-price drift, `chord` boundary test). No test fails only in the renamed tree. The export's 2 `durable` failures and a few of its `coding-agent` failures differ between runs and pass in isolation: timing flakes under load, since both trees were tested at the same time. A first run of the renamed tree also failed two `durable` tests only because the workspace links had been created from the mis-cased path `D:\Nyan`, which made Vitest load one module twice; relinking from `D:\nyan` fixed it.
