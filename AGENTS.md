# AGENTS.md

Nyan is a TypeScript npm-workspaces monorepo for an LLM agent harness: a model API, an agent loop, the `nyan` terminal coding agent, a durable session runtime, and supporting libraries. It is published to npm under `@ny4n/*`. It was forked from Pi (`earendil-works/pi`) at v1.1.0; Pi is a read-only source of code, not a dependency and not a compatibility target.

## Hard rules

- Never commit, push, tag, publish, or open a PR unless the user asks. A pushed `nyan-v*` tag publishes to npm, and a published version cannot be replaced.
- Always ask before removing functionality or code that appears intentional.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, or `git commit --no-verify`. Other sessions may share this worktree. Never force-push.
- Treat npm dependency and lockfile changes as reviewed code. Direct external dependencies use exact versions; `npm run check` enforces it.
- Never run lifecycle scripts unless the user asks. Install with `npm ci --ignore-scripts`, or `npm install --ignore-scripts`.
- Before updating `undici`, read its release notes for the target version and evaluate the impact.
- After dependency metadata changes, refresh the lockfile with `npm install --package-lock-only --ignore-scripts`. The pre-commit hook (`.husky/pre-commit`) blocks a staged `package-lock.json` unless `NYAN_ALLOW_LOCKFILE_CHANGE=1`; set it only when the user wants the lockfile committed.
- When `packages/coding-agent` dependencies change, regenerate `packages/coding-agent/install-lock/` with `npm run install-lock:coding-agent`. A new dependency with install scripts needs review and an entry in `allowedInstallScriptPackages` in `scripts/generate-coding-agent-install-lock.mjs`.
- Never write credentials into the repository, fixtures, or logs. Tests against real providers need credentials and scope from the user.

## Product identity

- The executable is `nyan`, packages are `@ny4n/*`, environment variables are `NYAN_*`, the user directory is `~/.nyan`, the project directory is `.nyan/`, and persisted and protocol identifiers are `nyan.*`. `packages/coding-agent/src/identity.ts` owns these names.
- Nyan does not read `~/.pi`, `.pi/`, or `PI_*`, and has no `pi` alias. The one concession to Pi is at extension load time (`src/core/extensions/pi-compat.ts`): the `@earendil-works/pi-*` and `@mariozechner/pi-*` imports map to the `@ny4n/*` host modules, and a package's `pi` manifest field is read when it has no `nyan` field. Do not widen that into Pi directories, variables, command names, or session formats; see [Pi extension compatibility](.agents/notes/implemented/architecture/2026-10-13-pi-extension-compatibility.md).
- Nyan has no default hosted service. The installer, share viewer, model catalog overlay, and MCP client metadata stay off until the operator sets `NYAN_INSTALLER_API_BASE`, `NYAN_SHARE_VIEWER_URL`, `NYAN_CATALOG_BASE_URL`, or `NYAN_MCP_CLIENT_METADATA_URL`. The version check asks the npm registry, and `nyan update` in a standalone binary downloads from this repository's GitHub releases (`NYAN_RELEASE_BASE_URL` changes the source). Never add a default URL for a service Nyan does not run; see [no default hosted services](.agents/notes/implemented/architecture/2026-10-11-no-default-hosted-services.md).
- Released versions have users: session files, settings, `auth.json`, durable storage, CLI flags, `NYAN_*` variables, and package exports. Tell the user before a change breaks one of them.
- `src/experimental/` (excluded from the build), examples, and extensions are candidate code. Do not describe them as Nyan features until a Nyan entry point, its persistence, and its recovery are verified.

## Repository layout

Before editing a package that has its own AGENTS.md, read it. Nyan loads context files only from the working directory and its ancestors, so a session started at the repo root does not load package files automatically.

```
packages/        layer             package
  chord/         foundation        Composition runtime: services, replicated state, RPC, plugins
  telemetry/     foundation        Telemetry contracts and typed schemas
  tui/           capabilities      Terminal UI library with differential rendering  -> packages/tui/AGENTS.md
  mcp/           capabilities      Model Context Protocol client
  codemode/      capabilities      Sandboxed JavaScript whose only capability is calling injected tools
  ai/            model             Unified LLM API, providers, model catalog         -> packages/ai/AGENTS.md
  agent/         agent-core        Agent loop and state (@ny4n/agent-core)
  durable/       durable-runtime   Durable conversation, task and document runtime   -> packages/durable/AGENTS.md
  protocol/      transport         Transport-neutral CBOR protocol for remote sessions
  client/        transport         Client for remote sessions
  server/        transport         Server for remote sessions (experimental)
  coding-agent/  product-shell     The nyan CLI and SDK: tools, sessions, TUI, RPC   -> packages/coding-agent/AGENTS.md
scripts/         Repository checks, generators, version and publish scripts
docs/            Navigation and architecture: current-state.md, layers.json
.agents/         Notes (decisions), skills (workflows), upstream (sync records)
.github/         CI, native prebuilds, release
```

