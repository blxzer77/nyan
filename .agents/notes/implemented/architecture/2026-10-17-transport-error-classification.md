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
4. A certificate code is appended to the stored message when the message does not already say it (`errorMessageWithCertificateCode`). Node's text would otherwise hide the reason from the classifier, which only sees the string. Only certificate codes are appended; every other message is unchanged.
5. The certificate list is copied into `retry.ts` and checked against `transport-error.ts` by a test. The copy exists because a runtime import from `retry.ts` adds a file to durable's entry graph, which has a fixed budget (`scripts/check-entry-graphs.mjs`); the budget was not raised.
6. `formatVersionCheckError` and the llama extension's connection test read the same codes, so they show the code on Bun as they already did on Node. The llama test keeps its old text match as a fallback, so an uncoded error behaves as before.

## Evidence

- `packages/ai/test/transport-error.test.ts` (23 tests) and `retry.test.ts`: 52 passed under Node and under Bun.
- Provider and error suites (`anthropic*`, `mistral*`, `error*`, `provider-error*`, `retry*`): 219 passed, 39 skipped (credential-gated) under Node and Bun.
- `packages/coding-agent/test/version-check.test.ts` and the llama tests: 26 passed under Node and under Bun.
- Mutations, each under Node and Bun, all caught: the certificate pattern off; the certificate codes removed from the pattern; only the first code read (found by adding a two-code test, since the first version of the test had no chain with two codes); the cause chain not followed; `AggregateError` members not read; connection codes not connection errors; the message not carrying the certificate code; Bun's refused text not retryable. Drift between the two certificate lists: caught by removing one entry from `retry.ts`.
- `npm run check` exits 0.

## Not verified

- Certificate and host-name failures under Bun on Linux and macOS, and in a compiled executable (probes ran under `bun`).
- A real TLS server behind a proxy (`CONNECT`). The probes used a local HTTPS server with a generated certificate.
- Bedrock and the AWS SDK's own retry layer, which do not go through `retry.ts` for transport failures in the same way.
