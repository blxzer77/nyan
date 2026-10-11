---
name: nyan-checks
description: Choose the smallest set of checks and tests that covers a change in the nyan repository. Use before committing, before saying checks pass, or when unsure which tests a change needs.
---

# Choosing checks for a nyan change

Run the narrowest evidence that would fail if the change were wrong. Do not repeat a check that already passed on the same diff.

## 1. See what changed

```bash
git status --short
git diff --stat
```

## 2. Pick checks by path

| Changed paths | Run |
|---|---|
| Only Markdown, `.agents/`, `.pi/prompts/` | Nothing required. Check that links and paths you wrote resolve. |
| Any `.ts`, `.mjs`, `package.json`, `tsconfig*.json`, `biome.json` | `npm run check` from the repo root (full output). It runs biome, dependency and import checks, and `tsc --noEmit`. It does not run tests. |
| Source in a vitest package | The test files that cover the changed module, from the package root: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts` |
| `packages/tui/src` | `node --test test/<file>.test.ts` from `packages/tui` |
| `packages/durable/src` document cache or retention | The covering vitest files twice: normally and with `PI_DURABLE_DOCUMENT_RETENTION_MS=0` |
| A shared contract used by several packages (types in `ai` or `agent`, `protocol`) | The covering tests in each consuming package, or `./test.sh` if consumers are many |
| `package.json` dependencies or `package-lock.json` | `npm run check`; if `packages/coding-agent` deps changed, `node scripts/generate-coding-agent-install-lock.mjs --check` |
| `packages/ai/scripts/generate-models.ts` | Regenerate with `npm run generate:models`, then `npm run check` |

If `npm run check` reports model ids as not assignable to `never`, the model data is not hydrated: run `npm run hydrate:model-data` first (needs network). This is an environment problem, not a failure caused by the change.

`./test.sh` runs every non-e2e test in an isolated environment. Use it when the change is repository-wide or the user asks; otherwise prefer focused files.

## 3. Never

- Never run the full vitest suite directly: e2e tests activate when provider env vars are present and can spend real tokens.
- Never run `npm run build` or `npm test` unless the user asks.

## 4. Report

State exactly which commands ran and their result. Do not claim a check passed if it was not run.
