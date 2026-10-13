# Retrieval 线阻断清单、共享同步项与未验证项（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**。
- 闸门状态（与用户裁定一致）：`P0_DOCUMENT_WRITE_COMPLETE` · `P0_REVIEW_BLOCKED` · `P0_EXIT_NOT_ALLOWED` · `STAGE_1_NOT_AUTHORIZED`；本轮修复后本线状态为 `READY_FOR_INDEPENDENT_REVIEW`（仅表示「可送审」，**不**表示 P0 通过）。
- 依据：`../implementation/06-blockers.zh-CN.md`（BL-01…BL-23，权威编号）、`../implementation/08-p0-admission-decision.zh-CN.md`、`../implementation/09-contract-entities-v1.zh-CN.md`、本线 `00`–`11`。
- 规则：每个阻断必须有 owner 与解除条件；没有解除条件的只算风险。新编号一律以 `R-` 前缀，**不重编号共享清单**。
- 修复期间并发情况：Implementation 线与 Compression 线在本轮同时更新了 `implementation/**` 与 `compression/**`（非本线写入）。本文件引用的共享契约事实以其**当前**行号为准，并已区分「Implementation 已整合」与「仍冲突」。
- 本轮（第三轮）修复范围：`CF-39`（`02` §5.2 删除本地 `interface` 声明与 Owner 声明）、`CF-42`（`03` §1.1 generation lineage 改名）、`CF-15`（陈旧 `scopeKey` 计数清理）。写集 = `retrieval/02`、`03`、`04`、`12`；本轮已修复并闭合 `X-14`。

## 1. 本线状态

| 项 | 状态 |
| --- | --- |
| P0 文档写作准入 | `P0_DOCUMENT_WRITE_ADMITTED`（`08` 裁定） |
| P0 文档写作 | 已完成（`00` + `01`–`12`） |
| 独立 Review | **未通过**（`P0_REVIEW_BLOCKED`）；`implementation/10-p0-exit-checklist` 条件 1 为 `open` |
| P0 离场 | **不允许**（`P0_EXIT_NOT_ALLOWED`） |
| 阶段 1 授权 | **未授权**（`STAGE_1_NOT_AUTHORIZED`） |
| 本线写集 | `docs/architecture/context-governance/retrieval/**` |
| 是否修改运行时代码 | 否（本线全程零代码改动） |
| 是否调用真实 provider | 否 |
| 是否建立索引 / vector DB | 否 |
| 是否启动长跑 / 旧 Prompt | 否 |
| 是否 commit / push | 否 |
| 是否读取凭据 | 否 |
| 是否修改 `docs/migration/**` | 否（需授权，见 `11` §7 `RG-01`） |

## 2. 共享阻断映射（`implementation/06-blockers` → 本线）

| 共享编号 | 与本线的关系 | 本线已做的处理 | 解除条件 |
| --- | --- | --- | --- |
| `BL-02` | EmbeddingGemma 调研产物缺失 | `09` 全部模型相关 fixture 标 `unverified`（`RD-4`/`RD-9`）；`01` §10 SP-R4；`03` §9 UV-G1…G6 | 提供调研产物，或 Review 接受「参数 + unverified」 |
| `BL-03` | 重新基线前的运行时改动处置 | 本线 `00` §6 记录 9 个文件的 hash；未纳入任何 P0 结论 | 用户决定冻结 / 隔离 / 回退 |
| `BL-04` | `develop` 无提交，`candidateSha` 不可用 | `02` §2.1 冻结 tree-hash 公式；`10` §2 要求绑定 `CandidateRefV1` | 已按 `08` §2.3 裁定执行 |
| `BL-05` | `RunLedgerV1`、唯一 Lease/Epoch、EffectGateway、Policy Gate、WorkspaceHost 均**未实现** | 本线 `02` §6 只冻结**设计挂接**（`contextOperationId + packHash + outcome` 拟落 RunLedger）；`03` §4 S1 明记「需要 Host P2（`BL-05`）；当前不可用」；本线**未**产生任何 ledger / receipt，也**未**做 `operationId` 对账 | Host 轨道 P1/P2 的 Task Close；或评审接受「1a 先行、1b 后置」拆分（`implementation/06-blockers:15` / `:43`、`implementation/10-p0-exit-checklist` 条件 6） |
| `BL-06` | `RetrievalPlanV2` vs ABI `RetrievalPlanV3` | `02` §1 冻结并存规则与 `abiPlan` 引用 | 评审接受 |
| `BL-08` | ABI ref 无法表达行号 / 大写 / 非 ASCII | `02` §7、`04` §8 冻结 `unconvertible` 语义与禁止变换；`10` §5 映射到 **`FI-20.1`** | Review 接受 `SourcePointerV1` |
| `BL-09` | Worker 索引写入 workspace | `03` §4 已对齐共享枚举（S1 写 effect / S2 外置 `indexDir`；选择未定 = `R-BL-09`）；阶段 1a 不建索引 | 阶段 1b/2 选方案 + 授权 |
| `BL-10` | file hash 语义不一致 | `04` IN-4、`02` §5.4（`textHash` 仅诊断） | P0 已裁定（原始字节权威） |
| `BL-11` | 旧证据绑定 MyHarness 候选，不可迁移 | `11` §5 复用规则：旧 results/summary/gold 不复用 | 新候选 + 新 manifest 下重跑 |
| `BL-12` | 旧 gold 缺标注者 / 独立性 | `10` §7 LB-3；`11` §7 RG-05 | 补齐 `labelProvenance` 或重标注 |
| `BL-16` | 外发授权策略未定义 | `08` 全篇 deny-by-default + `EgressAuthorizationV1` | 用户明确 capability policy |
| `BL-17` | 运行时文件被两线交错写入 | 本线未触碰运行时文件 | 指定唯一写入者 |
| `BL-18` | `check-pactile-brand-surface` 当前失败（文档门禁） | 本线新增文档会使该检查的「缺失登记」列表变长；本线已确认新文档不含 legacy 品牌 token | 用户决定登记 / 豁免 / 重基线（**不得为通过检查改写摘要**） |
| `BL-19` | secret 扫描策略未决 | `08` LG-4 / LG-5 记录「形态扫描 ≠ 已保护」 | 用户明确策略 |
| `BL-23` | 旧 P5 `fixtureMismatchCount=1` 未解 | `11` §1、§7 RG-04 保留为未解释事实 | 查明原因 |

