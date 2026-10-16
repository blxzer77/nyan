# Providers

Most hosted providers support one or both of these authentication methods:

- Sign in through a browser or device flow backed by OAuth.
- Provide an API key.

Use `/login [provider]` to see the methods supported by a provider. Amazon Bedrock and Google Vertex AI can also use ambient cloud credentials.

## Authenticate interactively

Run `/login` and select a provider. Nyan guides you through its OAuth or API-key flow and saves the resulting credential in [`auth.json`](configuration.md#agent-directory).

On a remote or headless machine, an OAuth callback may not reach the local process. When prompted, paste the final redirect URL or authorization code back into Nyan.

Run `/logout` and select a provider to remove its stored credential. This does not unset environment variables, remove authentication from `models.json`, or revoke the credential at the provider.

`auth.json` can contain API keys and OAuth tokens. Keep it private and do not commit it.

## Use an API key from the environment

Environment variables are useful in CI and anywhere Nyan should not store the key. Set the variable before starting Nyan:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
nyan
```

This table covers providers with a single primary API-key variable. Providers that need additional configuration or support ambient credentials are covered under [Provider Specific Config](#provider-specific-config).

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen and Go | `OPENCODE_API_KEY` |
| TypeSafe ([classifier models](models.md#use-classifier-models)) | `TYPESAFE_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI (Global and China) | `MOONSHOT_API_KEY` |
| Qwen Token Plan and Individual | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| CLIProxyAPI | `CLIPROXYAPI_API_KEY` |

Anthropic also recognizes `ANTHROPIC_OAUTH_TOKEN` as an API credential and `ANTHROPIC_AUTH_TOKEN` as bearer authentication.

With no key or token set, Anthropic uses workload identity federation when `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` are set: the Anthropic SDK exchanges the identity token for a short-lived access token and refreshes it itself (re-reading the identity token file, so keep that file fresh for long sessions). `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are passed through when set.

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in `auth.json` to a command prefixed with `!`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

Nyan runs the command when the key is first needed and caches its standard output for the process lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until Nyan restarts.

## Provider Specific Config

The providers below have additional setup, need additional settings, or can use credentials supplied by their platform.

A stored API-key credential can include an `env` object. Its values take priority over the process environment for that provider:

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### Azure OpenAI

The provider ID is `azure` (formerly `azure-openai-responses`). Use it as the key in `auth.json`, `models.json`, and `settings.json`, and in model references such as `--model azure/gpt-5.4`.

The `azure` provider serves OpenAI models through the Responses API and Microsoft Foundry models through Chat Completions, such as `azure/deepseek-v4-pro`.

Set an API key plus either a base URL or resource name:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# Or:
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

Resource root URLs under `ai.azure.com`, `cognitiveservices.azure.com`, and `openai.azure.com` are normalized to the OpenAI API path.

Nyan sends the model ID as the deployment name. If a deployment has a different name, map it with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`:

```bash
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-5.4=my-gpt-deployment,deepseek-v4-pro=my-deepseek
```

`AZURE_OPENAI_API_VERSION` overrides the API version for OpenAI models (default `v1`).

To use a Foundry model that Nyan does not include, add it under `azure` in [`models.json`](models.md#configure-a-compatible-endpoint) with `api: "openai-completions"`. Custom models require a `baseUrl`; `AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_RESOURCE_NAME` take priority over it when set:

```json
{
  "providers": {
    "azure": {
      "baseUrl": "https://your-resource.services.ai.azure.com",
      "models": [
        { "id": "your-deployment", "api": "openai-completions" }
      ]
    }
  }
}
```

### Amazon Bedrock

Bedrock can use a bearer token or an ambient AWS credential source:

```bash
# Named profile
export AWS_PROFILE=your-profile

# IAM keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# Required for temporary credentials
export AWS_SESSION_TOKEN=...

# Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# Region, when not supplied by the profile or AWS SDK configuration
export AWS_REGION=us-west-2
# AWS_DEFAULT_REGION is also supported
```

Nyan also supports ECS task credentials and IRSA through the standard `AWS_CONTAINER_CREDENTIALS_*` and `AWS_WEB_IDENTITY_TOKEN_FILE` variables.

### Cloudflare AI Gateway

The gateway requires a token, account ID, and gateway ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

The account and gateway IDs can come from the process environment or the credential's `env` object in `auth.json`.

`CLOUDFLARE_API_KEY` authenticates Nyan to the gateway. Upstream access can use Cloudflare unified billing, credentials stored in the gateway, or an `Authorization` header configured for the provider in `models.json`.

### Cloudflare Workers AI

Workers AI requires a token and account ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

The account ID can also be stored in the credential's `env` object.

### Google Vertex AI

Use a Google Cloud API key:

```bash
export GOOGLE_CLOUD_API_KEY=...
```

To use Application Default Credentials, configure a project and location:

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# GCLOUD_PROJECT is also supported
export GOOGLE_CLOUD_LOCATION=us-central1
```

Then authenticate:

```bash
gcloud auth application-default login
```

To use a service-account key file instead, set `GOOGLE_APPLICATION_CREDENTIALS` along with the project and location.

### CLIProxyAPI

CLIProxyAPI connects Nyan to a local or remote [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server. It dynamically fetches models via `/v1/models?client_version=pi`, serves every model in the proxy's catalog over HTTP/SSE through `/backend-api/codex` (the catalog's `prefer_websockets` flag only describes the proxy's own upstream transport), and supports model overrides, Fast mode (`/fast`), request pausing (`/pause`, `/continue`), and exact throughput tracking (`/cpa-usage`).

Authenticate interactively with `/login CLIProxyAPI` (or via CLI `nyan login cliproxyapi` / `nyan auth login --provider cliproxyapi`), enter the base URL (defaults to `http://127.0.0.1:8317`), and enter your proxy API key. Login checks the key against the proxy's model list before it reports success.

Do not pass `--method` for CLIProxyAPI. `--method api_key` is refused unless a key is already configured, and a key that method stores is not yet used for requests (they fail with `Provider is not configured`). The login without `--method` is the one that works.

Login tells you when a setting moves the key or the URL away from what you entered. `CLIPROXYAPI_API_KEY` (or the `apiKey` field of `cliproxyapi.json`) changes the key that the model list is fetched with, while requests use the stored login. `CLIPROXYAPI_BASE_URL` sends the model list and requests to the URL it names, not to the one you entered, and the key is checked at the entered URL. A key the proxy rejects at startup names the setting it came from.

Alternatively, configure connection parameters via environment variables or `~/.nyan/agent/cliproxyapi.json`:

| Variable | Config field | Default |
|---|---|---|
| `CLIPROXYAPI_BASE_URL` | `baseUrl` | `http://127.0.0.1:8317` |
| `CLIPROXYAPI_API_KEY` | `apiKey` | — |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` | `cliproxyapi` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` | `CLIProxyAPI` |
| `CLIPROXYAPI_FAST` | `fast` | `false` |
| `CLIPROXYAPI_PAUSE` | `pause` | `false` |
| `CLIPROXYAPI_OVERRIDES_FILE` | `overridesFile` | `cliproxyapi-overrides.json` |
| `CLIPROXYAPI_MANAGEMENT_KEY` | `managementKey` | — |

#### Request metrics and plan quota

Every request through CLIProxyAPI produces one record with time to first token (`ttftMs`), the generation window and tokens per second, total time, HTTP status, token counts, estimated cost, retry count, and the gateway trace id. Time spent in `/pause` is excluded from every duration. A figure that could not be observed is absent, not zero. `/cpa-usage` summarizes the session.

The 5 hour and weekly plan quota belongs to the accounts behind the proxy, and CLIProxyAPI does not send it to a client by default: it filters `codex.rate_limits` stream events, and it forwards `x-codex-*` response headers only when it runs with `passthrough-headers: true`. Nyan reads it from either source:

- **Management API (recommended).** Set `CLIPROXYAPI_MANAGEMENT_KEY` (or `managementKey` in `cliproxyapi.json`) to the proxy's management key, the `secret-key` of the management settings in its `config.yaml`. The proxy keeps only a bcrypt hash of it, so you cannot read the plaintext back; keep it when you set it. Nyan polls `GET /v0/management/auth-files` read-only, at most once a minute, at session start and after each finished run, and returns one entry per pooled Codex or Claude account. This key is not the API key and gives admin access to the proxy; keep it as private as `auth.json`.

  The proxy counts a request with a missing or wrong management key as a failed attempt, and five failures ban the client address from the management API for 30 minutes. When the proxy sits behind a port forward or reverse proxy, every client shares one address, so a ban hits everyone, including scanners' failures. Nyan therefore never sends a key the proxy has already rejected until the key changes, waits out a ban instead of retrying, and shows both states in `/cpa-quota` and `/cpa-doctor`.
- **Response headers.** With `passthrough-headers: true` on the proxy, the quota of the account that served the last request is read from that response.

Windows are identified by their length (300 minutes is the 5 hour window, 10080 the weekly one), not by the upstream's `primary`/`secondary` names. A Codex plus plan reports only a weekly window. A Claude account reports `5h` and `7d` windows with the upstream's own `allowed`/`rejected` verdict. `/cpa-quota` prints the result, or says which source is missing. A figure whose window has already reset is marked stale.

Other code can subscribe to the extension event bus: `cliproxyapi:request` carries each request record and `cliproxyapi:quota` the current quota view.
