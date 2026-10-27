# Decision Provider 设计

状态：已定稿，未实现（2026-10-27）。

设计来源：nyan-legacy 的 Jev / DecisionProvider（`references/pactile-context-governance/source/pactile/jev/`、
`source/pactile/retrieval/jev-planning.ts.txt`、`design/context-governance/implementation/03-stage-plan.zh-CN.md`、
`compression/compression-decision-chain-v1.zh-CN.md`）与 `packages/ai/src/api/{typesafe-system-one,llama-cpp-classify}.ts`。
偏离 CC 的代码用 `@nyan` 标注。

**定位**：四个模块里有一批"要不要 / 选哪个"的小判断（这次检索要不要 semantic、这一轮值不值得提取记忆、这个页面是不是
挑战页……）。现在它们要么用粗糙的确定性规则，要么交给主模型 / 小模型的完整调用（慢、贵、占上下文）。Decision Provider 把
这类判断交给**专用的快速分类模型**：只回答结构化问题、不生成文本、亚秒级。它是**加速与提质的增强**，不是依赖——任何时候
不可用，都回退到确定性规则，行为与没有它时一致。

## 一、为什么是分类模型，不是小对话模型（2026-10-27 实测）

| 方案 | 实测 | 结论 |
|---|---|---|
| 网关上的 haiku（`claude-haiku-5-5`，结构化 JSON 输出，`max_tokens 40`） | 3 次 2.22 / 3.29 / 2.28 s；答案正确 | 正确但慢：每个决策 2–3 s，放在检索、搜索的关键路径上不可接受 |
| Qwen3-Reranker（已部署，yes/no 打分）当二分类器 | 三组元决策问题（是否需要 semantic、是否值得记、是否挑战页）得分全部 < 0.1，第一组排序反了 | **不可用**：reranker 只判断"文档与查询是否相关"，不回答通用决策问题 |
| Jev（TypeSafe System One 分类模型，nyan-exit 上的 router） | 协议打通（`POST /systemone`，`{state, questions}`）；上游唯一账户 `oc-1` 当前 429 限流，router 返回 `all_accounts_failed`；health 往返直连 0.4–1.1 s、经 nyan-ops 入口 1.1–4.8 s | 形态正确，**可用性未验证**；决策延迟与质量未测（legacy 也从未评测） |

所以 Decision Provider 的后端必须是**专用分类模型**；对话模型只作为"慢速兜底"不进关键路径（第五节）。

## 二、legacy 的结论与本设计的取舍

legacy 把 Jev 放在 shadow（只记录、与确定性结果对比、不改变行为），原因是**设计闸门而非评测结论**：放权条件是"一致率与不
一致归因被 Review 接受"，而阶段 3–4 从未执行，没有任何质量数据（`03-stage-plan.zh-CN.md:186-218`、`evidence/p1a/evaluation-receipt.json`
写明"没有连接 JEV"）。2026-10-14 的 handoff 移除了旧 Jev 传输，只保留决策策略与 readiness。

本设计保留 legacy 的安全结构，改变放权方式：

| legacy | 本设计 |
|---|---|
| 封闭的决策节点（6 个，四模块只对应 retrieval-planning） | 封闭的决策点注册表（第四节），按四模块重新划分 |
| shadow 直到 Review 放权，全局一刀切 | **每个决策点独立三档**：`off` / `shadow` / `active`；新决策点默认 `shadow`，用户逐个放权 |
| 检索只能"在 exact-only 时追加分支，不能删意图、改证据" | 保留为通用约束：**决策只能在确定性结果的安全集合内选择**（第三节"安全集合"） |
| 置信度阈值 0.65（检索 0.75），低于即回退 | 保留，按决策点配置 |
| 外发审查：拒绝凭据、`key=value`、机密标记 | 保留，并扩展为本项目的外发规则（第六节） |
| 每 facade 决策次数上限、deadline 2.5 s / 最大 5 s、最多重试 1 次 | deadline 收紧到 800 ms（关键路径）/ 2 s（后台），不重试；次数上限按会话 |

## 三、接口

