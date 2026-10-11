# Agent Note: Break the durable run-lifecycle import cycle

Status: implemented

## Problem

Five files in `packages/durable/src/harness` imported one another at evaluation time: `compaction.ts`, `generation.ts`, `live.ts`, `submissions.ts` and `tool.ts`. The cycle was the code shape of a real mutual dependency in the run lifecycle:

- `generation` creates compactions and tool tasks and appends tool results;
- a conversation-owned `compaction` admits a write submission to place its summary (`admitSubmission`), atomically with its own terminal transition;
- admitting an idle input starts a run (`startRun`), which creates the generation task;
- `live` converted an interrupted partial through `generation.convertPartial` when a run task settled.

Only two of those edges were real obligations of the lower modules: `live` needed to append an assistant entry, and admission needed to create a task *of a kind implemented elsewhere*. Neither needed the code that implements the generation.

## Decision

Starting a task needs only its identity and first checkpoint, because `Tx.createTask()` reads `definition.name`, `definition.version` and `definition.initial(input)` and nothing else; the implementation is found by `name` in the registry when the task runs. Two small, behavior-preserving changes follow from that:

- **`TaskReference<I, S, R>`** (in `types.ts`, exported with the other task types) is that identity. `Tx.createTask()` has a second overload that accepts it, so a module that only starts a task need not import the module that implements it. Existing calls with a `Task` are unchanged.
- **`harness/run.ts`** owns run control: `generationTaskReference`, `startRun`, `createGeneration` and `handOver`. `GenerationTask` takes its `name`, `version` and `initial` from that reference, so the identity has one source.
- **`harness/assistant.ts`** owns appending an assistant message with its usage (`appendAssistant`) and converting an interrupted partial (`convertPartial`); both depend only on entries and the usage ledger.

`submissions.ts` imports `run.ts`; `live.ts` imports `assistant.ts`; `generation.ts` imports both. No transaction boundary moved: every call runs in the same `commit` as before, which is why the recovery behavior is unchanged.

## Alternatives considered

**Inject `startRun` into `admitSubmission`.** Rejected: the compaction task would need it through `TaskRuntime`, a public interface, or through another global.

**Place the summary after the compaction commits.** Rejected: the summary write and the terminal transition are one atomic commit today; splitting them creates a window where a restart finds a finished compaction with no summary.

**Merge the five files.** Removes the cycle by hiding the lifecycle in one large module.

## Consequences

`cycles.known` in `layers.json` is empty, and the architecture check fails if a static import cycle reappears in any package. The `durable` entry-graph budget rose from 64 to 66 files for the two new modules. `TaskReference` is a small addition to the public task types.

## Verification

The `durable` suite passes with the same counts as before the change (970 passed, 7 skipped), including the crash-recovery, compaction, submission and scheduler tests. `npm run check` passes with the cycle entry removed.
