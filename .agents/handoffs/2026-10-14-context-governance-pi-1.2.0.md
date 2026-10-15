# Handoff: Context Governance, Pi 1.2.0 Ports, and the Nyan TUI Direction

Date: 2026-10-14
Repository: `/home/blxze/projects/personal/nyan`
Branch: `main`
Status: historical record. Superseded on 2026-10-15 by
[`ROADMAP.md`](../../ROADMAP.md) and
[the durable migration inventory](../notes/proposed/architecture/2026-10-15-durable-migration-inventory.md).

Read this file for the Pi 1.2.0 port record and the reasoning behind it. Two statements below no
longer hold and must not be followed:

- durable is no longer "an optional task/recovery infrastructure". On 2026-10-15 the owner selected
  Shape B: the durable Harness becomes the product path. See the Decided architecture and
  Implementation orchestration sections of `ROADMAP.md`.
- the roadmap has been edited since. `ROADMAP.md` is the source of truth for planned work, and it now
  carries phases N0 through N9.

## Purpose

This document records the decisions, evidence, implementation state, and open questions from the context-governance review and the hand-port of selected Pi 1.2.0 changes. It is intended to let the next session continue without reopening settled context or mistaking a design decision for an implemented feature.

## Executive summary

Nyan is a TUI-first fork of the Pi agent. Pactile is the predecessor project and was also built on Pi. The owner confirmed that Pactile's Context, Compaction, Retrieval, Memory, and Search designs are the authoritative designs for Nyan, not merely ideas to evaluate. The correct migration is therefore:

```text
Pactile Context Governance design
  -> keep its contracts, policies, boundaries, evidence, and failure semantics
  -> remove App, Host, multi-client, logical workspace/worktree, and Kernel-process assumptions
  -> attach the result to AgentSession, SessionManager, and the TUI
```

The owner also decided to retain both `@ny4n/codemode` and `@ny4n/durable` and to try using them. Their roles are different:

- codemode is a product-facing tool composition and sandbox capability;
- durable is an optional task/recovery infrastructure and experimental integration surface;
- neither decision requires making durable the mandatory runtime for every TUI session.

A hand-port of Pi v1.2.0 codemode and durable changes, plus selected Pi fixes through the current Pi `main` snapshot, is in the working tree. The source and deviations are recorded in `.agents/upstream/pi-sync-2-06a466935.json`.

## User decisions and direction

### Confirmed

- Keep and try `@ny4n/codemode`.
- Keep and try `@ny4n/durable`.
- Port the recommended AI, TUI, coding-agent, MCP, and codemode fixes reviewed from Pi.
- Include the `before_agent_start` behavior for custom-message-triggered runs.
- Include the MCP resource-listing change: connections no longer enumerate all resources; `mcp list --json` reports a boolean capability.
- Include the Bun codemode worker-lifetime fix.
- Remove OpenRouter per-key model listing from the selected changes as unnecessary.
- B6 should remove the old Jev transport work and retain only decision policy and readiness checks; classification can use the existing `@ny4n/ai` API.
- Pactile Retrieval should be ported as designed. Codemode is not a replacement for Retrieval; it can be one execution/composition mechanism underneath or beside it.
- Pactile Compaction, Retrieval, Memory, and Search should be directly reused as designs, rather than reduced to a conservative "try codemode first" prototype.

### Still open

- Whether to add a Nyan-owned session-sharing service. Radius is Earendil Works' hosted Pi service, not a generic server package. Nyan does not currently have the Radius provider, authentication, or a documented compatible artifact server. Do not add a default Radius URL. A Nyan-owned upload endpoint would be a separate feature and must be configured explicitly.
- Whether to port Pi's chord2 runtime replacement. Pi's chord2 change is a large rewrite and removes the published client, protocol, and server packages plus the experimental client/server stack. This is not a small compatibility update.
- The product shape of approvals, Kernel/Task, Goal/Gate/Close, and non-interactive review. Nyan currently does not ask for approval before every tool call; introducing an approval chain would be a product decision, not a Context Governance implementation detail.
- The exact Nyan storage adapter for Pactile-style memory/artifacts/receipts. JSONL remains the session transcript source, but Pactile's artifact and receipt semantics may require `.nyan/` storage rather than putting every fact into ordinary `custom` entries.

