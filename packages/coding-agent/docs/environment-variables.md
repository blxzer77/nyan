# Environment Variables

Nyan uses environment variables in three ways:

- Variables such as `NYAN_OFFLINE` configure the Nyan process.
- Nyan sets process markers so child processes can identify Nyan as the launching agent.
- Commands run by the LLM-callable shell tools receive `NYAN_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=nyan` is a generic marker that lets tooling identify Nyan as the agent that launched the process.
- `NYAN_CODING_AGENT=true` is Nyan-specific and lets child processes detect that they run inside Nyan.

Child processes inherit both markers. They are not session-specific and are not set automatically when Nyan is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Nyan session state:

| Variable | Description |
|----------|-------------|
| `NYAN_SESSION_ID` | Current session ID |
| `NYAN_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `NYAN_PROVIDER` | Currently selected model provider |
| `NYAN_MODEL` | Currently selected model ID |
| `NYAN_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Nyan. `NYAN_PROVIDER` and `NYAN_MODEL` identify the selected Nyan model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$NYAN_PROVIDER" "$NYAN_MODEL"
printf 'reasoning=%s session=%s\n' "$NYAN_REASONING_LEVEL" "$NYAN_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$NYAN_SESSION_FILE" ]; then
  tail -n 1 "$NYAN_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Nyan. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Nyan removes inherited values for these variables so nested Nyan processes do not expose stale parent-session metadata.

## Nyan Process Configuration

These variables are read by Nyan itself:

| Variable | Description |
|----------|-------------|
| `NYAN_CODING_AGENT_DIR` | Override the config directory; default is `~/.nyan/agent` |
| `NYAN_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `NYAN_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `NYAN_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `NYAN_SKIP_VERSION_CHECK` | Disable the latest-version request |
| `NYAN_LATEST_VERSION_URL` | Ask this release feed instead of the npm registry; it answers `{ version, packageName?, note? }` |
| `NYAN_NPM_REGISTRY` | Registry used for the latest-version lookup (default `https://registry.npmjs.org`) |
| `NYAN_RELEASE_BASE_URL` | Folder URL holding the release assets that `nyan update` downloads in a standalone executable (default `https://github.com/blxzer77/nyan/releases/download`). It must be an https URL; http is accepted for localhost |
| `NYAN_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `NYAN_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `NYAN_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `NYAN_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `NYAN_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `NYAN_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise Nyan reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `NYAN_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `NYAN_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `NYAN_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests. On Node, Nyan installs an undici proxy agent (a plain-HTTP origin goes through a CONNECT tunnel). In the standalone executable Bun's own fetch reads these variables; which requests it proxies and in which form is Bun's behavior and can differ per platform |
| `NODE_EXTRA_CA_CERTS` | Path to a PEM file of extra certificate authorities to trust, for a private CA or a TLS-inspecting proxy. Read once, when the process starts. Works on Node and in the standalone executable |
| `NODE_OPTIONS=--use-system-ca` | Makes Node trust the operating system certificate store. The standalone executable (Bun) does not read `NODE_OPTIONS`: Nyan prints a warning once at start-up when this is set there, and the system store stays unused. Set `NODE_USE_SYSTEM_CA=1` or `BUN_OPTIONS=--use-system-ca` before starting Nyan instead, or use `NODE_EXTRA_CA_CERTS`. Checked on Windows only; where it has no effect, `NODE_EXTRA_CA_CERTS` is the supported way |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).
