# Agent Note: Hosted parallel CI/CD for Nyan

Status: proposed: measured baseline and target design recorded; no workflow changed, GitHub-side settings pending

Supersedes the runner-placement and job-shape bullets of [Nyan quality workflow architecture](2026-10-17-quality-workflow.md). The impact classifier, fail-closed gate, risk tiers, model-data snapshot, artifact reuse, and "publish exactly the verified bytes" decisions stay.

## Problem

The quality gate in `ci.yml` takes 22 minutes on a full pull request while 17 of its 25 test jobs do under 15 seconds of actual work, and the same run leaves the only CI host at roughly twice its CPU capacity. Measured on `origin/main` at `6060afa73`:

- Run `39028721085` (full PR, success) took 22.1 minutes: `policy` 24 s, `prepare` 38 s, the node/bun matrices 13.3 minutes of wall clock, `deep-gate` 7.4 minutes, `gate` 12 s.
- `.github/quality/policy.json` sets `pullRequest.targetP95Minutes: 10`. The gate misses its own target by more than 2x.
- Before the matrix split, the same change took 6.4 minutes (run `39029129651`, one vendor job per platform). Splitting into 25 matrix jobs made the pipeline 3.5x slower.
- `nyan-dev-01` (6 vCPU, 23 GiB) reported `load average: 3.81, 8.92, 11.52` for 1/5/15 minutes while six runner services were busy: 1.9x oversubscribed. Each job starts `vitest` with `maxWorkers = cpus - 1 = 5`, so six concurrent jobs run about 30 worker threads on six cores.

Three independent causes, in order of size:

1. **`max-parallel: 2` on two separate matrices.** 28 test jobs compete for 4 slots, so the last jobs queue for 12.7 minutes. The 6 self-hosted runners are the second limit: even without `max-parallel`, only 6 jobs can run.
2. **`deep-gate` re-runs work that already passed.** Of its 445 s, 182 s is `npm run test:scripts` plus five package suites and 146 s is the same five packages under Bun, both already covered by `node-tests` / `bun-tests` in the same run. Only the 1 s fuzz harness and the 93 s mutation run are unique. It also carries `concurrency: nyan-deep-gate / cancel-in-progress: false`, so two open PRs serialize.
3. **Per-job fixed cost dominates small jobs.** `checkout` 2 s + `Setup Nyan` (`npm ci`, 15 s) + artifact download 3 s is 20 s for a job whose test step is 1-14 s. 17 of 25 test jobs are in that class.

Secondary costs found while measuring:

- **Cache storage is 72% consumed and thrashing.** `gh api repos/blxzer77/nyan/actions/cache/usage` reports `active_caches_size_in_bytes: 7173534654` (7.17 GB) across 74 entries against the 10 GB limit. Almost all of it is `node-cache-<OS>-<arch>-npm-<lockfile sha>`, one entry per pull request because `actions/cache` is branch-scoped and every PR writes its own.
- **`npm ci` on an already-populated cache is 9.1 s, not 20 s.** Measured on `nyan-dev-01` after `git clone --depth 1`: `added 421 packages in 9s`. The 20 s in CI is cache restore plus network, not extraction.
- **The install output is small enough to ship.** `node_modules` is 438 MB / 23 233 files on Linux; `tar | zstd -3` gives 100 MB and extraction takes 0.79 s. A `node_modules` + `dist` artifact is therefore cheaper than a per-job install.
- **The apt step is probably unnecessary.** `ci.yml` installs `libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep` in five jobs. The only `canvas` import in the repository is `packages/ai/scripts/generate-test-image.ts`, a one-off generator; `canvas` is otherwise a `devDependencies` entry of `packages/ai` with no importer at test time, and `npm ci` runs with `--ignore-scripts`. Only `fd`/`rg` may matter, and `packages/coding-agent/src/utils/tools-manager.ts` looks both up on `PATH`.
- **`npm run check` never reads `dist`.** `tsconfig.json` maps every `@ny4n/*` specifier to `packages/*/src`, and `check-entry-graphs.mjs`, `check-architecture-layers.mjs` and `check-ts-relative-imports.mjs` either derive source paths from `exports` or skip `dist`. The `static` job still waits for `prepare` to finish building, which is pure serialization.
- **GitHub-hosted runners are free for this repository.** `blxzer77/nyan` is public (`gh repo view --json visibility`), and every `/actions/runs/<id>/timing` response reports `total_ms: 0` for UBUNTU, WINDOWS and MACOS, including the 8.7-minute release run `39029131011`. Hosted is about 25% slower per core than `nyan-dev-01` (`npm ci` 20 s vs 9 s, `npm run check` 38 s vs 30 s, `build:offline` 17 s vs 12 s) but it is dedicated and effectively unbounded, which is the trade this design takes.

