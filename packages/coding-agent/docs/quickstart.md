# Quickstart

Nyan runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Nyan

Install Nyan from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @ny4n/coding-agent
```

Nyan does not require dependency lifecycle scripts for a normal npm installation.

Verify the installation:

```bash
nyan --version
```

### Standalone executable (without Node.js)

Every [release](https://github.com/blxzer77/nyan/releases/latest) also attaches a standalone executable that includes its own runtime. Download the archive for your system:

| System | Archive |
| --- | --- |
| Linux, macOS | `nyan-linux-x64.tar.gz`, `nyan-linux-arm64.tar.gz`, `nyan-darwin-x64.tar.gz`, `nyan-darwin-arm64.tar.gz` |
| Windows | `nyan-windows-x64.zip`, `nyan-windows-arm64.zip` |

Extract it and run `nyan` (`nyan.exe` on Windows) from the extracted folder, or add that folder to your `PATH`. Keep the folder together: the executable reads its themes, documentation, and native helpers from beside itself, so copying `nyan` somewhere else breaks them.

- **Check the download.** Compare `sha256sum <archive>` (macOS: `shasum -a 256 <archive>`, Windows: `Get-FileHash <archive>`) with the line for your archive in the release's `SHA256SUMS`. The checksum detects a damaged download. It does not prove who built the file.
- **macOS.** The executable is not signed or notarized. A file downloaded in a browser carries a quarantine mark, and macOS may refuse to open it. Remove the mark with `xattr -dr com.apple.quarantine nyan/`. Files downloaded with `curl` are not marked.
- **Windows.** SmartScreen may warn about an unsigned executable. Unblock the archive before extracting it with `Unblock-File nyan-windows-x64.zip`, or choose **More info**, then **Run anyway**.
- **Updating.** `nyan update` downloads the archive for your system from the release, checks it against `SHA256SUMS`, and replaces the files in the extracted folder. It needs write access to that folder and `tar` (Windows 10 and later include one). `NYAN_RELEASE_BASE_URL` points it at a mirror.

## 2. Start Nyan

Change to the folder you want Nyan to work with, then start it:

```bash
cd /path/to/folder
nyan
```

The working folder helps Nyan discover relevant files, instructions, and configuration. Nyan also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Nyan running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Nyan in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Nyan's responses. A **provider** is the service or account Nyan uses to access that model.

In Nyan, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Nyan a task

Nyan shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Nyan finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Nyan saves sessions automatically. Exit Nyan, then resume the most recent session for the same working folder with:

```bash
nyan --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Nyan interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Nyan should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Nyan

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Nyan persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Nyan package](packages.md) |

## Uninstall Nyan

If you installed Nyan with npm, run:

```bash
npm uninstall -g @ny4n/coding-agent
```

Uninstalling does not remove configuration, credentials, sessions, or installed Nyan packages from `~/.nyan/agent/`.
