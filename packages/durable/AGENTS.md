# packages/durable

Durable conversation, task, and document runtime. State is committed to storage before it is shown, so reopening storage resumes interrupted work. Experimental: the API changes without notice.

- [`docs/spec.md`](docs/spec.md) is the normative specification. Read the sections that cover the code you change, and update the spec in the same change when behavior changes.
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md) describes how this package uses `packages/chord`.
- `npm test` runs the suite twice: once normally and once with `PI_DURABLE_DOCUMENT_RETENTION_MS=0`, which evicts every unattached document right after use. A change to document caching or retention must pass both. Run the evicting variant of one file with `PI_DURABLE_DOCUMENT_RETENTION_MS=0` before the vitest command.
- Remote execution environments live in `packages/env`, which has its own `docs/`.
