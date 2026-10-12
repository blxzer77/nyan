# Agent Note: Rename-aware upstream sync

Status: implemented

## Problem

The first sync after the fork brings in 24 upstream commits that touch 219 files. Every one of those files was also edited by the Pi-to-Nyan rename, and the rename changed about 1,100 files in total. A plain `git merge` of the upstream side reported 798 conflicts, almost all of them the same word on both sides: `@earendil-works/pi-ai` against `@ny4n/ai`, `PI_` against `NYAN_`. Resolving that by hand hides the real conflicts among the noise, and taking "ours" for the whole file silently drops the upstream change.

## Decision

Apply the rename to the upstream side too, then merge.

1. Export the v1.1.0 tree and the target upstream tree.
2. Run both through the same rename rules used for the fork (package names, `PI_`/`Pi`/`pi` word forms, path components, repository links), plus the final npm scope. Provenance links and `Math.PI` stay protected by the rules.
3. Commit the two normalized trees as scratch refs, the second on top of the first.
4. `git merge-tree --write-tree --merge-base=<normalized v1.1.0> HEAD <normalized target>` yields the merge with rename detection. The normalized base makes the upstream diff contain only what upstream changed, so conflicts are real: 27 paths, of which 12 were deleted changelogs.
5. Resolve, then run the full verification. The scratch refs are deleted afterwards.

The sync manifest for this run is `.agents/upstream/pi-sync-1-cdaf6c227.json`.

The history stays honest: the result is committed as a merge of `main` and the upstream line, even though its tree was computed against the normalized base.

## Alternatives considered

**Plain merge.** 798 conflicts; rejected as unreviewable.

**Cherry-pick each upstream commit.** Each pick conflicts for the same rename reasons and the picks do not compose, because later commits depend on earlier files.

**Copy the changed files over.** Overwrites Nyan's changes in the same files. The rename script is idempotent, so normalizing is cheaper than reviewing overwritten code.

## Consequences

The rules live in `.agents/skills/nyan-upstream-sync/normalize-upstream.mjs`, so the next sync starts from the same definition of "normalized". When the fork renames something new, add the rule there in the same change; a rule missing from the script comes back as a conflict on the next sync.

The checks found three places where upstream code did not fit this tree and were fixed as part of the sync: schema files that the `ai` contract layer would have imported from `providers/` (moved to `schemas/`), a new `durable/images/` directory with no layer (added as an adapter layer), and a test script that used POSIX `VAR=value command` syntax (replaced by a small launcher).

## Verification

`npm run check` and `npm test` on Windows; the sync manifest lists what was taken, dropped and not wired to a Nyan entry.
