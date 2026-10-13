# 旧 Retrieval Worker 任务迁移表（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。**只做映射与状态标记，不改任何旧证据、gold、分母或结果文件。**
- 依据：`00-rebase-report.zh-CN.md`；`../implementation/07-legacy-migration.zh-CN.md`；`../implementation/08-p0-admission-decision.zh-CN.md` §2.2、§4；`../implementation/06-blockers.zh-CN.md`（BL-02…BL-23）。
- 铁律：**旧 Prompt 1–10 的 PASS/VOID/INCONCLUSIVE 只能作为历史或 candidate evidence，不能升级为新架构通过**（`08` 裁定 2）。

## 1. 旧桶 → 新阶段映射

| 旧桶（Prompt） | 旧 runId / 目录 | 旧结论 | 新归属 | 迁移处理 |
| --- | --- | --- | --- | --- |
| P1 contract | `20261004T150309Z-contract01`、`20261005T002500Z/004500Z-contract01` | 无权威 run（无 `verification.json`） | 阶段 0 契约冻结的一部分 | 不重跑；契约结论由本线 `01`–`12` 取代 |
| P2 exact | `exact-02-20261007-181929-d25d33`（480 + 75 行，verify 0 失败） | PASS（candidate） | 阶段 1a `exact` 分支的**行为参考** | 只作参考；需在 A0 臂与新 fixture 下重跑 |
| P3 graph | `graph-03-20261007-171741`（116 pass / 2 contract-finding / 1 INCONCLUSIVE） | 未闭环 | 阶段 1a `structural` / `relation` 分支 | contract finding（目录 scope 语义）与新 abort 语义在阶段 1a 重新测 |
| P4 lifecycle | `lifecycle-04-20261007-190100`（46 sampleIds，orphans=0） | PASS（candidate） | 阶段 1a harness 生命周期参考 | 进程 / orphan 纪律沿用；评测格式改用 ERM/PCR |
| P5 concurrency | `concurrency-05-20261008-004408`（29/29、309/309） | PASS（candidate） | 阶段 1a 并发参考 | 保留 `fixtureMismatchCount=1` 的未解释事实（`BL-23`） |
| P6 budget/fault | `p6-budget-fault-06-20261007-183546-final`（verify 104 项 0 失败） | PASS（candidate） | 阶段 1a 预算 / 故障注入参考 | 与 `04-evaluation-controller` FI-01…FI-24 对照后重建 |
| P7 decision | `decision-07-20261007-054042`（70 PASS / 1 unverified，冻结前） | 背景证据 | 阶段 3（Jev retrieval shadow） | DecisionProvider 与 SemanticProvider 分离后重评；旧 P7 不代表语义质量 |
| P8 workflow/no-gold | 未启动 | — | 阶段 1a（FQ-09）+ 阶段 2 | fixture 类别进入 `10-evaluation-matrix` |
| P9 e2e | 未启动 | — | 阶段 5 之后（下游关联） | 需要 Agent 接入与真实执行，P0 不启动 |
| P10 final | 未启动 | — | 每阶段 Review 的聚合报告 | 由 ERM/PCR + Review 取代 |
| smoke | `smoke-20261008-020605`（2/2） | candidate smoke | 阶段 1a 的连通性参考 | 不作为验收 |

## 2. 桶名映射更正（**待执行**）

`docs/migration/retrieval-worker-d25d33.zh-CN.md` 与 `docs/migration/retrieval-worker-integration-design.zh-CN.md` 中的表述有误：

| 旧文档写法 | 实际（按旧提示词定义） |
| --- | --- |
| 「P8 Workflow semantics」 | 正确（Prompt 8 = workflow / no-gold） |
| 「P9 no-gold semantic」 | **错**：Prompt 9 = e2e 关联评测 |
| 「P10 Agent correlation」 | **错**：Prompt 10 = final 汇总（不重跑任何桶） |

处理方式：

