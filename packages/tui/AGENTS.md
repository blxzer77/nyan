# packages/tui

Terminal UI library with differential rendering, used by `packages/coding-agent`.

- Tests use `node:test`, not vitest. Run one file from this package with `node --test test/specific.test.ts`.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`. Add the default to `TUI_KEYBINDINGS` in `src/keybindings.ts` so it stays configurable.