```rust
// services/decision/mod.rs   (@nyan)
pub struct DecisionRequest {
    pub point: DecisionPoint,                  // 封闭枚举（第四节）
    pub state: String,                         // 任务摘要，≤ 2000 字符（System One 的 state / taskSummary）
    pub snippets: Vec<Snippet>,                // ≤ 3 段、每段 ≤ 3500 字符，已过外发审查（第六节）
    pub questions: BTreeMap<String, Question>, // noul / choice / score
}
pub enum Question {
    Noul   { instructions: String },                         // 二值，返回 P(true)
    Choice { instructions: String, options: BTreeMap<String, String> }, // 多选一，返回各项概率
    Score  { instructions: String, levels: Vec<String> },    // 有序等级
}
pub enum DecisionOutcome {
    Answered { answers: BTreeMap<String, Answer>, receipt: Receipt },
    Fallback { reason: FallbackReason, receipt: Receipt },   // 调用方必须走确定性路径
}
#[async_trait]
pub trait DecisionBackend: Send + Sync {
    async fn decide(&self, req: &DecisionRequest, deadline: Duration, abort: AbortSignal) -> DecisionOutcome;
}
```

**每个决策点由调用方提供三样东西**，Decision Provider 只负责"问"：

1. **确定性答案**（必须先算出来）：回退时直接用；shadow 时作为对照。
2. **安全集合**：模型答案只能落在其中，落在集合外 → `Fallback(out_of_safe_set)`。例：检索分支选择的安全集合是
   "确定性规则选出的分支 ∪ 可追加分支"，模型不能去掉任何确定性分支。
3. **置信度阈值**：低于阈值 → `Fallback(low_confidence)`。

`FallbackReason`（具名、封闭）：`disabled`、`shadow`、`backend_down`（服务状态机判 Down）、`timeout`、`rate_limited`、
`budget_exhausted`、`egress_denied`（第六节审查拒绝）、`low_confidence`、`out_of_safe_set`、`invalid_response`、`cancelled`。

**`shadow` 模式**：照常请求、记录答案与确定性结果是否一致，但返回 `Fallback(shadow)`——行为与关闭时完全相同。

**回执**（`Receipt`）只记服务方返回的值，不推断：后端、延迟、usage、各问题的置信度、是否与确定性答案一致。
回执写入本地评测日志（第七节），不进模型上下文、不写成消息。

**可复算**：决策结果是非确定的（模型、后端可用性、超时都会变），所以凡要求"排序可复算"的模块（检索第一节第 5 条），
把本次生效的决策（`DecisionOutcome` 的答案或回退原因）记进该模块的结构化结果（检索的 `SearchOutcome`）；评测回放时
注入记录的决策、不重新请求。同输入 + 同决策 ⇒ 同输出，确定性部分仍可复算。

## 四、决策点注册表（四模块）

每个决策点：确定性规则是默认与回退；`active` 时模型答案在安全集合内且置信度达标才生效。

| 模块 | 决策点 | 问题 | 确定性回退 | 安全集合 / 约束 | 默认档 | 关键路径 |
|---|---|---|---|---|---|---|
| 检索 | `retrieval.branches` | semantic 是否值得跑（noul）；查询意图（choice：definition / callers / concept / literal） | 检索 4.3 规则：默认四路全跑；标识符查询 symbol 加权 2.0 | 只能**追加**分支或调整 symbol 权重（1.0 / 2.0），exact / symbol / text 始终运行；semantic 未配置或 Down 时不可选 | shadow | 是（800 ms） |
| 检索 | `retrieval.rerank` | 融合后结果是否需要精排（noul） | 按 `nyan.retrieval.rerank.enabled` | 只在 rerank 服务 Ready 时可选"跑" | shadow | 是 |
| 外部搜索 | `web.providers` | 查询类型（choice：中文 / 技术文档 / 新闻时效 / 通用）→ provider 子集 | 全部 enabled provider 扇出 | 子集必须包含**下限集合**（`nyan.decision.web.minProviders`，默认 `["brave", "deepseek", "searxng"]`）；只能减少付费 provider，不能新增未配置的 | shadow | 是 |
| 外部搜索 | `web.rerank` | 候选是否需要精排（noul） | 按 `nyan.web.search.rerank.enabled` | 同检索 | shadow | 是 |
| 外部搜索 | `web.fetch_fallback` | 直抓结果是否为挑战页 / 空壳（noul） | 外部搜索 4.6：403 / 429 / 超时 / 正文 < 200 字符 | 只能把"规则判成功"的改判为"需要回退"（多花一次 provider 调用），不能把规则判失败的改成成功 | shadow | 是 |
| 记忆 | `memory.extract_worth` | 这一段对话是否含值得长期记住的内容（noul） | 记忆 M2：每 8 轮或 token 增长 ≥ 30k 触发提取 | 只能**跳过**一次节流触发的提取（省一次分叉），不能凭空触发；连续跳过 ≥ 3 次后强制按规则提取一次（防止漏记）；**压缩前的强制提取（记忆 M2.1）不可跳过** | shadow | 否（2 s，后台） |
| 记忆 | `memory.promote` | 候选是否晋升进 MEMORY.md 索引（noul）；与已有条目是否重复（noul） | 记忆 M4 的规则与提取 agent 自判 | 只作为第二意见：两者一致才晋升；判重复时转为候选由用户确认，不自动合并；`type: user` 仍由硬规则判为候选 | shadow | 否 |
| 记忆 | `memory.consolidate` | 现在是否该合并（noul） | 记忆 M9：24 h 且 ≥ 5 条新候选 | 只能**推迟**（最多到 72 h），不能提前 | shadow | 否 |