## Dependency direction

Dependencies point toward the more stable side. [`docs/architecture/layers.json`](docs/architecture/layers.json) is the policy and `npm run check:architecture` (part of `npm run check`) enforces it:

- A package may depend only on the layers in its layer's `mayDependOn`. Same-layer edges must be listed in `internal`. No edge may target a package less stable than its source (instability `I = Ce / (Ca + Ce)`, measured from source imports).
- Cross-package imports must use a subpath the target declares in `exports`, and every imported workspace package must be declared in the manifest.
- `agent` reaches the model layer only through `@ny4n/ai/contracts`; `durable` only through `@ny4n/ai/contracts` and `@ny4n/ai/utils/*`.
- `ai`, `durable`, and `coding-agent` have module layers inside the package. The headless `coding-agent` `core` must not import `modes`, `cli`, or terminal presentation.
- Static runtime import cycles are forbidden; `cycles.known` is empty.

When a new dependency, package, or module needs a rule change, edit `layers.json` first and record the reason there. Never loosen a rule only to make the check pass.

## Commands

- After code changes (not docs): `npm run check`, full output, no tail. It runs biome, `tsc --noEmit`, the dependency, import, architecture, entry-graph and install-lock checks, and a browser bundle smoke test. It does not run tests. Fix all errors, warnings, and infos.
- In a fresh checkout, run `npm run hydrate:model-data` first: `packages/ai/src/providers/data/` is gitignored and is fetched from models.dev. Without it `tsc` reports model ids as not assignable to `never`.
- Build with `npm run build:offline`. `npm run build` also regenerates the model catalog from the network.
- Run the CLI from the sources, without a build: `node scripts/nyan-source.mjs [args]`. It works from any directory and keeps the caller's working directory.
- One vitest file, from the package directory: `npx vitest --run test/specific.test.ts`. `packages/tui` uses `node:test`: `node --test test/specific.test.ts`. Root script tests: `npm run test:scripts`.
- Bun: after `npm run build`, `npm run test:bun` runs every workspace package's suite under Bun (`scripts/test-bun.mjs`; CI runs it as the `bun` job). A difference that appears only under Bun is fixed in the code, or in an assertion that had assumed Node; a suite is not dropped from that script to make it pass.
- Provider e2e tests run whenever a provider credential such as `ANTHROPIC_API_KEY` is set in the environment, and spend real tokens. Unset them before running a whole package suite.
- Choose the narrowest check that covers the change: follow [nyan-checks](.agents/skills/nyan-checks/SKILL.md).
- Never run `npm run build` or the full `npm test` unless the user asks. CI runs build, check, and the full suite on every push to `main`.
- If you create or modify a test file, run it and iterate until it passes.
- Write ad-hoc scripts to a temp file, run them, and remove them when done. Do not embed multi-line scripts in shell commands.

## Cross-platform

CI runs the full suite on Ubuntu and builds and checks on Windows; the full suite also passes locally on Windows.

- Build paths with `node:path` and compare them with `sep` or normalized forms, not literal `/`.
- Skip a test only when the platform cannot run it, such as Unix sockets or POSIX permission bits, with `it.skipIf(process.platform === "win32")` and a reason.
- npm scripts must not use POSIX shell syntax such as `VAR=value command`. Use a small Node launcher; see `packages/durable/scripts/test-without-document-retention.mjs`.
- Pass `./` or absolute paths to npm commands. npm on Linux reads `packages/x` as the GitHub repository `packages/x`.

## Conventions

