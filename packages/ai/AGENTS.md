# packages/ai

`@ny4n/ai`: the unified LLM API. Provider implementations, model types, auth, and the generated model catalog.

- Never edit `src/models.generated.ts` or `src/providers/*.models.ts` by hand. Change `scripts/generate-models.ts`, then regenerate with `npm run generate:models` from the repo root (needs network). Commit the regenerated files even when they also pick up unrelated model metadata changes.
- Model data under `src/providers/data/` is gitignored. In a fresh checkout, `tsc` and tests fail until it is fetched with `npm run hydrate:model-data` from the repo root, which needs network access to models.dev.
- The package has module layers in `docs/architecture/layers.json`: contracts (`types.ts`, `utils/`, `contracts/`, `schemas/`) import nothing else from the package, `api/` adapters never import the `models.ts` registry or `providers/`, and every new file must fall inside a layer.
- `@ny4n/ai/contracts` is the provider-neutral entry that `agent` and `durable` use. Anything added there becomes part of their dependency surface; keep it to shared types and the `ModelRuntime` interface.
- The package must load in a browser bundle (`npm run check:browser-smoke`, part of `npm run check`). Load Node built-ins lazily, as `src/env-api-keys.ts` does.
- Provider e2e tests run when the provider's credential variable is set and spend real tokens. Unset those variables unless the user asked for a live test.
- Adding a provider: follow [add-llm-provider](../../.agents/skills/add-llm-provider/SKILL.md).
