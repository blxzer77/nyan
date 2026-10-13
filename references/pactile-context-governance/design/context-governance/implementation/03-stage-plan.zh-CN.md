# 阶段 0–7 可执行计划（proposed）

- 状态：proposed。以下 Task / Run / Review 都是**提案**；按 `D:\MyHarness\.pactile\workflow.md`，只有用户同意提案后才能创建 Task，本线不创建。
- 依据：架构 §27.8（阶段映射）、§24/§24.1（基准规则）、§25（Host 轨道 P0–P6）、`workflow.md`（V2 Task：一个可审查交付物，带 ACs、交付级别、硬依赖；Run 保留授权、写集快照与结果；Review 绑定 Run 与确切候选；Close 需要最新 Review 通过且每条 AC 有证据）。
- 原则：**Controller pass ≠ 产品完成 ≠ Run completed ≠ settlement。** 每个阶段的 pass 只是该阶段评测事实；Task 的 Close 仍走 Kernel 流程。
- 数值：本计划**不设置任何质量阈值**。质量指标先在阶段 1 测基线；回归门槛只能在基线测量后、治疗臂运行前，预注册到 `EvaluationRunManifest`。零容忍项（§1.2）是规则，不是阈值。

## 1. 全阶段通用约定

### 1.1 通用门槛（任一阶段 ≥ 1 都适用）

| ID | 门槛 | 来源 |
| --- | --- | --- |
| U-1 | fixture 与 gold / negative labels 在任何运行之前冻结，记录 sha256、来源、标注者、是否独立于候选作者、是否盲审；修改只能产生新的 `caseSetHash` | 架构 §27.8；旧 harness 教训 |
| U-2 | 每个运行有 pre-run `EvaluationRunManifest`（`frozenAt` 早于任何结果）；缺失则结果为 `unverified` | 旧 v65 `preRunManifestPresent:false` |
| U-3 | 报告是 **paired**：基线臂与治疗臂用相同用例与 seed；分母显式，排除项列理由；provider 不可用是 `unverified`，不是 0 分 | `01` PCR |
| U-4 | 故障注入集（`04` §6）对该阶段新增的能力全部跑过，且每个故障的**预期状态**与**预期恢复**被断言 | 架构 §27.8 |
| U-5 | **Context Operation crash/replay fixture**：在 admission、manifest durable、policy 准入、artifact/manifest/receipt commit、compaction、audit 各步前后注入崩溃，恢复结果可解释且无重复副作用 | 架构 §27.8 新增门槛 1 |
| U-6 | **Pi compaction 与旧 Attempt/epoch 的 fence 测试**：旧 Attempt 的迟到结果被 `epoch_mismatch` 拒绝 | 架构 §27.8 新增门槛 2 |
| U-7 | **Evaluation Run 与产品 Run 隔离测试**：评测前后产品 store 字节级 hash 不变；EffectGateway 拒绝 `plane=evaluation` | 架构 §27.8 新增门槛 3 |
| U-8 | harness **阳性对照**：已知坏候选必须被判失败（`04` §7）；harness 自身缺陷单独记录，不混入候选结果 | 旧 P3/P5 harness 缺陷 |
| U-9 | 没有 silent success：任何降级、fallback、部分结果都在输出中披露原因 | 架构 §27.7 |
| U-10 | 高影响动作（数据外发、lossy、promotion、提交、发布）需要明确授权，授权记录进入 receipt | `AGENTS.md`、workflow |
| U-11 | 证据格式：每个 pass 绑定 candidate、fixture、`evaluationRunId` / `runId`、manifest、证据目录、具体分母与结果 | 任务书 |
| U-12 | 阶段退出必须能回滚到上一阶段（见各阶段回滚点） | 架构 §25 末段 |

### 1.2 零容忍计数器（任一非零即阶段 `fail`）

generation fence 违规数；数据外发违规数（未授权的 remote embedding / search）；silent success 数；越出 workspace / worktree 的读写数；reversible 动作后“还原不逐字节一致”数；评测期间产品 store 字节变化数；`plane=evaluation` 的 receipt 被入账数；`advisory` 被提升为 `host` / `kernel` 的数；`pack_empty_observed` 在 authoritative 分支非 ok 时出现的数。

> 本清单是 **CG 级零容忍计数器的权威定义**。各线可用线内前缀细化（例如 Compression 线的 `ZT-CM-1…ZT-CM-10`，见 `compression-memory-evaluation-matrix-v1` §6.3），但不得新增与 CG 清单冲突的语义，也不得把线内计数器当成全局编号；跨线汇总时按本清单归并（`05` §2.1 CF-24）。

### 1.3 可观察事件（提案；最终命名属 Protocol 线，随 `EventEnvelopeV1` 传输）

