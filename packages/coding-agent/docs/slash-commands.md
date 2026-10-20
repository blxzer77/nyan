# Slash commands

Type `/` in Nyan's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current Nyan release.

Extensions, prompt templates, and skills can add commands. The command menu in Nyan is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |
| `/cpa-refresh` | Force refresh the CLIProxyAPI model catalog |
| `/cpa-models [id]` | List CLIProxyAPI models with limits and overrides, or view one model in detail |
| `/cpa-pin [id]` | Toggle pin for a model, ensuring it stays in the catalog |
| `/cpa-hide [id]` | Toggle visibility for a model in the picker |
| `/cpa-show [id]` | Surface a model marked hidden by the catalog |
| `/cpa-doctor` | Show CLIProxyAPI provider configuration and diagnostics |
| `/cpa-usage [reset]` | Show token usage, estimated cost, time to first token, and throughput for the session |
| `/cpa-quota` | Show the 5 hour and weekly plan quota of the accounts behind CLIProxyAPI |
| `/cpa-overrides [show\|init]` | Show or seed the model overrides file |
| `/fast` | Toggle Fast mode (priority service tier) |
| `/pause`, `/continue` | Pause or resume provider requests |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Switch to another saved session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import and resume a JSONL session |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Nyan developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Nyan processes |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Nyan |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.

## Durable sessions

The default session store is durable, and a few commands behave differently there.

| Command | On a durable session |
|---|---|
| `/reload` | Closes and reopens the same session without the services already loaded, which is what reloads extensions and the resources they read. The transcript, name, and conversation are kept. The command waits while a response or a compaction is running. |
| `/scoped-models` | The set also filters the `/model` list for this process. Saving it writes `enabledModels`, which the next start reads. |
| `/settings` | The default model a new session starts with is saved here, since `/model` selects a model for the current session only. |
| `/hotkeys` | Lists the keys this interface binds; a key only the legacy interface binds is left out instead of listed as working. |
| `/tree` | Not available: a durable conversation is linear, so there are no branches to navigate (Decision #24). |
| `/import <path>` | Not available: a durable session is not a JSONL file. Read a legacy session with `nyan --session <file>`, or start the newest one with `nyan --resume` (Decision #34). |