## Proposal

Move ordinary CI to GitHub-hosted runners, stop paying per-job install cost, and make the longest single job the critical path instead of the job count.

### Non-negotiables

- A release still publishes the exact bytes that `verify` built and tested; no job rebuilds after packing.
- Fail-closed impact analysis, the model-data snapshot hash, SHA-pinned actions, and the `Merge gate` aggregator keep working unchanged.
- `policy.json`'s `impactAnalysisFailClosed`, `criticalPaths`, and deep-testing thresholds are untouched.
- No job gains a credential it does not already have. Moving to hosted removes the fork-PR trust split, so `needs.policy.outputs.fork_pr` guards and the `head.repo.full_name` `runs-on` ternaries are deleted rather than ported.

### Runner placement

| Work | Today | Target | Reason |
| --- | --- | --- | --- |
| policy, static, prepare, matrices, deep, gate, supply-chain, mcp | `[self-hosted, Linux, X64, repo-nyan]` | `ubuntu-latest` | free, dedicated, no `max-parallel` pressure |
| windows-smoke | `windows-latest` | unchanged | already hosted |
| native `linux-x64` | self-hosted | `ubuntu-latest` | the other three native targets are already hosted |
| release verify / binaries / smoke-linux | self-hosted | `ubuntu-latest` | publishes from `ubuntu-latest` already |
| nightly | self-hosted | `ubuntu-latest` | removes the last steady load from `nyan-dev-01` |

`nyan-dev-01` keeps its runners registered but idle for one week after the switch so a rollback is a one-line label change; then the six `actions.runner.*` services are removed. `nyan-dev-02` is not involved either way.

### Prewarmed workspace instead of per-job install

`prepare` becomes the single install+build point and publishes one artifact:

```yaml
prepare:
  name: Prepare workspace
  runs-on: ubuntu-latest
  timeout-minutes: 15
  steps:
    - uses: actions/checkout@<sha>
    - uses: ./.github/actions/setup-nyan     # setup-node (no cache) + npm ci + model-data restore
      with: { node-version: '24', bun: 'false', model-data: 'true' }
    - run: npm run build:offline
    - name: Pack workspace
      run: |
        tar -C . -cf - node_modules packages/*/dist .ci/model-data.lock.json \
          | zstd -3 -q -o workspace-linux.tar.zst
    - uses: actions/upload-artifact@<sha>
      with:
        name: nyan-workspace-${{ github.sha }}
        path: workspace-linux.tar.zst
        if-no-files-found: error
        retention-days: 3
```

Every Linux job then replaces setup+install+dist-download (20 s) with:

```yaml
    - uses: actions/checkout@<sha>
    - uses: actions/setup-node@<sha>
      with: { node-version: '24' }            # toolcache link only, no `cache: npm`
    - uses: actions/download-artifact@<sha>
      with: { name: nyan-workspace-${{ github.sha }} }
    - run: tar -xf workspace-linux.tar.zst
```

Measured shape: 100 MB zstd archive, 23 233 files, 52 workspace symlinks (`node_modules/@ny4n/* -> ../../packages/*`) preserved by tar, 0.79 s extraction on `nyan-dev-01`. A zstd archive rather than a raw upload matters: upload-artifact's own compression is not worth re-compressing 438 MB of already-compressed content.

Bun jobs add `oven-sh/setup-bun` (5 s) and keep the same artifact. Windows keeps its own `npm ci` because `node_modules` is platform-specific there.

`.ci/bin/{fd,rg}` may be added to the packed workspace by `prepare` so no job needs `apt-get`. This removes the five `Install Linux build dependencies` steps. Verify before deleting them: one `ubuntu-latest` run must show `build:offline`, `npm run check`, `coding-agent` tests, and `test:mcp-conformance` passing without the package install.

