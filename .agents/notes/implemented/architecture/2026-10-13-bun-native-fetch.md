# Agent Note: HTTP on Bun uses the native fetch

Status: implemented

## Problem

`configureHttpDispatcher()` made undici the HTTP stack: an `EnvHttpProxyAgent` with `headersTimeout` and `bodyTimeout` set from `httpIdleTimeoutMs`, installed as the global dispatcher and, through `undici.install()`, as the global `fetch`. On Bun this did not work. Its tests failed (`dispatcher.close is not a function`, a timeout case that returned a `Response`), and measured on Bun 1.4 a server that stalled for five seconds before its headers, or in the middle of its body, was answered after five seconds with an idle timeout of one second. The setting did nothing there. The standalone executable ships Bun, so every user of it had a timeout setting that was silently ignored, which the repository's rule against silently falling back to different behavior forbids.

## Decision

On Bun the global fetch stays Bun's native fetch. `configureHttpDispatcher()` on Bun does not touch undici; it wraps the native fetch with `createIdleTimeoutFetch()` (`src/core/idle-timeout-fetch.ts`). The Node path is unchanged.

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

`undici` stays a dependency of `@ny4n/coding-agent` for Node, so the AGENTS.md rule about reading its release notes before an update still applies.

## Verification

- `test/idle-timeout-fetch.test.ts` (9 tests, real local servers, Node and Bun): pass-through of status, headers, url and body; a body-less response; the headers timeout and the body timeout with their codes; chunks that keep arriving within the timeout; a slow consumer; the caller's abort reason; cancelling the body. Four deliberate breakages of the wrapper each make some of them fail.
- `test/http-dispatcher.test.ts`: the undici tests run on Node (a CONNECT tunnel for a plain-HTTP origin, the two-second connection attempt), and three tests run only on Bun (the fetch is wrapped and unwrapped, the timeout applies, a foreign fetch is left alone). No test asserts how Bun routes a proxied request, because that differs by platform.
- By hand on Bun 1.4.3: an HTTPS origin with a self-signed certificate behind a `CONNECT` proxy answered `200` through `configureHttpDispatcher(6000)`, with the proxy seeing `CONNECT`. Before this change, with an idle timeout of one second, a five-second header stall and a five-second body stall were returned after five seconds; now both fail after one second.
- Not verified: Linux and macOS, and the compiled executable (the tests ran Bun against the sources).
