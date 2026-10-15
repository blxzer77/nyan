# Agent Note: Durable migration inventory

Status: proposed

## Problem

On 2026-10-15 the owner decided that the durable Harness becomes Nyan's product path, and that
compaction, memory, retrieval, decision, and evidence become durable tasks on that path. The
alternative was to keep `AgentSession` and `SessionManager` as the product path and mount durable
beside them as a context-operation runtime. The owner rejected that, because durable already owns
the effect sandwich (`commit intent`, `perform effect`, `commit outcome`), phased checkpointed
tasks, optimistic document writes with bounded replay, and recovery after a restart. Building a
second operation state machine beside those primitives, and then keeping two sets of state in
agreement across a stale-basis check, is more work than moving the product onto the runtime that
already has them.

The move is not free. Nyan's extension surface is larger than durable's hook surface, and the two do
not line up:

| Surface | Nyan today | Durable |
| --- | --- | --- |
| Subscriptions | 41 in `ExtensionAPI` | 7 hooks |
| Status channel | event bus plus `AgentSession` getters | `Conversation.viewState()`; the spec states there is no public semantic event channel |
| Compaction | a summary with split-turn handling, driven by a last-write-wins cancel-or-result hook | a phased compaction task with a first-decision-wins hook that returns only `decline` or `summary` |

The problem this note addresses is that the mapping is a design decision with no way to verify it
from the code. A name-level match is seductive and wrong: durable's hooks have fixed signatures and
composition rules, so "both can replace messages" is not enough. Without a recorded destination per
member, the migration becomes an open-ended search during implementation, and a later addition to
`ExtensionAPI` can silently go unmapped.

### What the first draft of this note got wrong

An independent review (recorded in
[`2026-10-15-durable-migration-inventory-review.md`](2026-10-15-durable-migration-inventory-review.md))
rejected the first version. The author re-verified every blocking finding against source before
accepting it. Three classes of error are worth naming, because they are the reason the rules below
exist.

**Mappings were made by shape resemblance instead of by contract.** Four mappings claimed `keep` and
could not preserve Nyan behaviour:

- `beforeRequest` receives `{ messages }` (model messages) and runs on *every request attempt,
  including recovery* (`packages/durable/docs/spec.md:2705-2710`). `before_provider_request`
  replaces the assembled provider payload, and `before_agent_start` runs once per run. Neither is a
  `beforeRequest`.
- `afterResponse` receives a terminal `AssistantMessage` and returns `void` — it is an all-observers
  hook (`docs/spec.md:2712-2713`). `after_provider_response` fires when status and headers arrive,
  before the stream is consumed; `message_end` replaces a finalized message of any role.
- `onYield` returns only `{ continue: UserInput }` (`docs/spec.md:2714-2715`). `agent_before_settle`
  and `turn_end` append arbitrary entries and then continue.
- `session_before_compact` is **last-write-wins** in Nyan
  (`packages/coding-agent/src/core/extensions/runner.ts:1092-1100`) with a `CompactionResult`
  carrying `firstKeptEntryId`, `details`, and `usage`; durable's `beforeCompact` is
  first-decision-wins and returns only `{ decline: true }` or `{ summary: string }`
  (`docs/spec.md:2687`, `docs/spec.md:2745-2755`).

  Only two mappings matched a hook's real contract: `tool_call` to `beforeTool` and `tool_result` to
  `afterTool`.

**The inventory was incomplete.** It covered `on(...)` subscriptions and `ExtensionAPI` methods but
not the UI surface, the handler contexts, the tool contract, resource loading, the MCP lifecycle, or
session tree and fork. Those are inventoried below.

**Two cited facts were wrong.** The prototype is 1416 lines across 9 files, not 1350 (1350 is the
8 `.ts` files alone). And the verification section cited `rg -n 'on\(event:'`, which returns 32, not
41; only `rg -n '^\s*on\('` returns 41.

## Proposal

Freeze the migration's target shape and its per-member mapping before writing migration code.

### Deliverables

