# Pactile 检索与搜索服务设计（提案）

- 状态：`proposed`；当前仍受 `P0_REVIEW_BLOCKED` 约束。
- 适用范围：Pactile Agent 的 runtime 与 evaluation 检索链路，包括本地检索、DecisionProvider 规划、SemanticProvider 候选发现、外部 Search/Fetch/Evidence、降级和证据边界。
- 当前事实：本文统一现有检索设计，不代表真实外部 Provider 已接入，也不授权任何外部请求。
- 设计原则：先确定性规划和准入，再调用可选 Provider；所有不确定性、降级和失败都必须显式保留。

本文是检索线的总览文档，详细字段和故障规则仍以 [检索 Schema](./02-retrieval-schema.zh-CN.md)、[候选链路与融合](./05-candidate-pipeline.zh-CN.md)、[外部链路](./07-external-search-fetch-evidence.zh-CN.md) 和 [隐私与外发](./08-privacy-egress.zh-CN.md) 为准。

## 1. 目标与边界

检索服务为 Agent 提供可审计的候选发现和证据化输入。它解决三个问题：

1. 根据当前任务和 fact gap 选择允许的检索分支；
2. 在预算、deadline、取消信号、scope、generation 和权限范围内获取候选；
3. 只把经过当前源 Inspect、来源和 freshness 检查的内容交给 Context。

检索服务不拥有产品事实、审批、结算或最终权限。它也不把模型置信度、语义相似度或搜索排名当作事实证明。

检索服务是 Pactile Agent 的冷路径 Application Service；Pi 是执行体，Kernel 是产品事实和正式 Evidence 的权威，Host/Capability 层是网络和副作用的准入权威。

## 2. 总体架构

```text
任务 / 查询 / fact gap
          │
          ▼
DecisionProvider（Jev / rule，planning advice）
          │ 只产生 typed judgment，不执行搜索
          ▼
Retrieval Planner + Deterministic Oracle
          │ 生成 RetrievalPlan，固定 intents、scope、预算、deadline、egress
          ▼
Policy / Capability Gate
          │ 校验 provider、权限、隐私和外发授权
          ▼
Retrieval Controller
  ┌───────┼────────┬─────────┬──────────────────┐
  ▼       ▼        ▼         ▼                  ▼
exact  structural lexical  relation       semantic / external
  │       │        │         │                  │
  └───────┴────────┴─────────┴───────┬──────────┘
                                    ▼
                 canonicalize → dedupe → rank fusion
                                    ▼
                              Inspect + coverage
                                    ▼
                              RetrievalPackV1
                                    │
                 external branch: SearchHit → Fetch → Evidence
                                    ▼
                                ContextUnit
```

### 2.1 组件职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| DecisionProvider | 对检索计划给出 typed judgment 和建议 | 搜索、Fetch、授权、事实证明 |
| Deterministic Oracle / Planner | 把请求变成可复算的 RetrievalPlan | 使用模型置信度替代规则 |
| Policy / Capability Gate | provider readiness、权限、scope、egress 和隐私准入 | 产生候选或篡改产品状态 |
| Retrieval Controller | 执行分支、预算、取消、候选融合、Inspect 和 pack | 自行打开网络或写 Kernel 事实 |
| SemanticProvider | 产生相似候选、排序、去重和聚类建议 | DecisionProvider、Web Search、Evidence authority |
| Search Provider | 按获批 query 发现外部 URL 候选 | 引用事实、读取工作区、授予权限 |
| Fetch Adapter | 在受控范围内取得远程字节并记录 hash | 执行远程代码、把网页当指令 |
| Kernel / Host | 正式 Evidence、审批、Effect、Run 和结算 | 代替 Retrieval Controller 做候选排序 |

## 3. DecisionProvider 在搜索服务中的位置

DecisionProvider 参与的是**检索规划**，不是搜索执行。

### 3.1 调用时机

