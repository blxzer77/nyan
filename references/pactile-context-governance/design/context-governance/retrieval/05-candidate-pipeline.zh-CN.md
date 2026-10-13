# 候选链路与融合（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。
- 状态引用：本文使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3）；**不定义本地状态成员**（旧 `RetrievalFactStatusV1` 已作废，见 `02` §3.1 SRC-3）。`timeout` / `cancelled` 判定与层级折叠见 `02` §3.3 / §3.4。
- 依据：架构 §27.2（Retrieval Controller 是冷路径 Application Service）、§27.5；`01-contract-draft` §4.1–§4.3（RP/RC/RK 与 PK-1…PK-6）；`02-retrieval-schema`；`04-inspect-freshness-fence`；`06-fallback-degradation`。
- 目标：把六条分支的召回、预算、deadline、取消、规范化、去重、融合、coverage、abstain 与降级全部规则化，使得「同输入 → 同 `packHash`」可复算。

## 1. 分支总览

```text
                       ┌───────────── plan（多分支、预算、deadline、egress）─────────────┐
                       │                                                              │
exact ─┐               │  六条分支并行执行，各自独立预算 / deadline / 取消信号 / 覆盖统计   │
lexical ─┤             │                                                              │
structural ─┼─► 候选（各自带 scope / revision / generation / permissions / snapshot / provenance）
relation ─┤           │                                                              │
semantic ─┤           │  canonicalize → dedupe/merge → rank fusion → coverage → Inspect  │
external_search ─┘     │                                                              │
                       └──────────────────────────► RetrievalPackV1 ◄──────────────────┘
```

| 分支 | 类型 | 实现来源（现状 / 目标） | 权威性 | 阶段 1a 纳入 |
| --- | --- | --- | --- | --- |
| `exact` | 确定性 | `rg` / literal search / Worker exact | deterministic | **必须**（`03-stage-plan` 阶段 1a「目标」行） |
| `structural` | 确定性 | Worker graph / CodeGraph / AST / symbol index | deterministic | **必须**（同上；受 `BL-09` 索引写入约束） |
| `lexical` | 确定性 | 词元 / n-gram / 词权重检索（本地） | deterministic | **不在 1a**：已在 `01` §4.1 枚举登记；启用需先修改 1a 目标行（`R-BL-07`，Owner = Implementation） |
| `relation` | 确定性 | callers / callees / imports / references | deterministic | **不在 1a**：同上（可由 structural 数据派生） |
| `semantic` | advisory | `SemanticProvider`（EmbeddingGemma 或其他） | advisory | 阶段 2 起，先 shadow（需 `BL-02` / `BL-16`） |
| `external_search` | advisory | Search provider → Fetch → Evidence | advisory（候选） | 需 egress 授权（`07` / `08`） |

> 阶段 1a 的分支集合 = **exact + structural**（唯一权威：`03-stage-plan` 阶段 1a「目标」行）。本线不得自行把 lexical / relation 计入 1a 分母。

## 2. 每条分支必须携带的字段

```ts
interface RetrievalBranchRunV1 {
  branch: "exact" | "lexical" | "structural" | "relation" | "semantic" | "external_search";
  mode: "authoritative" | "shadow";
  workspaceScope: { workspaceId: string; worktreeId: string; scopeId: string; pathScopes: SourcePointerPatternV1[] };
  worktreeBranchScope: { branch: ObservedV1<string>; detached: boolean | "unknown" };
  deadline: { deadlineMs: number; deadlineAt: string };
  cancellation: { signalId: string; cancelled: boolean; reason: CancellationReasonV1 | null };
  sourceRevision: ObservedV1<SourceRevisionRefV1>;
  generation: GenerationRefV1;
  permissions: PermissionScopeV1;                 // 形状见 02 §5.3；不在此重定义
  scopeId: string;                               // = PermissionScopeV1.scopeId（09 §1.2.1；02 §5.3 SY-PS-1/2）
  deniedPathPolicy: "reject" | "skip-and-report";       // 检索分支策略（非 PS 成员）
  capabilitySnapshot: SnapshotRefV1 | null;      // 确定性分支为 null，semantic / external 必填
  budget: { maxCandidates: number; maxBytes: number; maxTokens: number | null; maxBranchesPerFile: number | null };
  providerRef: SnapshotRefV1 | null;
  failureStatus: FactStatusV1 | null;            // null 表示尚未失败（共享状态）
  provenance: ProvenanceV1;                      // authority 按分支类型
}
```

