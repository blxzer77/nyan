# Changelog

User-visible changes to `@ny4n/coding-agent`, the `nyan` CLI. `/changelog` shows this file, and Nyan shows the new sections once after an update. Releases are tagged `nyan-vX.Y.Z`.

## [Unreleased]

### Added

- Built-in `CLIProxyAPI` provider (`builtin:cliproxyapi`) supporting `/login CLIProxyAPI` and CLI `nyan login cliproxyapi` / `nyan auth login --provider cliproxyapi`. It discovers models from the proxy, provides declarative model limits and thinking level overrides, priority Fast mode (`/fast`), request pause gate (`/pause`, `/continue`), real token throughput reporting, and `/cpa-*` management commands. Existing `cliproxyapi.json`, overrides, cache, and auth credentials from `~/.nyan/agent` are loaded automatically.
- CLIProxyAPI telemetry: one record per request with time to first token, generation window, tokens per second, total time (excluding `/pause`), HTTP status, tokens, estimated cost, retries, and trace id, published on the `cliproxyapi:request` extension event. The 5 hour and weekly plan quota of the Codex and Claude accounts behind the proxy is read from the proxy's management API (`CLIPROXYAPI_MANAGEMENT_KEY`) or from `x-codex-*` and `anthropic-ratelimit-unified-*` response headers when the proxy runs with `passthrough-headers: true`, shown by the new `/cpa-quota`, and published on `cliproxyapi:quota`. Nyan stops sending a management key the proxy rejected and waits out the proxy's 30 minute ban. See [Providers](docs/providers.md#cliproxyapi).
- CLI login commands `nyan auth login [--provider <provider>] [--method <oauth|api_key>]` and `nyan login [provider]` to authenticate with providers directly from the terminal without entering interactive mode.
- An extension login prompt can require an answer with `onPrompt({ allowEmpty: false })`. The prompt is asked again instead of returning an empty string, and both `nyan login` and the interactive dialog honor it. `allowEmpty` defaults to true, and the manual authorization-code prompt requires an answer because an empty code can never be exchanged.
- In the standalone executable (Bun), Nyan prints a warning once at start-up when `NODE_OPTIONS` contains `--use-system-ca`: Bun and compiled Bun binaries do not read `NODE_OPTIONS`, so the operating system certificate store is not used. The warning names `NODE_USE_SYSTEM_CA=1`, `BUN_OPTIONS=--use-system-ca` and `NODE_EXTRA_CA_CERTS` as the ways that work. See [Environment variables](docs/environment-variables.md).

### Changed

- The default session path now reads these resource flags: `--skill`, `--no-skills`, `--no-context-files`, `--system-prompt`, `--append-system-prompt`, `--no-extensions`, `--no-mcp`, `--no-themes`, `--no-prompt-templates`, `--approve`, and `--no-approve`. It loads skills and context files from the same places as the legacy path, puts `--system-prompt` and `--append-system-prompt` into the request, applies `--use-theme` in the interactive mode, reports invalid settings files, and registers the providers of extensions, so `--provider cliproxyapi` resolves. Commands and events are not connected on this path yet, so the CLIProxyAPI commands and status labels are not available here. Extension tools are connected for the `direct` and `model-only` exposures (see the next entry). `--extension`, `--theme`, and `--prompt-template` still use the legacy path until extension tools and those resources are connected on the durable path. `--session`, `--session-id`, `--resume`, `--fork`, `--session-dir`, `--no-session`, `--name`, `--tools`, `--models`, and `@file` also still use the legacy path.
- The durable path now offers the tools that extensions register to the model, with their `exposure`: `direct` and `model-only` tools are offered, and `tool_call` and `tool_result` handlers run on them. MCP servers configured with `"exposure": "direct"` in `mcp.json` connect before the first prompt. MCP tools with the default `codemode` exposure reach the model through codemode, and `deferred` tools through tool search, as the entry below describes.
- The default path now runs an extension's `context` and `agent_settled` handlers, so CLIProxyAPI's per-run usage summary and its quota poll happen there after every run, including runs that ended without an answer.
- Codemode and tool search run on the default path while they are active, as on the legacy path: MCP servers whose tools are reachable only through codemode activate it, and a script calls those tools. Scripts keep the limit of two running at once. The `models` globals and `codemode.mode` `only` are not on this path yet.
- The durable path now runs the request hooks that extensions register and their session start and shutdown handlers. CLIProxyAPI's Fast tier and its persisted pause setting apply to requests made there. Commands and UI are still not connected on this path.
- The default interactive and text print session paths now use the durable Harness and SQLite under `~/.nyan/agent/sessions-durable/`; `--continue` resumes the newest durable session for the current directory. Eligible `--mode json` and `--mode rpc` invocations now use durable storage and recovery. Legacy JSONL sessions selected through compatibility flags are opened read-only, so their source files are never migrated or appended to.
- `nyan login` and `nyan auth login` ask their questions on a terminal only. With piped or absent stdin they stop with instructions instead of waiting for input that cannot arrive.
- The `@ny4n/ai` development CLI (`npx @ny4n/ai login`) trims a typed answer, asks again when a choice is not one of the offered numbers instead of exiting with `Invalid selection`, and refuses an empty answer to a prompt that requires one.
- A request that fails certificate or host-name verification (an untrusted or self-signed certificate, an expired certificate, a certificate for another host name) is no longer retried, on Node and Bun alike. Node used to retry these failures, which repeated the same request with the same certificate. The error now names the certificate code in its message, for example `fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)`. To trust a private certificate authority, set `NODE_EXTRA_CA_CERTS` as before.

### Fixed

- In the standalone executable on Windows, the process that closed a session no longer keeps the session database's `-shm` and `-wal` files locked, so the session directory can be deleted without leaving Nyan. Under Bun the durable session store now uses Bun's built-in SQLite (`bun:sqlite`) in place of `node:sqlite`; the file format is the same, and Node keeps `node:sqlite`.
- In the standalone executable, changing the HTTP idle timeout (`httpIdleTimeoutMs`, or the setting in `/settings`) while Nyan runs now also applies to provider clients that were created before the change. Before, such a client kept the timeout it was created with until Nyan restarted.
- A user ! bash command whose output is truncated returned the path of its full-output file before the file was completely written, so reading it at once could show a partial file. The path is now returned after the file is closed; if the file cannot be written, the output says so and the result has no path.
- `nyan auth check`, `nyan auth print-api-key`, `nyan auth print-bearer-token`, and `nyan login` reported every unexpected failure as `Failed to resolve credential`, hiding the cause. They now name the phase that failed and the error behind it.
- `nyan login` and `nyan auth login` substituted a prompt's placeholder for an empty answer. At CLIProxyAPI's API-key prompt this made an empty answer look like a real key, so the provider skipped its own empty-key check and sent the literal `sk-...` to the proxy, which failed with a misleading validation error instead of saying the key was empty. A placeholder is a hint, as it is in the interactive dialog, and an empty answer stays empty.
- `nyan login` and `nyan auth login` stopped with `Invalid selection` when a choice was not one of the offered numbers, and treated any answer other than `2` at the authentication-method prompt as OAuth. Both now re-ask.
- `nyan login` and `nyan auth login` announced `Successfully logged in` without checking that the credential works. They now verify it with the provider's own model listing, which authenticates with the credential just stored, and report a rejected credential as a failure with its reason. A listing that completes without the provider refusing the credential counts as verified; one that fails or is cancelled leaves the credential reported as stored and not verified.
- `nyan login` reported a provider whose model listing failed during the post-login credential synchronization as `Credential login committed for <provider>, but local synchronization failed`, naming neither the cause nor what to do. It now reports the provider's own error and says the credential is stored.
- The Xiaomi MiMo providers follow the rename of their models on models.dev (`mimo-v2.5-pro` to `mimo-v2.6-pro`). The built-in default model id and the tests that name it had gone stale, which left the provider without a usable default and the generated model catalogs unable to satisfy those ids.
- `nyan login cliproxyapi` verifies the key it just entered, not an environment key that would otherwise take precedence. A proxy that refuses the key fails the login, and the key stays stored to be corrected. A proxy that cannot be reached, or does not answer, leaves the key stored and reports it as not verified, instead of `Verified: 0 model(s) available`. Login warns when `CLIPROXYAPI_API_KEY`, the `apiKey` field of `cliproxyapi.json`, or `CLIPROXYAPI_BASE_URL` points the model list or requests somewhere other than what you entered. A key the proxy rejects at startup names the setting it came from. A failed verification says that the new login replaced the stored credential, which is not restored. `--method api_key` is refused with a pointer to the login that works.

## [1.3.0] - 2026-10-14

### Breaking Changes

- `before_agent_start` also runs for a run started by `nyan.sendMessage(..., { triggerTurn: true })`. `BeforeAgentStartEvent` is now a union on `messageType`: `"user"` carries `prompt` and `images`, `"custom"` carries the starting `message`. A handler that reads `event.prompt` or `event.images` must check `event.messageType` first, and a handler that adds context for a user prompt should return early for `"custom"`. The session also counts as busy while a run starts, so `ctx.isIdle()` is false during `before_agent_start`, and a message sent meanwhile goes into the starting run instead of starting a second one.
- `nyan mcp list --json` reports `"resources": true` for a server that offers resources, instead of the counts `resources` and `resourceTemplates`. Connecting no longer lists a server's resources, so a slow listing cannot keep its tools out of the first prompt. `/mcp` and `nyan mcp list` print `offers resources`. The resource tools still list and read resources on demand.

### Added

- Nyan reports its agent state to [Herdr](https://herdr.dev), a terminal workspace manager for coding agents, so a Nyan pane shows `working`, `blocked`, or `idle` in the Herdr sidebar, Herdr notifies you when Nyan finishes or needs input, and restarting the Herdr server reopens the pane in the same directory with the conversation restored. The integration is a built-in extension that acts only inside a Herdr pane. See [Run Nyan in Herdr](docs/herdr.md).
- The standalone executable archives and `SHA256SUMS` of a release carry a signed build provenance attestation. `gh attestation verify <archive> --repo blxzer77/nyan` shows that the file was built by the release workflow from a named commit. The executables are still not code-signed for macOS or Windows.
- Codemode tool declarations show input constraints such as `integer`, minimum and maximum, length, pattern, and `default` as `@` tags on property comments, so scripts see them without the tool repeating them in its description.
- Codemode rows show the time a script has been running while it runs and its total time when it finished, like bash rows.
- `describeNamespace()` and the `namespace` option of `searchTools()` in codemode scripts also match a namespace by its aliases. MCP namespaces answer to the server name, so `describeNamespace("docs")` finds `mcp__docs`.
- Tool definitions can declare `reachesTools`, for tools that reach other tools (such as `codemode` and `tool_search`). The MCP extension uses it to wait for the servers a call needs and to decide whether a replacement `codemode` or `tool_search` tool can reach MCP tools.

### Changed

- Print mode writes a warning to stderr and exits with status 1 when the final response stopped at the model's output token limit. The partial text is still written to stdout.
- Codemode declarations of MCP tools spell out the result type (`content`, `structuredContent`, `isError`) instead of referring to `CallToolResult<T>`, which `describeTool()`, `searchTools()`, and `ALL_TOOLS` showed without defining it. The codemode description no longer includes the shared MCP types.
- Compaction and branch summaries no longer include the model's thinking blocks. Replayed thinking is often not part of the live context, so including it could make a summarization request larger than the context it summarizes and fail.

### Fixed

- Stopping a codemode script or reaching its deadline no longer waits for a non-interruptible built-in to return on Bun. At most two codemode workers may be alive across all sessions in one process, and a cancelled worker keeps its slot until it exits; at capacity, a new script fails immediately.
- A resumed session restores the tools it had activated, with `--tools +name` and `-name` entries applied to them. Before, tools activated during the session were dropped. `--tools` with tool names, `--no-tools`, and `--no-builtin-tools` still select the tools explicitly.
- A leading `~` in exclusion and exact patterns of the `extensions`, `skills`, `prompts`, and `themes` settings (`!~/skills/pdf`, `-~/x`) means the home directory. Before, it was compared literally and never matched.
- On Windows, taking the `auth.json` lock retries briefly when a just-removed lock directory is still delete-pending and `mkdir` fails with `EPERM`. Real permission errors still fail at once.
- Terminal replies that arrive late, such as a device attributes or color report, stay out of keyboard input; the terminal keeps them until their terminator.
- Mouse wheel events that no component handles scroll the transcript under a focused overlay instead of reaching the overlay as raw input. An overlay that scrolls with the wheel must implement `handleMouse`.
- Kitty images are enabled in Herdr.
- Anthropic requests replace images in error tool results with a text note. The API rejects error results that contain anything but text, which stalled sessions after a failed codemode script that had shown images.
- Anthropic requests with strict tools retry with plain schemas when the API rejects the grammar (too large, too many strict tools, too many union types), and keep strict sampling for tools that require it.
- Tool call arguments with an invalid `\u` escape are repaired instead of failing the call.
- The wrapper text "The upstream provider returned an error" is retried like "Provider returned error".
- The OpenAI Codex request body is sent as a copy of the compressed bytes, which `fetch` accepts under every TypeScript lib.
- Codemode rejects a `// @options:` line that is not the first line of the script instead of ignoring it, which ran the script without its deadline.
- Codemode output with many text items is joined in linear time. A script that printed 100,000 empty lines took about ten seconds to format.

## [1.2.0] - 2026-10-12

### Added

- Extensions and packages written for Pi load as they are. Imports of `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai` and `pi-agent-core` (and the same names under `@mariozechner/`) resolve to Nyan's host modules, and a package's `pi` manifest field is read when it has no `nyan` field. Nyan still does not read `~/.pi` or `PI_*` variables, so an extension that locates the agent directory itself keeps using Pi's. See [Packages and extensions written for Pi](docs/packages.md#packages-and-extensions-written-for-pi).

### Fixed

- In the standalone executable (Bun), an extension is loaded from its source: its module code runs again on reload, and its imports of the host resolve to the running Nyan instead of a second copy that the runtime caches on its own.
- In the standalone executable (Bun), `--mode json`, `--mode rpc`, and print mode keep stdout for the protocol: output written with `console.log` goes to stderr there too, as it does on Node.
- In the standalone executable, `httpIdleTimeoutMs` takes effect. Before, a response that stalled before its headers or in the middle of its body was never given up on, whatever the setting. Proxy variables are read by Bun's fetch itself; the standalone executable now uses that fetch with an idle-timeout wrapper and no longer installs undici.

## [1.1.0] - 2026-10-12

### Added

- Each GitHub release attaches standalone `nyan` executables built with Bun for Linux, macOS and Windows on x64 and arm64, with a `SHA256SUMS` file. They need no Node.js installation. Extract the archive and run `nyan`, or `nyan.exe` on Windows, from the extracted folder; it reads its themes, docs and native helpers from beside the executable. `nyan update` updates a binary in place: it downloads the archive for your platform from the release, checks it against `SHA256SUMS`, and replaces the files in the extracted folder. `NYAN_RELEASE_BASE_URL` points it at a mirror.

## [1.0.1] - 2026-10-12

### Fixed

- `/changelog` and the "What's New" notice after an update show Nyan's release notes again, and the changelog link in the update notice resolves.
- Links in changelog entries point at Nyan's `nyan-vX.Y.Z` release tags. They used to point at the plain `vX.Y.Z` tags, which in this repository are Pi's.

## [1.0.0] - 2026-10-12

First release of Nyan, forked from [Pi](https://github.com/earendil-works/pi) v1.1.0 and synced with Pi up to commit `cdaf6c227`.

### Breaking Changes

- The executable is `nyan` and the package is `@ny4n/coding-agent`. There is no `pi` alias.
- Environment variables use the `NYAN_` prefix, the user directory is `~/.nyan/agent`, and the project directory is `.nyan/`. Nyan does not read `~/.pi`, `.pi/`, or `PI_*`, and does not migrate Pi's data.
- Nyan packages declare their resources under a `nyan` manifest field and use the `nyan-package` keyword. Extensions import `@ny4n/*`; the `@mariozechner/pi-*` and `@earendil-works/pi-*` import aliases for Pi extensions are gone.

### Changed

- Nyan makes no request to a hosted service unless the operator configures one. The installer, the `/share` viewer, the model catalog overlay, and MCP client metadata (`clientRegistration: "cimd"`) need `NYAN_INSTALLER_API_BASE`, `NYAN_SHARE_VIEWER_URL`, `NYAN_CATALOG_BASE_URL`, or `NYAN_MCP_CLIENT_METADATA_URL`; without them the feature is off or fails with an error that names the variable. Without a viewer, `/share` prints the gist URL only.
- The version check asks the npm registry for the `latest` dist-tag of `@ny4n/coding-agent`. `NYAN_LATEST_VERSION_URL` or `NYAN_NPM_REGISTRY` redirects it, and `NYAN_SKIP_VERSION_CHECK` or `NYAN_OFFLINE` turns it off.
- `/bug` writes a local zip file and uploads nothing.
- Settings, models, keybindings, and themes have JSON schemas in `schemas/`, usable for editor validation through `$schema`.

### Removed

- The Radius gateway: its provider, login flow, MCP offer, bug-report upload, and relay transport.
- The install-reporting ping and the `/dementedelves` announcement.
- The `doom-overlay` example extension.

### Fixed

- On Windows, resource patterns written by the configuration selector use `/`, so they match.
