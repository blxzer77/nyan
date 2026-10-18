# Agent Note: OCR review cadence

Status: implemented

## Problem

`.github/workflows/ocr-review.yml` used to send every pull-request push to the review service on `nyan-dev-02`, at
`medium` effort with `deepseek-flash`. The service is tailnet-only, so each review occupied one of the six
self-hosted runner slots for as long as it took, even when the next push superseded the result.

Measured over the 75 old-workflow runs in 2.5 days (62 success, 11 cancelled by the concurrency group, 2 failure):

- successful run median: 15.4 min; p90: 32.5 min; longest: 60.6 min;
- total: 20.4 self-hosted runner-hours, about 8 hours per day;
- a pull request pushed ten times could start ten reviews, with the first nine cancelled or unread;
- an earlier six-file comparison measured `low` at about 7 min with 8 findings and `medium` at about 30 min with 14,
  including a real regression that `low` missed.

## Decision

OCR is advisory and runs in batches, not on every pull-request push:

1. **Daily batch:** the scheduled workflow reviews `main` from the head of the last successful scheduled OCR run to
   the current `main` head. That head SHA is the bookmark; failed runs do not advance it, so the range is retried.
   The first run falls back to the preceding 24 hours.
2. **Release batch:** a maintainer manually dispatches the workflow with `range=since-last-tag` before pushing a release
   tag. Manual runs never move the daily bookmark.
3. **Model:** the only model sent is `gpt-6.1-sol`.
4. **Effort:** the service's maximum accepted value is `high`. The requested `xhigh` value was tested end-to-end and
   rejected by the dispatch command (`must be one of low, medium, high`), so `high` is the effective maximum.
5. **Result:** the workflow writes one batch result to the job summary and keeps the full output as a 30-day artifact.
   It attempts to open one `ocr-review` issue per batch when repository Issues are enabled. This repository has Issues
   disabled (`HTTP 410`), so the current fallback is a warning plus the summary and artifact; the review is not lost.
6. **Blocking:** OCR is not part of `Merge gate`, does not fail a release, and never blocks on a model finding alone.
   A finding can affect a merge or release only after a verified reproduction or a deterministic rule confirms it.

The review remains on `[self-hosted, Linux, X64, repo-nyan]` because the dispatch service is reachable only over the
Tailnet. The pull-request trigger and fork guard were removed: no pull request can reach this runner through OCR.
The workflow uses one non-cancelling concurrency group, so a running high-effort review is not interrupted by another
batch.

## Verification

- The model catalog contains `gpt-6.1-sol`.
- The first real dispatch with a 381-line custom range completed the review in about 3.8 min, but issue creation
  correctly exposed that repository Issues are disabled.
- After moving artifact upload before reporting, adding summary truncation below GitHub's 1 MiB limit, and making HTTP
  410 a warning, the second real dispatch completed successfully in about 3.7 min. It accepted `gpt-6.1-sol` at
  `high`, uploaded artifact `ocr-review`, wrote the report path, and emitted the expected Issues-disabled warning.
- A custom base that is not an ancestor now fails loudly instead of silently reviewing an empty range.
- `npm run check` and actionlint pass.

## Alternatives considered

- **Review every pull-request push:** rejected because it spent about 8 self-hosted runner-hours per day on superseded
  work and conflicted with the owner's decision that OCR is reference material, not a gate.
- **Review only when a PR is marked ready or labelled:** rejected for now; the daily and release ranges provide coverage
  without requiring a person to remember a label.
- **Use `xhigh`:** rejected by the service; its CLI accepts only `low`, `medium`, and `high`.
- **Make OCR required:** rejected; an unverified model finding is not evidence.
- **Run OCR on a hosted runner:** rejected; hosted runners cannot reach the tailnet-only service.
- **Enable repository Issues automatically:** not changed. It is a repository setting decision; until the owner enables
  it, summaries and artifacts are the durable result store.

## Consequences

The old per-push OCR load is gone. The daily batch and the pre-release batch each consume one self-hosted slot only
while they run, and a failed batch retries the same range. Findings arrive after the relevant merge for the daily batch
and before a tag is pushed for the release batch, but neither silently changes release or merge state.
