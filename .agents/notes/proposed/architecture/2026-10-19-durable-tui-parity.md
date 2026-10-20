# Durable TUI parity for 1.4.0

Status: proposed (R0 inventory, R1 and R2 merged, R3a ported; R3b and R3c remain)
Line: `prompts/r-tui.md`, worktree `nyan-n2`, branch `r-tui-r0-inventory`.
Reference: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (legacy TUI) and
`packages/coding-agent/src/modes/durable/tui.ts` (default interactive mode since N1).

## Problem

N1 made the durable TUI the default interactive mode. It answered four commands itself — `/model`,
`/tasks`, `/agents`, and `/compact` — and passed every other submitted line to
`controller.submit`, which sends it to the provider as a prompt. The legacy TUI answers 24 built-in
commands (`BUILTIN_SLASH_COMMANDS`) and `!`/`!!` user bash.

A user of the default mode who types `/settings` or `!echo bash-ok` therefore pays for a model
request and sends the command text to the provider. Both were reproduced in tmux before this batch
(`/settings`: prompt text `"!echo bash-ok"` recorded by a loopback provider; see the report
`reports/r-tui-r0.md`).

The parity work is split into three batches after this inventory: R1 session commands, R2 user bash
and output commands, R3 settings, account, keybindings, and startup surfaces.

## What R0 already changed

`src/core/durable/commands.ts` (new) decides what one submitted line is, before anything else looks
at it:

- a command name from `DURABLE_TUI_COMMANDS` is either **runnable** (`model`, `compact`, `tasks`,
  `agents` today) or **pending**, and a pending command answers with a message instead of being
  submitted;
- everything else stays on the prompt path, so extension commands, prompt templates, and prompts
  behave as before.

`PENDING` holds one entry per command this build does not run; `DurableRunnableCommand` is derived
from it (`Exclude<DurableTuiCommand, keyof typeof PENDING>`), so removing an entry turns the TUI's
dispatch switch into a compile error until the command has a handler. The TUI shows a pending
command's message in its notice area. `/tree` reports its Decision #24 reduction there.

This closes the "a command is paid for as a prompt" half of the release blocker for all 24 built-ins
now, rather than at the end of R3. `test/durable-tui-commands.test.ts` pins the contract: for every
`BUILTIN_SLASH_COMMANDS` entry, with and without an argument, the route is never `prompt`.

## Baseline: what the durable TUI already does

Verified in source, not assumed:

