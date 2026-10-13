# Evaluation Controller 设计（proposed）

- 状态：proposed。本文是设计与格式冻结草案，不实现任何 runner，不启动任何评测。
- 依据：架构 §27.2（Evaluation Controller 负责 fixture registry、evaluation runner、paired comparison、regression gate、fault injection 和报告；可设置 `pass/fail/blocked/unverified`，但那只是评测事实）、§27.3、§27.8、§24.1；契约见 `01-contract-draft.zh-CN.md`（EC / ERM / PCR 与 ISO-1…8）。
- 文中出现的所有 hash 与路径示例都是**占位**（`sha256:<pending>`）；没有任何一个是真实值，也不得被引用为证据。

## 1. 定位与不变量

Evaluation Controller **只产生 evaluation fact**。它不拥有 Run、lease、receipt、Policy、gold 的事后修改权，也不能把 pass/fail 写回产品状态。

| 不变量 | 内容 |
| --- | --- |
| EV-1 | 评测运行以 `evaluationRunId` 标识，`plane=evaluation`；永不分配 `runId` / `attemptId` / `turnId` / `operationEpoch` |
| EV-2 | 评测只写评测结果根；产品数据只通过**只读快照导出**读取 |
| EV-3 | 运行前必须有冻结的 `EvaluationRunManifest`；没有则结果 `unverified` |
| EV-4 | gold、分母、豁免、阈值在运行前冻结，运行后**不可修改**；需要修改就是新 `caseSetHash` 和新 run，旧证据保留 |
| EV-5 | harness 自身缺陷与候选缺陷分开记录；harness 无效时全部结果为 `unverified` |
| EV-6 | 报告的 `verdict ∈ {pass, fail, blocked, unverified}`，`affectsProductRun` 恒 `false` |
| EV-7 | 评测不替代 Review / Close；它的 pass 只能被 Review 按 hash 引用 |

## 2. 组件

```text
fixture registry ──► candidate snapshot ──► provider capability snapshot
        │                    │                          │
        └────────────► EvaluationRunManifest (frozen) ◄─┘
                                  │
                       evaluation runner ◄── fault injection
                                  │
                  results.jsonl ──► paired comparison ──► regression gate
                                  │                              │
                                  └────────────► report writer ◄─┘
                                                      │
                                               evidence index
```

| 组件 | 职责 | 输入 | 输出 | 关键不变量 / 失败处理 |
| --- | --- | --- | --- | --- |
| **fixture registry** | 内容寻址地登记 fixture 与 EC；计算 `fixtureHash`、`caseSetHash` | fixture 目录、EC 文件、labels | `registry.json`（只增不改） | 条目一经登记不可变；缺来源 / 缺标注者 / 缺独立性声明的条目为 `unverified`，不得进入分母；hash 不符 → `blocked` |
| **candidate snapshot** | 固定被测代码的身份 | 工作树文件清单 | `candidate-hashes.pre.json` / `.post.json`、`CandidateRefV1`、`dirtyWriteSet` | `develop` 无提交 → 使用 `tree-hash`（BL-04）；`pre` 与 `post` 不一致 → run `invalid`；不复制、不修改被测文件 |
| **provider capability snapshot** | 记录本次运行里每个 provider 的能力与可用性 | 独立 probe（阶段 0/1a 为 “fake / none”） | `ProviderCapabilitySnapshotV1` | 以 probe 结果为准，配置里出现名字不算；provider 不可用 → 该臂 `unverified`，**不是 0 分** |
| **evaluation runner** | 按 ERM 执行各臂、各用例、各 seed | 冻结的 ERM、fixture、端口注入 | `results.jsonl`（一行一个 case × arm）、`runner.log` | 只使用 evaluation 平面的 fake / 隔离端口；无 lease；崩溃后**不续跑**，只能以新 `evaluationRunId` 重来；行内记录观察到的 `FactStatusV1`，不得折叠 |
| **fault injection** | 在预定义注入点制造故障 | `04` §6 的故障目录 | 带 `faultId` 的结果行 | 每个故障声明预期状态与预期恢复；实际与预期不符 → 候选缺陷或 harness 缺陷（需归因） |
| **paired comparison** | 相同用例 + 相同 seed 的臂间比较 | `results.jsonl` | `PairedComparisonReport` 的 `metrics[]` | 配对键 `caseId+seed`；分母与排除项显式；不做加权综合分 |
| **regression gate** | 对预注册的回归门槛与零容忍项判定 | PCR、ERM 的预注册 | `gates[]`、`zeroTolerance[]` | 阈值只能来自预注册；零容忍非零 → `fail`；分母不足 → `unverified` |
| **report writer** | 写 JSON / Markdown 报告与失败清单 | 上述全部 | `report.json`、`report.md`、`failures.md`、`harness-failures.md` | 只读结果；候选结论与 harness 结论分开；不得写入凭据、正文、embedding |
| **evidence index** | 为结果根下每个文件登记 hash 与角色 | 结果根 | `evidence-index.json` | 追加式；被取代的 run 用新增文件标 `SUPERSEDED`，不删除；索引 hash 写入 PCR |

