# Bun Phase 3 progress

| Batch | PR | Merge commit (squash) | Date | Notes |
|---|---|---|---|---|
| 1 transport error classification | #35 | `2f6f3eb9a011281cbd03f04abeeb510f1e46c7f1` | 2026-10-17 | PR head `e3969a613` (merge of main `ee599af76` into `95a176ea9`). Merge gate green; no bypass used. |
| 2 HTTP backend split | #48 | `f8416a835be12f81d8de69cf4df416352faff3d9` | 2026-10-18 | PR head `a1ed435e6` (main `96de1e0a9` merged into `707b21ad7`; one ROADMAP.md conflict resolved: N2 row from main, Bun row mine). Merge gate green; no bypass. |
| 4 SQLite on bun:sqlite | #57 | `06497972c1398f5c1f847c799ad92b767230a189` | 2026-10-18 | PR head `eb8dc937f` (main `723e9163d` merged in twice, second time without conflicts). Merge gate green; no bypass. |

## Batch 1 (PR #35)

- Final head `e3969a613`: CI run 39073497352 success (Merge gate success); release dry run 39073757742 success, all jobs including Publish verified artifacts.
- Head `95a176ea9` (before merging main): CI run 39073032098 and release dry run 39073040964 success.
- Owner decisions during the batch (2026-10-17): codemode failures (`agent-session-codemode.test.ts`, durable `codemode.test.ts`) accepted for now, to be fixed later; OCR on the last head not required, its findings to be fixed later if any.
- OCR findings on `70a099071` (four) fixed in `95a176ea9`. OCR was not rerun on `95a176ea9`/`e3969a613` by decision; see the OCR comment on the PR for what it reported, if anything.
- Reruns used: apt lock on release (`607d80d28`, `70a099071`), `tools-images.test.ts` on release (`599f97a71`). `experimental-remote-runtime` flaked on `8d25cf174` (twice) and was not rerun again.
- Not changed, recorded as limit: the outer classifier sees stored text only; a provider whose stored text has an unlisted status form and a certificate in its body is not retried.

## Batch 2 (PR #48)

- Final head `a1ed435e6`: CI run 39114340141 success (14 jobs, Merge gate included); release dry run 39114364977 success (31 jobs, 4 binary smoke tests and Publish verified artifacts included). No reruns were needed.
- Earlier head `707b21ad7`: release dry run 39112458281 success. Its pull_request CI never started because the PR was in conflict with main (ROADMAP.md); found after 24 minutes of waiting, fixed by merging main into the branch (no force-push).
- Local, Windows x64, Node 24.3.0, Bun 1.4.3: `npm run check` exit 0 (before and after merging main); five test files Node 88 passed / 7 skipped, Bun 92 passed / 3 skipped, three consecutive runs stable; 12 mutations caught on Node and Bun where the behavior exists.
- System certificate store (design item b.2b), owner-approved test CA in `Cert:\CurrentUser\Root`: results table, install and cleanup are in `.agents/notes/implemented/architecture/2026-10-13-bun-native-fetch.md`. Short version: Bun supports the Windows store through `--use-system-ca`, `BUN_OPTIONS=--use-system-ca` and `NODE_USE_SYSTEM_CA=1`, not through `NODE_OPTIONS`. Nyan warns once when `NODE_OPTIONS` has the flag under Bun.
- OCR on `a1ed435e6` came after the merge: 2 low findings, in backlog A (`backlog-ocr-tests.md`).
- Not verified: Linux and macOS for the system store; `nyan.exe` itself for the system store (a compiled fetch probe was used; the release dry run smoke-tests the real binaries but not this); the owner's real CA in the system store.
## Batch 4 (PR #57)

