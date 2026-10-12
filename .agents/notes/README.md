# Agent Notes

An Agent Note records a design decision for this repository: the problem, what was decided, and what was rejected. It holds the rationale that code, tests, and other docs cannot carry, so a later session does not reopen a settled question. Task lists, mechanical changes, and implementation logs are not notes.

## When to write one

Write or update a note in the same change only for a lasting decision whose reason is not visible in the code. Mechanical or local edits do not need one. If a note already owns the decision, update it instead of adding another.

## Layout

```
.agents/notes/
  proposed/     considered, not built yet
  implemented/  shipped; kept current with what shipped
  rejected/     declined; kept while it prevents a plausible mistake
  archived/     superseded; frozen, read-only, not a source of current behavior
```

Inside each status folder, group by kind: `architecture/` for source boundaries and runtime ownership, `process/` for CI, upstream sync, dependencies, and release, and `feature/`, `bug-fix/`, `simplification/`, or `testing/` where they fit. Do not use `refactor/`.

File name: `yyyy-mm-dd-short-title.md`, dated when the topic was first proposed. Move the file between folders when its status changes and update the `Status:` line in the same change. A note is never edited into a different decision: write a new note and link both. Before archiving or deleting a note, keep any reason that still prevents a wrong decision and fix the links that point to it.

## Format

```markdown
# Agent Note: <title>

Status: proposed | implemented | rejected: <one-line reason>

## Problem

## Decision        (implemented)  or  ## Proposal  (proposed, rejected)

## Alternatives considered

## Consequences    (implemented: what it cost and what it bought)

## Verification    (implemented: what was run and what it showed)
```

`## Alternatives considered` is required: list each real alternative and why it lost. An implemented note describes the code as it is now, in the present tense; when the code changes, update the note in the same change. Link other notes with relative Markdown links. Notes are written in English.
