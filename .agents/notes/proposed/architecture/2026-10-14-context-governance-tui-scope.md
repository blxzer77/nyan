# Agent Note: Context governance scope for a terminal agent

Status: proposed

Nothing here is decided. Every item marked "owner decision" is waiting on the repository owner, and the roadmap decisions it touches stay open until the owner closes them.

## Problem

`ROADMAP.md` plans ten Context Governance batches (CG B1 to B10) that port design and code from Pactile. Pactile is a product made of a Product Kernel, an Electron App with a Renderer, and a CLI. Its context-governance design assumes a Host process, read-only clients (the TUI and the App), and approvals carried by Kernel commands. Nyan is a terminal agent. `AgentSession` runs in the same process as the TUI. A port that copies those assumptions would build machinery that a terminal agent does not use.

Evidence for the Pactile assumptions (all under `references/pactile-context-governance/`):

- `source/pactile/runtime/context-governance-review.ts.txt`: `createKernelApprovalVerifierV1` requires an `approvalRef` to be an applied Product Kernel command receipt.
- `design/context-governance/compression/compression-decision-chain-v1.zh-CN.md`: a `review` verdict writes an `approval_request` to the RunLedger and waits for "a person or the Kernel" to run a formal approval command.
- `design/pactile-docs/migration/retrieval-worker-d25d33.zh-CN.md`: Agent, Provider, Renderer and external receipts use a logical `worktreeId` and relative paths, so the Renderer never sees an absolute path.
- `source/pactile/runtime/workspace-admission.ts.txt`: separates `kernelRoot`, `repositoryRoot`, `candidateRoot`, `expectedBaseSha` and `ownerRunId` for Kernel dispatch of a Run to a candidate worktree.
- `design/context-governance/implementation/02-ownership-dependency.zh-CN.md` (O-1, F-8, F-9): the Workspace Agent Host is the only runtime entry, the Agent reads memory only through `memory.read`, and clients read versioned projections only.
- `source/pactile/runtime/runtime-host.ts.txt`: the runtime store is "owned by a CLI/Electron host" and carries lease, fencing and compare-and-swap machinery.

Checked and not desktop-specific: the context snapshots and deltas in C1 (the contract draft excludes Protocol events and Snapshot exposure), `/context review` and `/memory` (terminal slash commands), and the retrieval worker (its README states it does not depend on Electron, the Renderer or the Kernel).

## Proposal

Owner directions recorded on 2026-10-14:

1. Anything that depends on the App is dropped.
2. Whether to import the Product Kernel and Task Kernel is open for discussion; the owner finds them valuable.
3. App logic should be converted to Nyan TUI logic where possible.
4. A Host process with multiple clients is not built, at least not for the TUI, for now.

Mapping of those directions onto the roadmap, from what Nyan does today:

| Area | Nyan today | Proposed treatment |
| --- | --- | --- |
| Host composition root (G1, H6, M5) | `AgentSession`, `AgentSessionRuntime` and the services already compose model runtime, session, tools and extensions in one process. `@ny4n/server`, `client` and `protocol` are devDependencies used only by `src/experimental/`. | No Host. Attach the lifecycle hooks directly to `AgentSession` (roadmap P3). |
| Read-only clients and `memory.read` as the only read path (M4, M5) | No memory feature in the product path. The agent already has `read`, `grep`, `find`, `ls`, `bash`, `write` and `edit`. | The isolation premise (F-8) does not hold. Reduce M4 to an ordinary tool or a `/memory` command and drop the Host memory ports. Protecting memory files from agent writes is a separate question (an extension `tool_call` hook can block them). |
| RunLedger and SQLite RuntimeStore (H1 to H4) | Product persistence is JSONL through `SessionManager` using `appendFileSync`; no fsync or lock was found in `session-manager.ts`. `@ny4n/durable` is a devDependency and is imported only from `src/experimental/`, which the build excludes. | Owner decision #10 (see Alternatives). |
| Approval (C7, C8, M6, G4 review branch, decision #11) | `ctx.ui.confirm` and `select` exist on `ExtensionUIContext`; the `tool_call` and `session_before_compact` events can block or customize. | A `review` verdict opens an inline TUI confirmation. The user's answer is appended as a `custom` session entry that serves as the grant. Drop the Kernel receipt, the external `approvalRef` verifier and the ledger `approval_request` kinds. In a non-interactive mode no one can approve, so `review` is treated as `deny`. Unverified: whether the core path can reach `ui.confirm`, and its behavior in print and RPC modes. |
| Workspace identity (R3, R13, G6, M3) | Sessions are keyed by cwd (`session-cwd.ts`). `utils/paths.ts` has `canonicalizePath`, `normalizePath` and `getFileRevision`. | Project root is the git root or cwd. Persisted records use root-relative paths. The freshness fence reduces to a file revision, plus git HEAD if wanted. Drop the logical `workspaceId` and `worktreeId` and the `workspace-admission` module. Unverified: whether NFC and case-fold handling already exist in `utils/paths.ts` (H5). |

Overlap with existing Nyan code that changes batch scope:

- `findCutPoint`, `prepareCompaction`, `shouldCompact` and token estimation already cover part of C1 and C6. Compaction is LLM-summarized; there is no deterministic summarizer (C4 stays a gap).
- The `context_edit` session entry (`SessionManager.appendContextEdit`) omits or replaces an earlier model-visible entry on the active branch while the original stays in the JSONL file. It overlaps C13 and C14 reversible actions. Whether it meets Pactile's byte-exact recoverability definition is unverified.
- agent-core already has `beforeToolCall`, `afterToolCall` and `transformContext`. `context_update` (P1) does not exist.
- The built-in `grep`, `find` and `ls` tools overlap R7 `code_search`. Their retrieval quality was not evaluated.

## Alternatives considered

Decision #10, where governance records and receipts live:

- (a) Extend JSONL with new entry types. One source of truth and no SQLite. Cost: no cross-entry transaction, so the artifact, receipt, manifest ordering (acceptance invariant 4) must come from write order and content-addressed artifacts written first. Current leaning.
- (b) Add a SQLite ledger next to JSONL, as Pactile does. Cost: two sources of truth; Pactile's own module catalog records that the unified transaction boundary with the RunLedger is not closed.
- (c) Move the product onto `@ny4n/durable`. Largest change, and the package is marked experimental with an unstable API.

Port the Pactile Host and Protocol split as designed: rejected for now by owner direction 4, because the TUI is in-process.

Keep the Kernel approval verifier and replace only the UI: not proposed, because it keeps a dependency on a Kernel Nyan does not have. It returns if the owner chooses to import the Kernel.

## Open questions for the owner

1. Decision #10: option (a), (b) or (c).
2. Non-interactive `review` is `deny`: acceptable?
3. Kernel and Task: which part is wanted (Task schema, write set and review, or Goal, Gate and Close), what user problem it solves (tracking and verification of multi-step work, or parallel agents), and where it would live. The Kernel snapshot is not in `references/`: the module catalog says the Kernel and Task modules were excluded, and the source is at `D:\pactile`, which this machine cannot read. Decision #9 currently says "not now".
4. Decision #9 outcome changes how R18 (EvidenceRecord), acceptance invariant 7, M6, C8 and the E series are defined. Without a Kernel they follow the approval treatment above.

## Findings: `@ny4n/durable` and `@ny4n/codemode`

Read on 2026-10-14. For `durable/docs/spec.md` (5122 lines) sections 1, 2 to 2.1, 4, 5, 6 (part), 7.2, 7.3 (part), 8.7, 10 to 13 were read in full; sections 3 (documents and Chord), 7.1, 7.4, 7.5, 8.1 to 8.6 and 9 were not. The spec's sentence "Pico5 is not implemented yet" (line 297) is stale: the package has 76 source files and 108 test files. No test was run.

### What each module is

- `@ny4n/codemode` runs model-written JavaScript in a QuickJS sandbox whose only capability is calling injected tools. It is in the product path (`coding-agent/src/extensions/codemode/`) and off by default (`+codemode` or an MCP server turns it on). Nested tool calls run through the agent tool pipeline (`ctx.executeTool`), so `tool_call` and `tool_result` hooks and permission checks apply. `store` and `load` persist as branch-aware `codemode-store` custom session entries, written only when the script succeeds. Truncated output and images are written to the OS temp directory (mode 0600). `models.classify` reaches classifier models.
- `@ny4n/durable` is a durable conversation, task and document runtime (spec title "Pico5"). It is Experimental, a devDependency of `coding-agent`, and imported only by `src/experimental/` (durable, vacation, session-worker, client-tui, services), which the build excludes. The product path uses JSONL `SessionManager` and does not use it.

### What durable already specifies that Context Governance needs

| Context Governance need | durable |
| --- | --- |
| Atomic write of record, receipt and manifest (invariant 4) | Invariant 1: one Session commit is atomic across entries, tasks and documents. SQLite uses one SQL transaction. JSONL writes sidecars first and then one main marker, removes torn tails on recovery, and has an opt-in `fsync`. |
| No replay of unknown effects, effect intents and receipts (invariants 1 to 5, H2) | Section 5.2 effect sandwich: commit intent, perform the effect, commit outcome. Reopening in an intent phase means the effect may have happened, and the handler retries safely, polls, or records interruption. Tools carry `replay: "safe" \| "unsafe"` (default unsafe); an unsafe tool interrupted by a crash returns `interrupted`; `abandonOnRestart` stops a replay-unsafe caller and its children from resuming. |
| Cut points, reversible context edits (C1, C13, C14) | Section 2.1: entries are immutable; `head` moves the start of model context; `edits` `omit` or `replace` a target; raw history stays in storage. The context-derivation rules are normative. |
| Compaction pipeline (C3 to C5) | Section 8.7: compaction is a task with `select`, `summarize` and `retry` phases. The `beforeCompact` hook may return `{ decline: true }` or `{ summary }`, which is where a deterministic summarizer plugs in. Section 6 orders concurrent summaries by cut position with a stale-head rule. Section 12 records known hazards: an application edit placed during a compaction is lost, and an application head can be undone. |
| Pre-decision gates | Section 7.2 hooks: `beforeTool` replaces arguments or blocks with error text, `beforeCompact`, `beforeRequest`. `memo` is a durable first-writer-wins decision, usable for idempotent grants. |
| Cancellation, deadlines, unknown outcome (invariants 13, 14) | Section 5.4 and 5.5: abort marks flow down an ownership tree, abort handlers run bottom-up, a finished task waits in `completing` until owned work drains. Section 10.1: a storage error is fatal to the Session, and a resubmission after reopen reuses `requestId`. |
| Audit trail | Section 13 non-goals: no semantic event journal; a consumer that must audit every transition persists each fact as an immutable entry. |

What durable does not provide: a human approval primitive (the `Permissions` example only blocks with the text "Needs approval"), a content-addressed artifact store, memory, retrieval, classifier use, or multi-process lease and fencing (the experimental demo keeps a second process out with a lock file).

### What codemode and the AI package already provide

- Classifier models are built into `@ny4n/ai` (`api/typesafe-system-one.ts`, `cloudflare-workers-ai-system-one.ts`, `system-one-shared.ts`). `models.classify` in codemode and `ctx.modelRegistry.classify()` for extensions reach TypeSafe Jev, Cloudflare Clef and OpenAI GPT-6 Luna with usage accounting, and a virtual model can route requests through a classifier. The roadmap entry J1 ("Jev transport and outbound validation are not in Nyan") is out of date for transport. Not verified: whether any state redaction or egress validation sits on that path.
- There is no embedding provider in `packages/ai` or `coding-agent` (the only hits for the word are unrelated), so R8 stays as written.
- The `codemode-store` custom entry is a working in-repo precedent for governance records kept as branch-aware JSONL `custom` entries (B3 option a).
- Codemode keeps nested tool output out of the model context, and bounds the rest with `max_output_tokens` plus a spill file. That is prevention rather than compaction, and a precedent for C14 `externalize`. The spill file is in the OS temp directory and is not content-addressed, so it is not the durable artifact H4 describes.
- A script gets `timeout_ms`, abort, `Promise.allSettled` and a classifier concurrency cap of four, so parallel retrieval branches with deadlines (R11, R12) can be expressed as scripts. They are model-written, not a deterministic planner.

### Consequences for the options above

- Option (c), moving the product onto durable, now has a concrete shape: durable supplies most of what B2 and B3 want, but `AgentSession` (4398 lines) and `SessionManager` would be replaced, and the package is Experimental. That is a larger project than Context Governance.
- A new option (d): keep the product on JSONL and use the durable spec as the design reference. Implement the smallest subset as `custom` entries: effect intent and outcome pairs with an explicit replay policy, `context_edit` for reversible edits, a `session_before_compact` handler for a deterministic summary, and an approval entry written after `ui.confirm`. For B1 to B4 the English, tested durable spec then replaces most of the Pactile Chinese design documents as the reference.
- Update, same day: the Pi 1.2.0 changes to `@ny4n/codemode` and `@ny4n/durable` are ported in the working tree (record: `.agents/upstream/pi-sync-2-06a466935.json`). Durable now also has deferred tools, a `tool_search` extension, inputs placed as application entries, compaction failures recorded in `nyan.live.compactionFailure`, and a replay-safe code mode built on the deterministic `sandbox.start()` of `@ny4n/codemode`. Code mode is a second precedent for option (d): its journal is written before each delivery and a rerun refuses to replay when the script diverges. None of it is reached from the product path yet.
- Durable already has a Task (a durable state machine with phases, checkpoints, owner tree, waits, abort cascade, `/tasks` view and subagents). It has no Review, Workspace, write set, Goal, Gate or Close. That narrows the Kernel and Task discussion in question 3: Task is largely present on the durable side, and a Kernel-like layer would be built on durable tasks and documents rather than imported.
