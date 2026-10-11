# Agent Notes

An Agent Note records a design decision for this repository: the problem, what was decided, and what was rejected. It holds the rationale that code, tests, and other docs cannot carry, so a later session does not reopen a settled question.

## When to write one

Write or update a note in the same change only for a lasting decision whose reason is not visible in the code. Mechanical or local edits do not need one. If a note already owns the decision, update it instead of adding another.

## Layout

```
.agents/notes/
  proposed/     considered, not built yet
  implemented/  shipped; kept current with what shipped
  rejected/     declined; kept while it prevents a plausible mistake
```

File name: `yyyy-mm-dd-short-title.md`, dated when the topic was first proposed. Move the file between folders when its status changes and update the `Status:` line in the same change. A note is never edited into a different decision: write a new note and link both.

## Format

```markdown
# Agent Note: <title>

Status: proposed | implemented | rejected: <one-line reason>

## Problem

## Decision        (implemented)  or  ## Proposal  (proposed, rejected)

## Alternatives considered

## Consequences    (implemented: what it cost and what it bought)
```

`## Alternatives considered` is required: list each real alternative and why it lost. Link other notes with relative Markdown links.