**明确不交给 Decision Provider 的点**（各模块文档的"决策点"小节中列出的其余项）：

| 决策 | 理由 |
|---|---|
| 压缩：掩码候选的取舍、何时掩码 | 改变请求前缀，必须确定性、可复算（cache 第一约束）；且已有精确的 token 账 |
| 压缩：是否摘要、保活是否值得 | 有精确数值依据（measure、cache token 量），模型无增益 |
| 压缩：摘要切点 | 必须保证 tool_use / tool_result 成对，规则可证明，模型不可证明 |
| 外部搜索：私网判定、预算 | 安全边界与费用上限只能是确定性的 |
| 记忆：读时 / 写时安全检查（M3） | 安全拦截必须确定性；误报由用户在 `/memory` 处理 |
| 检索 / 外部搜索：查询改写、扩展、拆分 | 生成参数值（第九节） |

压缩模块因此**没有** active 决策点；它与 Decision Provider 的关系只有一条：Decision Provider 的请求不进入主会话上下文、
不影响 cache（它是独立的 HTTP 调用，不是分叉）。

## 五、后端

`DecisionBackend` 的实现，按 `nyan.decision.backends` 顺序选第一个 Ready 的（不聚合、不并发）：

| 后端 | 形态 | 状态 |
|---|---|---|
| `jev` | System One router：`POST <url>/systemone`，`{state, questions}`（**不是** legacy 契约的 `taskSummary`，2026-10-27 实测），Bearer key 按文件引用 | 已部署（nyan-exit `:50008`，nyan-ops `/jev/` 入口）；上游当前 429 |
| `local` | 自托管分类：llama.cpp 的 `/completion`（`n_predict: 1`、`n_probs`）读标签 token 的 logprob 做 softmax，即 legacy `llama-cpp-classify.ts` 的做法；模型用一个小的指令模型（例如 Qwen3-1.7B / 4B 的 GGUF，部署时选定并实测） | 未部署；部署见下 |
| `chat` | 网关上的对话模型，结构化 JSON 输出 | 可用（haiku 实测 2.2–3.3 s）；**只允许用于后台决策点**（记忆三项），关键路径点不用它 |

**`local` 的部署**（独立于代码，可先做）：

- 位置：corp-pc 的 GPU 剩余约 2.5 GB（embed 0.45 + rerank 0.25 已占）。小模型（1.7B Q4 约 1.2 GB）可放下；若显存不够，
  放 nyan-ops 用 CPU 推理（6 核，单 token 读出、prompt 约 500 token，预计数百毫秒，需实测）。**部署时先实测延迟再定位置**，
  目标 p50 < 300 ms。
- 访问：与检索相同——corp-pc 上回环，nyan-pc 经 `tailscale serve`；放 nyan-ops 时同 SearXNG 的 Serve 方式。
- 不可用时由服务状态机（README 第一节第 9 条）判 Down，回退到下一个后端或确定性规则。

