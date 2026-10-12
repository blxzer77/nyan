---
name: add-llm-provider
description: Checklist for adding a new LLM provider to packages/ai and wiring it into the nyan CLI. Covers the provider definition, model generation, credentials, an optional new API adapter, tests, coding-agent wiring, and docs.
---

# Adding an LLM provider (packages/ai)

A provider is a small definition (id, name, base URL, auth, models, API adapter) on top of a generated model catalog. Most providers reuse an existing API adapter such as `openai-completions`. Work through these steps in order; `src/providers/deepseek.ts` is a short complete example.

## 1. Provider id and credentials

- Add the id to the `KnownProvider` union in `src/types.ts`.
- Map the id to its API-key variable in `src/env-api-keys.ts`. Non-standard credentials go in the provider's `auth` (see `src/providers/amazon-bedrock.ts`); a login flow goes under `src/auth/oauth/`.

## 2. Models

- In `scripts/generate-models.ts`, produce the provider's `Model` objects: map its models.dev entries (see the `data["groq"]` block), or write the list by hand when models.dev lacks the provider (see `deepseekModels`). Set `api`, `baseUrl`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, and `compat` where the endpoint deviates.
- Run `npm run generate:models` from the repo root (network). It writes `src/providers/<id>.models.ts`, `src/providers/data/<id>.json`, and `src/models.generated.ts`. Never edit those by hand. Commit the generated `.ts` files; `data/` is gitignored.

## 3. Provider definition

- Create `src/providers/<id>.ts` exporting `<id>Provider()` built with `createProvider({ id, name, baseUrl, auth, models, api })`. `name` is the display name the CLI shows, including in `/login`.
- Use the lazy adapter factory (`openAICompletionsApi()` from `../api/openai-completions.lazy.ts` and similar), never the adapter module itself, so the adapter loads on first use.
- Add the provider to the list in `src/providers/all.ts`.
- No export or layer change is needed: the `./providers/*` subpath export and the `providers` module layer already cover the new file.

## 4. A new API adapter (only when no existing adapter fits)

- Add the API id to `KnownApi` in `src/types.ts` and its options interface (extending `StreamOptions`) to `ApiOptionsMap` in `src/api-options.ts`.
- Implement `src/api/<api>.ts`: request building, message and tool conversion, and response parsing that emits the standard stream events. Adapters may import contracts, auth contracts, and infra only; never `models.ts` or `providers/` (`npm run check:architecture` enforces this).
- Add `src/api/<api>.lazy.ts` that wraps it with `lazyApi(() => import("./<api>.ts"))`.

## 5. Tests (`packages/ai/test/`)

Provider tests run only when the provider's credential variable is set. Without it they skip, so a passing run with no key proves nothing about the provider; ask the user for a key and a budget before a live run.

- Add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API such as `openai-completions`.
- Add it to the wider matrix where it applies: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider and model pair, one per model family if the provider serves several (for example GPT and Claude).
- Request-shape logic (compat flags, headers, payload fields) gets a unit test that needs no network.

## 6. Coding agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: add the default model id to `defaultModelPerProvider`.
- `src/cli/args.ts`: document the credential variable in the help text.
- `docs/providers.md`: setup instructions, the variable, and the `auth.json` key.

## 7. Documentation (`packages/ai/README.md`)

Add the provider to the supported-providers list, the environment-variable table, and the model table, with its options and auth. Add an `### Added` entry under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.

## 8. Checks

`npm run check`, the provider's unit tests, `test/generate-models-strict.test.ts`, and, with a key from the user, the provider rows of `stream.test.ts`.
