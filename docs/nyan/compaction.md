# 压缩（Compaction）设计

状态：已定稿，未实现（2026-10-27）。cache 保活（C12）与 ContentReplacementState 默认开启已确认；C13 已查清
（统计口径错误 + 网关侧断崖 + 子代理缺 Agent-Id，新增切片 G）。

本文是 nyan 在 CometixCode（Claude Code 的 Rust 移植，下称 CC）之上的二次开发设计。设计来源是
nyan-legacy 的 N4 定稿（`.agents/notes/proposed/architecture/2026-10-22-n4-slices-and-admission-design.md`）
和 durable spec §8.7，按 CC 的现有结构落地。所有有意偏离 CC 的代码位置用 `@nyan` 注释标注，与上游的
`@cometix offset` 区分。

**定位**：CC 的压缩方案是成熟的基座，本设计是在它之上**补充与轻改**，不是替换。从 legacy 取的是设计思想
（先清后摘、清而不删、失败不伪装、cache 不因时间失效），实现优先复用 CC 现有机制；legacy 的具体实现与 CC
冲突时（例如摘要请求形态），以 CC 为准、只移植思想。

## 一、为什么这样设计

本机 cometix 的 4 个真实会话里，工具结果占发给模型内容的 54%–83%（按块类型统计字符数）；nyan-legacy
在 22 个 durable 会话上测得 94.9%。两组数据的结论相同：**清掉旧工具结果是主路径，摘要是例外**。legacy
的量化还表明：阈值取单条占预算 1% 明显好于 2%/5%，"保留最近 2 轮"与"8 轮"差别很小。

CC 现状的问题：

| 现状 | 位置 | 问题 |
|---|---|---|
| time-based microcompact | `services/compact/micro_compact.rs:379-438` | 空闲 60 分钟才触发；直接改写 `messages_for_query`，不冻结、不持久化；每次清理后 `reset_microcompact_state()`，prompt cache 整段失效 |
| 工具结果替换 `ContentReplacementState` | `utils/tool_result_storage.rs:36` | 机制正确（按 id 冻结、字节一致重放、`content-replacement` 条目持久化、resume 重建），但默认关闭（`feature_flags.rs:470`），且只按单条消息 200k 字符预算触发 |
| autocompact | `services/compact/auto_compact.rs:198` | 超阈值就把全部历史交给主模型摘要；不保留任何原文尾部 |
| 摘要校验 | `services/compact/compact.rs:644-672` | 只拒绝空文本与 `API Error`；不看 `stop_reason`，截断的摘要会被当成完整摘要 |
| Read 去重 | `tools/file_read_tool/mod.rs:1038-1061` | 同文件同范围且 mtime 未变时只回"参考之前的结果"；若之前的结果已被清掉，模型拿不到内容 |

## 二、流水线

每次模型请求前（`query.rs` 中 microcompact 位置），替换 CC 的 time-based 路径：

```
boundary 之后的视图
  → measure：估算上下文 token（扣除已掩码的部分）
  → 未超阈值 ─────────────────────────────▶ continue
  → 超阈值 → mask：清可清的旧工具结果（冻结、持久化）
           → 重新 measure
           → 回到阈值内 ──────────────────▶ continue
           → 仍超 → compact：摘要切点之前的前缀，保留尾部原文
```

没有 `blocked` 状态：掩码后没降下来就走摘要；摘要失败就是失败（上下文不变、计入熔断）。

## 三、决定

### C1 掩码载体：复用 ContentReplacementState

- 不新增 entry kind、不外部化、不算哈希。原始工具结果仍在 transcript 里不动，掩码只是"不再发送"。
- 掩码决定记入 `ContentReplacementState.replacements`，以 `content-replacement` 条目持久化，resume 时由
  `reconstruct_content_replacement_state` 重建。
- 占位文本改为带元数据（legacy 格式）：

  ```
  [tool result cleared: <toolName> <bytes> bytes, id <tool_use_id>]
  ```

