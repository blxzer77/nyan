# Agent Note: A Nyan changelog for the coding agent

Status: implemented

## Problem

Removing Pi's changelogs ([remove unused upstream content](2026-10-12-remove-unused-upstream-content.md)) left three user-visible features without a source. `/changelog` always answered "No changelog entries found", the "What's New" notice after an update never appeared, and the update notice linked to `packages/coding-agent/CHANGELOG.md` on GitHub, which returned 404. The link rewriting inside changelog entries also pinned repository links to `v<version>` tags, and in this repository those are Pi's tags.

## Decision

`packages/coding-agent/CHANGELOG.md` is Nyan's changelog, starting at 1.0.0, and the package ships it. It is the only changelog; the other packages have none.

- Entries go under `## [Unreleased]` in `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, or `### Removed`, written for someone who uses `nyan`. The root AGENTS.md states the rules.
- `npm run version:set -- X.Y.Z` moves the Unreleased entries under `## [X.Y.Z] - <date>` and leaves an empty Unreleased section (`scripts/changelog-release.mjs`). It refuses a release with no entries. A pre-release version leaves the changelog alone, so the entries stay unreleased until the final version.
- The release workflow runs `node scripts/changelog-release.mjs --check <version>` for a release tag and stops before building if the version has no section.
- `releaseTag()` in `src/utils/changelog.ts` turns a version into `nyan-vX.Y.Z`; changelog links are pinned to that tag.

## Alternatives considered

**Point the features at GitHub Releases and delete the changelog code.** No file to maintain, but `/changelog` and the post-update notice would only print a link, and the generated release notes list pull requests, not what a user notices.

**Fix only the 404 link.** Leaves `/changelog` and "What's New" permanently empty while still shipping their code and the `collapseChangelog` setting.

**One changelog per package, as Pi had.** The libraries have no users who read a changelog inside the CLI, and each file would need the same release discipline.

## Consequences

Every user-visible change to the CLI needs a changelog entry, and a release cannot be cut without one. Upstream syncs never take Pi's changelog edits; the user-visible part of an upstream change is written into this changelog by hand (see the [upstream sync skill](../../../skills/nyan-upstream-sync/SKILL.md)).

## Verification

`scripts/changelog-release.test.mjs` covers moving the entries, idempotence, CRLF files, an empty Unreleased section, a missing section, and the `--check` exit codes. `test/changelog.test.ts` covers the `nyan-v` tag. `npm pack --dry-run` of `@ny4n/coding-agent` lists `CHANGELOG.md`.
