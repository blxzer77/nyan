# packages/coding-agent

`@ny4n/coding-agent`: the `nyan` CLI and SDK. Tools, sessions, interactive mode, RPC, and resource loading.

- Resolve package assets through the helpers in `src/config.ts` (`getPackageDir()`, `getThemesDir()`, `getDocsPath()`, ...). Do not use `__dirname` directly: the helpers handle source checkouts and npm installations.
- Take product names from `src/config.ts` (`APP_NAME`, `CONFIG_DIR_NAME`, `ENV_AGENT_DIR`), which reads `src/identity.ts`. Do not hardcode `nyan`, `.nyan`, or `NYAN_` where these constants apply.
- Never hardcode key checks such as `matchesKey(keyData, "ctrl+x")`. Add the default to `APP_KEYBINDINGS` in `src/core/keybindings.ts` so it stays configurable.
- Module layers: `base -> ui -> core -> extensions -> modes -> cli -> entry` (`docs/architecture/layers.json`). `core` is headless and must not import `modes`, `cli`, or terminal presentation; presentation shared with tools lives in `src/ui/`.
- `schemas/*.schema.json` are generated. Change the source schema (`src/core/settings-schema.ts`, `src/core/keybindings-schema.ts`, `src/core/model-config.ts`, `src/ui/theme/theme-schema.ts`), then run `npm run generate:schemas` from this package. `test/config-schemas.test.ts` fails when the committed files drift.
- `src/experimental/` is excluded from the build and from the published package. It is candidate code; see the root AGENTS.md.
- Tests under `test/suite/` use `test/suite/harness.ts` and the faux provider. No real provider APIs, keys, or paid tokens.
- Run the CLI from source with `node packages/coding-agent/src/cli.ts` (Node strips the types). To check interactive behavior in a real terminal, follow [interactive-testing](../../.agents/skills/interactive-testing/SKILL.md).
- User-facing docs live in `docs/`. Update the affected page with any user-visible change.