规则：

| 规则 | 内容 |
| --- | --- |
| BR-1 | 缺少上表任一必填项的分支不得执行；plan decode 阶段即拒绝。 |
| BR-2 | `deniedPathPolicy` 必须显式：`reject`（整分支失败）或 `skip-and-report`（跳过并在 `coverage[].status` = `permission_denied` + `reason.code` 中披露）。禁止静默跳过。 |
| BR-3 | `semantic` / `external_search` 的 `capabilitySnapshot` 必须非 null；`providerRef` 指向同一 snapshot。 |
| BR-4 | 确定性分支不得因为「确定性」而省略 `generation`：`exact` / `lexical` 用 `index: null`，`structural` / `relation` 必须给出索引 generation。 |
| BR-5 | 每个分支独立 `deadline`；最小分支 deadline 不得大于 plan `budget.deadlineMs`（`01` §4.1）。 |
| BR-6 | 分支之间不得共享可变状态；跨分支通信只能通过候选列表与 `coverage`。 |

## 3. 预算模型

| 预算 | 作用域 | 单位 | 超限行为 |
| --- | --- | --- | --- |
| `maxCandidates` | 每分支 + 全局 | 候选数 | 分支截断并记 `cancelled` + `retrieval-budget-exhausted`（非 `timeout`）；全局截断必须在 `budget` 披露 |
| `maxBytes` | 每分支 + 全局 | 候选携带的 slice 字节（Inspect 之后） | 停止加入新候选；`cancelled` + `retrieval-budget-exhausted`；`pack_degraded` |
| `maxTokens` | 全局（可选） | token 估算 | 同上；tokenizer 来源记入 snapshot（`01` §9 开放问题 6） |
| `deadlineMs` | 每分支 + 全局 | 毫秒 | `timeout` + `retrieval-deadline-exceeded`；使用已有更低保证结果并披露 |
| `maxBranchesPerFile` | 每分支 | 同一文件返回的最大候选数 | 溢出候选记入 `rejected`（`cancelled` + `retrieval-budget-exhausted`） |

规则：

| 规则 | 内容 |
| --- | --- |
| BU-1 | 截断必须显式：`budget.used*` 与实际返回数一致，且被截断的候选 id 必须出现在 `rejected[]`（或 `fusion.merged[]`，若属去重）；不得静默丢弃。 |
| BU-2 | 预算不等于质量阈值；不得用预算逼近值推断「无匹配」。 |
| BU-3 | 任何分支不得借用其他分支的剩余预算（避免一个 provider 拖垮全链路）。 |
| BU-4 | 全局预算用尽后，未执行分支的 `coverage.status` 为 `cancelled`（`retrieval-budget-exhausted`），不得留空，**也不得**写为 `timeout`（`02` §3.4 TC-3）。 |

## 4. 取消语义

| 取消来源 | 结果状态（共享状态） | reason.code（`02` §3.5） | 行为 |
| --- | --- | --- | --- |
| deadline 到期（分支 / operation / Inspect） | `timeout` | `retrieval-deadline-exceeded` | 丢弃该分支部分结果 |
| 调用方取消 | `cancelled` | `retrieval-cancelled-by-caller` | 丢弃；不做部分保留 |
| operation 取消（上游撤销，非 deadline） | `cancelled` | `retrieval-cancelled-by-operation` | 同上 |
| epoch fence（旧 Attempt / 旧 epoch） | `cancelled` | `retrieval-epoch-fenced` | 丢弃；只记 stale diagnostic |
| 预算耗尽（分支未完成 / 未启动） | `cancelled` | `retrieval-budget-exhausted` | 丢弃未完成部分；已完成的候选保留 |
| plan 显式 early stop | `cancelled` | `retrieval-early-stopped` | 未启动分支不再执行；必须逐条记录 |

