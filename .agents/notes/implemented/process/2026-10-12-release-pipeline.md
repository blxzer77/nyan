# Agent Note: Release pipeline

Status: implemented

## Problem

The upstream release tooling (version bumping, tag-driven publishing, binary builds, announcements) was removed with the rest of the upstream shell, which left CI as a verification workflow only. Nyan needs its own path from `main` to npm, and the terminal helper modules in `packages/tui` must be built on the platforms they target. Neither could be tested with credentials here, so the pipeline has to fail safe.

## Decision

Three workflows in `.github/workflows/`, and two scripts that hold the logic so it can run locally.

- **`ci.yml`** — on every push and pull request to `main`: build, `npm run check` and `npm test` on Ubuntu; build and `npm run check` on Windows (the suite passes locally on Windows but the hosted runner has not run it, so only build and check gate there for now); a production-dependency audit (`scripts/npm-audit.mjs`); MCP conformance.
- **`native.yml`** — builds the native modules where they run: Linux x64 and arm64 on matching runners, macOS (the script cross-compiles both architectures), Windows (the script builds x64 and arm64). Reusable by the release workflow and runnable by hand.
- **`release.yml`** — on a pushed `nyan-vX.Y.Z` tag: verify (build, check, test), build the native modules, then publish. The tag must equal the package version. A pre-release suffix publishes under the `next` dist-tag. It creates a GitHub release with generated notes. A manual run defaults to a dry run.
- **`scripts/publish-packages.mjs`** — publishes the public packages in dependency order, requires one lockstep version (`--expect-version` pins it to the tag), skips versions already on the registry so a failed release can be re-run, and uses `npm publish --provenance` under GitHub Actions. `--dry-run` packs every tarball.
- **`scripts/set-version.mjs`** (`npm run version:set -- X.Y.Z`) — sets one version everywhere, then syncs internal ranges and regenerates both lockfiles.

Published tarballs carry the native binaries built by the workflow, not the ones committed to the repository; the committed prebuilds remain so a source checkout runs without a toolchain.

## Alternatives considered

**Tag as `vX.Y.Z`.** Rejected: the fork inherited all of Pi's tags, `v1.0.0` and `v1.1.0` already point at Pi's releases, and reusing a name would mean moving a tag that records where the code came from. Nyan releases use the `nyan-v` prefix. The package version is independent of Pi's, so the first Nyan release is 1.0.0.

**Publish on every merge to `main`.** Deferred. A tag makes the release an explicit act, keeps the version and the tag equal, and lets a pre-release go to `next`. A `main`-triggered pre-release job can be added once the scope is registered.

**Commit the rebuilt binaries back to the repository from CI.** Rejected: a bot commit per platform build adds history noise, and the published artifact is what users run.

**Cross-compile all natives on one runner.** Rejected for Linux and macOS system libraries; the macOS and Windows scripts already cross-compile their own architectures and use one runner each.

## Consequences

Nothing publishes until the repository has the `NPM_TOKEN` secret, a GitHub environment named `npm`, and the `@ny4n` scope on npm; until then a tag push fails at the publish step after verification, and nothing is released. `npm run release:dry` was run locally: all 12 packages pack in dependency order (telemetry, ai, agent-core, chord, protocol, client, codemode, mcp, tui, coding-agent, durable, server).

## Verification

The workflow files parse as YAML and list the intended jobs. `node scripts/publish-packages.mjs --dry-run` and `node scripts/set-version.mjs 1.1.0` (a no-op) ran locally. The workflows themselves have not run on GitHub.
