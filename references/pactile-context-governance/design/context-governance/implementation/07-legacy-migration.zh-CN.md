# 旧任务如何迁移到新任务（一页说明，proposed）

- 状态：proposed。本文只做映射和规则，不修改、不删除、不重启任何旧任务或旧证据。
- 读者：需要判断“旧的 retrieval-worker 评测、压缩 / 记忆评测、Native Agent 批次，现在算什么”的人。

## 1. 先说结论

1. **旧的“通过”一律降级为背景证据。** 它们绑定的是旧候选（MyHarness 的 `0a1dd4c3…` 或冻结的 retrieval-worker d25d33），不是 `D:\pactile` 的当前树，也没有新 manifest / 新 `evaluationRunId`。
2. **旧目标暂停，不删除。** “接真实 Provider / `pactile agent run` / Native E2E / Release preflight”移到 Host 轨道 backlog；Context Governance 的下一步是 P0 契约与评测冻结。
3. **旧 harness 的缺陷变成新 harness 的测试用例**（阳性对照 HV-1…6），而不是被默默修好。
4. **旧证据目录保持原样**：不重命名、不改 gold、不改分母、不补写 verdict。

## 2. 映射表

“状态”只描述旧结果的现状；“新用途”描述它在新计划里怎么用。

### 2.0 降级等级（P0 定义）

| 等级 | 含义 | 允许的引用方式 |
| --- | --- | --- |
| `historical` | 只用于理解历史、提取设计灵感与 negative case；不得作为任何阶段的通过依据 | 必须同时声明“已被取代”与“非证据” |
| `candidate evidence` | 可作为阶段 1 的**输入设计**参考（fixture 形状、臂设计、故障类型），但必须在新 manifest / 新 tree-hash 下重跑才能成为 evidence | 必须同时给出旧 candidate、旧 runId、旧分母 |
| `superseded goal` | 旧目标本身已被 Context Governance v1 阶段路线取代 | 只标注状态行，不改旧内容 |
| `unexplained` | 存在未核实的异常（如 P5 `fixtureMismatch`），不得描述为“已核实” | 必须显式列出未解释项 |

### 2.1 Retrieval Worker（candidate = `D:\MyHarness\pactile\packages\retrieval-worker`，冻结 d25d33）

| 旧项 | 旧状态（引用自已读文件） | 新阶段 / 用途 | 动作 |
| --- | --- | --- | --- |
| P1 contract | 无权威 run | 阶段 0：契约负例的灵感来源 → EC | 在新 manifest 下重建 |
| P2 exact | PASS：`exact-02-20261007-181929-d25d33` | 阶段 1a：exact 分支 fixture 与基线参考；**verdict 不迁移** | 新 run 重测 |
| P3 graph | 116 pass / 2 contract-finding / 1 INCONCLUSIVE | 阶段 1a：structural 分支 fixture；G1–G11 缺陷 → regression case；abort 窗口未证明 → 故障注入的待办 | 新 run 重测；不沿用旧结论 |
| P4 lifecycle | PASS：`lifecycle-04-20261007-190100` | FI-20 / FI-21（删除、重命名、分支切换）、generation fence 的 fixture 来源 | 新 run 重测 |
| P5 concurrency | PASS 29/29、309/309：`concurrency-05-20261008-004408`（注意 `fixtureMismatchCount=1` 未核实，BL-23） | FI-03 / FI-14 一类取消、写锁、close 后行为的 fixture 来源 | 新 run 重测 |
| P6 budget / fault | PASS：`p6-budget-fault-06-20261007-183546-final` | 预算与故障矩阵的格式参考（FI-03/04/05） | 新 run 重测 |
| P7 decision | 冻结前背景证据 | 阶段 3：Jev retrieval shadow 的输入设计 | 不作为证据 |
| P8 workflow / no-gold | **从未启动** | 阶段 1a：no-gold、wrong-repository 类别 | 作为 EC 类别重建 |
| P9 e2e 关联 | **从未启动** | 推迟：只能在阶段 5 之后作为下游相关性指标，不得回写为检索通过条件 | 不启动 |
| P10 final 汇总 | **从未启动** | 被 PCR + Review 取代 | 不启动 |
| smoke | 2/2 候选 smoke | 阶段 2 readiness fixture 的形状参考 | 不作为证据 |
| 旧提示词 `evaluation-agent-prompts.md`、Prompt 2–10 | — | 被 `pactile-context-governance-agent-prompts.zh-CN.md` 取代 | 不修改（在 MyHarness，只读） |

