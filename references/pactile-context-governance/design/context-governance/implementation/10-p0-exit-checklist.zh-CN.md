# P0 离场条件自检表（Review 入口）

- 状态：`proposed`（供独立 Review 使用）。
- 依据：`08-p0-admission-decision.zh-CN.md` §5（P0 离场条件 1–10）。
- 读法：`satisfied` = 文档层已有可核对内容；`partial` = 文档层部分满足，仍缺指定产物；`open` = 依赖其他线、实现或用户授权。
- 本表**不声称**任何条件是“已通过”；判定权属于独立 Review，不属 Implementation Controller。
- 修复轮说明：本表在 P0 修复轮更新（实体计数、状态唯一来源、条件 4/5 的文档面闭合、KB 未冻结、闸门行）；**条件 4 只有在独立 Reviewer 重新确认后才可改为 satisfied**，本线不得自行改。
- 修复轮三说明：本轮只修共享契约侧的真实 schema 冲突（CF-43 / CF-44 / CF-45）并重测跨线状态（CF-38…CF-42）；**未把任何证据缺口改为 satisfied**。

## 0. 闸门与修复状态（勿混淆）

| 状态行 | 取值 | 含义 |
| --- | --- | --- |
| `P0_DOCUMENT_WRITE_COMPLETE` | 保持 | 三线 P0 文档写作已完成（`08` 准入范围内） |
| `P0_REVIEW_BLOCKED` | **保持（独立复审仍为 BLOCKED）** | 独立 Review 尚未解除闸门；CF-48 / CF-49（检索线）已闭合；当前开放为 CF-20 / CF-23 的完整产物与证据门槛（CF-20 已有最小 runtime bridge，但完整失败/并发/crash-replay 证据仍缺）；KB `§7.1` 与 ERM SR-7 的 `harnessVerdict=blocked` / `mark_unverified` 关系已在预注册模板中绑定，并由轮二静态复审确认；真实 fixture、运行、冻结和结果证据仍缺失；X-14 已由检索线修复并复核；本线不得自我批准 |
| `P0_EXIT_NOT_ALLOWED` | 保持 | 条件 1、3、4、5、6、7、8、10 未全部满足 |
| `STAGE_1_NOT_AUTHORIZED` | 保持 | 阶段 1a 需用户单独授权 |
| `P0_REVIEW_REPAIR_READY` | 修复轮一达到；修复轮二 / 三**仍保持** | 共享契约冲突已逐条裁定并登记（`05` §2.1 CF-01…CF-49）；**仅表示“可交给独立 Review”，不表示 P0 通过** |
| `P0_REVIEW_SUBMITTED` | **轮十已送审；轮十二至轮十四复核结论为 BLOCKED** | 交付物已就绪并提交独立复审；轮十一专项回执、轮十二完整 P0 阻断回执、轮十三与轮十四闸门复核均已落盘，但没有批准回执，此状态不解除 `P0_REVIEW_BLOCKED` |

`P0_REVIEW_REPAIR_READY` / `P0_REVIEW_SUBMITTED` 与 `P0_REVIEW_BLOCKED` 同时成立并不矛盾：前两者说的是“修复交付物已就绪且已送审”，后者说的是“闸门未开”。任何把本轮结果写成 `P0 已通过` / `P0_CLOSED` / `READY_FOR_STAGE_1` 的表述都是错的；任何把修复轮三的裁定写成「Reviewer 已确认」的表述也是错的。

**闸门纪律**：本表的 `satisfied` 只在「磁盘事实已闭合」时保留；凡存在未应用项、未对账或未冻结产物，一律 `partial` / `open`，并必须写出承担方与可重跑的验证命令。

## 1. 十项条件自检

