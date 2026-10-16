# Agent Note: durable hooks for the N2 capabilities

Status: proposed

## Problem

The N0 inventory ([extension-surface.json](extension-surface.json), [inventory note](2026-10-15-durable-migration-inventory.md)) classifies eight behaviors that Nyan's extension API has and durable's seven hooks cannot express. Owner decisions #18 to #21 fixed the policy: keep every streamed event, add the phased request transform, widen the settlement hook so entry writes stay recoverable, and remove no event. This note fixes the hook signatures so the durable work and the coding-agent adapter can proceed in parallel against one contract.

Durable's invariants constrain the shape. A hook runs off the Session line, so a crash before the consuming commit may rerun it; it therefore cannot write. A hook does not write model context to a busy conversation; the Harness's tasks do. So a hook that wants an entry returns a draft and the generation task appends it in its own commit. A commit may not read a table after its first table write (`ReadAfterWrite`, spec "Table rules"), so anything a commit needs from the tables is read before it. `docs/spec.md` §7.2 states that there is no public semantic event channel.

## Proposal

New members are declared on the existing hook interfaces like the current ones: required in the interface, optional at registration because `hook()` takes `Partial<HooksOf<K>>`. With no handler registered for a name, no request, commit, or event changes: a task passes a provider callback or runs a delivery loop only when `runtime.hooks.has(name)` is true.

`HookRunner<H>` gains `has(name): Promise<boolean>`. It resolves the phase agent once and applies the predicate `each` applies (`typeof handler === "function"`). `HookRunner` is exported, so `has` is additive for callers and breaking for an external implementer; the package is documented as experimental and the scheduler is the only implementer in the repository.

### The eight capabilities

| Capability | Hook | Task | Composition | Ordinary throw |
| --- | --- | --- | --- | --- |
| `phased-request-transform` | `transformConversation` | generation | replacement chain, before `beforeRequest` | report, continue |
| `provider-payload-hook` | `beforeProviderRequest` | generation | replacement chain | report, continue |
| `provider-header-hook` | `beforeProviderHeaders` | generation | replacement chain | report, continue |
| `provider-response-observe` | `afterProviderResponse` | generation | all observers | report, continue |
| `streaming-channel` | `onProviderStreamEvent`, `onStreamEvent`, `onToolUpdate` | generation, tool | all observers, sequential | report, continue |
| `message-rewrite` | `rewriteMessage` | generation | replacement chain | report, continue |
| `settlement-entry-write` | `onBoundary` | generation | accumulating chain | report, continue |
| `compaction-result-fidelity` | `beforeCompact`, widened result | compaction | first decision wins (unchanged) | report, continue |

The adapter in coding-agent registers one durable extension that bridges to Nyan's runner. Nyan's composition rules (last write wins, in-place mutation) and its diagnostics (such as the report for a dropped leading system message) are the adapter's concern; durable fixes only the typed contract below. The adapter must register a member only when the Nyan runner has a handler for the matching event, because a registered member makes `has()` true and turns the feature on; it rebuilds the extension when the handler set changes.

### Signatures