在调用方没有显式指定 intents，且 Session 存在可分析的 fact gap 时，可以询问 Jev 或其他 DecisionProvider 是否需要增加 `semantic` 或 `structural` 路由。`exact` 始终保留。

DecisionProvider 请求只携带有界、脱敏的 planning facts。不能把用户控制的 Task 标题、交付物、源码片段、凭据或完整仓库发送给规划 Provider。

### 3.2 输出和采用规则

DecisionProvider 输出的是 typed judgment / CJ 形式的建议，例如推荐的检索 intent、理由码和 confidence。确定性 Planner 再根据当前 Policy、Provider 状态、scope 和预算决定最终计划。

采用顺序是：

```text
DecisionProvider advice
        ↓
schema / confidence / policy 校验
        ↓
Deterministic Oracle 裁决
        ↓
RetrievalPlanV3
```

Jev 不能增加 `external` / `external_search`，不能授权远程 Provider，不能改变 Kernel 策略，也不能单独修改分支启用、预算、deadline 或候选取舍。外部搜索只能由显式计划和 Host Egress Capability 同时允许。

### 3.3 Shadow 与失败回退

Jev retrieval 使用 shadow 模式时，只记录 planning judgment，与确定性 oracle 和 gold labels 对照；真实执行仍由确定性规则控制。

以下情况必须回退到无 Jev 的确定性计划，并保持相同的 pack 结果：

- timeout、cancelled、provider unavailable；
- schema mismatch、非法 response 或低置信度；
- 项目配置拒绝、敏感内容命中或缺少 API key；
- 外发策略不明确或 capability 不满足。

Jev 的 calibration、confidence 和一致率只属于评测证据，不能直接提升权限或 assurance。

## 4. 检索 intent 与分支

| 分支 | 性质 | 作用 | 当前阶段 |
| --- | --- | --- | --- |
| `exact` | deterministic | 路径、字面量、`rg`、Worker exact | 阶段 1a 必须可用 |
| `structural` | deterministic | symbol、AST、CodeGraph、引用关系 | 阶段 1a 必须可用 |
| `lexical` | deterministic | 词元、n-gram、词权重 | 已登记，尚未纳入 1a |
| `relation` | deterministic | callers、callees、imports、references | 可由 structural 派生，尚未纳入 1a |
| `semantic` | advisory | SemanticProvider 召回、排序、聚类 | 阶段 2，先 shadow |
| `external_search` | advisory | Search Provider → Fetch → Evidence | 需独立 egress 授权 |

每条启用分支都必须带 workspace scope、branch、source revision、generation、permission scope、capability snapshot（semantic/external 必填）、provider reference、独立预算、deadline、取消信号和 provenance。

## 5. RetrievalPlan 与执行规则

RetrievalPlan 不是模型自由生成的文本，而是经过解析、限制和 fingerprint 的结构化计划。至少固定：

- 查询及其 hash/ref；
- intents 和分支 mode（`authoritative` 或 `shadow`）；
- workspace/worktree/path scope 与 denied-path policy；
- minimum assurance、required evidence kinds 和 requested policy；
- provider/capability snapshot、source revision、generation；
- `maxCandidates`、`maxBytes`、`maxTokens`、`deadlineMs`、`maxBranchesPerFile`；
- cancellation signal、egress decision 和 privacy policy；
- rank fusion 的 `k`、权重和 tie-break 规则（如启用）。

### 5.1 预算与取消

- 每个分支拥有独立预算和 deadline，不借用其他分支剩余预算。
- 预算截断记录为 `cancelled + retrieval-budget-exhausted`，不能伪装成 `timeout` 或 `ok`。
- deadline 到期记录为 `timeout + retrieval-deadline-exceeded`。
- 调用方取消、operation 取消和 epoch fence 分别记录原因；部分结果不得伪装成完整成功。
- 任何 early stop 都必须由 plan 显式允许，并为未执行分支写入 coverage。

### 5.2 候选规范化、去重和融合

候选先转换为稳定的 `canonicalLocatorKey`，再去重和融合：

