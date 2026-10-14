# Pactile Context Governance Reference Snapshot

This directory is a **read-only reference snapshot** for planning Nyan's future Context Governance work. It is not an Nyan package, is not imported by any build, and does not mean that any copied Pactile capability is implemented in Nyan.

## Contents

- `source/pactile/`: selected Pactile context, memory, retrieval, decision, Jev, provider, runtime, and shared source.
- `source/pactile-core/context-memory/`: the related legacy/core context-memory implementation.
- `source/retrieval-worker/`: selected retrieval-worker source.
- `source/nyan-adapter-candidates/`: utility code identified during the roadmap assessment as possible migration candidates.
- `tests/`: selected Pactile and retrieval-worker tests copied as reference evidence; they are not wired into Nyan.
- `design/context-governance/`: context-governance design and implementation documents.
- `design/pactile-docs/`: additional migration and architecture documents relevant to the roadmap.
- `evidence/p0/` and `evidence/p1a/`: offline evaluation fixtures and receipts. Live provider-shadow material is intentionally excluded.
- `INDEX.md`: roadmap-item, batch, provenance, and reading-order index.
- `manifest.json`: every copied file, original local source path, category, size, and SHA-256 hash.
- `LICENSE.pactile` and `COPYRIGHT.pactile`: preserved source-project licensing notices.

The copied TypeScript and JavaScript source/test files use a `.txt` suffix so repository-wide Nyan checks cannot treat this reference snapshot as product source. Remove only that suffix when inspecting a file as standalone reference code.

## Provenance

The snapshot was assembled from the local Pactile checkout at `D:\pactile` and the local retrieval-worker checkout at `D:\MyHarness\pactile\packages\retrieval-worker`. The manifest records the source paths and hashes available at snapshot time. This is a curated extraction, not a full Pactile checkout.

## Safety and scope

The extraction deliberately excludes dependencies, build output, live provider-shadow probes and receipts, private-network endpoints, credentials, and unrelated Pactile Kernel/Task/CLI/application modules. Historical endpoint literals that are part of selected source or design text are retained only as source references; no copied file is connected to Nyan runtime configuration. Credential-shaped test literals are replaced with explicit placeholders and recorded in `manifest.json`.

Do not import these files into `packages/`, run them as Nyan code, or mark the corresponding roadmap items Done without independently verifying an Nyan entry point, persistence, recovery behavior, tests, and ownership decisions.

## License

This snapshot preserves the source project's license notices. See `LICENSE.pactile` and `COPYRIGHT.pactile`. Any future adaptation into Nyan must be reviewed separately for provenance and licensing; this reference snapshot itself does not relicense the copied source.
