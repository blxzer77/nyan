# Agent Note: Functional layers with stable-dependency enforcement

Status: implemented

## Problem

The workspace has 14 packages and a 306-file product shell, and the only boundary the first guard enforced was a numeric rank between packages. Measuring the real import graph showed that this was not enough to make "dependencies point toward stability" true:

- the rank map allowed same-rank edges in both directions (`durable-runtime` and `transport` shared a rank), declared nothing about cycles, and treated every subpath of a package as public;
- `coding-agent` imported `@nyan/durable` without declaring it;
- inside `ai`, the stable contract file `types.ts` imported ten option types from the volatile `api/*` adapters, and the adapters imported the `models.ts` registry for two pure functions;
- inside `coding-agent`, the headless `core` imported terminal presentation from `modes` (22 imports) and `cli` (1), and shared presentation code was reachable only through `modes/interactive`;
- the static runtime import graph contained cycles in `chord`, `coding-agent` and `durable`.

A layer is only worth having if it forbids a dependency someone could plausibly add and the check can fail on it. Layers that merely rename a rank do not qualify.

## Decision

[`docs/architecture/layers.json`](../../../../docs/architecture/layers.json) is the policy and `scripts/check-architecture-layers.mjs` (part of `npm run check`) is its enforcement.

**Package layers.** Eight layers, each with an explicit `mayDependOn` list instead of a numeric rank. Same-layer edges must be listed in `internal`. A layer exists because it forbids something real: `foundation` has no workspace dependencies; `capabilities` (`tui`, `mcp`, `codemode`) cannot reach the model or agent stack; `model` (`ai`) depends only on foundation; `agent-core` depends only on the model contract; `durable-runtime` and `transport` are independent of each other; only `product-shell` composes them.

**Measured stability.** The check computes instability `I = Ce / (Ca + Ce)` from the actual source imports and fails any edge whose target is more unstable than its source. This is the stable-dependencies principle stated as a measurement, so it holds even for an edge the layer matrix allows. Current values: chord, telemetry, codemode, mcp, tui `0.00`; ai `0.20`; protocol `0.25`; agent, durable `0.50`; client, server `0.67`; coding-agent `0.91`; env, evals `1.00`.

**Public entries.** A workspace import must resolve to a subpath in the target's `exports`; a source import must be declared in the manifest; `entryRules` narrow specific consumers (`agent` → `@nyan/ai/contracts` only; `durable` → `contracts` and `utils`). A rule that names an unknown package is itself an error, so a rename cannot silently disable it.

**Module layers inside packages.** `ai` (contracts → auth-contracts → infra/catalog → api/auth → registry → providers → facade), `durable` (core → session/storage → harness → tools/testing) and `coding-agent` (base → ui → core → extensions → modes → cli → entry). Every file must be classified; paths may be directories, files, or `prefix*suffix` globs. Exceptions are single file edges with a recorded reason.

**Code changes the rules forced.**

- `ai`: `ApiOptionsMap`/`ApiStreamOptions` moved from `types.ts` to `api-options.ts` (the contract no longer names adapters); `calculateCost`, `clampThinkingLevel`, `getSupportedThinkingLevels`, `hasApi`, `modelsAreEqual` moved to `utils/model-operations.ts` and are re-exported from `models.ts`.
- `coding-agent`: shared terminal presentation (`theme`, `keybinding-hints`, `visual-truncate`, `diff`, `dynamic-border`, `auth-url`) moved from `modes/interactive` to `ui/`; `SourceInfo` data and synthetic-path helpers moved to `utils/source-info.ts`; `isValidThinkingLevel` and `getAuthCredential` moved into `core`; `create-agent-session.ts` split from the `sdk.ts` barrel; `@nyan/durable` declared as a dev dependency (the `experimental/` tree is source-only and excluded from the build).
- `chord`: `delta/core.ts` holds the definitions and `delta/index.ts` is a pure barrel, so `diff.ts` and `tracker.ts` no longer import their own barrel.

**Cycles.** Static runtime import cycles are forbidden. Type-only and dynamic imports are excluded because they do not create an evaluation-order cycle. One cycle is recorded rather than fixed (see Consequences).

## Alternatives considered

**Keep numeric ranks and add checks.** Rejected: ranks cannot express that two packages in the same layer are independent, and a rank hides which layer a package may not reach.

**Put `ai` contracts in a separate package now.** Deferred. The `contracts` subpath plus the `entryRules`, the module layers and the entry-graph budget already make the boundary executable; a package split adds a release unit without adding enforcement. Revisit when a second consumer needs the contract without the provider graph.

**Fix the `durable` run-lifecycle cycle together with the layering.** Rejected for this change: it alters the commit and recovery boundaries of an in-flight run, so it needs its own note and the durable crash-recovery suite. It is tracked in [the proposed note](../../proposed/architecture/2026-10-11-durable-run-lifecycle-cycle.md).

**Move tool renderers out of `core` instead of moving `ui` below it.** Rejected: tool definitions carry their renderers by design (`ToolDefinition.renderCall/renderResult`), so the renderers' presentation dependencies belong in a layer below `core`, not above it.

## Consequences

A new dependency that points upward, sideways inside a layer, toward a less stable package, around a package's exports, or into an unclassified file fails `npm run check` with the offending file and line. Adding a package, module or exception means editing `layers.json` and saying why.

Known debts, all visible in `layers.json`: the `durable` harness cycle (`compaction`, `generation`, `live`, `submissions`, `tool`), two type-only exceptions in `durable` (`types.ts` and `entries.ts` name harness types), and one `coding-agent` exception (`core/extensions/virtual-modules.ts` imports the package's public barrel). The `ai` runtime import graph is acyclic; its type-level cycles through `types.ts` were removed.

Package-internal layering is not applied to the small packages (`tui`, `mcp`, `server`, `client`, `protocol`, `agent`); their size does not justify the maintenance.

## Verification

Negative tests were run against the checker: an `agent` source file importing `@nyan/coding-agent` fails four independent rules; an `agent` import of `@nyan/ai` (not `/contracts`) fails the entry rule; a `utils/text.ts` import of `api/anthropic-messages.ts` fails the `ai` module layer rule.

Passed after the change: `npm run check` (lint, typecheck, pinned and runtime dependency checks, relative-import check, architecture, entry-graph budgets, install lock, browser smoke), `npm run build:offline`, and the per-package test suites compared against an unmodified Pi v1.1.0 export built and tested the same way (see the [productization note](2026-10-11-nyan-productization.md) for the result). The only entry-graph budget that moved is `durable` `.`: 63 → 64 files, caused by the `chord` `delta/core.ts` split.