```ts
// @ny4n/ai/contracts: type-only additions
export type { ProviderHeaders, ProviderResponse } from "../types.ts";
export interface RequestTransforms {
  /** Transform the request headers the caller and the provider's auth supplied; `null` removes a header. */
  transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}
// ModelRuntime.streamSimple takes `SimpleStreamOptions & RequestTransforms`; `Models` already accepts that shape.

interface HookRunner<H extends object> {
  each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
  /** Whether any handler is registered under `name` among the phase's resolved hooks. */
  has<K extends keyof H>(name: K): Promise<boolean>;
}

interface GenerationHooks {
  // beforeRequest, afterResponse, onYield, afterTools: unchanged

  /**
   * Phase one of the request transform, before every request attempt and before `beforeRequest`. `messages` is the
   * request without system messages. A returned list that is not element-wise identical to the input replaces it, and
   * the Harness restores prompt and tool state: the request becomes `[head, ...returned]` with
   * `head = getCurrentSystemMessage(before)`, or just `returned` when there is no system message. An identical list
   * leaves the positional system entries untouched.
   */
  transformConversation(
    request: { readonly messages: readonly Message[] },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly messages: readonly Message[] }>;

  /** The provider body of one request attempt. May run more than once per attempt; must be idempotent. */
  beforeProviderRequest(
    request: { readonly payload: unknown; readonly model: Model<Api> },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly payload: unknown }>;

  /**
   * The headers the model runtime holds once authentication and `ConversationStreamOptions.headers` are merged, before
   * the provider adapter adds its own defaults. `null` removes a header. Once per attempt.
   */
  beforeProviderHeaders(
    request: { readonly headers: Readonly<ProviderHeaders>; readonly model: Model<Api> },
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly headers: ProviderHeaders }>;

  /** Status and headers arrived; the body is not consumed yet and waits for the observers. Zero or more times per attempt. */
  afterProviderResponse(
    response: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly model: Model<Api> },
    api: HookApi,
    context: Context,
  ): void | Promise<void>;

  /** One parsed provider stream frame, before normalization, read-only. Adapter-owned: see the delivery rules. */
  onProviderStreamEvent(
    frame: { readonly data: unknown; readonly model: Model<Api> },
    api: HookApi,
    context: Context,
  ): void | Promise<void>;

  /** Every event of the request attempt's assistant stream in provider order, including `start`, `done`, and `error`. */
  onStreamEvent(
    stream: { readonly event: AssistantMessageEvent; readonly attempt: number },
    api: HookApi,
    context: Context,
  ): void | Promise<void>;

  /**
   * The terminal assistant message of `request` or `poll`, before `afterResponse` and before classification. A valid
   * returned message replaces it, so the answer, the usage ledger, and the tool calls all use the replacement. Not
   * called for a deferred result, nor for a partial converted to an aborted entry.
   */
  rewriteMessage(
    message: AssistantMessage,
    api: HookApi,
    context: Context,
  ): HookResult<{ readonly message: AssistantMessage }>;

  /**
   * A turn or run boundary. Returned entries are appended by the generation task in the commit that ends the turn or
   * settles the run, after the answer and before queued inputs, so a crash before that commit reruns the hook and a
   * crash after it leaves the entries exactly once.
   */
  onBoundary(boundary: GenerationBoundary, api: HookApi, context: Context): HookResult<BoundaryDecision>;
}

type GenerationBoundary = {
  /** `turn_end`: after every turn that produced an answer or finished a tool round. `settle`: the run would end. */
  readonly kind: "turn_end" | "settle";
  /** The turn's assistant message; for `settle`, the final answer. */
  readonly assistant: AssistantMessage;
  /** Absent when the answer is committed together with the boundary. */
  readonly assistantEntry?: EntryId;
  /** The tool round's result entries in call order; empty for an answer. */
  readonly toolResults: readonly EntryId[];
  /** What earlier handlers of this boundary asked for. */
  readonly entries: readonly BoundaryEntry[];
  readonly continue: boolean;
};

/** An entry draft a boundary hook may return: user messages and data only, no head marker, no built-in kind. */
type BoundaryEntry = {
  readonly kind: string;
  readonly model?: readonly UserMessage[];
  readonly data?: JsonValue;
  readonly edits?: readonly ContextEdit[];
};

type BoundaryDecision = { readonly entries?: readonly BoundaryEntry[]; readonly continue?: boolean };

interface ToolHooks {
  // beforeTool, afterTool: unchanged

  /** Running output, details, or diagnostics changed. See the delivery rules. */
  onToolUpdate(
    update: {
      readonly call: ToolHookCall;
      /** Output pushed since the previous delivery. */
      readonly output?: string;
      /** UTF-8 bytes of output dropped before `output`: the pending window was full, or an environment window skipped them. */
      readonly droppedBytes?: number;
      /** The latest details, when they changed. */
      readonly details?: JsonValue;
      /** Diagnostics recorded since the previous delivery. */
      readonly diagnostics?: readonly ToolDiagnostic[];
    },
    api: HookApi,
    context: Context,
  ): void | Promise<void>;
}

type CompactionSummary = {
  readonly summary: string;
  /** First entry kept verbatim; default is the entry range selection chose. Must be a valid cut (below). */
  readonly firstKept?: EntryId;
  /** Stored on the compaction entry as `data.details`. */
  readonly details?: JsonValue;
  /** Spend of the extension's own summarization, added to `nyan.usage.models["<provider>/<modelId>"]`. */
  readonly usage?: { readonly model: ModelRef; readonly usage: Usage };
};
// CompactionHooks.beforeCompact returns HookResult<{ readonly decline: true } | CompactionSummary>.
```

### Rules

