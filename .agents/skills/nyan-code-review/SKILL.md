---
name: nyan-code-review
description: Review a Nyan change for state ownership, lifecycle, recovery, architecture rules, evidence, and user-visible behavior.
---

# Reviewing a Nyan change

Read the root `AGENTS.md`, the AGENTS.md of each touched package, and the notes that own the area. Then read the whole diff and its callers, not only the changed lines. Look for behavior defects, lifecycle bugs, and security problems first; leave style comments that have no evidence behind them.

Questions to answer:

- Which owner of a fact does the change touch? Does it create a second source of truth for a session, provider, tool, or setting?
- After a failure, a cancellation, or a restart, who owns the state? Can a partial or unknown side effect be reported as success?
- Are registrations, listeners, subprocesses, and temporary files released on every path? Can the operation run twice without doing its side effect twice?
- Do the tests go through the real CLI, provider, session, or extension entry point, and observe external state, events, or persisted results?
- Does a new import respect `docs/architecture/layers.json`, or does the change loosen a rule to pass?
- Does it break something released versions depend on: session files, settings, `auth.json`, durable storage, CLI flags, `NYAN_*` variables, package exports? If so, did the author say so?
- Does it bring back Pi names, `PI_*` variables, `.pi` paths, or a default URL for a service Nyan does not run?
- Do docs, error messages, and model-visible text match the code and tests?
- Does it describe experimental, example, or upstream candidate code as a Nyan feature?

Every finding states the location, the impact, how it is triggered, and the evidence. Put ownership and architecture problems that span files in the overall comment, and local defects on the smallest range of the diff.
