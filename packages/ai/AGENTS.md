# packages/ai

Unified LLM API: provider implementations, model types, and the generated model catalog.

- Never edit `src/models.generated.ts` by hand. Change `scripts/generate-models.ts`, then regenerate with `npm run generate-models` from this package (or `npm run generate:models` from the repo root). Commit the regenerated file even when it also picks up unrelated model metadata changes.
- Model data under `src/providers/data/` is gitignored. In a fresh checkout, `tsc` and tests fail until it is fetched with `npm run hydrate:model-data` from the repo root, which needs network access to models.dev.
- `src/models.generated.ts` may always be staged alongside your own files.
- Adding a provider: follow [add-llm-provider](../../.agents/skills/add-llm-provider/SKILL.md).
