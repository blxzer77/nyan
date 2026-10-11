# Nyan

Nyan is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use Nyan for software development, research notes, writing projects, data files, or hobby work. You can use Nyan as is, prompt it to adapt itself to your workflow, or build other applications powered by Nyan using the SDK.

## Start using Nyan

New to Nyan? Follow the [Quickstart](quickstart.md) to install Nyan, connect a model, and complete your first task.

If Nyan is already installed, choose what you want to do:

- [Use Nyan interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure Nyan](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how Nyan works](how-nyan-works.md), including tools, context, sessions, and the agent loop.

## Customize Nyan

Nyan can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-nyan) to select the smallest mechanism that meets your need.

## Automate or embed Nyan

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate Nyan process.
- Use the [TypeScript SDK](sdk.md) to run Nyan inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

Nyan's tools and extensions run with the permissions of the Nyan process. Project trust controls which project resources Nyan loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
