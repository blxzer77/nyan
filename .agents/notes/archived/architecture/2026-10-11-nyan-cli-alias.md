# Agent Note: Nyan CLI alias

Status: implemented — archived; superseded by [Pi-to-Nyan productization](../../implemented/architecture/2026-10-11-nyan-productization.md), which removes the legacy Pi names this note kept as compatibility values

## Problem

The product identity seam had a canonical Nyan name, but the published coding-agent package still exposed only the upstream `pi` executable. That left the first user-facing migration dependent on a future package rename.

## Decision

The coding-agent package now declares both `nyan` and `pi` binaries, pointing to the same bundled CLI entry. `nyan` is the additive product entrypoint; `pi` remains an explicit compatibility alias. The package scope, `.pi` config directory, environment variables, persisted identifiers, and update registry remain unchanged in this step.

The package distribution test and artifact smoke test validate both manifest entries. No separate bundle or runtime path is introduced, so the two names share the same behavior and version output.

## Alternatives considered

**Replace `pi` with `nyan` immediately.** Rejected because existing global installs and scripts would lose their executable during the package migration.

**Create a second implementation or bundle for Nyan.** Rejected because duplicate runtime artifacts could drift and would add release cost without changing behavior.

**Rename config, environment, and persisted data together with the binary.** Rejected because those surfaces need versioned readers and compatibility fixtures before their writers change.

## Consequences

New installations can use `nyan`; existing `pi` invocations continue to resolve to the same CLI. Documentation and internal display strings can migrate in a later batch after the identity display helper is separated from path and environment compatibility values.

## Verification

Passed: package distribution tests, `node --test scripts/coding-agent-smoke.test.mjs`, `npm run typecheck`, `npm run check`, `npm run build`, and `git diff --check`.