- 新增的掩码与 CC 原有的单消息预算替换共用同一份状态，所以开启掩码等于开启该状态（`@nyan`：
  `ToolResultContentReplacement` 在本 fork 默认开启）。
- **大 transcript 的 resume 漏洞（必须一起修）**：transcript > 5 MB 时，resume 只读最后一个 compact boundary
  之后的内容，boundary 之前的条目只保留 `METADATA_MARKERS` 列出的类型（`utils/session_storage.rs:5727`），
  其中**没有 `content-replacement`**。C7 保留尾部原文后，尾部里已掩码的工具结果的掩码记录写在 boundary 之前，
  resume 会丢失它们 → 原文重新出现、cache 断、上下文膨胀。修法：把 `"type":"content-replacement"` 加进
  `METADATA_MARKERS`（`@nyan`）。本会话的 transcript 已 5.2 MB，这不是假设场景。
- `tool_result_storage.rs:31` 注释"Cometix keeps session writes disabled"已过时（`SESSION_WRITE_ENABLED = true`，
  `session_storage.rs:86`），实现时一并更正。

### C2 触发与候选

- 触发：`measure > 阈值`，阈值沿用 autocompact 的 `有效窗口 − 13k`（`auto_compact.rs:91`）。
- 候选（全部满足）：
  1. 工具结果所属的工具在可清名单内（沿用 `is_compactable_tool_name`，`micro_compact.rs:507`）；
  2. 位于本次 `query()` 调用开始时的最后一条用户消息**之前**（legacy 说的"在飞那一轮"在 CC 里就是这个边界：
     模型正在使用的本轮工具结果一律不清）；
  3. 单条估算 token ≥ 预算的 1%（预算 = 有效窗口）；
  4. 尚未被替换。
- 选取：从旧到新累加，直到预计 `measure ≤ 阈值 − 余量`（C3）；然后**把最早被清位置之后的其余候选一并清掉**。
  理由：prompt cache 是前缀匹配，本轮 cache 从最早被改动的位置起失效，这个代价已经付了；顺带清掉其后的候选不增加
  本轮的失效量，却能腾出更多空间、推迟下一次掩码（下一次掩码又会断一次 cache）。
- 主线程与子代理都适用；子代理的掩码记录带 `agentId`（`record_content_replacement` 已支持）。

### C3 冻结与 prompt cache

prompt cache 是第一约束：**不允许任何因时间流逝而丢掉 cache 的设计**，cache 只能在"上下文内容确实变了"
时失效，并且每次失效都要换来足够的 token 节省。

- 一个 id 一旦掩码，永久掩码，后续每轮字节一致重放。cache 只在掩码发生的那一轮从最早被清的位置起失效一次，
  之后稳定。
- **CC 的 time-based microcompact 在本 fork 移除（不是关闭）**：它按"空闲 60 分钟"触发，等于把时间流逝变成
  cache 失效；且每次清理调用 `reset_microcompact_state()`。两点都与本约束冲突。
- 掩码只在**超阈值时**发生（C2），不按时间、不按轮数；一次掩码要清到 `measure ≤ 阈值 − 掩码余量`
  （余量默认为预算的 10%），避免每轮都只清一点点、每轮都打断 cache。
- cached microcompact（`COMETIX_CACHED_MICROCOMPACT`，服务端 cache edit）保持原样不动，默认关闭。
- cache 保活见 C12。

### C4 估算

- `measure` = 最后一次 assistant `usage` + 其后消息的粗估（CC 现状），再减去自该 usage 之后新掩码条目的
  token 数。否则掩码后的重新 measure 仍读到掩码前的 usage，会误判"仍超"直接走摘要。
- resume 后最后一条 assistant 的 usage 若是 `message_start` 阶段的值（无 `stop_reason` 且 `output_tokens = 0`），视为
  不可信，改用粗估（原因见 C13-1）。

### C5 Read 去重修正

