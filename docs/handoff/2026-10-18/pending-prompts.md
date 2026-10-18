# Pending prompts — do not dispatch during reinstall pause

These are continuation instructions, not an authorization to start work. The owner had not sent them when the system-reinstall pause began.

## N2 continuation

Start from the latest `origin/main` and read `ROADMAP.md` plus the N2 reports in this directory. Finish the remaining N2 task-C batch-3 work: durable slash commands and UI subset, `before_agent_start` message/system-prompt effects, prompt templates, `agent_end`, `model_select`, `ctx.sessionManager`, and the remaining coding-agent adapter mapping. Restore `--extension`, `--theme`, and `--prompt-template` to the durable route only after their durable implementations and tests exist. Then complete task B's JSON/RPC product APIs. Keep the current explicit unavailable responses until each API has an implementation and acceptance evidence. Do not reopen login work. Preserve the two-line WIP rule and update `ROADMAP.md` in each merged change.

Use isolated HOME and caches for tests. Do not use real `~/.nyan`, credentials, or provider endpoints. OCR is not a merge condition; append unresolved findings to the preserved backlog. Before any full suite, coordinate the single-run lock. Check `git status` and `gh pr view --json mergeable` before pushing. Never use `git add -A`, `git reset --hard`, `git clean`, or force-push.

## Bun continuation

Start from the latest `origin/main` and read `ROADMAP.md`, `bun-phase3-design.md`, and `bun-phase3-progress.md`. Begin Phase 3 batch 5 only: source-loader smoke under Bun for `scripts/nyan-source.mjs --version` and offline `--list-models`, investigation/fix of the `node:module.registerHooks` path, subprocess kill-tree/output evidence, and worker-lifecycle evidence. Do not begin Phase 4 or the deferred Windows CI/undici-loading work.

Use isolated HOME and caches, and coordinate full-suite runs. Do not modify the system certificate store or global configuration. The system-CA experiment is complete and the test certificate was removed. Check for junctions/reparse points before removing any worktree; never use `git worktree remove --force` on a directory containing a junction. OCR is not a merge condition. Push and open a PR only after the owner resumes this line; merge only with the existing authorization and a green Merge gate.

## Stop condition

When N2 and Bun reach the release-ready checks recorded in `2026-10-18-reinstall.md`, stop and report readiness. Do not version, tag, publish, or create a release without explicit owner authorization.