本线不阻塞于：`BL-05`（Host 轨道，阶段 1b 起）、`BL-07`（压缩动作词汇，属 Compression 线）、`BL-13`/`BL-14`/`BL-15`（压缩 / 记忆）、`BL-20`（Pi 版本）、`BL-21`（`pactile agent run`）、`BL-22`（Task 提案）。

## 3. 本线阻断项与跨线冲突

### 3.1 本次修复已闭合的项（ID 唯一，无重复）

下表包含两类：本线自行修复的项，以及**修复期间由 Implementation 线在共享契约中完成整合**的项（后者以当前行号为准）。

| 编号 | 原问题 | 解决位置 | 证据（文件 + 行 / 章节） |
| --- | --- | --- | --- |
| `R-BL-01`（已闭合） | `02` 维护了本地 `FactStatusV1`（11 项）与 `RetrievalFactStatusV1` | 本线：`02` §3.1（只引用 `01` §3.3 / `09` §3；`SRC-1…SRC-5`）；`05` / `07` / `09` 的旧引用已改 | `02` §3.1；旧别名仅存于废弃说明 |
| `R-BL-02`（已闭合 → 由 CF-39 收口，见 `R-BL-27`） | `InspectResultV1` 的检索字段散落、无唯一字段表 | 唯一字段表 / `id` 枚举 = `01` §4.4；本线：`02` §5.2 只保留**字段映射 + 自有校验规则**（`IR-1…IR-5`），已删除本地 `interface` 声明 | `02` §5.2；机械验证：`rg -n 'interface Inspect(Result\|Check)V1' retrieval/` = 0（未声明） |
| `R-BL-03`（已闭合，原为「待裁定」） | 对照臂 `RET-A2` 定义冲突 | **Implementation 已裁定**：`RET-A2` = Jev plan shadow + exact + structural（semantic 关闭）；旧提案降为 `RET-A3` | `implementation/04-evaluation-controller` §10（CF-25）；本线：`10` §4 `AR-1` / `AR-1b` / `AR-1c` / `AR-6` |
| `R-BL-05`（部分闭合） | `evaluationRunId` / `contextOperationId` 与 `PACTILE_LOGICAL_ID_PATTERN` 未核对 | 静态只读核对：模式 `^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$`；`evr-<ts>-<slug>` / `eval-evr-…` / `semgen-<hex32>` / `retrieval-*` / `rf-01` / `fq-16.ua` 全部 MATCH；大写 / 中文 / 连续分隔符 NO-MATCH | `packages/cli/src/pactile/shared/validation.ts:296`（`decodeLogicalIdV1:335`）；残余见 §4 `UV-14` |
| `R-BL-06`（已闭合为本线提案） | `reason.code` 字符集与封闭枚举未定义 | 本线：`02` §3.5（字符集 + `RS-1…RS-4` + 封闭枚举 + 移除 5 个旧码 + 重建语义码） | `02` §3.5 |
| `R-BL-11`（已闭合） | `permissions` / `freshness` 被重新定义形状；`scopeId` 被误写为检索自定义字段 | 本线：`02` §5.3（`SY-PS-1…3`，`scopeId` = `PermissionScopeV1` 唯一键）；`01` §2.5/§2.6 与 `05` §2 注释同步 | 本线：`02` §5.3；共享：`09` §1.2.1 规则 3、§1.2.2 |
| `R-BL-13`（已闭合） | FI-02 单层 `invalid_response` 与 `09` §3 保留 `wrong_dimension` 冲突 | **Implementation 已整合为两层预期** | `implementation/04-evaluation-controller:153`（FI-02）/`:183`（状态区分要求）；本线：`10` §5 `FQ-16`、`02` §3.3 |
| `R-BL-14`（已闭合） | `unconvertible` 无专属 FI | **Implementation 已登记子用例 `FI-20.1`** | `implementation/04-evaluation-controller:172`（`FI-20.1`，明标不是新全局编号）；本线：`10` §5 `FQ-23`、`04` §8 `UN-6` |
| `R-BL-15`（已闭合） | RK 字段类型与 `09` §3.1 矩阵不一致；残余的 `StatusFoldV1` 包装类型 | **Implementation 已收窄类型**；本线**已删除** `StatusFoldV1`，折叠只用 `01` §4.3 PK-7 字段 | `implementation/01-contract-draft:399`/`:403`/`:423`（PK-7）/`:424`（PK-8）；本线：`02` §3.3、§8 SY-2/SY-3 |
| `R-BL-16`（已闭合） | `IR.sourceHash` 与 `fileHashRaw` 命名冲突 | **Implementation 已统一**：`IR.fileHashRaw` 与 `CU.sourceHash` 同概念、不同字段名，不互换 | `implementation/01-contract-draft:443`（`IR.fileHashRaw`）、§4.5（`CU.sourceHash`）；本线 `02` §8 SY-7 |
| `R-BL-18`（已闭合） | 跨文件 ID 冲突：`02` 内 `RC-*` 双义；`RB-*` 在 `03`/`06`/`09` 三义 | 本线：`02` §3.5 → `RS-*`；`06` §4 → `RS-*`；`09` §5 → `RDB-*`；`03` §6 保留 `RB-*` | `02` §3.5/§4.2 命名空间说明；`06` §4 / `09` §5 头部 |
| `R-BL-22`（已闭合） | 评测结果行三层字段提案与 `04` §9.2 竞争 | 本线**撤销提案**：原生层 = `04` §9.2 `observed.status`；pack 层 = `01` §4.3 字段 + `cg-wrong-dimension` | 本线：`10` §3.5（`TL-1…TL-6`）、`02` §8 SY-3 |
| `R-BL-23`（已闭合） | `SemanticProviderProfileV1` / `EmbeddingProviderProfileV1` 未登记 | 本线**删除**两类型：`describe()` 返回 `PCS` provider 记录；generation 参数归 `03` §1 tuple | 本线：`01` §2.3/§2.4/§10 `SP-R2`；共享：`09` §1.2（PCS 行） |
| `R-BL-24`（已闭合） | 索引写入方案曾列为三种（含共享枚举外的内存方案） | 本线：`03` §4 改为共享的**两种**（S1 写 effect / S2 外置 `indexDir`）；选择归 `BL-09` | 本线：`03` §4 `SC-1…SC-3`；共享：`02-ownership-dependency:28`、`01-contract-draft:769` |
| `R-BL-25`（已闭合） | 阶段 1a 分支集合曾写成待定 | 本线：`05` §1 / `10` §8 改为「1a = exact + structural」（权威：`03-stage-plan` 阶段 1a 目标行）；`lexical` / `relation` 不属 1a | 本线：`05` §1 表+注、`10` §8 注 |
| `R-BL-26`（已闭合） | 本线未定义 `InspectResultV1` 的 T3 字段到共享登记的映射（早期增补项） | 本线：`02` §5.2 列出「已删除字段」（`scopeId` / `snapshot` / `operationEpoch`）与替代写法 | `02` §5.2；共享：`09` §2.1–§2.2（IR 行） |
| `R-BL-21`（已闭合） | `RK.gaps[]` 未登记（曾为本线阻断） | **Implementation 已登记**：`01` §4.3 line 422（字段形状 `{status, reason, detailHash}[]`）+ PK-9/PK-10（line 440/441）；本线 `02` §4.3 改为引用 | 本线：`02` §4.3 / §8 SY-5；本文件 §3.3 `X-7` |
| `R-BL-08`（已闭合） | `SemanticProviderProfileV1` / `EmbeddingProviderProfileV1` 是否独立成型（旧阻断，曾列于 §3.2） | 已由 `R-BL-23` 同一修复关闭：两类型删除，`describe()` 返回 `PCS` provider 记录；本行保留编号以避免断号 | 本线：`01` §2.3/§2.4/§10 `SP-R2`；本文件 `R-BL-23` |
| `R-BL-17`（已闭合） | `09` §3 的 `cancelled` 描述含「deadline /」字样，与 `timeout` 规则矛盾 | **Implementation 已修**（16:1x）：`09` §3.2.2 的 `cancelled` 行现为「上层 / 父级 deadline 触发的 abort」；`:345` + item 29（`:464`）显式记该裁定 | 共享：`implementation/09-contract-entities-v1` §3.2.2 `cancelled` 行（`:327`）→ 唯一判定规则（`:345`）/ §6 第 29 条（`:466`）；本线：`02` §3.4 `TC-1` / `TC-10`、§8 `SY-14` |
| `R-BL-19`（已闭合） | `09` §3.2.2 曾把 `unconvertible` 列入 `IR`，与 §3.1 矩阵矛盾 | **Implementation 已修**（16:0x）：`09` §3.2.2 矩阵「`unconvertible`」行现写「`IR` 不在其中」，§6 第 28 条登记「`IR` 不承载 `unconvertible`（X-10 / R-BL-19）」 | 共享：`implementation/09-contract-entities-v1` §3.2.2 矩阵「`unconvertible`」行（`:403`）/ §6 第 28 条（`:465`）；本线：`02` §3.2 `AP-1`/`AP-3`、§8 `SY-13` |
| `R-BL-20`（已闭合） | `01` §4.2 line 401 不变量写「`embeddingDim` 不一致 → 整个候选是 `invalid_response`」，与 `RC` 原生层矛盾 | **Implementation 已修**（15:59）：现为「原生状态是 `wrong_dimension`（不是低分候选，**不得**在 RC 层提前折叠）」 | 共享：`implementation/01-contract-draft:401`；本线：`02` §3.3 `WD-1` / `WD-2` |
| `R-BL-27`（已闭合） | **CF-39**：`02` §5.2 自持 `interface InspectResultV1` / `interface InspectCheckV1` 声明，并声称「本文件为字段表 Owner」「`id` 枚举唯一来源」「其他文档只能引用本表」 | 本线：`02` §5.2 重写为「字段映射 + 自有校验规则」；**删除**两个 `interface` 声明块；新增 `IR-5`（禁止把映射表当字段表引用） | 本线：`02` §5.2（`IR-1…IR-5`）+ §8 SY-2/SY-15；共享：`implementation/01-contract-draft` §4.4「唯一字段表」段；机械验证：`rg -n 'interface Inspect(Result\|Check)V1' retrieval/` = 0 |
| `R-BL-28`（已闭合） | **CF-42**：`03` §1.1 `SemanticGenerationV1` 用 `supersedes`（旧类型 `string \| null`）表达 generation 链，与 CM 的 `supersedes`（`EntityRefV1 \| null`）同名异义 | 本线：`03` §1.1 改为 `previousGenerationId` / `nextGenerationId`，新增 `LG-1…LG-4`（命名隔离、旧名作废、`state` 值 vs 字段名、双向链一致性） | 本线：`03` §1.1 line 58/59 + `LG-1…LG-4`（line 72–75）；共享：`01` §4.6（CM）/ `09` §1.2.4（CMP）；机械验证：`rg -n 'supersedes:\s*string' retrieval/` = 0 |