`cg.operation.admitted` · `cg.retrieval.branch.{started,completed,degraded}` · `cg.pack.built` · `cg.unit.manifest.durable` · `cg.judgment.recorded` · `cg.decision.{requested,admitted,blocked,review_required}` · `cg.effect.{intent,receipt}` · `cg.compaction.{started,completed}` · `cg.audit.completed` · `cg.memory.read` · `cg.fallback.used` · `cg.fault.injected` · `eval.run.{frozen,started,completed}` · `eval.report.written`。每个事件携带 `contextOperationId`（runtime）或 `evaluationRunId`（evaluation），不携带正文、embedding 或凭据。

### 1.4 候选写集的目录提案（仅阶段 ≥ 1，需授权）

```text
packages/cli/src/pactile/context-governance/
  contracts/      decoder · encoder · 负例 fixture 对应的类型（Node-neutral）
  retrieval/      Retrieval Controller（确定性分支 · fusion · Inspect 编排）
  compression/    ContextUnitizer · Judgment 封装 · DecisionRequest 构造
  coordinator/    Context Governance Coordinator
  evaluation/     Evaluation Controller（仅由评测入口引用；runtime 路径不得 import）
packages/cli/test/pactile/context-governance/**       测试与小型 fixture
D:\pactile-evidence\context-governance\               大型语料与评测结果根（仓库外，按 hash 注册）
```

不触碰：`packages/cli/src/pactile/agent/pi/**`（vendored Pi）、`retrieval/types.ts` 的 ABI V3（任何改动单独评审）、`D:\MyHarness\**`。

### 1.5 能力开关与回滚总则

运行时新能力默认**关闭**，由 capability policy 控制：`contextGovernance.mode ∈ {off, shadow, reversible, lossy}`。阶段 N 的回滚点 = 把 mode 退回阶段 N−1 的取值，并通过 Artifact 中保留的原文恢复；所有新增代码为增量文件，不覆盖现有文件。由于 `develop` 无提交，文件级回滚没有 git 基线，需先做只读快照（`05-writeset-rollback.zh-CN.md` §4）。

### 1.6 每阶段必交字段对照表（P0 冻结）

任务书要求每个阶段都给出 11 项。本表把它们逐阶段定位到具体产物；与本文各阶段小节的字段互为补充，不替代。空单元格不允许——没有内容的阶段必须写“无”。

**A. 验收与证据**

| 必交字段 | 阶段 0 | 阶段 1（1a / 1b） | 阶段 2 | 阶段 3 | 阶段 4 | 阶段 5 | 阶段 6 | 阶段 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acceptance criteria | AC-0.1…0.8 | AC-1a.1…1a.8 / AC-1b.1…1b.8 | AC-2.1…2.7 | AC-3.1…3.5 | AC-4.1…4.6 | AC-5.1…5.8 | AC-6.1…6.6 | AC-7.1…7.6 |
| fixture hash | 首次冻结 `caseSetHash` / `fixtureHash`（回填 `sha256:<pending>`） | 沿用 P0 集 + crash/replay 序列 fixture | + provider failure / wrong dimension 用例 | + oracle 标注集 | + 压缩用例集（protected/exact 锚点、race） | + restore 逐字节基准 | + lossy 负例（越权类别、audit 失败、semantic drift） | + promotion fixture（越权 scope、缺批准、secret、撤销） |
| gold / negative labels | 冻结 labels：来源、标注者、`independentOfCandidateAuthor`、盲审；`unknown` 不得用于放权结论 | 正样本 + no-gold（natural / counterfactual）+ wrong-repository，**独立分母** | + 维度 / 超时负例 labels | + 与 oracle 的一致性标注 | + `mustPreserveAnchors` 锚点集 | + restore 断言 labels | + 允许 lossy 类别白名单 labels | + secret / scope 负例 labels |
| failure state | `blocked` / `unverified` | 零容忍非零 → `fail`；determinism 不一致 → `fail`；harness 阳性对照失败 → `blocked`，结果均 `unverified` | `provider_unavailable` / `timeout` / `invalid_response` / `stale` / `wrong_dimension`（都不是 0 分） | CJ 全状态 | CJ / CDR；出现 lossy 执行跡象 → `fail` | `blocked` / `waiting` / `assurance_unknown` / `epoch_mismatch` / `manifest_conflict` | 同阶段 5 | `permission_denied` / `blocked` / `review_required` |
| 未验证项 | EmbeddingGemma 参数；候选身份；旧 gold 独立性 | 真实 provider 行为；Windows 大仓库规模；Node 24.0.0 | 真实模型质量 / 成本 / 隐私 | Jev 稳定性与成本 | 跨 provider 稳定性；真实净收益 | 长程稳定性；多 Run 并发 | semantic drift 度量有效性；用户感知质量 | retention / purge 策略 |

**B. 执行与治理**

