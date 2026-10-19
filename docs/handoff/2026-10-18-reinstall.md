# Reinstall handoff — 2026-10-18

## Scope

This handoff freezes the repository state before the owner's Windows reinstall. It is a continuation record, not a release authorization. The owner explicitly paused dispatching new prompts to the N2 and Bun sessions.

Current repository baseline: `origin/main` / `06497972c1398f5c1f847c799ad92b767230a189` (PR #57).

The next release target is **release-ready only**. Do not run `version:set`, create a release tag, publish npm packages, or create a GitHub Release without a later explicit authorization.

## Merged work

### Durable / N2

- #36 CI stability: `28ff7cfca96812ab90c58aa52c99cfdb62a3775a`
- #40 durable resources (task D): `519456b1ba4e52130f78decee31371fd684422fb`
- #46 task D regression fixes: `350da52f0173c2c896023ee32674179f59ecf3bc`
- #47 task C first batch: `96de1e0a92e0c91aeb74febf4d2c631b1f3c43de`
- #50 task C batch 2a, tool bridge and MCP: `f8fae5da3a7d36a11c779d860abbc79486c0056b`
- #54 task C batch 2b, durable codemode and tool search: `a616f5ee43ed2e5e29c64d9dcbec581f1e361c09`
- #56 task C batch 3 first slice: `f069d94692a7efbb298e477b9d1c0972cd39bc3b`

N2 is **not complete**. Remaining work is the rest of task C and task B:

1. durable slash commands and the UI subset;
2. `before_agent_start` message and system-prompt effects;
3. prompt templates and durable routing of `--extension`, `--theme`, and `--prompt-template` after their D-fix legacy fallback;
4. `agent_end` and `model_select` events;
5. `ctx.sessionManager` and the remaining coding-agent adapter mapping;
6. task B JSON/RPC product APIs, including the explicitly deferred unavailable commands.

The N2 gate remains open until C and B are verified. The next N2 prompt was drafted but **not sent** before the pause.

### CLIProxyAPI login

- #31 login verification fixes: `b1aa70b59e451d1d2405a0874e026e91fc492f33`
- #38 stored CLIProxyAPI key resolution: `c62d91fae68ea9e43b3e10762147ce1b659011ca`

The login line is closed. Pause-gate signal/unref and quota-throttle persistence were transferred to later work/backlog; do not reopen the login line during resume unless the owner explicitly requests it.

### Bun

- #32 Phase 2: `ed2fbf81277c7b90bd25461b1594c03675a8d89c`
- #33 publish dry-run fix: `6035deb9886f143772b6b349c4dfc7ea64a0461d`
- #35 Phase 3 batch 1: `2f6f3eb9a011281cbd03f04abeeb510f1e46c7f1`
- #48 Phase 3 batch 2 HTTP backend split and system-CA behavior: `f8416a835be12f81d8de69cf4df416352faff3d9`
- #57 Phase 3 batch 4 SQLite and Windows+Bun cleanup: `06497972c1398f5c1f847c799ad92b767230a189`

Bun Phase 3 batch 4 is complete. Batch 5 is **not started** and its prompt was **not sent** before the pause. The proposed batch 5 scope is source-loader smoke, subprocess kill-tree/output evidence, and worker-lifecycle evidence. Do not start Phase 4 from this handoff.

## Important incident

During #57, a temporary worktree contained a junction from `node_modules` to a real directory. `git worktree remove --force` followed the junction and deleted the real contents, including 1,895 tracked files, dependencies, and uncommitted batch-4 code. Recovery succeeded:

- the bad deletion commit was discarded;
- the tracked files were restored and verified complete;
- dependencies, model data, and offline build output were regenerated;
- batch-4 code was reconstructed and independently revalidated;
- #57 passed `npm run check`, Node/Bun durable tests, CI, and release dry run.

The incident affected only that temporary Bun worktree. Never use `git worktree remove --force` on a directory containing a junction/reparse point. Inspect reparse points first, and use explicit file paths rather than `git add -A` for checkpoints.

## Local branches preserved before reinstall

The old worktree `D:\nyan` had 68 dirty files. They were explicitly staged, checked by the repository hook, committed, and pushed:

- branch: `feat/durable-n1-close`
- commit: `057253dd7 chore: preserve pre-reinstall workspace changes`
- remote: `origin/feat/durable-n1-close`

This branch is based on an older durable migration point and must not be merged blindly into current `main`. It is a preservation branch for the local CI/workflow changes and generated model-data artifacts. Compare patches before reusing anything.

Other worktrees were clean and had no unpushed changes at handoff. `D:\nyan-bun` is the clean main worktree used for this handoff.

## Current blockers and backlog

- N2 task C and task B are the main durable release blockers.
- Bun Phase 3 batch 5 remains before the Bun line can close.
- OCR is not a merge condition. Unresolved OCR findings are collected for a later batch task.
- `tools-images` timing remains a high-priority flaky-test investigation. The earlier ratio-based fix was not stable under Deep verification.
- Bun legacy codemode `worker limit reached` remains recorded as test interference; do not change the worker limit without new evidence.
- The #57 Node-version difference around the exact `-2^63` SQLite read is recorded; the adapter preserves precision rather than asserting one Node minor's exception shape.
- Release dry runs have passed on the merged Bun work, but release readiness still requires the final N2/Bun gates on the current main.

The selected historical reports are in [`docs/handoff/2026-10-18/`](./2026-10-18/). The external coordination directory is not required after this handoff.

## Resume procedure on the new system

1. Clone the repository and fetch all branches:

   ```text
   git clone https://github.com/blxzer77/nyan.git
   cd nyan
   git fetch --all --prune
   ```

2. Use Node 24 and Bun 1.4.x. CI currently uses Bun 1.4.2; the Windows evidence used Bun 1.4.3.
3. Install without lifecycle scripts:

   ```text
   npm ci --ignore-scripts
   npm run hydrate:model-data
   npm run build:offline
   ```

4. Read `AGENTS.md`, this handoff, `ROADMAP.md`, and the selected reports before dispatching any new prompt.
5. Use an isolated test home and cache directory. Do not read, modify, or test against the real `~/.nyan`, provider credentials, `auth.json`, or real CLIProxyAPI endpoints.
6. Before running a full suite, coordinate through `D:\nyan-orchestration\load.md` if that coordination directory is recreated; only one session may run the complete suite at a time.
7. Continue only after confirming the owner still wants the N2 and Bun prompts sent. They were intentionally withheld during the reinstall pause.

User-level state such as `~/.nyan`, GitHub CLI authentication, npm authentication, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, proxy variables, and any private CA files is outside the repository and must be backed up separately by the owner. No credentials are included in this handoff.

## Release-ready stop condition

Stop and report when all of the following are true:

- N2 task C and task B are complete with repository evidence;
- Bun Phase 3 batch 5 and its gate are complete;
- the latest main passes `npm run check`, affected Node/Bun tests, CI Merge gate, and release dry run including Publish, binaries, and smoke;
- `ROADMAP.md`, `CHANGELOG.md`, user-facing docs, and unresolved-item records are current.

At that point report release readiness and wait. Do not version, tag, publish, or create a release without explicit authorization.