### Cache policy

With the workspace artifact, `setup-node cache: npm` is only needed in `prepare`. Leaving it on 25 jobs is what produced 74 entries and 7.17 GB. Two changes:

- `prepare` keeps `cache: npm` keyed by `package-lock.json`; `cache-dependency-path: package-lock.json`.
- PR runs restore only, main runs save. Either use `actions/cache/restore` + a save step guarded by `if: github.event_name == 'push'`, or set `setup-nyan`'s `install` input so that PRs run `npm ci --prefer-offline` against a restore-only cache. The point is that a pull request never writes a 100 MB npm cache that is scoped to a ref nobody will reuse.

Target: 2-4 cache entries per lockfile (Linux/Windows toolchain plus one npm cache) instead of 74.

### Job graph

```
Wave 0  (t = 0)
  prepare        ubuntu-latest  ~70 s   install + build:offline + pack workspace
  static         ubuntu-latest  ~55 s   npm run check (needs node_modules only, not dist)
  policy         ubuntu-latest  ~15 s   validate-workflows + ci-impact (no npm ci)
  supply-chain   ubuntu-latest  ~70 s   gitleaks + npm audit + signatures + trivy
  mcp            ubuntu-latest  ~60 s   conformance (needs prepare)
  windows        windows-latest ~110 s  own install + build + check

Wave 1  (needs prepare)
  node matrix    ubuntu-latest  9 jobs, longest ~70 s
  bun matrix     ubuntu-latest  5 jobs, longest ~60 s
  deep extras    ubuntu-latest  ~95 s   fuzz FUZZ_RUNS=5000 + mutation only

Wave 2
  gate           ubuntu-latest  ~15 s
```

Critical path: 70 s prepare + 70 s longest shard + 15 s gate ≈ **155 s**, with a p95 target of 4 minutes including hosted cold start. Against the 22.1-minute baseline that is a 7x reduction, and it puts `policy.json`'s 10-minute target back within reach.

`policy` in wave 0 is cheap because it stops running `npm ci` and the `docker run rhysd/actionlint` step: `npm run check:workflows` already validates that file, and actionlint is a lint of the same file. Keep `validate-workflows.mjs` and drop the container.

### Test matrices

Sharding by file count is not enough. Measured per-file cost shows the 4 slowest `coding-agent` files and the 7 slowest `durable` files hold most of the work:

| package | files | summed file duration | slowest files |
| --- | --- | --- | --- |
| coding-agent | 317 | 903 s | `git-update` 72 s, `experimental-presentation-facets` 60 s, `model-registry` 55 s, `tools` 42 s |
| durable | 64 | 748 s (one pass) | `tools-read-differential` 103 s, `jsonl-storage` 98 s, `codemode` 91 s, `tools-images` 80 s, `env-node-conformance` 74 s, `harness-scheduler-retention` 69 s, `provider-session-cache-e2e` 55 s |

A single 72 s file caps any shard that contains it, which is why `--shard` saturates: full 184 s, `1/2` 109 s, `1/4` 84.8 s, `1/8` 79 s on a 16-core Windows box. Round-robin cannot separate those files.

Target shape, with `max-parallel` chosen so the whole run stays inside the concurrency budget:

```yaml
  node-tests:
    name: Node tests (${{ matrix.group }})
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      max-parallel: 6
      matrix:
        include:
          - { group: coding-agent-1, cmd: 'npx vitest --run test/git-update.test.ts' }
          - { group: coding-agent-2, cmd: 'npx vitest --run --shard=1/3 ...' }
          # ... 4 groups total for coding-agent, weights balanced from the committed profile
          - { group: durable-1,      cmd: 'npx vitest --run --shard=1/3' }
          - { group: small,          cmd: 'for p in protocol client server mcp telemetry chord tui codemode agent; do npm -w packages/$p test; done' }
```

Two implementation details:

- **`npm test -- --shard=...` silently ignores the flag.** `npm --workspace packages/coding-agent test -- --shard=1/2` ran all 317 files in the probe. Shards must invoke `npx vitest --run --shard=i/n` directly, or a new script must be added, for example `"test:shard": "vitest --run"` in each package, called as `npm -w packages/<p> run test:shard -- --shard=i/n`.
- **`packages/durable` runs its suite twice.** `test` is `vitest --run && node scripts/test-without-document-retention.mjs`, and the retention script forwards no arguments, so a shard flag reaches only the first pass. `scripts/test-without-document-retention.mjs` must forward `process.argv.slice(2)` to `vitest`, and the shard job runs both passes for its own slice.