| 必交字段 | 阶段 0 | 阶段 1（1a / 1b） | 阶段 2 | 阶段 3 | 阶段 4 | 阶段 5 | 阶段 6 | 阶段 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| candidate write set | 仅 `context-governance/**`（本线 `implementation/**`） | 1a：contracts / retrieval（确定性）/ compression（lossless 纯函数）/ evaluation；1b：coordinator + Host 对接（Host 线写集） | retrieval semantic 分支 + provider adapter | retrieval 的 Jev 封装 | compression 的 Jev 封装 + 反事实回放 | coordinator + compression 执行路径 + Policy 规则 | compression lossy 路径 + Policy 规则 | Kernel command 路由（Kernel 线）+ recommendation 构造 |
| rollback point | 移除新增文档（先快照） | `contextGovernance.mode = off` | `mode: shadow` → 移除分支配置 | 关闭 Jev provider | 关闭 Jev provider | `mode: shadow` + 从 Artifact 原文恢复 | `mode: reversible` + 原文恢复 | revoke 命令 |
| observable events | 无（仅 `eval.run.frozen` 模板） | 1a：`eval.run.*`；1b：`cg.operation.admitted` / `cg.unit.manifest.durable` / `cg.decision.*` / `cg.effect.*` / `cg.memory.read` | `cg.retrieval.branch.*` / `cg.fallback.used` | `cg.judgment.recorded` | `cg.judgment.recorded` / `cg.decision.requested` | `cg.effect.*` / `cg.compaction.*` / `cg.audit.completed` | 阶段 5 全部 + `cg.decision.review_required` | Kernel command / evidence 事件 |
| review entry | `cg-p0-contract-freeze` | `cg-p1a-offline-baseline` / `cg-p1b-runtime-baseline` | `cg-p2-semantic-shadow` | `cg-p3-jev-retrieval-shadow` | `cg-p4-jev-compression-shadow` | `cg-p5-reversible-actions` | `cg-p6-low-risk-lossy` | `cg-p7-memory-promotion` |
| next gate | 三线 `READY_FOR_P0`（已具备，见 `08` §2.6）+ AC-0 全部 + 用户授权 | 基线数字与方差已记录 + 预注册门槛 + 用户授权 1b | 预注册回归门槛未被突破 + 用户决定 semantic 是否进 pack | 一致率与不一致归因被 Review 接受 | “Jev 在哪些类别上可被信任为建议”的结论被接受 | AC-5 + 用户明确授权讨论 lossy | AC-6 + 用户决定是否讨论 promotion | 无自动下一步；扩大范围回到契约评审 |
| 允许 / 禁止的动作 | 允许：文档、fixture 清单、labels；禁止：运行时代码、真实 provider、长跑 | 允许：纯函数 + 评测 harness（1a）；禁止：产品 receipt、provider、Pi compaction | 允许：semantic adapter shadow；禁止：HTTP 200 当 ready、源码 / facts / 路径 / token 进日志或报告、新建 vector DB、让 semantic 分数证明“不存在 / 无权限” | 允许：记录判断；禁止：Jev 改变分支启用 / 预算 / deadline / 候选取舍 | 允许：记录建议 + 沙盒反事实回放；禁止：在产品 Run 上执行任何 Jev 建议 | 允许：`mask_reopenable` / `externalize` / `structured_project`；禁止：lossy、`drop`、promotion、commit 前执行不可逆动作 | 允许：白名单类别 lossy；禁止：exact / protected lossy、`drop`、audit 失败后继续 | 允许：产 recommendation；禁止：Controller 直写 Kernel、跳过 approval / evidence / receipt |

### 1.7 P0 裁定的阶段落地

| 裁定（`08`） | 落地位置 |
| --- | --- |
| 1 EmbeddingGemma 参数 + `unverified` | 阶段 2；PCS / ERM；未验证项登记 |
| 2 运行时改动冻结隔离 | 全部阶段；阶段 1 前必须建立候选快照 + 唯一写入者 |
| 3 tree-hash 候选身份 | 阶段 0 manifest 模板；阶段 1a 起每次重跑生成新 tree hash |
| 4 `ContextRetrievalPlanV2` / `schemaVersion 2` | 阶段 0 契约 |
| 5 ABI `RetrievalPlanV3` 经 `abiPlan` 引用 | 阶段 1a（`unconvertible` 断言，故障注入子用例 `FI-20.1` / 负例 #22）；不改 ABI |
| 6 八动作并集 | 阶段 4 shadow 记录全部 8 个 |
| 7 `drop` 不开放执行 | 阶段 4（只记录）/ 阶段 6（仍禁止） |
| 8 `SourcePointerV1` / `unconvertible` | 阶段 1a 负例 #22 + `FI-20.1`（`04` §6）；`memory` scheme 不参与 ABI 转换 |
| 9 阶段 1 不写 workspace index | 阶段 1a（默认只读）；1b 只记录方案不选择 |
| 10 原始字节 source hash + `textHash` | 阶段 1a Inspect 断言（负例 #25） |
| 11 外发 deny-by-default | 阶段 2 / 3 / 4；FI-22；零容忍计数器 |
| 12 Pi 版本不一致只标 `unverified` | 阶段 1b / 5；PCS `role: pi-compaction`；P0 不改 lockfile |

## 2. Task / Run / Review 映射（提案）