## 3. 结果根与目录布局（提案）

结果根沿用现有约定，位于仓库外：

```text
D:\pactile-evidence\context-governance\
  fixtures\                         按 fixtureHash 内容寻址的大型语料（仓库内只保存其清单）
    registry.json                   只增不改
  runs\<evaluationRunId>\
    manifest.json                   ERM（frozenAt 早于其他文件）
    manifest.sha256.txt             ERM 的 hash（运行前写入）
    candidate-hashes.pre.json
    candidate-hashes.post.json
    provider-capability.json
    drivers.sha256.json             harness / driver 文件的 hash
    results.jsonl                   一行一个 case × arm
    runner.log
    summary.json                    汇总（候选观察）
    verification.json               证据链核验（harness 观察，见 §9）
    report.json                     PairedComparisonReport
    report.md
    failures.md
    harness-failures.md
    evidence-index.json
```

规则：结果根在 `workspaceKind = snapshot` 的副本上运行；运行不得在产品 `.pactile/` 下创建文件。

## 4. fixture 与 EC 的格式（提案）

### 4.1 fixture registry 条目

```json
{
  "fixtureId": "fx-<slug>",
  "kind": "repo-snapshot | transcript | manifest | provider-script",
  "source": { "origin": "local-copy | public-snapshot", "baseRevision": "<git sha or tree-hash>", "license": "<spdx or 'internal'>" },
  "snapshotHash": "sha256:<pending>",
  "treeListHash": "sha256:<pending>",
  "fileCount": 0,
  "createdBy": "<annotator id>",
  "frozenAt": "<ISO-8601>"
}
```

`fixtureHash` = 对所有被某 caseSet 引用的 fixture 条目的 canonical 列表取 hash。

### 4.2 EvaluationCase 文件

字段见 `01` §4.11。每个 case 一个 JSON 文件，文件名为 `caseId`；`caseSetHash` = 有序 case `bodyHash` 列表的 hash。

### 4.3 标注规则

1. gold 分层：`core`（必须命中的文件 / 符号 / 行）、`optional`（有帮助但非必要）；`negative` 明确错误或无关。
2. 来源与标注者必须记录；`independentOfCandidateAuthor` 取值 `true / false / "unknown"`，**`unknown` 的用例不得用于放权类结论**。
3. 盲审：至少一次不看候选输出的标注或复核，记录在 `labelProvenance.blind`。
4. 行范围映射：fixture 修改后的行映射记录为 `lineMapping`；重命名 / 生成文件的 gold 以 base snapshot 中的 canonical path 为准。
5. no-gold 区分 *natural*（真实无答案）与 *counterfactual*（构造无答案）；wrong-repository 独立成类；二者的分母**与正样本分离**。
6. 修订追加式：`revisionHistory` 只增不改；任何修订产生新的 `caseSetHash`。

### 4.4 用例类别（EC.category，封闭枚举；细目由各线补全）

| 线 | 类别 |
| --- | --- |
| 检索 | 代码查询；中文到英文实现；英文到代码；注释到实现；跨文件关系；no-gold（natural / counterfactual）；删除 / 重命名；分支切换；stale index；wrong repository；provider failure |
| 压缩 / 记忆 | determinism；anchor / protected-content；restore；wrong-repository；stale generation；missing / denied `memory.read`；compaction race；crash / replay；no-silent-success；net-benefit |
| 跨线 | Evaluation Run 与产品 Run 隔离；egress |

> 命名层次（修复轮）：本表是**伞形枚举**（`EC.category` 的取值域）；各线另有线内 fixture / bucket 注册表（检索线 `FQ-01…FQ-22`、Compression 线 `CM-B01…CM-B21`）。三者不冲突，也不得互相替代：一个 case 的 `category` 取自本表，线内细目写在线内注册文件里，线内编号不得写进 `EC.category`（`05` §2.1 CF-26）。

