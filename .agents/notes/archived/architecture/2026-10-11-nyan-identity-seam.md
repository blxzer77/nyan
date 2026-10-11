# Agent Note: Nyan identity seam

Status: implemented — archived; superseded by [Pi-to-Nyan productization](../../implemented/architecture/2026-10-11-nyan-productization.md), which removes the legacy Pi names this note kept as compatibility values

## Problem

The product shell had identity values embedded in `config.ts`: the display title, CLI compatibility name, and `.pi` directory were coupled. A later rename would therefore mix user-visible branding with command, path, and persisted-data compatibility.

## Decision

`packages/coding-agent/src/identity.ts` is now the product shell's identity owner. It defines the canonical Nyan CLI/display identity and the legacy Pi CLI/config-directory values. `config.ts` resolves package-level overrides through this seam:

- the interactive title uses `Nyan` by default;
- the current `pi` command remains the compatibility CLI name;
- `.pi` remains the compatibility config directory;
- package overrides continue to work through the existing `piConfig` shape.

The seam is exported from the coding-agent package entry for future CLI, package, and migration work. No package name, binary declaration, environment variable, persisted document kind, or URL was renamed in this step.

## Alternatives considered

**Rename the binary, package scope, and config directory together now.** Rejected because those are separate compatibility surfaces and the repository does not yet have versioned readers, aliases, and recovery fixtures for them.

**Keep identity constants in `config.ts`.** Rejected because future product-facing code would continue adding Pi-specific literals to a file that also owns path and install detection.

**Add a new identity module without routing any current behavior through it.** Rejected because that would create a decorative seam. The default display title now resolves through the new owner while compatibility values remain explicit.

## Consequences

New product-facing code has one identity source and can distinguish canonical Nyan values from compatibility inputs. Existing command and config-path behavior remains usable. The package and data migration still require a later versioned batch.

## Verification

Passed: `npm run typecheck`, `npm run check`, `npm run build`, `npx vitest --run` in `packages/durable`, and `git diff --check`.