| # | 条件（`08` §5） | 证据位置 | 现状 | 残余动作 | owner |
| --- | --- | --- | --- | --- | --- |
| 1 | 各线文档通过独立 Review | `retrieval/00`、`compression-memory-rebase-report`、本线 `00`–`10` | `open` | 轮十二已完成独立 Review，但结论为 `BLOCKED`；`cg-p1a-checklist-rebind` 当前已有 Task Kernel candidate snapshot（`8803710e-8851-474f-9e30-0372d9dff180`，fingerprint `b6f6fc6f050c49704b1d2b92b5cee17c0e6e8c20fa71b58aec00d3f95695239a`），但该 snapshot 只覆盖 checklist 文件和 `D:\MyHarness` 的工作树验证；Pactile 支持 bounded project snapshot，而待复审契约文件和当前 Host/runtime 提交位于兄弟目录 `D:\pactile`，根任务 snapshot 不覆盖这些文件；`cg-product-candidate-rebind-clean` 已生成并由独立 Reviewer 复核通过产品仓候选 snapshot `44f5fef9-1e42-4b62-af3a-617cec2a0923`（fingerprint `f8800951023e95276bf56414c30944e99524a433a6a3b6a4216741f92973d274`，clean Git worktree 绑定 `D:\MyHarness\.tmp\pactile-cg-product-candidate`，对应产品仓 `D:\pactile`）；该边界缺口已补齐，但整体各线 Review 结论仍为 `BLOCKED`，本条件继续保持 `open`，本线不得自我批准 | 用户指定的独立 Reviewer |
| 2 | 所有实体具有 schema id / version / 字段表 / hash 规则 / provenance | `09` §1（登记表 21 行）、§1.1–§1.3、§2（含 RT/CMP 行）、§4（hash 规则，含 `inspectedAt` / `issuedAt` / `updatedAt` 豁免）；`01` §3.6（T2 形状）、**`01` §4.4（IR 唯一完整字段表 + `InspectCheckV1`）**、`01` §4.3（`RK.gaps[]`） | `satisfied`（文档层，轮十二确认；不等于 P0 通过） | 共享契约侧双权威已消除：CF-39（`retrieval/02` **L360** 声“不声明”，`rg` = 0 声明体）、CF-40（compression **L107** = 四位许可位）、CF-41（compression **L308 / L309** 两平面字段 + **L318** RT-2 单一 schema）、CF-42（`retrieval/03` **L58 / L59**）——均已重测磁盘确认。`InspectResultV1` / `InspectCheckV1` 的唯一来源为 `01` §4.4，X-14 已由检索线 `04` §2 **L46** 修复并复核；整体 P0 仍受条件 1、3–8、10 阻断 | Review |
| 3 | `unknown` / `stale` / `missing` / `permission_denied` / `revision_mismatch` / `epoch_mismatch` 是一等结果（P0 扩展为 14 项） | `09` §3（14 项登记表）、§3.1（21 列统一矩阵）、§3.2（折叠注册表封闭；`cg-wrong-dimension` 两线共用；`timeout` / `cancelled` / `invalid_response` 永不折叠）、§3.3；`01` §3.3（唯一类型声明 + 折叠注册表 + L137/138 判定行）；`04` §6 L177 / L183 | `partial` | **跨线语义冲突已全部闭合**：CF-38 / CF-43 / CF-44 / CF-45 实测；**CF-46 / CF-47 已由压缩线于 16:21–16:24 应用并闭合**（`rg -n 'SP / IR / RC' compression` = 0；`rg -n '而非 deadline' compression` = 0；`compression-deadline-exceeded` = 7；FD-5 与 `09` §3 七行逐行对应）。**历史快照（状态同步轮五）**：当时曾由 **CF-48** 阻断本项；检索线后续已修复，CF-48 / CF-49 当前均已闭合。当前剩余阻断为 CF-20/CF-23 的完整产物与证据缺口（CF-20 最小 runtime bridge 已落地，但完整失败/并发/crash-replay 证据仍缺）；命名与编号裁定已完成 | Retrieval（应用）+ Review |
| 4 | exact / protected 内容有确定性识别规则和禁止处置清单 | `09` §2.4（`protection.class` 唯一枚举）、`09` §1.2.5（`AnchorKind`）、`01` §4.5（不变量）、`01` §5（8 动作 × 效果等级 × 最早阶段） | `partial`（**文档面已闭合，判定权在 Reviewer**） | 唯一引用：Compression 线 `context-unit-manifest-v1` §6.1（22 个 `AnchorKind`）/ §6.2（20 条规则）/ §6.3（误判出口）；本线不得自行改 satisfied | Compression 线 + Review |
| 5 | 决策链每一步都有失败出口 | `01` §4.8 / §4.9 / §4.10 / **§4.14（新）**；`09` §2.4、§3、§3.2 | `partial`（契约级落点已定义，机制未实现） | `review_required` 的人工 / Kernel 审批路径已在 `01` §4.14 冻结共享契约；RunLedger `approval_request` 载荷属 Host / Kernel 轨道（BL-05），实现仍需单独授权 | Implementation + Kernel / Host 轨道 |
| 6 | Receipt 映射证明 `RunLedgerV1` 是唯一 Attempt / Effect / Receipt / Settlement 权威 | `02` §0 O-2 / O-10、§3、§6 C2 / C9；`09` §1（CDR / CAR 的权威列）；`01` §4.9 / §6 | `partial`（**已有最小 Host/Pipeline 对账样本，完整证明未闭合**） | 最小 native pipeline 已产生 CDR/CAR 并在重开 Host 后核对无 missing/orphan；完整 AC-1b.1、Kernel settlement/outbox、crash/replay 与统一 Lease/Epoch 仍需阶段 1b/P2 证据。本项**不得**改写为通过 | Host 轨道 |
| 7 | fixture、gold / negative labels、来源、标注者、盲审规则与 `sha256` 已冻结 | `04` §4.1 / §4.3；`09` §4；`03` §1.6；Stage 1a bundle `evidence/p1a/freeze-manifest.json` 与 `results/known-bad-binding.json` | `partial`（**Stage 1a 离线 fixture/labels/hash 已冻结；完整 P0 gold 范围仍未闭合**） | Stage 1a 已回填并复核 `fixtureHash`、`caseSetHash`、13 个原始资产及 KB 执行绑定；实现文档中的全量 P0 pending 值、旧 gold 的标注者独立性（BL-12）和真实产品数据仍保持未完成，不能把离线 bundle 升级为全量 P0 证据 | 各线 + 标注者 |
| 8 | EvaluationRunManifest、paired report、fault injection 与阳性对照已冻结 | `04` §5 / §6（FI-01…FI-27 + FI-20.1）、§7（HV-1…HV-6）、§7.1（KB-1…KB-7）、§9、**§10（臂唯一权威：`RET-A0…A3` / `CMP-A0…A5`）**、§11；Stage 1a `evidence/p1a/{erm,pcr,freeze-manifest}.json` | `partial`（**Stage 1a ERM/PCR/7 个 KB 对照已冻结；完整 P0/Stage 1b 臂仍未冻结**） | Stage 1a 已有 33/33 negative、7/7 known-bad、paired parity 和独立复审绑定；完整 FI 矩阵、真实 fault injection、runtime/provider arms 及 `unconvertible` / `review_required` 的全量覆盖仍开放；`unconvertible` 继续使用 `FI-20.1` 子用例，不新增 FI-28 | Implementation + Retrieval |
| 9 | P0 全程没有运行时代码修改、真实 provider、真实 compaction 或长跑 | `05` §1（含 §1.4 修复轮写集）、§7；本线冻结候选的 16 文件 tree hash 在本轮前后一致（最终值随回执报告） | `satisfied`（**自 `08` 起**）；重新基线**之前**存在运行时改动，已按 `08` §2.2 冻结隔离 | 该冻结状态需在阶段 1 前建立候选快照与唯一写入者（BL-03 / BL-17） | 用户裁定 + Implementation |
| 10 | 阶段 1 的启动仍需单独授权 | `08` §1、`03` §1.6、`02` §7 | `open`（设计如此） | 用户授权前不得启动阶段 1a | 用户 |

## 2. P0 交付物清单与完整性

| 文件 | 作用 | sha256[0:16] |
| --- | --- | --- |
| `00-rebase-report.zh-CN.md` | 重新基线报告 | 见 `07` §6 |
| `01-contract-draft.zh-CN.md` | 身份平面 / 状态 / 权威挂接 | 见 `07` §6 |
| `02-ownership-dependency.zh-CN.md` | ownership / dependency / 证明义务 | 见 `07` §6 |
| `03-stage-plan.zh-CN.md` | 阶段 0–7 与 11 项必交字段 | 见 `07` §6 |
| `04-evaluation-controller.zh-CN.md` | 评测控制器与故障注入 | 见 `07` §6 |
| `05-writeset-rollback.zh-CN.md` | 写集 / 冲突地图 / 回滚 | 见 `07` §6 |
| `06-blockers.zh-CN.md` | 阻断与未验证项 | 见 `07` §6 |
| `07-legacy-migration.zh-CN.md` | 旧任务迁移与 erratum | 见 `07` §6 |
| `08-p0-admission-decision.zh-CN.md` | P0 入场裁定 | 见 `07` §6 |
| `09-contract-entities-v1.zh-CN.md` | 21 登记项（T1 12 + T2 9）× 18 必述项、14 状态、折叠规则、hash 规则、T3 / T4 例外登记 | 见 `07` §6 |
| `10-p0-exit-checklist.zh-CN.md` | 本文件：离场自检 | 见 `07` §6（07 自身哈希不写入 07，随回执报告） |

