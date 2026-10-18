# Agent Note: OCR review cadence

Status: proposed

## Problem

`.github/workflows/ocr-review.yml` sends the diff of a pull request to the review service on `nyan-dev-02` on every
push to the pull request, at effort `medium` with the model `deepseek-flash`, and posts the result as one comment.
The service is reachable only over the tailnet, so the job has to run on the self-hosted pool, and the job holds one
of its six slots for as long as the review takes.

Measured over the 75 runs of this workflow in the 2.5 days to 2026-10-17 (62 success, 11 cancelled by the
concurrency group, 2 failure):

- a successful run takes a median of 15.4 min, p90 32.5 min, longest 60.6 min;
- the runs add up to 20.4 runner-hours, about 8 a day, each on one self-hosted slot;
- a run starts on every `opened`, `synchronize` and `reopened`, so a pull request pushed ten times is reviewed up to
  ten times and the earlier runs are cancelled;
- an earlier measurement on a six-file diff: `low` took 7 min and found 8 issues, `medium` took about 30 min and found
  14, including a real regression that `low` missed. The highest effort has not been measured and will be slower.

OCR is already advisory: it is not part of `Merge gate` and it comments, it does not fail the build. The rule in the
[hosted CI note](2026-10-17-hosted-parallel-cicd.md) stands: a model finding blocks only after a verified reproduction
or a deterministic rule.

The owner wants the strongest review model at the highest effort, not blocking, and not on every pull request, with
reviews in batches.

## Proposal

Not decided. The shapes on the table, none implemented:

1. **Only when asked.** A pull request is reviewed when it is marked ready or carries a label, not on every push.
   Keeps the pull-request comment, costs one review per pull request that wants one.
2. **Nightly batch.** One review of everything merged to `main` since the last reviewed commit. A bookmark (a ref or
   an artifact) records the last reviewed commit. Cheap in slots, bounded to one run a day; findings arrive after
   the merge.
3. **Release range.** One review of the range since the previous release tag, before a release. Bounded, and
   aligned with the moment a mistake becomes expensive.
4. **Cheap per pull request plus a strong batch.** `low` effort on a pull request (about 7 min), the highest effort
   on (2) or (3).

Questions that only the owner or the service can answer:

- the model name the dispatch service accepts for the model the owner wants to review with, and the name of its
  highest effort; the workflow sends `deepseek-flash` and `medium` today;
- where a batch finding lands when there is no pull request to comment on: an issue, a commit comment on the range's
  last commit, or the job summary;
- who follows up a finding that arrives after the merge;
- a budget in runs or runner-hours per day.

## Alternatives considered

- **Keep per-push reviews and only raise the effort.** At `medium` they already cost about 8 runner-hours a day; the
  highest effort multiplies that and makes every push wait for a review nobody needs before the last push.
- **Make OCR required.** Rejected by the existing rule: a model finding without a reproduction is not evidence.
- **Move the review to a hosted runner.** The service is tailnet-only; a hosted runner cannot reach it. Opening it
  to the internet is a security change, not a CI change.

## Consequences

Not applicable until decided. Whatever is chosen, the self-hosted slots OCR uses are the only pull-request-related
load left on `nyan-dev-01`, and per-push reviews are the reason that load is not zero.
