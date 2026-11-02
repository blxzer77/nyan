# Provider / Model 抽象重设计

状态：设计稿（2026-11-02），只读审计后产出，未实现。

## 0. 结论摘要

nyan 的目标是 provider 无关的通用 agent，而不是把 Anthropic API 当作运行时抽象。当前代码的真实边界是：上层已经有相对通用的消息、工具和 agent 流程，但 API client、请求参数、能力判断、凭据和模型选择仍以 Anthropic 为中心。本设计把它们拆成四层：

```text
Settings / env / CLI
        ↓
ProviderCatalog + ModelCatalog + CredentialResolver
        ↓
Provider-neutral Request IR
        ↓
Provider adapter（Anthropic / OpenAI-compatible / Gemini）
        ↓
stream / usage / error normalized back to query loop
```

核心原则：

1. **模型 ID 不等于 provider**：`provider/model` 是稳定引用；裸模型名只在迁移兼容层解析。
2. **能力声明优先于名称推断**：上下文长度、工具调用、thinking、图片、结构化输出、流式能力等由模型条目声明；未知能力按“不支持”处理，避免误发请求。
3. **协议适配器隔离专有字段**：`anthropic-beta`、Anthropic cache control、Bedrock/Vertex/Foundry 特殊认证和 OAuth 不进入公共 Request IR。
4. **配置不携带秘密**：settings 只引用环境变量、key 文件或 OAuth profile；真正的 secret 不进 JSON、日志、model picker 或错误消息。
5. **选择与执行分离**：主 agent、子 agent、Decision Provider 都选择 `ModelRef`，执行层只接收已经解析的 `ResolvedModel`。
6. **失败可降级但不伪装**：provider 不可用、能力未知、凭据缺失或 adapter 不支持某字段时，走明确的 fallback / error，不静默改用另一家 provider。
7. **配置迁移可逆**：先支持旧的 Anthropic 配置和 gateway 配置，再逐步把新格式设为权威；每一步都能退回旧路径。

本文的接口是设计形状，不是要求一次性实现的代码 API。

## 一、现状审计

### 1.1 Settings、环境变量和启动覆盖

Settings 是严格 schema 的 `SettingsJson`，普通模型字段目前是 `model`、`availableModels`、`modelOverrides`、`advisorModel`，并另有 `env` 和 `httpHeaders`（`src/utils/settings/types.rs:60-85,122-124`）。nyan 自己的扩展集中在一个 `nyan` 顶层 key 下（`src/utils/settings/nyan.rs:1-19`），新 provider 配置应遵守同一约定，不再增加多个顶层私有 key。

settings 文件的合并顺序是 `userSettings → projectSettings → localSettings → cli flag → managed policy`；启用来源由 `get_enabled_setting_sources` 决定，但 CLI flag 和 policy 不能被关闭（`src/utils/settings/constants.rs:89-105`、`src/utils/settings/mod.rs:246-300`）。同一字段的后来源覆盖前来源，当前 settings 通过 session cache 读取（`src/utils/settings/mod.rs:303-329`）。

当前主模型选择链为：

```text
CLI --model / main-thread agent model
  → bootstrap main_loop_model_override
  → ANTHROPIC_MODEL
  → settings.model
  → provider/build audience 默认模型
```

入口和重要语义在 `src/main.rs:264-291`、`src/utils/model/model.rs:77-102,138-163`：CLI 或主线程 agent 形成运行时 override；没有 override 时才让 env/settings 继续参与解析。`sonnet` / `opus` / `haiku` / `best` / `opusplan` 和 `[1m]` 是 Anthropic 语义别名（`src/utils/model/model.rs:104-135`）。

当前 provider 选择不是配置对象，而是环境变量优先级：`CLAUDE_CODE_USE_BEDROCK` → `CLAUDE_CODE_USE_VERTEX` → `CLAUDE_CODE_USE_FOUNDRY` → FirstParty（`src/utils/model/providers.rs:7-27`）。`ANTHROPIC_BASE_URL` 只用于判断是否仍是官方 Anthropic host（`src/utils/model/providers.rs:39-68`），不能表达一个通用 provider。

### 1.2 Gateway model-picker 与模型能力

nyan 已有一处针对 gateway 的扩展：`settings.availableModels` 追加到 model picker，`additionalModelOptionsCache` 提供 label/description（`src/components/model_picker.rs:57-115`），内置 picker 仍硬编码 Sonnet/Opus/Haiku（`src/components/model_picker.rs:117-145`）。`modelOverrides` 把 Anthropic canonical ID 映射成 Bedrock 等 provider-specific ID（`src/utils/settings/types.rs:75-77`，并由 `src/utils/model/model_strings.rs:63-103` 使用）。

