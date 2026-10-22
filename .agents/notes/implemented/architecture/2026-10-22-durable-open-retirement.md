# Agent Note: Retire a durable open's extension runner when it closes

Status: implemented

## Problem

`DurableSessionOwner.reload()` replaces a whole `OpenDurableResult`: `previous.close("reload")` runs the extension lifecycle and closes the session, and a fresh `openDurable` (new services, new extensions) becomes the open the TUI renders. Nothing said what happened to the members of the open that was left: `ModelRuntime`, `SettingsManager`, `ResourceLoader`, the `ExtensionRuntime`, and the `ExtensionHost`'s runner all became unreachable without a stated end.

Two questions had to be answered before adding anything:

- **Is a handle leaked?** No. The only live resources an open owns are the ones its extension instances opened, and they are released by the `session_shutdown` that `close()` emits: the built-in MCP extension closes every connection, `cliproxyapi` clears its refresh interval, `herdr` releases the pane. `ModelRuntime`, `SettingsManager` and `ResourceLoader` hold no timer, watcher or socket at rest, and the HTTP dispatcher they configure is process-global, not per open. The MCP server of a replaced open exits during the reload, which `test/durable-reopen-retirement.test.ts` now asserts by pid.
- **What is actually missing?** An explicit retirement contract. A stale contract is worse than no handle leak: after `/reload`, an extension that kept its `ctx` from the closed open could still call into a session that no longer exists, and nothing reported it. The legacy path has the same protection (`AgentSession.reload()` calls `oldRunner.invalidate()`); the durable path, which builds a new host per open, had no equivalent.

## Decision

- `ExtensionRunner.retire(message?)` marks a runner stale: every context it hands out fails on first use, and every emit throws. `ExtensionRunner.invalidate(message?)` keeps its behavior for the legacy path and is now expressed as `retire()` plus `runtime.invalidate()`.
- `ExtensionHost.retire()` retires its runner and closes the codemode sandbox. `openDurable().close()` calls it right after `host.shutdown(reason)`, so every path that ends an open — `/reload`, `/new`, `/resume`, quit, and a failed reopen that falls back — retires exactly one runner.
- Retirement is **runner-level, not runtime-level**. The extensions themselves stay loaded: `/new` and `/resume` reuse the same services on purpose, and `runtime.invalidate()` would unsubscribe the event-bus subscriptions the loaded extensions tracked at load time, silently breaking them for the open that follows. Only `/reload` builds new extensions, and its old runtime is then garbage with no listener left behind.

## Alternatives considered

**A `dispose()` on `AgentSessionServices`.** Rejected: those three members own nothing to release, so the method would be an empty promise. The one thing that is per-open and does own state is the host.

**Retire through `runner.invalidate()`.** Rejected: it poisons the shared `ExtensionRuntime`. A `/new` after it would open a session whose extensions have no event-bus subscriptions, and the test above fails on exactly that.

**Retire the host from the TUI when it adopts the next open.** Rejected: the owner closes the previous open, so the end of an open belongs to `openDurable().close()`; a caller that closes a session without a TUI (RPC, print mode) must get the same guarantee.

**A `retire` option on `openDurable` that a test turns on.** Rejected: a product seam that exists only for tests. The guarantee is observable without it — a retired runner, and a closed MCP connection.

## Consequences

A context kept from a closed open now throws `This extension ctx is stale after session replacement or reload ...` instead of acting on the closed session. Extensions that shut down cleanly are unaffected, because `session_shutdown` still arrives before the runner is retired. The stale message moved to one constant in `runner.ts`, so the runner and the runtime report the same text.

## Verification

- `packages/coding-agent/test/durable-reopen-retirement.test.ts`: the runner of a replaced open refuses a context while the next open's works; a `/new` keeps the extensions' load-time event-bus subscriptions (this case fails if retirement invalidates the runtime); the MCP server of a replaced open exits during `/reload` and the newest one exits with the session.
- `packages/coding-agent/test/durable-tui-reopen.test.ts`: after a successful `/reload` the TUI reads the new open's settings, themes, and runner, and a key press reaches the reloaded extension instance; a `/reload` that cannot load its extensions follows the session the owner recovered and still takes a prompt; a `/new` whose store cannot be created does the same.
- Both files pass under Node and Bun; `npm run check` passes; the 42 `test/durable-*.test.ts` files (418 tests) and the extension/agent-session suites pass unchanged.