| Artifact | Purpose |
| --- | --- |
| This note | The decision, the session policy, the gate record, and the open questions |
| [`extension-surface.json`](extension-surface.json) | The machine-readable classification: one entry per member, with its destination, decision, consumers, and evidence |
| [`2026-10-15-durable-migration-inventory-review.md`](2026-10-15-durable-migration-inventory-review.md) | The independent review that rejected the first draft, and the findings it produced |
| [`scripts/check-extension-surface.mjs`](../../../../scripts/check-extension-surface.mjs) | Derives the surface from `types.ts` and the prototype directory and fails when the JSON is incomplete, stale, or invalid |

The JSON is the reviewed artifact. The script never invents a classification: a new event or API
member fails the check until a person records where it belongs. The tables below are generated from
the JSON, so the prose and the data cannot disagree.

Both files sit under `proposed/` because this is a plan, not current behavior. When the migration
lands, the JSON moves next to [`docs/architecture/layers.json`](../../../../docs/architecture/layers.json),
which is the same shape: reviewed policy data in a `docs/architecture` file, enforced by a script in
`scripts/`.

### Destinations

Each member resolves to exactly one destination.

| Destination | Meaning |
| --- | --- |
| `hook:<name>` | Lands on an existing durable hook. A `capability` on the entry means the hook has to be extended, which is the case for `beforeCompact`. |
| `durable-capability` | Requires durable code that does not exist. The entry names the capability. |
| `product-api` | Belongs to the product shell: trust policy, registries, the input pipeline, provider selection, and session lifecycle. It keeps a Nyan-owned handler API. |
| `internal-view` | No handler runs. Only internal consumers (the TUI, `--mode json`, `--mode rpc`) read it, and they read derived state from `Conversation.viewState()`. |
| `drop` | No consumer anywhere. Removing it is a user-visible change and needs a release note. |

A destination is only `hook:` when the Nyan semantics and the hook's composition rule agree. Where
they do not, the entry is `adapt` or a `durable-capability`, so the gap is visible instead of being
smoothed over.

### Consumers

Every entry records its consumers, derived from the source, in four buckets: `builtin` (a shipping
extension under `src/extensions/`), `core` (another `src/` file), `example` (`examples/`, which this
repository treats as candidate code), and `test`.

The buckets matter because "no consumer" is not one fact:

- 5 events have no extension consumer at all: `message_update`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, `thinking_level_select`. For the first four that
  does **not** make them droppable, because `--mode json` streams them (see below). Only
  `thinking_level_select` has no consumer of any kind.
- 8 events are consumed only by a shipping extension or by `src/`. Those constrain the migration
  rather than being free.

### Non-interactive interfaces are a constraint, not a UI detail

`--mode json` and `--mode rpc` are documented, shipped interfaces
([`docs/json.md`](../../../../packages/coding-agent/docs/json.md), [`docs/cli.md`](../../../../packages/coding-agent/docs/cli.md)).
`src/modes/json-event.ts` streams `message_update` and passes every other agent event through, so the
streaming events are part of a published contract. The roadmap requires those three modes to keep
their interfaces, which means `message_update` and `tool_execution_update` cannot be reduced to
"derive it from the view". This is the strongest single argument for a bounded durable channel, and
it was missing from the first draft.

### Events

<!-- BEGIN GENERATED: events -->