### 3.2 仍未闭合的阻断项

| 编号 | 阻断 | 证据（文件 + 章节 / 行） | 影响 | owner | 解除条件 |
| --- | --- | --- | --- | --- | --- |
| `R-BL-04` | `docs/migration/**` 的 P9 / P10 桶名更正未执行 | 待更正行：`docs/migration/retrieval-worker-d25d33.zh-CN.md:45`；写集归属：`implementation/07-legacy-migration:90`（`R-6`）、`:111`（脚注 4）、`:100`–`:102`（erratum 表）；本线登记：`11` §2 / §7 `RG-01` | 旧文档桶名错位 | 用户（扩展写集授权） | 授权写 `docs/migration/**` 后执行 |
| `R-BL-07` | 阶段 1a 的分支集合 | **已定**：`03-stage-plan` 阶段 1a「目标」行 = exact + structural；`lexical` / `relation` 已在 `01` §4.1/§4.2 枚举中登记，但**不属** 1a | 阶段 1a 分母 | Implementation | 若要把 `lexical` / `relation` 纳入 1a，必须先修改 `03-stage-plan` 的 1a 目标行（本线不得自行扩大分母） |
| `R-BL-09` | 索引写入方案选择（`08` §3.2 的**两种**：S1 EffectGateway 写 effect / S2 外置 `indexDir`）；`SemanticIndexManifestV1` 是否复用 manifest store | `implementation/02-ownership-dependency:28`（两种方案只记录不选择）、`01-contract-draft:769`（#10）、`06-blockers:47`（`BL-09`） | 阶段 1b / 2 | 用户 + Host 轨道 | 选方案并授权；本线 `03` §4 已对齐两种方案 |
| `R-BL-10` | readiness 最小 blocking 集未定 | `09` §3（列头「拟 blocking」）、`RD-8`；fixture registry = `04` §4.1 | 阶段 2 准入 | Implementation（`04` §4.1 / `09` §5） | 在阶段 2 readiness 运行授权时同时冻结 blocking 集；冻结前不得签发 `ready` |
| `R-BL-12` | 本线负例序号 N-01…N-27 与「静默改写 pointer」阳性对照的全局编号未分配 | 编号权威：`01` §7 line 784（`#1–#18` 已用）、`09` §6（`#19–#28` 已用）；本线：`02` §9（N-nn）、`10` §5 阳性对照行 | 负例与阳性对照无法冻结 | Implementation（`01` §7 / `04` §7.1） | 分配 `#29+` 与 KB 编号；`FI-20.1` 已示范子用例做法 |

