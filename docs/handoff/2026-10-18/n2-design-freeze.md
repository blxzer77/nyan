# N2 design freeze: tasks D, C, B (2026-10-16)

Author: N2 session. Read-only investigation; no code changed for this document. Baseline: `origin/main` at `ca47fe014`
(PR #30 merged). Everything below was read in the source of `D:\nyan-n2` unless it says "not verified".

## 0. Status of the four decisions

| # | Question | Status |
| --- | --- | --- |
| 1 | Project trust on the durable path | **Approved by the orchestrator: option (a)**, reuse the legacy trust resolution |
| 2 | Which flags task D lifts from the legacy route | Waiting for the orchestrator |
| 3 | Decision #24: fork / clone / tree / switch_session semantics | Waiting; to go to the owner (section 6) |
| 4 | Extension UI on the durable TUI: scope | Waiting for the orchestrator |

## 1. Facts that shape the design

1. **One entry for four modes.** TUI, print, json, and rpc all call `openDurable` (`core/durable/runtime.ts`).
   Its `ModelRuntime.create()` (around line 157) takes no agent-dir paths and no extension providers. That line is
   why `--provider cliproxyapi` fails with `Unknown provider` on the durable path.
2. **Providers do not need a runner.** `createAgentSessionServices` (`core/agent-session-services.ts`) does:
   `DefaultResourceLoader.reload()` runs the extension factories; they queue `pendingProviderRegistrations`,
   `pendingNativeProviderRegistrations`, `pendingVirtualModelRegistrations` on the shared `ExtensionRuntime`;
   the function flushes them into `ModelRuntime.registerProvider*` and calls `refresh({ allowNetwork: false })`.
   No `ExtensionRunner` and no session exist at that point. Task D can reuse exactly this.
3. **Route flags.** `canRunDurableProductPath` (`main.ts:149-181`) sends about 25 flags to the legacy path:
   `--extension`, `--no-extensions`, `--no-mcp`, `--skill(s)`, `--no-skills`, prompt-template and theme flags,
   `--no-context-files`, `--system-prompt`, `--append-system-prompt`, `--tools`, `--exclude-tools`, `--no-tools`,
   `--no-builtin-tools`, `--models`, `--tui-mode`, project-trust override, `--session`, `--session-id`, `--resume`,
   `--fork`, `--session-dir`, `--no-session`, `--name`, `@file`, more than one message (interactive).
   With no flag the durable path is taken and loads no extension at all.
4. **The runner is bound to `AgentSession`.** `new ExtensionRunner(extensions, runtime, cwd, sessionManager,
   modelRegistry)` needs the concrete `SessionManager` class (runner.ts:400, exposed as `ctx.sessionManager`);
   `bindCore` takes `ExtensionActions` (`sendMessage`, `setModel`, `getActiveTools`, ...) that `AgentSession`
   implements (agent-session.ts:3416). The runner already has everything the adapter needs, publicly:
   `hasHandlers`, `emitContext`, `emitMessageEnd`, `emitBoundary`, `emitBeforeProviderRequest`,
   `emitBeforeProviderHeaders`, `emitToolCall`, `emitToolResult`, `emitBeforeAgentStart`. So task C needs no new
   runner method, only one type widening (`SessionManager` -> `ReadonlySessionManager` in the constructor).
5. **durable has its own `codemode` and `tool-search`** (`@ny4n/durable/codemode`, `/tool-search`:
   `createCodemodeExtension`, `createToolSearchExtension`; tools support `callers`, `deferred`, `control.addTools`).
   Nyan's built-in `codemode` and `tool-search` extensions (`replaceable: true`) should give way on the durable
   path, the way `--no-mcp` already disables the built-in `mcp` (`disabledBuiltinExtensions`).
6. **The durable TUI has four hard-coded slash commands** (`modes/durable/tui.ts:633-638`: `/model`, `/tasks`,
   `/agents`, `/compact`); RPC `get_commands` returns `[]`. Extension commands (`/fast`, `/pause`, `/continue`,
   `/cpa-*`) have no entry point on the durable path today.
7. **Extensions can be replaced by name at run time** (spec 7.5). "Rebuild the adapter extension when the handler
   set changes" is therefore allowed. The Nyan extension instances (and any state in their closures) must live
   outside the rebuilt wrapper (section 3, rule S2).
8. **The trust primitives are not in main.ts.** `resolveProjectTrusted` (`core/project-trust.ts:47`),
   `ProjectTrustStore` and `hasTrustRequiringProjectResources` (`core/trust-manager.ts`), and
   `createProjectTrustContext` (`cli/project-trust.ts`) are importable. Only the glue sits in `main.ts`'s
   `createRuntime` (about lines 876-912): first reload with `projectTrusted: false`, then resolve trust from the
   loaded extensions' `project_trust` handlers, cached per cwd.

## 2. File sets

Paths are under `packages/coding-agent/src` unless noted.

### Task D: durable path loads providers and resources

| Kind | Files |
| --- | --- |
| New | `core/durable/services.ts`: `createDurableServices(...)` returning `{ modelRuntime, resourceLoader, settingsManager, diagnostics }`. It builds the `ModelRuntime` with the agent-dir `auth.json` and `models.json` paths, runs `ResourceLoader.reload()` with the trust glue (decision 1), flushes provider registrations, and returns the diagnostics. |
| Edited, small | `core/durable/runtime.ts`: only the `ModelRuntime.create()` line and the settings/registry creation lines; `OpenDurableOptions` gains the resource options. `core/durable/harness-setup.ts`: install durable's codemode and tool-search, and let the built-in ones give way. `core/durable/prompt.ts`: skills and context files come from `resourceLoader` instead of `loadSkills` / `loadProjectContextFiles` (honours `--skill`, `--no-skills`, extension-discovered resources). `main.ts`: lines 149-182 and 740-815 only. |
| Not touched | `core/durable/model-runtime-adapter.ts` (the narrow port stays), `core/extensions/*`, `core/agent-session-services.ts` (legacy), anything under `modes/`. |

What D delivers on its own: `--provider cliproxyapi` resolves; skills, prompt templates, and themes are discovered
through the loader; durable's codemode and tool-search are installed; project trust behaves as in legacy; extension
factories load without error. What D cannot deliver alone: extension tools registered by MCP (they register on
`session_start`, which needs a runner) and every extension event or command. Those are task C.

### Task C: extension adapter

| Kind | Files |
| --- | --- |
| New | `core/durable/extension-host.ts`: builds an `ExtensionRunner` from D's services, binds `ExtensionActions` and `ExtensionContextActions` on the durable controller, supplies a `ReadonlySessionManager` facade over conversation entries, emits the host events (`session_start`, `session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, `model_select`, `thinking_level_select`, `turn_start`, `message_*`, `tool_execution_*`) from the committed `AgentEvent` stream and the view. `core/durable/extension-adapter.ts`: the durable extension bridging runner handlers to hook members; registers a member only when `runner.hasHandlers(...)`. `core/durable/extension-tools.ts`: Nyan `ToolDefinition` -> durable `ToolRegistration` (`callers`, `deferred`, `replay`, schema, renderer stays host-side). `core/durable/extension-commands.ts`: slash command dispatch. |
| Edited, small | `core/extensions/runner.ts`: constructor parameter type only. `core/durable/runtime.ts`: one `registry.install(adapter)` plus `close()` and the UI-binding hand-over. `modes/durable/tui.ts`: slash dispatch and the `ExtensionUIContext` binding (scope: decision 4). |
| Not touched | `json-events.ts`: `--mode json` and `--mode rpc` events keep coming from the committed `AgentEvent` stream; the adapter is a live side channel. |

Mapping the adapter must implement (corrects the brief; see `n2-t3-cpa-acceptance.md` for the CPA use case):

| Nyan event | durable member or mechanism |
| --- | --- |
| `context` | `transformConversation` (copy the list, detect mutation, return the copy) |
| `context_with_system` | not a hook: stays with the adapter (system sections are the Harness's) |
| `message_end` (assistant) | `rewriteMessage`; other roles stay observers fed from the event stream (Decision #23a) |
| `turn_end`, `agent_before_settle` | `onBoundary` (`turn_end`, `settle`) |
| `tool_execution_update` | `onToolUpdate` |
| `before_provider_request` | `beforeProviderRequest` |
| `before_provider_headers` | `beforeProviderHeaders` |
| `after_provider_response` | `afterProviderResponse` |
| `provider_stream_event` | `onProviderStreamEvent` (adapter adds `provider`, `api`, `model` from the hook's `model`) |
| `message_update` | `onStreamEvent` |
| **`tool_call`, `tool_result`** | **`beforeTool`, `afterTool` (existing hooks; missing from the brief)** |
| **`before_agent_start`** | **`beforeRequest`, first request of a run only (missing from the brief; dedupe needed)** |
| **`session_before_compact`** | **`beforeCompact`** |
| `agent_settled`, `agent_end`, `model_select`, `session_*`, `input`, `user_bash`, ... | host events or product API, not hooks |

### Task B: JSON/RPC product APIs

| Kind | Files |
| --- | --- |
| New | `core/durable/session-ops.ts`: queue clearing, retry abort, user bash, fork / clone / tree / entries / export / name. |
| Edited | `modes/durable/rpc.ts` (12 commands); `core/durable/runtime.ts` (`DurableController` interface and object, `OpenDurableResult`). |
| Not touched | `modes/durable/json-events.ts`, `rpc-types.ts` (types are read-only inputs). |

Per command:

| Command | Proposal |
| --- | --- |
| `clear_queue` | Implement: `abortSubmission` for each queued inbox item; return the cleared steering and follow-up texts like legacy. |
| `abort_retry` | Check first whether a retry wait can be cancelled on its own (`live.generation.retry`). If not, record a reduction. |
| `bash`, `abort_bash` | Implement with the execution env's `exec` plus a recorded entry kind. Open question: does it enter the model context (legacy: `bashExecution` message unless `excludeFromContext`)? Largest item of B. |
| `get_entries` | Implement: map durable entries to the legacy entry shape. |
| `get_tree` | durable has no `parentId` tree. Return the active linear chain with head markers; record a reduction (Decision #24). |
| `fork`, `clone`, `get_fork_messages`, `switch_session` | Decision #24. |
| `export_html` | Implement: convert entries to the exporter's input. |
| `set_session_name` | Implement: store the name in the session directory metadata. |

## 3. Seams and rules

- **S1 `runtime.ts` is shared.** D, C, and B each edit it. Each edits only its own anchors (D: model runtime and
  registry creation; C: one install line, `close()`, UI hand-over; B: `DurableController` and result type). Merge order
  D, C, B; textual conflicts are resolved by keeping each side's block.
- **S2 Extension state lives in the Nyan extension instance, never in the durable wrapper.** The adapter wrapper can be
  rebuilt at will; the runner and the loaded extensions are created once per process and survive `replaceSession`
  (RPC `new_session`). Otherwise per-process state such as CPA's quota-poller throttle resets and a rejected key is
  sent again. This is a rule for D (services created once, passed into every `openDurable`) and for B's
  `replaceSession`.
- **S3 C uses D's services**, specifically `resourceLoader.getExtensions()`. C branches after D merges, or writes
  against the `createDurableServices` return type agreed here.
- **S4 B is independent of D and C** except for `runtime.ts` (S1). It may start from main at the same time as D.
- **S5 Registration is the cost switch.** A member is registered only when the runner has a handler for the matching
  event (`HookRunner.has()` turns the feature and its cost on). When the handler set changes (extension reload, runner
  rebind), the adapter is re-installed under the same name.
- **S6 MCP acceptance sits in C.** D verifies that the MCP factory loads without error; MCP tools appear only after
  `session_start` through a bound runner.

## 4. Constraints from the Bun commit `595dc4c5d` (read from `D:\nyan-bun`)

- `main-binary-update-cleanup.test.ts` runs `main(["--version"])` with `./runtime.ts`, `utils/binary-update.ts`,
  `utils/windows-self-update.ts`, and `package-manager-cli.ts` mocked. It needs, in order: `runAuthCommand`, the
  Windows quarantine cleanup, `cleanupBinaryUpdateLeftovers` only when `isBunBinary` (imported from `./runtime.ts`),
  `cleanupManagedInstall`, `handlePackageCommand`, then the `--version` exit. All edits of D are after that exit.
- `extension-loader-runtime.test.ts` mocks `jiti` and `jiti/static` and depends on `loader.ts` keeping `isBundledNode`
  and `isBunBinary` as load-time snapshots from `./runtime.ts`. D and C do not edit `loader.ts`.
- `image-resize-runtime.test.ts` depends on the `runningUnderBun()` branch in `utils/image-resize.ts`. Nobody edits it.
- Merge rule when imports collide in `main.ts`: keep the `./runtime.ts` import.

## 5. The four decisions

### Decision 1: project trust (approved: option a)

Today the durable path never loads project extensions, because any extension flag sends the call to legacy. Once D
loads extensions by default, `.nyan/extensions` of the working directory would run code.

| Option | Behaviour | Cost |
| --- | --- | --- |
| **(a) Reuse the legacy resolution (approved)** | First `reload()` with `projectTrusted: false`; resolve trust from the loaded extensions' `project_trust` handlers with `resolveProjectTrusted` (stored decision, `--trust` override, default, interactive prompt before the TUI starts), cached per cwd; reload if trusted. Same outcomes as legacy. | The glue now exists twice (legacy `createRuntime` and D). Keep legacy untouched; test the same three cases on both: stored decision, undecided and interactive, undecided and non-interactive. |
| (b) User-level and built-in extensions only | Route a call with undecided project trust to legacy. | Silent behaviour split; the extension surface differs by directory. |

Reason for (a): it is the only option with legacy behaviour, and the primitives are already importable.

### Decision 2: which flags D lifts from the legacy route

| Option | Lifts | Leaves on legacy |
| --- | --- | --- |
| **Recommended** | Resource flags: `--extension`, `--no-extensions`, `--no-mcp`, `--skill`, `--no-skills`, `--prompt-template`, `--no-prompt-templates`, `--theme`, `--no-themes`, `--no-context-files`, `--system-prompt`, `--append-system-prompt`, project-trust override | `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools` (tool selection, task C); `--models` and `--tui-mode` (named follow-ups or reductions); `@file` and several messages; and every session-selection flag |
| Everything | All of the above including session selection | Needs durable semantics for `--session`, `--resume`, `--fork`, `--session-dir`, `--no-session`, `--name` first |
| Minimum | Only what `--provider cliproxyapi` needs | Leaves the N2 gate ("functional parity") mostly open |

Reason for the recommendation: the resource flags are exactly what D builds; the others each need a decision of their
own. **Open question for the owner**, not mine to settle: do the session-selection flags stay on legacy for good
(legacy JSONL read-only, N1 decision), or must N2 cover them? It decides how the gate "functional parity on the
durable path" is read.

### Decision 3: Decision #24 (section 6)

### Decision 4: extension UI on the durable TUI

| Option | Scope | Cost |
| --- | --- | --- |
| **Recommended: subset first** | Slash dispatch plus `ctx.ui.notify`, `setStatus`, `select`, `confirm`, `input`, and `ctx.hasUI`, `ctx.model`, `ctx.signal`. This covers the first real use case (CPA uses `ctx.ui`, `ctx.model`, `ctx.signal`, `ctx.hasUI`, `ctx.force`, `ctx.allowNetwork`, never `ctx.sessionManager`). Everything else goes on a reduction list. | The reduction list needs an owner decision before the N2 gate can close. |
| Full `ExtensionUIContext` | widgets, header, footer, editor, autocomplete, custom components, themes | Large; belongs to the N9 TUI rewrite more than to N2 |

Reason: N9 rewrites the TUI; building the full surface into the current durable TUI is likely to be rewritten.

## 6. Decision #24 (proposed text for the owner)

**Problem.** Five legacy RPC commands assume the session is a tree of entries in one file, with a current session file
the client can switch.

- `fork { entryId }` returns `{ text, cancelled }` and makes the fork the current session; `clone` the same from the
  current leaf; `get_fork_messages` lists the user messages one can fork from; `switch_session { sessionPath }`
  loads another session file; `get_tree` returns entries with parent ids.
- durable stores a flat entry list per conversation with `head` markers and `edits`, no `parentId`. `Conversation.fork(at)`
  creates a **new conversation inside the same session**, not a new session. There is no operation that copies a
  conversation into another session directory.
- Trace of the difference: an RPC client calls `fork`, then `get_state`. Legacy answers with a new `sessionFile` and
  `sessionId`. With `Conversation.fork` the answer keeps the old `sessionFile` and `sessionId`; only the conversation
  differs.

**Candidates.**

| | Behaviour | Client-visible change | Cost |
| --- | --- | --- | --- |
| **A (recommended)** | `fork` and `clone` call `Conversation.fork(at)` and switch the controller to the new conversation; `get_fork_messages` lists user entries; `switch_session` opens another session directory (same as `new_session`'s reopen); `get_tree` returns the active chain with head markers. Document that the session id and file do not change on fork, and that the tree is linear. | `sessionFile` and `sessionId` stay on fork; no branches in `get_tree`. | Small. |
| B | `fork` and `clone` create a new durable session directory seeded with the entries up to the cut. | Matches legacy (new `sessionFile`). | New durable capability: copy a conversation across storages, including documents and usage ledger; large. |
| C | The five commands stay `unavailable` with a stable error code on the durable path. | The commands are gone for default invocations. | None; but the N2 gate needs the reduction recorded, and the parity claim for `--mode rpc` is weaker. |

**Recommendation: A**, with `get_tree` recorded as a reduction. B is a candidate for N3 or later if a client needs new
session files. If the owner chooses C, B (the RPC task) shrinks accordingly.

## 7. Verification plan per task

- **D.** In a temp HOME with `HOME`, `USERPROFILE`, `NYAN_CODING_AGENT_DIR` all pointing there (otherwise the
  `~/.pi` fallback leaks), a fake `cliproxyapi.json`, and a loopback HTTP stub: `--provider cliproxyapi --model x`
  gets past provider resolution on the durable path; the error becomes a connection or auth error from the stub, not
  `Unknown provider`. Same for `-p`, `--mode json`, `--mode rpc`. Trust: three cases. Skills, prompts, themes: loaded
  through the loader and visible. Mutation checks on each. `check:extension-surface`.
- **C.** The CPA acceptance cases in `n2-t3-cpa-acceptance.md`. Mutation check per bridged member: remove the bridge,
  see a test fail.
- **B.** One test per command through `--mode rpc` with the faux provider; the three event types (`message_update`,
  `tool_execution_*`, `thinking_level_select`) unchanged.
- Not run by me: the full suites. The machine is shared.

## 8. Risks not verified

- Cost of `ResourceLoader.reload()` on startup of the durable path; there is a startup timer in legacy, none here.
- Whether the Harness accepts new tools after open when MCP registers them on `session_start`; the basis is spec 7.5
  (same-name replacement), not a run.
- The CPA dependency list was written against an old main (see `n2-t3-cpa-acceptance.md`).