| Event | Destination | Decision | Consumers | Nyan semantics | Open question |
| --- | --- | --- | --- | --- | --- |
| `project_trust` | `product-api` | keep | example 1, test 3 | Decide project trust before any agent run |  |
| `resources_discover` | `product-api` | keep | example 1 | Contribute skill, prompt, and theme resources to the registry |  |
| `session_start` | `product-api` | keep | built-in 2, example 25, test 13 | Startup, reload, new, resume, or fork; extensions connect MCP and report state here |  |
| `session_info_changed` | `internal-view` | keep | test 1 | Session name or metadata changed; no extension consumer |  |
| `session_before_switch` | `product-api` | keep | example 3, test 2 | Cancel a session switch |  |
| `session_before_fork` | `product-api` | adapt | example 3, test 2 | Cancel a fork or skip conversation restore |  |
| `session_before_compact` | `hook:beforeCompact` | adapt | example 1, test 13 | Last non-empty result wins; supplies cancel plus firstKeptEntryId, details, and usage | durable beforeCompact is first-decision-wins and returns only decline or summary |
| `session_compact` | `internal-view` | keep | test 2 | Compaction finished; no extension consumer |  |
| `session_compact_failed` | `internal-view` | keep | test 1 | Compaction failed; no extension consumer |  |
| `session_shutdown` | `product-api` | keep | built-in 2, example 7, test 4 | Session closing; extensions flush and release |  |
| `mcp_servers_change` | `product-api` | keep | built-in 1 | MCP server set changed |  |
| `session_before_tree` | `product-api` | adapt | test 3 | Cancel branch summarization or supply its summary and label |  |
| `session_tree` | `product-api` | adapt | example 3 | Conversation tree changed |  |
| `context` | capability: `phased-request-transform` | adapt | example 1, test 3 | Phase one of two: sees the conversation only, and nyan restores prompt and tool state after each handler |  |
| `context_with_system` | capability: `phased-request-transform` | adapt | test 1 | Phase two: sees the full transcript including system and tool declarations, output used as returned |  |
| `cache_warming_decision` | `product-api` | keep | test 1 | The prompt-cache warmer decides whether to warm |  |
| `before_provider_request` | capability: `provider-payload-hook` | adapt | example 1 | Replace the assembled provider request body | durable beforeRequest receives model messages, not the provider payload |
| `before_provider_headers` | capability: `provider-header-hook` | adapt | test 2 | Observe and mutate outgoing provider headers per request |  |
| `after_provider_response` | capability: `provider-response-observe` | adapt | example 1 | Fires once status and headers arrive, before the stream is consumed; exposes status and headers | durable afterResponse receives only a terminal AssistantMessage |
| `provider_stream_event` | capability: `streaming-channel` | adapt | example 1, test 1 | Raw provider stream frames |  |
| `before_agent_start` | `hook:beforeRequest` | adapt | built-in 1, example 8, test 7 | Inject a starting custom message and replace the system prompt for the run | durable beforeRequest runs on every request attempt including recovery, not once per run |
| `agent_start` | `product-api` | keep | built-in 1, example 4, test 2 | Agent run started |  |
| `agent_end` | `internal-view` | keep | example 3, test 5 | Agent run ended; no built-in extension consumer |  |
| `agent_before_settle` | capability: `settlement-entry-write` | adapt | test 3 | Before final settlement: appends arbitrary entries and may force one more provider request | durable onYield returns only {continue}, so it cannot append entries |
| `agent_settled` | `product-api` | keep | built-in 1, example 4, test 2 | Agent fully settled |  |
| `ui_prompt_start` | `product-api` | keep | built-in 1 | A UI prompt opened; the Herdr extension reports blocked state here |  |
| `ui_prompt_end` | `product-api` | keep | built-in 1 | A UI prompt closed; the Herdr extension clears blocked state here |  |
| `turn_start` | `product-api` | keep | built-in 1, example 5 | Turn started |  |
| `turn_end` | capability: `settlement-entry-write` | adapt | example 5, test 1 | Turn boundary: appends arbitrary entries and may force another turn | durable onYield returns only {continue}, so it cannot append entries |
| `message_start` | `internal-view` | keep | test 1 | Message started; no extension consumer |  |
| `message_update` | capability: `streaming-channel` | adapt | none | Token-by-token assistant updates; streamed by --mode json and rendered by the TUI | a documented non-interactive interface consumes this, so it cannot be reduced |
| `message_end` | capability: `message-rewrite` | adapt | example 1, test 6 | Replace the finalized message of any role, including user, toolResult, and custom | durable afterResponse observes the assistant message and returns void |
| `tool_execution_start` | `internal-view` | keep | none | Tool execution started; streamed by --mode json and rendered by the TUI |  |
| `tool_execution_update` | capability: `streaming-channel` | adapt | none | Partial tool output; streamed by --mode json and rendered by the TUI | a documented non-interactive interface consumes this, so it cannot be reduced |
| `tool_execution_end` | `internal-view` | keep | none | Tool execution finished; streamed by --mode json and rendered by the TUI |  |
| `model_select` | `internal-view` | keep | example 1, test 1 | Model changed for the session |  |
| `thinking_level_select` | `drop` | drop | none | Thinking level changed | no consumer anywhere in the repository; drop unless a release note records the removal |
| `tool_call` | `hook:beforeTool` | adapt | built-in 1, example 5, test 8 | Argument replacement with first-block-wins; arguments are fixed after intent |  |
| `tool_result` | `hook:afterTool` | adapt | example 1, test 4 | Result replacement over content, details, structuredContent, isError, and usage | the field mapping onto durable's tool result type is unverified |
| `user_bash` | `product-api` | keep | example 4, test 2 | Supply custom shell operations or fully handle a user ! command |  |
| `input` | `product-api` | keep | example 3, test 6 | Input pipeline: continue, transform, or handled |  |