### 2.2 压缩 / 记忆（candidate = MyHarness `0a1dd4c3…` + dirty write set）

| 旧项 | 旧状态 | 新阶段 / 用途 | 动作 |
| --- | --- | --- | --- |
| B0 gate | 候选绑定通过 | ERM 的 candidate snapshot 与 pre/post hash 设计来源 | 格式迁移，不迁移 verdict |
| B2 mechanism | `20261005-b2-mechanism-v14-b3-fix`，40/40，确定性假 Provider | 阶段 1a：determinism 与臂设计（ctrl / mask / comp / both）参考；真实 Provider 质量分母 0 | 新 run 重测 |
| B3 recovery | Rapid：9/9 选定行，含一次真实进程中断；injected timeout 不算 strict pass | FI-14 / FI-19（crash、torn write）fixture 来源 | 新 run 重测 |
| B4 long-horizon | Rapid：25/25 settled、8/8 压缩；v65 `20261006-b4-full-100-rounds-v65` 18/100，`unverified`，已排除出 gate，`posthoc-invalid-for-gate` | 阶段 5 / 6：net-benefit 设计参考；**v65 不引用** | 不续跑 |
| B5 provider availability | 多次因 Connection error / 认证问题阻塞 | `ProviderCapabilitySnapshotV1` 的 `availability` 语义来源 | 格式迁移 |
| B7 action seam | 单一真实 GPT seam | 阶段 5：可逆动作 fixture 的参考；不是证据 | 新 run 重测 |
| B8 汇总 / goal audit | Rapid closure：7/7，**严格门槛 1/4 = 25%**，原始目标 open/deferred | 被 PCR + Review 取代；“25%”不沿用为新门槛 | 不沿用 |
| 独立复核 v63 | pass | 阶段 Review 流程的参考 | 流程迁移 |
| 旧 Policy 任务 `10-04-pactile-agent-context-memory-policy` | Kernel V2：Run `a11e0688-…` `completed`；1 个独立 Review（pass）；**已 Close**（`task.closed`，actor=`user`，2026-10-03T18:51:02Z） | Policy Gate 规则设计的输入（它只覆盖策略函数，未启动 native Pi bridge） | 保持现状：不改、不重开；新 Task 只把它当证据引用 |

### 2.3 Native Agent 批次（本线 / `D:\pactile`）

| 旧项 | 现状 | 新阶段 / 用途 | 动作 |
| --- | --- | --- | --- |
| Batch 2A Provider / Stream | 24 个 focused 测试通过；Provider port 与 adapter 已就位 | 作为 Provider 接缝继续有效；与 CG 无冲突 | 保持 |
| Session / Checkpoint / Effect Receipt / `agent run` 候选 | 已冻结（`00` §0）；含 DEF-IMPL-1…6 | 其设计意图转为 Host 轨道的 RunLedger / EffectGateway 需求；候选本身待 BL-03 处置 | 冻结 |
| `native-agent-gap-matrix` 第 2–11 行 | 全部 “未关闭” | 拆为 Host 轨道 backlog（RunLedger、EffectGateway、Recovery、`agent run`、E2E、release preflight）和 CG 阶段依赖（`02` §7） | 文档不改；在其顶部加状态行需授权 |
| Batch 2 Context / Compaction / Memory | 阶段 0–2 复核通过；阶段 3 受限；阶段 4 UNVERIFIED | 其中的设计与代码是 CG 阶段 1b / 5 的**候选输入**；其越权授权与 user-role 摘要注入已过时（Compression 线 §5） | 冻结；重新评审 |

### 2.4 旧证据降级登记（P0）