- Final head `eb8dc937f`: CI run 39126911010 success (Merge gate included); earlier head `85a298f79` also green (CI + release dry run 39126378186, which exercised the bundle with `bun:sqlite` external and the compiled binaries).
- Local, Windows x64: `npm run check` exit 0 before and after each merge of `main`. Durable suite with CI settings: **Bun 1358 passed / 7 skipped / 0 failed** (was 310 failed in 20 files), Node 1354 passed / 11 skipped / 0 failed, document-retention-0 variant the same. Targeted SQLite files: Bun 147 passed, Node 143 passed / 4 skipped.
- Pre-work parity measurement (Node 24.3.0 / SQLite 3.50.1 against Bun 1.4.3 / SQLite 3.53.4): `next_id` TEXT, `busy_timeout` and `BEGIN IMMEDIATE` behave the same; bigint handling differs (Bun wraps beyond int64 and rounds reads above 2^53), so the adapter reproduces node:sqlite's TypeError/RangeError/undefined-for-no-row rules.
- 31 mutations caught: 28 in the adapter (both int64 bounds, bind checks in run/get/all, `safeIntegers`, safe bounds and off-by-ones, number conversion, null vs undefined, row conversion, finalize on close, idempotent close, each PRAGMA, parent dirs, close when finalize throws, ROLLBACK, scope, defaults, validation), runtime selection on both runtimes, and the test fixture's finalize.
- `coding-agent` `durable-resources` + `durable-extension-host` under Bun: 15/15 pass; on `origin/main` the same files fail 11 tests with EBUSY. main's PR #55 fixed a different part of that cleanup (ENOTEMPTY retry).
- One CI round failed on `int64 min`: CI's Node 24.x returns the exactly representable double for -2^63 where 24.3.0 throws a RangeError. The adapter still throws; the test now asserts exactness (RangeError, or a number that converts back to the stored integer).
- OCR: no comment was posted on PR #57.
## Next

Batch 5: source-loader smoke under Bun (`nyan-source.mjs` fails with a missing `node:module.registerHooks`), subprocess and worker evidence; then the deferred batch 6 (Windows Bun job, Bun version alignment) and undici-on-Node-only. Unprocessed OCR findings and flaky tests are in `backlog-ocr-tests.md`.

## Open follow-ups from batch 1 (OCR on `e3969a613`, posted after the merge; owner agreed to fix later)

1. medium, `retry.ts:L17-L18`: the keyword group in the third branch of `RETRYABLE_HTTP_STATUS_TOKEN` has no word boundary in front, so `code500.example.com`, `http500.example.com` and `?status=500` in a Bun certificate message (it carries the request URL) are read as a status, and a certificate failure is then retried. A real regression risk; test with such URLs first.
2. medium, `retry.ts:L342`: Bedrock's `formatBedrockError` writes `<prefix>: 503: <body>`, a status form the token does not recognise, so a 503 whose body says "certificate expired" is no longer retried (it was before batch 1). The same limit already recorded in the note, now with a concrete provider.
3. medium, `mistral-conversations.ts:L279-L281`: `formatMistralError` repeats `normalizeProviderError` + `formatProviderError`; consider using them with the prefix, checking the differences first.
4. low, llama/index.ts: export one `isCertificateError(error)` from `transport-error.ts` and share it with provider-retry (provider-retry adds a status condition by design).
5. low, `transport-error.ts:L64`: `isCertificateErrorCode` is exported but only used in its own file; drop `export` or document.
6. Not covered in the last review run: `error-body.ts`, `provider-retry.ts` (model call failed).

Also open: codemode failures (Bun `agent-session-codemode.test.ts`, durable `codemode.test.ts`), accepted by the owner for now.
## Incident, 2026-10-18 (this session)

`git worktree remove --force` was run on a temporary worktree at `D:\nyan-tmp\bun\wt-base` that contained directory junctions to the real `node_modules` of `D:\nyan-bun`. The removal followed the junctions and deleted real content: 1895 tracked files and `node_modules` of the working tree, plus the uncommitted batch 4 files. A `git add -A packages/durable` then committed 216 deletions as a "checkpoint" before the damage was noticed.

Recovered: `git reset --mixed f8416a835` (the bad commit dropped), `git restore --source=HEAD --worktree` for the 1895 paths (0 missing afterwards), `npm ci --ignore-scripts`, `npm run hydrate:model-data`, `npm run build:offline`, and the batch 4 code rewritten from the session's own content. Repository state verified after: `npm run check` exit 0, full Bun and Node durable suites green. `D:\nyan-bun` is this session's own worktree; other worktrees (`D:\nyan`, `D:\nyan-n2`, …) were not touched. Rule for the future: never `git worktree remove` a worktree that holds junctions, and never `git add -A <path>` as a checkpoint.