The `small` group exists because nine packages cost 1-14 s each. Running them sequentially inside one job costs 20 s of setup instead of nine separate setups, and it keeps the job count inside the limit. This is deliberately not a full aggregation: a probe that ran eight packages as one vitest `projects` list (51 files, 908 tests) finished in 47 s but failed 5 tests that pass in isolation, including `packages/codemode/test/sandbox.test.ts` (output-limit timing) and `chord`'s state-fuzz timeout, because the projects competed for CPU. Sequential `npm -w ... test` keeps each package's own worker pool and avoids that.

### Deep verification

`deep-gate` keeps only what the sharded matrices do not already cover:

```yaml
  deep-extras:
    name: Deep verification
    needs: prepare
    if: needs.policy.outputs.deep_required == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:   # download workspace, then:
      - run: FUZZ_RUNS=5000 FUZZ_SEED=20261017 npm run test:fuzz:protocol
      - run: npm run test:mutation
```

Removing `concurrency: nyan-deep-gate` lets two risky PRs verify at the same time. Removing the duplicated suites drops 328 s of the old 445 s.

### Nightly

Today four jobs run strictly in series on `nyan-dev-01`, and `recovery` repeats the package list that `node-full` already ran. Target:

- One reusable workflow owns install/build/test lanes so `ci.yml`, `nightly.yml`, and `release.yml` cannot drift. `nightly.yml` calls it with `mode: full`; `ci.yml` calls the same workflow with the impact-selected groups.
- `node-full` and `bun-full` become matrix shards that run in parallel, not a `needs:` chain.
- `recovery` is deleted; its coverage is the durable, agent, coding-agent, protocol, server and client shards.
- `fuzz-and-mutation` runs `FUZZ_RUNS=10000` in parallel with the matrices instead of after `recovery`.
- Everything runs on `ubuntu-latest`. Expected 30+ minutes of serial self-hosted work becomes about 8-10 minutes on hosted.

Reusable-workflow shape: `prepare`, `static`, `node-tests`, `bun-tests` live in one `workflow_call` file with inputs `mode` and `groups`. Artifacts are run-scoped, so a `prepare` job inside the called workflow still feeds a `static` job declared in the caller if needed; keeping `static` inside the called workflow is simpler and is what this design assumes.

### Release

Today: `verify` (build + check + `npm test`) 5.7 min serial, then `native` → `binaries` → 4 smokes → `publish`, total 8.7 min, with `verify` and `binaries` on self-hosted.

Target:

```
verify (workflow_call, mode: full, ubuntu-latest)   ~3 min   build + check + sharded tests + pack
native (unchanged matrix, linux-x64 moves to ubuntu-latest) ~1.5 min   parallel with verify
binaries  needs [verify, native]                        ~1.5 min   ubuntu-latest
smoke x4  needs binaries                                ~1 min     unchanged
publish   needs [verify, native, smoke]                 ~1 min     ubuntu-latest
```

`verify` still packs the tarballs it tested and `publish` still uploads those artifacts, so the "same bytes" guarantee holds. Expected 8.7 → about 4-5 minutes, and no release work remains on `nyan-dev-01`.

### Concurrency budget

The plan-level concurrent-job limit could not be confirmed from this account: `gh api /user/settings/billing/actions` and the user billing endpoints return 404, and `/users/blxzer77` reports `plan: null`. The documented default for a Free personal account is 20 concurrent jobs (5 on macOS); public repositories are not charged for standard runners but are still subject to that limit. Treat **16 concurrent jobs as the working budget** so the design is safe at 20 and degrades predictably if it is lower.

Peak in the target graph: 6 wave-0 jobs + `max-parallel: 6` node + `max-parallel: 4` bun + 1 deep = 17 while wave 0 is still running. The `gate` and `policy` slots free up first, so steady state is 11. If the probe in the verification plan shows a lower limit, drop `max-parallel` for bun to 2 and move `supply-chain` behind `prepare`.

