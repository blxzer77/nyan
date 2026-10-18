# Agent Note: HTTP on Bun uses the native fetch

Status: implemented

## Problem

`configureHttpDispatcher()` made undici the HTTP stack: an `EnvHttpProxyAgent` with `headersTimeout` and `bodyTimeout` set from `httpIdleTimeoutMs`, installed as the global dispatcher and, through `undici.install()`, as the global `fetch`. On Bun this did not work. Its tests failed (`dispatcher.close is not a function`, a timeout case that returned a `Response`), and measured on Bun 1.4 a server that stalled for five seconds before its headers, or in the middle of its body, was answered after five seconds with an idle timeout of one second. The setting did nothing there. The standalone executable ships Bun, so every user of it had a timeout setting that was silently ignored, which the repository's rule against silently falling back to different behavior forbids.

## Decision

On Bun the global fetch stays Bun's native fetch. `configureHttpDispatcher()` on Bun does not touch undici; it wraps the native fetch with `createIdleTimeoutFetch()`. The Node path is unchanged.

Since Bun Phase 3 batch 2 the two backends have one home, `src/core/http/`: `index.ts` (the settings helpers, `applyHttpProxySettings()` and `configureHttpDispatcher()`, which picks the backend with `runningUnderBun()` on every call), `native.ts` (Bun), `undici.ts` (Node, the only importer of `undici`), `idle-timeout.ts` (the wrapper, moved from `core/idle-timeout-fetch.ts`) and `system-ca.ts`. `core/http-dispatcher.ts` re-exports the public API, so no caller changed its import. `undici` is still loaded on Bun; loading it only on Node is Phase 4.

- **One wrapper, a shared timeout.** The wrapper reads the idle timeout from a holder when each request starts (`createIdleTimeoutFetch()` takes a number or a function). `configureHttpDispatcher()` updates the holder and keeps one wrapper for the life of the process, so a client built before the setting changed (an SDK client keeps the fetch it was constructed with, for example the cached Anthropic federation client) follows it. With a timeout of 0 the original fetch becomes the global one again and a held wrapper passes requests through untouched. A request already in flight keeps the timeout it started with. The holder is updated even when someone else's fetch is global; the global is then left alone.
- **System certificate store.** See Consequences and Verification.

- **Proxy.** Bun's fetch reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` itself, on every request (checked, including a variable set after startup, which is how `applyHttpProxySettings` works). Nothing in the wrapper deals with proxies.
- **Idle timeout.** The wrapper arms a timer for the response headers and, while a consumer is waiting for it, a timer per body chunk. A timer abort rejects the pending `fetch()` or read with a `TimeoutError` whose `code` is `UND_ERR_HEADERS_TIMEOUT` or `UND_ERR_BODY_TIMEOUT`, the codes undici produces, so the provider retry and the MCP transport classify both runtimes alike. A timeout of 0 installs nothing. A caller's signal still aborts with the caller's reason.
- **Someone else's fetch.** As on the Node path, a fetch installed by someone else after startup is left alone.

## Alternatives considered

**Keep undici on Bun.** The previous behavior. Its dispatcher does not apply to Bun's fetch, and `undici.install()` replacing the global fetch with a JavaScript one forfeits Bun's native client, so the timeout was lost and the proxy path was not Bun's own.

**Native fetch without a timeout.** Simplest, but the setting would be ignored without telling anyone, in the runtime the standalone executable uses.

**Pass `timeout` or `proxy` options to Bun's fetch.** `{ timeout }` is ignored (measured: the call took the full six seconds). `{ proxy }` works but is a per-call option; the environment variables already cover every call.

## Consequences

The two runtimes differ in these ways, both verified:

- Which requests Bun's fetch proxies, and in which form, is Bun's own behavior and is not the same on every platform; nothing in Nyan configures it. Measured: on Windows a loopback plain-HTTP origin went through the proxy as `GET http://origin/...`, on Linux the same request went directly to the origin. On Node the dispatcher uses a `CONNECT` tunnel for a plain-HTTP origin. A proxy that supports only tunnels will refuse plain-HTTP origins on Bun.
- On Bun there is no dispatcher to configure: no HTTP/2 switch and no connection-attempt timeout (`autoSelectFamilyAttemptTimeout`).
- The wrapper returns a new `Response` for a response with a body, with the same status, headers, `url` and `redirected`, but not `type`.
- **The operating system certificate store is switched on differently.** Node reads `NODE_OPTIONS=--use-system-ca`. Bun does not read `NODE_OPTIONS`; it reads its own `--use-system-ca` argument, `BUN_OPTIONS=--use-system-ca` and `NODE_USE_SYSTEM_CA=1`, all at start-up (setting the variable from inside the process changes nothing). In the standalone executable the program's arguments are not Bun's, so only the two variables work there. A machine set up for Node (`NODE_OPTIONS=--use-system-ca`, as the owner's is) silently loses its system store under Bun, so `configureHttpDispatcher()` on Bun warns once when `NODE_OPTIONS` asks for it and none of Bun's switches is set (`core/http/system-ca.ts`). `NODE_EXTRA_CA_CERTS` works the same on both and needs no switch. Nyan does not turn the system store on for Bun by itself: that would change which certificates the standalone executable trusts for every user.
- Bun's TLS library rejects a CA certificate that carries an IP-address name constraint (`unsupported name constraint type`); Node accepts it. A DNS name constraint works on both. Measured with the test CA below; nothing in Nyan depends on it.

`undici` stays a dependency of `@ny4n/coding-agent` for Node, so the AGENTS.md rule about reading its release notes before an update still applies.

## Verification

- `test/idle-timeout-fetch.test.ts` (9 tests, real local servers, Node and Bun): pass-through of status, headers, url and body; a body-less response; the headers timeout and the body timeout with their codes; chunks that keep arriving within the timeout; a slow consumer; the caller's abort reason; cancelling the body. Four deliberate breakages of the wrapper each make some of them fail.
- `test/http-dispatcher.test.ts`: the undici tests run on Node (a CONNECT tunnel for a plain-HTTP origin, the two-second connection attempt), and three tests run only on Bun (the fetch is wrapped and unwrapped, the timeout applies, a foreign fetch is left alone). No test asserts how Bun routes a proxied request, because that differs by platform.
- By hand on Bun 1.4.3: an HTTPS origin with a self-signed certificate behind a `CONNECT` proxy answered `200` through `configureHttpDispatcher(6000)`, with the proxy seeing `CONNECT`. Before this change, with an idle timeout of one second, a five-second header stall and a five-second body stall were returned after five seconds; now both fail after one second.
- Not verified: Linux and macOS, and the compiled executable (the tests ran Bun against the sources).

### Bun Phase 3 batch 2

- `test/http-dispatcher.test.ts` (Bun cases): a client that captured the fetch before a change follows the new timeout; it stops timing out when the timeout is disabled; a held wrapper follows the setting even when someone else's fetch is global; the wrapper is one function for the life of the process. Run first against the unchanged implementation, the captured-client test, the disabled-timeout test and the one-wrapper test failed (the held-wrapper test was written afterwards); three mutations of `native.ts` (fixed timeout instead of the holder, holder updated only when the global is ours, timeout 0 not restoring the original) each fail them.
- `test/idle-timeout-fetch.test.ts`: a timeout given as a function is read per request, with the base fetch called untouched when it is not positive.
- `test/http-parity.test.ts`, on Node and on Bun with the same assertions: abort gives `AbortError` code 20, the caller's reason survives a mid-body abort, `AbortSignal.timeout` gives `TimeoutError` code 23, a redirect chain keeps `url` and `redirected`, a redirect loop ends in a `TypeError` (the limit differs, undici 20 and Bun about 127, and is not asserted), `Authorization` is not sent to another origin, a private CA is trusted through `NODE_EXTRA_CA_CERTS` and refused with a certificate code when not trusted. The CA and server certificate are built in memory (`test/fixtures/tls-certificates.ts`, `node:crypto` signing and a small DER writer; OpenSSL parses and verifies them), so no key is committed.
- `test/http-system-ca.test.ts`: the warning logic as pure functions, and `configureHttpDispatcher()` warning once on Bun and not on Node.
- Mutations, each on Node and Bun: the wrapper ignoring the caller's signal, replacing a body error, dropping `redirected`, not passing a disabled request through; the warning not limited to one, `NODE_USE_SYSTEM_CA` not read, `NODE_OPTIONS` matched as a substring, the Bun backend not warning; the Node dispatcher with `rejectUnauthorized: false`. All caught where the behavior exists (the Bun-only ones are not exercised on Node).

#### System certificate store under Bun (Windows x64, Node 24.3.0, Bun 1.4.3)

A throwaway CA (`CN=nyan-test-ca-20261018`, two days, may certify `DNS:localhost` only) signed a server certificate for `localhost`; an HTTPS server on `127.0.0.1` used it. `NODE_EXTRA_CA_CERTS` was unset in every run of the table, and the owner's own CA was not used. Before the CA was installed, every system-store variant failed on both runtimes with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and the controls that hand the CA over directly (`ca` on Node, `tls: { ca }` on Bun) succeeded. After installing the CA in `Cert:\CurrentUser\Root` only (SHA-1 `6D44E10AF7FCBAE159D06E5D0B2E57225DFCCE55`):

| How the store is requested | Node 24.3.0 | Bun 1.4.3 | compiled Bun probe |
|---|---|---|---|
| nothing | fails | fails | fails |
| `NODE_OPTIONS=--use-system-ca` | works | **fails** | **fails** |
| `--use-system-ca` argument | works | works | fails (the argument is the program's) |
| `NODE_USE_SYSTEM_CA=1` | fails (not read) | works | works |
| `BUN_OPTIONS=--use-system-ca` | not run | works | works |

Also on Bun: `NODE_USE_SYSTEM_CA=true` works, `0` fails; `NODE_OPTIONS` with the flag among other options fails; `NODE_OPTIONS` together with `NODE_USE_SYSTEM_CA=1` works; setting `NODE_USE_SYSTEM_CA` from inside the process, before or after the first request, fails. The "compiled Bun probe" is a 20-line fetch script compiled with `bun build --compile`, not `nyan.exe`. The same probe with `NODE_EXTRA_CA_CERTS` pointing at the CA file (no store) works, and without it fails.

Result: Bun does support the Windows system store, but not through `NODE_OPTIONS`. The warning and the table in `docs/environment-variables.md` follow from this.

Cleanup, after the runs: the test server stopped; `certutil -user -delstore Root 6D44E10AF7FCBAE159D06E5D0B2E57225DFCCE55` removed the certificate (`Remove-Item Cert:\CurrentUser\Root\<thumbprint>` refused with `UI is not allowed`); `CurrentUser\Root` held 286 certificates before, 287 with the test CA, 286 after, and no certificate matching `nyan-test-ca` remained in `CurrentUser\Root`, `LocalMachine\Root`, `CurrentUser\CA`, `My` or `TrustedPeople`; `D:\nyan-tmp\bun\ca\` was emptied, so the CA key and the server key are gone. Two earlier attempts with `Import-Certificate` failed with the same `UI is not allowed` and installed nothing.

Not verified: Linux and macOS (the table is Windows only); `nyan.exe` itself; a system store holding the owner's real CA.