- 判断 `file_unchanged` 前，若该文件上次 Read 的 `tool_use_id` 已被掩码，则视为未读过，正常返回内容。
- `ReadFileStateEntry`（`utils/query_helpers.rs:28`）目前没有 `tool_use_id`，需新增该字段并在 Read 写入状态时
  填上（Write / EditRefresh / NestedMemory 来源为 `None`，不参与去重判断以外的逻辑）。

### C6 摘要：legacy 的结构化格式，CC 的 cache 共享请求

只换"让模型写什么"，不换"怎么发请求"：

- **请求形态沿用 CC**：摘要是共享主会话 cache 的分叉（`compact.rs:990-1035`，`run_forked_agent`）——
  system、tools、历史消息与主会话逐字节相同，末尾追加一条摘要指令，历史部分全部命中 cache，只付输出 token。
  legacy 的"把对话序列化成 `<conversation>` 纯文本再发"会丢掉整段 cache、按全价重新输入，与 C3 的 cache 约束
  冲突，**不采用**。CC 的 fallback（`compact.rs:1087`，分叉失败时的无 cache 请求）保持原样。
- **摘要指令换成 legacy 格式**（`@nyan`，替换 `base_compact_prompt.txt` 的内容）：Goal / Constraints &
  Preferences / Progress（Done / In Progress / Blocked）/ Key Decisions / Next Steps / Critical Context，
  "保留精确的文件路径、函数名、错误信息"；被摘要部分以旧摘要开头时，要求并入旧摘要。有自定义指令时追加
  `Additional focus: …`。
- CC 的 partial compact 两个模板（`partial_compact_up_to_prompt.txt` / `partial_compact_from_prompt.txt`）
  同样换成上述结构，只保留各自"只摘要切点前 / 切点后"的范围说明。
- 摘要写回格式沿用 CC（`get_compact_user_summary_message`，带 transcript 路径提示），不改。
- 回退开关：`settings.nyan.compaction.summaryStyle = "cc"` 恢复 CC 原提示词，默认 `"legacy"`。

### C7 全量摘要保留尾部：keepRecentTokens

- autocompact 不再"全部摘要"，改为 legacy 的切点选择，结果走 CC 现成的
  `partial_compact_conversation(…, UpTo)`（`compact.rs:765`），尾部原文作为 `preserved_segment`
  落盘、resume 时重新接链（`session_storage.rs:5571`）。
- 切点（legacy §8.7）：从最新往旧累加估算 token，到达 `keepRecentTokens` 的那条起，切在其后第一个候选；
  候选是以 user 或 assistant 开头的消息，不能是工具结果，也不能是"前一条 assistant 的调用结果还在其后"的
  user 消息（tool_use / tool_result 成对）。
- 默认 `keepRecentTokens = 20000`、摘要输出上限 `min(0.8 × 16384, 模型上限)`（legacy 默认值）。
- 没有可切的位置（总量不到 `keepRecentTokens` 或切点前没有内容）时退回 CC 的全量摘要。
- cache：UpTo 只发切点之前的前缀（`compact.rs:824-825`），该前缀与主会话请求的开头逐字节相同，仍走
  cache 共享分叉、按前缀命中；命中量比全量摘要少最后一个 cache 断点之后的部分，可接受。
- 手动 `/compact` 同样走这条路径；`/compact` 的消息选择器（partial compact）保持 CC 行为。

### C8 摘要校验

摘要响应必须同时满足，否则失败、上下文不变、计入熔断：

| 条件 | 失败原因 |
|---|---|
| `stop_reason` 为 `EndTurn` / `StopSequence`（`types/message.rs:1183`） | `MaxTokens` → `summary_truncated`；`ToolUse` → `summary_contains_tool_call`；`Refusal` / `PauseTurn` / 缺失 → `model_error` |
| 不含 tool_use | `summary_contains_tool_call` |
| 文本非空 | `summary_empty` |
| 非 `API Error` / prompt-too-long（沿用 CC 的 PTL 截头重试） | `model_error` |

### C9 回执

写进 compact boundary 的 `CompactMetadata`（CC 已有 `trigger`、`pre_tokens`、`messages_summarized`、
`preserved_segment`），新增：

