# packages/tui

`@ny4n/tui`: the terminal UI library with differential rendering, used by `packages/coding-agent`.

- Tests use `node:test`, not vitest. Run one file from this package with `node --test test/specific.test.ts`.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`. Add the default to `TUI_KEYBINDINGS` in `src/keybindings.ts` so it stays configurable.
- Native helper modules live in `native/<platform>/`, with prebuilt `.node` files committed under `native/*/prebuilds/` so a source checkout runs without a toolchain. The release workflow rebuilds them on each platform and publishes the rebuilt ones. `npm run build:native:<platform>` needs that platform's toolchain (on Windows, MSVC with the Windows SDK) and overwrites the committed file; do not commit the result unless asked.
- In `src/latex.ts`, `pi` is the Greek letter π, not the old product name. Leave it out of any rename.