**为什么不默认 Jev**：第三方服务、单账户、当前限流、质量从未评测；且 `state` / `snippets` 要外发给第三方（第六节）。
默认顺序 `["local", "jev"]`；`local` 未部署时就是 `["jev"]`。

## 六、外发与隐私

`state` 与 `snippets` 会发给后端（`jev` 是第三方，`local` / `chat` 在用户自己的机器或网关）。外发审查对所有后端一律执行，
命中即 `Fallback(egress_denied)`，不截断改写后再发：

- 凭据形态：`sk-…`、`ghp_…`、`AKIA…`、`-----BEGIN … KEY-----`、JWT、长 hex / base64 串、`key=value` 中 key 含
  `token|secret|password|api[_-]?key`——复用记忆 M3 的 secret scanner，不另写一套。
- 路径：`.env`、`*.pem`、`id_*`、`credentials*` 等凭据类路径的内容（检索 4.5 的跳过分类）。
- `jev` 后端额外限制：**不发源码正文**——检索决策只发查询文本与分支元数据；记忆决策只发对话的用户 / 助手文本，
  不发工具结果正文。`local` 后端不受此额外限制。

## 七、评测与放权

legacy 卡在"没有评测数据"。本设计让数据在日常使用中自然积累：

- **shadow 日志**：每次决策（含 shadow）写一行到 `$CLAUDE_CONFIG_DIR/decision/<point>.jsonl`：时间、后端、延迟、
  模型答案与置信度、确定性答案、是否一致、事后信号（见下）。不含 `state` 原文，只含其 hash 与长度。
- **事后信号**（判断模型对错的依据，每个决策点一个）：
  - `retrieval.branches`：semantic 是否贡献了最终返回的结果（融合后的来源分支）；
  - `web.providers`：被省掉的 provider 在 shadow 期间若被调用，是否会贡献 top-8（shadow 时照常全量扇出，可直接计算）；
  - `web.fetch_fallback`：回退后取到的正文是否显著长于直抓；
  - `memory.extract_worth`：按规则执行的提取是否真的产生了候选。
- **`/decision` 命令**：按决策点显示样本数、一致率、模型"对而规则错"与"错而规则对"的次数、p50 / p95 延迟、各后端可用率；
  用户据此把某个点从 `shadow` 改为 `active`（写 settings）。不做自动放权。
- 日志保留 30 天，按文件 mtime 清理，与网页快照同一机制。

## 八、配置

`settings.nyan.decision`：

```jsonc
{
  "enabled": true,
  "backends": ["local", "jev"],          // 顺序尝试第一个 Ready 的
  "jev":   { "url": "https://nyan-ops.tail6334e5.ts.net/jev", "apiKeyFile": "~/.cometix/keys/jev" },
  "local": { "url": "http://127.0.0.1:8093", "model": "<部署时选定>" },
  "chat":  { "model": "haiku" },          // 仅后台决策点可用
  "deadlineMs": { "critical": 800, "background": 2000 },
  "maxPerSession": 200,                   // 超过 → Fallback(budget_exhausted)
  "points": {
    "retrieval.branches":   { "mode": "shadow", "minConfidence": 0.75 },
    "retrieval.rerank":     { "mode": "shadow", "minConfidence": 0.75 },
    "web.providers":        { "mode": "shadow", "minConfidence": 0.7, "minProviders": ["brave", "deepseek", "searxng"] },
    "web.rerank":           { "mode": "shadow", "minConfidence": 0.7 },
    "web.fetch_fallback":   { "mode": "shadow", "minConfidence": 0.8 },
    "memory.extract_worth": { "mode": "shadow", "minConfidence": 0.7 },
    "memory.promote":       { "mode": "shadow", "minConfidence": 0.8 },
    "memory.consolidate":   { "mode": "shadow", "minConfidence": 0.7 }
  },
  "logRetentionDays": 30
}
```

- `enabled: false` 或某点 `mode: "off"`：不发任何请求，行为与无 Decision Provider 完全相同。
- 每台机器各自配置（README 第一节第 7 条）；`jev` 的 key 需复制到 `~/.cometix/keys/jev`（0600）。
  **注意**：本机环境变量 `JEV_KEY` 的值末尾带换行，读取时必须 trim（2026-10-27 实测导致 400）。
