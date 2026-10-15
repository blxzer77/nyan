# Durable compatibility entry

The durable coding-agent implementation was promoted to the product source tree in N1:

- `src/core/durable/` owns session selection, Harness composition, settings, tools, prompts, and model access.
- `src/modes/durable/` owns the current durable TUI adapter.
- This directory keeps source-level shims for the old experimental entry while callers migrate.

The pre-promotion prototype was 1,416 lines across nine files. The implementation now lives outside
`src/experimental/`; the files here are not a second runtime and must not gain product logic.

New durable sessions live under `~/.nyan/agent/sessions-durable/<cwd-hash>/<timestamp>-<uuid>/session.sqlite`.
The old `~/.nyan/agent/sessions/` JSONL tree remains the read-only compatibility path for legacy
session-selection flags until their durable adapters are implemented.

Run the compatibility entry from a source checkout with:

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts --continue
```

The product CLI's default interactive path now calls the promoted runtime directly. The current
compatibility entry is temporary; its wrappers should be removed only after N1 verifies the product
entry and the old source-level command is no longer needed.