| 阶段 | 提案 Task id | 交付级别 | 硬依赖 | Run 划分 | Review |
| --- | --- | --- | --- | --- | --- |
| 0 | `cg-p0-contract-freeze` | `documentation` | 无 | 每次授权的文档写集一个 Run | 独立 Reviewer（非作者）绑定候选 = 文档集 hash |
| 1a | `cg-p1a-offline-baseline` | `local-result` | `cg-p0-contract-freeze` | 先 harness 阳性对照 Run，再基线 Run | 独立 Review，候选 = 代码 tree hash + fixture hash |
| 1b | `cg-p1b-runtime-baseline` | `local-result` | `cg-p1a-offline-baseline` + Host 轨道 P1、P2 的 Task | 每个 durable 步骤一个 Run | 同上，另含 crash/replay 证据 |
| 2 | `cg-p2-semantic-shadow` | `local-result` | `cg-p1a-offline-baseline`；外发授权 | readiness fixture Run → shadow Run | 同上 |
| 3 | `cg-p3-jev-retrieval-shadow` | `local-result` | `cg-p2-semantic-shadow` | shadow Run | 同上 |
| 4 | `cg-p4-jev-compression-shadow` | `local-result` | `cg-p1b-runtime-baseline`、`cg-p3-jev-retrieval-shadow` | shadow Run（含 sandbox 反事实回放） | 同上 |
| 5 | `cg-p5-reversible-actions` | `local-result` | `cg-p4-jev-compression-shadow`；Host P2 完成 | 每个动作类型一个 Run | 同上，另含 restore 逐字节证据 |
| 6 | `cg-p6-low-risk-lossy` | `local-result` | `cg-p5-reversible-actions`；正式授权 | 每个授权范围一个 Run | 同上，另含 post-audit 失败路径证据 |
| 7 | `cg-p7-memory-promotion` | `local-result` | `cg-p6-low-risk-lossy`；Kernel command 路由 | 每个 scope 提升一个 Run | 同上，另含批准 / 证据 / 撤销路径 |

交付级别均不是 `pull-request` / `merged-result`：当前**没有提交授权**。每个 Task 的 Close 需要最新 Review 通过且每条 AC 有证据，与本计划中的 Controller / Evaluation pass 无关。

---

## 阶段 0：Contract 与评测冻结

| 项 | 内容 |
| --- | --- |
| 目标 | 冻结 Context Governance 契约、fixture、gold / negative labels、RunManifest、报告格式 |
| 允许 | 写文档、写 fixture 清单与 labels 文件、计算 hash、独立 Review |
| 禁止 | 修改运行时代码；接真实 Jev / EmbeddingGemma；启动真实长跑；创建 vector DB；执行 compaction；promotion |
| 验收 | **AC-0.1** `01` 的 12 个实体（T1）与 `09` §1 的 9 个 T2 支撑类型都有字段表、版本、hash 规则、provenance、plane 适用性与生命周期（共 21 个登记项），且 14 个非 ok 状态作为一等结果、折叠规则唯一（`09` §3.2）；**AC-0.2** `01` §7 的 18 条负例 + `09` §6 的 #19–#28（共 28 条）各有 fixture 清单（输入 + 期望的 decode 失败原因）；**AC-0.3** Retrieval 线与 Compression 线的详细契约与本文不变量无冲突，或冲突已登记并裁定（登记表见 `05` §2.1）；**AC-0.4** fixture 清单、gold / negative labels 冻结并记录 sha256、标注者、独立性、盲审；**AC-0.5** `EvaluationRunManifest` 与 `PairedComparisonReport` 模板定稿，含预注册字段；**AC-0.6** 故障注入清单（`04` §6）定稿，每项有预期状态与预期恢复；**AC-0.7** BL-02/03/04/06/07 有结论；**AC-0.8** 旧证据迁移表（`07`）与旧问题转 regression case 的清单通过 Review。**AC-0.4 的“已冻结值”仍为 `sha256:<pending>`（AC-0.1 的字段表已闭合），故阶段 0 尚不可判完成。** |
| fixture / hash | 本阶段**产生**：`caseSetHash`、`fixtureHash` 清单。尚无可引用的 hash；清单里的位置先写 `sha256:<pending>`，冻结时回填 |
| 候选写集 | 仅 `D:\pactile\docs\architecture\context-governance\**`；如获授权，另改架构 §23/§24/§26 与 `docs/migration/**` 的状态行 |
| 回滚点 | 文档均为新增文件；回滚 = 移除这些文件（先快照）。架构文档的修订应以单独的可逆补丁形式提交审查 |
| 可观察事件 | 无运行时事件；产出 `eval.run.frozen` 的**模板** |
| 失败状态 | `blocked`（依赖未决，如候选身份、外发策略）；`unverified`（labels 缺来源 / 盲审） |
| Review 入口 | `cg-p0-contract-freeze` 的独立 Review：核对 AC-0.1…0.8，逐条给证据 |
| 下一闸门 | 三线 `READY_FOR_P0`（本线汇总）+ AC-0 全部满足 + 用户授权进入阶段 1a |
| 未验证项 | EmbeddingGemma 参数（无调研产物）；候选身份方案；旧 gold 的标注者独立性（旧文件中未见记载） |

