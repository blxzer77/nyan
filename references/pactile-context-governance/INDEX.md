# Pactile Context Governance Reference Index

This is a navigation index for the curated reference snapshot in this directory. It is not a Nyan status report and it does not promote any Pactile source, test, design, or evaluation asset to Nyan implementation status. The roadmap remains the status source of truth.

## Snapshot provenance

| Checkout | Commit at capture | Worktree at capture | Selected source root |
| --- | --- | --- | --- |
| Pactile | `d8d51fccef1f2f981dd2ba0ed01681bb4c64db4e` | Dirty | `D:\pactile` |
| Retrieval worker repository | `0a1dd4c350a115a3c53f9498570a8307bf438e0f` | Dirty | `D:\MyHarness\pactile\packages\retrieval-worker` |

The snapshot date recorded in `manifest.json` is `2026-10-13`. Both source checkouts had uncommitted changes, so a commit hash alone cannot reproduce every copied byte. Use the per-file SHA-256 values in `manifest.json` as the authoritative snapshot identity. The snapshot is curated rather than a full checkout.

## How to read the copied code

- Files ending in `.ts.txt` or `.js.txt` contain the selected TypeScript or JavaScript source text. Selected credential-shaped test literals are replaced with placeholders listed in `manifest.json`. Remove only the final `.txt` suffix when inspecting a file as standalone reference code.
- The suffix is deliberate: it prevents Nyan's repository-wide TypeScript checks from treating the archive as product source.
- Tests and source are reference material only. They are not wired into Nyan's test runner, package exports, build, or runtime.
- `manifest.json` contains the complete 245-file inventory, original local path, category, size, hash, and credential-placeholder redaction records.

## Recommended reading order

1. `README.md` for scope, safety exclusions, and licensing.
2. `ROADMAP.md` at the repository root for Nyan's current assessment and dependencies.
3. `design/context-governance/implementation/01-contract-draft.zh-CN.md` for the contract shape.
4. `design/context-governance/implementation/02-ownership-dependency.zh-CN.md` and `03-stage-plan.zh-CN.md` for ownership and sequencing.
5. `design/context-governance/implementation/04-evaluation-controller.zh-CN.md`, `05-writeset-rollback.zh-CN.md`, and `06-blockers.zh-CN.md` for gates and failure boundaries.
6. `design/context-governance/compression/context-unit-manifest-v1.zh-CN.md` and `compression-decision-chain-v1.zh-CN.md` for context and compression semantics.
7. `design/context-governance/retrieval/01-semantic-provider-contract.zh-CN.md` through `13-retrieval-search-service-design.zh-CN.md` for retrieval, provider, privacy, and external-evidence design.
8. The source and tests listed by the relevant batch below.

## Roadmap item map

The ranges in this table cover every numbered handoff item in the roadmap: C1-C14, G1-G8, M1-M7, H1-H8, P1-P4, R1-R21, J1-J6, T1-T6, E1-E5, and D1-D15.