<!-- END GENERATED: events -->

### Capabilities durable must add

<!-- BEGIN GENERATED: capabilities -->

| Capability | What durable must add |
| --- | --- |
| `phased-request-transform` | Two ordered request transforms with different visibility, plus restoration of prompt and tool state between them. |
| `provider-payload-hook` | A hook over the assembled provider request body, distinct from the model messages. |
| `provider-header-hook` | A hook that can read and mutate outgoing provider headers. |
| `provider-response-observe` | Observation at the point status and headers arrive, before the stream is consumed. |
| `streaming-channel` | Bounded per-event delivery for streamed deltas, with ordering and backpressure rules. |
| `message-rewrite` | Rewriting a finalized message of any role before it is committed. |
| `settlement-entry-write` | Appending arbitrary entries and forcing another request at the settlement boundary. |
| `compaction-result-fidelity` | A compaction hook that returns a kept-entry boundary, details, and usage, not only a summary string. |

<!-- END GENERATED: capabilities -->

`provider-response-observe` and `provider-header-hook` overlap: both sit between the request and the
first streamed frame. They are listed separately because they may be satisfiable by one hook with two
call sites, and merging them is a design decision for N1 rather than a fact this note can settle.

### Non-event API

<!-- BEGIN GENERATED: api -->

| API | Category | Destination | Decision | Nyan semantics |
| --- | --- | --- | --- | --- |
| `registerTool` | registry | `product-api` | keep | Register a tool with its schema and renderer |
| `registerCommand` | registry | `product-api` | keep | Register a slash command |
| `registerShortcut` | registry | `product-api` | keep | Bind a key to an action |
| `registerFlag` | registry | `product-api` | keep | Declare a CLI flag and its value shape |
| `getFlag` | registry | `product-api` | keep | Read a declared flag value |
| `registerMessageRenderer` | rendering | `product-api` | adapt | Render a custom message type |
| `registerMarkdownTransformer` | rendering | `product-api` | adapt | Transform markdown before rendering |
| `registerEntryRenderer` | rendering | `product-api` | adapt | Render a custom entry type |
| `registerToolRenderer` | rendering | `product-api` | adapt | Render a tool call and result |
| `sendMessage` | write | `product-api` | adapt | Append a custom message, optionally starting a turn |
| `sendUserMessage` | write | `product-api` | adapt | Append a user message, optionally starting a turn |
| `appendEntry` | write | `product-api` | adapt | Append an opaque custom entry |
| `setSessionName` | write | `product-api` | adapt | Rename the session |
| `getSessionName` | read | `product-api` | keep | Read the session name |
| `setLabel` | write | `product-api` | adapt | Label an entry |
| `exec` | effect | `product-api` | keep | Run a subprocess and capture its result |
| `getActiveTools` | read | `product-api` | keep | List the active tool names |
| `getAllTools` | read | `product-api` | keep | List every available tool |
| `getSettings` | read | `product-api` | keep | Read the effective settings |
| `setActiveTools` | write | `product-api` | adapt | Replace the active tool set |
| `getCommands` | read | `product-api` | keep | List registered slash commands |
| `setModel` | write | `product-api` | adapt | Switch the session model |
| `getThinkingLevel` | read | `product-api` | keep | Read the thinking level |
| `setThinkingLevel` | write | `product-api` | adapt | Set the thinking level |
| `registerProvider` | registry | `product-api` | adapt | Register a model provider |
| `unregisterProvider` | registry | `product-api` | adapt | Remove a model provider |
| `registerMcpServer` | registry | `product-api` | keep | Register an MCP server |
| `unregisterMcpServer` | registry | `product-api` | adapt | Remove an MCP server |
| `getMcpServers` | read | `product-api` | keep | List registered MCP servers |
| `registerVirtualModel` | registry | `product-api` | adapt | Register a virtual model |
| `unregisterVirtualModel` | registry | `product-api` | adapt | Remove a virtual model |