规则：取消必须**可归因**；`cancelled` 与 `timeout` 不得混写（`01` DL-2）。不支持的 provider 用进程终止实现有界取消，并把该事实写入结果（`01` DL-3）。

## 5. canonicalization

候选在被去重与融合之前，先规范化为 `canonicalLocatorKey`：

```text
canonicalLocatorKey =
  scheme + "|" + worktreeId + "|" + pathNfc + "|" + (range ? `${startLine}:${endLine}` : "*") + "|" + generationSemantic
```

| 规则 | 内容 |
| --- | --- |
| CA-1 | 路径使用 NFC 规范化、`/` 分隔、worktree 相对；**保留大小写与非 ASCII**（不做 lowercasing / slugify）。 |
| CA-2 | 拒绝绝对路径、盘符、UNC、`..`、尾随空白与 `.` 段；解析后必须仍在 worktree 根内。 |
| CA-3 | 行范围为 1-based 闭区间；`null` 与「整文件」等价，必须统一写成 `null`（不得出现 `0:0`）。 |
| CA-4 | 不同 generation 的候选**不**合并（`generationSemantic` 进入 key）。 |
| CA-5 | `artifact` / `transcript` / `external` scheme 使用各自稳定 id；`external` 用 `canonicalUrl` 的 hash。 |
| CA-6 | canonicalization 失败时分两类：路径越出 scope（绝对路径、盘符、UNC、`..`、符号链接越界）→ `permission_denied`（`retrieval-path-outside-scope`）；格式非法或 scheme 未知 → `invalid_response`。两者都进 `rejected`，并记 scope 违规计数（越权情形）。**不得**记 `unconvertible`：后者只用于 ABI V3 ref 转换失败（`02` §7 AB-7）。 |
| CA-7 | canonicalization 必须确定性且与平台无关（同一路径在 Windows / Linux 上得到同一 key，除大小写本身不同）。 |

## 6. 去重与合并

| 规则 | 内容 |
| --- | --- |
| DD-1 | 去重键 = `canonicalLocatorKey`；完全相同的 key 合并为一条 `keptId`，其余记入 `mergedIds`。 |
| DD-2 | 合并不得丢失 provenance：`RK.fusion.merged[]` 必须列出全部被合并 id，且所有来源分支都保留在 `inputs[]`。 |
| DD-3 | 合并保留信息最完整的一条作为 `keptId`（判定顺序：Inspect ok > 有 symbol > 有 slice hash > 有 branchRank）。 |
| DD-4 | 语义相似度可以**提议**聚类（同文件相邻范围），但聚类结果只能产生 `mergedIds` 建议，且必须人工可审计；跨文件聚类不得自动合并。 |
| DD-5 | 不得跨 worktree / 跨 generation / 跨 revision 合并。 |
| DD-6 | 被合并的候选如果 Inspect 失败，`keptId` 必须回退到次优候选；若全部失败，整组进入 `rejected`。 |

## 7. rank fusion（RRF）

```text
score(candidate) = Σ_branches  weight(branch) / (k + rank(branch, candidate))
```

| 规则 | 内容 |
| --- | --- |
| FU-1 | `k` **没有默认值**：必须由 plan 显式给出并记录在 ERM；阶段 1a 之前不得写死。 |
| FU-2 | `method = "none"` 时按单一分支 rank 排序，仍必须记录 `inputs[]`。 |
| FU-3 | 排序必须有确定性 tie-break：`(score desc, canonicalLocatorKey 的 UTF-8 字节序 asc, branch 顺序 asc)`。 |
| FU-4 | semantic 的 `similarity` 只作为该分支的 rank 来源；不直接进入融合公式的数值域，避免不同 `similarityMetric` 混用（`01` SC-7）。 |
| FU-5 | shadow 分支可以参与 rank 计算用于评测对照，但其候选不得进入 `items`（`01` PK-5）；对照结果记录在评测平面。 |
| FU-6 | 融合不得引入未在 plan 中启用的分支。 |
| FU-7 | 融合结果必须可复算：`packHash` 复算不一致 → 评测 `invalid`（`02` PK-10）。 |
| FU-8 | `weight(branch)` 若使用非等权，必须写入 plan 与 ERM；未记录即为非法。 |

## 8. coverage

