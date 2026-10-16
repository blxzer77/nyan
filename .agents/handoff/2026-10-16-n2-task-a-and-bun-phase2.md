# Handoff: N2 task A and Bun Phase 2 (2026-10-16)

Transient. Delete this file when PR #30 has merged and the open items below are fixed or filed. The lasting decisions are in the [N2 hooks note](../notes/proposed/architecture/2026-10-16-durable-n2-capability-hooks.md), the [Bun runtime note](../notes/implemented/architecture/2026-10-16-bun-runtime-adapter-parallelization.md), `packages/durable/docs/spec.md` (7.2, 8.3, 8.5, 8.7), and `ROADMAP.md`.

## 1. Where everything is

- **PR #30** (`n2-durable-hooks` into `main`): https://github.com/blxzer77/nyan/pull/30. Based on `2a3f15500`. Commits: Bun Phase 2 runtime helpers, the chord abort fix, N2 task A (durable hooks), and a follow-up that adds this file and corrects the spec.
- **Pushed regardless of CI**, as requested. CI is red; see section 2. Merge only after it is green.
- **Worktrees on this machine.**
  - `/home/blxze/projects/personal/nyan-n2`: clean checkout of the PR branch. Commit and push from here.
  - `/home/blxze/projects/personal/nyan` (`main`): still holds the same changes as uncommitted edits, so it looks dirty. They duplicate the PR; discard them only after the PR is merged and `git diff n2-durable-hooks -- <path>` is empty for each path. Never run `git reset --hard`, `git checkout .`, `git clean -fd` or `git stash` there (repo rule).
  - In `nyan` there is also an untracked `.agents/notes/implemented/architecture/2026-10-16-cliproxyapi-model-ownership.md`. It belongs to the CLIProxyAPI line (another session, already pushed as `2a3f15500`) and was deliberately not touched.
- Review and probe logs: `/tmp/nyan-parallel-reports/` (may not survive a reboot). The findings that still matter are copied into section 3.

## 2. CI on PR #30: what is red and why

Three jobs fail (Windows build and check, Ubuntu build, check and test, Bun on Ubuntu); Dependency audit and MCP conformance pass.

1. **Not caused by this PR: model catalog drift. `main` is red for the same reason since `2a3f15500`.**
   - `npm run check` fails in `tsc --noEmit`: 38 errors in `packages/ai/test/*.test.ts` on Ubuntu, all `Argument of type '"mimo-v2.5-pro"' is not assignable to parameter of type '"mimo-v2.6-flash" | "mimo-v2.6-pro" | ...'`.
   - The Bun job fails `packages/coding-agent/test/model-resolver.test.ts` "built-in chat providers have defaults in their generated catalogs": "xiaomi default mimo-v2.5-pro should exist in its generated catalog".
   - Cause: CI re-hydrates `packages/ai/src/providers/data/` from models.dev, and the xiaomi catalog no longer lists `mimo-v2.5-pro`. The previous green run (`3c33f79`, 2026-10-15) predates the change. Locally it is hidden because `@ny4n/ai` types and runtime resolve to a stale `packages/ai/dist`; the re-hydrated `xiaomi.json` here already has no `mimo-v2.5-pro` (0 matches).
   - Fix: `npm run hydrate:model-data && npm run build:offline`, then `npm run check` reproduces it. Change the xiaomi defaults in `packages/coding-agent/src/core/model-resolver.ts:51-54` (four providers) and the ids used by the 15 test files under `packages/ai/test/` plus `packages/coding-agent/test/model-resolver.test.ts` to an id that exists (`mimo-v2.6-pro` is the closest). Decide whether to make these tests independent of live catalog drift; that is a policy choice, not made here.
