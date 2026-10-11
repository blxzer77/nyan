// The delta module's public surface. Definitions live in core.ts; diff.ts and tracker.ts depend on core.ts
// directly so this barrel never sits inside an import cycle.
export * from "./core.ts";
export { diffRevisions } from "./diff.ts";
export type { Draft } from "./draft.ts";
export { type Change, type Prepared, type Tracker, track } from "./tracker.ts";