**Phased transform.** Phase one sees `messages.filter(m => m.role !== "system")`. Handlers run in extension order, each seeing the previous output. The restoration is Nyan's `restoreSystemMessages`: compare the returned list with the list the handler received element by element by identity, and only a difference replaces the system entries with the current merged system message. A change collapses the positional system entries into one leading message, which changes the prompt-cache prefix; that cost is Nyan's today. `getCurrentSystemMessage` comes from `@ny4n/ai/utils/transcript`, the subpath durable already uses for runtime helpers, not from the `contracts` entry. In-place mutation of the received list is not part of the durable contract (the type is `readonly`); the adapter copies the list, detects mutation, and returns the copy.

**Provider seam.** The four hooks reach the model runtime as `onPayload`, `transformHeaders`, `onResponse`, and `onProviderStreamEvent` of the request options, each set only when `has()` is true, through one internal plumbing function. They stay four hooks because their composition differs (replacement, replacement, observers, observers), which closes the inventory's open question about merging the header and response hooks. Each callback handed to the model runtime never throws except on abort: an adapter may await it without a guard (the Anthropic adapter) or wrap a throw into a stream error (the Codex adapter), and `each` already reports an ordinary throw and continues. What the adapters call is what Nyan's own extension events see today, so durable inherits it unchanged: `onPayload` can run again inside one attempt (the Anthropic strict-tool fallback rebuilds the body and calls it again), `onResponse` is not called by the Google, Vertex, or Codex WebSocket paths and is called per HTTP try on the Codex SSE path, and frames come only from adapters that support them. Header transforms run before the adapter adds its defaults, so a hook sees and can remove what the caller and auth supplied, not the adapter's own `User-Agent`. Nothing here is recovered: the resend after a crash rebuilds all four.

**Streaming channel.** The channel is live, in memory, and not durable. Delivery is sequential per source: all handlers see event `k` in extension order before any handler sees event `k+1`. Every wait for a handler races the invocation signal, so a hook that never returns delays only until abort; after abort the remaining events of the source are discarded. The three sources are not alike:
- *Provider frames* are awaited by the adapter, so a slow observer slows stream reading. A frame repeated by an adapter's own retry (the Codex WebSocket path retries without a new `start`) is not distinguished; frames are adapter-owned.
- *Assistant events* are pushed by the adapter into the stream's own queue (`EventStream.push` enqueues when no consumer waits), so no consumer can slow the provider. Reading the stream must not wait for observers either, or the throttled partial commit and the abort path would stall. Events therefore go to a per-attempt FIFO drained by one pump; the queue is as large as the response, which `maxTokens` bounds, and the pump drains before classification, racing the signal, so observers see every event before `afterResponse`.
- *Tool updates* come from `output()` and `diagnostic()`, which are synchronous, so the producer cannot wait (`details()` is asynchronous, resolves with its progress commit as today, and is not delayed by observers). At most one delivery is in flight and one update is pending; updates arriving meanwhile coalesce: output chunks concatenate, details keep the latest value, diagnostics append. The pending output is capped at `outputLimits.maxBytes` bytes; when it overflows, the oldest code points are dropped and the next delivery reports `droppedBytes`, which also counts output an environment window skipped. Observers get the pushed chunks, not the retained window of the result.

After a crash the request is resent and the assistant stream starts again with `start`. `attempt` counts the generation's retries and a resend keeps it, so a new `start` is the only mark of a restart. A rerun of a replay-safe tool reports from scratch. The committed `AgentEvent` stream remains the source for `--mode json`, `--mode rpc`, and the TUI; these hooks are the live tap for extensions that subscribed to `provider_stream_event`, `message_update`, and `tool_execution_update`.

**Message rewrite.** `rewriteMessage` is typed to the assistant role. The harness checks a replacement before accepting it: `role === "assistant"`, `content` an array, `stopReason` a known value, `usage` carrying numeric `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` with numeric `input`, `output`, `cacheRead`, `cacheWrite`, `total`, and a copy under `copyJson`. A replacement that fails is reported and ignored, because `recordUsage` and `appendEntry` run inside the classification commit and a throw there would fault the generation. `afterResponse` then observes the message that will be committed. The ledger records the replacement's usage, which is what makes a cost override work. The cliproxyapi extension's transient-error normalizer rewrites `errorMessage` of an assistant error message so `isRetryableAssistantError` accepts it; that works because the rewrite precedes classification.