- 本地路径使用 worktree 相对路径、NFC、`/` 分隔，并保留大小写和非 ASCII；
- 拒绝绝对路径、盘符、UNC、`..`、越界符号链接和未知 scheme；
- 外部候选使用版本化 `canonicalUrl` 的 hash；
- 不跨 worktree、generation 或 revision 合并；
- 合并必须保留全部来源、`mergedIds` 和 provenance；
- RRF 的 `k`、权重和 tie-break 必须显式记录，不能有隐含默认值；
- shadow 候选可用于评测，但不能进入 authoritative `items`。

### 5.3 Inspect、coverage 和 abstain

只有通过当前源 Inspect、权限、revision、generation 和 hash 检查的候选，才能进入 `RetrievalPackV1.items`。

每条启用分支恰好有一条 coverage。`status = ok` 只表示本次 scope、generation、revision 和 deadline 内完成，不表示不存在其他匹配。

只有所有 authoritative 分支均为 `ok` 且零命中时，才允许记录 `abstain`。它只是“本次覆盖范围内未观察到命中”，不是不存在的证明。任何分支失败、降级或覆盖未知时，都只能使用 `insufficient_coverage`，不能返回确定性无匹配。

## 6. SemanticProvider 的边界

SemanticProvider 与 DecisionProvider 是两个不同角色：

- DecisionProvider 决定“建议采用什么检索计划”；
- SemanticProvider 判断“哪些候选可能相关”。

EmbeddingGemma 或其他 embedding provider 只能用于候选发现、semantic 分支排序、去重建议、主题聚类、coverage 统计和 Fetch 优先级。它不能：

- 生成 citation 或替代 Fetch；
- 证明当前源、权限、事实或无匹配；
- 决定 scope、deadline、预算或 egress；
- 读取或写入 Kernel、RunLedger、Memory 或 Runtime Store；
- 充当 Web Search Provider。

模型、维度、prompt、chunker 或 semantic generation 改变时，必须使旧候选失效并触发显式重建或回退。

## 7. 外部搜索服务

外部搜索是 `external_search` 分支，由 Host 管理的网络 capability 承载。它不是 SemanticProvider 的隐式能力，也不是 Retrieval Controller 自己打开的网络通道。

### 7.1 Search 阶段

Search 接收经过隐私处理的 query、scope、预算、deadline 和 egress decision，返回 `SearchHitV1[]`。

`SearchHitV1` 至少包含：

- `providerId`、`requestRef`、`hitId`；
- 原始 URL 和版本化 `canonicalUrl`；
- title；
- snippet 的 `textHash` 和可选 pointer，不保存明文；
- discovered time、rank、score、freshness；
- capability snapshot、egress record 和 advisory provenance；
- `inspect = not_inspected`、`fetch` 观察和 `citation = null`。

SearchHit 只是候选：不能直接进入 `RetrievalPackV1.items`，不能直接成为 citation，也不能证明网页内容真实。

Search Provider 不得读取工作区。向远程端点发送的只能是用户批准的 query 和允许的上下文；不得发送凭据、私有日志、隐藏推理或整个仓库。

### 7.2 Fetch 阶段

Fetch 只接受经过准入的 URL，并生成 `FetchRecordV1`。请求必须固定：

- allowed/deny hosts 和 worktree scope；
- deadline、cancellation、`maxBytes`、`maxRedirects`、允许的内容类型；
- `requireHttps`、`blockPrivateNetworks`、`allowRemoteWebText`、`allowRemoteCode`、脚本处理策略；
- egress decision 和 authorization reference。

Fetch 必须防止 SSRF、私网访问、非 HTTPS、跨 host 未重检的重定向和不允许的内容类型。超时或取消时丢弃部分字节，不生成半个 citation。远程代码只能作为受控数据读取，永不执行。

`FetchRecordV1` 保存 HTTP 观察、重定向链、content type、大小、截断标记、response hash、Artifact pointer、policy 结果、egress record、failure status 和 provenance。没有 `responseHash` 就不能产生 citation。

### 7.3 Evidence 阶段