### 3.3 跨线字段冲突登记（按任务书要求：文件 / 章节 / 字段 / 冲突内容 / 建议裁定）

| 编号 | 文件 + 位置 | 字段 | 冲突内容 | 建议裁定 |
| --- | --- | --- | --- | --- |
| `X-1` | ~~`implementation/01-contract-draft:340`/`:343` vs `09` §3.1~~ **已闭合** | `RK.rejected[].status`、`RK.coverage[].status` | Implementation 已收窄为 `Exclude<FactStatusV1, "ok" | "wrong_dimension">` | 已按 `09` §3.2.2 折叠；本线 `02` §3.3 保留规则层 |
| `X-2` | ~~`implementation/01-contract-draft:386` vs `09` §1/§7~~ **已闭合** | `InspectResultV1.permissions` | Implementation 已改为引用 `PermissionScopeV1`；`09` §1.2.1 提供唯一形状 | 已闭合（本线 `02` §5.3 只引用） |
| `X-3` | ~~`implementation/01-contract-draft:385` vs `09` §1/§7~~ **已闭合** | `InspectResultV1.freshness` | 同上（`09` §1.2.2 提供 `FreshnessV1`，`mtimeMs` 不再是判定依据） | 已闭合（本线 `02` §5.3） |
| `X-4` | `implementation/04-evaluation-controller` §10 vs 任务书 | 对照臂 | `RET-A2` = Jev plan shadow + exact + structural（semantic 关闭）；旧提案降为 `RET-A3` | **已闭合**：`04` §10（CF-25）+ 本线 `10` §4 `AR-1` |
| `X-5` | ~~`compression/compression-memory-evaluation-matrix-v1` vs 本线 `10` §4~~ **已闭合** | 臂 ID | Implementation 已将两线臂命名空间化：`RET-A0…A3` / `CMP-A0…A5` | 已执行（`04` §10）；本线 `10` §4 `AR-1b` / `AR-1c` |
| `X-6` | ~~`implementation/01-contract-draft:92`–`:94` vs `implementation/09-contract-entities-v1` §3~~ **已闭合** | `FactStatusV1` 成员数 | `01` §3.3 含 4 个 P0 新状态（与 `09` 一致）；`09` §3 正文已改为「修复轮声明」 | **已闭合（16:2x 实测）**：`rg -n '待同步' implementation/09-contract-entities-v1.zh-CN.md` = 0 |
| `X-7` | ~~`implementation/01-contract-draft` §4.3 vs `09` §3.2.2~~ **已闭合** | `RK.gaps[]` | Implementation 已在 `01` §4.3 line 422 登记字段（`{status, reason, detailHash}[]`），并补 PK-9/PK-10（line 440/441） | 本线 `02` §4.3 行已改为引用 |
| `X-8` | ~~`implementation/04-evaluation-controller` §9.2 vs 本线 `10` §3.5~~ **已闭合** | `results.jsonl` 行 | 本线已**撤销**三层字段提案；原生层 = `04` §9.2 的 `observed.status`；pack 层 = `01` §4.3 字段 | 已执行（`10` §3.5 `TL-1…TL-6`） |
| `X-9` | ~~`implementation/09-contract-entities-v1:317` vs `:335`；`implementation/01-contract-draft:131`~~ **已闭合** | `cancelled` 描述 | `09` 的 `cancelled` 行曾含「deadline /」字样 | **已闭合（16:2x 实测）**：Implementation 已修，现为「上层 / 父级 deadline 触发的 abort」（`:327`），与唯一判定规则（`:345`）及 §6 第 29 条（`:466`）一致；本线一律按 `02` §3.4 `TC-1` / `TC-10`（`R-BL-17`） |
| `X-10` | ~~`implementation/09-contract-entities-v1:374` vs `:339`–`:356`~~ **已闭合** | `unconvertible` × `IR` | §3.2.2 曾把 `IR` 列入，§3.1 矩阵为 `—` | **已闭合（16:2x 实测）**：`09` §3.2.2 矩阵「`unconvertible`」行（`:403`）明写「`IR` 不在其中」、§6 第 28 条（`:465`）登记；本线按 §3.1 矩阵（`02` §3.2 `AP-1` / `AP-3`、`04` §8 `UN-5`）（`R-BL-19`） |
| `X-11` | ~~`implementation/01-contract-draft:387` vs `implementation/09-contract-entities-v1:370`~~ **已闭合** | `RC` × `wrong_dimension` | `01` §4.2 曾写「整个候选是 `invalid_response`」 | **已闭合（15:59 实测）**：`01` §4.2 现为「原生状态是 `wrong_dimension`（…不得在 RC 层提前折叠）」（`R-BL-20`） |
| `X-12` | 本线 `03` §4（早期草稿三种方案）vs `implementation/08-p0-admission-decision` §3.2 / `01-contract-draft:769` | 索引写入方案 | 共享只枚举**两种**方案；本线曾列入第三种（内存 / 临时目录） | **已闭合**：本线删除第三种； `03` §4 与 BL-09 对齐 |
| `X-13` | `compression/*` 的 `scopeKey` vs `implementation/09-contract-entities-v1` §1.2.1 | 权限唯一键 | **当前活字段 = 0**（2026-10-09 15:52 只读重测：`compression/` 共 3 处命中，**全部**是“不得使用旧名”的禁令 / 历史说明——`context-unit-manifest-v1.zh-CN.md` L123（SP-5 废名）、L161（CF 状态行）、L438（字段名禁令表）；`rg -n 'scopeKey\s*[:?]' compression` = 0，无任何 live 字段声明）。旧记录「仍 7 处」**已失效，不得再当作活冲突** | **已闭合（CF-15）**；本线全部使用 `scopeId` |
| `X-14` | 检索线 `04` §2 line 46 vs `implementation/01-contract-draft` §4.4 | `InspectCheckV1.id` 枚举的引用指针 | **性质 = 引用指针陈旧，不是 shared schema 冲突**：`01` §4.4 与 `02` §5.2 在字段 / 枚举定义上已无分歧，修复前 `04` 曾把唯一来源写为「`02` §5.2」，现已按 CF-39 改为 `01` §4.4。Implementation 侧同此登记：`implementation/10-p0-exit-checklist:101`（「仍开放且**不属 schema 冲突**」）/ `:102`（「写集外陈旧项…本线只登记，不伪装为已修复」）。**已闭合（本轮修复）**：`04` §2 line 46 已改为引用共享 `InspectResultV1` / `InspectCheckV1` 的唯一来源 `implementation/01-contract-draft` §4.4，并保留 `02` §5.2 仅作映射与线内校验。验证：`rg` 命中 0 条旧 Owner 引用。 | Owner = 本线 |
| `X-15` | ~~`implementation/05-writeset-rollback` §2.1 的 CF-39 / CF-42 行~~ **已闭合** | 冲突登记表的闭合状态 | 该处曾将 CF-39 / CF-42 列为未闭合、并把 `03` L58 归到 `SemanticIndexManifestV1` | **已闭合（16:20 实测）**：Implementation 已在 16:10 逐条重测磁盘并改写（`:97` / `:115` / `:221` / `:224`），现记 CF-39 / CF-42 已闭合且引用正确行号（`02:360`、`03:58/59/72–75`） |