| Items | Roadmap destination | Primary reference locations | Coverage boundary |
| --- | --- | --- | --- |
| C1-C2, C4, C6, C9 | CG B1; verification in B4 | `source/pactile/agent/context/`, `source/pactile/agent/memory/durability/index.ts.txt`, `source/pactile/runtime/context-governance-policy.ts.txt`, `source/pactile/shared/validation.ts.txt`; `tests/core/pactile/context-memory/` | Pactile contracts and algorithms only; no Nyan `@ny4n/context` implementation is present. |
| C3, C5, C10-C11 | CG B3 and B8; verification in B4 | `source/pactile/runtime/governed-context-pipeline.ts.txt`, `context-governance-pipeline-producer.ts.txt`, `context-governance-receipts.ts.txt`, `context-governance-artifact-intents.ts.txt`, `governed-run-session.ts.txt`; matching `tests/pactile/runtime/` files | The selected runtime pieces are not a drop-in Nyan AgentSession integration. |
| C7-C8, C12 | CG B4 | `source/pactile/runtime/context-governance-review.ts.txt`, `context-governance-approval-grant.ts.txt`, `context-governance-receipts.ts.txt`; `tests/pactile/runtime/context-governance-review.test.ts.txt`, `run-ledger-approval-grant.test.ts.txt`, `review-regressions.test.ts.txt` | Review and approval behavior must be rewritten for Nyan ownership and persistence. |
| C13-C14 | CG B8 and B9 | `design/context-governance/compression/context-unit-manifest-v1.zh-CN.md`, `design/context-governance/compression/compression-decision-chain-v1.zh-CN.md`, `source/pactile/runtime/context-governance-artifacts.ts.txt`, `context-governance-artifact-intents.ts.txt` | Context actions remain reference designs; lossy actions require separate approval. |
| G1-G3 | CG B3 and B8 | `source/pactile/runtime/governed-context-pipeline.ts.txt`, `governed-run-session.ts.txt`, `source/pactile/agent/native-agent/`, `source/pactile/agent/pi/`; `design/context-governance/implementation/02-ownership-dependency.zh-CN.md` | No CG Coordinator, Workspace Host, ContextUnitizer, or Compression Controller exists in Nyan. |
| G4-G5, G7 | CG B4 | `source/pactile/runtime/context-governance-policy.ts.txt`, `context-governance-review.ts.txt`, `context-governance-approval-grant.ts.txt`; `tests/pactile/runtime/context-governance-*.test.ts.txt`; `evidence/p0/`, `evidence/p1a/` | Evaluation evidence is offline reference material and must not write Nyan product state. |
| G6 | CG B5 | `source/pactile/retrieval/evidence.ts.txt`, `envelope.ts.txt`, `planner.ts.txt`, `source/pactile/agent/retrieval/`; `design/context-governance/retrieval/04-inspect-freshness-fence.zh-CN.md` | Retrieval fencing is not implemented in Nyan. |
| G8 | CG B9 | `design/context-governance/compression/compression-memory-legacy-migration.zh-CN.md`, `implementation/06-blockers.zh-CN.md`, `implementation/07-legacy-migration.zh-CN.md` | Retention policy remains an owner-controlled Nyan decision. |
| M1, M3 | CG B1, B3, and B9 | `source/pactile/agent/memory/durability/index.ts.txt`, `scope.ts.txt`, `source/pactile/agent/context/`, `source/pactile/shared/validation.ts.txt`; `tests/core/pactile/context-memory/` | Storage location and Nyan scope semantics still require owner decisions. |
| M2, M5 | CG B1 and B2 | `source/pactile/agent/memory/artifact-store/`, `source/pactile/runtime/store-port.ts.txt`, `stores/artifact/`; `tests/pactile/runtime/file-artifact-store.test.ts.txt`, `stores.test.ts.txt` | These are ports and storage references, not Nyan host implementations. |
| M4 | CG B3 | `source/pactile/agent/memory/read-tool.ts.txt`, `source/pactile/agent/memory/scope.ts.txt`, `tests/pactile/runtime/governed-memory-read-tool.test.ts.txt` | Nyan ToolDefinition and renderer are absent. |
| M6-M7 | CG B9 | `design/context-governance/compression/`, `design/context-governance/implementation/07-legacy-migration.zh-CN.md` | Memory promotion and `/memory` behavior are not copied as product code and remain gated. |
| H1-H4 | CG B2 and B3 | `source/pactile/runtime/run-ledger.ts.txt`, `run-ledger-effect-receipts.ts.txt`, `sqlite-runtime-store.ts.txt`, `stores/sqlite/`, `stores/artifact/`; `tests/pactile/runtime/run-ledger*.test.ts.txt`, `sqlite-runtime-store.test.ts.txt` | RunLedger placement is Owner Decision #10; no Nyan SQLite RuntimeStore exists. |
| H5 | CG B1 and B2 | `source/pactile/runtime/canonical-paths.ts.txt`, `case-fold.ts.txt`, `unicode-nfc.ts.txt`, `unicode-nfc-data.ts.txt`, `paths.ts.txt`; `tests/pactile/runtime/paths.test.ts.txt` | Reconcile with Nyan path utilities before porting. |
| H6-H7 | CG B3 | `source/pactile/runtime/governed-run-session.ts.txt`, `runtime-host.ts.txt`, `source/pactile/agent/session/`, `tests/pactile/runtime/governed-run-session.test.ts.txt`, `runtime-host.test.ts.txt` | The host composition root and JSONL checkpoint seam must be designed for Nyan. |
| H8 | CG B1 | `source/pactile/shared/validation.ts.txt`, `source/pactile/agent/context/compaction.ts.txt`, `tests/pactile/agent/tool-result-fingerprint.test.ts.txt` | Validation and fingerprint helpers need a Nyan ownership note. |
| P1-P3 | CG B3 | `source/pactile/agent/pi/`, `source/pactile/agent/native-agent/`, `source/pactile/agent/effects/contract.ts.txt`, `source/pactile/agent/session/`; `tests/pactile/agent/` | These are lifecycle and seam references; do not copy the native-agent wrapper as a Nyan adapter. |
| P4 | Out of scope | No reference port is required. | Nyan already owns `@ny4n/ai`; Pactile provider-port and Pi adapter layers are excluded. |
| R1-R2 | CG B5 | `source/retrieval-worker/src/`, `tests/retrieval-worker/worker.test.ts.txt`, `design/retrieval-worker-README.md` | The worker is external reference code, not an Nyan package or Nyan evidence. |
| R3-R7 | CG B5 | `source/pactile/retrieval/`, `source/pactile/agent/retrieval/`, `source/nyan-adapter-candidates/utils/`; `tests/pactile/retrieval/` | The selected files cover ABI, planner, adapters, router, ranking, classification, and telemetry references. |
| R8-R9 | CG B5 and B7 | `design/context-governance/retrieval/01-semantic-provider-contract.zh-CN.md`, `03-semantic-generation-index.zh-CN.md`, `09-readiness-fixtures.zh-CN.md`, `10-evaluation-matrix.zh-CN.md` | No embedding provider, index, or approved index-write placement exists in Nyan. |
| R10-R11 | CG B5 and B10 | `source/pactile/retrieval/planner.ts.txt`, `pack.ts.txt`, `design/context-governance/retrieval/05-candidate-pipeline.zh-CN.md`, `07-external-search-fetch-evidence.zh-CN.md`, `13-retrieval-search-service-design.zh-CN.md` | External search remains design-only and owner-gated. |
| R12-R14 | CG B5 | `source/pactile/retrieval/ranking.ts.txt`, `planner.ts.txt`, `pack.ts.txt`, `evidence.ts.txt`, `types.ts.txt`; `tests/pactile/retrieval/` | Deterministic branches and pack states are reference behavior only. |
| R15-R19, R21 | CG B10 | `design/context-governance/retrieval/06-fallback-degradation.zh-CN.md`, `07-external-search-fetch-evidence.zh-CN.md`, `08-privacy-egress.zh-CN.md`, `09-readiness-fixtures.zh-CN.md`, `13-retrieval-search-service-design.zh-CN.md`; P0/P1a evidence | Provider, egress, SSRF, evidence, citation, and external tools are not admitted into Nyan. |
| R20 | CG B3, B5, and B10 | `source/pactile/runtime/run-ledger.ts.txt`, `source/pactile/retrieval/`, `design/context-governance/retrieval/04-inspect-freshness-fence.zh-CN.md` | Context-operation epochs and restart recovery need a Nyan integration design. |
| J1-J5 | CG B6-B8 | `source/pactile/jev/`, `source/pactile/decision/`, `source/pactile/providers/`; `tests/pactile/jev/`, `tests/pactile/providers/`; `design/context-governance/retrieval/01-semantic-provider-contract.zh-CN.md`, `09-readiness-fixtures.zh-CN.md`, `12-blockers-unverified.zh-CN.md` | Selected source retains historical endpoint references but is not connected to Nyan configuration; live provider-shadow material is excluded. |
| J6 | Out of scope | No reference port is required. | Kernel scheduler, tile, task, and verification Jev integrations are excluded. |
| T1 | CG B1 and B4 | `tests/core/pactile/context-memory/`, `tests/pactile/agent/context-summarizer.test.ts.txt`, `tests/pactile/agent/tool-result-fingerprint.test.ts.txt` | Tests are external reference coverage and require Nyan rewrites. |
| T2 | CG B3 and B8 | `tests/pactile/agent/` | Applicable agent tests must be ported around Nyan AgentSession. |
| T3 | CG B2-B4 | `tests/pactile/runtime/` | Runtime tests are not runnable from this archive and do not prove Nyan behavior. |
| T4 | CG B5 | `tests/pactile/retrieval/`, `tests/retrieval-worker/worker.test.ts.txt` | Worker and retrieval tests require Nyan package/layer decisions. |
| T5 | CG B6 | `tests/pactile/jev/`, `tests/pactile/providers/provider-probes.test.ts.txt` | Only safe schema/readiness tests may be ported; no live credentials are included. |
| T6 | Out of scope | No reference port is required. | Kernel, old Pi executor/RPC-host, and settlement-outbox tests are excluded. |
| E1-E2 | CG B4 | `evidence/p1a/`, `evidence/p0/`, `design/context-governance/implementation/04-evaluation-controller.zh-CN.md`, `10-p0-exit-checklist.zh-CN.md` | These are evaluation-only assets, not Nyan product evidence. |
| E3 | CG B6-B7 | No provider-shadow files are present by design; see `design/context-governance/retrieval/09-readiness-fixtures.zh-CN.md` and `12-blockers-unverified.zh-CN.md`. | The live probe and private-network receipts were intentionally excluded. |
| E4 | CG B4 | `design/context-governance/implementation/06-blockers.zh-CN.md` | The stage 1a runner was not found in the inspected sources. |
| E5 | CG B4-B10 | `design/context-governance/retrieval/10-evaluation-matrix.zh-CN.md`, `implementation/04-evaluation-controller.zh-CN.md`, P0/P1a evidence | Paired runs and unknown-outcome cases remain new Nyan work. |
| D1-D6 | CG B1, B4, B8, and B9 | `design/context-governance/compression/`, `design/context-governance/implementation/01-contract-draft.zh-CN.md` through `10-p0-exit-checklist.zh-CN.md` | These documents describe Pactile decisions and must be re-expressed as Nyan notes/specs. |
| D7 | CG B5-B10 | `design/context-governance/retrieval/` | Retrieval design is a migration input, not current Nyan behavior. |
| D8-D9 | CG B3-B5 | `design/pactile-docs/migration/native-agent-gap-matrix.zh-CN.md`, `design/pactile-docs/architecture/pactile-module-catalog.zh-CN.md` | Broader Pactile prompt and dual-product materials are not copied into the curated snapshot. |
| D10-D11 | CG B3 and B5 | `design/pactile-docs/migration/retrieval-worker-integration-design.zh-CN.md`, `retrieval-worker-d25d33.zh-CN.md`, `native-agent-gap-matrix.zh-CN.md` | Worker and native-agent designs remain reference-only. |
| D12-D13 | CG B1-B10 | `design/context-governance/implementation/00-rebase-report.zh-CN.md`, `06-blockers.zh-CN.md`, `design/context-governance/retrieval/08-privacy-egress.zh-CN.md`, `09-readiness-fixtures.zh-CN.md` | Pactile decisions and user-facing material must be rewritten for verified Nyan behavior. |
| D14 | CG B5 and B10 | `design/context-governance/retrieval/13-retrieval-search-service-design.zh-CN.md` | Search Service design is not a running Nyan service. |
| D15 | Inventory only | `design/pactile-docs/architecture/pactile-module-catalog.zh-CN.md` | The catalog is an external inventory, not proof of Nyan integration. |

