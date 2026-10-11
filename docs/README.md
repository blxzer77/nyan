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
| Historical release information | Package `CHANGELOG.md` files | What was true for a released version; not a source for current behavior |

When two documents disagree, update the fact owner first and then update derived navigation. Do not turn a proposed design into current-state documentation. Proposed changes live in [`.agents/notes/proposed/`](../.agents/notes/proposed/) until their acceptance criteria are implemented and verified.

## Architecture

- [Current-state architecture and rename status](architecture/current-state.md)
- [Implemented stable model runtime boundary](../.agents/notes/implemented/architecture/2026-10-11-stable-model-runtime-boundary.md)
- [Implemented durable model runtime adapter](../.agents/notes/implemented/architecture/2026-10-11-durable-model-runtime-adapter.md)
- [Implemented functional layers and stable-dependency rules](../.agents/notes/implemented/architecture/2026-10-11-nyan-layered-architecture.md)
- [Implemented Pi-to-Nyan productization](../.agents/notes/implemented/architecture/2026-10-11-nyan-productization.md)
- [Implemented no default hosted services](../.agents/notes/implemented/architecture/2026-10-11-no-default-hosted-services.md)
- [Proposed durable run-lifecycle cycle](../.agents/notes/proposed/architecture/2026-10-11-durable-run-lifecycle-cycle.md)

Superseded decisions are frozen under [`.agents/notes/archived/`](../.agents/notes/archived/).