## 阶段 1a：确定性 baseline（离线 / evaluation 平面）

| 项 | 内容 |
| --- | --- |
| 目标 | 在**不产生任何产品 receipt** 的条件下建立确定性基线：exact、structural、Inspect、lossless mask 与 deterministic externalize 的**纯函数**部分；artifact read-back；receipt / manifest 的**干跑**形状 |
| 允许 | 新增 contracts decoder 与 Controller 的确定性实现；评测 harness（fixture registry、runner、阳性对照）；在 evaluation 平面使用 fake RunLedger / Artifact / Manifest 端口 |
| 禁止 | 产生任何 `plane=runtime` 的 receipt；连接真实 provider；改变任何现有运行路径；修改 `agent/pi/**` |
| 验收 | **AC-1a.1** decoder 通过全部负例；**AC-1a.2** **determinism**：同输入、同 `policyVersion`、同 seed，在 ≥3 次独立进程运行中 `bodyHash` 全部相同（重复次数记录于 ERM）；**AC-1a.3** 检索基线指标按 `04` §8 的口径全部**测量并记录**（Recall@1/5/20、MRR、precision / F0.5、Inspect 后有效率、正确 abstain、p50/p95/p99、候选 bytes / tokens），**不设阈值**；**AC-1a.4** Inspect 只信任当前工作树原始字节，`stale / missing / permission_denied / revision_mismatch` 全部作为一等结果出现并被断言；**AC-1a.5** lossless mask / externalize 的 restore **逐字节一致**；**AC-1a.6** artifact read-back 校验 hash / scope / revision；**AC-1a.7** 阳性对照：至少 3 个已知坏候选（越权读取、生成 hash 不稳定、静默丢弃 rejected）被判 `fail`；**AC-1a.8** U-7 隔离测试通过 |
| fixture / hash | 本地小型 fixture（契约与故障路径）+ 冻结的公开 snapshot；hash 在阶段 0 回填。no-gold、wrong-repository、删除 / 重命名、分支切换、stale index 各自独立分母 |
| 候选写集 | `context-governance/contracts/**`、`retrieval/**`（确定性分支）、`compression/**`（ContextUnitizer、lossless 纯函数）、`evaluation/**`、对应 `test/**`；仓库外的评测结果根 |
| 回滚点 | 全部为新增文件；`contextGovernance.mode = off`；回滚 = 移除新增目录（先快照） |
| 可观察事件 | `eval.run.*`、`eval.report.written`；evaluation 平面的 `cg.*` 事件（带 `evaluationRunId`） |
| 失败状态 | 任一零容忍计数器非零 → `fail`；determinism 不一致 → `fail`；harness 阳性对照未被判失败 → `blocked`（harness 无效，结果全部 `unverified`） |
| Review 入口 | `cg-p1a-offline-baseline`：Reviewer 复核 ERM、报告、证据目录，并**独立重跑**阳性对照 |
| 下一闸门 | 基线数字与方差被记录；预注册的回归门槛写入后续阶段的 ERM 模板；用户授权进入 1b（并确认 Host 轨道前置） |
| 未验证项 | 真实 Provider 下的行为；Windows 大仓库规模；Node 24.0.0 最低版本 |

## 阶段 1b：确定性 baseline（运行时 / runtime 平面）

| 项 | 内容 |
| --- | --- |
| 目标 | 把 1a 的确定性动作接入 Host：Context Operation admission、ContextUnitManifest durable、Policy Gate 准入（仅确定性规则）、durable receipt、artifact / manifest / receipt 提交、`memory.read` 恢复 |
| 前置 | Host 轨道：`RunLedgerV1` + 唯一 Lease/Epoch + EffectGateway（架构 §25 的 P1、P2）。**这些不存在时本阶段不能开始**（BL-05），否则 receipt 会落入第二套权威 |
| 允许 | 在 `contextGovernance.mode = shadow`（只记录）或经授权的 `reversible` 小范围试点下运行；使用真实 Artifact / Manifest 端口 |
| 禁止 | 任何 lossy 动作；Jev / Embedding 参与决策；绕过 Policy Gate；`plane=evaluation` 的实体入账 |
| 验收 | **AC-1b.1** 对账：每个 runtime CDR / CAR 在 ledger 有对应 `operationId`，且无孤儿；**AC-1b.2** U-5：admission → manifest durable → 准入 → commit → audit 每步前后崩溃，恢复结果可解释、无重复副作用、unknown effect 不自动 replay；**AC-1b.3** U-6 epoch fence；**AC-1b.4** manifest CAS 冲突得到 `manifest_conflict` 并重试或阻断，不覆盖；**AC-1b.5** `memory.read` 的 missing / denied / stale / hash 不符均得到对应一等状态；**AC-1b.6** 重启后 transcript 与 checkpoint 的 snapshot 一致（回应 Compression 线 B-CM-2）；**AC-1b.7** U-7 隔离测试在含真实端口的组合下仍通过；**AC-1b.8** 报告中 `pack_*` 与 `verdict` 不改变 `RunV1` 状态 |
| fixture / hash | 沿用 1a 冻结集 + crash/replay 序列 fixture（新增，同样冻结 hash） |
| 候选写集 | `coordinator/**`、Host composition 对接（属 Host 轨道写集，需联合评审）、对应测试 |
| 回滚点 | `mode: off`；已写入的 receipt 保留（不删除证据）；Context 如被替换则从 Artifact 原文恢复 |
| 可观察事件 | `cg.operation.admitted`、`cg.unit.manifest.durable`、`cg.decision.*`、`cg.effect.*`、`cg.audit.completed`、`cg.memory.read` |
| 失败状态 | `blocked`、`waiting`、`assurance_unknown`、`epoch_mismatch`、`manifest_conflict`；任何一种都不得被转成成功 |
| Review 入口 | `cg-p1b-runtime-baseline` |
| 下一闸门 | AC-1b 全部满足；Host 轨道对应 Task 已 Close；用户授权 |
| 未验证项 | 多 Run 并发；真实 Pi SessionManager v3 的 tree / branch / fork；Node 22 |

