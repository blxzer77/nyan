# Run Nyan in Herdr

[Herdr](https://herdr.dev) is a terminal workspace manager for coding agents. Like tmux it keeps panes alive in a background server, and it adds a sidebar that shows the state of every coding agent across your projects.

Nyan reports its own state to Herdr, so the sidebar shows `working`, `blocked`, or `idle` for a Nyan pane, and Herdr notifies you when Nyan finishes a turn or needs an answer.

## What Herdr shows

| Nyan state | When Herdr shows it |
| --- | --- |
| `working` | Nyan is running a turn |
| `blocked` | Nyan is waiting on a dialog, such as a confirmation or a question |
| `idle` | Nyan is ready for input |
| *(no agent)* | Nyan quit, so the pane is an ordinary shell again |

Herdr also stores the command that reopens the session, so restarting the Herdr server brings the pane back in the same directory with the conversation restored.

## Requirements

Nothing to install. The integration ships inside Nyan and turns itself on only when it detects a Herdr pane: Herdr sets `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_BIN_PATH` for every process it starts. Outside Herdr it does nothing.

To turn it off, disable the `herdr` built-in extension in `nyan config`.

## Use it

Run Nyan in a Herdr pane as usual:

```bash
herdr          # start or attach to the Herdr session
nyan           # run Nyan in a pane
```

## Check what Herdr sees

Herdr only names agents it started itself with `herdr agent start`. A Nyan you launch by hand has no name, so target it by pane id instead:

```bash
herdr pane list                  # find the pane id, for example w1:p1
herdr pane get w1:p1             # show its agent and state
herdr agent list                 # every agent Herdr tracks
```

To operate the agent by name, give it one first:

```bash
herdr agent rename w1:p1 reviewer
herdr agent get reviewer
```

## Differences from Herdr's built-in agents

Herdr recognizes some agents, such as Claude Code and Codex, by their process and screen output. Nyan is not one of them; it reports its own state instead. Two consequences:

- `herdr agent start --kind nyan` does not exist. Start Nyan yourself in a pane.
- Nyan sends the reports it can observe. Its state comes from Nyan's own events, not from reading the screen, so it does not depend on Herdr learning Nyan's interface.

Herdr restarts remain manual for `working` state: if the Herdr server stops while Nyan is running a turn, that turn is lost, because Herdr restores the pane by running the resume command again.
