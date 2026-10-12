---
name: nyan-error-handling
description: Design and review failure handling in Nyan, covering recovery, retries, background work, and user-visible error reports.
---

# Error handling in Nyan

Every expected failure has a stable discriminant, an owner that handles it, a guarantee about the state it leaves, and a next step the user can take. Never dispatch on the error message. Keep the original cause, and keep the machine-readable identity separate from the displayed text.

Catching an exception limits how far it propagates; it does not undo a change that already happened. Only the owner of the state can prove that later work is safe. Otherwise stop the dependent work, discard the state that can no longer be trusted, or report the outcome as unknown. A retry needs an idempotency guarantee, defined cancellation, and a budget.

Missing configuration fails at the earliest point it is known and names the setting or `NYAN_*` variable to set. It never falls back silently to a different behavior.

The final report says which operation was affected, what is known and unknown about the outcome, what the system did about it, and what is safe to do next. Do not claim that something was rolled back, succeeded, or can be retried safely without evidence.