## 阶段 2：EmbeddingGemma semantic shadow

| 项 | 内容 |
| --- | --- |
| 目标 | 引入 `SemanticProvider`，先在 shadow 中验证；**只改变候选召回，不改变压缩动作** |
| 前置 | 阶段 1a 完成；EmbeddingGemma 调研产物（BL-02）或接受“参数 + unverified”；若使用远程端点，数据外发授权（BL-16） |
| 允许 | `SemanticProvider` adapter；`embeddingModelId / embeddingDim / promptVersion / chunkerVersion / semanticGeneration` 写入 generation；RRF 或其他 rank fusion、dedupe、coverage；exact / structural 作为 fallback；**readiness fixture**（端点、返回维度、task prefix、标题处理、batch、有限浮点数、超时 / 取消、错误响应、日志脱敏、外发授权） |
| 禁止 | 把 HTTP 200 当作 ready；把源码 / facts / 路径 / token 写进 provider 日志或报告；新建 vector DB 或第二条 indexing pipeline（除非 P0 另行批准）；让 semantic 分数证明“真实 / 无匹配 / 权限 / Evidence” |
| 验收 | **AC-2.1** readiness fixture 全绿，且每一项以独立 probe 为准；**AC-2.2** 模型 / 维度 / prompt / chunker 任一变化使 `semanticGeneration` 失效，并触发重建或回退（故障：wrong generation、wrong dimension）；**AC-2.3** provider timeout / unavailable / invalid response 时 exact + structural fallback 生效，并披露降级原因；**AC-2.4** paired ablation：A0 = exact + structural，A1 = A0 + semantic（shadow），报告 Recall@k、MRR、precision / F0.5、Inspect 后有效率、正确 abstain、fallback 触发率、p50/p95、候选 bytes / tokens、外发违规数；**AC-2.5** 所有 semantic 候选经过当前工作树 Inspect；**AC-2.6** 零容忍计数器全为 0；**AC-2.7** 是否让 semantic 候选进入 RetrievalPack 的结论只是建议，**需要单独授权** |
| fixture / hash | 沿用阶段 0 冻结的检索 fixture；新增 provider failure、wrong dimension 用例（同样冻结） |
| 候选写集 | `retrieval/**`（semantic 分支与 fusion）、provider adapter、测试；**不**新增索引 pipeline |
| 回滚点 | 该分支 `mode: shadow` → 移除分支配置；A0 路径始终保持可用 |
| 可观察事件 | `cg.retrieval.branch.*`（带 `semanticGeneration`）、`cg.fallback.used` |
| 失败状态 | `provider_unavailable`、`timeout`、`invalid_response`、`stale`（generation）→ fallback + 披露，**不是 0 分** |
| Review 入口 | `cg-p2-semantic-shadow` |
| 下一闸门 | AC-2 全部满足；paired 结果显示 A1 相对 A0 的预注册回归门槛未被突破；用户决定是否放开 semantic 候选进入 pack |
| 未验证项 | 真实 EmbeddingGemma 质量；成本；中文到英文实现类查询的效果；隐私策略 |

## 阶段 3：Jev retrieval shadow