## 5. EvaluationRunManifest 示例（占位）

```json
{
  "schemaId": "pactile.cg.evaluation-run-manifest",
  "schemaVersion": 1,
  "plane": "evaluation",
  "evaluationRunId": "evr-<yyyymmddhhmmss>-<slug>",
  "candidateSha": { "kind": "tree-hash", "sha256": "sha256:<pending>", "fileCount": 0, "listHash": "sha256:<pending>" },
  "dirtyWriteSet": [],
  "caseSetHash": "sha256:<pending>",
  "fixtureHash": "sha256:<pending>",
  "seed": 0,
  "arms": [
    { "armId": "A0", "config": "exact+structural", "policyVersions": ["<pending>"] },
    { "armId": "A1", "config": "A0+semantic(shadow)", "policyVersions": ["<pending>"] }
  ],
  "providerCapabilitySnapshot": { "snapshotId": "<pending>", "hash": "sha256:<pending>" },
  "isolation": { "workspaceKind": "snapshot", "resultRoot": "D:\\pactile-evidence\\context-governance\\runs\\evr-<...>", "productStoreAccess": "none" },
  "plannedDenominators": [ { "metric": "recall@5", "n": 0, "excludedCases": [] } ],
  "stopRules": [ { "id": "SR-1", "condition": "candidate pre/post hash differ", "action": "stop" } ],
  "frozenAt": "<ISO-8601 earlier than any result file>"
}
```

## 6. 故障注入目录

故障在 evaluation 平面通过**脚本化的 fake 端口**或**变异后的 fixture 副本**注入，不触碰产品系统。每项必须同时断言**预期状态**与**预期恢复**，且结果行记录实际观察到的 `FactStatusV1`。

“线”：R = Retrieval、C = Compression/Memory、X = 跨线。