上下文长度也有一条 gateway 专用旁路：`GlobalConfig.modelContextWindows` 按模型 ID 查表，并在去掉 `[1m]` 后再查；查不到才回到官方 200k / 1M 规则（`src/utils/context.rs:126-154`，字段定义在 `src/utils/config.rs:617-621`）。它解决了 gateway 自有模型没有官方 model table 的问题，但能力仍只有一个整数，且位置不在 Settings schema。

模型其它能力依赖名称、provider 和 Anthropic beta：

- `utils/betas.rs` 按 canonical Claude 名称和 `ApiProvider` 判断 interleaved thinking、context management、structured outputs、tool-search 等（`src/utils/betas.rs:118-193,209-297`）；
- 3P 模型只能通过 `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` 覆盖少数 thinking/effort 能力（`src/utils/model/model_support_overrides.rs:37-92`）；
- thinking 和 max output 仍调用 Anthropic 模型表（`src/services/api/claude.rs:30-39`、`src/utils/context.rs:161-190`）。

### 1.3 请求构造与 Anthropic 专有部分

当前请求主链是：

```text
query loop
  → get_anthropic_client()
  → build_sdk_message_create_plan()
  → anthropic_sdk::BetaMessageCreateParams
  → provider-specific SDK / stream parser
```

client factory 明确构造四种 Anthropic SDK client：Direct、Bedrock、Foundry、Vertex（`src/services/api/client.rs:1-9,152-163`）。它在一个工厂内同时处理通用 header、OAuth refresh、API key、proxy、timeout、四种 provider auth 和 base URL（`src/services/api/client.rs:184-246,291-515`）。

请求 body 直接是 Anthropic SDK 类型：`BetaMessageCreateParams` 包含 Anthropic 的 `max_tokens`、`system` block、`thinking`、`tools`、`tool_choice` 等，模型和 provider 逻辑在 `src/services/api/claude.rs:2027-2116,2264-2403`；stream parser 也直接匹配 Anthropic content block delta，包括 thinking delta（`src/services/api/claude.rs:3010-3175`）。

当前 header 已有正确的分层起点，但仍是 Anthropic adapter 形状：

- common header：`User-Agent`、`x-app`（`src/services/api/request_headers.rs:12-21`）；
- Anthropic adapter header：`X-Nyan-Session-Id`、远程 session/container header、`x-anthropic-additional-protection`（`src/services/api/request_headers.rs:23-50`）；
- `anthropic-beta` 只应发给 Anthropic 请求（`src/services/api/request_headers.rs:52-58`），但 beta 计算本身仍广泛散落在 `utils/betas.rs`；
- `httpHeaders` 会按 header 名覆盖内建 header（`src/services/api/request_headers.rs:60-82`）。

OAuth 也仍是 Claude.ai 专有路径：OAuth endpoint、scope、`oauth-2025-04-20` 和 `.credentials.json` 形状都集中在 `src/constants/oauth.rs:23-43,64-102` 与 `src/utils/auth.rs:551-609`。关键产品开关 `OAUTH_CREDENTIAL_SIDE_EFFECTS_ENABLED` 被编译期固定为 `false`（`src/constants/oauth.rs:40-47`）；刷新后的 OAuth credentials 会先在内存构造，但持久化前直接返回 unavailable error，且不会清理 beta/tool-schema cache（`src/utils/auth.rs:614-691`）。`get_anthropic_client` 在选中 Claude.ai OAuth 且该 gate 拒绝时，会让 client construction 失败（`src/services/api/client.rs:210-240`）。这不是通用 OAuth 能力，不能直接复制给其它 provider。

### 1.4 子 agent 和 Decision Provider 选模

子 agent 当前模型选择优先级是：`CLAUDE_CODE_SUBAGENT_MODEL` → tool 指定模型 → agent definition 的 model → `inherit`（父模型），并在 Bedrock 下继承 region prefix（`src/utils/model/agent.rs:21-93`）。运行时在 `run_agent` 中先解析模型，再用它启动子 agent query（`src/tools/agent_tool/run_agent.rs:706-750`）。`inherit` 是“继承父模型”的特殊值，不是 provider-neutral 的模型引用。