| 项 | 内容 |
| --- | --- |
| 目标 | 记录 Jev 的检索判断（planning judgment），与**确定性 oracle**对照；真实执行仍由确定性规则控制 |
| 允许 | 把 Jev 作为 `DecisionProvider` 调用，产出 CJ 形式的检索建议；与 oracle（gold labels 派生）对比；记录一致率、延迟、成本 |
| 禁止 | Jev 输出改变分支启用、预算、deadline 或候选取舍；把 confidence 当权限 |
| 验收 | **AC-3.1** schema 合规率（decode 成功率）与失败分布（timeout / invalid / unavailable）全部记录；**AC-3.2** 与 oracle 的一致 / 不一致样本入库，**不一致样本逐个归因**；**AC-3.3** 低置信度、schema mismatch、超时、provider unavailable 均降级为确定性规则（断言 pack 与无 Jev 时 `bodyHash` 相同）；**AC-3.4** calibration 只报告，不用于放权；**AC-3.5** U-7 隔离、零容忍计数器为 0 |
| fixture / hash | 沿用检索 fixture + 阶段 0 冻结的 oracle 标注 |
| 候选写集 | `retrieval/**` 的 Jev 封装、评测 harness |
| 回滚点 | 关闭 Jev provider 配置即回到阶段 2 |
| 可观察事件 | `cg.judgment.recorded`（带 provider snapshot） |
| 失败状态 | 同 CJ；任何一种都不改变执行 |
| Review 入口 | `cg-p3-jev-retrieval-shadow` |
| 下一闸门 | AC-3 满足；一致率与不一致归因被 Review 接受 |
| 未验证项 | Jev 的稳定性与成本；旧 System One smoke 只是单次连通性，不是质量评测 |

## 阶段 4：Jev compression shadow

| 项 | 内容 |
| --- | --- |
| 目标 | 记录 Jev 对 8 个压缩动作（`01` §5）的建议，与确定性 Policy 裁决及 gold “必须保留”标注对照；**不执行任何破坏性 Jev 动作** |
| 前置 | 阶段 1b（有 durable CM 与 Policy Gate 的确定性裁决）、阶段 3 |
| 允许 | 产出 CJ / CDQ（仅记录）；在 **evaluation 平面的沙盒副本**里对 Jev 建议做反事实回放，并运行 CAR 的检查，估计“如果执行会丢什么” |
| 禁止 | 在产品 Run 上执行任何 Jev 建议；`lossy_compress` / `drop` 的真实执行 |
| 验收 | **AC-4.1** 8 个动作的建议分布、与 Policy 裁决的一致 / 冲突样本被完整记录；**AC-4.2** 对 gold “必须保留”的锚点，Jev 建议 lossy 的样本逐个列出，反事实回放的 CAR 检查结果被记录；**AC-4.3** 断言本阶段**没有**任何 lossy effect receipt（零容忍）；**AC-4.4** 低置信度 / 超时 / unavailable 全部降级到 `keep_full` / `externalize` / `request_review` 之一；**AC-4.5** 净 token / 延迟收益只在反事实回放中估计，并明确标注“未执行”；**AC-4.6** U-5…U-9 通过 |
| fixture / hash | 压缩用例：protected / exact 锚点、restore、wrong-repository、stale generation、missing / denied `memory.read`、compaction race、crash / replay、no-silent-success（`04` §5） |
| 候选写集 | `compression/**` 的 Jev 封装、评测反事实回放 |
| 回滚点 | 关闭 Jev provider；回到阶段 1b |
| 可观察事件 | `cg.judgment.recorded`、`cg.decision.requested`（仅记录） |
| 失败状态 | 同 CJ / CDR；任何 lossy 执行迹象 → `fail` |
| Review 入口 | `cg-p4-jev-compression-shadow` |
| 下一闸门 | AC-4 满足；Review 接受“Jev 在哪些类别上可被信任为建议”的结论（仍只是建议） |
| 未验证项 | 跨 Provider 稳定性（旧 v56 DeepSeek / GLM Connection error 仍保留）；真实净收益 |

## 阶段 5：可逆动作

| 项 | 内容 |
| --- | --- |
| 目标 | 经 Policy Gate 开放 `mask_reopenable`、`externalize`、`structured_project`；每次动作有 durable receipt；**禁止自动 promotion** |
| 前置 | 阶段 1b、阶段 4；Host P2 完成 |
| 允许 | `contextGovernance.mode = reversible`；Pi compaction **只在** Artifact / Manifest / Receipt 已 durable commit 之后执行（链路见 `01` §4.10、架构 §27.7） |
| 禁止 | `lossy_compress`、`drop`；任何 promotion；在 commit 前执行不可逆动作 |
| 验收 | **AC-5.1** 每个动作都有 CDR，并在 ledger 有 `operationId`；**AC-5.2** restore 逐字节一致（零容忍）；**AC-5.3** 动作期间崩溃：恢复到“动作未生效”或“动作已生效且有 receipt”，不存在中间态；**AC-5.4** post-compaction audit（CAR）全检查项 pass 才 `accepted`；**AC-5.5** pointer 经 `memory.read` 可读，且 missing / denied / stale 得到一等状态；**AC-5.6** 旧 Attempt / epoch 的迟到 compaction 结果被拒绝（U-6）；**AC-5.7** 净 token / 延迟收益以**真实执行**测量，报告 net benefit 与失败样本；**AC-5.8** 零容忍计数器为 0 |
| fixture / hash | 沿用阶段 4 冻结集 + restore 逐字节基准 |
| 候选写集 | `coordinator/**`、`compression/**` 的执行路径、Policy Gate 规则、测试 |
| 回滚点 | `mode: shadow`；用 Artifact 原文恢复已 mask / externalize 的单元；receipt 保留 |
| 可观察事件 | `cg.effect.{intent,receipt}`、`cg.compaction.*`、`cg.audit.completed` |
| 失败状态 | `blocked` / `waiting` / `assurance_unknown`、`epoch_mismatch`、`manifest_conflict`；audit 失败 → `restored` / `expanded` |
| Review 入口 | `cg-p5-reversible-actions`，另含 restore 的独立重跑 |
| 下一闸门 | AC-5 满足；用户明确授权讨论 lossy |
| 未验证项 | 长程稳定性；跨 Provider；多 Run 并发 |