<!-- END GENERATED: api -->

### Surface this note does not enumerate member by member

The first draft stopped at `on(...)` and `ExtensionAPI` methods, which is not the whole surface that
has to move. These areas are recorded here so N1 and N2 do not discover them late. They are not
enumerated member by member because their members are product shapes rather than a subscription list,
and each needs its own design pass.

<!-- BEGIN GENERATED: extra-surface -->

| Area | Decision | What moves |
| --- | --- | --- |
| ExtensionUIContext | adapt | Dialog, status, widget, header, footer, editor, and autocomplete surface available to extensions. |
| ExtensionContext and tool/command/replaced-session contexts | adapt | Abort, session and tree operations, reload, and nested-tool capability handed to handlers. |
| ToolDefinition contract | adapt | exposure, reachesTools, prepareLoadout, executionMode, renderers, and structured output; durable declares a different tool contract. |
| Resource loading | adapt | Skills, prompt templates, themes, images, and their discovery precedence. |
| MCP lifecycle | adapt | Connection, authentication, and resource tools across server changes and session lifecycle. |
| Session tree and fork | adapt | Branch summarization, tree switching, and fork behaviour the prototype README excludes. |
| Non-interactive event interface | keep | --mode json streams message_update and tool events; the roadmap requires that interface not to regress. |

<!-- END GENERATED: extra-surface -->

### Prototype inventory

`packages/coding-agent/src/experimental/durable/` already runs a durable coding agent with SQLite
storage, Nyan's model runtime, auth, settings, theme, keybindings, and TUI components, plus
subagents, `/agents`, the task graph, and `/compact`. It is excluded from the build and no product
entry point reaches it.

The decisions below are about the source, not about its behavior. A README claim is not verification
evidence, and neither is the existence of a file. The prototype README states plainly what it does
not cover, including fork and tree behavior, which is why those appear as unfinished work above.

<!-- BEGIN GENERATED: prototype -->

| File | Decision | Lines | Purpose |
| --- | --- | --- | --- |
| `harness-setup.ts` | promote | 117 | HTTP, settings, coding registry, execution envs, initial model |
| `main.ts` | promote | 20 | Entry point: parse --continue, open the runtime, run the TUI |
| `model-runtime-adapter.ts` | promote | 1 | Re-export of the model runtime adapter |
| `prompt.ts` | promote | 74 | Nyan's system prompt as a durable extension with cached resources |
| `README.md` | rework | 66 | Prototype documentation; claims must be re-verified before promotion |
| `runtime.ts` | rework | 369 | Harness composition, SQLite storage, view and controller boundary |
| `sessions.ts` | rework | 56 | Session directory, lock, and --continue selection |
| `subagent.ts` | promote | 55 | Foreground subagent as a child conversation owned by the call |
| `tui.ts` | rework | 658 | Durable TUI; superseded by the P9 rewrite |

<!-- END GENERATED: prototype -->

### Session directory, lock, and `--continue` policy

Two different things are recorded here, and the first draft conflated them: what the prototype does
today, and what the product will do. Only the rows marked as policy are decisions.