| ID | 故障 | 线 | 注入方式 | 预期状态 | 预期恢复 / 行为 |
| --- | --- | --- | --- | --- | --- |
| FI-01 | wrong generation（静态：消费方拿到旧 generation 的对象） | R/C | 候选 / 索引 / manifest 引用一个**已过期但仍存在**的 generation | `generation_mismatch`（同 revision 内 generation 不匹配；`09` §3） | 候选进入 `rejected`；重建或降级到 exact + structural，披露；不进入 pack；不得当作低分候选。**freshness 过期属 FI-08，不得混用 `stale`** |
| FI-02 | wrong embedding dimension | R | fake provider 返回与 snapshot 不同的维度 | 原生层（`RC` / `PCS` / `OBS` / `ERM` / `PCR`）= `wrong_dimension`；pack 层（`RK.coverage[]` / `rejected[]`）= `invalid_response` + `reason.code = "cg-wrong-dimension"` | 整批丢弃；fallback；不当作低分候选；`embeddingDim` 校验在 decode 前；折叠规则见 `09` §3.2 |
| FI-03 | provider timeout | R/C | fake provider 超过 deadline | `timeout` | 取消；使用较低保证的结果并披露；该臂不记 0 分 |
| FI-04 | provider unavailable | R/C | 连接失败 / probe 失败 | `provider_unavailable` | fallback 到确定性规则；`coverage` 对应分支为非 ok |
| FI-05 | invalid provider response | R/C | 非 JSON / schema 不符 / confidence 越界 / 非有限浮点 | `invalid_response` | 丢弃，不部分接受；Jev 降级到 `keep_full` / `externalize` / `request_review` |
| FI-06 | manifest conflict | C | 并发写入使 CAS 失败 | `manifest_conflict` | 重新读取并重做，或阻断；不覆盖 |
| FI-07 | compaction race | C | 在 compaction 进行时，transcript 又追加 / 旧 Attempt 结果迟到 | `epoch_mismatch` 或 `revision_mismatch` | 拒绝迟到结果，仅记为 stale diagnostic；audit 判 `restored` / `expanded` |
| FI-08 | stale source revision | R/C | 候选指向的文件已被修改 | `stale` / `revision_mismatch` | Inspect 拒绝；重新 Inspect；不进入 pack |
| FI-09 | `memory.read` missing | C | pointer 指向的 artifact / manifest 不存在 | `missing` | 恢复原 Artifact 或扩大 Context；若不可恢复 → `blocked` / `waiting`；**不静默接受摘要** |
| FI-10 | `memory.read` denied | C | scope / 权限不允许 | `permission_denied` | 阻断；请求授权；不绕过 Port |
| FI-11 | wrong repository | R/C | 查询 / pointer 指向另一个 worktree 或仓库 | `revision_mismatch` 或 `permission_denied` | 拒绝；不返回另一仓库内容；计入 wrong-repository 分母 |
| FI-12 | no-gold query | R | 无答案查询 | pack 的 `abstain.basis = full_coverage_no_match`（所有 authoritative 分支 ok 且无命中） | 正确 abstain 被计数；任一分支非 ok → `pack_degraded`，**不得**记为正确 abstain |
| FI-13 | dirty write-set | X | 候选或 fixture 在运行中被改动 | candidate pre/post 不一致 → run `invalid` | 停止；结果 `unverified`；不修补后继续 |
| FI-14 | crash / replay | C/X | 在 admission、manifest durable、准入、commit、compaction、audit 各步前后杀进程并恢复 | unknown effect 保持 `unknown` | 恢复后无重复副作用；无自动 replay；结果可解释 |
| FI-15 | Evaluation / 产品 Run 交叉污染 | X | 评测期间制造 “评测失败” 或让评测读写产品路径 | — | 产品 store 字节级 hash 不变；EffectGateway 拒绝 `plane=evaluation`；`RunV1` 状态不变（EV-ISO-1…8） |
| FI-16 | 旧 Attempt 迟到消息 | C/X | 旧 `operationEpoch` 的 compaction 完成消息到达 | `epoch_mismatch` | 拒绝；stale diagnostic |
| FI-17 | artifact hash mismatch | C | 篡改 artifact 字节 | `invalid_response`（hash 不符） | 恢复 / 阻断；不读取内容进入 Context |
| FI-18 | Inspect 无权限 | R | 文件不可读或越出 scope | `permission_denied` | `rejected`；不当作 missing |
| FI-19 | torn write | C | artifact 写入一半时中断 | `missing` / `invalid_response` | 恢复扫描识别并隔离，不暴露半成品 |
| FI-20 | 删除 / 重命名 | R | 候选文件被删除或重命名 | `missing` / `stale` | Inspect 拒绝；索引增量后无残留 |
| FI-20.1（FI-20 的子用例，**不是**新全局编号） | locator 形态不可转换 | R | fixture 变体：路径含大写 / 非 ASCII / 超长 / 敏感词段，或带行号范围 / worktree id；调用 ABI ref 转换 | `unconvertible`（保留原 `SourcePointerV1`） | 候选进 `rejected`；保留原 pointer 供人工与评测查看；`unconvertible` 比率计入指标（AB-4）；**禁止**截断行号、改大小写、丢 worktree、重编码路径。继续使用 `FI-20.1` 这一 FI-20 子用例；不新增全局 FI-28 |
| FI-21 | 分支切换 | R | worktree 切换分支 | `revision_mismatch` | 候选全部重新 Inspect；旧 generation 失效 |
| FI-22 | 未授权外发 | R/X | 计划含 remote 分支但无授权引用 | 计划被拒 | 外发违规数保持 0；分支不执行 |
| FI-23 | 重复请求 | C/X | 同一 `idempotencyKey` 重放 | 幂等回放 | 不产生第二个 receipt / effect |
| FI-24 | 融合输入缺分支 | R | 启用的分支没有产出 `coverage` 条目 | — | pack 构造失败（PK-1）；不得出 `pack_ready` |
| FI-25 | 取消（cancellation） | R/C/X | 取消 / 停止事件（**均非自身 deadline 到期**）：调用方取消、上层 / 父级 deadline 触发的 abort、operation 撤销、epoch fence、预算耗尽、early stop；每个来源使用自己的线内诊断码 | `cancelled`（与 `timeout` 可区分）；来源码：`*-cancelled-by-caller` / `*-cancelled-by-deadline` / `*-cancelled-by-operation` / `*-epoch-fenced` / `*-budget-exhausted` / `*-early-stopped` | 使用已有的更低保证结果并披露；取消响应有上界；不得产出 `pack_ready`；**不得**写 `timeout`（自身 deadline 对照见 FI-03）；迟到结果的 `epoch_mismatch` 不属本用例（见 FI-16、`02` TC-6） |
| FI-26 | 旧 P5 `fixtureMismatch` 未解释情况 | X | 运行前后重算 fixture hash，构造一次“场景内合法变异”与一次“fixture 漂移” | 合法变异 → 允许继续（须在 manifest 声明变异前后 hash 对）；漂移 → `blocked` | 本次必须能区分两者，不得用退出码 0 掩盖；查清旧 P5 前不得写成“fixture 未漂移”（BL-23） |
| FI-27 | generation 漂移（同 revision，运行中竞态） | R/C | 运行中索引 / semantic / manifest generation 变更，但 source revision 未变（与 FI-01 的区别：FI-01 是消费旧对象，FI-27 是运行中漂移，必须断言结果集不混合两个 generation） | `generation_mismatch` | 不得当作低分候选；不得混合两个 generation 的结果；已产出的 pack 作废重建 |

