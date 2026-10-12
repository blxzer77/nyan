# packages/durable

`@ny4n/durable`: the durable conversation, task, and document runtime. State is committed to storage before it is shown, so reopening storage resumes interrupted work. Experimental: the API changes without notice.

- [`docs/spec.md`](docs/spec.md) is the normative specification. Read the sections that cover the code you change, and update the spec in the same change when behavior changes.
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md) describes how this package uses `packages/chord`.
- `npm test` runs the suite twice: once normally and once with `NYAN_DURABLE_DOCUMENT_RETENTION_MS=0` (through `scripts/test-without-document-retention.mjs`), which evicts every unattached document right after use. A change to document caching or retention must pass both. For one file, set `NYAN_DURABLE_DOCUMENT_RETENTION_MS=0` in the environment of the vitest command.
- Module layers: `core -> session -> storage -> harness -> tools -> images -> testing -> facade` (`docs/architecture/layers.json`). From `@ny4n/ai` only `@ny4n/ai/contracts` and `@ny4n/ai/utils/*` are allowed.
- To start a task, pass its `TaskReference` to `Tx.createTask()` instead of importing the module that implements it; `src/harness/run.ts` holds the run-lifecycle references. This is what keeps the harness free of import cycles; see [the note](../../.agents/notes/implemented/architecture/2026-10-11-durable-run-lifecycle-cycle.md).
- `scripts/check-entry-graphs.mjs` caps the number of files reachable from the package entry. If a change has to raise the cap, say why in the same change.