```
nyan: { maskedCount, maskedTokens, summaryModel, summaryStyle, keepRecentTokens,
        tokensAfterEstimate, usage }
```

掩码本身的回执即 `content-replacement` 条目（id + 占位文本），不另建文档。

### C10 摘要模型

- `settings.nyan.compaction.model`：摘要使用的模型，未设置时用当前主模型（CC 行为）。
- **代价**：prompt cache 按模型隔离，换模型就无法共享主会话 cache，摘要请求要按全价输入整段历史（走 CC 的
  无 cache fallback 路径）。主模型贵、摘要模型便宜很多时才划算；文档与 `/compact` 输出里注明本次是否命中 cache。
- 窗口检查：被摘要的输入估算超过摘要模型窗口时，先按 CC 的 PTL 截头逻辑截断，仍超则失败（不静默换模型）。

### C11 开关

`SettingsJson`（`utils/settings/types.rs:63`）是严格 schema：编辑时未知顶层键直接报错
（`utils/settings/validation.rs:454`）。所以新增一个正式字段 `nyan: Option<NyanSettings>`（`@nyan`），
压缩配置放在 `nyan.compaction` 下，后续模块（记忆、检索、外部搜索）也挂在 `nyan` 下，不散落到顶层。

| 设置 | 默认 | 作用 |
|---|---|---|
| `settings.nyan.compaction.mask` | `true` | 关闭后回到 CC：无掩码、全部摘要 |
| `settings.nyan.compaction.maskMinFraction` | `0.01` | 候选单条占预算的下限 |
| `settings.nyan.compaction.keepRecentTokens` | `20000` | 摘要保留的尾部 |
| `settings.nyan.compaction.summaryStyle` | `"legacy"` | `"cc"` 回退 CC 提示词 |
| `settings.nyan.compaction.model` | 未设置 | 摘要模型 |
| `settings.nyan.compaction.maskHeadroom` | `0.10` | 一次掩码清到阈值以下多少（占预算比例） |

### C12 prompt cache 保活（来自 legacy cache warmer）

问题：Anthropic 的 cache TTL 默认 5 分钟（可选 1 小时）；思考一会、跑一条长命令、或离开一阵后，下一次请求
整段 cache 过期，按全价重写。

本机会话实测（按请求去重 usage 后）：

| 会话 | 模型 | 命中率 | 说明 |
|---|---|---|---|
| 66b6b0c1 | claude-opus | 98% | 10 次空闲超 5 分钟，最长 23 分钟，仍 98%：网关侧对 Claude 的 cache 寿命明显长于 5 分钟（未验证具体值） |
| 244e7657 | deepseek-flash | 98% | 无长空闲 |
| e570820f | deepseek-flash | 93% | 无长空闲 |
| 83c495ff | gpt-6.1-sol + deepseek | 71%（按最终 usage） | 原记"45%、167 次中 101 次 `cache_read=0`"是统计口径错误：208/351 个 gpt 请求的 transcript 只有 `message_start` 阶段的 usage（`cache_read=0`、`output=0`），不是真实未命中。按最终 usage：前 247 个请求约 99%；第 248 个起（约 300k token）连续只命中 12544（system + tools）直到 7.5 小时后自行恢复（见 C13） |

legacy 的思想（`packages/coding-agent/src/core/cache-warmer.ts`）：在 cache 过期前把**同一个请求原样重放、输出
上限 1 token**，续上寿命；值不值得续由经济账决定。legacy 的经济账按美元算（价格表 + $0.05 阈值 + 0.15 空闲继续概率），
在本项目不适用：CC 的价格表（`utils/model_cost.rs`）只覆盖 Claude，网关上的 GPT / DeepSeek 等查不到价格。
本项目按 **token 账**落地——对任何模型，cache 读取约为输入价的 1/10、写入约等于输入价，所以只比 token 量：