Decision Provider 目前将模型抽象成 `fast` / `accurate` 两个闭集别名：配置定义在 `src/utils/settings/nyan.rs:838-902`，决策点注册表包括 `agent.route` 等宿主场景（`src/services/decision/mod.rs:48-137`），System One 后端通过 `settings.nyan.decision.emrank.models` 映射真实模型（`src/utils/settings/nyan.rs:841-852`）。这使 Decision Provider 能独立于主模型，但后端和凭据仍是 EMRank/Anthropic chat 的专用假设；后续需要把别名映射到通用 `ModelRef`，并保留 `fast/accurate` 作为逻辑档位而非 provider 名称。

## 二、目标抽象

### 2.1 四个核心对象

```rust
pub struct ProviderId(pub String);        // anthropic, openai-main, gemini, vllm, ollama
pub struct ModelRef {                     // 始终可解析到一个 provider
    pub provider: ProviderId,
    pub model: String,                     // provider wire model id
}

pub struct ModelCapabilities {
    pub context_window: u32,
    pub max_output_tokens: Option<u32>,
    pub tools: ToolCapability,
    pub thinking: ThinkingCapability,
    pub images: ImageCapability,
    pub structured_output: bool,
    pub streaming: bool,
    pub prompt_cache: CacheCapability,
}

pub struct ResolvedModel {
    pub reference: ModelRef,
    pub display_name: String,
    pub capabilities: ModelCapabilities,
    pub credential_profile: Option<String>,
    pub endpoint: Endpoint,
}
```

`ModelRef` 是配置与日志中的身份；`ResolvedModel` 是请求前的快照。一次请求必须固定使用一个快照，不能在重试中因环境变量变化而悄悄换 provider 或 capabilities。

能力最少覆盖用户要求的四项：`context_window`、`tools`、`thinking`、`images`。建议同时声明 `max_output_tokens`、`structured_output`、`streaming`、`prompt_cache`，原因是这些字段当前也会改变请求形状。能力应是可组合的显式枚举，而不是无穷的字符串：

```jsonc
{
  "tools": "native",       // none | native | emulated
  "thinking": "adaptive",  // none | budgeted | adaptive
  "images": "input",       // none | input | inputAndOutput
  "promptCache": "native"  // none | native | clientSide
}
```

未知能力一律按 `none` 处理；provider adapter 可在启动时对配置做 schema 校验，但不应根据模型名称猜测“看起来支持”。

### 2.2 Provider 是协议 + endpoint + credential profile

provider 条目不直接等于厂商。建议使用以下 protocol：

| protocol | 覆盖 | 首批 adapter | 关键差异 |
|---|---|---|---|
| `anthropicMessages` | Anthropic API、Anthropic-compatible gateway、Bedrock/Vertex/Foundry 的 Anthropic wire 变体 | Anthropic | system blocks、thinking、tool schema、beta、cache control、SSE/专用 transport |
| `openaiChat` | OpenAI、OpenRouter、兼容网关、vLLM 的 OpenAI endpoint | OpenAI-compatible | `messages` content parts、tool calls、JSON response format、usage/finish reason |
| `gemini` | Gemini API / Vertex Gemini | Gemini | `contents`/`parts`、function call、thought parts、inline data |
| `ollama` | Ollama 原生 endpoint | 后续；也可先用 `openaiChat` | 本地模型发现、keep-alive、图片格式和本地错误语义 |

vLLM 默认走 `openaiChat`，除非其 endpoint 明确只实现其它协议；Ollama 允许用户显式选择 `ollama` 或兼容的 `openaiChat`。这样“本地/云端”不是协议枚举，也不会把部署方式锁死在品牌名里。

公共层接口只暴露规范化输入输出：

```rust
#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    async fn send(
        &self,
        model: &ResolvedModel,
        request: &ModelRequest,
        cancel: &CancellationToken,
    ) -> Result<ModelStream, ProviderError>;

    fn validate(&self, model: &ResolvedModel, request: &ModelRequest)
        -> Result<(), CapabilityError>;
}
```

`ModelRequest` 由会话消息、system blocks、工具 schema、tool choice、thinking preference、image parts、output limit 和 query source 组成；不包含任何 provider header/beta 字段。adapter 负责：

1. 把 IR 转成自身 wire body；
2. 只发送自身支持的能力；
3. 把 stream delta、tool call、usage、stop reason、provider request id 归一化；
4. 把 HTTP/SDK 错误映射成 `ProviderError`（auth、unsupported、rateLimited、overloaded、contextOverflow、invalidRequest、transport、unknown）。