| 旧项 | 等级 | 不得再做的事 |
| --- | --- | --- |
| P2 exact（`exact-02-20261007-181929-d25d33`） | `candidate evidence` | 不得作为新候选的 exact 分支通过证据 |
| P3 graph（116 pass / 2 contract-finding / 1 INCONCLUSIVE） | `candidate evidence`；abort 窗口部分 `unexplained` | 不得当成 graph 分支可用；不得把 INCONCLUSIVE 写成 pass |
| P4 lifecycle（`lifecycle-04-20261007-190100`） | `candidate evidence` | 不得作为 generation fence / lifecycle 已实现证据 |
| P5 concurrency（`concurrency-05-20261008-004408`，29/29、309/309） | `candidate evidence`；`fixtureMismatchCount=1` 属 `unexplained` | 不得写成“fixture 未漂移”；不得用 `exitCode=0` 代替两个独立 verdict |
| P6 budget / fault（`p6-budget-fault-06-…-final`） | `candidate evidence` | 不得作为预算 / 故障矩阵已覆盖证据 |
| P7 decision | `historical` | 不得作为 Jev retrieval shadow 的输入端已就绪证据 |
| 旧 Rapid Evidence Closure（v1，严格门槛 1/4 = 25%） | `superseded goal` + `historical` | 不得把“7/7 项”写成全量目标通过；不得沿用 25% 作为新门槛 |
| v65 interrupted（18/100，`preRunManifestPresent:false`） | `historical`（已标 `posthoc-invalid-for-gate`） | 不得引用其任何数字；不得续跑 |

规则：以上旧项均**不迁移**为 `evaluationRunId`，也不进新分母；引用时必须同时写出 candidate、fixture、runId、manifest、证据目录、分母与结果（R-2）。

## 3. 迁移规则

| ID | 规则 |
| --- | --- |
| R-1 | 旧 runId（`bucket-时间戳` 形式）**不得**复用为 `evaluationRunId`；旧目录名保持不变 |
| R-2 | 引用任何旧“通过”时，必须同时写出 candidate、fixture、runId、manifest、证据目录、分母与结果；缺项则只能称“背景证据” |
| R-3 | 旧 gold 只能作为**新 labels 的提案来源**；采用时必须补 `labelProvenance`（标注者、独立性、盲审），并产生新的 `caseSetHash` |
| R-4 | 旧 harness 缺陷（P3 H1/H2、P5-H1…H13、v65 无 pre-run manifest）转为 HV-1…6 的检查项 |
| R-5 | 不启动 P1 / P3 重跑、P8 / P9 / P10、v65 类长跑，直到阶段 1a 被授权 |
| R-6 | 对旧文档的更正（P8 / P9 / P10 桶名映射、状态行）属文档修订，属 Retrieval 线写集（`08` §4）；本线记录 erratum（§3.1），不双写 |
| R-7 | 旧 Task 的 Kernel 状态不被改动；新 Task 只引用它们 |
| R-8 | 发现旧证据与新结论冲突时，新报告写明冲突并保留两者，不覆盖 |

### 3.1 P8 / P9 / P10 桶名映射更正（erratum，依据 `08` §1.3）

**更正内容**：

| 桶 | 旧文档的错误写法 | 正确含义（旧提示词定义） | 状态 |
| --- | --- | --- | --- |
| P8 | （已正确） | workflow / no-gold | 未启动 |
| P9 | “no-gold semantic” | **e2e 关联** | 未启动 |
| P10 | “Agent correlation” | **final 汇总** | 未启动 |

需要更正的两个旧文档：`docs/migration/retrieval-worker-d25d33.zh-CN.md` 与 `docs/migration/retrieval-worker-integration-design.zh-CN.md`。

**更正规则**：