## Existing roadmap context

`ROADMAP.md` is stale and has not been edited in this work:

- its verified baseline still says `82e63a1e`;
- the current tree has moved past that baseline;
- merged documentation work for issues 17-19 is absent from its Done table;
- the Context Governance section still reflects the larger Pactile/App/Host plan;
- the Bun phases and CG B1-B10 need to be re-estimated after the decisions above.

Do not edit the roadmap until the owner has finished the product-shape discussion. When it is edited, update the roadmap and `packages/coding-agent/CHANGELOG.md` together where the change is user-visible.

## Pactile Context Governance target for Nyan

The target is not a new lightweight summary prompt. It is the Pactile pipeline adapted to one Nyan TUI session:

```text
Session / transcript
  -> validated cut point
  -> protected-region policy and tool-result masking
  -> structured summary and memory facts
  -> artifact / receipt semantics using a Nyan storage adapter
  -> new context snapshot
  -> AgentSession continues or fails closed
```

### Compaction principles to preserve

1. **Validated boundaries**: do not cut through a user turn or an assistant tool-call/result arc; reject malformed or unresolved transcripts.
2. **Protected regions**: system, user, tool-call, approval, evidence, effect, and unpaired-result regions must be protected according to policy.
3. **Mask before compact**: clear eligible old tool-result payloads while retaining the call/result arc, then perform full compaction only if the context remains too large.
4. **Structured checkpoint summaries**: preserve goal, constraints, progress, decisions, next steps, and critical context; keep facts distinct from derived summaries.
5. **Stale/conflict checks**: revalidate the selected cut point against the current session projection before committing the replacement.
6. **Fail closed**: if summary generation, artifact persistence, receipt/checkpoint recording, or validation fails, do not replace the live context with an unproven result.
7. **No second fact source by accident**: the transcript remains the source for the conversation; memory facts and artifacts need explicit provenance and hashes.

Nyan already has useful pieces: `prepareCompaction`, `findCutPoint`, split-turn summaries, `session_before_compact`, `context_edit`, compaction entries, SessionManager projections, summary failure reporting, and file-operation tracking. The next implementation should strengthen these pieces toward the Pactile contracts instead of introducing a separate ad-hoc compressor.

Pactile's App/Host, multi-client leases, logical workspace/worktree admission, and Kernel process are not part of the TUI target. A single-process TUI can use session-entry IDs, projection checks, hashes, and an explicit local storage adapter without pretending to provide multi-process fencing.

## Role of codemode and durable

### `@ny4n/codemode`

Codemode is suitable for the main product path when the task is short-lived tool composition:

- search and filter results;
- combine `grep`, `find`, `read`, and other tools;
- build bounded evidence packs;
- run deterministic, replayable scripts;
- use `tool_search` and MCP tools without growing the Agent loop.

Its boundary is important:

```text
codemode executes a model-generated script
Context Governance decides what may enter the model context
```

Codemode must not bypass context budgets, sensitive-data handling, retrieval policy, memory scope, or evidence provenance.

### `@ny4n/durable`

Durable should remain a separately usable infrastructure package and an experimental integration surface. It is useful for:

- long-running tasks;
- restart and recovery;
- effect intent/outcome tracking;
- replay policy and unknown outcomes;
- scheduler and wait-cycle validation;
- durable code mode;
- future background work.

It should not become a mandatory dependency for every normal AgentSession merely because it exists. A likely product shape is:

```text
TUI
  - normal AgentSession
  - codemode for short tool composition and retrieval execution
  - durable for explicitly long-running, recoverable, or background work
```

The Pi upstream is useful for bug fixes and infrastructure improvements, but Nyan remains independent of Pi. Future changes must be hand-reviewed and adapted, not merged as a routine sync. Each selected range needs a record under `.agents/upstream/`.

## Pi 1.2.0 and selected post-1.2.0 changes ported

The hand-port is intentionally not a git merge. Pi source was read from a temporary clone, normalized for Nyan names, and adapted to Nyan's layers and existing file layout.

### Codemode and durable