### 2.3 Anthropic adapter 的隔离边界

第一阶段不删除现有 `services/api/claude.rs`，而是把它变成 Anthropic adapter 的实现细节。以下内容只允许出现在 Anthropic adapter、Anthropic credential/provider modules 或明确的 provider capability table 中：

- `anthropic-beta` 及 `src/utils/betas.rs` 的 beta 选择；
- `request_headers.rs` 中 Anthropic adapter headers；common headers 仍可复用；
- `system` block 的 Anthropic cache control、prompt cache scope 和 thinking/redacted-thinking block；
- Bedrock SigV4 / bearer、Vertex Google auth、Foundry Azure auth；
- Claude.ai OAuth scopes、`oauth-2025-04-20`、`.credentials.json` 与 `OAUTH_CREDENTIAL_SIDE_EFFECTS_ENABLED=false`；
- Anthropic 模型 alias、`[1m]` 语义和官方模型表。

公共层可以知道“这个模型声明支持 prompt cache/thinking”，但不能知道 beta header 字符串，也不能直接调用 `get_merged_betas`。这会让 OpenAI/Gemini 请求不再被误加 Anthropic beta，也让关闭 OAuth side effect 不影响其它 provider。

## 三、建议配置格式

### 3.1 Settings 形状

新配置放在 `settings.nyan.providers` 与 `settings.nyan.models`。字段均使用现有 `SettingsJson.nyan` 的 optional/deep-merge 规则；provider credential 的 secret 只写引用。

```jsonc
{
  "nyan": {
    "providers": {
      "anthropic": {
        "protocol": "anthropicMessages",
        "baseUrl": "https://api.anthropic.com",
        "credential": { "env": "ANTHROPIC_API_KEY" }
      },
      "openai": {
        "protocol": "openaiChat",
        "baseUrl": "https://api.openai.com/v1",
        "credential": { "env": "OPENAI_API_KEY" }
      },
      "local-vllm": {
        "protocol": "openaiChat",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "credential": { "optionalEnv": "VLLM_API_KEY" }
      },
      "local-ollama": {
        "protocol": "ollama",
        "baseUrl": "http://127.0.0.1:11434",
        "credential": { "none": true }
      },
      "gemini": {
        "protocol": "gemini",
        "baseUrl": "https://generativelanguage.googleapis.com",
        "credential": { "env": "GEMINI_API_KEY" }
      }
    },
    "models": {
      "main": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "displayName": "Sonnet",
        "capabilities": {
          "contextWindow": 200000,
          "maxOutputTokens": 128000,
          "tools": "native",
          "thinking": "adaptive",
          "images": "input",
          "structuredOutput": true,
          "streaming": true,
          "promptCache": "native"
        }
      },
      "local-fast": {
        "provider": "local-vllm",
        "model": "Qwen/Qwen3-32B",
        "capabilities": {
          "contextWindow": 131072,
          "maxOutputTokens": 16384,
          "tools": "native",
          "thinking": "budgeted",
          "images": "none",
          "structuredOutput": true,
          "streaming": true,
          "promptCache": "none"
        }
      }
    },
    "selection": {
      "main": "main",
      "subagent": "inherit",
      "decision": {
        "fast": "local-fast",
        "accurate": "main"
      }
    }
  }
}
```

这里的 `models` key 是用户可见的 profile 名称，`provider + model` 是实际身份。建议允许 `selection.main` 直接写 `provider/model`，但内部统一归一化为 profile；这样同一个模型可以有不同 capability declaration、费用标签或 endpoint profile，而日志仍可记录完整 `provider/model`。

不建议把所有可发现模型自动写回 settings：model discovery 是外部状态，应该只生成临时 picker cache；用户要稳定选择的模型才写入 `nyan.models`。

### 3.2 Credential 引用

```jsonc
{
  "credential": { "env": "OPENAI_API_KEY" },
  "credential": { "file": "~/.nyan/keys/openai" },
  "credential": { "optionalEnv": "VLLM_API_KEY" },
  "credential": { "oauth": "google-default" },
  "credential": { "oauth": "anthropic-claude-ai" }
}
```

解析规则：

