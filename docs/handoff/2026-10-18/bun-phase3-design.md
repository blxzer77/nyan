# Bun Phase 3 design (research only, nothing implemented)

Written 2026-10-17 on `origin/main` at `ed2fbf812` (Phase 2 merged). No code was changed for this document; the only repository change in this session besides Phase 2 is PR #33 (`publish-packages.mjs`). Probes ran on Windows x64, Node 24.3.0, Bun 1.4.3 (CI runs Bun 1.4.2), with local servers only; the probe scripts are in `D:\nyan-tmp\bun\` (`fetch-parity.mjs`, `fetch-parity-undici.mjs`, `tls-probe.mjs`, `sqlite-probe.mjs`, `sqlite-probe2.mjs`, `redirect-loop.mjs`, `zlib-probe.mjs`, `retry-probe.ts`).

Evidence labels: **measured** (I ran it), **read** (from source, not run), **unverified**.

## 0. Where Decision #12 leaves us

Decision #12 (resolved 2026-10-17): on Bun the HTTP client is Bun's native fetch, placed behind the runtime adapter. PR #13 already did the core of it in `packages/coding-agent/src/core/http-dispatcher.ts`: on Bun `configureHttpDispatcher()` wraps the original global `fetch` with `createIdleTimeoutFetch()` (`core/idle-timeout-fetch.ts`) and does not touch undici; proxy variables are read by Bun itself. What the decision still asks for is mostly (a) giving that choice one named home instead of a `runningUnderBun()` branch inside a Node-shaped file, and (b) closing the behavior gaps that the switch left open. The probes found real gaps (section b): one of them changes retry behavior today.

## a. HTTP inventory (who sends requests, with what, under Bun today)

"Global fetch" below means `globalThis.fetch` after `configureHttpDispatcher()`: on Node the npm undici 8.10.2 `fetch` (via `undici.install()`) plus an `EnvHttpProxyAgent`; on Bun the original native fetch wrapped by the idle-timeout wrapper. `configureHttpDispatcher()` is called from `main.ts` (twice), `cli/setup.ts`, `rpc-entry.ts`, `modes/interactive/interactive-mode.ts` (also when the user changes the idle timeout), `core/durable/harness-setup.ts` (N2) and `experimental/vacation`. All read.

| Caller | Mechanism | On Node | On Bun now | What "behind the adapter" changes |
|---|---|---|---|---|
| Anthropic, OpenAI (completions, responses, azure), Google GenAI, Mistral, OpenRouter images, classifiers (`packages/ai/src/api/*`) | Provider SDKs and raw `fetch`; `options.fetch ?? globalThis.fetch`; coding-agent passes no `fetch`, so the global is used (read) | undici | native + idle wrapper (SDK clients are built per request, except the cached Anthropic `federationClient`) | Nothing in the call sites. The wrapper must stay the global fetch. See b.9 for a stale-timeout edge. |
| Codex SSE (`openai-codex-responses.ts:401`) | raw `fetch`, zstd request body | undici | native | None for fetch. Compression: section c. |
| Codex WebSocket (`openai-codex-responses.ts:997`) | `globalThis.WebSocket`; under Bun a subclass adds `proxy:` from `resolveHttpProxyUrlForTarget` (`utils/node-http-proxy.ts`), because Bun's WebSocket ignores proxy variables (oven-sh/bun#15489) | Node's WebSocket (undici-based, no proxy support here) | native + manual proxy | Keep. Move `resolveHttpProxyUrlForTarget` usage behind the adapter only if the adapter gains a `webSocket` member; otherwise it is a Phase 3 leave-alone. |
| Bedrock (`bedrock-converse-stream.ts:193`) | AWS SDK `NodeHttp2Handler`; with a proxy `NodeHttpHandler` + `HttpProxyAgent`/`HttpsProxyAgent` | node:http2 / node:http | same code on Bun's node:http2 and node:http compat | **Not fetch, outside Decision #12.** Unverified on Bun at all (no test goes through a real handler). |
| OAuth flows (`ai/src/auth/oauth/*`, `mcp/src/oauth/*`, `coding-agent/extensions/mcp/oauth.ts`) | `fetch` for token calls; `node:http` `createServer` for the loopback callback | undici | native | None. Callback servers use node:http, which Bun implements. |
| MCP transports (`mcp/src/transports/streamable-http.ts`, `oauth/*`) | `options.fetch ?? globalThis.fetch`; `isRetryable()` treats any `TypeError` and codes starting `E` or `UND_ERR` as retryable | undici | native (TypeError holds on Bun, measured) | None. |
| `@ny4n/agent` proxy stream (`agent/src/proxy.ts:147`) | `fetch` | undici | native | None. |
| Version check (`utils/version-check.ts`), tools download (`utils/tools-manager.ts`), binary self-update (`utils/binary-update.ts`), remote model catalog (`core/remote-catalog-provider.ts`, off unless `NYAN_CATALOG_BASE_URL`) | `fetchWithRetry` (`utils/management-http.ts`), global fetch with its own `AbortSignal.timeout` | undici | native | None. `formatVersionCheckError` reads `error.cause.code`; Bun puts the code on the error itself (b.8). |
| CLIProxyAPI, llama.cpp, Hugging Face extensions (`extensions/*`) | global `fetch` | undici | native | None. llama's `isTransient` matches the text "fetch failed", which Bun never produces (b.8). |
| `package-manager-cli.ts:82` | global `fetch` | undici | native | None. |
| `undici` itself | `core/http-dispatcher.ts` is the only importer in `packages/*/src` outside `experimental`; `coding-agent` is the only package that depends on it (`undici@8.10.2`) | used | imported at module load and never used | Optional: load it only on Node. Needs a synchronous load or an async `configureHttpDispatcher`; decide after measuring startup and size (Phase 4 owns benchmarks). Not required by the decision. |
| `https-proxy-agent`, `http-proxy-agent` | `ai`: Bedrock only | used | used | none |