| Area | Durable TUI today |
| --- | --- |
| Transcript | Renders user, assistant (streaming), tool-result, compaction, reset, and boundary `custom_message` entries from `Conversation.viewState()`; tool cards are the legacy `ToolExecutionComponent` renderers |
| Editor | The legacy `CustomEditor` (multiline via `tui.input.newLine`, cursor/word/jump/page movement, yank, undo), with the working indicator in its top border |
| Full-screen navigation | `TuiAltScreen` provides `tui.altScreen.*`: page/half-page/line scrolling, transcript search, previous/next prompt, top/bottom |
| Status | Working, retrying (with attempt and error), deferred response, compacting, and running-tool status in the editor border |
| Panels | Task graph (`/tasks`), inbox queue, notices (view notices plus extension `notify`) |
| Commands | `/model`, `/compact [instructions]`, `/tasks`, `/agents`, then extension commands |
| Extension UI | The five-method subset (`notify`, `setStatus`, `select`, `confirm`, `input`) plus `setTitle`, `getTheme`, `getToolsExpanded`/`setToolsExpanded` (Decision #28) |
| Settings | Theme from `SettingsManager` (light/dark pairs resolved against terminal colors), terminal capability overrides, keybindings reloaded from `KeybindingsManager.create()` |
| Lifecycle | `session_start`/`session_shutdown`, extension events, cache warming, compaction, retries, abort |

## Inventory

Destination values: **parity** (already there), **port** (batch named), **reduce** (decision named),
**n/a** (reason given).

### Built-in slash commands

| Command | Legacy behaviour | Durable today | Destination |
| --- | --- | --- | --- |
| `/settings` | `SettingsSelectorComponent` over `SettingsManager`, applying each change live | ported (R3a) | ported (R3a): the shared dialog over `SettingsManager`, the model runtime, and controller getters/setters, plus a **Default model** item the durable TUI supplies |
| `/model [provider/model]` | `ModelSelectorComponent`; argument seeds the search; saves a default model; groups by provider | `ListSelector` over the runtime's model catalog, filtered by the enabled set; R0 makes the argument seed the filter | reduce #36: the picker stays a list, and the default model is saved from `/settings` (R3a) |
| `/tree` | `TreeSelectorComponent`: navigate branches, fork at a node, label nodes | none — durable conversations are linear | reduce: Decision #24. The TUI reports it |
| `/thinking [level]` | `ThinkingSelectorComponent`, or set a level from the argument | ported (R3a) | ported (R3a): a level from the argument, or `ThinkingSelectorComponent`, with `ctrl+s` saving the default |
| `/scoped-models` | `ScopedModelsSelectorComponent`: enable, order, save the cycle set | ported (R3a) | ported (R3a): `ScopedModelsSelectorComponent`; the set filters `/model` now and feeds the `ctrl+p` cycle in R3b |
| `/export [path]` | HTML by default, `.jsonl` when the path ends with it | none | port R2: `sessionOps.exportHtml` exists; add a JSONL export over the mapped entries |
| `/import <path.jsonl>` | Imports a JSONL session and resumes it | none — a durable session is SQLite, and legacy JSONL sessions are read-only (Decision #32) | reduce: new decision #34 (recommend refusing with a pointer to the legacy route) |
| `/share` | Exports JSONL plus HTML to a temporary directory and creates a secret gist with `gh` | none | port R2, subject to request #2 (`session-share.ts` is outside this line's files) |
| `/bug` | Consent, optional model summary, zip archive written to the cwd | none | port R2 from `core/bug-report.ts` (metadata, diagnostics, summary, archive) with the dialog glue in `modes/durable/` |
| `/copy` | Copies the last assistant text | none | port R2 |
| `/name [name]` | Sets or shows the session display name | none (`sessionOps.setSessionName` exists) | port R1, and show the name in the footer |
| `/session` | Session file, id, message counts, token totals, cost breakdown, cache-warming state | none (the footer shows totals) | port R1 as a read-only panel over `view` and `sessionOps.entries()` |
| `/changelog` | Renders the changelog markdown from the package | none | port R2 (pure: `parseChangelog`, `normalizeChangelogLinks`) |
| `/hotkeys` | Renders the active bindings and extension shortcuts | ported (R3a) | ported (R3a): the keys this TUI binds plus extension shortcuts, leaving out keys only the legacy TUI binds |
| `/fork` | User-message selector, then a fork and a switch | none (`sessionOps.forkMessages`/`fork`, `controller.switchConversation` exist) | port R1 |
| `/clone` | Forks at the newest entry | none (`sessionOps.clone` exists) | port R1 |
| `/trust` | `TrustSelectorComponent`, stores the decision in the trust store | ported (R3a) | ported (R3a): `TrustSelectorComponent` over the same trust store |
| `/login [provider]` | `LoginDialogComponent` / `OAuthSelectorComponent` over auth storage | ported (R3a) | ported (R3a): the provider picker and `LoginDialogComponent`, as legacy shows them |
| `/logout` | OAuth selector in logout mode | ported (R3a) | ported (R3a) |
| `/new` | New session in the same process | none | port R1 through the RPC `new_session` reopen path |
| `/compact [instructions]` | Compacts | parity | — |
| `/resume` | Session picker for the cwd, then switch | none | port R1 through the RPC `switch_session` reopen path; blocked on request #2 |
| `/reload` | Reloads keybindings, extensions, skills, prompts, themes, and context files | ported (R3a) | ported (R3a): `DurableSessionOwner.reload()` closes the session and reopens its directory without the cached services, restoring the session with those services if that open fails |
| `/quit` | Shuts down and prints the resume command | `ctrl+c` and `ctrl+d` exit; no `/quit`, and the resume hint is dropped (durable sessions cannot be named on the command line, Decision #25) | port R1 |
| `/tasks`, `/agents` (durable only) | — | parity | — |
| `/debug`, `/arminsayshi` (not in `BUILTIN_SLASH_COMMANDS`) | Writes a render dump; plays an easter egg | none | n/a: undocumented and tied to the main-screen renderer; no user-facing contract to keep |

### User bash

| Item | Legacy | Durable today | Destination |
| --- | --- | --- | --- |
| `!cmd` | `handleBashCommand`: `user_bash` first, then `executeBash` with the extension's operations or result, output streamed into a `BashExecutionComponent` | RPC `bash` does all of this; the TUI does not route `!` | port R2 |
| `!!cmd` | The same, with the result kept out of the model context | as above | port R2 |
| Bash output entry | A `bashExecution` entry renders as a card, also after a resume | the entry is written by `controller.executeBash`, but `#addEntry` renders no `bashExecution` kind | port R2 |
| Running guard | Refuses a second command while one runs; `esc` cancels | `controller.abortBash` exists | port R2 |
| Bash mode in the editor | `!` prefix switches the editor border and quoting for pasted paths | none | n/a for 1.4.0: cosmetic; record as a Queue follow-up |

### Editor input

| Item | Legacy | Durable today | Destination |
| --- | --- | --- | --- |
| Multiline | `shift+enter`, `ctrl+j`, `enter` submits | parity (the shared `Editor`) | — |
| Slash-command and argument completion | `CombinedAutocompleteProvider`: built-ins, prompt templates, extension commands, skills, model and thinking arguments | none | reduce: Decision #28 defers autocomplete to N9 |
| `@` file and path completion | same provider, `fd`-backed | none | reduce: Decision #28 |
| Prompt history | `tui.editor.cursorUp` browses submitted prompts; the TUI calls `editor.addToHistory` | the editor supports it, but nothing adds to the history | port R3b |
| Image and clipboard paste (`ctrl+v`) | Files on macOS, images, or text into the editor, and images attached to a prompt | none; `submit` takes text only | port R3b |
| External editor (`ctrl+g`) | `external-editor.ts`, 46 lines over the editor buffer | none | port R3b |
| Queue dequeue (`alt+up`) | Restores queued messages to the editor | none (`sessionOps.clearQueue` returns the texts) | port R3b |
| Extension shortcuts | `setupExtensionShortcuts`: extension-declared keys | `CustomEditor.onExtensionShortcut` is unset | port R3b |

### Keybindings

Actions the durable TUI binds today: `tui.input.submit`, `tui.input.newLine`, `tui.editor.*`,
`app.interrupt` (escape → abort), `app.exit` (ctrl+d), `app.clear` (ctrl+c → exit), `app.model.select`,
`app.thinking.cycle`, `app.tools.expand`, `app.message.followUp`.

| Action | Legacy behaviour | Destination |
| --- | --- | --- |
| `app.clear` (ctrl+c) | Clears the editor; a second press within 500 ms exits | port R3b (the durable TUI exits on the first press) |
| `app.message.copy` (ctrl+x) | Copies the selection in the tree, or the last assistant message | port R2 with `/copy` |
| `app.message.dequeue` (alt+up) | Restores queued messages | port R3b |
| `app.model.cycleForward` / `cycleBackward` (ctrl+p, shift+ctrl+p) | Cycles the scoped models | port R3b with the scoped set `/scoped-models` now keeps |
| `app.suspend` (ctrl+z) | Suspends the process | port R3b |
| `app.editor.external` (ctrl+g) | Opens the external editor | port R3b |
| `app.clipboard.pasteImage` (ctrl+v) | Pastes files, images, or text | port R3b |
| `app.thinking.toggle` (ctrl+t) | Hides or shows thinking blocks | port R3b |
| `app.session.*` (new, tree, fork, resume, rename, delete, path/sort/filter) | Session picker and tree actions | port R1 for new/fork/resume; n/a for `tree`/`rename`/`delete` until the session picker supports them (the durable picker is R1's; see #36 and Decision #25) |
| `app.tree.*`, `app.models.*` | Tree navigation and scoped-model selector actions | n/a for tree (Decision #24); `app.models.*` work inside `/scoped-models` (R3a) |
| `tui.altScreen.*`, `tui.select.*`, `tui.editor.*` | transcript navigation, list selection, editing | parity |

### Startup notices

| Item | Legacy | Durable today | Destination |
| --- | --- | --- | --- |
| Startup diagnostics | Shown as info/warning/error lines | notices from `openDurable` | parity |
| Model fallback and unavailable-model message | Shown at startup | notices | parity |
| Project trust prompt | Asked through the extension UI before loading project resources | `ProjectTrustContext` from the CLI | parity (the prompt is the CLI's, not the TUI's) |
| Project trust warning line | Printed when the project is untrusted and has resources | none | port R3c |
| Changelog popup | Renders the new sections once after an update, collapsible via `collapseChangelog` | none | port R3c |
| Version update check | `checkForNewNyanVersion`, notice with the new version | none | port R3c |
| Package update check | `DefaultPackageManager` check, notice | none | port R3c |
| Crash notice | `takeUnnotifiedCrash`: offers `/bug` with the recorded crash | none | port R3c |
| tmux keyboard warning | `checkTmuxKeyboardSetup` | none | port R3c |
| Loaded resources listing | Skills, prompts, themes, extensions with source tags and diagnostics | none (diagnostics only) | port R3c |
| Terminal title | `APP_TITLE - session name - cwd`, updated on rename | only when an extension sets it | port R3c |
| Theme file watcher | Re-renders on theme file change | `InteractiveThemeController` handles themes; no watcher | reduce: #37 (N9) |
| Git branch watcher | Footer branch display | none | reduce: #37 (N9) |
| Terminal progress (`showTerminalProgress`) | Progress indicator in the terminal during a turn | none | reduce: #37 (N9) |

### Footer and status

| Item | Legacy footer | Durable footer | Destination |
| --- | --- | --- | --- |
| cwd | `~`-relative | absolute path | port R3c |
| Git branch | ` (branch)` | none | reduce: #37 (N9) |
| Session name | `• name` | none | port R1 with `/name` |
| Token and cost totals | `↑ ↓ R W $` | parity | — |
| Cache hit rate | `CH 42.0%` | none | reduce: #37 (N9) |
| Context percentage | `45.2%/128k`, warning above 70%, error above 90% | parity (error above 90% only) | reduce: #37 (N9) for the 70% tier |
| Auto-compaction marker | `(auto)` | none | port R3c |
| Subscription marker | `$0.123 (sub)` | none | port R3c |
| Routed model | `model → routed model` | none | port R3c |
| Provider prefix | `(provider)` when several providers are configured | none | port R3c |
| Extension statuses | One line, sorted | appended to the hint line | parity |
| Hint line | `!`, `!!`, `/` hints | `/model`, `/agents`, `/compact`, `/tasks` hints | port R3c, once the command list is final |

## Reductions that need no new decision

- `/tree` and `app.tree.*`: Decision #24 (durable conversations are linear).
- Slash, argument, `@` file completion: Decision #28 (autocomplete moves to N9).
- Extension widgets, header/footer replacement, editor replacement, and custom components:
  Decision #28. The durable TUI's notice area and five-method UI subset are what N2 keeps.
- Session-selection CLI flags: Decision #25. `/new` and `/resume` inside a session are this line's
  work; the flags stay on the legacy route.

## New owner decisions

Added to `ROADMAP.md` as #34–#36. Work on the reversible part continues with the recommendation.

| # | Question | Recommended | Blocks |
| --- | --- | --- | --- |
| 34 | What does `/import <path.jsonl>` do on the durable path, where a session is a SQLite directory and legacy JSONL sessions are read-only? | Refuse with a message that points at the legacy route (`nyan --resume`, `nyan --session <file>`), and keep JSONL→durable import out of 1.4.0. Importing would be a second migration path with its own recovery rules. | R2 (`/import`) |
| 35 | `/share` and `/bug` need the gist upload and bug-report flow in `modes/interactive/session-share.ts` and `modes/interactive/bug-report.ts`, which take an `AgentSession` and are outside this line's file allowance. May R2 extract the session-independent part of those files into `core/`, with legacy behaviour unchanged? | Yes: extract the gist upload and the archive assembly, and keep both TUI flows' dialogs in their own mode. If the extraction is refused, reduce `/share` and `/bug` to a "not available on the durable session yet" notice in 1.4.0. | R2 (`/share`, `/bug`) |
| 36 | The durable model picker is a filterable list; the legacy `ModelSelectorComponent` also saves a default model, groups by provider, and shows auth state. | Keep the list for 1.4.0 and take the richer picker with N9. Nothing is lost from `/model`'s ability to select a model, and the extra affordances are settings work (`/settings` saves defaults in R3). | R3 |

## Batch plan

The grouping below follows the note; where it differs from `prompts/r-tui.md`, the difference is
named. Each batch keeps the R0 invariant test green, deletes its `PENDING` entries, and adds TUI-level
behaviour tests.

### R1 — session commands (`r-tui-r1-session`)

`/new`, `/resume`, `/name`, `/session`, `/fork`, `/clone`, `/quit`, plus the session name in the
footer.

The resume hint legacy prints on exit is not ported: a durable session cannot be named on the command
line yet (Decision #25), and `--continue` opens the newest session of the directory, which is not
necessarily the one that just ended.

- A reopen seam in `modes/durable/main.ts`: it owns `openDurable`, so it exposes a host that can
  close the current open and open the next one with the previous `services`, exactly as RPC's
  `new_session` and `switch_session` do. The TUI re-subscribes to the new view, re-binds its
  extension UI context to the new runner, and repaints. Services are not reloaded (S2), and
  `session_shutdown`/`session_start` are emitted by the reopen itself.
- `/fork` reuses `sessionOps.fork` and `controller.switchConversation`; the fork lifecycle events are
  already emitted by G1b. `/clone` is `sessionOps.clone`.
- `/session` is a read-only panel from `view` and `sessionOps.entries()`; it must not claim a cache
  warming status the durable path does not render (that surface is N9's).
- `/resume` lists the siblings of the open session's directory, which are exactly the sessions of
  the same working directory, so no cwd hash is recomputed and `core/durable/sessions.ts` needs no
  change.
- A `/resume` reopens the target before the current session shuts down, so a bad path or a lock
  leaves the current session intact. `openDurable` gained `deferSessionStart` for that order: without
  it the new session's `session_start` reaches extensions before the old session's
  `session_shutdown`, which would undo the new session's extension state.

### R2 — user bash and output commands (`r-tui-r2-bash-io`)

`!cmd`, `!!cmd`, `/export`, `/import` (per #34), `/share`, `/bug`, `/copy`, `/changelog`.
`/hotkeys` moves to R3: its content is the binding list that R3 ports.

- `!` and `!!` take the same path RPC `bash` takes: `emitUserBash` first (an extension may replace
  the execution with operations or a finished result), then `controller.executeBash`, with the
  `BashExecutionComponent` streaming output. `!!` passes `excludeFromContext`.
- The transcript learns to render `bashExecution` entries, so a resumed session shows earlier
  commands.
- `/copy` and `app.message.copy` share one implementation.
- `/export` gains a JSONL variant over the same entry mapping `exportHtml` uses.

### R3 — split into three batches

R3 was too large for one branch, so it runs as R3a, R3b, and R3c (notice #10). R3a has landed; R3b and
R3c remain.

#### R3a — settings, account, and toolkit commands (`r-tui-r3a-commands`, ported)

`/settings`, `/thinking`, `/scoped-models`, `/trust`, `/login`, `/logout`, `/reload`, `/hotkeys`. The
settings dialog is the legacy component; the durable TUI supplies a **Default model** item (Decision #36)
and applies a change to the running session where this path has an equivalent. `/reload` reopens the
session's directory with freshly loaded services and restores the session with the loaded ones if that
fails. `/hotkeys` lists only the keys this TUI binds, so R3b adds its keys to the same table.

#### R3b — input and keybindings (`r-tui-r3b-input`)

Prompt history, image and clipboard paste (`ctrl+v`), the external editor (`ctrl+g`), queue dequeue
(`alt+up`), the model cycle (`ctrl+p` / `shift+ctrl+p`) over the scoped set, suspend (`ctrl+z`), the
thinking toggle (`ctrl+t`), extension shortcuts, and `ctrl+c` clearing the editor before the second press
within 500 ms exits.

#### R3c — startup and labels (`r-tui-r3c-startup`)

The version and package update notices, the changelog popup (`collapseChangelog`), the crash notice that
points at `/bug`, the project trust warning line, the loaded-resources listing, the tmux keyboard warning,
the terminal title, the footer's `~`-relative cwd and its remaining labels, and the fork/clone label that
R1 recorded: a forked or cloned conversation showed as `subagent N`.

### What the pre-split R3 plan required

Two requirements of the pre-split plan are met by R3a and carry over to R3b and R3c:

- `/reload` reopens the same session directory without the cached services, which is the only way
  extensions reload on this path.
- The settings selector, scoped-model selector, trust selector, OAuth selector, and login dialog are
  reused from `modes/interactive/components/`. Where a component asks for an `AgentSession` getter,
  the durable equivalent comes from `view`, `controller.get*()`, and `settings`.

When R3c merges, `PENDING` holds only the recorded reductions (`/tree`, `/import`) plus `/share` and
`/bug` if the release-fix line's F2b has not landed, so the R0 test covers every built-in command as
either runnable or answered with its reason.

## Test contract

`test/durable-tui-commands.test.ts` asserts, for every entry of `BUILTIN_SLASH_COMMANDS` and for each
with an argument appended, that `routeDurableInput` does not return `prompt`. It also pins the exact
routes for the runnable commands (including argument extraction), the exact pending message, the
`/tree` reduction message, and the prompt path for extension commands, unknown names, and bare text.

Each later batch adds behaviour tests at the TUI seam: drive the command against a real durable
session with the faux provider and assert the effect (session directory, session name metadata,
conversation switch, transcript entries, notices) — not a recorded call on a stub. A command that
only records "it called the controller" is not covered.

## Requests to the orchestrator

1. **RPC runner UI context after a reopen.** `modes/durable/rpc.ts` (not this line's file) binds the
   extension UI context once, before the first prompt; `new_session` and `switch_session` open a new
   `ExtensionRunner` and never re-bind it, so extension dialogs after a reopen run with
   `ctx.hasUI === false`. Filed as a finding, not fixed here.
3. **`/share` and `/bug` file allowance** — see decision #35.

## Verification of this batch

- `test/durable-tui-commands.test.ts`: 39 cases pass under vitest.
- Mutation checks: removing `/quit` from the command list fails its case; removing the name guard
  sends four prompt-path cases to a command; removing the pending lookup fails the two pending-message
  cases.
- tmux, loopback `openai-completions` provider, temporary HOME: `/settings`, `/export out.html`, and
  `/tree` print their messages with no provider request recorded, while a plain prompt is sent.
  `!echo bash-ok` still reaches the provider — that is R2's work, recorded as it is.

## R1 verification

- `test/durable-tui-session-commands.test.ts` (11 cases, Node and Bun) drives the real command layer
  against real durable sessions opened through `DurableSessionOwner`, with a recorded `DurableCommandUi`
  port: the display name is stored in `session.json` and reflected back, `/session` reports the session
  and its counts, `/fork` moves the conversation to the branch and stays put when the picker is
  cancelled, `/clone` copies the conversation, `/quit` asks the TUI to exit, `/new` opens a new
  directory and releases the previous session's lock, and `/resume` reopens the chosen directory after
  the previous session's shutdown. `test/durable-tui-commands.test.ts` (47 cases) also pins the exact
  route of the seven commands added here.
- Mutations, each failing a named test: deleting `deferSessionStart` and `startSession` from the
  resume path (the event-order case), not storing the name (the `/name` case), not switching to the
  forked conversation (the `/fork` case), and opening the new session without closing the previous
  one (the `/new` case).
- tmux, same loopback provider and temporary HOME: `/name release line` printed
  `Session name set: release line` and the footer showed the name, `/session` listed the session,
  its counts, tokens, and cost, `/clone` switched to the copy, `/new` cleared the transcript and the
  name, `/resume` listed only the other session of the directory and reopened it with its transcript
  and name, `/fork` listed the user messages and switched to the branch, and `/quit` returned to the
  shell. Every command produced zero provider requests.
- Not fixed, recorded: a forked or cloned conversation is labelled `subagent N` in the footer and in
  `/agents`, which is the label N2 task B2 recorded for a fork.

## R2 verification

- `!` and `!!` take the RPC `bash` path: `user_bash` first (a handler's `operations` run the
  command, a handler's `result` is recorded without running anything, and a handler that throws
  stops the command so this process's shell is never a fallback), then the durable executor
  streaming into a `BashExecutionComponent`. `test/durable-tui-bash.test.ts` (7 cases, Node and Bun)
  drives that flow against a real session: the entry's data, the model message `!` adds and `!!`
  omits, the exit code of a failing command, both handler answers, the throwing handler, and a next
  prompt that carries the command.
- `/export` writes HTML or legacy JSONL (`exportJsonl` on the session operations, over the same entry
  mapping the HTML export uses); `/copy` hands the newest assistant text to the clipboard port;
  `/changelog` renders the released sections oldest first, as legacy does.
  `test/durable-tui-session-commands.test.ts` grew to 16 cases for these.
- `/import` is a recorded prompt, not a port: a durable session is not a JSONL file (decision #34,
  recommendation applied until the owner answers).
- Mutations, each failing a named test: ignoring a `user_bash` result, dropping its `operations`, and
  falling back to the local shell after a throwing handler, and always exporting HTML.
- tmux: `!echo bash-ok` and `!!echo hidden` drew one card each with their output, `/export` wrote both
  files, `/copy` reported there is nothing to copy yet, `/changelog` rendered the changelog, and
  `/import` printed the pointer. No command sent a provider request.
- Found and fixed while verifying: a finished command was drawn twice (the live card and its
  `bashExecution` entry). The live card now stands for its entry instead of being drawn beside it.

## R3a verification

- `test/durable-tui-settings-commands.test.ts` (15 cases, Node and Bun) drives the commands against real
  durable sessions and the real settings manager: `/thinking` from an argument and from the picker, a
  level the model does not have, the settings dialog and each effect that reaches the session, the
  settings, or the terminal, the saved default model, the scoped set and its storage as patterns, the
  trust decision in the trust store, a reload that reloads extensions and keeps the transcript, a failed
  reload that leaves a live session which still takes a prompt, the hotkeys table, `/logout` with
  nothing stored, `/login` naming an unknown provider and cancelling at the picker, and the unavailable
  answer when the embedding passes no product surface. The routing test is 69 cases; the shared test
  scaffolding moved to `test/durable-tui-harness.ts`, which the R1 tests use too.
- Mutations, each failing a named case: no thinking-level validation, a steering-mode change that is not
  applied, a reload that reuses the cached services, a failed reload that leaves no session, scoped ids
  that ignore the settings, and a legacy-only key listed as working.
- tmux with a temporary HOME and a loopback `openai-completions` provider: `/hotkeys` rendered three
  tables; `/settings` opened the shared dialog with 33 items, the Default model submenu showed the
  current default, and Output padding changed from 1 to 0 and was written to `settings.json`;
  `/thinking high` set the level and the border and footer followed; the thinking picker marked the
  current level and the saved default; `/scoped-models` and `/model` listed only the enabled model;
  `/trust` wrote `{"/tmp/rtui-r3a": true}` to `trust.json`; `/logout` reported nothing stored; `/login`
  listed 51 providers and cancelled; `/reload` reopened the session and kept the transcript; `/settings`
  opened again after the reload; and a prompt was answered after it. The provider's request counter
  stayed at 0 until that prompt.
- Not verified: the `/reload` guards for a running response and a running compaction (no test drives a
  live generation, and the tmux run had none); the OAuth and API-key entry inside the login dialogs
  (they open a browser against a real provider — the picker, the cancel path, and the no-credentials
  path are verified); the TUI's own wiring in `runDurableTui`, which the tmux run covers end to end and
  no test drives; and Windows (no Windows host; the owner tracks Windows coverage separately).