1. `env`：变量名必须是配置的变量名，不能在 settings 中写变量值；未设置是明确的 `missingCredential`。
2. `file`：展开 `~` 后读取单行，trim 仅作用于文件格式，不修改 token 本体；要求普通文件、owner-only 权限（Unix 0600；Windows 使用 owner ACL 检查或至少明确记录无法检查）。
3. `optionalEnv`：没有凭据也允许构造 client，适用于本地无认证 endpoint；如果 endpoint 返回 401，再映射为 auth error，不伪装成 offline。
4. `oauth`：只引用 provider-specific OAuth profile。OAuth flow、refresh、token cache 和 side effects 都由该 provider 的 credential owner 实现。Anthropic 的默认关闭 gate 只作用于 `anthropic-claude-ai`，不能阻断 API key、Gemini ADC 或其它 provider。
5. 若一个 provider 需要多段凭据（例如 AWS access key/secret/session token 或 Google ADC），credential resolver 返回 typed material，不把多段值拼成一个通用字符串。

凭据优先级不应再由任意环境变量隐式抢占：显式 CLI/profile 选择的 credential profile > settings 中的 provider credential > provider adapter 的标准 env fallback。兼容期可读旧 env，但启动诊断要显示“来源类型/变量名”，绝不显示 secret。

### 3.3 Provider、model 和 endpoint 的作用域

- user settings：个人 provider、key 引用、默认模型；
- project settings：只允许模型 profile 和 capability policy，不允许 project 内定义 `file` 指向私密路径，也不允许覆盖 user credential；
- managed policy：可限制 provider allowlist、model allowlist、最大 context、是否允许本地 endpoint；
- CLI：一次会话的 `--provider` / `--model` / `--profile` override；不落盘；
- env：迁移兼容和 CI/headless 注入，优先影响 credential，不应暗中改变已解析的 provider。

建议把 endpoint 的 URL 视为 provider 配置的一部分，并在显示与日志中记录 scheme/host（必要时脱敏 path）。对 `http://127.0.0.1`、LAN 和公网 endpoint 的安全策略由 provider config 明确控制，不能把“本地”作为自动信任的充分条件。

## 四、模型选择协议

### 4.1 主模型

解析得到：

```text
CLI explicit --model / --profile
  > session override from /model
  > settings.nyan.selection.main
  > legacy settings.model / ANTHROPIC_MODEL migration resolver
  > built-in default profile
```

`selection.main` 最终必须是 `ModelRef`。裸 `sonnet`、`opus` 等只在 legacy resolver 中解释，且只有 active Anthropic profile 才允许这些 alias；OpenAI/Gemini 的裸 `gpt-4.1` 不应被误判为 Anthropic alias。

model picker 按 profile 展示 `displayName`、provider 名、能力标记和 context window；gateway discovery 的 model 列表可以作为未配置的候选，但选中后写入一个明确的 `nyan.models` profile，而不是把 provider-specific ID 塞进旧 `availableModels`。

### 4.2 子 agent

将当前 `inherit` 保留为逻辑选择值，但它的解析对象改成父 agent 的 `ResolvedModel`，而不是只复制字符串：

```text
explicit agent profile/model
  > agent definition model
  > CLAUDE_CODE_SUBAGENT_MODEL（迁移兼容，仅 Anthropic alias 或明确 profile）
  > inherit parent ResolvedModel
  > selection.subagent
```

推荐新增：

```jsonc
{
  "nyan": {
    "selection": {
      "subagents": {
        "Explore": "local-fast",
        "Plan": "main",
        "Verify": "main"
      },
      "subagent": "inherit"
    }
  }
}
```

规则：

- agent definition 或 tool 的显式 `provider/model` 优先于 profile 默认；
- `inherit` 继承 provider、model、capabilities snapshot 和 credential profile，但子 agent 可以通过 policy 限制能力；
- 若显式子 agent 模型不支持 tools，而 agent 必须用工具，启动前返回 capability error，不自动切到主模型；
- `CLAUDE_CODE_SUBAGENT_MODEL` 只作为迁移 alias，文档中标 deprecated；新实现使用 `NYAN_SUBAGENT_MODEL` 或 settings profile；
- Bedrock region prefix 等 provider-specific 逻辑只在 Anthropic adapter/credential resolution 中执行。

### 4.3 Decision Provider

`fast` / `accurate` 保留为**逻辑档位**，不再绑定 EMRank 或 Anthropic。配置改成：

```jsonc
{
  "nyan": {
    "decision": {
      "backends": {
        "fast": { "model": "local-fast", "deadlineMs": 800 },
        "accurate": { "model": "main", "deadlineMs": 2000 }
      },
      "points": {
        "retrieval.answers": { "mode": "active", "tier": "fast" },
        "memory.type": { "mode": "active", "tier": "accurate" }
      }
    }
  }
}
```