**Boundary.** Order at a final answer: `onYield`, then `onBoundary({ kind: "turn_end" })`, then, when neither asked to continue, `onBoundary({ kind: "settle" })`, with `entries` and `continue` accumulating across handlers and across the two calls. After a tool round: `onBoundary({ kind: "turn_end" })` before the hand-over, and `settle` when `terminate` or `handoff` ends the run. In one commit: `prepareBoundary`, append the answer, append the drafts, then `applyBoundary`, which is the order `finishToolRound` already uses for a handoff entry.

Drafts are checked before the commit, off the line, against `runtime.context()`. The commit therefore performs no table read after its first write, and the read is current enough: a hook cannot change the context, and the only Harness writer that can land between the check and the commit is a background compaction. If one does, an edit whose target the compaction left out of the active context has no effect, because edits apply to active entries only; nothing is reported, and the draft's other fields are appended as usual. `Tx.appendEntry` itself validates nothing about `head` or `edits`: a bad draft does not throw, it silently changes which entries are active, and a value that is not strict JSON throws and would fault the generation. The checks: `kind` is a non-empty string and does not start with `nyan.`, because built-in kinds carry built-in meaning; the draft carries only `kind`, `model`, `data`, and `edits`, and no `head`, so a boundary hook cannot start a new context range; `model` holds only `user` messages, so a draft cannot break tool-call pairing; every `edits` target is an entry of the active context, with the action `omit` or `replace`, and a `replace` carries a list of user messages with finite timestamps, because the context derivation reads that list on every derivation and a missing one would make the conversation unreadable; and the draft survives `copyJson(draft, { omitUndefinedProperties: true })`, whose copy is what the commit receives. A rejected draft list is dropped as a whole and reported, and `continue` is dropped with it, matching Nyan's invalid-boundary rule.

`continue` is honored only at a final answer, only when no queued input and no reset was selected, and only when the validated drafts contain at least one `model` message. A queued input overrides `continue` silently and the drafted user message stays in the context before it; a queued reset overrides it too, and because the reset follows the drafts they leave the active context. The answer is appended before the drafts, so without a model draft the last model message is the assistant answer and a request would end with an assistant message. With one, the last model message is a user message. Otherwise `continue` is reported and ignored. A tool round continues anyway, so `continue` there is ignored without a report.

