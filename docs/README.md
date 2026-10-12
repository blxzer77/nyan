# Nyan Documentation

This directory contains current, reviewable product facts and navigation for the Nyan repository. It does not replace package documentation, repository rules, or durable decision records.

## Fact ownership

| Fact | Owner | What belongs there |
| --- | --- | --- |
| Repository rules and current workflow | [`AGENTS.md`](../AGENTS.md) | Applicable instructions, evidence levels, release and contribution constraints |
| Governance and reusable workflows | [`.agents/`](../.agents/) | Agent Notes, skills, upstream source records, and maintenance procedures |
| Package API and package behavior | Each package `README.md`, source exports, and tests | Public entry points, supported behavior, package-specific examples |
| Current cross-package architecture | [`architecture/current-state.md`](architecture/current-state.md) | A dated inventory of ownership, dependency direction, entry points, and naming debt |
| Functional layer policy | [`architecture/layers.json`](architecture/layers.json) | Versioned package-to-layer map enforced by the architecture check |
| Decisions that affect future work | [`.agents/notes/`](../.agents/notes/) | Rationale, alternatives, consequences, and acceptance evidence |
| Release history | [`packages/coding-agent/CHANGELOG.md`](../packages/coding-agent/CHANGELOG.md), and GitHub releases (`nyan-vX.Y.Z` tags) | User-visible changes per release, shown by `/changelog`; the GitHub release notes list the merged pull requests |

When two documents disagree, update the fact owner first and then update derived navigation. Do not turn a proposed design into current-state documentation. Proposed changes live in [`.agents/notes/proposed/`](../.agents/notes/proposed/) until their acceptance criteria are implemented and verified.

## Architecture

- [Current-state architecture and rename status](architecture/current-state.md)
- [Implemented stable model runtime boundary](../.agents/notes/implemented/architecture/2026-10-11-stable-model-runtime-boundary.md)
- [Implemented durable model runtime adapter](../.agents/notes/implemented/architecture/2026-10-11-durable-model-runtime-adapter.md)
- [Implemented functional layers and stable-dependency rules](../.agents/notes/implemented/architecture/2026-10-11-nyan-layered-architecture.md)
- [Implemented Pi-to-Nyan productization](../.agents/notes/implemented/architecture/2026-10-11-nyan-productization.md)
- [Implemented HTTP on Bun uses the native fetch](../.agents/notes/implemented/architecture/2026-10-13-bun-native-fetch.md)
- [Implemented Pi extension compatibility](../.agents/notes/implemented/architecture/2026-10-13-pi-extension-compatibility.md)
- [Implemented no default hosted services](../.agents/notes/implemented/architecture/2026-10-11-no-default-hosted-services.md)
- [Implemented durable run-lifecycle cycle](../.agents/notes/implemented/architecture/2026-10-11-durable-run-lifecycle-cycle.md)
- [Implemented removal of unused upstream content](../.agents/notes/implemented/process/2026-10-12-remove-unused-upstream-content.md)
- [Implemented release pipeline](../.agents/notes/implemented/process/2026-10-12-release-pipeline.md)
- [Implemented rename-aware upstream sync](../.agents/notes/implemented/process/2026-10-12-rename-aware-upstream-sync.md)
- [Implemented coding-agent changelog](../.agents/notes/implemented/process/2026-10-12-coding-agent-changelog.md)
- [Implemented initialization boundary and Pi baseline](../.agents/notes/implemented/process/2026-10-11-nyan-initialization.md)

Superseded decisions are frozen under [`.agents/notes/archived/`](../.agents/notes/archived/).