2. **Possibly this PR, not reproduced: one Bun test.** `packages/coding-agent/test/suite/agent-session-codemode.test.ts` "adds the usage of nested results to the codemode result" got `result.usage` undefined on CI. It is absent from every earlier red run on `main`. Here it passes 3 of 3 in isolation under Bun, passes under Node, and the whole `packages/coding-agent` suite passes under Bun (2899 passed, 0 failed, credentials scrubbed). It uses the legacy `AgentSession`; I found no mechanism by which the PR changes it (the coding-agent files touched only swap how Bun and Node are detected, and the durable and chord changes are not on that path), but that is an argument, not proof. First step: rerun the job (`gh run rerun 38884316388 --failed --repo blxzer77/nyan`). If it fails again after the catalog fix, bisect the four commits; if it passes, treat it as a flake and say so in the PR.
3. **Not run on CI, fails locally for unrelated reasons** (do not mistake them for regressions):
   - `packages/durable/test/tools-images.test.ts` "prepares in a worker thread" asserts `< 100 ms` and measured 100 to 115 ms under load; it passes on a quiet machine.
   - `packages/durable/test/provider-session-cache-e2e.test.ts` is a live test that runs whenever `~/.nyan/agent/auth.json` has an `openai-codex` credential, and the provider answers "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account". It needs a different model id or a skip.

## 3. Open review findings

The first review (claude-haiku-5-5) found five blockers, all fixed. A second review of the fixes returned "mergeable with corrections". Corrected in the follow-up commit: the spec's account of a queued reset (the drafts leave the active context) and the `rewriteMessage` check list. Still open:

| Priority | Finding | Where | Suggested fix |
| --- | --- | --- | --- |
| Blocking by the reviewer, but a defect that predates this PR | A tool result's `usage` is recorded inside the commit without validation. A tool returning `usage.input = NaN` makes the commit throw, the `nyan.tool-result` entry is never written, and nothing is reported; the model then sees "Tool result unavailable". A negative value is accepted into the ledger. | `packages/durable/src/harness/tool.ts:937` (and the nested-call twin at 694), `usage.ts` | Run the tool's usage through `usageProblem` before the commit and reject negatives; add a test beside the compaction `invalid_usage` ones. |
| Suggestion | `usageProblem` accepts negative counters and extra non-numeric fields, and two `1e308` values add up to `Infinity`. | `packages/durable/src/harness/usage.ts` | Reject negatives; check the ledger sum is finite. |
| Suggestion | A `replace` edit whose user message has no `content` is accepted. Behavior with a real provider is unverified. `omit` with a `messages` field is accepted and ignored. | `generation.ts` `userMessagesProblem`, `boundaryProblem` | Check `content`; reject `messages` on `omit`. |
| Suggestion | The chord test's "cancelled while waiting" case passes without the fix, so only the early-abort case guards the regression. `awaitWithContext` now throws `TypeError` for a non-Promise thenable (the signature says `Promise`). `#closing` in `packages/durable/src/session/session.ts` (near 484) is shared, so the added catch marks it handled for every observer. | `packages/chord/test/context.test.ts:102`, `packages/chord/src/context/index.ts` | Drop or relabel the case; comment the shared promise. |
| Suggestion | The test named "lets a tool stream output and details when no observer exists" only calls `api.output`. | `packages/durable/test/harness-stream-hooks.test.ts:317` | Rename, or add an `api.details(...)` call. |
| Suggestion | `onError` of a `Delivery` that itself throws would end the pump with an unhandled rejection. | `packages/durable/src/harness/util.ts` | Wrap the call. |

Not verified by anyone: a crash between a boundary hook and its commit (the hook reruns and the entries are appended exactly once) is argued from the commit structure only; Bedrock's `onResponse` frequency under SDK retries; that the SDKs drop a header set to `null` (read from their sources, not run); the effect of `Infinity` in a real SQLite ledger; the compiled Bun binary and bundled-Node build for Phase 2.

## 4. What N2 still needs (the gate stays open)

Task A is the hook contract in `packages/durable`. Nothing in `coding-agent` uses it yet, so no user-visible behavior changed and `packages/coding-agent/CHANGELOG.md` is untouched.

