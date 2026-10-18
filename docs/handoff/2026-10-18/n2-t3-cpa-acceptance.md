# T3 mapped to the N2 hooks: CPA acceptance cases for task C (2026-10-16)

Author: N2 session. Inputs: `login-T3-cliproxyapi-durable-dependencies.md` (written against the old main), the N2 hooks
note and spec 7.2 / 8.3 as merged in `ca47fe014`, and the CPA sources read at
`packages/coding-agent/src/extensions/cliproxyapi/` (index.ts, usage.ts, retry.ts, pause.ts, quota.ts).

## 1. Corrections to the T3 list

1. **CPA never subscribes to `agent_before_settle` or `turn_end`.** The subscriptions are (file:line):
   `before_provider_request` (index.ts:177, usage.ts:230), `model_select` (index.ts:237), `agent_settled`
   (index.ts:241, usage.ts:324), `session_start` (index.ts:272), `session_shutdown` (index.ts:308, usage.ts:358),
   `message_end` (retry.ts:42, usage.ts:305), `before_agent_start` (usage.ts:206), `after_provider_response`
   (usage.ts:257), `provider_stream_event` (usage.ts:291), `agent_end` (usage.ts:313).
   So **`onBoundary` is not part of the CPA acceptance**. T3 gap 4 ("settlement") and the instruction "settlement ->
   onBoundary" do not apply: the quota poll runs on `agent_settled`, which the inventory classifies as `product-api`,
   a host event, not a durable hook. It is emitted by task C's extension host when a run settles, with
   `{ aborted }`. Consequence: Decision #23(b) (no boundary hook after an error or abort) does not touch the quota poll.
   The host must emit `agent_settled` for every settled run, including `unanswered` ones, to keep the legacy behaviour.
2. **`before_agent_start` is missing from T3.** It maps to the existing `beforeRequest` hook, but `beforeRequest` runs
   on every request attempt (tool rounds, retries, recovery), while the legacy event fires once per prompt. CPA's
   handler is already idempotent (`if (this.run) return`, "keep one timer across retries and tool continuations"), but
   the adapter should still emit it for the first request of a run only.
3. **The "task memo" suggestion for the quota throttle is wrong.** The poll is not durable-task work; see section 3.

## 2. CPA function to durable member

"Host" means a task-C extension-host event or product API, not a hook.

