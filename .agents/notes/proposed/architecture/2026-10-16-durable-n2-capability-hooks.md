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
- A crash between the boundary hook and its commit (the hook rerun and the entries appended exactly once) is argued from the commit structure in `packages/durable`, which has no test for it. The coding-agent test `durable-extension-events.test.ts` ("a boundary handler interrupted before its commit runs again and its entries are written once", C3g) covers the nearest thing it can drive: the Harness is closed while a `turn_end` handler is parked, the session is reopened with `continueSession`, and the handler runs again and its entry is written once. A close is not a process kill, so a kill between the hook and the commit is still not run.
- A header set to `null` is dropped by the Anthropic and OpenAI SDKs according to their `buildHeaders` sources, which the reviewer read and nobody ran against a provider; whether Bedrock's `onResponse` runs once under SDK retries is not checked.
- That the coding-agent adapter can express Nyan's `context`, `message_end`, `turn_end`, and `agent_before_settle` handlers over these hooks; that is task C.

## Tool bridge mapping (task C, batch 2a)

The bridge (`core/durable/extension-tools.ts`, `extension-adapter.ts`, `extension-host.ts`) maps each Nyan tool that the runner
holds to a durable registration, installed in one extension `nyan.extension-tools` that the host replaces by name on every
sync: after `session_start` and on each `refreshTools` (`pi.registerTool` after load calls it). `hidden` tools are not
installed. Mapping tests: `test/durable-extension-tools-mapping.test.ts`; behaviour: `test/durable-extension-tools.test.ts`;
MCP acceptance: `test/durable-mcp.test.ts`.

### Field by field

| Nyan (`ToolDefinition`) | Durable | Note |
| --- | --- | --- |
| `name` | `name` | |
| `description` | `description` | |
| `parameters` | `parameters` | legacy requires an object schema; kept |
| `label` | dropped (R1) | the durable TUI shows no tool labels |
| `promptSnippet`, `promptGuidelines` | extension `section` `extension_tools` | rendered for the tools the request offers, as legacy's system prompt does for custom tools |
| `prepareArguments` | `prepareArguments` | same contract |
| `executionMode` | `executionMode` | same values |
| `outputSchema` | `structuredOutputSchema` | a result without `structuredContent` becomes an error result (legacy: text only). A deliberate change; the legacy docs already require the pair |
| `exposure: "direct"` | default callers, not deferred | offered to the model; callable from tools |
| `exposure: "model-only"` | `callers: ["model"]` | offered; scripts cannot call it |
| `exposure: "codemode"` | `callers: ["tools"]` | never offered to the model; reached by codemode (2b) |
| `exposure: "deferred"` | `deferred: true` | offered only after tool search loads it (2b) |
| `exposure: "hidden"` | not installed | legacy registers it but nothing reaches it |
| `defaultActive` (or the default for the exposure) and `setActiveTools()` | the active set; a tool that is not active is `deferred: true` | legacy's active set decides what is declared to the model. The host keeps the set: a tool enters it on first registration when `isActiveByDefault`, and `setActiveTools(names)` replaces it, then re-installs the tools |
| `getAllTools()` | the runner's registered tools as `ToolInfo` (name, description, parameters, promptGuidelines, reachesTools, exposure, namespace, annotations, sourceInfo) | MCP's `tool_call` handler reads it to find the owner of a call; without it every MCP call on this path is blocked (found by the MCP test) |
| `getActiveTools()` | the active set | MCP reads it when it activates codemode or tool search (2b) |
| `namespace` | dropped (R5) | codemode and tool-search namespaces: batch 2b |
| `annotations` | dropped (R6) | MCP hints for permission checks; no durable permission path yet |
| `constrainedSampling` | dropped (R2) | no per-tool provider sampling in durable |
| `prepareLoadout` | dropped (R7) | loadout of codemode and tool-search: batch 2b |
| `reachesTools` | dropped (R8) | the `tool_call` wait for MCP servers a codemode call may reach: batch 2b |
| `renderShell`, `renderCall`, `renderResult` | host side (R3) | rendering stays with the host; the durable TUI shows calls as text |
| `replay` (durable only) | default `unsafe` | legacy has no replay notion; an interrupted call is not rerun |
| `execute(toolCallId, params, signal, onUpdate, ctx)` | `execute(args, api, context)` | `toolCallId` = `api.callId`; `params` = `args`; `signal` = `context.abortSignal`; `onUpdate` text = `api.output` (partial details are not streamed, R9); `ctx` = the runner's context with `tools: []` and `executeTool` unavailable (R10, 2b) |
| result `content` | `output` | |
| result `details` | `details` | JSON only; a non-JSON value is dropped (R11) |
| result `structuredContent` | `structuredOutput` | JSON only |
| result `isError` | `isError` | |
| result `usage` | `usage` | |
| result `terminate` | `control.terminate` | |
| `tool_call` event | `beforeTool` | `block` and `reason` map to `block`; a changed `input` (mutated in place) replaces the arguments when JSON; `terminate` on a block is dropped (R12) |
| `tool_result` event | `afterTool` | `content`, `details` (JSON), `isError`, `structuredContent` replace the result; a result the handler does not change is kept |