- **Task B, JSON/RPC product APIs.** The durable RPC adapter in `packages/coding-agent/src/modes/durable/rpc.ts` handles 33 command cases; 12 answer "unavailable" (clear_queue near 147-148, abort_retry near 210-211, ten more near 246-255): bash, queue mutation, entry and tree access, fork, export and related. They are N2 scope under Decision #22. `--mode json` and `--mode rpc` must keep emitting the same event types (`message_update`, `tool_execution_*`, `thinking_level_select`); `packages/coding-agent/src/modes/durable/json-events.ts` is the translator.
- **Task C, the extension adapter.** Register one durable extension that bridges Nyan's runner to the new members (`context` to `transformConversation`, `message_end` to `rewriteMessage`, `turn_end` and `agent_before_settle` to `onBoundary`, tool updates to `onToolUpdate`, the provider events to the four provider members). Register a member only when the Nyan runner has a handler for the matching event: a registered member makes `HookRunner.has()` true and turns the feature, and its cost, on. Composition rules (last write wins, in-place mutation) and Nyan's diagnostics stay in the adapter. Classification: `.agents/notes/proposed/architecture/extension-surface.json` (73 destination entries: 49 product-api, 11 durable-capability, 8 internal-view, 4 hook, 1 drop); `npm run check:extension-surface` guards it.
- **Before running B and C in parallel**, freeze their file sets: a read-only review found they overlap (`main.ts`, `core/extensions/*`, `modes/durable/*`). Do that as a short design step first.
- **Decision #23** (four scope reductions) is waiting on the owner; the work follows the recommendation. If rejected: (a) assistant-only `rewriteMessage` needs a tool-result and `custom` role story, (b) and (c) mean boundary hooks on the failure path or a split answer commit, (d) is N4's decision.
- WIP rule: at most two active lines. N2 and Bun Phase 2 are the two. The CLIProxyAPI work has no roadmap line; if it needs one, one of these two has to wait.

## 5. What Bun Phase 2 still needs

Done: `packages/coding-agent/src/runtime.ts` and `packages/ai/src/utils/runtime.ts`, with the HTTP dispatcher, output guard, both user-agent helpers, bug report, and the `ai` provider-env, env-api-keys, Codex OAuth, Codex responses and Bedrock checks moved onto them. Bun also reports `process.versions.node`, so a Bun-only branch uses `runningUnderBun()`, never `isNodeLikeRuntime()`.

Remaining consumers: `utils/image-resize.ts`, `bun/restore-sandbox-env.ts`, `core/extensions/loader.ts`, `main.ts`, `experimental/*`, and the `packages/ai` loader path. Known inconsistency left alone: `loadNodeZlib()` is not narrowed to Node-only, because that changes request behavior on Bun and needs an owner decision. The Phase 2 gate also wants a compiled Bun binary check and a bundled-Node build check (`scripts/build-binaries.mjs`, `NYAN_BUNDLED_NODE`); neither was run.

## 6. Other things worth knowing

- The CLIProxyAPI extension reads `~/.pi/agent` (`packages/coding-agent/src/extensions/cliproxyapi/config.ts` near 165, 283, 369 and `cache.ts` near 57). The repo rule says Nyan never reads `~/.pi`. Raise it with that line's owner.
- `@ny4n/ai/utils/*` resolves to `packages/ai/dist`, which is gitignored. A fresh worktree has no `dist`, so many durable suites fail to load there with "Cannot find package '@ny4n/ai/utils/estimate'". Run `npm run build:offline`, or temporarily symlink `dist` from another checkout (and delete the symlinks afterwards: `git status` shows them as untracked).
- Verification recipe used for the hooks: for each behavior, disable the code under test and confirm a test fails (about 70 such checks). Two tests that survived this were rewritten. Run the durable suite twice, once with `NYAN_DURABLE_DOCUMENT_RETENTION_MS=0`, with provider credentials removed from the environment.
- The Astra reviewer is unavailable (`openai-codex` credentials). Reviews used `nyan --provider cliproxyapi --model claude-haiku-5-5 --thinking high --no-session --no-mcp --no-approve --tools read,bash -p "<prompt>"`; it can return a connection error, so retry.

## 7. First hour at home

1. `cd /home/blxze/projects/personal/nyan-n2 && git fetch && git status` (branch `n2-durable-hooks`).
2. Reproduce and fix the catalog drift (section 2.1); push; check that `main`-style checks go green on the PR.
3. Rerun the failed Bun job; settle section 2.2.
4. Fix the tool usage validation (section 3, first row) with a test and a mutation check.
5. Ask the owner about Decision #23; then merge, delete this file, and update `ROADMAP.md` Active rows.