每个故障至少一条**正向**用例（故障出现时行为正确）和一条**阴性对照**（无故障时不触发降级），避免 “任何情况下都降级” 也通过。

状态区分要求（与 `09` §3 / §3.2、检索线 `02` §3.4 `TC-1` / `TC-10` 对齐）：`timeout` = **工作单元自身** deadline 到期；`cancelled` = 调用方取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop（各自带来源码），二者不得互换；`stale` / `revision_mismatch` ≠ `generation_mismatch`；`unconvertible` 是**转换**失败，不得被判为数据失败，且 `IR` 不承载该状态（`09` §3.1 矩阵）。`wrong_dimension` 必须在 `RC` / `PCS` / `OBS` / `ERM` / `PCR` 层原样保留；只在 `RK`（及 Compression 的 `CJ`）按 `09` §3.2.2 折叠为 `invalid_response` + `cg-wrong-dimension`，不得提前折叠、不得丢失维度证据。评测实体的 epoch 仿真（FI-07 / FI-16）由 fake 端口的 fixture 内部记录承载，不得写入 EC / ERM / PCR（ISO-2）。

### 6.1 失败包（failure bundle）

每个 `fail` / `blocked` / `unverified` 结果必须能导出一个自包含的失败包，供 Review 与后续 regression case 使用：

| 内容 | 规则 |
| --- | --- |
| `evaluationRunId` / `caseId` / `armId` / `faultId` | 直接引用，不重新编号 |
| `observed` | 一等状态 + `reason.code`；不写自由文本 |
| 最小复现输入 | 只含 hash 与 `ArtifactRefV1`；**禁止**内联源码 / 正文 / transcript |
| 期望 vs 实际 | 两者都记录；不得只记实际（空真检测 HV-2） |
| 归因 | `candidate / harness / fixture / provider` 四选一，必须写依据 |
| 可否生成 regression case | 如可，给出建议的 `caseSetHash` 增量与分类 |
| 禁止内容 | 凭据、原始敏感文本、未授权源码、完整 transcript、embedding 向量 |

规则：失败包是 Artifact，不修改被评测候选；一个失败包可生成多个 regression case，但只能通过新的 `caseSetHash` 生效。

## 7. harness 有效性（阳性对照）

旧 harness 出现过：端点格式不一致使幽灵边比较静默失效（P3 H1）、窗口先于重置使断言空真（P5-H3）、拼错 fixture 目录导致假超时（P5-H6）、`Tee-Object` 懒建日志使缺失产物未被发现（P5-H7）、v65 无 pre-run manifest。因此：

| 对照 | 内容 | 期望 |
| --- | --- | --- |
| HV-1 已知坏候选 | 提供至少三个故意缺陷的候选：越权读取、生成 hash 不稳定、静默丢弃 `rejected` | harness 必须判 `fail`；若判 `pass` → harness `blocked`，所有结果 `unverified` |
| HV-2 空真检测 | 每条断言带 “被断言对象计数 > 0” 的前置检查 | 计数为 0 的断言记为 `harness_failure`，不是 pass |
| HV-3 产物存在性 | runner 的每一步产物（日志、results、summary）必须存在且非空，步骤退出码单独记录 | 缺失 → run `invalid` |
| HV-4 fixture hash | 运行前后重算 fixture hash | 不一致 → `blocked`，除非 manifest 里声明了该场景的 “变异前后 hash 对” |
| HV-5 分母一致 | summary、report、results 三处分母交叉核对 | 不一致 → `invalid` |
| HV-6 判定可复现 | 同一 ERM 在新进程中重放，`bodyHash` 与判定一致 | 不一致 → determinism 缺陷（候选或 harness，需归因） |

> 旧 P5 权威 run（`concurrency-05-20261008-004408`）的 `verification.json` 同时有 `fixtureMismatchCount=1` 与 `exitCode=0`；退出码只表示 “证据链完整”。新格式不允许这种含糊：见 §9 的两个独立 verdict。

