# packages/coding-agent

The `pi` CLI: tools, sessions, interactive mode, RPC, and resource loading.

- Resolve package assets through the helpers in `src/config.ts` (`getPackageDir()`, `getThemesDir()`, `getDocsPath()`, ...). Do not use `__dirname` directly: the helpers handle source checkouts, npm installations, and standalone binaries.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`. Add the default to `APP_KEYBINDINGS` in `src/core/keybindings.ts` so it stays configurable.
- Tests under `test/suite/` use `test/suite/harness.ts` and the faux provider. No real provider APIs, keys, or paid tokens.
- To check interactive behavior in a real terminal, follow [interactive-testing](../../.agents/skills/interactive-testing/SKILL.md).
- User-facing docs live in `docs/`. Update the affected page with any user-visible change.
