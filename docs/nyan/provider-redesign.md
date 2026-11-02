# Provider / Model 抽象重设计

状态：设计稿（2026-11-02 修订），只读审计后产出，未实现。

本文只描述目标设计，不修改运行时实现。nyan 当前没有需要保护的用户配置，因此本设计直接替换旧模型/provider 配置，不提供兼容迁移层。

## 0. 结论摘要

nyan 的目标是 provider 无关的通用 agent，而不是把 Anthropic API 当作运行时抽象。目标运行时分层如下：

```text
settings.nyan / CLI / session
        ↓
ProviderCatalog + ModelCatalog + CredentialResolver
        ↓
Provider-neutral Request IR
        ↓
Provider adapter
        ↓
normalized stream / usage / error / retry policy
```

已确定的核心原则：

1. 新配置统一放在 `settings.nyan.providers`、`settings.nyan.models`、`settings.nyan.selection`；旧模型/provider 字段直接删除，不做兼容迁移。
2. 稳定配置只能引用 profile 名；`provider/model` 直写只允许命令行或单个会话临时使用，不能写入 project settings。
3. 模型能力来自固定的、外部维护的模型元数据快照；不做运行时探测。profile 中显式能力覆盖元数据快照。
4. 不设默认 provider。没有可解析的 profile 时清晰报错或进入配置引导，绝不偷偷回退 Anthropic。
5. Provider 协议由 adapter 隔离：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini；vLLM/Ollama 只走 OpenAI-compatible，不做 Ollama native adapter。
6. OAuth 由各 provider 自己管理，不做统一 broker。凭据 resolver 只提供 provider-scoped 的存取边界。
7. Project settings 只能引用 user/managed settings 已定义的 profile 名，不能新增 endpoint 或 credential file。
8. Decision Provider 暂时只允许商业模型；本地 profile 即使支持分类能力，也不能绑定到 Decision Provider。
9. 主请求默认不跨 provider 自动重试；只有用户显式配置的 fallback 列表才允许切 provider。
10. Windows key file 必须通过 owner-only ACL 验证；无法验证就拒绝使用，并说明原因。

本文的接口是设计形状，不是要求一次性实现的代码 API。

## 一、现状审计

### 1.1 Settings、环境变量和启动覆盖

当前 `SettingsJson` 的普通模型字段是 `model`、`availableModels`、`modelOverrides`、`advisorModel`，另有 `env` 和 `httpHeaders`（`src/utils/settings/types.rs:60-85,122-124`）。nyan 自己的扩展集中在 `nyan` 顶层 key 下（`src/utils/settings/nyan.rs:1-19`）。目标配置会继续放在这个命名空间，但 `model`、`availableModels`、`modelOverrides` 等旧字段不再作为 provider 配置入口。

当前 settings 来源和合并顺序是 `userSettings → projectSettings → localSettings → cli flag → managed policy`；policy 最后覆盖前面的值（`src/utils/settings/constants.rs:89-105`、`src/utils/settings/mod.rs:246-300`）。新设计保留这个来源机制，但增加来源作用域约束：

- provider/profile 定义只来自 user 或 managed settings；
- project/local settings 只能写 profile 名、选择关系和不含 endpoint/credential 的策略；
- CLI 可临时指定 profile 或 `provider/model`，不落盘；
- policy 可以定义或限制 profile，并可限制 provider、模型、fallback 和本地 endpoint。

### 1.2 当前模型/provider 选择链

当前主模型链是：

```text
CLI / bootstrap override
  → ANTHROPIC_MODEL
  → settings.model
  → Anthropic build-audience 默认模型
```

入口在 `src/main.rs:264-291`、`src/utils/model/model.rs:77-102,138-163`；`sonnet`、`opus`、`haiku`、`best`、`opusplan` 和 `[1m]` 是 Anthropic 专属别名（`src/utils/model/model.rs:104-135`）。当前 provider 由 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY` 环境变量决定（`src/utils/model/providers.rs:7-27`），没有统一 provider trait。

这些旧入口只用于现状审计。目标实现中它们被删除：不再读取 `settings.model`、`ANTHROPIC_MODEL`、`GlobalConfig.modelContextWindows`，也不再保留 Anthropic 默认 provider。

### 1.3 Gateway model picker 与上下文窗口

当前 picker 将 `availableModels` 追加到内置 Sonnet/Opus/Haiku（`src/components/model_picker.rs:57-145`）；`additionalModelOptionsCache` 只提供 label/description。`modelOverrides` 将 Anthropic canonical ID 映射成 provider-specific ID（`src/utils/settings/types.rs:75-77`、`src/utils/model/model_strings.rs:63-103`）。

当前 `GlobalConfig.modelContextWindows` 是 gateway 专用旁路，按 model ID 查上下文长度（`src/utils/context.rs:126-154`，字段在 `src/utils/config.rs:617-621`）。目标设计删除这条旁路，统一使用固定模型元数据 + profile override；不存在“查不到时默认 200k”的隐式行为。

### 1.4 请求构造与 Anthropic 专有部分

当前请求链是：

```text
query loop
  → get_anthropic_client()
  → build_sdk_message_create_plan()
  → anthropic_sdk::BetaMessageCreateParams
  → provider-specific SDK / stream parser