- **何时保活**：一次真实请求结束后，若它的 prompt 中 cache 部分（`cache_read + cache_creation`）≥ `minCachedTokens`
  （默认 20k），就排一个保活定时器；否则不值得（重写成本本来就小）。
- **TTL 从响应里读，不让用户配**：Anthropic usage 带 `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`（CC 已解析，`services/api/claude.rs:148`）——哪个非零就是哪个 TTL。都为零且
  `cache_read` 也为零（这个模型 / 网关没 cache）就不保活。网关若对 Claude 的实际寿命更长（本机实测空闲 23 分钟仍
  命中），按 5 分钟保活只是多花少量读取，不会出错。
- **没有 `ephemeral_*` 字段但 `cache_read > 0`**（经网关的 GPT / DeepSeek 等，由上游自动缓存）：TTL 未知，**不保活**。
  这类上游的自动缓存寿命由服务端决定、无法从响应得知，保活请求能否续命也无法验证；本机这几类会话在无长空闲时
  命中率已达 93%–99%（上表，按最终 usage）。以后若实测某个上游有固定 TTL 且保活有效，再按模型名加白名单。
- 判断用**内存里的最终 usage**（`message_delta` 合并后），不读 transcript（落盘值可能停在 `message_start`，见 C13-1）。
- **时机**：TTL 的 90%（至少留 10 秒余量）发一次；定时器迟到超过余量一半就放弃（迟到的刷新等于一次全价写入）。
- **请求**：复用 CC 每轮结束时保存的主线程 cache-safe 参数（`get_last_cache_safe_params`，`utils/forked_agent.rs:404`；
  由 `query/stop_hooks.rs:91-114` 写入，CC 本来就用它让 `/btw`、prompt suggestion 等分叉共享主会话 cache）。
  保活走 `run_forked_agent`（cache 共享分叉，**不带** `X-Claude-Code-Agent-Id`，见 C13-3）：`max_output_tokens = Some(1)`、`max_turns = 1`、`skip_transcript = true`，追加一条极短的
  user 消息。分叉请求 = 主会话前缀（system、tools、历史逐字节相同）+ 这条消息，读到整段已缓存前缀、刷新其寿命，
  只新写几个 token——与 CC 现有分叉共享 cache 的机制相同，不需要另存"最后一次请求的原始字节"。
  - `max_output_tokens` 会影响 budget 型 thinking 的 `budget_tokens`，进而改变 cache key（`utils/forked_agent.rs:451`
    的注释已指出）；主会话用 budget 型 thinking 时不保活，adaptive 或关闭 thinking 时保活。
- **何时停**：上下文一变（新的真实请求、换模型、掩码、摘要）立即停；运行中最长保活 60 分钟，agent 停下（等待用户输入）
  后最长 30 分钟（legacy 的两个安全上限，保留——它们防的是"人走了还在一直花钱"）。
- **记账**：保活请求的 usage 计入 CC 现有的会话费用统计（`cost_tracker.rs`），不进模型上下文，不写成消息。
- **开关** `nyan.cache.warming`：`"off"` | `"active"`（默认，仅 agent 运行期间，覆盖长工具调用与长思考）|
  `"idle"`（等待用户输入时也保活，受 30 分钟上限）。
- **1 小时 TTL**：CC 已有 `promptCache1h` 开关（`feature_flags.rs:488`，默认关）。不改默认；保活在 1h TTL 下自然
  变成每 54 分钟一次，开不开交给用户。

### C13 非 Anthropic 模型的 cache 利用（已查清，2026-10-27）

原判断"经网关调用 gpt 时 cache 基本失效"**不成立**，是统计口径错误；真实问题有两个，一个在 nyan，一个在网关。

**1. transcript 里的 usage 不是最终值（nyan 侧，统计口径）**

- 83c495ff（nyan-pc 会话）的 351 个 gpt 请求中，208 个在 transcript 里没有任何带 `stop_reason` 的条目，usage 是
  `message_start` 阶段的值（`cache_read=0`、`output=0`）；这 208 个全部以 `tool_use` 结尾、紧跟 `tool_result`。