### 7.1 known-bad candidate 注册表（阳性对照的维护）

- 注册表位于评测夹具目录，**不属于产品代码**；条目是可复现的最小缺陷实现：`KB-1` 越权读取（workspace 外路径仍返回 `ok`）；`KB-2` 非确定性 hash（同输入两次 `bodyHash` 不同）；`KB-3` 静默丢弃（`rejected` 候选被从 `coverage` 删除但仍输出 `pack_ready`）；`KB-4` 全零占位 hash（DEF-IMPL-1 的最小复现）；`KB-5` 把 `cancelled` 折叠为 `timeout`；`KB-6` 把 `generation_mismatch` 当作低分候选；`KB-7` 报告把“无匹配”当成“证明不存在”（fail-open）。
- 每次 harness 变更（新增断言、修改 runner、改变分母）后必须重跑阳性对照；KB 必须全部被判 `fail`，否则 `harnessVerdict = blocked`，所有候选结果 `unverified`。
- KB 的期望输出与 KB 本体一起冻结 hash；KB 不得被当作产品代码或 fixture 基线。
- **冻结状态（当前 P0）**：KB-1…KB-7 的最小 catalog 与坏输入已落盘于 `evidence/p0/kb-catalog.json` / `evidence/p0/fixtures/known-bad-inputs.json`，但**真实坏候选、运行结果、期望输出 hash 仍未冻结**（`sha256:<pending>`），实际运行目录仍待 Stage 1a 授权后创建。`10` §1 条件 8 保持 `partial`。KB 覆盖与已登记状态不一一对应：`unconvertible` 的静默重编码、`review_required` 的错误 `accepted`、维度折叠丢失证据目前没有 KB 条目；新增 KB 编号需用户批准（本轮不新增）。
- 旧记录的 `harnessFailures`（P5-H1…H13）只作为 KB 的设计灵感，不当作已修复事实。

## 8. 指标目录（性能矩阵扩展，对应架构 §27.9#5）

遵循 §24.1：基准使用 fake Provider 与可重复 fixture，不把公网模型延迟计入 Host 指标；区分 cold start / warm start / steady state / crash recovery；报告 p50、p95、p99 与失败样本，不只平均值；队列、Actor、Journal、Renderer 分层采样；改变 Lease / Receipt / Settlement / Recovery 语义的优化必须重跑故障矩阵；先建基线与回归告警，**再**决定哪些指标成为阻断门槛。真实 Provider 的测量单独标注，不与 fake 结果混合。

| 层 | 指标 | 定义 / 分母 |
| --- | --- | --- |
| **RetrievalPack** | Recall@1/5/20；MRR；precision；F0.5 | 仅正样本分母；按用例类别与仓库分别报告 |
| | Inspect 后有效率 | `items` 中 `inspect.status=ok` 的比例；`rejected` 按状态分布 |
| | no-gold：正确 abstain / 错误 abstain / 错误返回 | 独立分母，不混入正样本 |
| | generation fence 违规数 | 零容忍 |
| | fallback 触发率与原因分布 | 分母 = 启用 semantic 分支的用例 |
| | 候选 bytes / tokens | 每包的分布 |
| | coverage ok 率 | 每分支 `status=ok` 的比例 |
| | p50 / p95 / p99 延迟 | 每分支与端到端分别报告 |
| **Embedding** | readiness 通过项 | 逐项（端点、维度、前缀、batch、有限浮点、超时 / 取消、脱敏、授权） |
| | 返回维度正确率；timeout / 失败率（按码） | |
| | batch 延迟 p50 / p95 / p99 | |
| | 外发违规数 | 零容忍 |
| | generation 失效次数与重建耗时 | |
| **Jev** | schema 合规率；timeout / unavailable / invalid 分布 | |
| | 与 oracle 的一致率（按动作类别） | oracle 来自 gold，不得来自 Jev 自身 |
| | 低置信度降级正确率 | 低置信度时是否确实走了确定性路径 |
| | calibration | **只报告，不放权** |
| | 延迟 p50 / p95 / p99、成本 | 真实 Provider 单独标注 |
| **ContextUnit** | unitization determinism | 重复运行 `bodyHash` 一致率 |
| | protected / exact 分类的召回与精确 | **漏判 exact 锚点是关键失败**，单独计数 |
| | manifest durable 耗时 | |
| **Pi compaction** | restore 逐字节一致数 | 零容忍 |
| | anchor 保留率 | 按锚点类别 |
| | compaction 耗时；失败与回滚次数 | |
| **post-audit** | 各 check 的 pass / fail 分布 | 17 项：`source_cursor / exact_anchor / protected_content / tool_call_pairing / permission / source_hash / source_revision / generation / worktree_fence / semantic_drift / jev_preservation / pointer_reachability / manifest_current_pointer / memory_read_probe / epoch_fence / supersedes_relation / rollback_reference`（`01` §4.10 / `compression-decision-chain-v1` §7.1） |
| | audit 误接受（accepted 但 gold 锚点丢失） | 零容忍 |
| | audit 结论分布 | `verdict` 7 值：`accepted / restored / expanded / blocked / waiting / assurance_unknown / review_required`（`01` §4.10）。CAR lifecycle 唯一形式 = `running → <verdict>`；**不存在 `failed`**——audit 自身未能得出结论时计为 `assurance_unknown`（不自动重放，人工 reconcile），确定性拒绝计为 `blocked`（`compression-decision-chain-v1` §7.4.1） |
| | audit 误拒绝；audit 耗时 | |
| **net benefit** | 净 token 变化 | 节省的 token − 重读（`memory.read`）与恢复造成的增量；**仅在真实执行（阶段 ≥5）下测量**；反事实回放必须标注 “未执行” |
| | 净延迟变化 | 同上 |
| **系统** | RSS、CPU、队列深度 | 按 §24.1 分层 |