Decision Provider 选择模型的约束：

1. 先按点的 `tier` 选择，再检查模型能力：必须支持结构化输出或至少稳定的闭集 JSON、tools=false 即可、context window 足够；
2. 如果用户指定的模型不满足 capability，按明确的 `backendUnavailable` 回退到确定性路径，不把主会话模型偷偷换掉；
3. Decision Provider 请求独立记录 provider/model、latency、usage 和 fallback reason；不把凭据或完整 state 写入日志；
4. “更快”由实测 latency/health/cost metadata 维护，不由模型名猜；同一 tier 可以在 user settings 里改 provider；
5. provider down 时可以尝试同 tier 的显式备用 profile，但重试次数、预算和安全集合仍由 Decision Provider 核心决定；不能把 classifier 的失败变成主模型行为变化。

现有 `DecisionBackend` 接口和 `off/shadow/active` 语义可以保留（`src/services/decision/mod.rs:19-27`）；只替换 backend model resolution，不改变硬安全规则、确定性回退和凭据 redaction。

## 五、迁移路径

### 5.1 兼容解析表

| 旧来源 | 迁移到 | 兼容期行为 |
|---|---|---|
| `settings.model` | `nyan.selection.main` + Anthropic profile | 旧值继续有效；新配置优先并在诊断中提示来源 |
| `ANTHROPIC_MODEL` | Anthropic legacy resolver | 仅当没有显式新选择时读取；写日志为 deprecated source |
| `availableModels` | picker discovery / managed allowlist | 继续作为 allowlist；选中后 materialize 新 profile |
| `modelOverrides` | `models.<profile>.model` 或 Anthropic deployment mapping | 保留读取；新配置明确 provider 和 wire model，避免 canonical ID collision |
| `GlobalConfig.modelContextWindows` | `models.<profile>.capabilities.contextWindow` | 新声明优先；旧 map 作为 legacy fallback，不能覆盖显式 capability |
| `additionalModelOptionsCache` | provider discovery cache | 只作 UI metadata；不作为能力或凭据来源 |
| `ANTHROPIC_SMALL_FAST_MODEL` | `selection.roles.fast` 或 Decision tier | Anthropic 兼容期读取；新配置显式绑定 profile |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `selection.subagent` / per-agent map | 兼容读取；不再能跨 provider 解释裸 alias |
| `settings.nyan.decision.emrank.models` | `decision.backends.*.model` | `fast/accurate` key 保留，value 改成 profile/ModelRef |
| `httpHeaders` | provider common/adapter header policy | 兼容 global override，但禁止用它注入另一协议的 auth/beta；未来按 provider 作用域 |

### 5.2 分阶段兼容策略

1. **Read-only catalog phase**：新增 provider/model schema 和 resolver，但默认不改变现有 Anthropic 请求；启动输出 resolved catalog（无 secret）。
2. **Anthropic-through-adapter phase**：把现有 Anthropic client 接到公共 Request IR，默认请求字节与当前路径一致；旧 env/settings 仍是输入。
3. **Explicit non-Anthropic opt-in**：OpenAI-compatible、Gemini、vLLM、Ollama 只有在新 profile 被显式选中时启用；旧配置永远继续走 Anthropic。
4. **New selection authority**：新 `nyan.selection` 优先，旧模型字段进入 deprecated warning；managed policy 可阻止旧隐式 gateway 路径。
5. **Cleanup after telemetry**：至少一个版本周期后再移除旧 `modelOverrides` / `modelContextWindows` 的写入支持；读取和迁移导出可保留更久。

迁移命令/诊断（实现时）应提供 dry-run：列出旧来源、解析出的 `ModelRef`、能力缺口、需要用户确认的 provider endpoint 和 credential reference；默认不写文件。自动写入只生成备份，并且不把 env 的 secret 落盘。

## 六、分阶段实施计划（每阶段可单独 PR）