完整性检查：

- 实体登记共 **21 行**（T1 12 + T2 9）全部在 `09` §1 登记，且每行在 §2.1–§2.4 四个矩阵中都有行；`09` §3.1 是 **21 列**统一状态矩阵（含 `PS` / `FR` / `RT` / `CMP`）；T3 内联结构与 T4 线内 `schemaId` 分别在 `09` §1.2.5 / §1.3 登记。任务书最初列出的 17 项 = T1 12 + 当时的 T2 5 项，**不再是当前计数**（`05` §2.1 CF-01）。
- `InspectResultV1` / `InspectCheckV1` 的字段表与 `id` 枚举唯一位置 = `01` §4.4（检索线 `02` §5.2 已改为只引用，15:51 实测）；`RK.gaps[]` 唯一位置 = `01` §4.3。检索线只保留「13 项检查 ↔ 枚举」的对应关系与线内规则。
- 14 个一等状态全部在 `09` §3 登记，并有状态→实体适用性矩阵与折叠规则（§3.2）；类型声明唯一来源为 `01` §3.3（15 成员，含 `ok`）；decoder 负例清单现为 `01` §7（18 条）+ `09` §6（#19–#33）。
- 任务书列出的 11 项阶段必交字段全部在 `03` §1.6 定位到具体产物。
- 任务书列出的故障场景全部在 `04` §6 有对应条目（含取消 FI-25 与旧 P5 fixtureMismatch FI-26）。
- 旧任务迁移与 P8/P9/P10 erratum 在 `07` §2.0、§2.4、§3.1。

## 3. 明确未证明的事（不得写成通过）

### 3.0 证据缺口清单（2026-10-09 实现前快照；本节不回填、不补写）

> 本节保留 2026-10-09 Stage 1a evidence freeze 与 Host P1 seam 落盘前的历史快照。后续当前状态以 §3.1（Stage 1a evidence freeze）和 §3.3（Host P1 thin seam）为准；本节的“未实现 / 未冻结 / 未产生”不得反向覆盖后续已落盘证据，也不构成 P0 或 Stage 1b 通过。

| 产物 | 要求来源 | 实际状态（2026-10-09 15:56） | 对应条件 |
| --- | --- | --- | --- |
| `RunLedgerV1` 本体与实现 | 架构 §23.3.1、§26.3；Host 轨道 P0/P1 | **未实现**；候选代码仍以 `RuntimeStore` 为权威（DEF-IMPL-2、BL-05） | 条件 6 |
| CDR / CAR ↔ `operationId` 对账证明 | `02` §6 C2 / C9；AC-1b.1 | **已有最小 native pipeline 样本；完整 AC-1b.1 仍需阶段 1b 运行时证据** | 条件 6 |
| fixture 清单与 `fixtureHash` | `04` §4.1；`evidence/p0/fixtures/negative-catalog.json` + `negative-fixture-inputs.json` | **33 个最小负例输入与 catalog 已创建，但未冻结；`fixtureHash` 仍 pending** | 条件 7 |
| gold / negative labels | `04` §4.3；`retrieval/10` §7；压缩矩阵 §5；`evidence/p0/labels/negative-labels.json`；`evidence/p0/negative-label-blind-review-round-1.json`；`evidence/p0/negative-label-blind-review-round-2.json`；`evidence/p0/negative-label-comparison-round-2.json` | **负例 labels 文件已创建；轮一静态对齐与轮二第二方盲标注均覆盖 33 条，轮二独立判定均为 `negative`，且与现有 labels 33/33 条一致；冻结与候选作者独立性声明仍未完成**；旧 gold 的标注者独立性 = `unknown`（BL-12） | 条件 7 |
| 标注者 / 盲审 / `labelProvenance` | `01` §4.11 `labelProvenance`；labels provenance；`evidence/p0/negative-label-blind-review-round-1.json` + `evidence/p0/negative-label-blind-review-round-2.json` + `evidence/p0/negative-label-comparison-round-2.json` | **准备者 provenance、两轮静态回执和 33/33 条机械比对已存在；独立于候选作者的声明、冻结和 observed decoder 结果仍未完成** | 条件 7 |
| KB 本体与期望输出（KB-1…KB-7） | `04` §7.1；`evidence/p0/kb-catalog.json` + `fixtures/known-bad-inputs.json` + `evidence/p0/kb-erm-static-review-round-1.json` + `evidence/p0/kb-erm-static-review-round-2.json` | **KB catalog 与 7 个最小坏输入已登记，inputRef 已逐条对齐；静态复核已确认登记一致性，但实际坏候选、运行结果和 expected-output hash 尚未产生** | 条件 8 |
| `caseSetHash` / `caseSet` 实体 | `04` §4.2；`01` §4.11；`evidence/p0/p0-hash-preflight-round-1.json` + `evidence/p0/p0-hash-preflight-review-round-1.json` | **33 个 case 的 bodyHash 与有序 caseSetHash 已按 Pactile canonicalizer 预计算并由独立复核逐项重算一致，但两份回执均明确为 `preflight-not-frozen`，尚未成为冻结证据** | 条件 7 / 8 |
| ERM / PCR 实例（含 `armId`） | `04` §5 / §9.3；`evidence/p0/erm-pcr-preregistration.json` + `evidence/p0/kb-erm-static-review-round-1.json` + `evidence/p0/kb-erm-static-review-round-2.json` | **最小预注册模板已创建；静态复核确认 ERM freeze prerequisites 6/6 pending、PCR 未创建；无实际 run 实例** | 条件 8 |
| 任何 `evaluationRunId` / 评测运行 | `04` §13 | **未产生**；无真实 provider / 长跑 | 条件 8 |
| 本表 / 各线文档自哈希 | `07` §6 | **已计算**（实现线），但**不代表架构通过** | — |

结论：**条件 6 / 7 / 8 只能保持 `partial` 或 `open`**，与本轮 schema 修复结果无关。