Both event members exist only when a loaded extension handles the event (`HookRunner.has()`, S5).

### Decision 4 reduction list (what the durable path does not carry yet)

| # | Item | Why | Owner batch |
| --- | --- | --- | --- |
| R1 | `label` | durable TUI shows no tool labels | none (decide with the TUI rewrite, N9) |
| R2 | `constrainedSampling` | no durable equivalent | none |
| R3 | renderers (`renderShell`, `renderCall`, `renderResult`) | rendering is host-side; the durable TUI prints tool calls as text | N9 |
| R5 | `namespace` | needed by codemode and tool-search | 2b |
| R6 | `annotations` | no durable permission path | later |
| R7 | `prepareLoadout` | codemode and tool-search loadouts | 2b |
| R8 | `reachesTools` | codemode and tool-search waits | 2b |
| R9 | streamed `details` (partial) | final details only | later |
| R10 | `ctx.tools`, `ctx.executeTool` | codemode | 2b |
| R11 | non-JSON `details` or `structuredContent` | durable transcript holds JSON | none (the tool's own fault) |
| R12 | `terminate` on a blocked call | durable has no batch-stop on block | later |
| R13 | `before_agent_start` message and system-prompt changes | only the wait is applied in 2a (see below) | batch 3 |
| R14 | `before_agent_start` prompt sections (MCP's `mcp_servers` section) | not rendered | batch 3 |
| R15 | MCP's codemode and tool-search auto-activation | MCP looks for the nyan tools named `codemode` and `tool_search` with `reachesTools`; the durable versions are Harness tools, not runner tools, so they are not seen | 2b |

### `before_agent_start`: the wait only (2a)

MCP waits for its direct servers in `before_agent_start`, so a first prompt lists their tools (legacy behaviour, measured
in the MCP test: without the wait the first request has no MCP tool). The durable controller therefore runs the handlers
before it submits a prompt (`submit`, `submitAndWait`). The handlers' changes are not applied (R13, R14). The event fires
for every submitted prompt, including ones that queue behind a running turn; A9 (once per prompt, not per tool round) is
batch 3's to finish.

### Spec 7.5 check (2a, before the bridge)

`packages/durable/test/registry-late-install.test.ts`: an extension installed after `Harness.open` is in the next request's
declared tools (`getCurrentTools` of the messages); a second install under the same name replaces the first; an install
during a run is in that run's next request. All pass, so the bridge relies on the runtime behaviour, not on the spec alone.

### Batch 2a notes

- `disabledBuiltinExtensions` now always lists `codemode` and `tool-search`: their legacy tools call `ctx.executeTool`, which the
  durable path does not provide. Batch 2b installs the durable versions in their place.
- MCP's default exposure is `codemode`: on this path an MCP tool with the default is reachable only through codemode (2b).
  The MCP test sets `exposure: "direct"` in `mcp.json`.


## Batch 2b: codemode and tool search on the durable path

Both are native tools, not runner tools: `core/durable/native-tools.ts` builds the durable extensions (`codemode`, `tool-search`), and the host installs them. While a native tool is active its extension is installed; while it is not, an empty extension of the same name replaces it, so the registry holds nothing of it. The active set is the same one the bridged tools use (`setActiveTools`, `getActiveTools`), so one model decides visibility for every tool:

- `codemode` and `tool_search` are `model-only` and inactive by default, as the legacy definitions are.
- `getAllTools()` reports both, whether active or not, with the metadata MCP reads (`exposure`, `reachesTools`). MCP's
  auto-activation (unchanged) therefore sees them: its `setActiveTools([..., "codemode"])` installs the durable codemode.
- A codemode-exposed tool is `callers: ["tools"]` while codemode is inactive, and callable by scripts once it is active.

### Sandbox and worker slots

- `createCodemodeSandbox()` is the legacy construction: wasm from `getQuickJSWasmPath()`, worker from `getCodemodeWorkerSpecifier()`
  (both in `src/config.ts`), the memory limit, and `acquireWorker`. The slot counter and the limit are in
  `core/codemode-workers.ts`, shared with the legacy extension, so one process holds at most two workers on either path.
- The limit refuses a third script; it does not queue it. That is the current behaviour, kept (the owner's decision).
- The sandbox is created on the first activation and closed with the session.

### Namespaces

Durable groups tools by name prefix. A tool's `namespace.name` is its prefix, so an MCP tool (`mcp__<server>__…`) is
grouped under its server. Aliases are not used on this path. The namespaces are recomputed on every sync, so a server
that connects later is listed.

### Lifecycle boundary: `before_agent_start` (decision 4)

- **Before a submitted prompt** (`submit`, `submitAndWait`): `before_agent_start` runs, and only its wait is applied. MCP's
  wait for its direct servers belongs to the preparation of the first model request, so it runs before the prompt is
  submitted. This is the only effect of the hook on this path.
- **Not applied yet** (batch 3): the handlers' message and system-prompt changes (R13), and the prompt sections they add
  (R14). The event fires for every submitted prompt, including ones that queue behind a running turn; A9 (once per
  prompt, not per tool round) is batch 3's.
- Nothing else in the request path waits on a handler before the first request.

### Reduction list: status after 2b

| # | Status |
| --- | --- |
| R5 `namespace` | done for codemode (name prefix; aliases not used) |
| R7 `prepareLoadout` | not used by any extension that reaches this path yet; batch 3 |
| R8 `reachesTools` | done for the native tools: `"all"` (see R19) |
| R10 `ctx.tools`, `ctx.executeTool` | codemode scripts call the tools through the durable nested calls; `ctx.executeTool` for an extension tool stays unavailable |
| R13, R14 | batch 3 (above) |
| R15 MCP codemode and tool-search activation | done: MCP's logic is unchanged and sees both tools through `getAllTools` |
| R16 `models` namespace, classifiers, and image generation in scripts | not connected: the durable codemode takes no model globals yet |
| R17 `codemode.mode: "only"` | not connected: direct tools are always declared |
| R18 tool search loads deferred tools only | legacy also loads `codemode`-exposed tools; durable does not, so they are reached through codemode only |
| R19 `reachesTools` of codemode is `"all"` | legacy narrows it to the servers a script names; `"all"` makes MCP wait for every server before a codemode call (slower, not wrong) |
| R20 `inlineBudget` | read from the settings at each sync; the legacy setting mode is not used |

## Batch 3, first slice: host events, context, and the two state answers

- **`agent_settled`** is emitted after every run that ends, whatever its outcome (`aborted` when the run was aborted). It
  fires from the durable controller's settle path (`submit`, `submitAndWait`), which is where a run's terminal settlement is
  known. Legacy's rule is unchanged: every settled run, including `unanswered` (the quota poll depends on it).
- **`context`** maps to `transformConversation`. The handler sees the request without system messages, as legacy shows it.
  The member returns a list only when one differs from the request: returning an unchanged list would still replace it,
  which collapses the system entries into one leading message and changes the prompt-cache prefix.
- **`ctx.isIdle()`** answers from a run counter in `runtime.ts` (false while a run is in flight). **`ctx.isProjectTrusted()`**
  answers from the services' trust decision; when trust had to be resolved by the reload, the services now report the
  decision that reload reached instead of the initial `false`.
- Still open in batch 3: the slash commands and UI subset (decision 4), the `before_agent_start` message and system-prompt
  changes (R13/R14), prompt templates, `agent_end`, `model_select`, and the real `ctx.sessionManager`. `agent_end` would
  need the run's messages; it is not emitted yet (R21).

## Durable RPC bash design (N2 task B, B3)

The durable RPC `bash` command owns an in-memory abort controller for each execution and invokes the session's `ExecutionEnv.exec`; `abort_bash` aborts those controllers without aborting the Harness conversation or its generation task. Output is forwarded as `bash_execution_update` records while the command runs. Once the command settles, the result is appended as an application entry with kind `bashExecution`. The entry carries the command and result data; it contributes the legacy `bashExecutionToText` user message to model context unless `excludeFromContext` is true. The command is executed before the entry commit, so a crash between those effects can leave an unknown external command outcome and must not be replayed automatically; a later session inspection is the recovery path.

The shared legacy bash executor remains the output/cancellation boundary for RPC formatting and full-output files. Its full-output close has a deadline, failed command paths remove temporary files, and a spill failure is reported only when the returned result is actually truncated.

## Batch C3h: the run's abort signal in every handler

Legacy reports `ctx.signal` as `agent.signal` (`agent-session.ts`), which is set for the whole run, so a `turn_end`,
`context`, or tool handler can cooperate with an abort. The durable adapter set a provider-call scope only around the
provider and tool *executions*, so every hook member that ran an extension handler outside that scope read
`undefined`: the boundary, context, `message_end`, `message_update`, `tool_call`, `tool_result`, `tool_execution_update`,
and `session_before_compact` handlers could not respond to an abort even if the extension wanted to.

Each durable hook member that calls an extension handler now runs it in `inProviderCall(scope, undefined,
context.abortSignal, ...)`: the handler reads the task context's `abortSignal` as `ctx.signal`, and `ctx.model` stays
unset so it falls back to the agent's model. The scope is unchanged for the provider callbacks and the tool execution,
and `beforeRequest` runs no handler (it applies the staged `before_agent_start` effects).

Who aborts that signal, and what it buys: `Harness.close()` (`scheduler.join`) and `Conversation.abort()` both abort the
run invocation's controller, and every hook context is that invocation's context (`withAbortSignal(invocation.signal,
context)`). A handler that waits for `ctx.signal` is therefore released by `close()`, by RPC `abort`, and by
`new_session` (which closes the session first). A handler that ignores the signal still holds the close up: durable
waits for every call, including code that never returns, and that is what makes a reopen safe (spec §close). The
orchestrator's ruling was to keep that guarantee and fix the adapter instead, which is what this batch does.

Not covered, deliberately: `agent_end` and `agent_settled` are emitted from the controller's settle path, after the
durable run has settled, so those handlers have no signal (legacy's `agent_end` still runs inside the run and has one);
`before_agent_start` has no signal in either path, because the run does not exist yet when it runs.

`custom_message` in the durable TUI: `customMessageView` decides, from the entry's `data`, whether a boundary
`custom_message` is shown. `display: false` shows nothing, as legacy does, and a visible one shows as plain text with its
custom type. The durable TUI has no `ExtensionRunner`, so an extension's message renderer is not used (recorded
reduction; the durable TUI renders no other custom entry either).

## Batch G0b: the extension surface audit

Every `durable-capability` in [extension-surface.json](extension-surface.json) and every event mapping is labelled below
as satisfied (with the pull request or test that proves it on the durable path) or as a recorded reduction (with the
owner decision). PR numbers are the task C batches: batch 1 #47, 2a #50, 2b #54, 3-slice-1 #56, C3b #63, C3c #66,
C3d #68, C3e #72, C3f #73, C3g #76, C3h #80, G0b this batch.

### The eight capabilities

| Capability | Status | Evidence |
| --- | --- | --- |
| `phased-request-transform` | Satisfied for phase one; phase two not bridged | `context` runs as `transformConversation` (#56; `durable-extension-events.test.ts` "a context handler rewrites the request"). `context_with_system` is the phase that owns the full transcript; `transformConversation` never sees system messages, so the adapter cannot express it. Owner Decision #31 |
| `provider-payload-hook` | Satisfied | `beforeProviderRequest` (#66); `durable-extension-host.test.ts` "a before_provider_request change reaches the provider" |
| `provider-header-hook` | Satisfied | `beforeProviderHeaders` (#66, #80); `durable-handler-signal.test.ts` direct member test |
| `provider-response-observe` | Satisfied | `afterProviderResponse` (#66); `durable-extension-host.test.ts` "… and the after_provider_response status is seen" |
| `streaming-channel` | Satisfied | `onStreamEvent`, `onToolUpdate`, `onProviderStreamEvent` (#66, #80); `durable-handler-signal.test.ts` real-run test, `durable-extension-host.test.ts` frame test. All events are retained, Decisions #18 and #21 |
| `message-rewrite` | Satisfied for the assistant role | `rewriteMessage` (#73). Reduction #23(a): tool results rewrite through `afterTool`, user input is the product `input` event, and durable has no `custom` role |
| `settlement-entry-write` | Satisfied | `onBoundary` (#73, #76); `durable-extension-events.test.ts` boundary tests. Reductions #23(b) (no boundary for a failed or aborted turn), #23(c) (no `messageEntryId` for a final answer), #29 (what a draft may contain) |
| `compaction-result-fidelity` | Satisfied except a foreign cut | `beforeCompact` summary, details, and usage (#73, #76). Reduction #29: a `firstKeptEntryId` other than durable's selected cut is reported and durable's cut stands |

### The event mappings

| Event | Destination | Status | Evidence |
| --- | --- | --- | --- |
| `project_trust` | product-api | Satisfied | resolved by `createDurableServices` (#68); `durable-resources.test.ts` |
| `resources_discover` | product-api | Satisfied | resource loader (#68); `durable-resources.test.ts` |
| `session_start` | product-api | Satisfied | `host.start` (#66); `durable-extension-host.test.ts` |
| `session_info_changed` | internal-view | Satisfied as a view | no extension consumer; the durable TUI renders the view |
| `session_before_switch` | product-api | Satisfied | `host.beforeSwitch` (#66); RPC `switch_session` (#75) |
| `session_before_fork` | product-api | Not bridged (Decision #31) | no built-in or core consumer; examples only; fork follows Decision #24 |
| `session_before_compact` | hook:beforeCompact | Satisfied | #73, #76; reduction #29 for a foreign cut |
| `session_compact` | internal-view | Satisfied as a view | the durable compaction task state and TUI notices (#72) |
| `session_compact_failed` | internal-view | Satisfied as a view | same |
| `session_shutdown` | product-api | Satisfied | `host.shutdown` (#66); `durable-extension-host.test.ts` |
| `mcp_servers_change` | product-api | Satisfied | the runner binds the registry listener in `bindCore`, so MCP sees later changes (#63, #50) |
| `context` | durable-capability | Satisfied | #56, #76 |
| `context_with_system` | durable-capability | Not bridged (Decision #31) | the phase needs the full transcript, which no durable hook receives |
| `before_provider_request` | durable-capability | Satisfied | #66; stub test |
| `before_provider_headers` | durable-capability | Satisfied | #66, #80 |
| `after_provider_response` | durable-capability | Satisfied | #66; stub test |
| `provider_stream_event` | durable-capability | Satisfied | #66; stub frame test |
| `before_agent_start` | hook:beforeRequest | Satisfied | #66; injection test; G0b staging fix |
| `agent_start` | product-api | Not bridged (Decision #31) | built-in `herdr` consumes it; durable emits no run-start event to extensions (`run_start` exists in the committed stream, which `--mode json` already uses) |
| `agent_end` | internal-view | Satisfied | `host.settled` (#66); G0b tests |
| `agent_before_settle` | durable-capability | Satisfied | #73, #76 |
| `agent_settled` | product-api | Satisfied | #66; G0b tests |
| `ui_prompt_start` | product-api | Satisfied | `ExtensionRunner.setUIContext` wraps every dialog; the durable TUI and RPC bind it (#63, #72) |
| `ui_prompt_end` | product-api | Satisfied | same |
| `turn_start` | product-api | Not bridged (Decision #31) | built-in `mcp` consumes it to reconnect servers signed in mid-session |
| `turn_end` | durable-capability | Satisfied | #73, #76 |
| `message_start` | internal-view | Satisfied through `--mode json` and the view | `durable-json-events.test.ts` (#56) |
| `message_update` | durable-capability | Satisfied | #80; real-run test |
| `message_end` | durable-capability | Satisfied for the assistant role | #73; reduction #23(a) |
| `tool_execution_start` | internal-view | Satisfied through `--mode json` | `durable-json-events.test.ts` |
| `tool_execution_update` | durable-capability | Satisfied | #80; real-run test |
| `tool_execution_end` | internal-view | Satisfied through `--mode json` | `durable-json-events.test.ts` |
| `model_select` | internal-view | Satisfied | `host.modelSelected` (#66) |
| `thinking_level_select` | product-api | Satisfied | `host.thinkingSelected` (#66) |
| `tool_call` | hook:beforeTool | Satisfied | #50; `durable-extension-tools.test.ts` |
| `tool_result` | hook:afterTool | Satisfied | #50; same file |
| `user_bash` | product-api | Not bridged (Decision #31) | no built-in or core consumer; durable RPC `bash` records an entry instead (#77) |
| `input` | product-api | Not bridged (Decision #31) | no built-in or core consumer; durable has no legacy input pipeline |
| `cache_warming_decision` | product-api | Not bridged (Decision #31) | no built-in consumer; the cache warmer is not on the durable path |

All 31 non-event `ExtensionAPI` members are classified `product-api`. The durable host connects a subset and throws
`<api> is not connected on the durable path yet` for the rest, so a handler that calls one fails visibly; the list is in
`docs/extensions.md`. Only `codemode` calls one of them (`appendEntry`), and the durable path replaces that built-in with
the durable codemode (#54).

### The settled-handler difference

`agent_end` and `agent_settled` are emitted by the controller's settle path after the durable run has settled, so their
handlers see no `ctx.signal`; legacy's `agent_end` runs inside the run and has one. The orchestrator asked whether a
parked `agent_end` handler can hold `close()`, `new_session`, or the next prompt.

What the code does: `settle()` awaits `host.settled()`, so the host does await these handlers. That await belongs to the
submission's settle promise, not to the durable Session line: `Harness.close()` joins the scheduler, which knows nothing
of it, and `close()`, RPC `new_session`, and the next `submit`/`submitAndWait` never join that promise. Measured
(`durable-settled-handlers.test.ts`, with an `agent_end` handler parked on a promise that never resolves): `close()`
returns, RPC `new_session` answers `success: true`, and the next prompt finishes, each while the handler is still parked.
Only the prompt response that was already waiting for that run waits for the handler, which is legacy's behavior too.

The one piece of state that wait owns is the staged `before_agent_start` effects. They used to be cleared after the two
emits, so a prompt submitted while an `agent_end` handler was parked queued its effects behind the settled run's applied
ones, and that prompt's injected message never reached its request. G0b clears the staging before the emits; the test
above asserts that the second prompt's injected message is in its own request body while the first run's handler is still
parked. The difference itself stays documented rather than fixed: a signal for these handlers would have to be aborted by
`close()` and `new_session`, and those do not join the handlers in the first place.