| PR | 内容 | 独立验收 | 主要风险 |
|---|---|---|---|
| 1. catalog types | 新增 `ProviderId`、`ModelRef`、capabilities、credential reference、schema 与纯 resolver；不接请求 | settings schema 能读/拒绝非法值；旧配置回归测试全绿 | strict schema、deep merge、空值语义被破坏 |
| 2. credential owner | env/key-file/OAuth profile resolver、权限检查、secret-safe diagnostics；Anthropic OAuth 仍 default-closed | mock env/file/OAuth；日志无 secret；缺凭据错误类型稳定 | Windows ACL 与 Unix mode 差异；OAuth side effect 误扩大范围 |
| 3. request IR | 公共 message/tool/image/thinking/usage/error 类型和 capability validation；保留现有 API | 同一输入 IR 能拒绝不支持能力；序列化 fixture 稳定 | 把 Anthropic semantics 泄漏进公共类型；tool/thinking 配对错误 |
| 4. Anthropic adapter | 将 `services/api/client.rs`、`claude.rs`、headers、betas、Bedrock/Vertex/Foundry 接到 adapter；默认行为字节对照 | Anthropic direct/gateway/3P mock 请求与旧 fixture 对照；OAuth gate 仍只影响 Claude.ai | cache prefix、beta 顺序、stream/tool/thinking 解析改变 |
| 5. OpenAI-compatible adapter | OpenAI、vLLM 和兼容 gateway；tools/images/streaming/JSON output；usage/error mapping | local `TcpListener` mock 覆盖 chat/tool/vision/stream/error | 各 gateway 方言不一致；tool call streaming 拼接 |
| 6. Gemini + Ollama | Gemini parts/function calls/thoughts；Ollama discovery/keep-alive/native errors | provider-specific mock 与 offline fallback；不影响已选 Anthropic | thought parts 和图片协议转换；本地服务阻塞启动 |
| 7. selector integration | model picker、main model、subagent profile/inherit、managed allowlist；旧配置迁移提示 | picker 显示 provider/capability；子 agent 不再错误继承 provider-specific alias | session snapshot 与 retry 不一致；显式选择优先级争议 |
| 8. Decision Provider integration | `fast/accurate` → ModelRef；capability/health/cost selection；保留 off/shadow/active | Decision backend 可替换 provider；down/timeout 仍确定性回退 | classifier 质量/延迟下降；把主会话凭据或源码误发到错误 provider |
| 9. migration + deprecation | dry-run/export、旧字段警告、文档和 release notes；暂不删除读取 | 旧 settings/env、gateway map 与新配置双向验收 | 用户配置组合数量大；自动迁移产生不可逆覆盖 |

PR 之间的写集应保持隔离：先 schema/resolver，再 IR，再 adapter，最后接入选择和迁移；不要在 adapter PR 顺便重写 model picker 或 settings merge。

## 七、风险与防护

| 风险 | 影响 | 防护 |
|---|---|---|
| 把 capability 当作 provider 猜测 | 错误 thinking/tools/images 请求，甚至丢工具调用 | capabilities 显式声明；unknown=unsupported；请求前 validate |
| 统一 IR 过度追求最低公分母 | Gemini/Anthropic 特性丢失，效果退化 | IR 保留可选 typed extension；extension 只能由对应 adapter 读取 |
| 不同 provider 的 tool-call 语义不同 | tool_use/tool_result 不成对、循环卡死 | normalized stream state machine；每家 adapter 单测 fixture |
| cache 语义混用 | prompt cache miss 或把不支持 cache 的 provider 当命中 | `CacheCapability` 明确为 native/clientSide/none；cache receipt 记录 provider |
| OAuth 复用错误 | token 写错文件、刷新副作用越过编译期开关 | credential owner 按 provider 隔离；Anthropic gate 不下沉为全局开关 |
| 项目设置携带凭据 | secret 泄漏到 git | project scope 禁止 secret value/file path policy；gitleaks 与 schema test |
| gateway endpoint 伪装 provider | beta/auth/header 发错，错误信息误导 | protocol 显式配置；base URL 只作为 endpoint，不再决定 provider 身份 |
| env 在 session 中途变化 | 同一会话模型/能力不稳定 | 启动或选择时解析 snapshot；请求携带 ResolvedModel snapshot |
| 本地 provider 阻塞或不可用 | TUI 启动变慢、Decision Provider 卡住 | 不启动探测；首次请求超时；health state 与确定性 fallback |
| provider 数量扩大导致测试矩阵爆炸 | CI 慢、协议回归难发现 | 每 adapter mock contract suite + 少量真实 smoke；公共 IR 测试复用 |
| 迁移覆盖旧设置 | 用户行为悄悄改变 | dry-run、备份、显式确认；旧读取至少保留一个版本周期 |