**Phase 0 probe (owner or CI agent):** add a throwaway `probe-concurrency.yml` on a scratch branch that dispatches 40 `sleep 60` jobs on `ubuntu-latest`, dispatch it, and read the observed overlap from `gh api .../jobs`. Delete the file afterwards. This is the only way to know the real number; record it in `.github/quality/policy.json` as `pullRequest.concurrencyBudget` so later edits have a reference.

### Required checks

`policy.json` and `.github/quality/policy.json`'s `pullRequest.required` list eight job names, and branch protection must name each one. Every matrix rename (`Node tests (ai)` → `Node tests (small)`) therefore breaks a required check and leaves a PR permanently pending. Two changes:

1. Branch protection requires exactly **`Merge gate`** (plus `Policy and impact` if a second independent signal is wanted). `scripts/ci-gate.mjs` already fails when any required job is not `success`, so the aggregate is the contract and the matrix names become an implementation detail.
2. `ci-gate.mjs` keeps treating `skipped` as a failure for a required job. `deep-extras` stays conditionally required through `deep_required`, as today. Add `advisory: []` handling only if an advisory job is introduced.

Also confirm `merge_group` still selects the gate: the gate currently derives everything from `needs.*.result`, so it needs an `always()` and no `if:` that can skip it.

### Failure reporting

Per-package jobs today localise a failure by name. Shards lose that. Compensate with:

- `--reporter=dot,github-actions` (already set in most configs) so annotations name the file and test.
- `--reporter=junit --outputFile=junit.xml` on shard jobs plus `actions/upload-artifact` with `if: always()` and `retention-days: 3`, so a merged job can still be attributed.

## Alternatives considered

- **Keep self-hosted and only remove `max-parallel`.** Cheapest change, but 6 runners cap the run at 6 concurrent jobs, so the two-shard-limit becomes a six-runner limit and 28 jobs still take two waves. `nyan-dev-01` stays at ~2x CPU and the 74-entry cache problem stays.
- **Raise the runner count on `nyan-dev-01`.** The host is 6 vCPU/23 GiB. More runner services increase oversubscription; it cannot be fixed by concurrency settings alone.
- **Add `nyan-dev-03` (2 vCPU, 7 GiB, idle) as a runner.** Useful only for native arm64-style builds; 2 vCPU cannot take a `coding-agent` shard without becoming the new critical path.
- **Aggregate all packages into one vitest `projects` run.** Measured: 47 s for eight packages and 908 tests, but 5 tests fail from CPU contention that pass in isolation. Also collapses per-package failure isolation. Rejected in favour of sequential small-package grouping plus weighted shards.
- **Bake a `ghcr.io/blxzer77/nyan-ci` container image with node, bun, and system libraries.** Removes `setup-node` (5 s) and apt entirely, but adds an image build/publish/rotation workflow and a registry credential for a 5 s gain over the workspace artifact. Reconsider only if the apt step turns out to be required.
- **Use `actions/cache` for `node_modules` instead of an artifact.** Same effect, but cache entries are branch-scoped and capped at 10 GB, which is the failure already observed at 7.17 GB / 74 entries. Artifacts are run-scoped and expire.
- **Speed up the slow tests instead of sharding around them.** The right long-term fix: 4 `coding-agent` files and 7 `durable` files are the majority of both suites' CPU. Out of scope here because it changes product test behaviour; recorded as a follow-up so the shard weights are not mistaken for the real fix.
- **Keep a self-hosted fallback lane in every workflow.** Doubles every job definition and every required-check name for a rollback that a one-line `runs-on` change already provides.
- **Move to a larger paid runner.** Unnecessary: the workload fits in 16-20 free concurrent hosted jobs, and paid minutes are the only thing this design avoids spending.

## Consequences

