# Agent Note: Independent of Pi

Status: implemented

## Problem

Nyan was forked from Pi v1.1.0 and synced from it once ([rename-aware upstream sync](2026-10-12-rename-aware-upstream-sync.md)). Pi's `main` has kept moving: 79 commits were ahead of that sync when this was written. Nyan has since gone its own way (layered architecture with an enforced dependency direction, no hosted services, Bun standalone executables with in-place update, its own changelog and release pipeline, a smaller set of packages). Keeping up means one more rename-aware merge each time, with conflicts in the files both sides changed, and a review of every upstream change against decisions Pi did not make.

## Decision

Nyan does not follow Pi. There is no scheduled sync, and nobody merges or rebases onto `upstream`.

- The `upstream` remote and `.agents/upstream/` stay as the record of where the code came from.
- A Pi change is taken only when the owner names it. It is ported as Nyan code (by hand for a small change, with the [upstream sync skill](../../../skills/nyan-upstream-sync/SKILL.md) for a range), reviewed against Nyan's rules, and recorded in `.agents/upstream/`.
- Pi issues, pull requests, workflows, and release processes stay out of Nyan's documentation and process, as before.

## Alternatives considered

**Sync Pi periodically.** The cost grows with the distance between the trees, and most upstream work (its release tooling, its hosted-service features, its own governance) is content Nyan removed on purpose.

**Take only Pi's fixes automatically.** A fix to code Nyan has reorganized still needs reading and porting, so nothing is saved by automating the fetch; and a bot that merges another project's changes into a published package is the kind of unreviewed change Nyan's rules exclude.

**Remove the `upstream` remote and the records.** They are provenance, and the MIT license notice that Nyan keeps refers to that origin. They cost nothing to keep.

## Consequences

A bug or security fix that Pi makes in code Nyan still shares is not picked up unless someone notices it and asks for it. Nobody is assigned to watch Pi's releases, so this is a real gap, not a managed one. The sync tooling (`normalize-upstream.mjs`, the skill) stays for the occasional deliberate port and can be removed once it is clear it will not be used again.