安全边界：provider adapter 不得改变权限系统的硬 deny、路径检查、凭据 redaction 或 hook/user decision；Decision Provider 也不能用新模型选择绕过这些规则。

## 八、需要拍板的决策点

以下是实现前需要确认的产品决策；括号内是本设计的推荐默认值。

1. **新配置的权威位置**：是否接受全部放在 `settings.nyan.providers/models/selection`，不新增顶层 `providers`？（推荐：接受，保持现有 strict schema 与 nyan 约定。）
2. **模型引用格式**：是否以 profile key 为主、同时允许 `provider/model` 直写？（推荐：profile 为主，直写仅作 CLI/临时 override。）
3. **未声明能力的策略**：unknown 是否一律禁用，还是允许 adapter probe 自动发现？（推荐：unknown=禁用；probe 只更新显式 discovery cache，不自动改变运行时 capability。）
4. **默认 provider**：新安装是否继续默认 Anthropic，还是提供无 provider 的 setup wizard？（推荐：兼容现状默认 Anthropic，但代码路径不再把 Anthropic 当公共抽象。）
5. **OpenAI-compatible 范围**：首批是否只承诺 OpenAI Chat Completions 子集，还是优先 Responses API？（推荐：先定义一个 adapter contract，首批实现 Chat Completions；Responses 作为独立 protocol capability，避免混淆。）
6. **Ollama 协议**：是否优先走 OpenAI-compatible endpoint，还是必须实现 Ollama native adapter？（推荐：vLLM 先走 OpenAI-compatible；Ollama native 放第二阶段，但 profile 可显式选。）
7. **OAuth 范围**：是否只实现 provider 自己已有的 OAuth（Anthropic gate 保持 false），不为通用 provider 做统一 OAuth broker？（推荐：是；每家 provider 自己拥有 OAuth/ADC/exec credential。）
8. **项目级 provider**：是否允许 `.claude/settings*.json` / project settings 定义 endpoint？（推荐：只允许引用 managed/用户已定义的 provider，不允许项目新增任意公网 endpoint 或 credential file。）
9. **主模型与 Decision Provider 的隔离**：Decision Provider 是否允许使用本地模型，即使主模型是云端？（推荐：允许，默认仍 off/shadow；能力、延迟、隐私和预算独立记录。）
10. **旧配置淘汰窗口**：旧 `settings.model`、`ANTHROPIC_MODEL`、`modelContextWindows` 至少保留多久？（推荐：一个完整 release 周期后再停止写入支持，读取兼容更久。）
11. **provider fallback 语义**：主请求遇到 429/5xx 是否允许自动跨 provider 重试？（推荐：默认不跨 provider；只有用户显式配置的同 tier fallback 才允许，且必须记录 provider switch。）
12. **Windows 凭据文件权限**：Windows 是否要求 owner-only ACL，还是“能读取即接受并警告”？（推荐：发布前实现 ACL 检查；第一阶段若无法可靠检查则拒绝把 key file 当安全存储并给出 env 替代。）

## 九、验收标准

1. 不配置新 provider 时，现有 Anthropic direct/Bedrock/Vertex/Foundry 的请求与 stream 行为保持不变。
2. `provider/model`、profile key、旧 Anthropic alias 的解析结果可在启动诊断中区分；请求期间使用固定 `ResolvedModel`。
3. 任一模型的 context/tools/thinking/images 能力都可显式声明；未声明能力不会进入请求 body。
4. `request_headers.rs` 的 common header 不含 `anthropic-beta`；Anthropic beta、OAuth 和特殊 auth 只由 Anthropic adapter 生成。
5. OAuth side effect gate 为 false 时，Claude.ai refresh 持久化仍失败并明确报错，但 API key、OpenAI-compatible、Gemini、vLLM、Ollama 不受影响。
6. key file、env、OAuth、无认证四类 credential source 都有 provider-independent resolver contract 和 provider-specific typed material；日志不含 secret。
7. 子 agent 的 `inherit` 继承父 `ResolvedModel`；显式 provider/model 不支持所需工具时 fail before request，不静默换模型。
8. Decision Provider 的 `fast/accurate` 仅是 tier；可以分别绑定不同 provider，down/timeout/low-confidence 仍回到确定性路径。
9. `modelContextWindows` 旧 map 只作为迁移 fallback；显式 `models.*.capabilities.contextWindow` 永远优先。
10. 新配置 PR 不删除旧字段、不重置 prompt cache、不改变权限硬边界；迁移 dry-run 不写 secret。
