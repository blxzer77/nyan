# Sessions and Context

Nyan saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Nyan saves sessions automatically unless you start it with `--no-session`.

```bash
nyan --continue
nyan --resume
```

`--continue` opens the most recent session for the current working directory: its newest durable session, or, when the directory has only legacy JSONL sessions, the newest of those read-only, with a warning that the file will not be written. A directory with neither starts a new session. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Nyan keeps two session stores. A session Nyan creates now is a **durable** session, a SQLite database in its own directory under `~/.nyan/agent/sessions-durable/`. A session created before 1.4.0 is a **legacy JSONL** file under `~/.nyan/agent/sessions/`; Nyan reads those files but never writes to them.

The session flags follow the store they name:

- `--continue` continues the current directory's newest durable session, as described above. It only reads the durable store to decide, so a run in a directory without sessions leaves nothing behind.
- `--resume` lists the legacy JSONL sessions and opens the one you choose read-only. `--session` opens the path, exact ID, or partial ID it names read-only; a match in another project offers to fork it, and that fork is written as a new JSONL session.
- `--session-id`, `--fork`, `--session-dir`, `--no-session`, and `--name` keep the compatibility route and its JSONL storage. `--session-id` opens an existing ID read-only or creates that ID, `--fork` writes the forked session as a new JSONL file, `--name` records the name in the JSONL session, `--session-dir` chooses where the JSONL store is, and `--no-session` keeps the session in memory.

Durable session selection, so that these flags can address durable sessions, is not part of 1.4.0.

`/import <path>` has no durable form. A durable session is a SQLite directory rather than a JSONL file, and 1.4.0 does not import JSONL into a durable session, so the command answers with the route that does work: `nyan --session <path>` opens that legacy file read-only, and `nyan --resume` opens a legacy session from the current directory.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## What a start shows

A durable session, which is what the default interactive mode opens, says the same things a legacy session says at start, in its transcript and its terminal title:

- The terminal title is `Nyan - <session name> - <directory>`, and it follows `/name`; without a name it is `Nyan - <directory>`.
- A new release and package updates are announced with the command that applies them.
- After an upgrade, the changelog sections newer than the version you last ran are shown once, unless the session already has messages. `collapseChangelog` reduces that to one line.
- A crash the previous run recorded is reported once, with a pointer to `/bug`, which attaches the details.
- A project that is not trusted while it holds project resources is reported once, with a pointer to `/trust`.
- The resources that loaded (context files, skills, prompts, extensions) are listed unless `quietStartup` hides them. A resource the loader could not read is always reported.
- Inside tmux, a keyboard setup that cannot carry modified keys is reported with the setting to change.

The footer shows the working directory relative to your home directory, the session name, the token and cost totals, the context usage with `(auto)` while automatic compaction is on, `(sub)` when the provider bills a subscription, and the model. With several providers configured the model carries its provider, and a virtual model shows the physical model that answered last as `→ model`. A fork or clone is named `fork <id>` there and in `/agents`, so it is not mistaken for a subagent's conversation.

## Choose how to branch

Nyan stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, Nyan can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. Nyan combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Nyan Works](how-nyan-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, Nyan normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

A durable session lives in `~/.nyan/agent/sessions-durable/<working-directory-hash>/<timestamp>-<session-id>/`. The directory holds `session.sqlite` and a `session.json` that records the working directory and the display name, so both survive a restart. The hash names the working directory, so each project keeps its own store, and the store's location is not configurable.

Legacy JSONL sessions stay where earlier releases wrote them, under `~/.nyan/agent/sessions/`, grouped by working directory. Use `--session-dir`, `NYAN_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to point the JSONL store somewhere else; the CLI option has highest precedence. Nyan opens a JSONL session read-only and never migrates it, so its file is never changed by a newer Nyan.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after Nyan exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it as a private GitHub gist through the GitHub CLI. When `NYAN_SHARE_VIEWER_URL` names a viewer, the link opens the gist there.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a report you can inspect and share yourself. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. Nyan writes the report as a zip archive in the current directory; nothing is uploaded.
