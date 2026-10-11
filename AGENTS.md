# AGENTS.md

nyan is a TypeScript npm-workspaces monorepo for an LLM agent harness: a model API, an agent loop, a terminal coding agent (the `pi` CLI), a durable session runtime, and supporting libraries. It started as a fork of Pi (earendil-works/pi) and does not track upstream. Do not cite or follow upstream issues, workflows, or release processes.

## Hard rules

- Never commit, push, or open a PR unless the user asks.
- Always ask before removing functionality or code that appears intentional.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, or `git commit --no-verify`. Other sessions may share this worktree.
- Treat npm dependency and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Never run lifecycle scripts unless the user asks. Install with `npm install --ignore-scripts`, or `npm ci --ignore-scripts` for a clean install.
- Before updating `undici`, read its release notes for the target version and evaluate the impact.
- After dependency metadata changes, refresh the lockfile with `npm install --package-lock-only --ignore-scripts`. Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`; set it only when the user wants the lockfile committed.
- If `packages/coding-agent/install-lock/` needs regeneration, run `node scripts/generate-coding-agent-install-lock.mjs`. New deps with lifecycle scripts need review and an explicit allowlist entry in that script.

## Repository layout

Before editing a package that has its own AGENTS.md, read it. Pi loads context files only from the working directory and its ancestors, so a session started at the repo root does not load package files automatically.

```
packages/
  ai/            Unified LLM API, providers, model catalog       -> packages/ai/AGENTS.md
  agent/         Agent loop, transport abstraction, state
  coding-agent/  pi CLI: tools, sessions, interactive mode       -> packages/coding-agent/AGENTS.md
  tui/           Terminal UI library with differential rendering -> packages/tui/AGENTS.md
  durable/       Durable conversation, task, and document runtime -> packages/durable/AGENTS.md
  chord/         Composition runtime: services, replicated state, RPC, plugins
  codemode/      Sandboxed JavaScript whose only capability is calling injected tools
  mcp/           Model Context Protocol client
  protocol/      Transport-neutral CBOR protocol for remote sessions
  client/        Client for remote sessions over protocol/
  server/        Server for remote sessions (experimental)
  env/           Remote execution environments for durable: SSH-deployed daemon and client
  telemetry/     Telemetry contracts and typed schemas
  evals/         Evaluation harness
scripts/         Repository checks, generators, release tooling
.agents/skills/  On-demand workflows, one SKILL.md per directory
.agents/notes/   Design decisions: why, and what was rejected
.pi/prompts/     pi slash-command templates
.pi/extensions/  Repository-local pi extensions
```

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos. It does not run tests.
- Non-e2e tests: `./test.sh` from the repo root. Never run the full vitest suite directly: e2e tests activate when provider endpoint or auth env vars are present.
- One vitest file, from the package root: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`.
- Choose the narrowest check that covers the change: follow [nyan-checks](.agents/skills/nyan-checks/SKILL.md).
- Never run `npm run build` or `npm test` unless the user asks.
- If you create or modify a test file, run it and iterate until it passes.
- When adding a regression test for a GitHub issue, put the issue number in a comment next to the test.
- Write ad-hoc scripts to a temp file, run them, and remove them when done. Do not embed multi-line scripts in `bash` commands.

## Conventions

- No `any` unless narrowing is infeasible.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Use only erasable TypeScript syntax in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs that need JS emit. Node runs these files in strip-only mode. Use explicit fields with constructor assignments.
- Check `node_modules` for external API types; don't guess.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Inline single-line helpers that have only one call site.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Search snippets are not enough.
- Do not preserve backward compatibility unless the user asks.
- Record a lasting design decision in `.agents/notes/` when code, tests, and docs cannot explain why. See the [notes README](.agents/notes/README.md).

## Conversational style

- Keep answers short and concise. Technical prose only, be direct.
- No emojis in commits, issues, PR comments, or code. No filler text.
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries or unexplained lists of changes.
- When the user asks a question, answer it before making edits or running implementation commands.
- When responding to feedback or an analysis, say whether you agree or disagree before saying what you changed.

## Git

- Only commit files you changed in this session. Stage explicit paths and run `git status` first.
- Message format: `{feat,fix,docs,refactor,test,chore}(<package>): <message>`, where `<package>` is a directory name under `packages/`. Omit the scope for repository-wide changes.
- When a commit closes an issue, include `fixes #<number>`. Repeat the keyword per issue (`closes #1, closes #2`).
- On rebase conflicts, resolve only files you modified. If a conflict is in a file you did not modify, abort and ask. Never force push.

## Changelog

Each package keeps `packages/*/CHANGELOG.md`. New entries go under `## [Unreleased]` in `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, or `### Removed`. Read the whole section first and append to existing subsections. Released version sections are immutable. Add entries only on `main` or in a pull request branch. Link issues as `([#123](https://github.com/blxzer77/nyan/issues/123))`.

## Editing these instructions

`CLAUDE.md` is a symlink to this file; edit `AGENTS.md`. Keep each rule one self-contained sentence or short paragraph. Put package-specific rules in that package's AGENTS.md and rationale in `.agents/notes/`, and link them from here.

## User override

If the user's instructions conflict with a rule in this file, ask for explicit confirmation before overriding it.