**Compaction result.** The checks fail the compaction with a named reason and leave the live context unchanged: `invalid_first_kept`, `invalid_details`, or `invalid_usage`. `firstKept` must be an entry of the active context after the head marker that the cut-candidate rule accepts (an assistant or user contribution, never a tool result, never a user entry that a result of the preceding assistant's calls still follows). That rule is `isCandidate` in `harness/compaction.ts`, which is not exported today; it is exported for this check. `place()` currently receives the `firstKept` that `select` computed, so a hook's value needs a new parameter. The summary is assumed to cover every entry before `firstKept`; durable cannot check that. `details` is strict JSON stored as `data.details` of the compaction entry. `usage` must name its model as `{ provider, modelId }` and carry finite counters. It is recorded in the summary-placing commit of the hook path only, so the summarize path does not count it twice.

### Accepted reductions

ROADMAP decision #23: the owner accepted all four of these reductions on 2026-10-16.
- `rewriteMessage` covers the assistant role. A `toolResult` rewrite maps to `afterTool`, which runs before its commit. A `user` message enters through the Session line, where no task or hook runs; Nyan's `input` event (product API) covers that need. The `custom` role does not exist in durable. Every repository consumer rewrites assistant messages: the tests, the cost override, and the cliproxyapi transient-error normalizer.
- Boundary hooks do not fire for an error or aborted turn. Those end the run through the failure path, which has no boundary commit, and the TUI and `--mode json` already report them through `task_failed` and `agent_end`.
- `messageEntryId` is absent for a final-answer turn because the answer is committed together with the boundary.
- A `compaction` boundary draft, and any draft that writes a head marker, is not supported. Compaction is a durable task whose cut, receipt, and recovery N4 governs; a hook that wrote a compaction entry would bypass that. `context_edit` drafts are supported through `edits`.

## Alternatives considered

- **One provider-request hook with several call sites.** Rejected: payload and headers are replacement chains, response and frames are observers. A merged hook would need a discriminated union and would hide the composition rule in each branch.
- **Deliver streamed events only from the committed event stream.** Rejected by decision #18, and not possible for provider frames, which are never committed.
- **Await observers inline in the assistant stream loop.** Rejected: it would not slow the provider (the stream queues without a waiter) but it would stall the throttled partial commit, and on abort the loop's `finally` could not run until the observer returned.
- **A new `Conversation.watchStream()` subscription.** Rejected for N2: hooks give extensions what they need, the host keeps the committed stream, and a subscription API can be added for the TUI rewrite (N9) without changing these hooks.
- **Let `onBoundary` append through a transaction.** Rejected: hooks run off the line and may rerun, and the Harness's tasks, not hooks, write to a busy conversation. Returned drafts keep entries atomic with the turn outcome.
- **Validate drafts inside the commit.** Rejected: a table read after the first write throws `ReadAfterWrite`, so the context read would have to precede the answer's append, and a rejected draft would then need to abort a half-built commit.
- **Commit the answer first and run the boundary hook in a second phase.** Rejected for now: it would give `messageEntryId` but split one outcome into two commits and needs a new checkpoint phase and a recovery case. Reconsider if a consumer needs the id.
- **Give durable Nyan's composition rules** (last result wins for compaction, in-place mutation for headers). Rejected: the adapter owns the Nyan runner and composes before calling durable.
- **A generic message rewrite at the append seam.** Rejected: appends happen inside commits, where an asynchronous hook cannot run.
- **Silently fall back to the selected cut when `firstKept` is invalid.** Rejected: it would change what the extension asked for without saying so.
- **Allow any `EntryDraft` from a boundary hook.** Rejected: `head` and built-in kinds change what the model sees or masquerade as harness entries, and `appendEntry` would not notice.

## Consequences

Durable gains nine hook members, one `HookRunner` method, one contract type, one exported predicate, and a widened compaction result and compaction entry. A conversation without these hooks runs the same code path as before. The adapter in coding-agent (task C) and the JSON/RPC adapter (task B) can be written against these types before the implementation lands. The public surface of `@ny4n/durable` and `@ny4n/ai/contracts` grows; nothing existing is removed or retyped incompatibly. The `check:entry-graphs` budget of `packages/durable` may need to rise if new files are added; that must be justified in the change that raises it.

## Verification

Implemented in `packages/durable` and `packages/ai`, not yet reviewed by the owner or wired to the coding-agent adapter. An independent review (claude-haiku-5-5) found five blocking problems, all confirmed against the source and fixed:
- A `replace` edit in a boundary draft was not checked, so one without `messages` would make every later context derivation throw (`undefined.filter`). It now needs a list of user messages with finite timestamps.
- `awaitWithContext` in `@ny4n/chord` returned early on an already-aborted context without observing the work, so a hook that failed afterwards produced an unhandled rejection, which ends a Node process that has no handler. Fixed there (the cause), with a test for the early and the late abort.
- `usageProblem` did not check `cacheWrite1h` and `reasoning`, nor strict JSON, so a bad compaction usage faulted the task instead of failing with `invalid_usage`, and a string counter would have been concatenated. It checks both now. `rewriteMessage` also checks `timestamp` and tool call `id` and `name`.
- Two tests claimed more than they proved. "Does not slow the read loop" asserted only that the run was open; it now holds the stream open with the observer parked and waits for the partial to appear in `nyan.live`. "Registers nothing when no observer exists" cannot observe the `has()` gate, which only saves work; it is renamed for what it checks, and the gate for streaming deliveries is not covered by a test.
- Spec and code disagreed on a `continue` that a queued input overrides: the spec said it is reported, the code ignores it, correctly, since the run goes on with that input. The spec now says so.

`Delivery` also changed: its pump now starts one microtask after `push`, so a delivery that throws or pushes before its first await can no longer leave a finished promise in `#running` or start a second pump, and an `onError` no longer ends delivery of what is queued behind it. `test/delivery.test.ts` (7 tests) covers order and a single pump, a synchronous throw, a push from inside a delivery, errors without losing the queue, merging, abort, and the late failure after abort.

New tests, each checked by disabling the code under test and confirming a test fails:
- `test/harness-provider-hooks.test.ts` (9 tests): no callback set without a hook; payload chain, `undefined` keeps the body, throw reported; header merge and `null` removal; response status and model; frames in order with a throw reported; rebuild per request; abort releases a hook that never returns. Four callback mutations.
- `test/harness-stream-hooks.test.ts` (10 tests): order and completeness before `afterResponse`; sequential per event; throw reported; the read loop is not blocked by a parked observer; abort releases a hanging observer; restart marked by `start`; tool update delivery before `afterTool`, coalescing with one in flight and nothing lost, the `maxBytes` cap with conservation of bytes (delivered plus dropped equals pushed), throw reported, a streaming tool without observers. Eight mutations, the gate for tool-update deliveries excepted.
- `test/harness-request-hooks.test.ts` (19 tests): identity keeps positional system entries, a replacement collapses them into one head, order against `beforeRequest`, chaining, throw, per-request reruns; rewrite commits the replacement, shows it to `afterResponse`, records its usage, chains, starts a tool round from its calls, makes an error retryable, skips a deferred result, and rejects eight kinds of invalid replacement. Twelve mutations.
- `test/harness-compaction.test.ts`, block `beforeCompact result` (12 tests): `firstKept`, `details`, and `usage` placed and counted once; summary-only unchanged; `invalid_first_kept` three ways including a cut between a tool call and its result; `invalid_details`; `invalid_usage` six ways; each failure leaves entries, status, and ledger unchanged. Eleven mutations.
- `test/harness-boundary-hooks.test.ts` (23 tests): entries after the answer and attributed to the generation task; accumulating chain; continue with a drafted user message; settle only when nothing else continues; a queued input beats continue; continue without a user message reported; throw reported; no boundary for an error turn; eight kinds of rejected draft and four of rejected edit, each dropping the whole list and its continue and leaving the conversation readable; an accepted omit and an accepted replacement; tool round entries after the results, `terminate` raising `settle`. Nineteen mutations.

A second review of those fixes returned "mergeable with corrections"; the corrections are in the code, tests, and spec:
- A tool result's `usage` was recorded inside the result commit without a check, so `usage.input = NaN` made the commit throw, the `nyan.tool-result` entry was never written, and the model saw "Tool result unavailable". `finalResult` now checks it after `afterTool`. A result whose usage fails the check keeps its output and loses the usage; it gets a `warn` diagnostic with the code `invalid_usage` that names the call id and the problem, and the host receives a report. The ledger then counts less than the tool spent, which the diagnostic says and spec 8.6 records.
- `usageProblem` rejects negative counters (the optional ones and `cost` included) and fields the ledger does not count. `recordUsage` no longer adds a sum that is not finite (two `1e308` costs); it returns the problem and leaves the ledger as it was. A tool result and a nested result drop the usage with the same diagnostic, a compaction hook's usage is dropped with a report while the summary is placed, and a provider response's usage still throws inside its commit.
- A provider response whose usage cannot be recorded is not lost silently. The commit throws, the generation task faults, no answer entry is written, and the submission settles `unanswered` with reason `faulted` and the cause in `detail` (`test/harness-tool-usage.test.ts`, two tests: a NaN counter and a ledger overflow that names `faux/faux-1`). The host's report callback does not receive that fault; the settled submission and the faulted task record carry it, as they do for any other commit failure.
- A boundary `replace` edit needs user messages with `content`, and an `omit` that carries `messages` is rejected instead of ignored.
- `awaitWithContext` wraps the work in `Promise.resolve` before marking it handled, so a thenable that is not a Promise is accepted as before. The `#closing` promise in `Session.close()` is shared, so that catch marks a failed close handled for every observer; a comment says so.
- The chord test is split: the already-cancelled case guards the fix, and the cancelled-while-waiting case, which passed without it, is labelled as not a guard.
- The "streams output and details with no observer" test now calls `api.details` and checks the result's details. `Delivery` swallows a throw from its own `onError`, because the pump would otherwise end as an unhandled rejection.

The whole `packages/durable` suite passes except `test/tools-images.test.ts` "prepares in a worker thread, leaving the event loop free", a wall-clock assertion (`< 100 ms`) that measured 100 to 115 ms while the machine's load average was above 11; it passed in isolation at a load near 5 before the later slices, and `src/images` and `src/tools` are unchanged. `npm run check` passes.

Not verified:
- That the ledger rejects `Infinity` the same way on a real SQLite storage: the overflow tests use `MemoryStorage`. The code no longer writes a non-finite value, so the question only matters if a path bypasses `recordUsage`.
- A crash between the boundary hook and its commit (the hook rerun and the entries appended exactly once) is argued from the commit structure, not tested.
- A header set to `null` is dropped by the Anthropic and OpenAI SDKs according to their `buildHeaders` sources, which the reviewer read and nobody ran against a provider; whether Bedrock's `onResponse` runs once under SDK retries is not checked.
- That the coding-agent adapter can express Nyan's `context`, `message_end`, `turn_end`, and `agent_before_settle` handlers over these hooks; that is task C.