```

client factory 构造 Direct、Bedrock、Foundry、Vertex 四种 Anthropic SDK client，并同时处理 header、OAuth refresh、API key、proxy、timeout 和 provider auth（`src/services/api/client.rs:1-9,152-163,184-246,291-515`）。请求 body 直接使用 `BetaMessageCreateParams`，stream parser 直接处理 Anthropic content block delta（`src/services/api/claude.rs:2027-2116,2264-2403,3010-3175`）。

当前 header 已有可复用边界：

- common：`User-Agent`、`x-app`（`src/services/api/request_headers.rs:12-21`）；
- Anthropic adapter：session/container/remote header（`:23-50`）；
- `anthropic-beta` 只由 Anthropic 请求使用（`:52-58`）；
- `httpHeaders` 最后覆盖同名 header（`:60-82`）。

OAuth、beta、cache control、Bedrock/Vertex/Foundry auth 和 Anthropic SDK 类型都必须留在 Anthropic adapter 或其 credential owner 中。`OAUTH_CREDENTIAL_SIDE_EFFECTS_ENABLED=false`（`src/constants/oauth.rs:40-47`）继续只影响 Anthropic OAuth，不成为全局 provider 开关。

### 1.5 子 agent 和 Decision Provider

当前子 agent 选择优先级是 `CLAUDE_CODE_SUBAGENT_MODEL` → tool model → agent definition model → `inherit`（`src/utils/model/agent.rs:21-93`），并在 Bedrock 下继承 region prefix。目标设计删除这些旧 env/model alias 入口，改为 profile 名或父 agent 的 `ResolvedModel`。

当前 Decision Provider 用 `fast` / `accurate` 映射 EMRank 模型（`src/utils/settings/nyan.rs:838-902`、`src/services/decision/mod.rs:48-137`）。目标保留 tier 概念，但 tier 只能绑定标记为 `commercial: true` 的 profile；本地 provider 不得进入 Decision Provider。

## 二、已定决策

以下 12 条是本设计的约束，不再作为待选项：

1. **配置位置与替换**：新配置统一在 `settings.nyan.providers` / `models` / `selection`；直接替换旧配置。nyan 当前没有用户，因此不做兼容迁移、导入、deprecated 读取或旧字段警告。
2. **模型引用**：持久化配置以 profile 名为主。`provider/model` 只允许 CLI 或单个 session 临时使用，不能写入 project settings。
3. **能力元数据**：不做运行时探测；采用 Pi Agent 维护的固定模型元数据快照，profile 显式字段可覆盖快照。
4. **无默认 provider**：用户必须配置 provider/profile。没有可解析 profile 时给清晰错误或配置引导，不回退 Anthropic。
5. **OpenAI 两种协议**：Chat Completions 与 Responses API 在同一阶段实现，分别作为可声明的 adapter protocol。
6. **Ollama**：不实现 Ollama native adapter；Ollama 只能配置为 OpenAI-compatible endpoint。vLLM 同样走 OpenAI-compatible。
7. **OAuth**：各 provider 自己管理 OAuth、refresh、token schema 和持久化；不做统一 OAuth broker。Pi Agent 与 CLIProxyAPI 只作为设计参考，不作为运行时依赖。
8. **Project settings 边界**：project settings 绝对不能新增 endpoint 或 credential file，只能引用 user/managed settings 已定义的 profile 名。
9. **Decision Provider**：暂时只允许商业模型 profile，不能绑定本地 provider。
10. **旧字段删除**：直接删除 `settings.model`、`ANTHROPIC_MODEL`、`GlobalConfig.modelContextWindows` 的读取逻辑与配置入口；不保留兼容路径。
11. **跨 provider fallback**：默认禁止跨 provider 自动重试；只有用户显式配置的 fallback profile 列表允许切换 provider。
12. **Windows key file**：必须验证 owner-only ACL；无法验证就拒绝使用，并说明需要改用环境变量或系统凭据。

## 三、目标抽象

### 3.1 Provider、profile 和模型引用

```rust
pub struct ProviderId(pub String);       // anthropic, openai, gemini, local-vllm
pub struct ModelProfileId(pub String);   // main, review, local-fast

