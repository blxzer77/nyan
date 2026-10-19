# Durable TUI parity for 1.4.0

Status: proposed (R0 inventory of the release line opened by PR #95)
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
| `/settings` | `SettingsSelectorComponent` over `SettingsManager`, applying each change live | pending message | port R3 (the component is reusable: its inputs come from `SettingsManager`, the model runtime, and controller getters/setters) |
| `/model [provider/model]` | `ModelSelectorComponent`; argument seeds the search; saves a default model; groups by provider | `ListSelector` over `view.models`; R0 makes the argument seed the filter | port R3 for the picker's extra affordances; the picker itself is at parity (reduce #36) |
| `/tree` | `TreeSelectorComponent`: navigate branches, fork at a node, label nodes | none — durable conversations are linear | reduce: Decision #24. The TUI reports it |
| `/thinking [level]` | `ThinkingSelectorComponent`, or set a level from the argument | none (only `shift+tab` cycling) | port R3 |
| `/scoped-models` | `ScopedModelsSelectorComponent`: enable, order, save the cycle set | none | port R3 (component reusable; the cycle then feeds `ctrl+p`) |
| `/export [path]` | HTML by default, `.jsonl` when the path ends with it | none | port R2: `sessionOps.exportHtml` exists; add a JSONL export over the mapped entries |
| `/import <path.jsonl>` | Imports a JSONL session and resumes it | none — a durable session is SQLite, and legacy JSONL sessions are read-only (Decision #32) | reduce: new decision #34 (recommend refusing with a pointer to the legacy route) |
| `/share` | Exports JSONL plus HTML to a temporary directory and creates a secret gist with `gh` | none | port R2, subject to request #2 (`session-share.ts` is outside this line's files) |
| `/bug` | Consent, optional model summary, zip archive written to the cwd | none | port R2 from `core/bug-report.ts` (metadata, diagnostics, summary, archive) with the dialog glue in `modes/durable/` |
| `/copy` | Copies the last assistant text | none | port R2 |
| `/name [name]` | Sets or shows the session display name | none (`sessionOps.setSessionName` exists) | port R1, and show the name in the footer |
| `/session` | Session file, id, message counts, token totals, cost breakdown, cache-warming state | none (the footer shows totals) | port R1 as a read-only panel over `view` and `sessionOps.entries()` |
| `/changelog` | Renders the changelog markdown from the package | none | port R2 (pure: `parseChangelog`, `normalizeChangelogLinks`) |
| `/hotkeys` | Renders the active bindings and extension shortcuts | none | port R3, after the bindings themselves (the content depends on them) |
| `/fork` | User-message selector, then a fork and a switch | none (`sessionOps.forkMessages`/`fork`, `controller.switchConversation` exist) | port R1 |
| `/clone` | Forks at the newest entry | none (`sessionOps.clone` exists) | port R1 |
| `/trust` | `TrustSelectorComponent`, stores the decision in the trust store | none (the CLI asks once at startup through `ProjectTrustContext`) | port R3 |
| `/login [provider]` | `LoginDialogComponent` / `OAuthSelectorComponent` over auth storage | none | port R3 |
| `/logout` | OAuth selector in logout mode | none | port R3 |
| `/new` | New session in the same process | none | port R1 through the RPC `new_session` reopen path |
| `/compact [instructions]` | Compacts | parity | — |
| `/resume` | Session picker for the cwd, then switch | none | port R1 through the RPC `switch_session` reopen path; blocked on request #2 |
| `/reload` | Reloads keybindings, extensions, skills, prompts, themes, and context files | none | port R3 by reopening the same session directory without the cached services, which is what reloads extensions |
| `/quit` | Shuts down and prints the resume command | `ctrl+c` and `ctrl+d` exit; no `/quit`, no resume hint | port R1 |
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
| Prompt history | `tui.editor.cursorUp` browses submitted prompts; the TUI calls `editor.addToHistory` | the editor supports it, but nothing adds to the history | port R3 |
| Image and clipboard paste (`ctrl+v`) | Files on macOS, images, or text into the editor, and images attached to a prompt | none; `submit` takes text only | port R3 (`UserInput` already carries content parts) |
| External editor (`ctrl+g`) | `external-editor.ts`, 46 lines over the editor buffer | none | port R3 |
| Queue dequeue (`alt+up`) | Restores queued messages to the editor | none (`sessionOps.clearQueue` returns the texts) | port R3 |
| Extension shortcuts | `setupExtensionShortcuts`: extension-declared keys | `CustomEditor.onExtensionShortcut` is unset | port R3 |

### Keybindings

Actions the durable TUI binds today: `tui.input.submit`, `tui.input.newLine`, `tui.editor.*`,
`app.interrupt` (escape → abort), `app.exit` (ctrl+d), `app.clear` (ctrl+c → exit), `app.model.select`,
`app.thinking.cycle`, `app.tools.expand`, `app.message.followUp`.

| Action | Legacy behaviour | Destination |
| --- | --- | --- |
| `app.clear` (ctrl+c) | Clears the editor; a second press within 500 ms exits | port R3 (the durable TUI exits on the first press) |
| `app.message.copy` (ctrl+x) | Copies the selection in the tree, or the last assistant message | port R2 with `/copy` |
| `app.message.dequeue` (alt+up) | Restores queued messages | port R3 |
| `app.model.cycleForward` / `cycleBackward` (ctrl+p, shift+ctrl+p) | Cycles the scoped models | port R3 with `/scoped-models` |
| `app.suspend` (ctrl+z) | Suspends the process | port R3 |
| `app.editor.external` (ctrl+g) | Opens the external editor | port R3 |
| `app.clipboard.pasteImage` (ctrl+v) | Pastes files, images, or text | port R3 |
| `app.thinking.toggle` (ctrl+t) | Hides or shows thinking blocks | port R3 |
| `app.session.*` (new, tree, fork, resume, rename, delete, path/sort/filter) | Session picker and tree actions | port R1 for new/fork/resume; n/a for `tree`/`rename`/`delete` until the session picker supports them (the durable picker is R1's; see #36 and Decision #25) |
| `app.tree.*`, `app.models.*` | Tree navigation and scoped-model selector actions | n/a for tree (Decision #24); port R3 for `app.models.*` inside `/scoped-models` |
| `tui.altScreen.*`, `tui.select.*`, `tui.editor.*` | transcript navigation, list selection, editing | parity |

### Startup notices

| Item | Legacy | Durable today | Destination |
| --- | --- | --- | --- |
| Startup diagnostics | Shown as info/warning/error lines | notices from `openDurable` | parity |
| Model fallback and unavailable-model message | Shown at startup | notices | parity |
| Project trust prompt | Asked through the extension UI before loading project resources | `ProjectTrustContext` from the CLI | parity (the prompt is the CLI's, not the TUI's) |
| Project trust warning line | Printed when the project is untrusted and has resources | none | port R3 |
| Changelog popup | Renders the new sections once after an update, collapsible via `collapseChangelog` | none | port R3 |
| Version update check | `checkForNewNyanVersion`, notice with the new version | none | port R3 |
| Package update check | `DefaultPackageManager` check, notice | none | port R3 |
| Crash notice | `takeUnnotifiedCrash`: offers `/bug` with the recorded crash | none | port R3 |
| tmux keyboard warning | `checkTmuxKeyboardSetup` | none | port R3 |
| Loaded resources listing | Skills, prompts, themes, extensions with source tags and diagnostics | none (diagnostics only) | port R3 |
| Terminal title | `APP_TITLE - session name - cwd`, updated on rename | only when an extension sets it | port R3 |
| Theme file watcher | Re-renders on theme file change | `InteractiveThemeController` handles themes; no watcher | port R3 |
| Git branch watcher | Footer branch display | none | port R3 with the footer |
| Terminal progress (`showTerminalProgress`) | Progress indicator in the terminal during a turn | none | port R3 |

### Footer and status

| Item | Legacy footer | Durable footer | Destination |
| --- | --- | --- | --- |
| cwd | `~`-relative | absolute path | port R3 |
| Git branch | ` (branch)` | none | port R3 |
| Session name | `• name` | none | port R1 with `/name` |
| Token and cost totals | `↑ ↓ R W $` | parity | — |
| Cache hit rate | `CH 42.0%` | none | port R3 |
| Context percentage | `45.2%/128k`, warning above 70%, error above 90% | parity (error above 90% only) | port R3 for the 70% tier |
| Auto-compaction marker | `(auto)` | none | port R3 |
| Subscription marker | `$0.123 (sub)` | none | port R3 |
| Routed model | `model → routed model` | none | port R3 |
| Provider prefix | `(provider)` when several providers are configured | none | port R3 |
| Extension statuses | One line, sorted | appended to the hint line | parity |
| Hint line | `!`, `!!`, `/` hints | `/model`, `/agents`, `/compact`, `/tasks` hints | port R2/R3 as the commands land |

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
footer and the resume hint on exit.

- A reopen seam in `modes/durable/main.ts`: it owns `openDurable`, so it exposes a host that can
  close the current open and open the next one with the previous `services`, exactly as RPC's
  `new_session` and `switch_session` do. The TUI re-subscribes to the new view, re-binds its
  extension UI context to the new runner, and repaints. Services are not reloaded (S2), and
  `session_shutdown`/`session_start` are emitted by the reopen itself.
- `/fork` reuses `sessionOps.fork` and `controller.switchConversation`; the fork lifecycle events are
  already emitted by G1b. `/clone` is `sessionOps.clone`.
- `/session` is a read-only panel from `view` and `sessionOps.entries()`; it must not claim a cache
  warming status the durable path does not render (that surface is N9's).
- `/resume` needs a lister for the current cwd's durable sessions. `core/durable/sessions.ts` is
  r-fix's file, so this batch asks for one exported function rather than duplicating the directory
  policy (request #2).

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

### R3 — settings, account, keybindings, startup (`r-tui-r3-settings`)

`/settings`, `/thinking`, `/scoped-models`, `/trust`, `/login`, `/logout`, `/reload`, `/hotkeys`,
then the keybindings and startup surfaces marked "port R3" above.

- `/reload` reopens the same session directory without the cached services, which is the only way
  extensions reload on this path.
- The settings selector, scoped-model selector, trust selector, OAuth selector, and login dialog are
  reused from `modes/interactive/components/`. Where a component asks for an `AgentSession` getter,
  the durable equivalent comes from `view`, `controller.get*()`, and `settings`.
- When R3 merges, `PENDING` is empty and the R0 test's table covers every built-in command as
  runnable.

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
2. **A durable session lister for `/resume`.** `core/durable/sessions.ts` (r-fix's file) owns the
   `sessions-durable/<sha256(cwd)[0..24]>` layout. R1 needs one exported function that lists the
   sessions of a cwd with their metadata; duplicating the hash and the name pattern in the TUI would
   give the layout two owners.
3. **`/share` and `/bug` file allowance** — see decision #35.

## Verification of this batch

- `test/durable-tui-commands.test.ts`: 39 cases pass under vitest.
- Mutation checks: removing `/quit` from the command list fails its case; removing the name guard
  sends four prompt-path cases to a command; removing the pending lookup fails the two pending-message
  cases.
- tmux, loopback `openai-completions` provider, temporary HOME: `/settings`, `/export out.html`, and
  `/tree` print their messages with no provider request recorded, while a plain prompt is sent.
  `!echo bash-ok` still reaches the provider — that is R2's work, recorded as it is.