- No `any` unless narrowing is infeasible. No unchecked assertions from `unknown`.
- Top-level static imports only. `import()` is reserved for deliberate lazy loading: provider adapters in `*.lazy.ts`, Node built-ins in `packages/ai` code that must also load in a browser, optional native modules, and extension loading. No `import("pkg").Type` type imports.
- Use only erasable TypeScript syntax (`erasableSyntaxOnly`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs that need JS emit. Node runs these files in strip-only mode. Use explicit fields with constructor assignments.
- Check `node_modules` for external API types; don't guess.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Inline single-line helpers that have only one call site.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Search snippets are not enough.
- Cross-package IDs, session events, tool results, and errors carry a stable discriminant. Dispatch on it, never on message text, and make the default branch of a closed union report the unhandled case.
- Report missing configuration at the earliest point it is known. Never silently fall back to a different product behavior.
- Add behavior at extension points. Do not put product logic into the agent loop unless a note records the ownership change.
- Comments explain ownership, timing, failure guarantees, or safety that the code does not show. Do not restate the code.
- Record a lasting design decision in `.agents/notes/` when code, tests, and docs cannot explain why. See the [notes README](.agents/notes/README.md).

## Runtime and recovery

For a change that touches sessions, providers, tools, subprocesses, concurrency, or persistence, state who owns the state, what admission, cancellation, idempotency, and restart recovery look like, and how an unknown outcome is surfaced. Catching an exception is not recovery: only the owner of the state can prove that continuing is safe. Everything a model request sees must be rebuildable from the session or another named persisted fact. See [nyan-error-handling](.agents/skills/nyan-error-handling/SKILL.md).

## Upstream

- `upstream` is `https://github.com/earendil-works/pi.git` and is read-only. The fork starts at Pi v1.1.0 (`abe508e1b`) and is synced to `cdaf6c227`; each sync has a record in `.agents/upstream/`.
- Bring in upstream changes only with [nyan-upstream-sync](.agents/skills/nyan-upstream-sync/SKILL.md): a rename-aware merge, never a file overwrite.
- Do not cite or follow upstream issues, pull requests, workflows, or release processes. The plain `vX.Y.Z` tags in this repository are Pi's releases.

## Release

Run `npm run version:set -- X.Y.Z` (it also dates the changelog), commit, then push the tag `nyan-vX.Y.Z`. `.github/workflows/release.yml` builds, checks, and tests on Ubuntu, builds the `packages/tui` native modules on each platform, publishes the 12 packages in dependency order with provenance (`scripts/publish-packages.mjs`, already-published versions are skipped, a pre-release version goes to the `next` dist-tag), and creates the GitHub release with generated notes and the binary archives. Before publishing it compiles the standalone Bun executables (`scripts/build-binaries.mjs`, six platforms) and smoke-tests four of them on matching runners, including `nyan update` from a local mock release (`scripts/smoke-test-binary-update.mjs`). The tag must equal the package version. `npm run release:dry` packs locally; a manual run of the workflow defaults to a dry run. Publishing needs the `NPM_TOKEN` repository secret.

## Git

- `main` is the only long-lived branch. Use short-lived feature branches; do not create `develop`.
- Only commit files you changed in this session. Stage explicit paths and run `git status` first.
- Message format: `{feat,fix,docs,refactor,test,chore}(<package>): <message>`, where `<package>` is a directory name under `packages/`. Omit the scope for repository-wide changes.
- When a commit closes a Nyan issue, include `fixes #<number>`. Repeat the keyword per issue (`closes #1, closes #2`).
- On rebase conflicts, resolve only files you modified. If a conflict is in a file you did not modify, abort and ask.

## Documentation

- Docs state current, verified behavior. Plans live in `.agents/notes/proposed/` until they ship. [`docs/README.md`](docs/README.md) lists which document owns which fact.
- User-facing docs are in `packages/coding-agent/docs/`; update the affected page with any user-visible change. The cross-package picture is [`docs/architecture/current-state.md`](docs/architecture/current-state.md).
- GitHub generates the release notes from the pull requests merged since the previous release; commits pushed directly to `main` do not appear in them.

## Changelog

`packages/coding-agent/CHANGELOG.md` is the only changelog. Nyan shows it in `/changelog` and shows the new sections once after an update, so it describes what a `nyan` user notices, not internal changes.

- Add entries under `## [Unreleased]` in `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, or `### Removed`. Read the whole section first and append to existing subsections.
- Released sections are immutable. `npm run version:set` moves the Unreleased entries under the new version and refuses a release without entries; the release workflow refuses a tag whose version has no section.
- Links to repository files may be relative to `packages/coding-agent/`; Nyan rewrites them to the release tag. Link Nyan issues as `([#123](https://github.com/blxzer77/nyan/issues/123))`.

## Conversational style

- Keep answers short and concise. Technical prose only, be direct.
- No emojis in commits, issues, PR comments, or code. No filler text.
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries or unexplained lists of changes.
- When the user asks a question, answer it before making edits or running implementation commands.
- When responding to feedback or an analysis, say whether you agree or disagree before saying what you changed.
- Report what you ran and what it showed: passed, skipped, failed, and what remains unverified. Existing source is not proof that an entry point works.

## Editing these instructions

`CLAUDE.md` is a symlink to this file; edit `AGENTS.md`. Keep each rule one self-contained sentence or short paragraph. Put package-specific rules in that package's AGENTS.md and rationale in `.agents/notes/`, and link them from here. Skills live in `.agents/skills/`; [`.agents/README.md`](.agents/README.md) lists them.

## User override

If the user's instructions conflict with a rule in this file, ask for explicit confirmation before overriding it.
