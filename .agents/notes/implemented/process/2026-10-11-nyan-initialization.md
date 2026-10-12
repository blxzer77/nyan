# Agent Note: Nyan initialization boundary and the Pi v1.1.0 baseline

Status: implemented

## Problem

Nyan starts as a fork of Pi v1.1.0. The Pi repository holds the runtime together with upstream organization governance, distribution channels, Nix packaging, a Pi-specific development assistant, contributor automation, and experimental code. Keeping all of it would mix Nyan's product boundary, verification entry points, and later decisions with the upstream project's. Deleting runtime packages in one step would break the real agent dependency graph.

## Decision

Nyan keeps the agent core, providers, TUI, the coding-agent CLI, protocol, client, server, MCP, codemode, durable, and the shared test infrastructure. It removes the upstream organization and release shell: the root `.pi/`, the Nix files and directory, the upstream contributor list, issue automation, Pi-specific local test launchers, and the upstream binary and environment release workflows.

The root `AGENTS.md` holds the current development rules, `.agents/notes/` holds decisions with a lifecycle, and `.agents/skills/` holds Nyan workflows for checks, review, error handling, and upstream sync. `origin` is the Nyan fork and `upstream` is the Pi repository. The baseline is Pi v1.1.0, commit `abe508e1b89912adde45528136c3221eb69acdd7`, recorded in `.agents/upstream/pi-v1.1.0.json`; later syncs add their own records there.

Initialization kept the package names, `PI_*` variables, the `pi` CLI, and the experimental source, leaving them to a separate product decision. That decision is implemented in [Pi-to-Nyan productization](../architecture/2026-10-11-nyan-productization.md). The experimental source is still in the tree and is still candidate code.

## Alternatives considered

**Copy the DeepSeek Harness `.agents/` wholesale.** Rejected: its Cordis, Python SDK, web and desktop, session snapshot, and package-layer rules do not match a Node-only monorepo forked from Pi. Only the note lifecycle, the evidence discipline, error ownership, and documentation rules were carried over.

**Delete all experimental packages, examples, and durable source.** Rejected at initialization: they could still become the source of Nyan's session, extension, and recovery implementations, and deleting them before confirming they have no consumer would hide a capability regression. Packages later confirmed unused were removed; see [remove unused upstream content](2026-10-12-remove-unused-upstream-content.md).

**Change only the README and set up no governance directory.** Rejected: upstream syncs, promoting experimental code, and recovery semantics need a stable place for decisions and evidence.

## Consequences

The working tree carries none of Pi's organization-level issue, contributor, Nix, or release automation. Initialization itself did not change the product identity; the productization note did. New capabilities must pass through a real entry point with matching evidence before they become Nyan features.

## Verification

Run and passed at initialization: `npm ci --ignore-scripts`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check`, `node --test scripts/local-package-install.test.mjs` (3/3), and `git diff --check`. The model data was generated locally with `npm run hydrate:model-data` and stays gitignored.

At that point the full `npm test` on Windows still failed on Pi v1.1.0's platform assumptions: Unix socket permissions, the environment daemon not being built, path separators, and TUI path assertions. Those were fixed later, and the suite now passes on Windows.
