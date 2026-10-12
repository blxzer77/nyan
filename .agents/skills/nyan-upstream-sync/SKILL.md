---
name: nyan-upstream-sync
description: Bring Pi upstream commits into the Nyan fork with a rename-aware merge, keeping Nyan's changes and recording the source and the evidence.
---

# Syncing from Pi upstream

The fork renamed nearly every file it shares with Pi, so a plain `git merge` of upstream reports hundreds of conflicts that are the same word on both sides. Normalize the upstream side with the same rename rules first, then merge. The method and its trade-offs are in [rename-aware-upstream-sync](../../notes/implemented/process/2026-10-12-rename-aware-upstream-sync.md).

1. Record the exact commits of `main`, the last synced upstream commit (the newest file in `.agents/upstream/`), and the target upstream commit. The working tree must be clean.
2. Export the last synced tree and the target tree with `git archive` into two temporary directories.
3. Run `node .agents/skills/nyan-upstream-sync/normalize-upstream.mjs <dir> --apply` on both. Without `--apply` it prints what it would change.
4. Commit the two normalized trees as scratch refs, the target on top of the base.
5. `git merge-tree --write-tree --merge-base=<normalized base> HEAD <normalized target>` gives the merged tree and the real conflicts.
6. Resolve conflicts only in files whose Nyan owner is clear. Drop upstream changes to content Nyan removed (upstream project operations, removed packages) and every edit to Pi's changelogs: `packages/coding-agent/CHANGELOG.md` is Nyan's own, so keep this tree's version and describe the user-visible upstream changes there yourself. When ownership is unclear, stop and ask.
7. Commit the result as a merge whose second parent is the real upstream commit, not the scratch ref, so history stays true. Delete the scratch refs.
8. Run the audits and checks: no Pi names, `PI_*` variables or `@earendil-works/pi-*` imports in the merged files; `npm run check`; `npm run build:offline`; the suites of the affected packages. New upstream files often need a layer in `docs/architecture/layers.json`.
9. Add `.agents/upstream/pi-sync-<n>-<short-commit>.json`, in the format of the existing records: source commits, what was taken, dropped, adapted, and not integrated, and the verification.

When the fork renames something new, add the rule to `normalize-upstream.mjs` in the same change; a rule missing from the script comes back as conflicts on the next sync. Upstream code that no Nyan entry point reaches is candidate code, not a Nyan feature.