| Item | Prototype behavior (verified) | Product policy |
| --- | --- | --- |
| Root | `getAgentDir()/experimental/durable-sessions` (`sessions.ts`) | `~/.nyan/agent/sessions-durable/` — the `experimental` segment is dropped; this is a decision, not an observation |
| Per-directory key | `sha256(realpath(cwd))` truncated to 24 hex characters (`sessions.ts`) | unchanged |
| Session directory | `<root>/<key>/<13-digit epoch ms>-<uuid>/` (`sessions.ts`) | unchanged |
| Database | `session.sqlite` in the session directory (`sessions.ts`, `runtime.ts`) | unchanged; WAL is unverified and must be confirmed in N1 |
| Lock | `proper-lockfile.lock(directory, { realpath: false })` (`sessions.ts`) | unchanged |
| Lock contention | 12 retries one second apart, then "Session is already open in another process" (`sessions.ts`) | unchanged |
| Stale lock | 10 seconds — this is the `proper-lockfile` default; `sessions.ts` does not set `stale` | must be confirmed as sufficient under load in N1 |
| `--continue` | newest directory matching `^\d{13}-[0-9a-f-]{36}$`, matched lexicographically (`sessions.ts`) | unchanged |
| Existing JSONL sessions | not read, not written by the prototype | preserved read-only at `~/.nyan/agent/sessions/`. Nyan does not read, rewrite, migrate, or delete them, and the durable path does not write into that tree (owner decision, 2026-10-15) |

### Gate

`npm run check:extension-surface` must pass before N1 starts, and it joins `npm run check` at that
point. It fails when:

- a subscription or an `ExtensionAPI` method has no JSON entry, names something the source no longer
  declares, or records the wrong declaration line;
- the number of subscription handlers in the interface body does not match the number of parsed
  subscriptions, which is how a declaration hidden behind a comment, or a second declaration sharing
  a line, is caught;
- a file under the prototype directory, at any depth, has no recorded decision;
- a `kind`, `timing`, `rerunnable`, `destination`, or `decision` value is outside its enum;
- a `hook:` destination names a hook durable does not declare;
- a `durable-capability` destination does not name a declared capability, or a declared capability is
  never required;
- an evidence string points at a missing file, a line past the end of the file, or — for the
  `types.ts` declaration of an event or API member — a line that does not name it.

The owner reviews this note and the JSON before the check is wired into `npm run check`.

### Open questions

Eleven events carry an open question; the full list is in the generated table above. They group into
four decisions that need an owner answer before N2:

| Decision | Affects | Why it cannot be settled here |
| --- | --- | --- |
| Does durable gain a bounded streaming channel, or do the streamed events arrive another way? | `message_update`, `tool_execution_update`, `provider_stream_event` | A documented non-interactive interface consumes the first two, so reducing them is a user-visible break. The owner has chosen to preserve them, which makes this new durable code with its own ordering and backpressure rules. |
| Does durable gain the phased request transform? | `context`, `context_with_system` | Nyan runs two ordered transforms with different visibility and restores prompt and tool state between them (`runner.ts:1294-1300`). The owner has chosen fidelity, so this is a durable capability rather than a merge into `beforeRequest`. |
| How is the settlement boundary expressed? | `agent_before_settle`, `turn_end` | These append arbitrary entries; `onYield` can only continue. Either durable widens the hook or the entries move elsewhere. |
| Which of the five events with no extension consumer are removed? | `thinking_level_select` and the four tool/message stream events | Removing an event is a user-visible change. Only `thinking_level_select` has no consumer at all, so it is the only safe `drop` today. |

## Alternatives considered

**Keep the current path and mount durable beside it.** Rejected by the owner. It preserves the JSONL
format and the extension surface unchanged, but it requires a snapshot and commit port between
`SessionManager` and durable, plus a second operation state machine whose recovery cannot be proven
by durable's own machinery.

**Map the events onto the hooks mechanically, by name.** Rejected, and the first draft of this note
is the evidence for why. Eight mappings were wrong in ways a name-level match hides: the objects
differ (`messages` versus the provider payload), the timing differs (every attempt versus once per
run), the return value differs (`void` versus a replacement), and the composition rule differs
(first-wins versus last-write-wins).

