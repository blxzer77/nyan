---
name: nyan-checks
description: Choose the smallest set of checks and tests that covers a change in the Nyan repository, and report the evidence. Use before committing, before saying checks pass, or when unsure which tests a change needs.
---

# Choosing checks for a Nyan change

Run the narrowest evidence that would fail if the change were wrong. Do not repeat a check that already passed on the same diff.

## 1. See what changed

```bash
git status --short --branch
git diff --stat
```

Read the changed files in full, find the real entry point, and list every package that consumes the change.

## 2. Pick checks by path

| Changed paths | Run |
|---|---|
| Only Markdown or `.agents/` | Nothing required. Check that links and paths you wrote resolve. |
| Any `.ts`, `.mjs`, `package.json`, `tsconfig*.json`, `biome.json`, `docs/architecture/layers.json` | `npm run check` from the repo root (full output). It does not run tests. |
| Source in a vitest package | The test files that cover the changed module, from the package directory: `npx vitest --run test/<file>.test.ts` |
| `packages/tui/src` | `node --test test/<file>.test.ts` from `packages/tui` |
| `packages/durable/src` document cache or retention | The covering vitest files twice: normally and with `NYAN_DURABLE_DOCUMENT_RETENTION_MS=0` in the environment |
| A contract used by several packages (`@ny4n/ai/contracts`, types in `agent`, `protocol`) | The covering tests in each consuming package |
| `package.json` dependencies or `package-lock.json` | `npm run check`, which includes the install-lock check. If `packages/coding-agent` dependencies changed, run `npm run install-lock:coding-agent` first. |
| `packages/ai/scripts/generate-models.ts` | `npm run generate:models` (network), then `npm run check` |
| Schema sources in `packages/coding-agent` | `npm run generate:schemas` in `packages/coding-agent`, then `test/config-schemas.test.ts` |
| `scripts/*.mjs` | `npm run test:scripts` |
| Build or packaging (`exports`, `files`, bundle script) | `npm run build:offline`, run `node packages/coding-agent/dist/bundle/cli.js --version`, and `npm run release:dry` |
| `.github/workflows/` | Parse the YAML. A workflow proves itself only on GitHub; a manual run of `release.yml` is a dry run by default. |
| Sessions, providers, tools, subprocesses, persistence | Tests that go through the real entry point (CLI, session, extension loading) and cover cancellation, restart, duplicate requests, and unknown outcomes |

If `npm run check` reports model ids as not assignable to `never`, the model data is not hydrated: run `npm run hydrate:model-data` first (needs network). This is an environment problem, not a failure caused by the change.

## 3. Never

- Never run a whole package suite or `npm test` with provider credentials in the environment. Provider e2e tests switch on when a variable such as `ANTHROPIC_API_KEY` is set, and they spend real tokens.
- Never run `npm run build` or the full `npm test` unless the user asks. CI runs both on every push to `main`.
- Never narrow a test or skip it to make a change pass. Skip only for a platform that cannot run the test, with the reason in the skip.

## 4. Report

State exactly which commands ran and their result: passed, skipped, failed, and what could not be verified. Do not claim a check passed if it was not run. A test that failed and then passed on a rerun is reported as such, with the reruns.
