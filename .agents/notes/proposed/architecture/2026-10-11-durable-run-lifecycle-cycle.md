# Agent Note: Break the durable run-lifecycle import cycle

Status: proposed

## Problem

Five files in `packages/durable/src/harness` import one another at evaluation time: `compaction.ts`, `generation.ts`, `live.ts`, `submissions.ts` and `tool.ts`. The cycle is the code shape of a real mutual recursion in the run lifecycle:

- `generation` creates compactions and tool tasks and appends tool results;
- a `compaction` admits a submission when it finishes (`admitSubmission`);
- a `submission` starts a run (`startRun`, which lives in `generation`);
- `live` converts an interrupted partial through `generation.convertPartial` while `generation`, `compaction` and `tool` all update live state.

The architecture check records this cycle in `layers.json` because splitting it moves code across the commit and recovery boundaries of an in-flight run. A mechanical extraction can change which operations commit in the same transaction, so a clean-looking move could change crash-recovery behavior.

## Proposal

Introduce a run-control port owned by a lower module (for example `harness/run-control.ts`) that exposes only `startRun` and `convertPartial` as function types. `submissions` and `live` depend on the port; `generation` provides the implementation when the harness is assembled. `compaction` receives `admitSubmission` through the same assembly step instead of importing `submissions`.

Before moving any code, write the lifecycle down: which transaction each call runs in, what state the call may observe, and what a restart between the two calls leaves behind.

## Alternatives considered

**Leave the cycle.** Acceptable while the baseline is stable; the check prevents it from growing. It keeps four files unable to be tested without the other three.

**Merge the five files.** Removes the cycle by making one large module; it hides the lifecycle instead of stating it.

## Acceptance criteria

- `cycles.known` in `docs/architecture/layers.json` no longer lists the `durable` harness files and `npm run check:architecture` passes.
- The `durable` test suite passes with no change in the number of passed tests, including the crash-recovery, compaction and submission tests.
- A new test fixes the order of commits across `generation`, `compaction` and `submissions` for one run, and fails if the order changes.

## Risks

The port can become a second place that decides when a run starts; keep the decision in `generation`. Reordering imports can change module initialization order for `LiveDoc` definitions; the test suite plus a restart test covers it.
