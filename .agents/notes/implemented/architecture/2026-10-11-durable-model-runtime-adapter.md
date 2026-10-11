# Agent Note: durable model runtime adapter

Status: implemented

## Problem

`coding-agent` owns the complete provider runtime: model catalogs, credential state, OAuth, provider composition, and request execution. Passing that class directly into durable made the boundary structural rather than explicit, so durable could accidentally become coupled to product-shell capabilities as its calls evolved.

## Decision

`packages/coding-agent/src/experimental/model-runtime-adapter.ts` now creates the durable model port at the composition root. The former durable-local path remains a small re-export for source compatibility. The adapter exposes only `getModel`, `streamSimple`, `completeSimple`, `fetchDeferred`, and `cancelDeferred`, matching `@ny4n/ai/contracts`.

`openDurable()`, vacation, and the session worker keep the full `ModelRuntime` for product-shell concerns such as model selection and availability snapshots, while each `Harness.open()` receives only the narrow adapter. Durable therefore depends on the provider-neutral contract and cannot acquire catalog or authentication ownership through these integration points.

## Alternatives considered

**Pass the full provider runtime directly.** Rejected because structural assignability would hide an expanding dependency surface.

**Move provider composition into durable.** Rejected because durable should own persistence and recovery semantics, not credentials, OAuth, provider catalogs, or host-specific composition.

**Create a generic adapter in the AI package.** Rejected because the adapter joins a product-shell implementation to a durable consumer; keeping it in `coding-agent` makes the ownership direction visible.

## Consequences

The durable integration has an explicit, reviewable port. The coding-agent shell still owns provider selection and availability presentation, and durable request/recovery behavior is unchanged. Future durable model needs must be added deliberately to the stable contract and adapter rather than appearing through the full runtime class.

## Verification

Passed: focused Biome checks, targeted coding-agent tests, `npm run typecheck`, `npm run check`, `npm run build`, and `git diff --check`.
