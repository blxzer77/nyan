# Agent Note: Stable model runtime boundary

Status: implemented

## Problem

The first layer guard identified `packages/agent` and `packages/durable` as consumers of the full `@nyan/ai` package root. That root also owns provider catalogs, credential stores, OAuth flows, API adapters, and compatibility exports. Letting runtime layers import it directly makes provider implementation details part of their source boundary and makes future package or provider changes harder to contain.

## Decision

Nyan now exposes `@nyan/ai/contracts` as the provider-neutral integration entry point. It contains shared message, tool, transcript, stream, and model types plus the narrow `ModelRuntime` interface required by durable execution:

- resolve a model by provider and ID;
- stream or complete a simple request;
- fetch a deferred response;
- cancel a deferred response.

`packages/agent` and the durable runtime import shared types through `@nyan/ai/contracts`. Durable runtime-only helpers stay on explicit `@nyan/ai/utils/*` subpaths; they are allowed by the layer map because routing them through the aggregate contracts entry would expand the durable public entry graph beyond its budget. A host may continue to pass the full `Models` collection because it structurally satisfies `ModelRuntime`; provider catalogs, credentials, OAuth, and provider mutation remain outside durable's contract.

The executable layer check records both package direction and this source-import rule in [`docs/architecture/layers.json`](../../../../docs/architecture/layers.json). The root `check` command runs it.

## Alternatives considered

**Re-export every durable helper from `@nyan/ai/contracts`.** Rejected because runtime exports from the aggregate facade pulled additional utility modules into the durable public entry graph and exceeded the existing entry-graph budget.

**Keep importing `Models` from the package root.** Rejected because it exposes provider catalog and auth ownership to durable callers and makes the layer boundary descriptive rather than enforceable.

**Create a new package immediately for all AI contracts.** Deferred. The current subpath establishes an executable seam without moving files or changing package names; a separate package can be introduced once the ownership split and compatibility window are proven.

## Consequences

The durable API accepts a smaller capability contract while remaining compatible with the existing `Models` implementation. New provider features do not become durable dependencies unless they are added deliberately to `ModelRuntime`. This is a boundary change only. It is enforced by the `entryRules` and module layers in [`layers.json`](../../../../docs/architecture/layers.json) (see [functional layers](2026-10-11-nyan-layered-architecture.md)); the later [productization](2026-10-11-nyan-productization.md) renamed the package scope without changing the boundary.

## Verification

Passed after rebuilding the AI contract output:

- `npm run check`;
- `npm run build`;
- `npm --prefix packages/durable test` — 46 files passed, 3 skipped; 970 tests passed, 7 skipped;
- `npm --prefix packages/ai run build:offline`;
- `git diff --check`.

The initial parallel Windows durable test run was invalid because it used stale `packages/ai/dist` output and amplified the resulting import failures through SQLite cleanup locks; the rerun after rebuilding `ai` is the evidence used here.