- 机制：主会话的 assistant 记录入写队列后，由 `message_delta` 的 `AssistantDelta` 回写修补
  （`query.rs:2132-2172` → `session_storage.rs:3870` `apply_assistant_delta_to_queued_record`）。CLIProxyAPI 会提前推出
  tool_use 块，流式执行器立即开跑工具，`tool_result` 记录先入队，delta 晚到时修补不到——CC 自己也接受这个竞态
  （100 ms 刷新，`session_storage.rs:3936-3938` 注释）。本机直连 Claude / DeepSeek 的会话里每会话只有 0–4 个这样的请求。
- **影响范围只在落盘的数字**：内存里的 usage 是最终值。C4 measure、C12 保活判断都读内存里的最后一条 assistant usage，
  不受影响；受影响的是事后按 transcript 做的统计（命中率、费用复盘）以及 resume 后第一次 measure。
- **决定**：
  - resume 后的 measure 若最后一条 assistant 的 usage 是 `output_tokens=0` 且无 `stop_reason`，视为不可信，退回
    CC 的粗估（`token_count_with_estimation` 的估算分支），不当作真实 usage。写进压缩切片 B。
  - 不改写队列的竞态（与 CC 行为一致，改动面大、收益只在统计）；本文与后续统计脚本**只用带 `stop_reason` 的条目**
    计算命中率。

**2. 第 248 个请求起的命中断崖（网关侧，不在 nyan 修）**

- 第 248 个 gpt 请求（约 300k token）起，`cache_read` 连续固定为 12544（只命中 system + tools），未缓存 290k–330k，
  请求间隔 10–60 s、未换模型、未压缩；约 7.5 小时后自行恢复到 308k 命中。
- 已排除：`prompt_cache_key` 不稳定。CLIProxyAPI（v8.0.44 源码）的 Codex executor 取 `X-Claude-Code-Session-Id` +
  `X-Claude-Code-Agent-Id` 生成 `prompt_cache_key`（`helps/claude_code_session.go:120-127`、
  `codex_executor_request.go:117-153`），会话内稳定。
- 未验证的假设：(a) 上游把请求路由到另一账号 / 机器，或 cache 被淘汰；(b) CPA 的 reasoning replay 每 agent 上限
  256 turns / 16 MB（`internal/cache/codex_reasoning_replay_cache.go:31-34`），超限从头部裁剪旧 turn，改变了请求前缀。
  需要 CPA 日志（trace-id、auth 切换、replay 裁剪）核实，属于网关运维，不进入任何 nyan 切片。

**3. 子代理与主线程共用网关 cache 身份（nyan 侧，需修）**

- CPA 的 `prompt_cache_key` = `sha1(model, "claude:<sessionId>:agent:<agentId>")`，`agentId` 只取 `X-Claude-Code-Agent-Id`
  头、缺失即 `main`（`helps/claude_code_session.go:31-45,120-127`）。nyan 不发这个头（全仓无此字符串；CC 原版是否发未核实），
  所以所有子代理与主线程共用同一个 `prompt_cache_key` 与 reasoning replay 状态。前缀不同的请求挤同一个 key，会互相顶掉 cache，也会让 replay 把子代理
  的 reasoning 混进主线程。
- **决定**：子代理请求（`run_agent` / `run_forked_agent`）带 `X-Claude-Code-Agent-Id: <agentId>`，主线程不带（CPA 缺省为
  `main`）。**例外**：共享主会话 cache 的分叉（摘要 C6、保活 C12、记忆提取 / 合并）必须**不带**或带主线程的身份——它们的
  前缀与主线程逐字节相同，目的就是命中主线程的 cache。
- 对 Anthropic 直连无影响（该头不进 cache key）。这一项是独立的小切片，见第五节切片 G。

## 四、明确不做