1. 只改表述与状态行；不改旧证据、gold、分母、结果或目录名。
2. 两者都是“未启动”，因此任何暗示 P9/P10 “已评估 / 已有结果”的叙述都是错的。
3. 建议顶部状态行：“已被 Context Governance v1（阶段 0–7）取代；本文件保留为历史记录。”
4. **写集归属**：`docs/migration/**` 的更正属于 Retrieval 线的 P0 写集（`08` §4 “Retrieval Controller”）。本线只在本文件记录 erratum 与建议措辞，**本轮未修改 `docs/migration/**`**（避免两线双写，BL-17）；若用户要求 Implementation 直接应用，需显式授权。
5. P8 的 no-gold / wrong-repository 类别不因桶名而在新计划中消失，而是在阶段 1a 以 EC 类别重建（`04` §4.4）。

## 4. 迁移步骤（一页内的顺序）

1. 评审 `00`–`06`；用户给出 BL-01/03/04/06/07 的决定。
2. 三线各自返回 `READY_FOR_P0`；本线汇总。
3. 获授权后，在 `D:\pactile\docs\architecture\context-governance\` 下完成 P0 文档（各线详细契约、fixture 清单、labels、ERM 模板、故障清单）。
4. 把旧问题逐条转成 EC（regression case）：Compression 报告 §4 的 12 项、Worker 的 G1–G11、本线 DEF-IMPL-1…6、旧 harness 的缺陷。
5. 冻结 `caseSetHash` / `fixtureHash` / 标注；回填所有 `sha256:<pending>`。
6. P0 Review 通过后，用户另行授权阶段 1a。
7. 旧证据与旧任务全程只读。

## 5. 不迁移的东西（明确列出）

- 旧加权分（40/30/25/5）与 “严格门槛 1/4” 口径；
- 旧 −17.7% token 数字（fail-open 版本，非受控实验）；
- v65 的任何数字；
- 旧 P5 的 “29/29、309/309” 作为 *新* 候选的通过证据；
- 旧 B3 的 “injected timeout” 排除决定（新计划里 timeout 是一等状态，必须测）。

## 6. 文件哈希清单（供评审核对；`sha256` 前 16 位）

下表由 **P0 修复轮二**在所有写入完成后统一重算（修复轮一的哈希全部作废）。`07` 自身编辑后的哈希无法写入自身，随最终回执报告。`03` / `06` / `08` 本轮**未被修改**，其哈希与上一轮一致——可作为“未越权写入”的验证证据（`05` §1.4b）。

| 文件 | sha256[0:16] | 状态同步轮五是否修改 |
| --- | --- | --- |
| `00-rebase-report.zh-CN.md` | `0403ca1771b58549` | 否 |
| `01-contract-draft.zh-CN.md` | `276c2b164ed53b3b` | 否（轮三已改 CF-43/44/45） |
| `02-ownership-dependency.zh-CN.md` | `4de06c274a53d3f4` | 否 |
| `03-stage-plan.zh-CN.md` | `ec5f36a8ece751b0` | 否 |
| `04-evaluation-controller.zh-CN.md` | `5898985918c70197` | 否（轮三已改） |
| `05-writeset-rollback.zh-CN.md` | `20aeabd19c714aa5` | 是（CF-46…CF-49 + §1.4e + 统计） |
| `06-blockers.zh-CN.md` | `456c7bd174b1b49a` | 否 |
| `07-legacy-migration.zh-CN.md` | （本表写入后本文件被修改，故随回执报告） | 是（仅本表） |
| `08-p0-admission-decision.zh-CN.md` | `9433796e0739adf6` | 否（用户裁定文件） |
| `09-contract-entities-v1.zh-CN.md` | `cdb58d4df4cf27b2` | 是（§3 判定表：陈旧 `timeout` 行改为实际码 + 失效声明） |
| `10-p0-exit-checklist.zh-CN.md` | `d7aef96011e34afe` | 是（§0 / §1 / §3 / §4） |

> 轮三哈希（历史）：`01` = `276c2b164ed53b3b`、`04` = `5898985918c70197`、`09` = `d64173ff20dfe9bd`、`10` = `af2326b674052b50`；轮五仅 `05` / `09` / `10` 发生变化。

注意：上表是“修复轮二文档定稿后、回执写作前”的快照；任何后续写入必须重新计算并在下一轮回执中替换（不得手改单个字符后沿用旧哈希）。
