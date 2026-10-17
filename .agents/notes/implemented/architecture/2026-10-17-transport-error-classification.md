# Agent Note: transport error classification (Bun Phase 3, batch 1)

Status: implemented

## Problem

A failed request reaches the retry classifier as a string: `AssistantMessage.errorMessage`. Each runtime reports the same failure differently, so one message can mean different things:

- Node (undici) throws `TypeError("fetch failed")` for every failure and keeps the reason on `error.cause`. A refused connection has no code on the cause; a DNS failure has `ENOTFOUND`; a certificate failure has `DEPTH_ZERO_SELF_SIGNED_CERT` or `ERR_TLS_CERT_ALTNAME_INVALID`. The text alone cannot tell them apart, so the classifier retried all of them.
- Bun (native fetch) puts the code on the error and in the message: `ECONNREFUSED: Unable to connect...`, `ECONNRESET: The socket connection...`, `getaddrinfo ENOTFOUND ...`, and `ERR_TLS_CERT_ALTNAME_INVALID fetching ...`. The text patterns did not match `ECONNREFUSED: Unable to connect`, so a refused connection was not retried on Bun, while Node retried it.

Measured with `packages/ai/test/transport-error.test.ts` (fixtures built from the measured shapes) and the probes in the Phase 3 design:

| Failure | Node before | Bun before |
|---|---|---|
| refused | retried (`fetch failed`) | **not retried** |
| DNS | retried | retried |
| connection reset | retried | retried |
| self-signed or unknown issuer | **retried** | not retried |
| host name mismatch | **retried** | not retried |

## Decision

1. Certificate and host-name verification failures are not retried on either runtime. A retry sends the same request to the same server and gets the same certificate error. This is a behavior change on Node, and the CHANGELOG `Changed` entry says so.
2. Connection failures stay retryable. On Bun the classifier also matches `ECONNREFUSED` and `unable to connect`, which Bun writes for a refused connection. Node's behavior for connection failures is unchanged.
3. The code is read from the error and its cause chain (`transportErrorCodes()` in `packages/ai/src/utils/transport-error.ts`), so an SDK wrapper such as `Connection error.` does not hide it. The chain walk is bounded (depth 6, cycle-safe, `AggregateError` members included).
4. A certificate code is appended to the stored message when the message does not already say it (`errorMessageWithCertificateCode`). Node's text would otherwise hide the reason from the classifier, which only sees the string. When no code is on the chain, the text of a cause that names a certificate is appended instead, so a text-only failure under an SDK wrapper (`Connection error.` over `fetch failed` over `self signed certificate`) is not stored as a plain connection error. Only certificate codes and certificate text are appended; every other message is unchanged. `NormalizedProviderError.message` therefore is not always the SDK's own message.
5. The certificate code list (`CERTIFICATE_ERROR_CODE_LIST`) and the message matcher (`isCertificateErrorMessage`) live in `retry.ts`. `transport-error.ts` imports them from there. The import goes this way on purpose: a runtime import from `transport-error.ts` into `retry.ts` adds a file to durable's entry graph, which has a fixed budget (`scripts/check-entry-graphs.mjs`, 66), and the budget was not raised.
6. Messages that name a certificate in text are judged by a text rule, with two checks:
   - Outer classifier (`isRetryableAssistantError`): a stored message is a certificate failure only when it has no retryable HTTP status. A status is recognised where a provider writes one: `503: ...` (formatProviderError), `503 {...}` (the raw Anthropic SDK message, which has a space and no colon), `(429): ...`, `HTTP 503`, `status code 500`, `code: 503`. A leading number followed by `ms`, `msec` or `milliseconds` (any whitespace before the unit) is a duration, not a status. Ports, IPv6 groups, and numbers inside host names do not match. The outer layer sees only the stored text, so a provider whose stored text has another form and whose body names a certificate is still not retried here. This is a known limit.
   - Inner layer (`retryProviderRequest` in `utils/provider-retry.ts`): a certificate code anywhere on the error or cause chain is not retried. Certificate text on the chain counts only when the error has no HTTP status, because an HTTP error's message is its response body, and a 503 whose body says "certificate expired" is still a server error to retry.
7. `formatVersionCheckError` reads the same codes, so it shows the code on Bun as it already did on Node. The llama extension's connection message checks the certificate first (code, then text), so a certificate is shown instead of "Could not connect to the server." even when a connection code is also on the chain. Certificate text is judged there without the status rule because the llama message is only displayed, not retried.
8. Undici codes are listed one by one as connection errors: the socket, closed, connect-timeout, headers-timeout and body-timeout codes. `UND_ERR_*` as a prefix also matched a cancelled request (`UND_ERR_ABORTED`), a non-2xx response, and a bad argument, none of which mean the server was not reached.
9. The certificate code list is regex-escaped before it is put into the pattern, though the current codes need no escaping.

## Evidence

Last run on the last code commit of this batch:

- `npm run check` exits 0.
- `packages/ai/test/transport-error.test.ts`, `retry.test.ts`, `provider-retry.test.ts`, `error-body.test.ts`: 100 passed under Node and under Bun.
- `packages/coding-agent/test/llama-connection-message.test.ts`, `llama-extension.test.ts`, `version-check.test.ts`: 35 passed under Node and under Bun.
- Mutations, each under Node and Bun, all caught: the certificate pattern off; certificate codes removed from the pattern; only the first code read; the cause chain not followed; `AggregateError` members not read; connection codes not connection errors; the message not carrying the certificate code; Bun's refused text not retryable; the outer status exemption removed; the status token in its colon-only, broad, or colon-less-leading form; the ms exclusion removed or limited to one space and `ms`; the llama certificate branch and its text branch removed; the certificate text of a cause not appended when there is no code.
- Earlier heads: the full `packages/ai` suite passed locally under Node (143 files, 1355 tests, `NYAN_OFFLINE=1`).

## Not verified

- Certificate and host-name failures under Bun on Linux and macOS, and in a compiled executable (probes ran under `bun`).
- A real TLS server behind a proxy (`CONNECT`). The probes used a local HTTPS server with a generated certificate.
- Bedrock and the AWS SDK's own retry layer. The AWS SDK retries inside its own handler, which `retryProviderRequest` does not wrap, so a certificate failure there is not covered by batch 1.
- The OpenAI and Anthropic SDKs' own `maxRetries` (set to zero by nyan, so not exercised here), and any SDK retry that runs before `retryProviderRequest` sees the error.
- The outer status rule covers the stored-text forms listed in decision 6. A provider that stores a status in another form, with a body that names a certificate, is not retried by the outer classifier.

## Known failures in this area, not caused by batch 1

- Bun `agent-session-codemode.test.ts` and the durable `codemode.test.ts` intermittently fail on this branch (CI and release dry run). The tests reach codemode's own `stopReason`/`errorMessage` path, not the retry classifier. The owner accepted these failures for now (2026-10-17); the fix is tracked with the codemode work.