| 项 | 内容 |
| --- | --- |
| 待更正的精确位置 | `docs/migration/retrieval-worker-d25d33.zh-CN.md:45`——原文写「P8 Workflow semantics、P9 no-gold semantic、P10 Agent correlation 尚未形成权威完整 run」 |
| 正确映射 | P8 = workflow / no-gold（该行正确）；**P9 = e2e 关联**；**P10 = final 汇总** |
| 写集归属 | `implementation/07-legacy-migration` §3.1 脚注 4 声明：`docs/migration/**` 的更正属 **Retrieval 线 P0 写集**（`08` §4），Implementation 线只记录 erratum、不双写 |
| 本轮状态 | **未执行**：本轮写集限定为 `retrieval/**`，`docs/migration/**` 不在内；且需要用户明确授权才能扩展写集 |
| 授权前约束 | 引用旧文档时必须同时注明本表的正确映射；不得把旧文档的桶名当权威 |
| 登记项 | `RG-01`（§7）；不得由本线静默修改 `docs/migration/**` |
| 其他旧文档检查结果（只读） | `retrieval-worker-integration-design.zh-CN.md:103/167/168` 使用「P8/P9/P10」而未给出错误桶名，且 167/168 的叙述（P8/P9 闸门未满足、P10 最后只读汇总）与正确映射**一致**，无需更正 |

## 3. 旧候选（Retrieval Worker）在新架构中的位置

| 维度 | 旧状态 | 新状态 |
| --- | --- | --- |
| 角色 | 「检索链路」本体 | `exact` / `structural` 分支的一个**实现候选** |
| 覆盖 | exact + graph + rule decision | 只覆盖两条分支；不含 lexical / relation / semantic / external |
| `RetrievalPack` 所有权 | Worker 自己的 pack | 归 Retrieval Controller；Worker 只返回候选 |
| DecisionProvider | rule（允许）/ LLM（P7） | 与 SemanticProvider 彻底分离（`01` SEM-F2） |
| hash 语义 | UTF-8 解码文本 hash | Inspect 只信任原始字节 hash（`04` IN-4） |
| ref 语法 | `source://<path>` 小写段 | `SourcePointerV1` + 显式 `unconvertible`（`02` §7）；`unconvertible` 仅限 ABI 转换失败（AB-7） |
| cancel | 无（RPC 无 cancel） | 进程终止实现有界取消（`01` DL-3） |
| index 写入 | 写入 workspace | 阶段 1a 默认不写；后续方案只有 S1（EffectGateway 写 effect）/ S2（外置 `indexDir`）两种，选择未定 = `BL-09`（`03` §4） |
| 候选身份 | bucket runId | `evaluationRunId` + `candidateSha`（tree-hash） |

## 4. 旧缺陷 → 新项目映射

| 旧编号 | 内容 | 新归属 | 状态 |
| --- | --- | --- | --- |
| G1 | V3 ref 语法无行号 / 只允许小写 | `02` §7（AB-1…AB-6）、`04` §8 | P0 已冻结规则 |
| G5 | 无 cancel | `01` DL-1…DL-6 | P0 已冻结规则 |
| G6 | 索引写入 workspace | `03` §4（IX-1…IX-7）、`BL-09` | 待阶段 1 选方案 |
| G8 | graph 目录 scope 语义错误 | `04` §2（path / workspace 检查） | 阶段 1a 验证 |
| G10 | 解码文本 hash vs 原始字节 hash | `04` IN-4、`BL-10` | P0 已裁定（原始字节权威） |
| D22 / D23 / D24 / D25–D33 | 历史缺陷（path 校验、watcher 状态、生命周期等） | 无直接继承；作为阶段 1a 回归参考 | 不重开旧编号 |
| DEF-IMPL-1…6 | 重新基线前的运行时缺陷（Implementation 线） | `BL-03` / `BL-15` / `BL-21` | 随 `BL-03` 处置 |

## 5. 复用规则

| 资产 | 可复用 | 条件 |
| --- | --- | --- |
| 旧 harness 的**进程纪律**（PID / 父 PID / orphan=0 / 凭据扫描 / driver 冻结） | ✅ | 直接沿用，写入新 ERM / 报告格式 |
| 旧 harness 的 **fixture 生成脚本** | ⚠️ | 需重定向结果根（禁止写入 `D:\MyHarness`）并重算 hash |
| 旧 **fixture 语料** | ⚠️ | 需重新注册为 `fixtureId` + `fixtureHash`；旧 hash 不作为新证据 |
| 旧 **gold 标签** | ❌（默认） | 旧 gold 的标注者 / 独立性 / 盲审无记载（`BL-12`）；除非能补齐 `labelProvenance`，否则重新标注 |
| 旧 **results.jsonl / summary / verification** | ❌ | 格式与语义均被 ERM / PCR / 两 verdict 取代 |
| 旧 **candidate 代码**（Worker） | ⚠️ | 只能作为分支实现候选；hash 需重新冻结，且必须有唯一写入者（`BL-17`） |
| 旧 **driver 的 verify/report 逻辑** | ⚠️ | 需改造成「两个独立 verdict」（`04-evaluation-controller` §9.1） |