## 4. 未验证项（不得写成 pass）

| 编号 | 内容 | 现有信息 | 关联 |
| --- | --- | --- | --- |
| `UV-01` | EmbeddingGemma 模型 id、默认维度语义、task prefix、query/document 前缀差异、batch、取消、隐私、成本 | 无调研产物 | `BL-02`、`09` §3、`03` UV-G1…G6 |
| `UV-02` | 512 / 256 / 128 profile 的性质（同一模型输出维度 / 独立模型 / 后处理投影） | 无调研产物 | `09` §2 PF |
| `UV-03` | RRF 的 `k` 与分支权重取值 | 无基线 | `05` FU-1 / FU-8 |
| `UV-04` | 六条分支的延迟、字节 / token 消耗基线 | 未测量 | `10` §3 |
| `UV-05` | `unconvertible` 在真实仓库（含大写、中文路径）中的比率 | 未测量 | `02` AB-4 |
| `UV-06` | 阶段 1a 在 Windows 大仓库下的 Inspect 吞吐 | 未测量 | `04` §2 |
| `UV-07` | 旧 P1 无权威 run、旧 P3 abort 窗口 INCONCLUSIVE、旧 P7 冻结前证据 | 旧证据 | `11` §1、共享 `UV-09` |
| `UV-08` | no-gold 与 wrong-repository 的 gold 标注独立性与盲审 | 旧文件无记载 | `BL-12`、`10` §7 |
| `UV-09` | 外部 Search / Fetch provider 的真实行为（限流、内容类型、重定向） | 未接真实 provider | `07`、`08` |
| `UV-10` | Node 24.0.0 最低版本的干净安装 / 全量测试 / pack | 仅 Node 24.3.0 | 共享 `UV-07` |
| `UV-11` | 本地 semantic provider（进程 / 端口）在 `PCS` provider 记录中的表达是否足够 | 未设计 | `01` §2.3（已改为引用 `PCS`）、`08` LP-2、`09` §1.2 |
| `UV-12` | precision / 量化对召回的影响 | 未测量 | `03` UV-G4 |
| `UV-13` | 多 worktree 并发重建的资源与锁需求 | 未设计 | `03` GI-R5、`R-BL-09` |
| `UV-14` | `evaluationRunId` / `contextOperationId` 的**运行时 decoder 是否真的应用** `PACTILE_LOGICAL_ID_PATTERN` | 本项目前只做静态正则核对（`packages/cli/src/pactile/shared/validation.ts:296` `:335`），未运行任何 decoder；格式提案 MATCH，但「契约会把该字段按 logical id 解码」仍未验证 | `R-BL-05` 残余、`04-evaluation-controller` 开放问题 1、`09` §7 |
| `UV-15` | 是否存在 EmbeddingGemma 调研产物位于更深的未检索位置 | 迄今多目录检索无命中 | `BL-02`、共享 `UV-15` |
| `UV-16` | 检索事实的持久化与 receipt 是否成立（`RunLedgerV1` 未实现、`operationId` 对账未产生） | 共享侧实测仅为「**未实现**」与「**未产生**」（`implementation/10-p0-exit-checklist:74`：`RunLedgerV1` 本体与实现未实现，候选代码仍以 `RuntimeStore` 为权威；`:75`：CDR / CAR ↔ `operationId` 对账证明未产生，需阶段 1b 运行时）。本线 `02` §6 仅为设计挂接，**无任何运行证据**；lease / EffectGateway 同样未实现（`03` §4 S1「当前不可用」） | `BL-05`、`implementation/10` 条件 6、本文件 §2 `BL-05` |

