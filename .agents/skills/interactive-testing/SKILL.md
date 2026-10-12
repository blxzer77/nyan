---
name: interactive-testing
description: Test and debug nyan's interactive mode in a controlled tmux terminal. Use for TUI behavior checks and for smoke-testing a published release.
---

# Testing nyan interactive mode with tmux

tmux needs Linux, macOS, or WSL. Native Windows has no scriptable terminal here: run the steps inside WSL, or ask the user to check the behavior by hand.

A prompt that reaches a model uses the user's provider credentials and spends tokens. Ask which provider and model to use before submitting one. `NYAN_OFFLINE=1` turns off startup network activity (version check, catalog refresh) so the run depends only on the model call.

Run the TUI from source, from the repo root:

```bash
tmux new-session -d -s nyan-test -x 80 -y 24 -c "$PWD"
tmux send-keys -t nyan-test "NYAN_OFFLINE=1 node scripts/nyan-source.mjs" Enter
sleep 3 && tmux capture-pane -t nyan-test -p     # capture after startup
tmux send-keys -t nyan-test "your prompt here" Enter
tmux send-keys -t nyan-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t nyan-test
```

`scripts/nyan-source.mjs` runs the TypeScript sources without a build. To test what ships, run `npm run build:offline` and use `node packages/coding-agent/dist/bundle/cli.js` instead.

## Release smoke test

Install the published package into an empty directory and run it with a scratch home, so the check sees what a new user sees:

```bash
dir=$(mktemp -d) && cd "$dir"
npm install --ignore-scripts --no-audit --no-fund @ny4n/coding-agent@<version>
HOME="$dir/home" ./node_modules/.bin/nyan --version
tmux new-session -d -s nyan-release -x 80 -y 24 -c "$dir"
tmux send-keys -t nyan-release "HOME=$dir/home ./node_modules/.bin/nyan" Enter
```

Check that `--version` prints the released version and that the run creates `~/.nyan` in the scratch home. Then log in or provide a key, submit a prompt, and wait for the model's reply: startup alone is not a passing smoke test.