不使用加权综合分。旧评测的 40/30/25/5 加权方案不沿用（Compression 线 §5#5）。

## 9. 报告格式与 verdict 语义

### 9.1 两个独立 verdict

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `harnessVerdict` | 证据链与 harness 是否有效 | `valid / invalid / blocked` |
| `candidateVerdict` | 在 harness 有效的前提下，候选的评测结果 | `pass / fail / blocked / unverified` |

规则：`harnessVerdict ≠ valid` 时，`candidateVerdict` 一律为 `unverified`。`verification.json` 只写 `harnessVerdict` 及其检查项；`summary.json` / `report.json` 只写候选观察。不再让一个退出码同时表达两件事。

### 9.2 results.jsonl 行格式（提案）

```json
{
  "evaluationRunId": "evr-...", "caseId": "...", "armId": "A0", "seed": 0,
  "observed": { "status": "ok | stale | missing | ...", "reason": { "code": "...", "detailHash": null } },
  "outcome": "pack_ready | pack_empty_observed | pack_degraded | pack_blocked | accepted | restored | ...",
  "metrics": { "latencyMs": 0, "candidates": 0 },
  "fault": null,
  "evidenceRef": { "artifactId": "...", "contentHash": "sha256:<pending>" }
}
```

### 9.3 PairedComparisonReport 的必备段

`arms` · `pairing`（`n` 与排除项）· `metrics`（含区间与 `n`）· `zeroTolerance` · `gates` · `verdict` · `affectsProductRun:false`；另附 `limits`：未执行的臂、未验证项、harness 缺陷摘要。

### 9.4 evidence-index.json（提案）

```json
{ "evaluationRunId": "evr-...", "entries": [
  { "path": "manifest.json", "sha256": "sha256:<pending>", "bytes": 0, "role": "manifest", "producedBy": "runner", "createdAt": "<ISO-8601>" }
], "indexHash": "sha256:<pending>" }
```

规则：结果根追加式；被取代的 run 用新增的 `SUPERSEDED` 标记文件指向取代者；旧 run 不删除、不改写。

## 10. paired comparison 设计

- **配对键**：`caseId + seed`。同一用例、同一 seed 在各臂各跑一次；`n` 显式。
- **臂（权威定义 = 本节）**：本文件是评测控制器与臂编号的唯一权威；其他文档只能引用，不得重定义。
  - 检索线（`RET-`）：`RET-A0` = exact + structural；`RET-A1` = `RET-A0` + semantic（阶段 2 起为 `shadow`）；**`RET-A2` = Jev plan shadow + exact + structural（semantic 关闭）**；`RET-A3`（可选）= `RET-A1` + Jev（联合效果，非默认）。
  - 压缩线（`CMP-`）：`CMP-A0` = 无压缩；`CMP-A1` = 可逆动作（mask / externalize / structured_project）；`CMP-A2` = Pi compaction；`CMP-A3` = 组合；`CMP-A4` = shadow；`CMP-A5` = 故障子臂。
  - **唯一性规则**：旧提案 “`A2` = `A1` + Jev” **已作废**（降为 `RET-A3`）；本文件与任何引用处不得再保留两套定义或不带前缀的 `A0–A3`。`RET-*` 与 `CMP-*` 不得混用；`ERM` / `EC` 的 `armId` 必须带前缀（`04` §5 / §9.2）。
  - 依据与理由：`RET-A2` 的判定目标是“Jev 规划增益”的干净消融（与 `RET-A0` 单因子差异 = Jev）；旧定义与 `RET-A1` 混淆了两个变量。真实执行臂只在阶段 ≥5 出现。