| CPA function | Nyan event (file:line) | durable member | Notes for the adapter |
| --- | --- | --- | --- |
| Pause gate; Fast tier | `before_provider_request` (index.ts:177) | `GenerationHooks.beforeProviderRequest` | Replacement chain. The adapter calls `runner.emitBeforeProviderRequest(payload)` and returns `{ payload }` only when it changed (`undefined` keeps the adapter's body). `ctx.model` for the handler is the hook's `model`, not the agent document. The handler blocks by awaiting; see section 3. |
| Request telemetry start | `before_provider_request` (usage.ts:230) | `beforeProviderRequest` (same member) | One bridged member runs both CPA handlers in extension order. May run more than once per attempt; CPA counts calls as attempts. |
| Header quota; response status; ttft start | `after_provider_response` (usage.ts:257) | `afterProviderResponse({ status, headers, model })` | Observers. Called by the adapters CPA uses (`openai-responses` line 191, `openai-codex-responses` HTTP path 415, `anthropic-messages` 690); not by the Codex WebSocket path, nor by Google/Vertex. |
| First SSE frame, ttft | `provider_stream_event` (usage.ts:291) | `onProviderStreamEvent({ data, model })` | The legacy event is `{ provider, api, model, data }`; CPA tests `event.provider`. The adapter builds it from the hook's `model`. The adapter awaits the callback, so a slow observer slows stream reading; CPA's handler is synchronous. |
| Retry normalizer; request record | `message_end` (retry.ts:42, usage.ts:305) | `rewriteMessage` | Assistant role only (Decision #23a); both CPA handlers filter to assistant messages of its provider anyway. The adapter calls `runner.emitMessageEnd(message)` and returns `{ message }` only when changed. Runs for the terminal provider message, including error messages, before classification, so a rewritten `errorMessage` makes it retryable. Not called for a deferred result. |
| Run timer, status | `before_agent_start` (usage.ts:206) | `beforeRequest`, first request of a run | Dedupe in the adapter. |
| Per-run usage | `agent_end` (usage.ts:313) | host (committed `AgentEvent`) | Needs the run's messages. |
| Usage summary notify; quota poll | `agent_settled` (usage.ts:324, index.ts:241) | host event | Emitted per settled run, any outcome, `{ aborted }`. |
| Footer labels | `model_select` (index.ts:237) | host (model change in the view) | `ctx.ui.setStatus`. |
| Provider registration | `session_start` (index.ts:272) | D (loader flush) | Already registered by D at startup; `session_start` also re-registers after the background catalog refresh through `runtime.registerProvider`, which needs the bound runner (C). |
| `/pause`, `/continue`, `/fast`, `/cpa-*` | `registerCommand` | host command dispatch | Decision 4 (UI scope): needs `ctx.ui.notify` and friends. |
| `/login CLIProxyAPI` | provider `oauth.login` | product shell | Not a hook. |

## 3. The two recovery questions

### Q1. The pause gate blocks in `beforeProviderRequest`: what happens on abort, cancel, close, restart?

How it is wired (`core/…` is the merged `packages/durable/src/harness/generation.ts`, `providerCallbacks`):
`onPayload` calls `awaitWithContext(runtime.hooks.each("beforeProviderRequest", ...), context)`, with the invocation's
context. The adapter's HTTP send happens after `onPayload` returns, so while the gate waits **no request has been sent**.

| Event while the gate waits | What happens | Evidence |
| --- | --- | --- |
| User abort (`abortTask`, Escape) | `awaitWithContext` rejects at once with the abort error; `onPayload` throws; the run ends `unanswered / aborted`; the attempt is not stuck. | Existing test `harness-provider-hooks.test.ts:185` ("stops waiting for a hook that never returns when the run is aborted"). |
| `close()` of the Harness | Invocations are aborted without writing an outcome; the wait is released the same way; `close()` does not hang on the hook. | Same mechanism; probe below. |
| Reopen after close (restart) | The generation task resumes in its request phase, calls the hooks again; the gate re-reads the persisted pause and blocks again; **no request was sent before, none is sent twice**. With the gate open on reopen: exactly one request, one assistant entry, the hook ran twice. | Probe, passed (2 of 2): `D:\nyan-orchestration\n2-probe-gate.test.ts.txt`, SQLite storage. |
| Reopen with the gate still closed, then abort | Ends `unanswered / aborted`, nothing sent; the aborted run does not restart on a later open. | Same probe. |
| Timeouts | `settings.stream.timeoutMs` is not consumed while the gate waits: the SDK `timeout` option and Codex's `AbortSignal.timeout(httpTimeoutMs)` are created after `onPayload` (`openai-responses.ts:174` then `:180`; `openai-codex-responses.ts:279` then `:293` / `:398`). | Read, not run. |

**What can still go wrong: the gate itself ignores the signal.** `waitForPauseToEnd(agentDir, controller)` (pause.ts)
polls every 200 ms in a `while (true)` loop with a plain `setTimeout`, no `signal`, no `unref`. After an abort or a
close the durable side has moved on, but the abandoned gate keeps polling until `/continue`. Effects:

- a leaked timer loop per abandoned request (small, but unbounded in count if the user aborts repeatedly while paused);
- the timer is not unref'd, so after the Harness is closed the Node process stays alive until `/continue`. In print or
  json mode that is a hung process instead of an exit.

This is already true in legacy (the handler there also ignores `ctx.signal`), so it is not a regression, but the
durable path makes it visible because abort and close now actually return.

**Recommended change (login session's file, `pause.ts` / `index.ts:177`):** pass `ctx.signal` into
`waitForPauseToEnd`, stop polling and reject (or return) when it aborts, and `unref()` the timer. Task C supplies
`ctx.signal` from the hook's `context.abortSignal`. Acceptance case A3 below tests it.

### Q2. Where does the quota-poll throttle live so a rejected management key is not sent again after replay or restart?

State today (`quota.ts:367-415`): `lastStartedAt`, `bannedUntil`, `rejectedFingerprint` are private fields of the
`QuotaPoller` instance, created in the extension factory closure. Nothing is persisted. The proxy counts every wrong
key; five ban the client address for 30 minutes (`DEFAULT_BAN_SECONDS`).

| Situation | Behaviour with the state in the closure |
| --- | --- |
| Hook replay inside the process (a crash before a commit reruns a hook; the quota poll is not a hook, so it does not replay at all) | Not affected. The poller is not driven by a durable task. |
| Adapter wrapper rebuilt (handler set changed) | Safe **only if** the Nyan extension instance is not recreated. Rule S2 in `n2-design-freeze.md`: the runner and extension instances are created once per process. |
| RPC `new_session` (durable `replaceSession` closes and reopens) | **Unsafe if the extensions are reloaded per `openDurable`**: a new poller forgets the rejection and resends the key. Rule S2: services and extensions are created once and passed to each `openDurable`; the same applies to B's `replaceSession`. |
| Process restart | **Unsafe**: state is gone. This is the same in legacy. A key that was rejected is sent again once per restart (counts toward the 5-attempt ban). |

**Where to put the state.** Not in a durable task memo or a conversation document. Reasons: the ban is per client
address and per key, so it spans sessions and processes, while durable documents are per conversation and exist for
replay; and the poll is not durable-task work, so a memo has no owner that reads it. Recommended: a small file in the
agent directory next to CPA's other caches (`cache.ts`), holding `{ rejectedFingerprint, bannedUntil }`, written when
the poller learns of a rejection or ban, read in the poller's constructor, and cleared on success. The fingerprint is
already a non-reversible identifier ("without revealing the key"). After a restart: a still-rejected key is not sent
again; once `bannedUntil` has passed, one probe is legitimate. This is a change in the login session's files
(`quota.ts`, `cache.ts`); the N2 session only guarantees S2.

## 4. Acceptance cases for task C (CPA as the first real use case)

Each case: remove the bridge, a test fails. Use the faux provider and a loopback stub; no real proxy, no real keys;
isolated HOME / USERPROFILE / `NYAN_CODING_AGENT_DIR`.

| # | Case | Passes when |
| --- | --- | --- |
| A1 | Fast: Fast on, request to a CPA model | the adapter's `onPayload` receives `service_tier: "priority"`; a request to another provider is unchanged |
| A2 | Pause: `/pause`, then a prompt | no provider call is made until `/continue`; then exactly one |
| A3 | Pause, then abort and close | the run ends `unanswered / aborted`; no timer keeps the process alive (needs the `pause.ts` change in Q1) |
| A4 | Pause, close, reopen paused, `/continue` | one request in total, one assistant entry |
| A5 | `after_provider_response` | `observeResponseHeaders` receives the quota headers; `pending.httpStatus` set |
| A6 | `provider_stream_event` | first frame sets `firstEventMs`; handler sees `event.provider === "cliproxyapi"` |
| A7 | Retry normalizer | a transient stream error message gets the network prefix and the run retries once |
| A8 | Request record | one record published on `cliproxyapi:request` per terminal assistant message |
| A9 | `before_agent_start` | fires once per prompt, not per tool round |
| A10 | `agent_settled` after an `unanswered` run | usage summary notify and quota poll still happen |
| A11 | Quota throttle across `new_session` | no second management request with a rejected fingerprint |
| A12 | No handler, no cost | with CPA absent, none of the four provider callbacks is set (already tested in durable) |

## 5. Not verified

- A4's reopen path was run in durable with a hand-written hook, not with CPA's gate.
- No part of Q2's recommended state file exists yet; it is a design, not a run.
- `agent_settled` emission by the extension host does not exist yet (task C).