## 5. P0 离场条件自检（本线视角；不声称通过）

| AC | 内容 | 本线状态 |
| --- | --- | --- |
| AC-0.1 | 实体有字段表、版本、hash 规则、provenance；非 ok 状态一等 | 计数以 `09` §1.1 为权威：**T1 = 12 实体 + T2 = 9 支撑类型（登记表 21 行）**；非 ok 状态 = **14 项**（`01` §3.3 的 15 成员含 `ok`）。检索侧字段口径：`InspectResultV1` / `InspectCheckV1` 字段表与 `id` 枚举 = `01` §4.4（本线只映射，`02` §5.2）；RP/RC/RK = `02` §4；PS/FR = `09` §1.2.1/§1.2.2（本线只引用，`02` §5.3）；层级规则：`02` §3.3 |
| AC-0.2 | 负例各有 fixture 清单 | 本线 27 条以 `N-01…N-27` 编号（`02` §9）；全局编号 `#29+` 由 `01` §7 分配（`R-BL-12`）；尚未转成 fixture 文件 |
| AC-0.3 | 两线详细契约与 `01` 不变量无冲突或已裁定 | §3.3 冲突表：共 15 行，已闭合 15 行；未闭合 0 行。 |
| AC-0.4 | fixture / gold 冻结并记录 sha256、标注者、独立性、盲审 | 规则已冻结（`10` §2/§7）；第二方盲标注已产出 33/33 negative 回执，且已完成与现有 labels 的 33/33 条机械比对；Pactile canonicalizer 已预计算 bodyHash/caseSetHash，且独立复核回执 `evidence/p0/p0-hash-preflight-review-round-1.json` 已重算确认 33/33 一致；但两份回执仍为 `preflight-not-frozen`，候选作者独立性声明、实际冻结、fixtureHash 和正式 hash 回填仍未完成（值仍为 `sha256:<pending>`） |
| AC-0.5 | ERM / PCR 模板定稿 | 由 `04` 负责；本线提供绑定字段（`10` §2）、状态层级口径（`10` §3.5）与停止条件（`10` §6）。**模板与实例均未产出**：本线不存在任何 ERM / PCR 实例，不得写成已定稿 |
| AC-0.6 | 故障注入清单定稿（含预期状态与恢复） | FI-01…FI-27 + KB-1…KB-7 为**设计编号与映射**（本线映射见 `10` §5；`unconvertible` 固定为 `FI-20.1`，`R-BL-14` 已闭合）。**KB 实例尚未生成；已有最小 fixture 输入与 catalog 登记文件，但均未冻结**：`implementation/10-p0-exit-checklist:76` 记 fixture 值仍为**未回填的 hash 占位符**，现有登记文件尚未成为冻结注册 |
| AC-0.7 | BL-02/03/04/06/07 有结论 | `BL-04`/`BL-06` 已裁定；`BL-02` 按「参数 + unverified」；`BL-03` 待用户；`BL-07` 属 Compression |
| AC-0.8 | 旧证据迁移表与 regression case 清单通过 Review | `11` 提供迁移表、编号所有权（§7.1）与行动项 `RG-01…RG-08`；regression case 清单待与 `04` 合并 |

