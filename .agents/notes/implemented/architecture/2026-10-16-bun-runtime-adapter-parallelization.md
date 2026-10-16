# Agent Note: Bun runtime adapter parallelization

Status: implemented

Scope of "implemented": the three slices described under Decision. Bun Phase 2 itself stays Active in `ROADMAP.md` until the remaining consumers are migrated.

## Problem

Bun support is already functional, but runtime decisions are split between `config.ts`, inline `process.versions.bun` checks, the HTTP dispatcher, worker paths, source loading, subprocess setup, and the `@ny4n/ai` package. N2 is also changing the durable product path and the extension surface. Editing these areas without a fixed boundary can change the meaning of the existing Bun/Node branches or create avoidable conflicts between the two active work lines.

## Decision

Run Bun Phase 2 as the second active roadmap line alongside N2, with no more than the two lines allowed by `ROADMAP.md`.

The first Phase 2 batch establishes a pure coding-agent runtime identity module at `packages/coding-agent/src/runtime.ts`. It owns only runtime identity and detection:

- `RuntimeKind` is the string union `"bun-binary" | "bun" | "bundled-node" | "node"`.
- `isBunBinary`, `isBunRuntime`, and `isBundledNode` retain their current module-load snapshot semantics and public names.
- `runningUnderBun()` retains its current re-read semantics because tests intentionally change `process.versions.bun` after module load.
- `getRuntimeKind()` resolves with the precedence Bun binary, bundled Node, Bun, unbundled Node. Its Bun input is re-read on each call, while the Bun binary and bundled Node inputs are the load-time snapshots.

`config.ts` continues to own package paths and product configuration. It re-exports the existing identity names from `runtime.ts` so current imports remain compatible; it does not become the runtime adapter.

The first implementation slice centralizes the HTTP dispatcher branch on `runningUnderBun()` without changing the existing Bun-native-fetch or Node-undici policy. The second slice moves the stdout takeover branch in `packages/coding-agent/src/core/output-guard.ts` to `runningUnderBun()` and replaces the duplicated `bun/x` versus `node/x` label in `packages/coding-agent/src/utils/nyan-user-agent.ts` and `packages/coding-agent/src/core/bug-report.ts` with `getRuntimeLabel()`. `getRuntimeLabel()` re-reads `process.versions` on each call, so it keeps the same test-time behavior as the inline checks it replaces. It also keeps their truthiness test, whereas `runningUnderBun()` keeps its `typeof` test; the two differ only for an empty `process.versions.bun`, which Bun does not report, and `test/runtime.test.ts` pins that difference so changing either is a deliberate decision. The third slice gives `@ny4n/ai` its own boundary, because `ai` is a lower layer that must load in a browser bundle and cannot import coding-agent. `packages/ai/src/utils/runtime.ts` sits in the `contracts` module layer, imports nothing, and exports `isNodeLikeRuntime()` (Node or Bun, that is, not a browser) and `runningUnderBun()`. Both re-read `process.versions` on every call, so each of the eight former inline checks keeps its evaluation time and truthiness behavior. The two helpers are separate on purpose: Bun also reports `process.versions.node`, so a Bun-only branch must not be written as the Node-like check. The remaining consumers (`utils/image-resize.ts`, `bun/restore-sandbox-env.ts`, `core/extensions/loader.ts`, `main.ts`, and `experimental/*`) are separate slices and must not be claimed as complete Phase 2 until they are migrated and tested.

The N2 file reservation is explicit: the first Phase 2 slice must not modify `main.ts`, `core/extensions/loader.ts`, `core/durable/**`, `modes/durable/**`, or image/resource files that N2 may reconnect. Any later overlap requires a fresh reservation before editing.

## Alternatives considered

- **Keep the identity in `config.ts`:** rejected because `config.ts` imports filesystem, OS, path, package identity, and process helpers and reads `package.json` during module initialization; it is not a pure identity boundary.
- **Add one adapter abstraction for every Bun difference:** rejected because most differences are product-specific path or loading behavior, while HTTP is the only current pair of complete Node/Bun implementations. Over-abstraction would increase layering and browser risks.
- **Change the HTTP policy while extracting the identity:** rejected because Owner Decision #12 keeps the Bun-native-fetch versus undici choice visible. This batch only changes the source of the branch decision.
- **Run Phase 2 after N2:** rejected because the roadmap explicitly makes Phase 2 independent of N0/N2, and the two work lines can be kept disjoint.

## Consequences

Phase 2 gets a stable base contract and can proceed in independent batches. The new base module requires the coding-agent architecture catalogue to include `runtime.ts`. The work remains partial until loader, subprocess, worker, AI-runtime, and cross-runtime validation slices are complete. N2 retains ownership of durable integration and extension/resource behavior.

## Verification

Slice 1 added `packages/coding-agent/src/runtime.ts`, registered it in `docs/architecture/layers.json`, kept the `config.ts` identity exports, and moved the HTTP branch decision to `runningUnderBun()` without changing the Bun-native-fetch or Node-undici policy.

Slice 2 moved the stdout takeover branch and the two runtime labels onto the same module. `packages/coding-agent/test/nyan-user-agent.test.ts` asserts the literal user agent with the Bun marker set, absent, and empty. `packages/coding-agent/test/output-guard-runtime.test.ts` asserts that `takeOverStdout()` replaces the console methods only when the marker is set and that `restoreStdout()` puts them back; with the Bun branch forced false, the marker-set test fails, and the restored source passes. `packages/coding-agent/test/runtime.test.ts` covers the precedence table, the re-read of the marker, an absent marker, and the empty-marker difference.

Slice 3 added `packages/ai/src/utils/runtime.ts` and `packages/ai/test/runtime.test.ts` (marker injected, empty, and `process` absent) and replaced the eight inline checks in `utils/provider-env.ts`, `utils/nyan-user-agent.ts`, `env-api-keys.ts`, `auth/oauth/openai-codex.ts`, `api/bedrock-converse-stream.ts`, and `api/openai-codex-responses.ts`. The whole `packages/ai` suite, run with credential-like variables removed from the environment so provider e2e tests skip, gives the same result under Node and Bun: 142 test files passed and 26 skipped, 1328 tests passed and 868 skipped. The skips are the credential-gated provider tests.

Observed results: the coding-agent runtime, user agent, output guard, HTTP dispatcher, config, and bug-report test files pass under Node (37 passed, 3 skipped) and Bun (38 passed, 2 skipped). `check:extension-surface`, `typecheck`, `check:pinned-deps`, `check:runtime-deps`, `check:ts-imports`, `check:architecture`, `check:entry-graphs`, `check:install-lock:coding-agent`, and `check:browser-smoke` pass, and `npm run lint` passes over the whole repository.

Not verified: the full Bun suite, the compiled Bun binary, and the bundled-Node build were not run. The full Phase 2 gate remains open because loader, subprocess, worker, and cross-runtime validation slices are not complete.