- Ordinary PR feedback drops from 22 minutes to about 3, p95 4, and no CI work runs on `nyan-dev-01`. The 6-vCPU host stops being a single point of failure for the whole repository.
- The pipeline loses warm-runner locality: hosted per-core throughput is about 25% behind `nyan-dev-01`, and every job pays a 3-5 s checkout and toolcache link. That is repaid by dedicated cores and by removing 17 jobs' worth of install.
- The workspace artifact makes test jobs depend on `prepare` having succeeded. A `prepare` failure now blocks every test job at once instead of failing one vendor job; the fail-closed gate reports it as one reason.
- Weight-based shard groups are a maintained list. When a suite's slowest files change, the balance degrades silently until someone re-measures. Mitigation: keep the profile generator and re-measure quarterly, or accept `--shard` round-robin as the fallback when weights are older than the last 30 commits.
- Deleting the fork-PR guards removes code paths that no longer have a purpose. It also means a fork PR now runs the same jobs as an internal one, which is only safe because no self-hosted runner is involved. This must not be reverted while self-hosted runners are still registered.
- `merge_group` runs become cheap enough to keep enabled without slowing the queue.
- The `17 concurrent jobs` peak leaves 3 slots at the assumed 20 limit. If the real limit is lower, wall clock degrades by one wave rather than failing.

## Verification

Measured for this note, not yet implemented:

- `gh run list --workflow=ci.yml` plus `/actions/runs/<id>/jobs` for runs `39028721085`, `39029129651`, `39028540637`, `39030387971`, `39030398500`: per-job and per-step durations, 22.1 min full-PR baseline, 6.4 min pre-matrix baseline, 12.7 min worst queue.
- `/actions/runs/<id>/timing` for `39029131011`, `38660834853`, `39029129651`, `39028540637`: `total_ms: 0` for UBUNTU/WINDOWS/MACOS. `gh repo view --json visibility` reports `PUBLIC`.
- `ssh nyan-dev-01`: `nproc 6`, 23 GiB, `load average: 3.81, 8.92, 11.52`, six `actions.runner.*` services, `/root/.npm` 151 MB.
- `git clone --depth 1` on `nyan-dev-01`: `npm ci --ignore-scripts` 9.1 s, `node_modules` 438 MB / 23 233 files, `tar | zstd -3` 100 MB, extraction 0.79 s, 52 workspace symlinks preserved.
- `packages/coding-agent`: full 184 s, `--shard=1/2` 109 s, `1/4` 84.8 s, `1/8` 79 s. `packages/durable`: `1/2` 37 s, `1/3` 24 s. JSON reporter profiles: coding-agent 317 files / 903 s, durable 64 files / 748 s.
- `npm test -- --shard=1/20` in `packages/coding-agent` ran all 317 files, confirming the flag is swallowed by the npm wrapper.
- Eight-package `projects` probe: 51 files, 908 tests, 47 s, 5 failures that pass when run alone (`packages/codemode/test/sandbox.test.ts`, `packages/chord/test/state-fuzz.test.ts` and others).
- `npm run check` sub-step timings on a 16-core Windows box: `typecheck` 26.2 s, `check:runtime-deps` 25.7 s, `lint` 16.1 s, `check:ts-imports` 13.6 s, remaining checks ≤ 3.4 s each.
- Source inspection for the apt question: only `packages/ai/scripts/generate-test-image.ts` imports `canvas`; `packages/coding-agent/src/utils/tools-manager.ts` resolves `fd`/`fdfind` and `rg` from `PATH`.

Still unverified, and each needs a run before the corresponding claim is made:

1. **Real concurrent-job limit** for this account. Phase 0 probe above.
2. **Ubuntu-latest without `libcairo2-dev` and friends**: `build:offline`, `npm run check`, `coding-agent` + `durable` tests, `test:mcp-conformance`.
3. **Workspace artifact on hosted**: `tar -xf` of a 100 MB zstd archive plus `npx vitest` in a shard, with `node_modules/@ny4n/*` symlinks resolving.
4. **`bun --bun <vitest> --run --shard=i/n`** accepts the shard flag through `scripts/test-bun.mjs`.
5. **Durable shard forwarding** after `scripts/test-without-document-retention.mjs` forwards argv.
6. **`static` without `dist`** on a hosted runner, confirming the tsconfig `paths` reading.
7. **Release timing** on a `workflow_dispatch` dry run before the next tag.

Owner actions that are not workflow edits:

- Rotate the GitHub PAT found in plaintext in `/root/.npmrc` on `nyan-dev-01` (`//npm.pkg.github.com:_authToken=ghp_...`). Every self-hosted runner on that host can read it, and it will outlive this migration.
- Confirm the plan's concurrent-job limit in Settings -> Billing -> Actions, and record it in `policy.json`.
- Decide whether branch protection requires `Merge gate` alone or `Merge gate` plus `Policy and impact`.