结论：本线已完成**第四轮**（只读一致性复核 + 证据状态登记：CF-39 / CF-42 / CF-15 复核通过；Implementation 侧 `R-BL-17` / `R-BL-19` / `R-BL-20` / `X-6` / `X-9` / `X-10` / `X-11` / `X-15` 已逐条重测确认闭合；新增 §2 `BL-05` 行、§4 `UV-16` 行、AC-0.5 / AC-0.6 实例缺失声明、§6 四条禁止声明、§7 条件六 / 七证据行；`X-14` 已修复并闭合，原为陈旧引用，非 schema 冲突）。**仍未通过独立 Review**；§3.1 已闭合 24 行、§3.2 未闭合 5 行、§3.3 未闭合 0 行、§4 未验证 16 行——均有效。

## 6. 不得声明的结论

```text
「检索链路已完成」／「检索已接入」        → 未接入 Agent Context Pipeline
「P0 已通过」／「P0 完成」                → 文档已写并修复，独立 Review 未通过
「本轮修复完成 = P0 通过」               → 最多 READY_FOR_INDEPENDENT_REVIEW
「Review 发现已全部关闭」                 → 已闭合项在 §3.1；未闭合项在 §3.2
「semantic 质量已验证」                   → 未接真实 provider，readiness 未运行
「旧评测支持新架构」                      → 旧证据只作背景（`11` §1）
「fixture 已冻结」                        → 格式已定义，hash 未回填（AC-0.4）
「外发策略已定义即可放行」                 → deny-by-default 仍然生效（`BL-16`）
「readiness 通过 = 可发布」               → readiness ≠ quality ≠ 接入验收
「blocking 集已定」                       → 仅为提案（`RD-8` / `R-BL-10`）
「A2 未定」／「A2 = A1 + Jev」            → 已闭合：`RET-A2` = Jev plan shadow + exact + structural；旧式表述降为 `RET-A3`（`10` §4 / `04` §10）
「PS/FR 形状待定」                        → 已冻结：`09` §1.2.1 / §1.2.2；本线只引用
「scopeId 是检索自定义字段」                 → 错：`scopeId` 是 `PermissionScopeV1` 的**唯一键**（`09` §1.2.1）
「unconvertible 可写在 IR 上」              → 错：`09` §3.1 矩阵 IR = `—`（§3.3 `X-10`）
「检索线拥有 InspectResult 字段表」          → 错：唯一字段表 / `id` 枚举 = `01` §4.4；本线只映射（`02` §5.2 `IR-5` / CF-39）
「generation 的 supersedes 就是 CM 的 supersedes」 → 错：generation 链 = `previousGenerationId` / `nextGenerationId`；CM = `supersedes: EntityRefV1 \| null`（`03` §1.1 `LG-1` / CF-42）
「旧键名仍是活字段」                       → 失效：当前活字段 = 0（§3.3 `X-13`，15:4x 只读实测；旧计数值已作废）
「RunLedger / receipt 已产生」              → 未实现：`RunLedgerV1` 未实现、`operationId` 对账未产生（§4 `UV-16`、`implementation/10` 条件 6）
「fixture / gold / labels / KB 已冻结」      → 未冻结：hash 仍为未回填占位符，现有登记文件尚未成为冻结注册（AC-0.4 / AC-0.6、`implementation/10-p0-exit-checklist:76`）
「ERM / PCR 已定稿」                        → 模板与实例均未产出（AC-0.5）
「X-14 是新的 schema 冲突」                 → 错：仅引用指针陈旧，现已修复闭合，不属 schema 冲突（§3.3 `X-14`）
```