Evidence 只能从成功的 FetchRecord 生成，并必须经过当前源 Inspect 和范围验证。`EvidenceRecordV1` 至少包含：

- FetchRecord reference、URL、canonical URL、title、fetchedAt；
- `responseHash`、provider、source freshness；
- selector、text hash 和可选 byte range；
- `citationPointer = canonicalUrl + responseHash + evidenceRangeHash`；
- Inspect 结果和 provenance。

Artifact 中的字节被清理后，citation 必须变为 `stale`。同一 URL 重新 Fetch 得到不同 response hash 时，旧 citation 不能继续代表新内容。

外部 Evidence 只服务于 Context 引用，不能直接成为 Kernel Evidence；Kernel Evidence 仍由 Kernel/Host 正式命令提交。

## 8. Policy、Egress 与隐私

外部请求默认拒绝。必须同时满足：

1. plan 明确启用 `external_search`；
2. provider capability snapshot 可用且未过期；
3. Policy Gate 允许目标、数据类型、内容类型和用途；
4. 存在 `egress.authorizationRef` 和可审计的 egress record；
5. 当前 operation、Run、scope 和 epoch 仍然有效。

Retrieval Controller 不能自行把 `allowRemoteWebText`、`allowRemoteCode` 或远程目标改成允许。宿主 identity 或用户全局路由文件也不能直接选择 Provider。

Jev 规划外发和外部 Search 外发是两道独立的准入：允许 Jev 规划不等于允许 Web Search；历史 Run grant 也不能替代当前 active Run 的目标授权。

## 9. 失败、降级与可见性

失败必须保留在 `coverage[]`、`fallback`、`rejected[]` 和 `reason.code` 中，不能静默变为空结果或 0 分。

| 失败 | 结果 |
| --- | --- |
| provider unavailable / unsupported | `provider_unavailable`，确定性分支继续，`pack_degraded` |
| timeout | 丢弃未完成分支结果，`pack_degraded` |
| cancelled / epoch fenced | 丢弃旧结果；当前 operation 不接收迟到结果 |
| invalid response / malformed URL | 丢弃该批候选，记录 `invalid_response` |
| egress denied / private network / non-HTTPS | 请求前拒绝，记录 `permission_denied` |
| stale source / generation mismatch | 候选拒绝，记录 `stale` 或 `generation_mismatch` |
| hash mismatch / missing Artifact | Evidence 不可用，记录 `invalid_response` 或 `missing` |
| 全部 authoritative 分支失败 | `pack_blocked`，不能返回空 pack 伪装成功 |

`pack_degraded` 仍可供下游构建 Context，但必须携带降级标记；下游不能据此宣称“没有匹配”。provider 恢复后，候选必须重新 Inspect，不能把 shadow 候选自动提升为 authoritative。

## 10. Runtime 生命周期与恢复

检索运行必须挂在 Context Operation、Run、Attempt、Turn 和 operation epoch 上，并遵守 Host 的 admission、lease/epoch fencing、idempotency 和 recovery 规则。

- admission 前不执行 provider 或外部请求；
- 每个请求和分支都有 operation、plan、provider snapshot 和授权引用；
- 旧 Attempt 或旧 epoch 的迟到结果必须被拒绝；
- crash 后不得自动重放未知效果或重复提交 Evidence；
- Fetch 部分字节、未完成 artifact 和不完整引用不能进入 Context；
- 重建由明确 reason code 表达，不自动触发隐式索引或模型重建；
- runtime 与 evaluation 平面隔离，evaluation 不得写产品 receipt、Kernel facts 或 Effect。

## 11. 分阶段落地