1. **fixture/KB/ERM 的最小准备资产已经落盘，但没有任何 fixture、gold label 或 sha256 被真实冻结**：33 个负例输入可供 harness 使用；第二方盲标注与现有 labels 的 33/33 条机械比对已完成，33 个 case 的 bodyHash/caseSetHash 也已有冻结前预计算，但独立性声明、正式冻结、fixtureHash 和运行所需 hash 仍是 `pending`。
2. **没有任何评测运行**：本文件不产生 `evaluationRunId`、不产生 `report.json`、不产生通过结论。
3. **专项与完整阻断回执已落盘，但 P0 仍未批准**：聚焦证据资产的独立复核回执已写入 `evidence/p0/review-round-11-evidence-assets.json`，完整 P0 入口阻断回执已写入 `evidence/p0/review-round-12-full-p0-entry.json`，第二方盲标注回执已写入 `evidence/p0/negative-label-blind-review-round-2.json`，33/33 条 labels 机械比对已写入 `evidence/p0/negative-label-comparison-round-2.json`，Pactile canonicalizer 的冻结前 hash 预计算已写入 `evidence/p0/p0-hash-preflight-round-1.json`，并由独立复核回执 `evidence/p0/p0-hash-preflight-review-round-1.json` 重算确认 33/33 bodyHash 与 caseSetHash 一致（两份回执仍明确为 `preflight-not-frozen`），KB/ERM/PCR 针对性复审已写入 `evidence/p0/kb-erm-static-review-round-2.json`，轮十三与轮十四闸门复核已分别写入 `evidence/p0/p0-gate-status-review-round-13.json` 与 `evidence/p0/p0-gate-status-review-round-14.json`；这些回执结论均为 `BLOCKED`，没有批准结论，条件 1、4、5 不得据此视为已满足。
4. **没有真实 provider、真实 Pi compaction、真实进程重启或长跑证据**（`06` §4 UV-01…UV-15）。
5. **候选身份仍是 tree-hash 锚定的工作树**，不是安全审计过的发布物（BL-04 裁定 3）。
6. **P0 之前的运行时改动仍在工作树中**（冻结、隔离、未回滚），其存在本身就是未评审状态（BL-03）。
7. **旧 P5 `fixtureMismatchCount=1` 仍未解释**（BL-23）。
8. **`check-pactile-brand-surface` 仍失败**（BL-18：inventory snapshot drift `1520e666…`→`b369cde5…`、canonical contract digest `10a8e04e…`→`5ad5ac2c…`、source map 缺失 62 个）；本线未修改映射表或摘要。
9. **跨线状态（状态同步轮五只读实测，2026-10-09 16:25–16:35；X-14 修复后复读）**：`05` §2.1 登记 **49 条**冲突，**已闭合 47 条、仍开放 2 条（CF-20、CF-23）**；当前无额外写集外开放项。
   **⚠ 本轮关键事实：压缩线在 16:21–16:24 写入**（四个文件），因此本表轮四（16:10）关于 CF-46 / CF-47 “开放”的判定**已被覆盖**；下列以 16:25 之后重测为准：
   - **CF-46 → 已闭合**：`context-unit-manifest-v1` **L506 / L517** 均已写“不含 `IR`”；`rg -n 'SP / IR / RC' compression` = **0**。
   - **CF-47 → 已闭合**：同文 **L495** 新增 `timeout` 行（`compression-deadline-exceeded`）、**L496** 改写 `cancelled` 行为六类触发、**L531–542** 新增 FD-5 唯一判定表并显式作废旧表述；`rg -n '而非 deadline' compression` = **0**。
   - **历史快照：当时未闭合** CF-48 / CF-49（检索线旧状态；后续已修复并闭合）。**当前仍开放**：CF-20/CF-23 的实现与证据门槛（真实 RunLedger、fixture/gold/labels/KB/ERM/PCR/hash）；名称/schemaId 与 FI-20.1 编号裁定已完成。
   - **写集外陈旧项 X-14**：检索线 `04` §2 **L46** 已修复为指向 `01` §4.4，旧 Owner 搜索为 0；当前不再计为开放项。
   - **回归确认**：CF-38 / CF-39 / CF-40 / CF-41 / CF-42 在压缩线 16:21–16:24 写入后**仍全部闭合**。
   本行**不**把任何 fixture / gold / KB hash / RunLedger 缺口写成已完成。
10. **`09` 与 `01` 的特征裁定未获批准性确认**：轮十二已对入口和证据状态做独立只读复核，但未形成 P0 批准；`PS.actions` 四位、RT 平面互斥、IR 唯一字段表与 `InspectCheckV1` 收编、`RK.gaps[]`、折叠注册表封闭、CAR `failed → assurance_unknown`、`RET-A2` 唯一裁定、以及本轮 CF-43 / CF-44 / CF-45 的裁定仍不得写成已批准事实。
11. **独立复审状态**：本表 §0 已标 `P0_REVIEW_SUBMITTED`（已送审）；磁盘上已有 focused evidence-asset receipt、完整 P0 阻断回执、KB/ERM/PCR 针对性复审、两轮负例盲标注/比对和轮十三、轮十四闸门复核，但没有批准结论；因此 `P0_REVIEW_BLOCKED` 与 `P0_EXIT_NOT_ALLOWED` 保持。
12. **本文件的自我更正记录（状态同步轮四 / 轮五）**：
   - 轮四曾把 **CF-23 误列入“本轮新闭合”**：压缩线 / 检索线就位的是 `FI-20.1` **子用例**（`04` §6 L172、compression 矩阵 L225），而 CF-23 已裁定继续使用 `FI-20.1` 子用例，不新增全局 FI-28；
   - 轮四 `05` 的 `活冲突残留` 标题曾写“共享契约层面无未闭合 schema 冲突”，与当时的 CF-46 / CF-47 矛盾 → 已改为按实际情况分列；
   - **轮五重大更正**：**压缩线在 16:21–16:24 写入**（本线轮四读取时为 16:10，早于该次落盘）。因此轮四关于 CF-46 / CF-47 “开放”的判定**已被磁盘事实覆盖**；本表及 `05` 已改为“已闭合”，并附重测命令。
   - **教训（写入流程）**：跨线状态判定**必须**在回执前重读一次 mtime 与关键行；对方线可能在同一时段并发写入。
   - 机械检查命令**不得**在待检目录内包含本表或 `05` 登记表自身的引用文字（否则会把“待验文本”自身计为命中）；因此 §4 第 6 条的命令均限定到具体契约文件，或显式限定到 `compression` / `retrieval` 目录。