## 7. 下一闸门

| 闸门 | 条件 |
| --- | --- |
| Implementation Controller 共享契约整合 | `R-BL-17` / `R-BL-19` / `R-BL-20` 与 `X-6` / `X-9` / `X-10` / `X-11` **已全部由 Implementation 修完并经本线 16:2x 逐条重测确认**（见 §3.1 与 §3.3）；余下待办：负例 `#29+` 与 KB 编号分配（`R-BL-12`）。**已关闭项**：CF-15（活字段 = 0）、CF-39（`R-BL-27`）、CF-42（`R-BL-28`）——均无需再列入本闸门 |
| X-14 修复证据 | `X-14`：`retrieval/04` §2 line 46 的旧 Owner 引用已修正为共享 `InspectResultV1` / `InspectCheckV1` 唯一来源 `implementation/01-contract-draft` §4.4；`02` §5.2 仅作映射与线内校验。**性质 = 引用指针陈旧，已闭合，不是 shared schema 冲突**。修复证据：`rg` 命中 0 条旧 Owner 引用。 |
| 条件 6 / 7 证据（Harness 侧） | 检索事实的 receipt（`RunLedgerV1` / `operationId` 对账）与 fixture / gold 冻结均属 Harness 侧证据，当前全部为**未实现 / 未产生 / hash 占位符未回填**；本线只提供绑定字段与设计挂接（§4 `UV-16`、AC-0.4、AC-0.6），不得在条件 6 / 7 上声称本线已闭环 |
| 独立复审（目标条件） | 本线 `00`–`12` **需**通过独立 Review；当前轮十二完整入口以及轮十三、轮十四闸门复核结论均为 `BLOCKED`，且 Task Kernel 的 `candidateSnapshot=null`；Pactile 支持无 Git 的 bounded project snapshot，但当前任务根目录是 `D:\MyHarness`，待复审契约文件位于兄弟目录 `D:\pactile`，现有 snapshot 不覆盖根目录外文件，因此该条件尚未满足。`R-BL-04`、`R-BL-07`、`R-BL-09`、`R-BL-10`、`R-BL-12` 有结论；fixture / gold 实际冻结并回填 sha256（当前 4 处占位声明仍为未回填占位符：`02` 前置声明、`01` 前置声明、`06` §4、本文 AC-0.4） |
| 离开 P0 | 复审通过 + 上表全部满足 + `08` §5 的 P0 离场条件 1–10 满足 |
| 进入阶段 1a | 离开 P0 + `BL-03`（运行时文件处置）+ `BL-17`（唯一写入者）+ `BL-22`（Task 提案批准）+ 用户授权 |
| 进入阶段 2 | 阶段 1a 完成 + `BL-02`（或接受参数化）+ `BL-16`（外发策略）+ readiness 运行授权 + `R-BL-10` blocking 集冻结 |
| 任何代码工作 | 单独授权；本线当前无代码写集 |