- deterministic codemode sandbox runs and host-controlled replay;
- declaration constraint tags and first-line `// @options:` validation;
- codemode worker shutdown that does not wait for Bun workers stuck in non-interruptible built-ins;
- two-worker admission accounting until actual worker exit;
- shared BM25/search utilities in `@ny4n/codemode/search` instead of duplicate copies;
- coding-agent namespace aliases, `reachesTools`, MCP result typing, elapsed/total codemode timing, linear output joining, and compaction serialization updates;
- durable input application entries, display-only writes, compaction failure visibility, schema-tool error diagnostics, wait-cycle rejection, deferred tools, tool search, and durable code mode;
- durable code mode intentionally does not expose Pi's `models.*` globals because Nyan's durable model boundary is the narrower `ModelRuntime` contract;
- durable does not add Pi's `FileSystem.listFiles` because Nyan has no implementing environment.

### AI, MCP, coding-agent, and TUI fixes

- repair invalid `\\u` escapes in tool-call arguments;
- replace images in Anthropic error tool results with a text note;
- retry Anthropic strict-tool grammar failures with non-strict schemas where permitted;
- retry the "The upstream provider returned an error" wrapper wording;
- send a copied compressed Codex request body;
- print-mode warning and non-zero exit for length-truncated final responses;
- retry transient Windows `EPERM` while acquiring the auth lock;
- expand `~` in resource setting patterns;
- restore active tools on session resume;
- run `before_agent_start` for custom-message-triggered runs and expose the event union by `messageType`;
- stop enumerating MCP resources during connection; expose `resources: true` in the JSON listing;
- preserve delayed terminal replies outside keyboard input;
- let unhandled wheel input scroll the transcript below focused overlays;
- enable Kitty images in Herdr.

The complete source list, rejected changes, local adaptations, and verification are in `.agents/upstream/pi-sync-2-06a466935.json`.

## Verification evidence

### Passed

- `npm run check` passed after the final source changes. This includes lint, TypeScript, pinned dependencies, runtime dependencies, relative import checks, architecture, entry graphs, coding-agent install lock, and browser smoke.
- `packages/ai`: full Vitest run with provider credentials unset: 1,324 passed, 868 skipped, 2,192 total.
- `packages/codemode`: 232 passed.
- `packages/mcp`: 45 passed.
- `packages/tui`: selected Node test files: 233 passed.
- `packages/durable`: relevant normal and `NYAN_DURABLE_DOCUMENT_RETENTION_MS=0` runs passed; the earlier full run reached 1,223 passed with one environment-sensitive code-mode timing issue before the test was made time-bounded.
- `packages/coding-agent`: affected tests and `test/suite` passed apart from the environment-specific `fswatch-error-crash` test when `@ny4n/tui/dist` had not been built.
- A Photon worker timing test in durable was reproduced as intermittent on a clean `HEAD` worktree and is not caused by the one-line comment change in that file.

### Not yet verified

- Bun test suites and a full offline build after the final source state.
- Full root `npm test` and the full coding-agent suite.
- Real provider calls. Provider credentials must remain unset for local test runs.
- A real Nyan TUI end-to-end run through every new Context Governance path.

## Immediate next steps

1. Review this handoff and the Pi sync record after the commit.
2. Continue the product-shape discussion in this order:
   - Pactile-style compaction;
   - Pactile-style retrieval and evidence;
   - memory/artifact storage and lifecycle;
   - search and codemode integration;
   - audit visibility;
   - approvals and Kernel/Task only if the product needs them.
3. Port Pactile Context Governance contracts into the TUI-owned architecture, removing only App/Host/multi-client assumptions.
4. Decide the Nyan artifact/receipt storage adapter before claiming durable compaction guarantees.
5. Rework `ROADMAP.md` after the above decisions, including the current Done baseline and the role of codemode/durable.
6. For future Pi changes, use `.agents/skills/nyan-upstream-sync/SKILL.md`, preserve Nyan identity, and add an `.agents/upstream/` record.

## Safety and process constraints

- Do not add a default URL for Radius or another hosted service Nyan does not operate.
- Do not delete published packages or intentional functionality without an explicit product decision.
- Do not turn `@ny4n/durable` into a mandatory coding-agent dependency without documenting the lifecycle, recovery, and unknown-outcome ownership.
- Do not claim an experimental durable entry point is a Nyan product feature until a Nyan entry point, persistence path, and restart recovery are verified.
- Do not commit or push unrelated worktree changes; inspect the staged file list before committing.