```ts
interface BranchCoverageV1 {
  branch: string;
  mode: "authoritative" | "shadow";
  status: FactStatusV1;                     // 共享状态（01 §3.3 / 09 §3）；受 02 §3.2 适用性约束
  reason: ReasonV1 | null;
  requested: number; returned: number;
  deadlineMs: number; elapsedMs: number;
  scopeCovered: { pathScopes: number } | null;
  shardsSearched: number | null; shardsTotal: number | null;
}
```

| 规则 | 内容 |
| --- | --- |
| CO-1 | 每条**启用**分支恰好一条 coverage 条目，不多不少（`01` PK-1）。 |
| CO-2 | `status = ok` 只表示「该分支在本次 scope、generation、revision、deadline 内完成且无错误」；**不**表示「不存在其他匹配」。 |
| CO-3 | 分支被截断（预算）时 `status` 为 `cancelled` + `retrieval-budget-exhausted`，不得为 `ok`，也不得为 `timeout`（`02` §3.4 TC-3）。 |
| CO-4 | semantic 分支的 `shardsSearched/shardsTotal` 缺失时记 `unknown`，且该分支 `status` 不得为 `ok`（因为覆盖不可证）。 |
| CO-5 | shadow 分支的 coverage 必须记录，但不参与 `outcome` 判定（`02` PK-8）。 |
| CO-6 | coverage 汇总只允许确定性计算；provider 自报的 coverage 只作为 `ObservedV1` 观测，不得直接作为结论。 |

## 9. early stop

| 条件 | 行为 |
| --- | --- |
| 所有 authoritative 分支 `ok` 且候选数已达 `maxCandidates` | 可提前停止剩余分支（必须逐条记录被提前停止的分支为 `cancelled` + `retrieval-early-stopped`） |
| 最高 rank 候选已满足 plan 的显式充足条件（若 plan 声明） | 同上；plan 未声明时不得提前停止 |
| deadline 剩余时间不足以完成某分支 | 该分支直接记 `timeout` + `retrieval-deadline-exceeded`，不启动（时间是真实耗尽） |
| `pack_blocked`（例如 scope 违规） | 立即停止所有分支 |

规则：early stop 必须是**计划显式允许**的；默认全分支执行完毕。任何 early stop 都不得使 `outcome` 变成 `pack_empty_observed`。

## 10. abstain

| 规则 | 内容 |
| --- | --- |
| ABST-1 | `abstain.decided = true` 只在「所有 authoritative 分支 `coverage.status = ok` 且零命中」时允许（`01` PK-2 / PK-6）。 |
| ABST-2 | 任一 authoritative 分支非 ok → `basis = "insufficient_coverage"`，且 `outcome ≥ pack_degraded`。 |
| ABST-3 | `abstain` 是**观察**，不是事实；不得作为「证明不存在」的声明（`01` PK-6）。 |
| ABST-4 | semantic 的相似度不得用于 abstain 判定；即使所有 semantic 候选相似度极低，也不构成 abstain 依据。 |
| ABST-5 | no-gold 用例的「正确 abstain / 错误 abstain / 错误返回」使用独立分母（`10-evaluation-matrix`）。 |

## 11. stale / partial / unknown

| 情形 | pack 表达 |
| --- | --- |
| 部分分支成功、部分失败 | `outcome = pack_degraded`；`coverage[]` 逐分支记录；`fallback.used = true` |
| generation 过期 | 相关候选进 `rejected`（`generation_mismatch`）；分支 coverage 记 `generation_mismatch` |
| revision 过期 | 候选进 `rejected`（`revision_mismatch`）；若整分支受影响则分支 `stale` |
| 无法判定（例如无 VCS、无 symbol 解析） | `unknown` + `reason.code = retrieval-check-indeterminate`；不得折叠成 ok |
| 全部 authoritative 分支失败 | `outcome = pack_blocked`；不得返回空 pack 当作结果 |
| provider 不可用 | `provider_unavailable`；`fallback.used = true`；见 `06` |

## 12. fallback reason 与 provider failure 披露

`RetrievalPackV1` 必须携带（`01` §4.3 + `02` §4.3）：