- 关键路径点（检索、外部搜索）的 deadline 800 ms 是硬上限：超过即 `Fallback(timeout)`，不等待、不重试。
  关键路径上决策与确定性分支**并行发起**——不等决策结果才开始跑 exact / symbol / text；决策只影响"是否追加 semantic、
  是否精排、是否省 provider"，到 deadline 未返回就按确定性规则继续。

## 九、明确不做

| 项 | 理由 |
|---|---|
| 决策自动放权（按一致率自动从 shadow 升 active） | 放权是行为变更，由用户看 `/decision` 数据后决定 |
| 多后端聚合 / 投票 | 增加延迟与成本；决策是"快速判断"，不是召回 |
| 让模型生成参数值（查询改写文本、provider 新增、权重连续值） | 只允许在封闭的安全集合内选择；生成内容无法验证 |
| 压缩相关决策 | 见第四节，必须确定性 |
| legacy 的 21 种回退码、tile / scheduling / review 等节点 | 本项目只有第四节的决策点；回退码收敛为第三节的 11 个 |

## 十、实现切片

| 切片 | 内容 | 主要写集 | 依赖 |
|---|---|---|---|
| A | 接口、`DecisionOutcome`、安全集合与阈值校验、shadow 语义、外发审查（复用 secret scanner）、会话上限 | 新 `services/decision/{mod,egress}.rs` | 公共 H（服务状态机）、记忆 A（secret scanner） |
| B | `jev` 后端（System One router，`{state, questions}`） | `services/decision/backends/jev.rs` | A |
| C | `local` 后端（llama.cpp logprob 读出）+ 部署（模型选定、延迟实测、Quadlet / Serve） | `services/decision/backends/local.rs`；部署独立 | A |
| D | `chat` 后端（网关结构化输出，仅后台点） | `services/decision/backends/chat.rs` | A |
| E | 决策日志、事后信号、`/decision` 命令 | `services/decision/log.rs`、`commands/decision/` | A |
| F | 接入：检索 `retrieval.branches` / `retrieval.rerank` | 检索切片 B / G 的调用点 | A、检索 B |
| G | 接入：外部搜索 `web.providers` / `web.rerank` / `web.fetch_fallback` | 外部搜索切片 E / F / H 的调用点 | A、外部搜索 E |
| H | 接入：记忆 `memory.extract_worth` / `memory.promote` / `memory.consolidate` | 记忆切片 C / D 的调用点 | A、记忆 C |

A 进批次 1；B、C、D、E 可并行；F、G、H 跟随各自模块的调用点切片。

## 十一、验收

1. `nyan.decision.enabled = false`、所有点 `off`、或所有后端 Down 时，四个模块的行为与没有 Decision Provider 时逐字节一致
   （确定性回退）。
2. `shadow` 模式下照常请求并记录日志，但模块行为与 `off` 完全相同。
3. `active` 模式下：答案在安全集合内且置信度达标才生效；落在集合外 → `out_of_safe_set`、低于阈值 → `low_confidence`，
   都回退到确定性答案。
4. 关键路径决策超过 800 ms 即回退，检索 / 搜索的总耗时不因 Decision Provider 增加超过 800 ms；确定性分支与决策并行发起。
5. 含凭据形态的 `state` / `snippets` 不发出（`egress_denied`）；`jev` 后端不收到源码正文与工具结果正文。
6. `web.providers` 的 active 答案始终包含 `minProviders`；`memory.extract_worth` 连续跳过 3 次后强制提取一次。
7. 后端 Down（corp-pc 关机、Jev 429）时服务状态机判 Down，退避期间不再发请求。
8. `/decision` 显示每个点的样本数、一致率、延迟、后端可用率。
9. 离线测试：后端 URL 可注入，用 `TcpListener::bind("127.0.0.1:0")` 起 mock（与外部搜索的测试替身相同），覆盖
   answered / 各回退原因。

## 十二、待验证（实现切片的第一步，不阻塞设计）

- Jev 上游恢复后的真实决策延迟（目标 < 800 ms）与各决策点的 shadow 一致率。
- `local` 后端的模型选择、显存与 p50 延迟（目标 < 300 ms）；放 corp-pc GPU 还是 nyan-ops CPU。