## Batch reading map

| Batch | Read first | Then inspect | Acceptance focus |
| --- | --- | --- | --- |
| CG B1 contract foundation | `implementation/01-contract-draft`, `02-ownership-dependency`, `03-stage-plan` | `source/pactile/shared/`, `agent/context/`, `agent/memory/`, selected T1 tests | Public contract, ownership, validation, fingerprint, and layer boundary; no host storage yet. |
| CG B2 host storage | `implementation/05-writeset-rollback`, `06-blockers` | `source/pactile/runtime/run-ledger*`, `stores/`, `store-port.ts.txt`, runtime storage tests | Admission, idempotency, receipts, recovery, and the RunLedger decision. |
| CG B3 AgentSession seam | `pactile-docs/migration/native-agent-gap-matrix`, `implementation/02-ownership-dependency` | `source/pactile/agent/session/`, `agent/pi/`, `agent/native-agent/`, governed session sources and tests | Nyan AgentSession ownership, cancellation, restart recovery, and no copied Pi adapter layer. |
| CG B4 audit/evaluation | `implementation/04-evaluation-controller`, `08-p0-admission-decision`, `10-p0-exit-checklist` | `runtime/context-governance-review*`, approval/receipt tests, `evidence/p0/`, `evidence/p1a/` | Product/evaluation isolation, review gates, receipts, and unknown-outcome handling. |
| CG B5 deterministic retrieval | `retrieval/02-retrieval-schema`, `05-candidate-pipeline`, `06-fallback-degradation` | `source/pactile/retrieval/`, `source/retrieval-worker/`, adapter and retrieval tests | Local worker, lexical/relation branches, ranking, budgets, cancellation, and pack states. |
| CG B6 decision providers | `retrieval/01-semantic-provider-contract`, `09-readiness-fixtures`, `12-blockers-unverified` | `source/pactile/jev/`, `decision/`, `providers/`, Jev/provider tests | Configuration-only provider readiness, fail-closed behavior, and no copied endpoint. |
| CG B7 semantic shadow | `retrieval/03-semantic-generation-index`, `10-evaluation-matrix` | `source/pactile/retrieval/jev-planning.ts.txt`, selected Jev planning tests | Advisory-only shadow, dimensions/readiness, index placement decision, and no product writes. |
| CG B8 reversible context | `compression/context-unit-manifest-v1`, `compression-decision-chain-v1` | context governance artifact/intent/review sources and tests | Proposal-only reversible actions, protection rules, and explicit authorization. |
| CG B9 memory lifecycle | `compression/compression-memory-legacy-migration`, `implementation/07-legacy-migration` | memory durability, artifact store, scope, retention-related tests/design | Promotion, lossy compaction, retention, delete, and cross-session ownership. |
| CG B10 external evidence | `retrieval/07-external-search-fetch-evidence`, `08-privacy-egress`, `13-retrieval-search-service-design` | P0/P1a evaluation assets only; do not use provider-shadow files | Egress, SSRF, evidence, citations, stale results, cancellation, and external approval. |

## Exclusions that affect navigation

- `evidence/provider-shadow/` is not present. Its live probe, receipts, tailnet addresses, and provider-specific readiness artifacts were intentionally excluded.
- Pactile Kernel, Task, Worktree, CLI, application, tile, scheduler, old Pi executor/RPC-host, and settlement-outbox modules are not part of this snapshot.
- Several Pactile entry-point glue files are not copied because this is a curated migration reference rather than a full checkout. Follow the `Coverage boundary` column above instead of assuming that an absent path is missing from Pactile.
- No file in this directory is an Nyan implementation, package export, runtime dependency, or completion proof.