## 阶段 6：低风险 lossy

| 项 | 内容 |
| --- | --- |
| 目标 | 只允许对**已有 pointer 的、非事实的、低风险说明**做 `lossy_compress`；强制 post-compaction audit |
| 前置 | 阶段 5；**正式授权**（`authorization.class = lossy`，带 grant 引用） |
| 允许 | `mode = lossy`，范围由 Policy 的白名单类别限定 |
| 禁止 | 对 exact / protected 内容 lossy；`drop`；自动 promotion；audit 失败后继续 |
| 验收 | **AC-6.1** 范围外的 lossy 请求全部被 Policy Gate `blocked` / `review_required`；**AC-6.2** 每次 lossy 前原文已 durable 且可恢复；**AC-6.3** audit 失败 → 恢复原 Artifact、扩大 Context、`blocked` / `waiting` / `assurance_unknown` 或生成 regression case（四选一，且被断言）；不存在“无法重读仍接受”；**AC-6.4** 每个 audit 失败自动生成 EC 型 regression case；**AC-6.5** 摘要不会被模型当作用户指令或事实（披露形式由 Compression 线定义，不得以 user role 注入）；**AC-6.6** 零容忍计数器为 0 |
| fixture / hash | 沿用阶段 5 + lossy 专用负例（越权类别、audit 失败、semantic drift） |
| 候选写集 | `compression/**` lossy 路径、Policy 规则、测试 |
| 回滚点 | `mode: reversible`；从 Artifact 原文恢复 |
| 可观察事件 | 同阶段 5 + `cg.decision.review_required` |
| 失败状态 | 同阶段 5 |
| Review 入口 | `cg-p6-low-risk-lossy` |
| 下一闸门 | AC-6 满足；用户决定是否讨论 promotion |
| 未验证项 | semantic drift 度量的有效性；用户感知质量 |

## 阶段 7：Memory promotion

| 项 | 内容 |
| --- | --- |
| 目标 | 记忆晋升走 **Recommendation → Kernel command → approval → evidence → receipt**；`run → workItem → project` 的最终提交**不由 Context Controller 直接完成** |
| 前置 | 阶段 6；Product Kernel 的 command 路由；宿主侧秘密扫描策略（Compression 线 B-CM-8） |
| 允许 | Controller 产出 recommendation（`promotion_recommendation`）；Kernel / Host 通过正式命令处理 |
| 禁止 | Controller 直接写 Kernel；Jev / Embedding / 评测报告直接成为 Evidence；跳过批准 |
| 验收 | **AC-7.1** recommendation 不含 secret，范围（scope）与来源明确；**AC-7.2** 缺批准 / 缺 evidence / 缺 receipt 时，Kernel command 被拒绝，不存在旁路；**AC-7.3** 晋升可撤销（revoke）且撤销有 receipt；**AC-7.4** personal memory 默认 append-only、有来源和作用域；**AC-7.5** 禁止对未授权历史内容的自动 replay；**AC-7.6** 零容忍计数器为 0 |
| fixture / hash | promotion 专用 fixture：越权 scope、缺批准、secret 泄漏、撤销 |
| 候选写集 | Kernel command 路由与适配器（Kernel 线写集）、recommendation 构造（`compression/**`） |
| 回滚点 | 通过 revoke 命令撤销；`mode` 回到 lossy / reversible |
| 可观察事件 | `cg.decision.*`、Kernel 的 command / evidence 事件 |
| 失败状态 | `permission_denied`、`blocked`、`review_required` |
| Review 入口 | `cg-p7-memory-promotion` |
| 下一闸门 | 无自动下一步；任何扩大范围都回到阶段 0 式的契约评审 |
| 未验证项 | retention / purge 策略（尚无自动删除；immutable artifact 永久保留不等于 retention 已完成） |

## 3. 阶段之间的“不得跳过”规则

- 没有阶段 1a 的基线数字与阳性对照，不得运行阶段 2 / 3 / 4 的 paired 比较。
- 没有阶段 4 的 shadow 结果、低置信度降级、no-gold / wrong-repository、恢复路径和 rollback 证据，**Jev 不能自动放权**（架构 §27.8 末段）。
- 阶段 5 之前，任何动作不改变上下文；阶段 6 之前，不存在 lossy；阶段 7 之前，不存在 promotion。
- 每个阶段的外发、lossy、promotion、提交、发布都需要独立授权，授权不继承。