## 6. 不得迁移的表述

以下旧表述在新架构中**不成立**，出现在任何新文档中即为错误：

```text
「P1–P10 全部通过」                     → 其中 P1 无权威 run、P3 INCONCLUSIVE、P8/P9/P10 未启动
「检索链路已完成」                       → 尚未接入 Agent Context Pipeline
「Worker 就是检索系统」                  → Worker 只是两条分支的实现候选
「fixture 未漂移」（基于 P5）             → fixtureMismatchCount=1 未解释（BL-23）
「readiness 通过 = 可发布」              → readiness ≠ quality ≠ 接入验收
「semantic 分数可以证明无匹配」           → 明确禁止（01 SC-2、05 §13）
「Jev 是统一 DecisionProvider」          → 分离（01 §7 映射表）
「HTTP 200 即 ready」                    → 明确禁止（09 RD-3）
```

## 7. 本轮登记的行动项（未执行）

| 编号 | 内容 | 需要 | 原因 |
| --- | --- | --- | --- |
| RG-01 | 更正 `docs/migration/retrieval-worker-d25d33.zh-CN.md:45` 的 **P9 / P10 桶名映射**，并加「已被 Context Governance v1 取代」状态行（不改旧证据、gold、分母、结果） | 用户授权将写集扩展到 `docs/migration/**` | 本轮写集只允许 `retrieval/**`；写集归属已由 `implementation/07` §3.1 脚注 4 声明为 Retrieval 线 |
| RG-02 | 把旧 P2 / P4 / P5 / P6 的 run 目录登记为 `legacy-evidence-index`（只读引用） | 评测结果根写入 | 本轮不写结果根 |
| RG-03 | 为旧 Worker 候选建立唯一写入者与重新冻结流程 | `BL-17` + 用户授权 | 运行时文件所有权未定 |
| RG-04 | 把 `fixtureMismatchCount=1`（P5）追查到底 | Retrieval 线后续任务 | `BL-23` 未解释 |
| RG-05 | 旧 gold 的标注者 / 独立性补齐或重标注 | 用户 / 标注者 | `BL-12` |
| RG-06 | ~~`unconvertible` 的宿主 FI 归属~~ **已闭合**：`04` §6 已登记 **`FI-20.1`**（`FI-20` 的子用例）；无需新全局编号 | — | `R-BL-14` / `BL-08` 已闭合 |
| RG-07 | 是否新增「静默改写 pointer 以凑语法」的阳性对照条目（本线提案） | Implementation 线（`04` §7.1 拥有 KB 编号） | `R-BL-12` |
| RG-08 | ~~`IR.sourceHash` 与 `fileHashRaw` 的命名统一~~ **已闭合**：Implementation 已把二者定位为不同实体的同概念字段（`01` §4.4 `IR.fileHashRaw` / §4.5 `CU.sourceHash`） | — | `02` §8 SY-7 |

## 7.1 编号所有权（边界声明）

| 编号族 | 拥有者 | 本线权限 |
| --- | --- | --- |
| `FI-01…FI-27`（含子用例如 `FI-20.1`） | `implementation/04-evaluation-controller` §6 | 只映射；子用例形式由实现线定义（如 `FI-20.1`） |
| `KB-1…KB-7`（已知坏候选阳性对照） | `implementation/04-evaluation-controller` §7.1 | 只引用；新条目只能提案 |
| `HV-*`（harness 有效性） | `implementation/04-evaluation-controller` §7 | 只引用 |
| `BL-01…BL-23`（共享阻断） | `implementation/06-blockers` | 只映射；新增用 `R-BL-*` |
| `FQ-*` / `CX-*`（检索 fixture 类别与跨类别检查） | 本线 `10-evaluation-matrix` | 本线拥有 |
| `RF-*` / `RD-*`（readiness） | 本线 `09-readiness-fixtures` | 本线拥有 |
| reason.code `retrieval-*` | 本线 `02` §3.5（封闭枚举） | 本线拥有，但需 Review 登记 |

## 8. 不变量

| ID | 不变量 |
| --- | --- |
| LM-1 | 旧 PASS 不得写成新架构通过 |
| LM-2 | 旧证据目录只读；被取代只新增标记文件 |
| LM-3 | 旧 gold 默认不复用，除非补齐 provenance |
| LM-4 | 旧 fixture 语料必须重新注册 hash 后才能进入新分母 |
| LM-5 | 旧编号（D22…D33、G1…G11）不被新文档重开或重编号 |
| LM-6 | 桶名映射更正前，引用旧文档必须同时给正确映射 |