13. **`compression-wrong-dimension` 的机械检查说明**：`rg -n 'compression-wrong-dimension' .../compression` 的结果为 **2 处，且均为“禁用示例”**（`context-unit-manifest-v1` §11 负例 18b 将其列为禁止值；`compression-memory-evaluation-matrix-v1` CM-B23 将其列为 negative）——**不是活用法**。真正需要机械验证的是“该字符串不得出现在任何 `reason.code` 赋值位置”；本表不使用“计数 = 0”这类会被禁用示例反转的判据。
14. **KB verdict 语义已在文档层绑定并由静态复审确认**：`04` §7.1 要求任一已知坏候选漏捕获时 `harnessVerdict=blocked` 且候选结果全部 `unverified`；ERM SR-7 保留 schema 允许的 `action=mark_unverified`，并在 condition 中显式绑定 `harnessVerdict=blocked`。真实执行前仍不能把静态 `known-bad-inputs.json` 的 expected 文本当作已观察 verdict。

### 3.1 当前 Stage 1a evidence freeze（2026-10-10）

上面的 §3.0 是 2026-10-09 冻结前的缺口快照；它保留历史事实，不回写为“从未产生”。随后完成的 Stage 1a 离线运行已经形成当前可核对的 evaluation evidence bundle：

- canonical manifest：`evidence/p1a/freeze-manifest.json`；evaluation receipt：`evidence/p1a/evaluation-receipt.json`；对应 `evaluationRunId=evr-20261010-p1a-offline`、`policyVersion=cg-v1-p1a-offline`、`seed=p1a-seed-1`。
- 一次性冻结值：`fixtureHash=sha256:27e5269ced81a2f76923e8e11ed46ab7a008a30eec7b690235841bd907fb10f1`；`caseSetHash=sha256:87f870905207c8926290daab94205dcf316eec25c159e7f5876abdadc355e537`。manifest 另列 14 个 bundle 文件的字节数与 SHA256，manifest 自身明确排除自引用 hash；`results/known-bad-binding.json` 将 7 个 KB 输入逐项绑定到同一 evaluationRunId、预期/观察结果和每项的 canonical body/output hash。
- observed evaluation：33/33 negative cases rejected，7/7 known-bad candidates failed，mismatches=0，paired baseline parity=true，excluded=[]；ERM/PCR 已落盘并绑定同一 evaluationRunId；KB binding 同样为 7/7 failed、0 mismatches。
- isolation boundary：`plane=evaluation`、`runtimeReceipt=false`、`providerCalls=0`、`productStoreWrites=0`、`productStoreAccess=none`。这不是 RunLedger runtime receipt，也不是 Stage 1b、真实 provider 或生产 readiness 证据。
- P0 与 Stage 1a 五组输入资产（negative fixture inputs、negative catalog、negative labels、known-bad inputs、KB catalog）已做 JSON 语义对齐核验，均为 `semanticEqual=true`；脱敏本地回执为 `D:\MyHarness\.tmp\pactile-cg-asset-alignment-20261010\asset-alignment-receipt.json`。该核验只证明 Stage 1a observed 结果对应当前 P0 资产，不改变 P0 的独立性声明、freezeStatus 或闸门。
- 真实 provider 的脱敏 shadow 结果单独登记在 `evidence/provider-shadow/provider-readiness-receipt.json`：EmbeddingGemma 2 返回 768 维向量并达到 `ready-for-shadow`；JEV 新端点返回 200，原始 `typesafe/jev` 经精确归一化后通过现有 parser。随后使用同一端点做的 transport-level synthetic smoke 也返回 `answered` / `typesafe-jev`，对应根任务回执 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\jev-commandcode-transport-live-smoke.json`；EmbeddingGemma 2 的 live smoke 回执为 `embeddinggemma2-live-smoke.json`。这些回执不属于本 offline evaluation bundle，不改变 `providerCalls=0` 的隔离结论，也不宣称质量或生产 readiness。

因此，Stage 1a 的 fixture/gold/KB/ERM/PCR/hash **已有独立复审通过的冻结 evaluation bundle**；P0 条件 6 已有最小 RunLedger/operationId runtime 对账样本，但完整 AC-1b.1 与 Host P1/P2 证据仍未闭合，状态保持 `partial`。P0 闸门四行保持原样，`P0_EXIT_NOT_ALLOWED` 与 `STAGE_1_NOT_AUTHORIZED` 不变。后续若要把这些结果升级为 P0 exit 或启动 Stage 1b，仍需完整 Host/RunLedger 证据与新的针对性 Review。

## 4. 建议的 Review 顺序

1. 先核 `09`（实体 × 必述项）与 `01` 的一致性：任何字段矛盾必须先解决。
2. 再核 `02` §0 的 10 条 ownership 断言与 §6 的证明义务是否能被阶段 1 测试证伪。
3. 再核 `03` §1.6 的 11 项字段是否每格都有内容，且 AC 编号与各阶段小节一致。
4. 再核 `04` 的故障目录是否覆盖任务书列出的全部场景，以及两个独立 verdict 是否消除了旧 P5 的含糊。
5. 最后核 `05`/`06`/`07` 的写集、阻断、迁移是否与其他两线的写集冲突（`05` §2），并逐条核对 `05` §2.1 的 CF-01…CF-49：裁定是否可接受、同步清单是否完整、验证证据是否可复现；再确认本 `10` 的 §0 闸门行未被误读为“P0 通过”。
6. **机械检查（建议 Reviewer 直接重跑；下列为 2026-10-09 16:10 实测值）**：

   约定：下列命令均在 `docs/architecture/context-governance/` 下执行；**不得**把待验目录扩到 `implementation/` 全目录（否则 `05` 登记表 / 本表自身的引用文字会被计为命中，产生假阳性）。

   | 检查 | 命令 | 期望 | 实测（16:10） |
   | --- | --- | --- | --- |
   | 状态单一声明（CF-38） | `rg -c '^type FactStatusV1' implementation/01-contract-draft.zh-CN.md retrieval` | 仅 `implementation/01` = 1 | ✅ 1 / 0 |
   | IR 字段表唯一（CF-39） | `rg -n 'interface Inspect(Result\|Check)V1' retrieval` | 0 个声明体 | ✅ 0（`02:360` 为“不声明”说明） |
   | PS 许可位四位（CF-40） | `rg -n '^\s+.*promotionRecommendation' compression` | 0 字段声明 | ✅ 0（`107` = 四键） |
   | RT 平面字段（CF-41） | `rg -n 'operationEpoch: number \| null\|evaluationRunId: string \| null' compression/context-unit-manifest-v1.zh-CN.md` | ≥2 行且同属 `RestoreTokenV1` | ✅ L308 / L309；`318` RT-2 |
   | generation 链字段名（CF-42） | `rg -n 'supersedes: string' retrieval` | 0 | ✅ 0（`03:58/59`） |
   | RC 维度原生层（CF-43） | `rg -n '否则整个候选是' implementation/01-contract-draft.zh-CN.md` | 0；`01` 含“原生状态是 `wrong_dimension`” | ✅ 0 / 含（L401） |
   | IR × unconvertible（CF-44） | `rg -n 'SP、IR、RC\|SP / IR / RC' implementation/01-contract-draft.zh-CN.md implementation/09-contract-entities-v1.zh-CN.md` | 0 | ✅ 0（`01:118`、`09:401/443/460`） |
   | cancelled 混类（CF-45） | `rg -n '被调用方或上层取消\|由 deadline 触发；' implementation/01-contract-draft.zh-CN.md implementation/09-contract-entities-v1.zh-CN.md` | 0 | ✅ 0（`01:120/137/138`、`09:327/332/345`） |
   | 旧名仅作禁令 | `rg -n 'scopeKey\|PointerRefV1\|promotionRecommendation' compression` | 均为“不得使用 / 已废止”语境，无活字段 | ✅ 已逐条看过 |
   | 消费方 vs 共享权威（CF-46） | `rg -n 'SP / IR / RC' compression` | 0 | ✅ **0（已闭合，16:21–16:24 压缩线应用）** |
   | 同文自相矛盾（CF-46 反证） | `rg -n '不含 .IR.' compression` | ≥2（`L506` / `L517`） | ✅ 已消除 |
   | 取消语义（CF-47） | `rg -n '而非 deadline' compression` | 0 | ✅ **0（已闭合）** |
   | timeout 来源码已登记（CF-47） | `rg -n 'compression-deadline-exceeded' compression` | ≥1 | ✅ **10** |
   | 六个 `cancelled` 来源码齐全（CF-47） | 逐个 `rg -n 'compression-(cancelled-by-caller\|cancelled-by-deadline\|cancelled-by-operation\|epoch-fenced\|budget-exhausted\|early-stopped)' compression` | 每个 ≥1 | ✅ 均 ≥2 |
   | 取消码合法性自洽（CF-48，当前已闭合；历史检查） | `rg -n '已移除的 reason.code.*cancelled-by-deadline' retrieval/02-retrieval-schema.zh-CN.md` | 历史期望 0 | 历史实测 1（L513）；**后续已修复，当前 0** |
   | `09` 引用可寻址（CF-49，当前已闭合；历史检查） | `rg -n '§3.2.2 line 395' retrieval` | 历史期望 0 | 历史实测 3；**后续已修复，当前 0** |
   | 旧语义未重现（三线全局） | `rg -n 'IR.*unconvertible\|unconvertible.*IR' implementation compression retrieval` | 命中项**只能是**登记/禁令/「不承载」语境 | ✅ 已逐条人工确认（无活契约声明） |
   | 证据未回填（implementation 子目录） | `rg -o 'sha256:<pending>' implementation` | ≥1（不得为 0：0 意味着被虚构填充） | ✅ 18 处（仅 implementation 范围，当前重算） |
   | 证据缺口可见（条件 6/7/8） | `rg -n 'RunLedger\|operationId\|fixture\|gold\|KB\|ERM\|PCR' implementation/10-p0-exit-checklist.zh-CN.md` | 命中均处于“未实现 / 未冻结 / 未产生”语境 | ✅ 均为未完成语境 |

### 0.1 历史跨线读取（状态同步轮六）

历史读取曾确认检索线 02-retrieval-schema.zh-CN.md mtime 为 **2026-10-09 17:22:49**；当时记录 CF-48 与 CF-49 未闭合。该段仅作历史快照；P0_REVIEW_BLOCKED、P0_EXIT_NOT_ALLOWED、STAGE_1_NOT_AUTHORIZED 以及 P0_DOCUMENT_WRITE_COMPLETE 四行保持原样；CF-20、CF-23、X-14 和 RunLedger/fixture/gold/KB/ERM/PCR/hash 证据缺口继续开放。

### 0.2 当前磁盘事实（后续复读）

复读确认 CF-48 / CF-49 已闭合：检索线 N-25 不再列活跃取消码，错误 `09 §3.2.2 line 395` 引用已清零。条件 3 的剩余阻断转为 CF-20 / CF-23 的完整实现与证据缺口（CF-20 最小 runtime bridge 已落地）；RunLedger、fixture、gold、KB、ERM、PCR、hash 证据缺口仍开放。

### 3.2 Host P1/P2 实现前复核快照（2026-10-10）

该段保留实现前的只读复核快照，针对条件 6 的实现边界，不改变任何闸门：

- `packages/cli/src/pactile/runtime/` 当前有 RuntimeStore、SQLite adapter 与 lease/epoch 代码，但源码与测试中没有 `RunLedgerV1`、`EffectGateway` 或 `WorkspaceHost` 的实现声明；`RuntimeStore` 仍是现有 runtime 的写入面。
- 已关闭的 runtime-host bootstrap 任务只证明 RuntimeStore host composition 与 SQLite fail-closed 行为，不产生 RunLedger 或 CDR/CAR `operationId` 对账证据。
- 现有 SQLite port 任务最近一次在 provider 运行前失败；Product Kernel SQLite 任务最近一次在 repository-binding preflight 停止。两者都没有形成可绑定的 RunLedger/Kernel 事务候选。

因此，P0 条件 6 仍为 `partial`；已有最小 runtime CDR/CAR 样本在 ledger 中绑定同一 `operationId` 且重开后无孤儿，但 `AC-1b.1` 的全量运行时要求仍未证明。`P0_REVIEW_BLOCKED`、`P0_EXIT_NOT_ALLOWED`、`STAGE_1_NOT_AUTHORIZED` 与四条闸门行保持原样。

### 3.3 当前 Host P1 thin seam（2026-10-10）

随后在 `chore/cg-host-p1-run-ledger` / `8c1e660` 落盘一个最小 Host P1 seam：

- `run-ledger.ts` 定义 `RunLedgerV1` / `EffectLedgerEntryV1`；`runtime-host.ts` 暴露同一 SQLite connection 上的 `ledger`。
- `runtime-host.ts` 现在同时暴露既有 Product Kernel SQLite store（`productKernel`）及其诊断；两者保持独立数据库与事实空间，Host 只负责生命周期组合，不伪造跨库原子提交。
- `commitRunLedger` 复用单连接 `BEGIN IMMEDIATE` 事务，支持 idempotent replay（`applied=false`）和单向 `intent → success/failure/unknown` receipt 推进；`readRunLedger` 可报告 `missingOperationIds` / `orphanOperationIds`。
- `run-ledger-effect-receipts.ts` 提供一个只负责 durable intent/receipt 的薄 EffectGateway seam；它不执行工具、不重放 unknown effect，未知结果仍保持 `effectsKnown=false`。
- `context-governance-receipts.ts` 提供纯内存 CDR/CAR binding validator：校验 runtime/evaluation 隔离、CDR `effect.operationId` 对账和 CAR 17 项 checks；它不持久化 payload，也不自称 producer。
- `context-governance-producer.ts` 提供最小 producer seam：先把 canonical receipt bytes 写入 immutable ArtifactStore，再把 `payloadType` / `payloadHash` / `payloadArtifactRef` 绑定到同一 terminal effect；重复调用返回 `applied=false`，effect identity 变化或部分 payload 绑定会拒绝。它不执行压缩、不结算 Kernel run。
- typecheck、ESLint 与 28 个 runtime focused tests 通过；RunLedger focused tests 5/5、RunLedger effect receipt tests 2/2、CDR/CAR binding tests 3/3、CDR/CAR producer tests 2/2，包含 `missingOperationIds` 非空、unknown 不自动重放和 Artifact/RunLedger replay 分支。
- 新增 `context-governance-pipeline-producer.ts`，复用既有 `PactileContextPipeline.onResult` 扩展点：成功 compaction 会自动生成并持久化 `admitted` CDR，以及明确为 `assurance_unknown` 的 CAR（17 项检查尚未由真实 audit 执行，绝不伪造 `accepted`）。`context-governance-pipeline.integration.test.ts` 显式接入这一 Host adapter，运行一次 native compaction，重复调用同一 producer 后 RunLedger revision 不变，关闭并重开 Host 后仍得到 `missingOperationIds=[]`、`orphanOperationIds=[]` 与两种 payload type；该测试 1/1 通过。当前尚未把 adapter 隐式注入所有 pipeline 构造器，也没有把 unknown CAR 当作通过证据。
- 新增一条最小 crash/replay 证据：`context-governance-producer.test.ts` 在 immutable artifact 已提交、RunLedger payload 绑定前注入一次 adapter 提交失败；重试复用同一 artifact 并完成单次 ledger binding，重试后当前 Host 的 `missingOperationIds=[]`、`orphanOperationIds=[]`。这是 adapter 级故障注入，不冒充真实进程 crash；该证据只覆盖 receipt producer 的一个恢复切面，不能替代 AC-1b.2 的全量 admission/manifest/policy/compaction/audit 故障序列。
- 本 seam 仍不是完整 Host P1/P2：Product Kernel store 已由 Host 组合并可独立执行 settlement/recover；成功 settlement 现在会在同一 Product Kernel 事务内写入一个 durable `pending` settlement outbox，已有薄 Kernel→Runtime projector 可按 outboxId 幂等投影并显式阻断 missing/orphan/mismatch；同库 acknowledgement 现已作为独立的 lease/revision-fenced 操作落地，重复 acknowledgement 不增加 revision。跨库 inbox/reconciler 与 AC-1b.2 所需的全量 crash/replay evidence 仍未完成。Lease proof 可作为现有 RunLedger 写入的 fence，但统一 Lease/Epoch authority 仍未完成。因此 P0 条件 6 仍为 `partial`，`AC-1b.1` 仍未证明，四条闸门保持原样。
- `71a7d2a` 的 settlement outbox 已由独立回执 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-outbox-review-round-1.json` 复核通过：v1 数据升级保留既有 fact/revision，同库 `BEGIN IMMEDIATE` 事务覆盖 settlement、pending outbox、revision 与 command receipt，重放/拒绝/重开/恢复路径通过；该复核明确 `condition 6=partial`，不解除四条闸门。
- 新增 `settlement-outbox-projector.ts` 作为薄 Kernel→Runtime 投影接缝：以 deterministic `outboxId` 作为 RuntimeStore 幂等键，已存在的同 receipt 重试返回 `already_projected`，RunLedger 缺失、ledger 自身 missing/orphan 或 receipt 不一致分别返回一等状态；它不跨库伪造原子提交，也不确认/删除 Kernel outbox。Product Kernel acknowledgement 已单独提供 lease/revision fence、receipt 匹配和重复调用幂等语义；跨库 reconciler 与完整 AC-1b.2 crash 序列仍待后续阶段。定向 projector 测试 2/2 通过，独立复核回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-outbox-projector-review-round-1.json`；该复核同样明确 fake in-memory 测试未覆盖并发/进程级 crash/replay。
- `b01cc8f` 的 acknowledgement seam 已由独立回执 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-outbox-ack-review-round-1.json` 复核通过：SQLite 15 项、projector 2 项定向测试，tsc、targeted ESLint 与 diff check 均通过；回执确认 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false`。随后补充执行了 outbox missing、receipt mismatch 与 stale revision 负例；lease fence 复用同文件既有测试。仍未覆盖跨进程 crash/replay 与跨库 reconciler，故不能把它升级为完整 Host P1/P2 或 AC-1b.2 证据。
- 负例增量复核回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-outbox-ack-negative-review-round-1.json`：确认 `acac90f` 的 missing、receipt mismatch、stale revision 断言与实现一致，既有 lease epoch/owner/expiry fence 覆盖可复用；`condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四条闸门均保持。
- `9d2d521` 增加单次可重试协调接缝：复用 projector，只有 `projected` / `already_projected` 才调用 acknowledgement；非成功投影、outbox 消失和 ack refusal 都原样返回，Product Kernel 与 Runtime 仍是两个事务。独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-reconcile-review-round-1.json`，定向 projector 测试为 3/3，tsc、targeted ESLint 与 diff check 通过；该 seam 仍未覆盖 SQLite integration、并发、真实进程 crash/replay 或完整跨库 inbox reconciler，因此 `condition 6` 和四条闸门不变。
- `385b7a3` 补充真实 SQLite integration：重开 Product Kernel 后调用 reconciliation seam，真实 acknowledgement 返回 `applied=true` 并持久化 `acknowledged`；重复 acknowledgement 返回 `applied=false` 且 revision 不增加，第二次 settlement 仍拒绝。定向 SQLite/projector 测试为 15+3，tsc、targeted ESLint 与 diff check 全部通过；独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-settlement-reconcile-sqlite-review-round-1.json`。该证据仍不覆盖并发、真实进程 crash/replay 或完整跨库 inbox reconciler，故 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- `205d461` + `0ac6e07` 补充 CF-20 最小 runtime memory bridge：真实 SQLite/FileArtifactStore Memory Port 的 `commit → read → persistContextGovernanceMemoryV1` 路径写入 `DisclosureRecordV1` / `MemoryReadRecordV1`，并将 `disclosure` / `memory_read` Context Operation 绑定到同一 RunLedger；首次绑定 `applied=true`，重放 `applied=false` 且 revision 不变，EffectLedger 保持为空。4 个定向测试文件共 14 项、tsc、targeted ESLint 与 diff check 全部通过；独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-context-memory-records-review-round-1.json`，结论 `pass` / `recommendMerge=true`。该切片仍不覆盖 Memory Port 失败状态、并发、真实进程 crash/replay 或 artifact-first 后续绑定失败的恢复清理，故仅登记为最小实现，`condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- `7938d84` 补充同一 SQLite Host 内的 CF-20 并发 fence：RunLedger 已有记录时要求 revision 严格前进一格，第二个复用同 revision 的 writer 返回 `RuntimeStoreFencedError(event_sequence_mismatch)`；真实 SQLite/FileArtifactStore barrier 测试让两个不同 `contextOperationId` 同时读取同一 revision，最终一个绑定成功、一个返回 `ledger_binding_failed`，RunLedger 保留一组（两条）Context Operation。7 个 focused test 文件实际观察到 36 项全部通过，tsc、targeted ESLint 与 diff check 通过；独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-context-memory-concurrency-review-round-1.json`，结论 `pass` / `recommendMerge=true`。artifact-first 竞争失败者的 immutable artifacts 未回收，跨进程并发、真实 crash/replay 与完整 inbox/reconciler 仍未覆盖，故 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- `880896c` 补充 CF-20 的最小失败记录切片：`MemoryReadRecordV1` 在 `missing` / `permission_denied` / `stale` / `revision_mismatch` / `epoch_mismatch` / `manifest_conflict` 失败状态下，未验证的 `manifestRef`、`manifestRevision`、`contentHash`、`disclosureRecordId` 必须全部为 `null`；`persistContextGovernanceMemoryFailureV1` 只写结构化失败记录并绑定 `status=failed` 的 `memory_read` Context Operation，首次写入 `applied=true`，重放 `applied=false`。真实 SQLite/FileArtifactStore 的 disclosure refusal（`memory_disclosure_missing`）路径已通过；8 个相关测试文件共 38 项、tsc、targeted ESLint 与 diff check 全部通过。独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-context-memory-failure-review-round-1.json`，结论 `pass` / `recommendMerge=true`。本轮仅覆盖请求校验阶段的 disclosure refusal，尚未覆盖 manifest/artifact 缺失、权限、stale、revision、epoch、manifest conflict 的数据库故障矩阵，也未覆盖 artifact-first 失败清理、跨进程并发、真实 crash/replay 与完整 inbox/reconciler；因此 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- `a6f75d7` 将真实 Artifact Store 故障接入同一失败记录路径：SQLite/FileArtifactStore 提交第二个 memory artifact 后删除其内容对象，`memory.read(acknowledgeDisclosure=true)` 实际返回 `memory_artifact_missing`；`persistContextGovernanceMemoryFailureV1` 写入 `status=missing` 的结构化 `MemoryReadRecordV1`，`manifestRef`、`manifestRevision`、`contentHash`、`disclosureRecordId` 均为 `null`。8 个相关测试文件共 38 项、tsc、producer 定向 ESLint 与 diff check 通过；独立回执为 `D:\MyHarness\.pactile\tasks\10-10-cg-p1a-checklist-rebind\host-p1-context-memory-artifact-missing-review-round-1.json`，结论 `pass` / `recommendMerge=true`。本增量未重复扩大 replay/reopen 断言，artifact-first 补偿清理、跨进程并发、真实 crash/replay、完整数据库故障矩阵与 inbox/reconciler 仍开放；因此 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- `f73d5ec` 在同一真实 SQLite Host 里补充 stale manifest 故障切片：先提交 basis revision 2，再读取 basis revision 1，`memory.read(acknowledgeDisclosure=true)` 实际返回 `memory_manifest_stale`；随后写入 `status=stale` 的 `MemoryReadRecordV1`，未验证的 `manifestRef`、`manifestRevision`、`contentHash`、`disclosureRecordId` 均保持 `null`。该增量复用了现有失败持久化路径，未修改 runtime 语义；8 个相关测试文件共 38 项、tsc、producer 定向 ESLint 与 diff check 通过。独立复审回执待补；本切片仍不覆盖 permission、revision、epoch、manifest conflict、artifact-first 清理、跨进程 crash/replay 与完整 inbox/reconciler，因此 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
- 工作树随后补充了同一 Host 的 epoch fence 证据：旧 lease 读取实际返回 `memory_lease_fenced`，改用 takeover 后的当前 lease 持久化为 `status=epoch_mismatch` 的 `MemoryReadRecordV1`，四个未验证字段继续为 `null`；8 个相关测试文件仍为 38 项全通过，tsc、producer 定向 ESLint 与 diff check 通过。该增量尚未形成独立复审回执，因此不改变 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门。
- 同一真实 SQLite Host 进一步覆盖 manifest/receipt 冲突：先提交第三个 memory artifact，再把当前 manifest 中该 entry 的 content hash 与 storage ref 一起改成另一份结构上有效但与 durable receipt 不一致的值；`memory.read` 实际返回 `memory_receipt_conflict`，随后持久化为 `status=manifest_conflict`，四个未验证字段仍为 `null`。8 个相关测试文件仍为 38 项全通过，tsc、producer 定向 ESLint 与 diff check 通过；独立复审回执待补，故 `condition 6=partial`、`p0ExitAllowed=false`、`stage1bReady=false` 与四闸门保持。