- **统计**：配对差值 + 固定 seed 的 bootstrap 区间，区间方法与 seed 写入报告；二元指标另报精确符号检验的计数；**主指标预注册**，其余为次要指标，不据次要指标改写结论；不做 p 值挑选。
- **排除**：被排除用例逐个列出理由；排除比例过高 → `unverified`。
- **多 seed**：确定性阶段至少重复独立进程以验证 `bodyHash` 稳定（次数记入 ERM）。

## 11. regression gate

| 类别 | 规则 |
| --- | --- |
| 零容忍 | 见 `03` §1.2；任一非零 → `fail`，与基线无关 |
| 回归门槛 | 对预注册的主指标，“治疗臂相对基线的差值区间下界不低于预注册的边际”；**边际由阶段 1a 的基线方差与 Review 共同在 ERM 中预注册，本文不设数值** |
| 分母不足 | 有效 n 低于预注册最小值 → `unverified` |
| 基线更新 | 只能通过新的基线 run + Review；不得在同一 run 内更换基线 |
| 影响 | gate 结果只进入 PCR；**不触发任何产品动作**，也不自动阻断产品 Run |

## 12. 隔离测试（U-7 的具体内容）

| ID | 测试 | 通过条件 |
| --- | --- | --- |
| EV-ISO-1 | 评测前后产品 store（RunLedger / Kernel / Runtime Store / Artifact）字节级 hash | 完全相同 |
| EV-ISO-2 | 评测期间产品 lease 表 | 无新增、无续租 |
| EV-ISO-3 | 向 EffectGateway 提交 `plane=evaluation` 的 receipt | 被拒绝，且未入账 |
| EV-ISO-4 | `evaluationRunId` / `contextOperationId` 命名空间与产品 id 不相交 | 无碰撞（属性测试） |
| EV-ISO-5 | 在产品路径不存在 / 只读的环境里运行评测 | 评测成功，说明未依赖活 store |
| EV-ISO-6 | 静态：runtime 路径（Host composition、Coordinator）不 import `evaluation/**` | 依赖边界测试通过 |
| EV-ISO-7 | 删除评测结果根后运行产品路径 | 产品行为不变 |
| EV-ISO-8 | 注入 “评测失败” 的 PCR | `RunV1` 的 `completed/settled` 不变；Kernel 无新事实 |

## 13. 评测运行的生命周期

```text
drafted ──freeze──► frozen ──start──► running ──► completed
                       │                  ├──► aborted   （停止规则触发 / 候选 pre-post 不一致 → 结果 unverified）
                       └──► invalid       └──► invalid   （harness 校验失败）
```

- 只有 `frozen`（ERM hash 已写入）才能 `start`；`running` 之外产生的结果无效。
- `aborted` / `invalid` 的 run 保留，不删除；重试必须是新的 `evaluationRunId`，不续跑。
- 同一 ERM 被修改即新 run；旧 run 标 `SUPERSEDED`（新增文件）。

## 14. 开放问题

1. `evaluationRunId` 的格式（提案 `evr-<yyyymmddhhmmss>-<slug>`）与 `PACTILE_LOGICAL_ID_PATTERN` 的兼容性。
2. 只读快照导出的格式与由谁生成（Host 提供的导出能力尚未设计）。
3. 评测入口形态：独立 CLI 子命令、脚本，还是仅测试内调用（影响 EV-ISO-6 的静态规则）。
4. 阳性对照所用的“已知坏候选”由谁维护，以及如何避免被误当作产品代码；KB 本轮未冻结（§7.1），其结构与期望输出必须先冻结再进阶段 1a。
5. 真实 Provider 臂的预算与授权流程（阶段 2 起）。
6. 新增（修复轮）：是否需要另设独立 FI 编号（已裁定不新增 FI-28，继续使用 `FI-20.1` 子用例）；`review_required` 的失败包模板是否需要在 §6.1 加专用段；KB 是否补 `unconvertible` / `review_required` 条目——三项均需用户 / Review 裁定，本轮不新增编号。