pub struct ModelRef {
    pub profile: ModelProfileId,
    pub provider: ProviderId,
    pub model: String,                   // provider wire model id
}

pub struct ResolvedModel {
    pub reference: ModelRef,
    pub display_name: String,
    pub capabilities: ModelCapabilities,
    pub credential_profile: String,
    pub endpoint: Endpoint,
    pub commercial: bool,
}
```

持久化 `selection` 只写 profile 名。CLI/session 临时输入 `provider/model` 时先解析为一个不可持久化的临时 `ResolvedModel`，请求结束即丢弃。project settings 不能写 provider/model 直写值，也不能定义 profile 内容。

### 3.2 能力模型

```rust
pub struct ModelCapabilities {
    pub context_window: u32,             // 必填才能运行
    pub max_output_tokens: u32,
    pub tools: ToolCapability,
    pub thinking: ThinkingCapability,
    pub images: ImageCapability,
    pub structured_output: bool,
    pub streaming: bool,
    pub prompt_cache: CacheCapability,
}
```

能力至少覆盖上下文长度、工具调用、thinking、图片；同时声明结构化输出、流式和 prompt cache，因为它们会改变请求形状。未知能力按不支持处理，不通过请求 probe 猜测。

### 3.3 Pi Agent 模型元数据：来源、格式、许可证和更新

采用 [earendil-works/pi](https://github.com/earendil-works/pi) 的 `packages/ai` 模型目录作为首个外部元数据来源。仓库许可证为 MIT；nyan 不复制 Pi runtime，仅引入生成后的数据快照，并在发行物/源码中保留 MIT NOTICE 与来源 commit。

Pi 的元数据结构可直接覆盖 nyan 的核心字段：

- `packages/ai/src/providers/model-schema.ts` 定义 schema；
- `packages/ai/src/types.ts` 的 `BaseModel` 包含 `id`、`name`、`api`、`provider`、`baseUrl`、`input`、`inputLimits`、`cost`；
- chat `Model` 额外包含 `reasoning`、`thinkingLevelMap`、`promptCache`、`contextWindow`、`maxTokens` 和 API compatibility overrides；
- `packages/ai/src/providers/*.models.ts` 是 provider-specific source shards；
- `packages/ai/src/providers/data/*.json` 是生成的数据；`models.generated.ts` 聚合 provider shards；
- `packages/ai/scripts/model-data.ts` 校验 schema version、provider 文件、manifest、structure hash 和每个生成文件的 SHA-256；
- `.github/workflows/publish-model-catalog.yml` 在 CI 成功后按工作日计划生成、校验并发布 catalog artifact。该 workflow 不是 nyan 的运行时依赖，nyan 只消费经过 pin 的快照。

引入方式：

1. 在 nyan 中新增一个**生成数据导入 PR**，记录 Pi commit/tag、model catalog schema version、生成时间和 MIT NOTICE；不引入 Pi 的 TypeScript/Bun runtime。
2. 将 Pi 的 JSON model catalog 转换成 nyan 自己的稳定 JSON schema，保留 source commit 和原始 provider/model ID；生成 Rust 静态数据或 checked-in resource，不在启动时联网。
3. 做 schema/hash 校验：缺 `contextWindow`、`maxTokens`、`input`、`reasoning` 或 provider/api 的条目不能进入可运行 catalog；上游新增字段默认忽略，schema breaking change 必须人工审查。
4. 更新走显式 PR：升级 source commit，重新生成快照、跑校验、更新 NOTICE 和变更说明；不自动拉取远端元数据，不因上游 catalog 变化而改变用户运行时行为。
5. Pi catalog 的 `reasoning` 映射为 thinking 候选，`input` 中的 `image` 映射为图片能力，`contextWindow`/`maxTokens`/`promptCache`/`inputLimits` 映射为同名能力；工具支持仍由 adapter protocol 与 profile override 共同决定，因为 Pi 的 BaseModel 并不把“tools”作为单独通用布尔字段。

如果未来需要第二个来源，必须先定义来源优先级、许可证和字段冲突规则；不能把多个 catalog 在运行时无规则合并。

### 3.4 Provider protocol

| protocol | 覆盖 | 阶段 | 关键差异 |
|---|---|---|---|
| `anthropicMessages` | Anthropic API、Anthropic-compatible gateway、Bedrock/Vertex/Foundry 的 Anthropic wire 变体 | Anthropic adapter 阶段 | system blocks、thinking、tool schema、beta、cache control、SSE/专用 transport |
| `openaiChat` | OpenAI Chat Completions、OpenRouter、vLLM、Ollama OpenAI-compatible endpoint | OpenAI 阶段 | `messages` content parts、tool calls、JSON response format、usage/finish reason |
| `openaiResponses` | OpenAI Responses API 与兼容 Responses endpoint | OpenAI 阶段，与 `openaiChat` 同 PR | `input` items、response output items、reasoning、background/continuation 语义 |
| `gemini` | Gemini API / Vertex Gemini | 后续独立阶段 | `contents`/`parts`、function call、thought parts、inline data |

不提供 `ollama` protocol。Ollama profile 必须声明 `protocol: openaiChat`，并把 Ollama 特有的 endpoint/header/body 差异限制在 OpenAI-compatible adapter 的显式 compatibility options 中；首版不实现 Ollama native API。

### 3.5 Provider-neutral Request IR

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

`ModelRequest` 包含消息、system blocks、tools、tool choice、thinking preference、图片、output limit 和 query source，但不包含 provider header/beta。adapter 负责 wire body、stream normalization、usage、stop reason、request id 和 provider-specific error mapping。

## 四、建议配置格式

### 4.1 Provider、profile 和 selection

```jsonc
{
  "nyan": {
    "providers": {
      "anthropic": {
        "protocol": "anthropicMessages",
        "baseUrl": "https://api.anthropic.com",
        "credential": { "oauth": "anthropic-claude-ai" },
        "commercial": true
      },
      "openai": {
        "protocols": ["openaiChat", "openaiResponses"],
        "baseUrl": "https://api.openai.com/v1",
        "credential": { "env": "OPENAI_API_KEY" },
        "commercial": true
      },
      "local-vllm": {
        "protocol": "openaiChat",
        "baseUrl": "http://127.0.0.1:8000/v1",
        "credential": { "optionalEnv": "VLLM_API_KEY" },
        "commercial": false
      },
      "local-ollama": {
        "protocol": "openaiChat",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "credential": { "none": true },
        "commercial": false
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
      "mainFallbacks": [],
      "subagent": "inherit",
      "subagents": {
        "Explore": "main",
        "Plan": "main"
      },
      "decision": {
        "fast": "main",
        "accurate": "main"
      }
    }
  }
}
```

规则：

- `selection.main` 是必填的 profile 名；未配置或 profile 不存在时，启动进入配置引导/返回明确错误；不使用内置 Anthropic default。
- `mainFallbacks` 是用户显式允许的 fallback profile 列表，默认空；不配置就不跨 provider 自动切换。
- `selection.subagent` 和 `subagents.*` 只能是 profile 名或 `inherit`；project settings 可以引用 user/managed 中存在的名字，但不能定义 provider/profile 内容。
- `provider/model` 直写只接受 CLI/session 临时输入，必须带“不落盘”语义。
- profile 的 `capabilities` 覆盖 Pi snapshot；覆盖值必须经 schema 校验，不能把未声明能力自动设为 true。
- profile 定义只能写在 user 或 managed settings。project/local settings 只能写 profile 名、选择关系和 policy，不得写 `baseUrl`、`credential.file`、secret、OAuth client data 或任意新的 provider ID。

### 4.2 Credential 引用与 OAuth owner

```jsonc
{
  "credential": { "env": "OPENAI_API_KEY" },
  "credential": { "file": "~/.nyan/keys/openai" },
  "credential": { "optionalEnv": "VLLM_API_KEY" },
  "credential": { "oauth": "anthropic-claude-ai" },
  "credential": { "oauth": "openai-codex" }
}
```

credential reference 只引用来源，不把 secret 写入 settings：

- `env`：读取指定变量；未设置是 `missingCredential`；
- `file`：单行读取；Unix 要求 0600；Windows 必须验证 owner-only ACL，无法验证立即拒绝并说明需要 env 或系统凭据；
- `optionalEnv`：允许无认证本地 endpoint，但收到 401 仍报告 auth error；
- `oauth`：绑定一个 provider-owned OAuth profile，flow、refresh、token schema、存储和删除都由该 provider owner 实现。

**Pi Agent 参考**：

- `packages/ai/src/auth/oauth/load.ts` 明确按 provider 注册 OAuth loaders：Anthropic、OpenAI Codex、OpenAI ChatGPT、GitHub Copilot、OpenRouter、Kimi Coding、Meta、xAI，以及可参数化的 Radius；每个 flow 是独立模块，不是统一 token broker。
- `packages/coding-agent/src/core/auth-storage.ts` 使用 `auth.json` 文件存储，以 provider id 为 key；OAuth credential 包含 access、refresh、expires，API key 支持 env indirection；写入使用锁，目录默认 0700、文件创建 mode 0600，并处理 Windows 删除 pending 的锁重试。
- Pi 的 OAuth module 使用 PKCE、loopback callback 或手工粘贴 redirect/code；provider-specific endpoint 和 scope 位于各自的 OAuth module。

**CLIProxyAPI 参考**：

- [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 `internal/auth/` 按 provider 拆分 Claude、Codex/OpenAI、Gemini/Vertex/Antigravity、Kimi、Devin、Meta、xAI 等 auth/refresh/token 实现；README 也把 Claude Code、Codex、Gemini、Grok、Kimi、Devin 等列为独立登录/路由能力。
- `sdk/auth/filestore.go` 的 `FileTokenStore` 遍历配置的 auth directory，保存 provider-specific JSON；创建目录使用 0700，文件使用 0600；每个 provider 通过自己的 `TokenStorage` 序列化和刷新。
- `internal/auth/claude/filename.go`、`internal/auth/codex/filename.go` 按 provider/account identity 生成文件名，保留 legacy filename fallback；这说明多账户隔离应在 provider owner 中完成，而不是由统一 broker 猜 token 格式。
- CLIProxyAPI 是 Go gateway/proxy，不作为 nyan 的运行时依赖；nyan 只借鉴“provider-specific OAuth + per-account file store + refresh owner”的边界。

Pi 和 CLIProxyAPI 都是 MIT 许可（以各自仓库 LICENSE 为准）；nyan 不复制其实现。引用的设计、字段和文件存储模式需要在实现 PR 中保留来源链接、版本/commit 和许可证说明。用户需要决定是否接受把 provider OAuth 凭据以本地加密/权限保护文件形式存储，还是首批只支持 env/key file。

## 五、模型选择协议

### 5.1 主模型与 session 临时模型

持久化选择只有 profile 名：

```text
CLI --profile / --model provider/model（临时）
  > session /model profile 选择（只改当前 session）
  > settings.nyan.selection.main（profile 名）
  > 无配置：清晰引导/错误
```

没有 built-in default。选择器展示 profile 名、provider、协议、能力和 context window；没有 profile 时展示配置引导，不生成 Anthropic fallback。

### 5.2 子 agent

```text
explicit agent profile
  > agent definition profile
  > inherit parent ResolvedModel
  > selection.subagents.<agent-type>
```

`inherit` 继承父 `ResolvedModel` 的 provider、model、capabilities snapshot 和 credential profile。子 agent 的显式值必须是 profile 名；`provider/model` 只能作为同一个 session 的临时 tool/CLI 输入，不能写回 project settings。若显式 profile 不支持 tools/thinking/images，启动前返回 capability error，不静默换模型。

### 5.3 Decision Provider

`fast` / `accurate` 是逻辑 tier，但只允许选择 `commercial: true` 的 profile：

```jsonc
{
  "nyan": {
    "selection": {
      "decision": {
        "fast": "commercial-fast",
        "accurate": "commercial-accurate"
      }
    }
  }
}
```

约束：

1. profile 必须支持闭集结构化输出、足够的 context window，并标记 commercial；
2. local-vLLM、Ollama、其它 `commercial: false` profile 在 schema/resolver 阶段拒绝；
3. Decision Provider 的 fallback 也只能来自显式 commercial fallback 列表；
4. down/timeout/low-confidence 仍回到确定性路径，不切到主 agent profile；
5. 保留现有 `off/shadow/active` 语义和 credential redaction，不改变硬安全规则。

## 六、上下文窗口、token 计算与缺失元数据

### 6.1 没有声明 context window 时

`contextWindow` 是可运行 profile 的必填能力：

- Pi 快照有 `contextWindow` 时直接导入；
- profile 显式 override 时使用 override；
- 两者都没有时，profile 解析失败，不能发送请求；
- 不使用旧的 `modelContextWindows`、200k 默认值、模型名称猜测或 runtime probe。

这样做会让缺元数据的 profile 立即暴露配置错误，而不是在长对话中随机 overflow。

### 6.2 token 计数规则

即使 profile 无法运行，诊断仍可显示估算 token：

1. 预请求使用 provider-neutral 的现有 rough estimator，按文本、tool schema、图片引用和消息结构估算；它用于 UI/诊断，不声称与 provider tokenizer 精确一致；
2. 发送前用 `contextWindow - reservedOutputTokens - safetyMargin` 做 admission；任何无法计算的图片/二进制 part 按 profile 的 `inputLimits` 或保守上限计入；
3. provider 返回的 usage 是事后权威值，按 provider adapter 归一化记录；不回写成新的能力元数据；
4. contextWindow 缺失时没有 admission threshold，也不启动自动 compaction 试探；先报 profile invalid；
5. `maxOutputTokens` 取 profile/元数据与 provider adapter 上限的较小值，不能因未知而使用无限或旧 Anthropic 默认。

### 6.3 Cache 与 token 统计

`promptCache` 只描述已知的 provider cache 语义；未知时按 none。cache 命中、写入和读取 token 只在 provider 返回 usage 后记录，不用猜测或跨 provider 迁移 cache receipt。

## 七、限流、错误和重试语义

### 7.1 统一错误模型

adapter 把 provider 错误归一化为：

```text
rateLimited { retryAfter, providerWindow? }
overloaded
transient { status, retryable }
contextOverflow
invalidRequest
unauthorized
forbidden
notFound
transport
partialStream
```

原始 status、Retry-After 和 provider-specific rate-limit headers 只进入安全的 request receipt；不把 token 或完整响应写日志。

### 7.2 默认重试规则

- 同一 provider 的**请求尚未产生可见输出**时，才允许对明确的 transient/rate-limited/overloaded 错误重试；默认最多 2 次，指数退避 + jitter，并受 `maxRetryDelay` 限制；
- 优先尊重标准 `Retry-After`；provider adapter 可解析自己的 reset headers，但不能把某家 header 当成通用协议；
- 一旦流已经产生 normalized output，连接失败返回 `partialStream`，不自动重放整个请求，避免重复工具调用和重复副作用；
- 400/401/403/404、能力不支持、上下文溢出和 schema 错误不重试；
- provider 选择不因 429/5xx 自动改变。跨 provider 只有在用户显式提供 `mainFallbacks`/对应 tier fallback 列表时才允许，并记录 provider switch；
- fallback 列表按顺序尝试，每个 profile 使用自己的 credential、协议、rate-limit policy 和 capability snapshot；列表为空就是不 fallback。

### 7.3 各协议语义

| provider/protocol | 限流/暂态信号 | 默认处理 |
|---|---|---|
| Anthropic Messages | HTTP 429、529 overloaded、408/5xx；优先 `Retry-After` 与 Anthropic rate-limit headers | 未输出前最多 2 次同 provider retry；429/529 不自动切其它 provider |
| OpenAI Chat Completions | HTTP 429、408/5xx；优先 `Retry-After`，可记录 `x-ratelimit-*` reset 信息 | 与 Responses 共用 retry controller，但 adapter 分别解析 body/error；流已输出则 partialStream |
| OpenAI Responses | HTTP 429、408/5xx，以及 Responses-specific error body | 与 Chat 同阶段实现；不得把 Responses continuation 当成可安全重放的完整请求，除非尚未产生输出 |
| Gemini | 429/503 或 provider 明确标为 `RESOURCE_EXHAUSTED`/暂态的响应；优先标准 retry hint | adapter 负责把 Google error reason 映射为 rateLimited/overloaded；无 hint 时使用受限指数退避 |
| OpenAI-compatible vLLM/Ollama | 只依赖标准 HTTP 429/408/5xx；不假设某个 gateway header | profile 默认可关闭 retry；开启后只在同 endpoint 重试，跨 provider 仍需显式 fallback |

“各家 provider 支持什么 header/错误码”属于 adapter contract 和测试 fixture，不在公共层硬编码。provider 更新 rate-limit 语义时更新 adapter 与 fixture，不修改用户配置含义。

## 八、替换路径（不是兼容迁移）

nyan 没有用户，因此实现阶段直接删除旧入口：

- 从 `SettingsJson` 删除 `model`、`availableModels`、`modelOverrides` 等旧 provider/model 配置入口；
- 删除 `ANTHROPIC_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` 等旧模型选择读取；
- 删除 `GlobalConfig.modelContextWindows` 和 `gateway_context_window`；
- 删除基于 Anthropic build audience 的隐式默认模型/默认 provider；
- 删除旧 `availableModels` picker allowlist 的读取；picker 只展示已解析 profile；
- 不写 migration command、dry-run、旧字段 warning、备份导入或 legacy fallback；
- 旧环境变量即使存在也不影响新 resolver，错误信息直接指出应配置 `settings.nyan.providers/models/selection` 或 CLI 临时 profile。

当前代码中的旧字段和调用链保留在本节之前仅作为审计证据，不是目标行为。

## 九、分阶段实施计划（每阶段可单独 PR）

| PR | 内容 | 独立验收 | 主要风险 |
|---|---|---|---|
| 1. provider/profile schema replacement | 新增 `settings.nyan.providers/models/selection`、profile scope、无默认 provider；删除旧 `settings.model`、`ANTHROPIC_MODEL`、`modelContextWindows` 读取和 schema；不接请求 | 无配置时清晰引导/错误；只能解析 profile；project 只能引用 user/managed profile；旧字段不再生效 | strict schema、settings source scope、删除旧调用点不完整 |
| 2. pinned model metadata | 导入 Pi MIT catalog 的转换格式、source commit/schema manifest、NOTICE、profile override 和 context/token validation | 快照 hash/schema 校验；缺 contextWindow 的 profile 被拒绝；更新只通过显式 PR | 上游数据变化、许可证/NOTICE、Pi schema breaking change |
| 3. credential owner and OAuth | env/key file/OAuth reference、provider-specific credential owner；Pi/CLIProxyAPI 参考的 per-provider OAuth；Windows owner-only ACL | env、OAuth、key file mock；Windows ACL 无法验证时拒绝；无 secret 日志 | token schema差异、refresh side effects、Windows ACL |
| 4. request IR + Anthropic adapter | 公共 message/tool/image/thinking/usage/error IR；Anthropic client、headers、betas、Bedrock/Vertex/Foundry 接入 adapter | Anthropic mock 请求与 stream fixture；OAuth gate 仍只作用 Anthropic | cache prefix、beta、stream/tool/thinking 改变 |
| 5. OpenAI adapters | **同一阶段**实现 Chat Completions 和 Responses；tools/images/streaming/structured output/usage/error | 两种协议各自 mock contract；同一 profile 不能混淆 chat/responses；未输出重试与 partialStream | 两种 wire shape、tool call streaming、retry/replay |
| 6. OpenAI-compatible local + Gemini | vLLM/Ollama 只走 OpenAI-compatible；Gemini adapter 独立实现；不做 Ollama native | local endpoint mock；Gemini parts/function/thinking fixture；无本地 provider 进入 DP | gateway 方言、图片/thinking转换、本地 timeout |
| 7. selector and subagent | profile-only picker、main/session CLI、`inherit` snapshot、per-agent profile、project scope enforcement | 无默认 provider；临时 `provider/model` 不落盘；子 agent capability validation | session snapshot、显式 profile 优先级 |
| 8. retry/fallback/health | normalized errors、各 adapter rate-limit policy、同 provider retry、显式 fallback 列表；禁止隐式跨 provider | 429/Retry-After/529/503/stream partial fixture；空 fallback 不切 provider；switch receipt | 重复工具调用、provider header drift |
| 9. commercial Decision Provider | `fast/accurate` tier 绑定 commercial profile；拒绝 local profile；保留 off/shadow/active | local profile schema rejection；down/timeout 回确定性路径；fallback 仍只 commercial | classifier 费用/延迟、来源隐私 |

没有 migration/deprecation PR。第 1 PR 完成后，旧字段和旧读取路径应不存在；后续 PR 不得重新引入兼容读取。

## 十、风险与防护

| 风险 | 影响 | 防护 |
|---|---|---|
| Pi catalog 上游字段/许可证变化 | 能力或分发合规错误 | pin commit/schema/hash；显式更新 PR；保留 MIT NOTICE；schema breaking 必须人工审查 |
| 缺 contextWindow | 请求 overflow 或错误 compaction | profile 解析直接失败；不使用旧 200k/default/probe |
| provider rate-limit 语义不同 | 重试过多、重复请求、错误切 provider | adapter-specific policy；只在未输出时 retry；跨 provider 只走显式列表 |
| Chat/Responses 混淆 | tool/continuation 丢失 | 独立 protocol adapter 和 contract fixture；profile 明确协议 |
| 统一 OAuth broker 误用 token | token scope、刷新、存储和撤销错误 | provider-owned OAuth modules；credential profile 按 provider 隔离 |
| Windows key file ACL 不可验证 | secret 被同机其他账户读取 | ACL 验证失败即拒绝；提示使用 env/系统凭据 |
| Project settings 注入 endpoint | 项目文件劫持请求或泄露凭据 | schema/source scope 禁止 endpoint/credential file，只接受 profile name |
| 无默认 provider | 首次启动体验差 | 清晰配置引导、列出缺失字段和可用 CLI 临时选项；不静默 fallback |
| 本地模型误进 Decision Provider | 分类数据外发/质量和延迟不可控 | `commercial` capability + schema hard gate；tier fallback 同样检查 |
| OpenAI-compatible gateway 方言 | 请求字段不兼容 | protocol compatibility options 显式配置；adapter fixture；不 runtime probe |
| OAuth 文件并发写 | token 丢失/refresh race | 参考 Pi 的 file lock；provider owner 按 provider/account 串行化 |

安全边界：provider adapter 不得改变权限系统的 hard deny、路径检查、凭据 redaction 或 hook/user decision。模型能力、fallback 和 retry 也不能绕过这些边界。

## 十一、仍需用户拍板的问题

12 条产品决策已经固定；实现前还需要确认以下调研衍生问题：

1. **Pi catalog 的引入形态**：接受把 Pi 的 MIT 生成 JSON 快照复制为 nyan checked-in resource，并随 nyan 保留 NOTICE/source commit，还是需要只在构建时下载、不把数据提交进仓库？（推荐 checked-in snapshot，保证可复现。）
2. **Pi 快照更新节奏**：按 Pi release、固定月度 PR，还是仅在 provider/model 变更时手动更新？（推荐显式 PR，不自动跟随 Pi 的 hourly publication。）
3. **元数据冲突**：Pi 数据缺失或错误时，是否允许 profile override 覆盖全部能力字段，还是只允许 context/maxOutput 等安全字段覆盖？（推荐允许用户 profile 覆盖，但 managed policy 可限制上限和能力。）
4. **首批 OAuth provider 清单**：是否首批只做 Anthropic、OpenAI Codex/ChatGPT、Gemini/Vertex，GitHub Copilot、OpenRouter、Kimi、xAI 等后置？Pi 和 CLIProxyAPI 都支持更多 provider，但每个 OAuth flow 都是独立维护成本。
5. **OAuth 文件 vs 系统凭据**：是否接受首批使用 provider-scoped `~/.nyan/keys`/auth 文件，随后补 Windows Credential Manager、macOS Keychain 和 Linux secret service？（Windows key file ACL 的拒绝规则已经固定。）
6. **商业模型判定**：`commercial: true` 是用户在 profile 中写，还是只能由 managed policy/内置 catalog 授权？（推荐 user 可标记，但 Decision Provider 只接受 managed allowlist 或内置 catalog 认可的 profile。）
7. **同 provider retry 默认值**：各 provider 默认最多 2 次是否合适？是否给 managed policy 一个全局最大预算？
8. **Gemini 阶段**：是否与 OpenAI 阶段并行实现，还是作为下一 PR，尽管 OpenAI Chat/Responses 必须同阶段？
9. **OpenAI-compatible fallback**：vLLM/Ollama endpoint 是否允许用户显式加入主模型 fallback 列表？（推荐允许主请求，但永远禁止进入 Decision Provider。）

## 十二、验收标准

1. `settings.nyan.providers/models/selection` 是唯一持久化模型/provider 配置；无配置时不产生请求且给出明确引导/错误。
2. `settings.model`、`ANTHROPIC_MODEL`、`GlobalConfig.modelContextWindows` 和旧 alias 不再被读取。
3. profile 是唯一稳定模型引用；project settings 只能写已有 profile 名，不能写 endpoint、credential file 或 `provider/model`。
4. Pi snapshot 有 source commit、schema version、hash 和 MIT NOTICE；更新不是 runtime 网络行为。
5. profile 没有 contextWindow 时解析失败；有值时预请求使用保守估算，事后使用 provider usage，不使用隐式 200k。
6. Anthropic beta/OAuth/cache/auth 只由 Anthropic adapter 处理；OpenAI Chat/Responses、Gemini 不收到 Anthropic beta。
7. OpenAI Chat Completions 与 Responses 在同一阶段分别通过 contract fixture；vLLM/Ollama 只使用 OpenAI-compatible，不能选择 Ollama native protocol。
8. OAuth credential schema、refresh、storage 和 account isolation 按 provider owner 分开；Pi/CLIProxyAPI 仅为参考，不成为依赖。
9. Windows key file ACL 无法验证时拒绝使用；日志和错误不显示 secret。
10. Decision Provider 只接受 commercial profile；local profile 及其 fallback 均被拒绝。
11. 429/overload/5xx 的 retry 使用 adapter-specific 语义；stream 已产生输出后不重放；跨 provider 只在显式 fallback 列表中发生。
12. 所有 PR 阶段可单独测试；没有迁移 PR，也没有旧字段兼容读取或自动 fallback。