```text
fallback.used       : boolean
fallback.from[]     : 发生降级的来源分支（例如 ["semantic"]）
fallback.reasons[]  : { code, detailHash }[]   ← 封闭枚举 code，不写自由文本
coverage[].status   : 每分支一等状态
coverage[].reason   : 非 ok 时必填
coverage[].status   : 逐分支一等状态（`09` §3.1）
coverage[].reason   : 非 ok 时必填（封闭 reason.code，`02` §3.5）
fallback.reasons[]  : 降级原因（封闭 code）
budget.used*        : 实际消耗（截断披露）
rejected[].status   : 未接受候选的状态与 reason
budget.used*        : 实际消耗
```

披露规则：

| 规则 | 内容 |
| --- | --- |
| FD-1 | 任何降级、截断、跳过、提前停止都必须在 pack 中可见（`03-stage-plan` U-9：无 silent success）。 |
| FD-2 | provider 原始错误文本不进入 pack；只保留 `reason.code` 与 `detailHash`（artifact）。 |
| FD-3 | `fallback.reasons[]` 至少区分：`provider_unavailable` / `timeout` / `cancelled` / `invalid_response` / `wrong_dimension` / `generation_mismatch` / `index_unavailable` / `egress_denied`。 |
| FD-4 | 「未启用分支」不进 `fallback`，也不计入降级率分母（`01` SP-1）。 |

## 13. semantic score 的允许与禁止

| 允许影响 | 具体方式 |
| --- | --- |
| 候选发现 | 通过 vector 检索产生 `SemanticCandidateV1` |
| 候选排序 | 作为 `semantic` 分支的 `branchRank` 参与 RRF |
| 去重 | 提议同一文件相邻 chunk 的聚类（`mergedIds` 建议，可审计） |
| 聚类 | 同文件/同模块分组，用于覆盖与展示 |
| Fetch 优先级 | 决定先 Fetch 哪个 `SearchHit`（`07`） |
| coverage | 只影响 semantic 分支自身的 coverage 统计 |

| 禁止证明 | 说明 |
| --- | --- |
| 当前源真实 | 需 Inspect + `fileHashRaw` |
| 行范围仍存在 | 需 Inspect range 检查 |
| 分支仍匹配 | 需 Inspect branch 检查 |
| workspace 有权限 | 需 permission / scope 检查 |
| 没有其他匹配 | 需全部 authoritative 分支 `ok` 且零命中（且仍只是观察） |
| 某事实成立 | 需 Evidence / corroboration（ABI V3 链路） |
| 某 Web 来源可引用 | 需 Fetch → Evidence（`07`） |

## 14. 不变量汇总

| ID | 不变量 |
| --- | --- |
| CP-1 | 每条启用分支恰好一条 coverage；`items` 只含 Inspect ok 的候选 |
| CP-2 | canonicalization 保留大小写与非 ASCII，不做任何重编码 |
| CP-3 | 去重可回溯（`mergedIds` + `inputs[]`），不静默合并 |
| CP-4 | `k` / `weight` 无默认值，必须显式记录 |
| CP-5 | 融合确定性：同输入 → 同 `packHash` |
| CP-6 | 截断、跳过、提前停止、降级全部披露 |
| CP-7 | semantic 分数不进入 evidence 字段，不影响 abstain 判定 |
| CP-8 | 取消与超时可区分且可归因 |
| CP-9 | 跨 worktree / generation / revision 永不合并 |

## 15. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| CP-R1 | `lexical` / `relation` 在阶段 1 是否都必须实现，还是允许 `relation` 由 `structural` 派生（影响阶段 1 AC 与分母） |
| CP-R2 | `canonicalLocatorKey` 是否包含 `revision`（本文按「不包含，但 generation 包含 semantic 分量」处理） |
| CP-R3 | RRF 的 `weight(branch)` 是否允许非等权；若允许，权重来源（plan / 基线 / 预注册） |
| CP-R4 | `maxBranchesPerFile` 的默认语义（`null` 表示无限制还是取全局值） |
| CP-R5 | early stop 的「显式充足条件」是否需要在 P0 就定义词汇（本文只定义机制） |
| CP-R6 | `coverageHint` 与 `coverage` 的合并规则（`02` RS-R4） |