| 项 | 理由 |
|---|---|
| `basis` / `stale_basis` | 为 durable 的异步压缩任务设计；CC 的 autocompact 在请求前同步执行，没有并发写入 |
| `blocked` 准入状态 | legacy 已砍：没有真正的产生者 |
| artifact store、哈希绑定掩码 | 条目不可变且永存，恢复路径就是 transcript 本身 |
| ContextUnitManifest、22 种 AnchorKind、8 种压缩动作、CDR/CAR、审批门 | legacy 已明确后置；没有 Kernel / RunLedger / 审批载体 |
| context collapse、snip、reactive compact | CC 上游也是空 stub，保持 no-op |

## 五、实现切片

| 切片 | 内容 | 主要写集 | 依赖 |
|---|---|---|---|
| A | 掩码：候选筛选、冻结、占位文本、持久化；移除 time-based 路径；开启 ContentReplacementState；`METADATA_MARKERS` 加 `content-replacement` | `services/compact/micro_compact.rs`、`utils/tool_result_storage.rs`、`utils/feature_flags.rs`、`utils/session_storage.rs` | — |
| B | measure 扣除掩码 token；准入 continue/mask/compact 接线 | `utils/tokens.rs`、`services/compact/auto_compact.rs`、`query.rs` | A |
| C | Read 去重修正 | `tools/file_read_tool/mod.rs` | A |
| D | legacy 摘要格式与校验、回退开关、摘要模型配置 | `services/compact/compact.rs`、`services/compact/prompt.rs` | — |
| E | keepRecentTokens 切点 + 走 partial compact UpTo；回执 | `services/compact/auto_compact.rs`、`services/compact/compact.rs`、`types/message.rs` | B、D |
| F | cache 保活：从 usage 读 TTL、token 账、定时器、复用 cache-safe 参数重放、费用记账、开关 | 新 `services/cache_warmer.rs`、`query/stop_hooks.rs`（启动）、`query.rs`（新请求时停止）、`cost_tracker.rs` | — |
| G | 网关 cache 身份（C13-3）：普通子代理请求带 `X-Claude-Code-Agent-Id`；cache 共享分叉不带 | `services/api/claude.rs`（按请求加头，`agent_id` 已在 options 里，`claude.rs:411`）、`utils/forked_agent.rs` | — |

A、C、D、F、G 可并行（写集不重叠）；B 在 A 后；E 最后。

切片 G 的判别：`run_forked_agent` 给每个分叉也分配 `agent_id`（`forked_agent.rs:199`），所以不能按"有无 `agent_id`"
决定是否带头；cache 共享分叉（`fork_context_messages` 非空、复用主线程 cache-safe 参数的：摘要、保活、记忆提取 /
合并、`/btw`、prompt suggestion）不带，其余子代理（Agent 工具派生的独立上下文）带。每个切片：受影响测试改为断言新行为，新增行为各有测试；
`just test` 的隔离方式跑受影响模块；用真实会话回放验证掩码后的 token 曲线。

## 六、验收

1. 超阈值时先掩码；掩码后回到阈值内则不调用摘要模型。
2. 同一 id 掩码后，后续每轮发出的字节一致（cache 不再失效）。
3. resume 后掩码状态一致；transcript 里原始工具结果仍在；transcript > 5 MB 且经历过摘要时同样成立。
4. 在飞那一轮的工具结果永不被掩码。
5. 掩码后 measure 下降（不读到旧 usage）。
6. 被掩码文件再 Read 能拿到内容。
7. 截断 / 含 tool call / 空摘要都失败，上下文不变。
8. 摘要后保留 `keepRecentTokens` 尾部原文，tool_use/tool_result 不被拆开；resume 后链完整。
9. 关闭 `mask` 与 `summaryStyle="cc"` 时行为回到 CC。
10. 移除 time-based microcompact 后，空闲任意时长再继续，不会因 nyan 自身行为清理任何内容。
11. 保活刷新的请求与上一次真实请求除 `max_tokens` 外逐字节相同；刷新后下一次真实请求 `cache_read` > 0。
12. 上下文变化（新消息、换模型、掩码、摘要）后保活立即停止；`warming: "off"` 时从不发刷新；无 cache 的模型从不保活。
