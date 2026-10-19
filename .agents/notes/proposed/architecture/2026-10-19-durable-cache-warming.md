# Agent Note: Cache warming on the durable path

Status: proposed

## Problem

`cacheWarming` defaults to `streaming`, and the legacy path keeps the prompt cache entry warm by re-sending the
conversation's request with a one-token output cap while the agent run continues. Since the durable Harness became the
default path (Decision #17), nothing warms a cache there: the setting is accepted, `/session` cannot show a warming
status, and a long tool turn or a paused session pays a full cache write for its next request. Decision #31 records
`cache_warming_decision` and cache warming on the durable path as one of the ten N2 items that are fixed rather than
reduced.

## Proposal

### Who owns warming

The coding-agent's durable host layer owns it, in a new module `packages/coding-agent/src/core/durable/cache-warmer.ts`.
The durable `generation` task does not learn about warming:

- Warming must exist only while a nyan session is open, must answer to a nyan extension, and must be reported as a
  nyan notice. All three are product-shell concerns; durable's generation task is a model-request state machine that
  must stay independent of them.
- A warm request is not part of the conversation: it appends no entry, settles no submission, and must never change
  whether a run is idle. Putting it in the generation task would give it a task identity, a checkpoint, and restart
  semantics it does not need, and `close()` would have to wait for it.
- The strategy is already written and tested for the legacy path (`src/core/cache-warmer.ts`): the TTL and delay
  derivation, the replayability rule, the safety horizons, the continuation probability, and the dollar threshold.
  Reusing that computation keeps one policy instead of two, and leaves the legacy path's behavior unchanged.

The reusable parts of `src/core/cache-warmer.ts` are exported for the durable warmer: `getCacheWarmingDelayMs`,
`getPromptCacheTtlMs`, `isReplayable` (already exported), and, newly extracted, `evaluateCacheWarming` — the economics
of one decision, `{model, promptTokens, phase}` to `CacheWarmingDecision`, which the legacy class and the durable warmer
both call. The random constants (`MAX_WARMING_AGE_MS`, `MAX_IDLE_WARMING_AGE_MS`,
`CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`, `IDLE_CONTINUATION_PROBABILITY`) become exported names. The scheduling loop
(timer, deadline, abort, one refresh in flight) is written once per owner, as legacy has it today.

### How a warm request is sent

Every durable session request goes through one funnel: `openDurable` wraps nyan's `ModelRuntime` with
`createDurableModelRuntime`, and durable's generation task calls `models.streamSimple(model, { messages }, options)`
with the request it built. The honest anchor is that wrapper, so `createDurableModelRuntime` gains one hook, invoked
before it forwards a `streamSimple` call: `onSessionRequest({ model, context, options })`. Compaction summarization calls
`completeSimple` with `cacheRetention: "none"` and never reaches the hook.

The warm request is `streamSimple(model, { messages }, {...options, signal: warmingSignal, maxTokens: 1,
maxRetries: 0})`. Everything that decides the provider's cache key is therefore identical to the real request, by
construction rather than by a parallel construction:

| What must match | Why it matches |
| --- | --- |
| The model object, and its provider/model ids | It is the object the real request received. |
| The messages, in order | The real request's `Context` is passed through unchanged, so the cached prefix is the same prefix. |
| `reasoning` and the thinking level | Taken from the same `options`. A different reasoning level changes Anthropic's request shape and its cache key. |
| `sessionId` (provider session id) | Taken from the same `options`; a warm request belongs to the same provider session as the request it extends. |
| `cacheRetention`, `timeoutMs`, and the rest of `SimpleStreamOptions` | The same object, with only `signal`, `maxTokens`, and `maxRetries` replaced. |
| `transformHeaders` (`before_provider_headers`) | It is a closure in `options`; the warm request applies the same headers, so header-varied cache keys agree. |
| `onPayload` (`before_provider_request`), `onResponse`, `onProviderStreamEvent` | The same closures, so a payload rewrite applies to the warm request too. |

The differences are exactly the three fields that make it a refresh: `maxTokens: 1` (the entry must not be extended past
the prompt), `maxRetries: 0` (a warm request is best-effort), and a `signal` of its own, so cancelling warming cannot
abort the run and an aborted run's signal does not silently disable warming while the run is still streaming.

`isReplayable` still applies: an Anthropic model with budget-based thinking (reasoning without
`compat.forceAdaptiveThinking`) is not replayed, because `max_tokens` feeds its thinking budget and changes the cache
key.

### Usage and cost

A refresh that answers spends money, so its usage goes into the conversation's `nyan.usage` ledger in one commit, in
the same `models` bucket keyed `provider/modelId` that the conversation's own answers use:

```
opened.commit((tx) => { const usage = tx.doc(UsageDoc, conversationId); …sum… }, context)
```

That is the ledger durable writes provider usage into, so a client that reads usage (`usage_changed`, RPC
`get_session_stats`) sees the refresh's tokens and cost without a second source of truth. The sum repeats durable's
non-finite guard: a counter that would become non-finite is not added and the refresh's usage is dropped with a notice,
because a warm request may not fault the session. Nothing is kept in memory only. The trade-off, recorded as a
difference from legacy below, is that the refresh spends under the model's own key instead of a separate `cache_warm`
usage entry, because durable's ledger has no per-request usage entries at all.

`@ny4n/durable` exports `UsageDoc` and `UsageState` but not its `recordUsage`/`addUsage` helpers. Writing the doc
through `tx.doc` is the public path available to the coding-agent; the summation is repeated here rather than reaching
into the durable package, and [the report](../../../../nyan-orchestration/reports/n2-w1-cache-warming.md) asks whether
`recordUsage` should be exported so a later change can delete the copy.

### Cancellation and shutdown

One warm run exists at a time. It ends, and its timer and in-flight request are dropped, when:

| Event | Anchor | Effect |
| --- | --- | --- |
| A new real request starts | the same `onSessionRequest` hook | The previous run is replaced before the new request is forwarded, so no refresh races the request it would warm for. |
| The run settles in `streaming` mode | `host.settled()` in `openDurable` | Warming stops: the premise is that the user's own next request follows within the run. |
| The run settles in `idle` mode | the same anchor | The run continues in the `idle` phase until the 30-minute idle horizon. |
| `close()` | `openDurable.close` | The run is cancelled; its timer is cleared and its request is aborted, so a closed session leaves no pending timer and no socket. |
| `new_session`, `switch_session` | the reopen in `runtime.ts` / `rpc.ts` | The host that owned the warmer is closed, which cancels it; the new open starts its own warmer. |
| `fork`, `clone` (a new conversation) | `switchConversation` in the controller | The run is cancelled, because the forked conversation's transcript is not the request's prefix. |
| The model changes | `setModel` | The run is cancelled; `isCurrent` would also refuse it, but the cancel is explicit so no timer survives a model switch. |
| The setting changes to `off`, or from `idle` to `streaming` | every read of the mode | Each validation reads the mode again and stops with the reason the legacy class uses, so a mode change needs no settings listener (nyan's `SettingsManager` has none). A timer that fires after the change sends nothing. |
| The transcript or model no longer matches the request | `isCurrent`, checked before every refresh and before recording | The run stops with "conversation context changed": the request's prefix is no longer a prefix of the conversation, or the agent model differs. |

`isCurrent` compares durable entry ids, not message identity: the run records the ids of the conversation entries that
carried the request, and a later commit must still contain them in order, with the same agent model. Legacy compares
message object identity; entry ids are the same test with durable's stable identity.

### Recovery

Warming state lives in memory only and is not restored after a restart. A restart reopens the conversation and the next
real request starts a new warm run from that request. This is acceptable because a warm request has no persisted
effect of its own: it appends no entry, settles no submission, and holds no task. Losing it costs at most one cache
write that the next request would have paid anyway, and the durable recovery model is unchanged — nothing about a
closed or crashed session depends on a warm request having been sent. Usage already committed to the ledger stays.

### The `cache_warming_decision` event

Before each refresh the warmer computes the decision and asks the session's extension runner, through the durable
extension host's runner (`emitCacheWarmingDecision`), so a handler sees the same event as on the legacy path and can
return an `action`. A handler's `"stop"` ends warming with the reason "stopped by extension"; a handler that throws is
reported through `onExtensionError` (the durable `extension_error` path) and nyan's own decision stands. An override is
reported as a nyan notice and as `extensionOverride` in the status, as legacy does.

### Unknown outcomes

A warm request whose result is unknown — a timeout, a lost connection, an aborted request, or a stream that ends in
`error` — is not counted as a success and records no usage. It is reported as a warning notice naming the model and the
reason, and warming continues with the next scheduled refresh so a transient failure does not end warming. Only a
refresh that answered with a message (`stopReason` other than `error`/`aborted`) records usage. There is nothing to
recover: the request has no durable effect, and a crash during one loses only that attempt.

### Differences from the legacy path

| Aspect | Legacy | Durable |
| --- | --- | --- |
| Request options | Built by `buildRequestOptions` in `create-agent-session.ts` | Taken from the options durable's generation task built, so `timeoutMs`/`maxRetries` come from durable's `HarnessSettings.stream`. |
| Distinguishing session requests | `options.sessionId === sessionManager.getSessionId()` | The `streamSimple` funnel: only generation calls it, and compaction uses `completeSimple` with `cacheRetention: "none"`. |
| "Still current" test | Message object identity and model identity on `agent.state` | Durable entry ids of the request's transcript plus the agent model, read from the conversation view. |
| Recording usage | `sessionManager.appendUsage("cache_warm", …)`, one transcript entry, published as `entry_appended`, shown by `/session` | One commit that adds the usage to `nyan.usage`; `usage_changed` publishes it, and no transcript entry exists. |
| Warming status surface | `/session` in the interactive mode | The durable host exposes the same `CacheWarmingStatus`; the durable TUI's status line is not connected in this batch (N9 owns the TUI surface). |
| Mode changes | `session.setCacheWarmingMode()` calls `onModeChanged()` | Every validation re-reads the mode; there is no settings listener to call. |
| Warm requests in flight at settle | Aborted when warming stops | Same: the run's `AbortController` is aborted by `clearRun()`. |

## Alternatives considered

- **A warm task inside the durable Harness.** Rejected: it gives a refresh a task id, a checkpoint, and restart
  recovery it does not need; `close()` and `isIdle()` would have to account for it, and the extension event and the
  notice would move into durable. It also changes `packages/durable`'s surface, which this batch may not do.
- **Reusing the legacy `CacheWarmer` class with adapter objects.** Rejected: its `appendUsage` is synchronous and its
  `onWarmed` cannot await anything, so recording usage would have to happen after the class had already scheduled the
  next refresh. The ledger write must be a commit this layer awaits, which means owning the loop.
- **Warming from the durable event stream** (a `generation` observation) instead of the model-runtime funnel. Rejected:
  the stream reports a committed partial, not the request, so the context and options the provider received would have
  to be reconstructed rather than reused, and the cache key could drift.
- **Recording warming usage in a second `nyan.usage` bucket keyed `cache_warm`.** Not available: `UsageState` has
  `models` keyed by model and `tools` keyed by tool name; a third shape would need a durable change.
- **Doing nothing and documenting that the durable path does not warm.** Rejected: the owner requires the setting to
  mean what it says on the default path before the N2 gate.

## Consequences

- The durable path honors `cacheWarming` with the legacy policy, one warm request per real request TTL, and its spend
  appears in the conversation's ledger.
- The coding-agent carries a second scheduling loop (~120 lines) next to the legacy one, sharing the economics, the
  TTL and delay rules, and the constants. A future change to the policy touches `evaluateCacheWarming` once.
- The ledger sum repeats part of durable's `addUsage`. Exporting `recordUsage` from `@ny4n/durable` would delete the
  copy; that is a durable public-interface change and is asked for in the batch report rather than made here.
- Warming is invisible to durable's recovery story, which is what makes "in memory only" acceptable.

## Verification

`test/durable-cache-warming.test.ts` runs under Node and Bun, 14 cases each. With a fake clock and a doubled provider
it covers `streaming` during a run, `idle` across a settle, `off`, the dollar threshold, replacement by a new request
(the replaced timer is gone, checked with the timer count), `close()` and `cancel()` without a pending timer, the
`cache_warming_decision` veto, a thrown and an errored refresh reported and not recorded, the `isCurrent` stop, the
non-replayable Anthropic budgeted-thinking request, and the ledger sum with its overflow guard. One end-to-end case
opens a real durable session whose tool sleeps long enough for a refresh to fire during the turn and asserts the ledger
grew by exactly that refresh — its whole prompt read from the cache (`input` 0, `cacheWrite` 0), which only holds when
the refresh sent the same request. Thirteen mutations were applied one at a time: twelve fail a named test, and removing
the early `off` branch in `start()` survives because every refresh re-reads the setting, so the branch only avoids
arming a timer. `npm run check` exits 0. This note moves to `implemented/` once the batch merges.