| 阶段 | 目标 | 允许 | 禁止 |
| --- | --- | --- | --- |
| P0 | 冻结 schema、fixture、外发策略、canonicalization 和证据保留规则 | 文档、fixture、负例、独立 Review | 真实 Provider、真实长跑、真实外部请求 |
| 1a | exact + structural deterministic baseline | 离线纯函数、Inspect、fusion、故障 fixture | 连接真实 provider、运行时 receipt |
| 1b | 接入 Host admission、manifest、receipt、recovery | shadow/reversible 的确定性路径 | Jev/Embedding 参与产品决策 |
| 2 | SemanticProvider shadow | embedding adapter、generation、RRF、fallback | 让相似度改变 Evidence、权限或压缩动作 |
| 3 | DecisionProvider / Jev retrieval shadow | 记录 planning judgment，与 deterministic oracle 对照 | Jev 改变分支、预算、deadline 或候选取舍 |
| External | Search → Fetch → Evidence | 经过独立 egress 授权的 provider 适配器和安全 fixture | 默认开网、SearchHit 直接引用、绕过 Fetch/Inspect |

每个阶段都必须有 design record、明确 write set、typecheck、lint、focused tests、build 和 integration evidence；外部链路还必须覆盖 SSRF、重定向、超时取消、hash 变化、权限拒绝、Artifact 丢失和 unknown-effect recovery。

## 12. 当前实现映射与证据状态

| 位置 | 当前作用 | 证据级别 |
| --- | --- | --- |
| `packages/cli/src/pactile/decision/contract.ts` | DecisionProvider typed advice、`planning` scope 和 receipt 形状 | implementation |
| `packages/cli/src/pactile/agent/retrieval/router.ts` | Agent retrieval 路由和 provider availability 观察 | implementation / local integration seam |
| `packages/cli/src/pactile/agent/retrieval/policy.ts` | fail-closed policy evaluation | implementation |
| `packages/cli/src/pactile/retrieval/planner.ts` | RetrievalPlan V3 构造、校验和 fingerprint | implementation |
| `packages/cli/src/pactile/retrieval/evidence.ts` | candidate、corroboration、assurance 和 evidence 评估 | implementation |
| `packages/cli/src/pactile/retrieval/adapters/local-worker.ts` | exact/structural Local Worker adapter | local implementation |
| `docs/architecture/context-governance/retrieval/07-external-search-fetch-evidence.zh-CN.md` | Search/Fetch/Evidence 契约 | proposed / P0 blocked |

当前没有外部 Search Provider、Fetch Adapter 或真实外部调用证据。因此不能把“存在契约或文档”表述为 external search 已集成、已调用、已验证或已发布。

## 13. 待裁定事项

1. `urlCanonicalizationVersion` 的完整规则：tracking 参数、大小写、端口、IDN 和 query 排序；
2. Search Provider 是否需要独立于 SemanticProvider 的 capability snapshot；
3. 外部 Artifact 保留期和 citation 失效后的清理策略；
4. 重新 Fetch 是否只能由显式请求触发；
5. 外部内容进入 ContextUnit 时，token/byte budget 归检索预算还是上下文预算；
6. DecisionProvider retrieval-specific schema 是否需要从通用 `scope: planning` 进一步冻结；
7. 外部 Search 的 provider allowlist、日志脱敏规则、请求幂等键和未知网络结果的恢复策略。

## 14. 参考文档

- [检索与 assurance](../../../capabilities/retrieval.zh-CN.md)
- [语义 Provider 契约](./01-semantic-provider-contract.zh-CN.md)
- [检索 Schema](./02-retrieval-schema.zh-CN.md)
- [Inspect、freshness 与 fence](./04-inspect-freshness-fence.zh-CN.md)
- [候选链路与融合](./05-candidate-pipeline.zh-CN.md)
- [Fallback 与降级披露](./06-fallback-degradation.zh-CN.md)
- [外部 Search → Fetch → Evidence](./07-external-search-fetch-evidence.zh-CN.md)
- [隐私与 Egress](./08-privacy-egress.zh-CN.md)
- [Readiness fixtures](./09-readiness-fixtures.zh-CN.md)
- [阶段 0–7 可执行计划](../implementation/03-stage-plan.zh-CN.md)
- [Pactile 双产品架构设计](../../pactile-dual-product-architecture-design.zh-CN.md)