What PR #13 left that Decision #12 wants cleaned: the Bun branch lives inside a file that imports undici at the top and whose doc comments describe both runtimes. Proposed shape (design only):

```
core/http/
  index.ts            configureHttpDispatcher(), applyHttpProxySettings(), parseHttpIdleTimeoutMs()  (same public API, same import path re-exported from core/http-dispatcher.ts)
  native.ts           Bun backend: wrapper over the original fetch (today's configureNativeFetch)
  undici.ts           Node backend: today's EnvHttpProxyAgent + install()
  idle-timeout.ts     createIdleTimeoutFetch (moved from core/idle-timeout-fetch.ts)
```
Selection stays `runningUnderBun()` from `runtime.ts`, evaluated at call time (tests rely on that). The public API and the import path `core/http-dispatcher.ts` stay, so `main.ts`, `cli/setup.ts`, `rpc-entry.ts`, `interactive-mode.ts` and N2's `core/durable/harness-setup.ts` need no edit. This is a move plus the b-items below, not a policy change.

## b. Parity list: native fetch (Bun) against undici (Node as nyan ships it)

The Node column is the npm undici 8.10.2 that `configureHttpDispatcher()` installs, probed with `fetch-parity-undici.mjs`; Node's bundled undici differs in places and is noted.

| # | Topic | Node + undici | Bun native fetch | Plan |
|---|---|---|---|---|
| 1 | Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) | `EnvHttpProxyAgent` reads them at configure time, CONNECT tunnel for HTTP origins (`proxyTunnel: true`); `applyHttpProxySettings` writes env before configure | Bun reads them on every request, including values set after startup; plain-HTTP origins go as `GET http://origin/...` through the proxy, HTTPS via CONNECT (PR #13: measured on Bun 1.4.3 and covered by `http-dispatcher.test.ts` Bun-only cases) | Known, accepted difference; documented in `2026-10-13-bun-native-fetch.md`. Add: `NO_PROXY` wildcard and port forms against a local proxy (PR #13 did not list them). Owner's environment sets `HTTP_PROXY` and `NODE_USE_ENV_PROXY=1`. Unverified: that the owner's proxy accepts forward-proxy form for plain-HTTP origins. |
| 2 | Custom CA | `NODE_EXTRA_CA_CERTS` honored (measured: self-signed origin fails with `DEPTH_ZERO_SELF_SIGNED_CERT`, succeeds with the variable) | `NODE_EXTRA_CA_CERTS` honored (measured, same result); `fetch(url, { tls: { ca } })` and `rejectUnauthorized:false` also work (Bun-only options) | Nothing to build for the variable. Test: a CA-trust case on both runtimes in `http-dispatcher.test.ts`. |
| 2b | System trust store | Owner's `NODE_OPTIONS=--use-system-ca` makes Node trust the OS store (not exercised here) | **Unverified.** `NODE_OPTIONS` is not read by Bun in my probe (flag accepted, no effect on a self-signed server, which proves nothing about the system store). Compiled binaries: unknown. | Needs a certificate in the Windows user store to test, i.e. a change to the owner's machine: ask before doing it. If Bun ignores the OS store, document `NODE_EXTRA_CA_CERTS` as the supported way and have the adapter warn once when `NODE_OPTIONS` contains `--use-system-ca` under Bun. |
| 3 | `httpIdleTimeoutMs`, idle timeout | undici `headersTimeout` + `bodyTimeout` | Wrapper (`idle-timeout-fetch.ts`): headers timer, per-chunk body timer, undici error codes (PR #13: 9 tests, real servers, both runtimes) | Keep. Gap: the timeout is a closure constant of each wrapper; `interactive-mode.ts:4957` reconfigures while running and installs a new wrapper. A client that captured the old global (the cached Anthropic `federationClient` constructs with the global at creation) keeps the old timeout. Read, not measured. Plan: the wrapper reads the timeout from a shared holder that `configure` updates; test with a client constructed before reconfiguration. |
| 3b | Connection-attempt timeout, HTTP/2 switch | `autoSelectFamilyAttemptTimeout` 2 s, `allowH2: false` | none exposed | Accepted (PR #13). |
| 4 | Abort and cancel | `AbortError` code 20 for caller abort, caller reason preserved mid-body, `TimeoutError` code 23 for `AbortSignal.timeout` | identical names and codes (measured) | Parity. Add the three cases to the adapter test so they stay equal. |
| 5 | Streaming response | works | works; 64 MiB streamed: RSS +23 MiB on Bun, +9 MiB on Node (measured) | Parity. |
| 6 | Compression, response | gzip, br, deflate, zstd decoded (zstd decoded by npm undici; Node's bundled undici did NOT: 24 bytes undecoded, measured) | gzip, br, deflate, zstd decoded (measured) | Parity for the shipped Node path. |
| 6b | Compression, request | zstd body sent with `content-encoding: zstd`, server decodes (measured) | same (measured; `zstdCompressSync` exists on Bun 1.4.3 and round-trips) | See c. |
| 7 | Redirects | follows up to 20, the 21st fails as `TypeError: fetch failed` (cause has no code, measured) | follows up to 127 (a loop stops after 127 hops in 133 ms), error `TooManyRedirects` (measured); `redirect: "manual"` and `"error"` agree; `Authorization` is dropped on a cross-origin hop on both | Difference in the limit only. No code change; note it. |
| 8 | Error shape and classification | `TypeError("fetch failed")`, code on `error.cause.code` (`ENOTFOUND`, `UND_ERR_SOCKET`; for refused connections the cause has no code) | `TypeError` whose message carries the code and `error.code` is set directly (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`); no `cause` | **Real gap.** `ai/src/utils/retry.ts` classifies by message text. Measured with `retry-probe.ts`: Node refused/reset/DNS are retryable (all say "fetch failed"); on Bun "ECONNREFUSED: Unable to connect..." is **not retryable**, while reset and DNS are. TLS failures are not retryable on Bun ("self signed certificate") but retryable on Node (wrapped as "fetch failed"). Also `formatVersionCheckError` (reads `cause.code`) and llama's `isTransient` (matches "fetch failed"). Plan: one function `transportErrorCode(error)` in `packages/ai/src/utils/` that reads `error.code`, then `error.cause.code`, then each `AggregateError` member; retry.ts adds the codes as a second, code-based test next to the text patterns, so existing Node behavior is unchanged; the two other users switch to it. The TLS asymmetry is a decision (below). |
| 9 | Large responses | `arrayBuffer()` of 64 MiB: RSS +177 MiB (npm undici) | +55 MiB | Parity or better. |
| 10 | Response `url` / `redirected` | native | wrapper re-defines both (PR #13) | Covered. |
| 11 | WebSocket proxy | no proxy support in this code path | manual `proxy:` option under Bun | Keep; see a. |

Other probes: 500 responses and `ok` behave the same; connection reset before headers surfaces as `TypeError` on both (MCP's `isRetryable` relies on that and holds).

### Verification for b

All of it is automatable with local servers (no network, no credentials): extend `test/http-dispatcher.test.ts` and `test/idle-timeout-fetch.test.ts` with the transport-error table (b.8), reconfiguration (b.3), CA (b.2), redirect limit (b.7) on both runtimes; `ai/test/retry*.test.ts` gets the Bun message strings. CI runs the Bun job on Ubuntu only, so every test must pass there; Windows evidence comes from the local runs.

## c. `loadNodeZlib()` (Decision #12 does not give a basis for narrowing it)

What it is: `openai-codex-responses.ts:208` returns `process.getBuiltinModule("node:zlib")` whenever `isNodeLikeRuntime()` (Node **or** Bun); the only user is `compressRequestBodyZstd()`, which zstd-compresses the Codex SSE request body and sets `content-encoding: zstd` (added in `0ac3cfe09`, tested in `openai-codex-stream.test.ts:2595`).

Measured: Bun 1.4.3 has `getBuiltinModule`, `zstdCompressSync` and `ZSTD_c_compressionLevel`, round-trips, and Bun's native fetch sends the compressed `Uint8Array` unchanged with the header, and the server decodes it (b.6b). So with native fetch the compressed path works on Bun exactly as on Node.

Consequence of narrowing to Node only: on Bun `compressRequestBodyZstd()` returns `null`, so Bun sends the plain JSON and no `content-encoding`. That works, but it makes request bodies of long conversations several times larger on Bun and diverges from the official Codex client; nothing in Decision #12 requires it, because undici versus native fetch does not change how a `Uint8Array` body is sent. **My recommendation: do not narrow it.** The inconsistency noted in the Phase 2 handoff is only the name (`isNodeLikeRuntime()` reads as "Node or Bun, i.e. not a browser" and is correct here). The change worth making: add a test that runs the zstd case under Bun (the existing test passes under Bun today, so it already does), and rename nothing. If you still want it narrowed, the change is one line (`isNodeLikeRuntime()` to a Node-only check) plus flipping the Bun expectation in `openai-codex-stream.test.ts`; the effect is the larger bodies above; verification is the existing test inverted. This is your decision; I have not changed anything.

## d. The rest of Phase 3

**SQLite.** `packages/durable` has one adapter, `NodeSqliteDatabase` over `node:sqlite` (`storage/sqlite/node.ts`), used by `coding-agent/src/core/durable/runtime.ts` (N2 files) and experimental code. Evidence for the 310 Windows+Bun failures in `durable` (20 files): 72 `EBUSY` removing temp directories plus 2 preload errors. Measured root cause (`sqlite-probe.mjs`): on Windows under Bun, `DatabaseSync.close()` of a WAL database leaves the `-shm`/`-wal` files locked when a prepared statement was created and not finalized, and the directory cannot be removed (`EBUSY`); Node's `close()` releases them. `NodeSqliteDatabase.close()` only does `statements.clear()` and `database.close()`; `StatementSync` has no `finalize()`. In `sqlite-probe2.mjs`: dropping the statement and `Bun.gc(true)` before close, or after close, releases the file (GC finalizes it); `bun:sqlite` with `statement.finalize()` then `close()` releases it; `bun:sqlite` without finalize does not. So: it is an adapter question, and a real one for users (a session directory cannot be deleted by the process that opened it, on Windows under Bun), not only a test problem. Options: (1) a `BunSqliteDatabase` adapter on `bun:sqlite` with explicit `finalize()` of cached statements, chosen at run time by `runningUnderBun()` inside `packages/durable/src/storage/sqlite/` (new file plus selection, no change to N2's coding-agent files if selection lives behind `openNodeSqliteStorage`); (2) keep `node:sqlite` and call `Bun.gc(true)` after close under Bun (one line, hacky, not guaranteed); (3) skip the cleanup-dependent durable tests on Windows+Bun and record it. Evaluation criteria for (1): the 1329-test durable suite passing under Bun on Windows and Linux, `bun:sqlite` bigint/`next_id` TEXT handling (see `migrations.ts` note), busy timeout, `BEGIN IMMEDIATE`. **`packages/durable` is N2's area: I request permission to touch `packages/durable/src/storage/sqlite/**` and `packages/durable/test/**` for this item only.**

**`--preload` file URL.** `packages/durable/test/env-truncate.test.ts:29` passes `new URL("./fixtures/delete-buffer.ts", import.meta.url).href` to `--preload`; Bun wants a path (`error: preload not found "file:///..."`). `packages/ai/test/fixtures/runtime-preload.ts` already has `preloadArgs()` for exactly this. Test-only fix in `packages/durable/test` (needs the same permission); it also affects `harness-lifecycle` (one failure each).

**`file-operations` timeout / `ENOSPC`.** `coding-agent/test/session-manager/file-operations.test.ts:162` writes a file longer than the runtime's `MAX_STRING_LENGTH`: 512 MiB on Node, 2 GiB (2147483647) on Bun (measured). NTFS does not make the gap sparse, so Bun writes about 2 GiB of zeros: it times out at 30 s on a slow disk and hits `ENOSPC` below about 3 GB free. Test-only. Plan: skip on Bun when the platform is win32 with the reason in the skip (the source reads in chunks; the property under test does not depend on the constant), or write sparse files on platforms that support them. No source change.

**Source loading.** `experimental/source-runtime-args.ts` (Node needs `--import source-resolver.ts`, Bun reads tsconfig `paths`), the jiti `tryNative: false` choice in `core/extensions/loader.ts`, and `scripts/nyan-source.mjs` under Bun. Read; the loader branches are covered since Phase 2. Open: running the source CLI (`nyan-source.mjs`) end to end under Bun is unverified. Plan: a smoke test that spawns it under Bun with `--version` and `--list-models` offline.

**Subprocess.** The bash tool and the durable tool runtime spawn shells and kill process trees; the CI-only Linux coverage does not exercise Windows. In the Windows+Bun run these durable tests failed only through the SQLite/preload causes above, so no separate subprocess defect surfaced; process-group and Windows Git Bash behavior under Bun remains **unverified**. Plan: a targeted test for kill-tree and output capture of a long-running child under Bun on Windows, run locally, recorded as evidence.

**Workers.** Image resize uses the Bun-first string path (`utils/image-resize.ts`, covered since Phase 2); codemode documents that Bun's `worker.terminate()` cannot stop a spinning wasm thread, so a worker can outlive the result (interrupt flag mitigates). `agent-session-codemode.test.ts` is flaky under Bun (9/25, 1/25, 0/25 failures on different runs; also 1 of 3 with the Phase 2 files reverted; passes on Node; it failed once in CI on PR #30 and passed on rerun, per the ROADMAP). Plan: reproduce with a loop under Bun, capture the failing message (`Script error:` where `1` expected), decide between a test fix and a codemode fix.

**Cross-runtime validation.** CI's Bun job: Ubuntu only, Bun 1.4.2 (local 1.4.3), `npm run test:bun`. There is no Windows or macOS Bun job and the compiled binaries are only smoke-tested with `--version` and the update flow. The Bun results on this Windows host: `agent`, `chord`, `client`, `codemode`, `mcp`, `protocol`, `server`, `telemetry`, `tui`, `ai` pass; `durable` 310 and `coding-agent` 1 fail for the causes above.

**Smaller items found.** `process.versions.node` is truthy under Bun, so Bun-only branches must use `runningUnderBun()` (already the rule). `main.ts` calls `configureHttpDispatcher()` before settings are loaded and again after; harmless on both backends.

## e. Batches and file sets

N2 owns (do not touch): `main.ts`, `core/durable/**`, `modes/durable/**`, `core/extensions/*` including `runner.ts`. `packages/durable/**` needs a request first.

| Batch | Content | Files | N2 conflict |
|---|---|---|---|
| 1 | Transport error classification (b.8): `transportErrorCode()`, `retry.ts`, `formatVersionCheckError`, llama `isTransient`; tests with Bun message strings | `packages/ai/src/utils/retry.ts`, new `packages/ai/src/utils/transport-error.ts`, `packages/ai/test/*retry*`, `coding-agent/src/utils/version-check.ts`, `coding-agent/src/extensions/llama/index.ts`, tests | none |
| 2 | HTTP backend split and the b-items: `core/http/{index,native,undici,idle-timeout}.ts`, shared timeout holder (b.3), CA/redirect/abort parity tests, docs (`settings.md`, `environment-variables.md`), `docs/architecture/layers.json` if new paths need cataloguing | `coding-agent/src/core/http-dispatcher.ts` (becomes a re-export), `core/idle-timeout-fetch.ts` (moved), new `core/http/*`, `coding-agent/test/http-dispatcher.test.ts`, `idle-timeout-fetch.test.ts`, `docs/` | none (public API and import path unchanged; `main.ts` and `core/durable/harness-setup.ts` are callers only) |
| 3 | Test hygiene without source change: `file-operations` Windows+Bun skip, `agent-session-codemode` investigation | `coding-agent/test/session-manager/file-operations.test.ts`, `coding-agent/test/suite/agent-session-codemode.test.ts` | none |
| 4 | SQLite on Bun (adapter or alternative), `--preload` path fix | `packages/durable/src/storage/sqlite/**`, `packages/durable/test/env-truncate.test.ts`, durable storage tests | **needs your permission for `packages/durable`**; no `coding-agent` file if selection stays inside durable |
| 5 | Source loader smoke, subprocess and worker evidence (tests only; source changes only if a defect is found, each as its own item) | `coding-agent/test/*`, `packages/codemode/test/*` | none |
| 6 | Gate verification: CI Bun version alignment, optional Windows Bun job, release dry run, compiled-binary run | `.github/workflows/ci.yml` (and its Bun version), `scripts/test-bun.mjs` | none; workflow edits need your yes |

Order: 1, then 2 (2 consumes 1's tests), 3 anytime, 4 after permission, 5, 6 last.

## f. Gate draft for Phase 3

Closing conditions (same style as Phase 2):

1. `npm run check` exits 0 on the merge commit's parent branch after rebasing onto `main`.
2. Targeted Node and Bun tests for every changed file pass; each new branch has a test that fails when the branch is disabled (mutation check recorded).
3. PR CI green: Ubuntu Node suite, Ubuntu Bun suite, Windows build and check.
4. Release dry run green on the branch, **including `Publish`** once PR #33 is merged.
5. The parity table in b is either implemented with a test, or each remaining difference is recorded as accepted in `2026-10-13-bun-native-fetch.md` (redirect limit, forward-proxy form, no connection-attempt timeout, no HTTP/2 switch are the current ones).
6. Windows+Bun: **fix, do not reduce, the two defects that are real for users**: the SQLite file lock on close (batch 4) and the `--preload` path in the test; record the `file-operations` item as a test skip with its reason. CI has no Windows Bun job, so the evidence for these is a local Windows run (`npm run test:bun` with the durable and coding-agent suites passing), written into the Verification section of the note. If you prefer to treat the SQLite lock as accepted for Phase 3, that is the one condition that would move to Phase 4 and the Windows Bun results would stay "known failing" in the ROADMAP; I recommend fixing it because it also breaks deleting a session directory from the same process.
7. Unverified items listed in the note instead of silently dropped: system CA store under Bun, Bedrock handlers on Bun, subprocess kill-tree on Windows under Bun (unless batch 5 measures them), macOS.

## Decisions I need from you

1. `loadNodeZlib()`: leave as is (my recommendation, section c) or narrow to Node.
2. Retry classification of TLS failures: today on Node every connection failure, including a certificate error, is "fetch failed" and is retried; on Bun a certificate error is not. Make Bun match Node (retry), or make both not retry certificate errors (a behavior change on Node)?
3. Permission to touch `packages/durable/src/storage/sqlite/**` and `packages/durable/test/**` for batch 4, and which SQLite option (1, 2 or 3).
4. Permission to add a certificate to the Windows user store temporarily to test `--use-system-ca` against Bun (b.2b), or leave it unverified.
5. Whether a Windows Bun job in CI is wanted (batch 6), and aligning CI's Bun version (1.4.2) with the one we test locally (1.4.3).
6. Whether to load undici only on Node (needs a sync or async decision; measure startup and size first, Phase 4).

## Not verified in this document

Everything labelled read or unverified above; Bun on Linux and macOS (all probes ran on Windows); compiled-binary behavior of the probes (they ran under `bun` and `node`, not inside `nyan.exe`); the owner's proxy and CA setup; the `agent-session-codemode` flake cause.