**Collect the prototype's README claims as the inventory.** Rejected. The same claim is not evidence,
and this repository's rule is that a source file or a design document is not proof that an entry
point works.

**Enumerate only `on(...)` and `ExtensionAPI`.** Rejected after review. That is 72 of the members but
not the whole surface; the UI context, handler contexts, tool contract, resources, MCP, and tree
behaviour are also affected.

**Skip the inventory and find the gaps during implementation.** Rejected. The surface is large enough
that an unrecorded gap becomes a mid-migration scope discovery, and nothing would stop a later
`ExtensionAPI` addition from going unmapped. The gate now catches that, including a declaration
hidden behind a comment.

## Consequences

What this buys:

- N1 and N2 start with a known scope: 3 hook destinations (one needing an extended hook), 11
  `durable-capability` members across 8 capabilities, 17 `product-api` members, 8 `internal-view`
  members, and 1 `drop`.
- The gate makes the mapping self-maintaining. Adding a subscription without recording its
  destination fails `npm run check`, and so does an evidence line that does not point at what it
  claims.
- The session path, lock, and `--continue` policy are separated into verified prototype behaviour and
  owner decisions, so a later reader can tell which is which.
- The cost estimate is now anchored in a review that rejected the first attempt, rather than in the
  author's own confidence.

What it costs:

- 8 capabilities that durable does not have and must gain before the parity claim holds. This is the
  single largest workstream in the migration and it is larger than the first draft suggested.
- An open question per capability until the owner answers the four decisions above.
- The classification is a judgement about semantics, not a mechanical extraction. Where the judgement
  is wrong, N2 discovers it, and the entry must be corrected rather than worked around.

What this note does not claim:

- That the prototype works. Its README claims interrupted-tool-call recovery, and that claim is
  unverified here. N1 verifies it.
- That the cost is dominated by the extension surface. The first draft asserted this and the review
  disagreed. The honest position is that the extension migration is large and the context work is
  also large, and neither can be sized until the four decisions above are answered.
- That the 8 capabilities are sufficient. They are what the current surface needs; the context work
  will add more.

## Verification

`npm run check:extension-surface` was run against the source and reported: 41 events, 31
`ExtensionAPI` members, 9 prototype files, 7 extra areas, 11 open questions, and 5 events with no
extension consumer.

Methods this note relies on and what they showed:

- `rg -n '^\s*on\(' packages/coding-agent/src/core/extensions/types.ts` finds 41 subscriptions;
  `rg -n 'on\(event:'` finds only 32, because nine declarations span lines. The first draft cited the
  second command and the wrong number.
- Counting `handler: ExtensionHandler<` (40) plus `handler: ProjectTrustHandler` (1) equals the 41
  parsed subscriptions. A bare `handler:` count is 42 because `registerShortcut` has one in its
  options object; that is why the gate counts the two subscription types specifically.
- The `ExtensionAPI` body boundary is the first line after the declaration that closes at column
  zero. Counting braces is not reliable: the body's doc comments contain braces inside prose and
  examples, and an earlier version of the check read `ExtensionVirtualModel.route` as a member.
- `wc -l packages/coding-agent/src/experimental/durable/*` reports 1416 lines across 9 files; the
  8 `.ts` files alone are 1350.
- Consumers were derived by matching `on("<event>"` across the package and bucketing by path:
  `src/extensions/` as built-in, other `src/` as core, `examples/` as example, and test paths. Five
  events match nothing.

Negative tests confirmed the gate fails rather than passing silently. Removing the `tool_call` entry
reported it as unclassified; setting its destination to `hook:notARealHook` reported an enum
violation; setting its line to `1` reported the mismatch; pointing its evidence at
`types.ts:1` reported that the line does not name it; and adding a second `on(...)` declaration to an
existing line, without shifting any line number, was caught by the handler-count cross-check. The
data was restored after each run, and `--write` then reported that the note tables already matched.
