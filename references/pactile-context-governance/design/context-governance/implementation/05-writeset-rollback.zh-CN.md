# 写集、冲突地图与回滚说明（proposed）

- 状态：proposed。本文不执行任何回滚，也不删除任何文件。
- 范围：本轮实际写集；三条线的目录冲突；拟议的后续写集；重新基线前运行时改动的逐文件回退说明；快照协议；各阶段回滚点。
- 约束：`develop` 没有任何提交，**所有**文件都是 untracked，因此不存在 git 基线可用于 `checkout` / `restore` / diff。任何“回滚”都必须先有只读快照与 hash 清单。

## 1. 实际写集

### 1.1 重新基线轮（仅文档，均为新增）

```text
D:\pactile\docs\architecture\context-governance\implementation\
  00-rebase-report.zh-CN.md
  01-contract-draft.zh-CN.md
  02-ownership-dependency.zh-CN.md
  03-stage-plan.zh-CN.md
  04-evaluation-controller.zh-CN.md
  05-writeset-rollback.zh-CN.md        （本文件）
  06-blockers.zh-CN.md
  07-legacy-migration.zh-CN.md
```

### 1.2 P0 文档轮（仅文档；本轮）

新增：

```text
  08-p0-admission-decision.zh-CN.md    （用户提供并作为裁定文件）
  09-contract-entities-v1.zh-CN.md     （P0 文档轮：17 实体 × 18 必述项、14 状态、hash 规则；**修复轮已修订为 21 登记项，见 §1.4**）
  10-p0-exit-checklist.zh-CN.md        （P0 离场自检）
```

原地修订（仍仅限文档）：

| 文件 | 修订内容 |
| --- | --- |
| `01` | `FactStatusV1` 由 10 项扩至 **14 项**（新增 `generation_mismatch` / `wrong_dimension` / `cancelled` / `unconvertible`）；§5 动作词汇标为 P0 冻结；§7 负例 #19–#28 指针；§9 四项标记已冻结 |
| `02` | 新增 §0（10 条 ownership 收紧 + 3 条边界）；F-11…F-14；外发依赖行；阶段 1a 不写 index |
| `03` | 新增 §1.6（每阶段 11 项必交字段矩阵）、§1.7（12 裁定的阶段落地） |
| `04` | FI-25（取消）/ FI-26（旧 P5 fixtureMismatch）/ FI-27（generation 漂移）；§6.1 失败包；§7.1 known-bad candidate 注册表；状态区分要求 |
| `06` | 新增 §1.1（P0 裁定后的阻断状态）；重写 §3 准入顺序 |
| `07` | 新增 §2.0 降级等级、§2.4 旧证据降级登记、§3.1 P8/P9/P10 erratum；R-6 改为不双写；§6 hash 表更新 |
| `05` | 本文件的写集与冲突记录 |

本线**没有**：修改任何 `packages/**` 文件、Worker 候选、`D:\MyHarness\**`、Provider 配置、lockfile、gold、分母、旧 run 目录、全局配置；没有 commit / push / reset / stash；没有启动或终止任何进程；没有读取或写入凭据；没有启动任何评测、真实 provider、真实 compaction 或 restore 演练。

### 1.3 只读核查（本轮）

| 动作 | 结果 |
| --- | --- |
| 冻结候选 16 文件的 tree hash | 与本轮开始一致（`sha256:5997626548a43627…`），**未改动** |
| `packages/**` 最近 40 分钟写入的文件 | 无（排除 `dist` / `.tmp` / `node_modules`） |
| `git status --short` 条目数 | 18（维持现状；无新目录外写入） |

本线对 `typecheck`、`lint` 的两次执行、以及 `check-pactile-brand-surface` 的一次执行是只读检查：它们不修改源文件（`typecheck` 不输出；`lint` 不带 `--fix`）。

### 1.4 P0 修复轮一（历史；仅文档）

写集（只修订，不新增文件）：`01`–`07`、`09`、`10` 共 9 个文件。**不在写集内**：`00`、`08`（用户裁定文件）、`packages/**`、`docs/migration/**`、`retrieval/**`、`compression/**`、gold、fixture、评测结果、全局配置。

本轮做了什么：把独立 Review 提出的共享契约阻断逐条裁定并登记（§2.1 冲突登记表）；修订 01/09 的实体分层与计数、权限唯一形状、保护分类唯一枚举、CAR 17 项与 verdict、状态折叠规则；修订 02 的 T2 所有权与“计划 vs 已执行”读法；修订 03/04 的 AC 计数、FI 预期状态与臂编号；修订 05/06 的写集地图与阻断状态；修订 10 的离场条件自检。

本轮**没有**做：任何运行时代码改动、真实 provider / compaction / restore / promotion、评测长跑、fixture / gold / hash 冻结、Task / Run 创建、commit / push；`09` 与 `01` 的新裁定全部标记为“待独立 Review 确认”，不构成 P0 通过。

> 说明：本轮收到的 Review 发现以**派发任务书**的七类阻断清单为准；磁盘上没有名为 Review 回执的文件（已在最终回执的 UNVERIFIED 段披露），因此本表只能给出“文件·章节”级别的核对结果，无法引用 Review 回执的具体行号。

### 1.4b P0 修复轮二（历史；仅文档）

写集：`01`、`02`、`04`、`05`、`09`、`10` 共 6 个文件（原地修订）；另经**用户显式授权**修订 `00-rebase-report.zh-CN.md` 的**实体计数句（L278）**；`07` §6 哈希表因写入而发生机械更新。**未写入**：`retrieval/**`、`compression/**`、`docs/migration/**`、`packages/**`、`08`（用户裁定）、lockfile、全局配置、fixture / gold / 评测结果。

本轮做了什么（对应任务书 1–8 项）：

1. **共享契约单一权威**：`scopeId` 唯一；`FactStatusV1` 唯一声明 = `01` §3.3；`PS.actions` 只留四位；`CM.supersedes = EntityRefV1 \| null`；`PointerRefV1` 保持退役；`SourcePointerV1` 的 `memory` scheme 是记忆来源指针的唯一表达。
2. **`RestoreTokenV1` 闭合**：字段名唯一为 `pointer`；runtime / evaluation **共用同一 schema**；`operationEpoch` / `evaluationRunId` 平面互斥（恰好一个非 null）；删除“评测 token 禁止 epoch”与“epoch 必填”的相反约束（CF-41）。
3. **T2 状态矩阵补齐**：`09` §3.1 改为 20 列统一矩阵（含 `PS` / `FR` / `RT` / `CMP`），旧 §3.2.3 分表删除。
4. **错误码与生命周期唯一**：折叠注册表（§3.2.2）封闭；`cg-wrong-dimension` 两线共用；`unconvertible` 只在压缩线折叠且用 `compression-pointer-unconvertible`；`timeout` / `cancelled` / `invalid_response` 永不折叠；CAR `failed` 唯一映射 = `assurance_unknown`（`01` §4.10 AU-8）。
5. **收编 Retrieval additive schema**：`InspectResultV1` 完整字段表（含 `workspaceId` / `pathNfc` / `symbol` / `generation` / `textHash` / `rangeExists` / `checks[]` / `inspectedAt`）入 `01` §4.4；`InspectCheckV1` 声明为共享 T3；`RK.gaps[]` 入 `01` §4.3（PK-9 / PK-10）；已删字段（`scopeId` / `snapshot` / `operationEpoch`）写明不得恢复。
6. **评测臂统一**：`04` §10 为唯一权威，`RET-A2` 唯一裁定，删去双定义与“待 Review”措辞。
7. **状态记录清理**：CF-09 / CF-15 / CF-25 / CF-31 更新；新增 CF-38…CF-41；重算 00 计数。
8. **`10` 条件重算**：仅当磁盘已闭合才保留 `satisfied`；条件 6–8 保持 partial。

本轮**没有**做：任何运行时代码改动；任何真实 provider / compaction / restore / promotion；任何评测长跑；任何 fixture / gold / KB / hash 冻结或回填；Task / Run 创建；commit / push。闸门行 `P0_REVIEW_BLOCKED` / `P0_EXIT_NOT_ALLOWED` / `STAGE_1_NOT_AUTHORIZED` 未变。

4 条未闭合项（CF-38…CF-41）在本轮**未被**本线应用（对方线写集）；它们已逐条给出“文件 + 章节 + 旧文 + 新文 + 机械验证命令”。

> 历史说明（修复轮一）：当时**完整 P0 Review 回执**不存在于磁盘；该轮的“已闭合 / 未闭合”判定均来自对磁盘的只读 `rg` / `Get-Content` 实测。当前已有轮十一专项回执和轮十二完整阻断回执，但二者均不能作为 P0 批准；命令与预期结果已写入 §2.1 的“验证证据”列。

### 1.4c P0 修复轮三（上一轮；仅文档）

写集：`01`、`04`、`05`、`09` 四个文件（原地修订，均为本线责任范围）；`10` 仅同步条件状态；`07` §6 哈希表因写入而机械更新。**未写入**：`retrieval/**`、`compression/**`、`docs/migration/**`、`packages/**`、`03`、`06`、`08`、lockfile、全局配置、fixture / gold / KB / 评测结果。

本轮处理（对应任务书 1–8 项）；前序条件是 Retrieval / Compression 第三轮已完成（15:46–15:54）：

1. **embeddingDim 语义冲突（CF-43 / 检索线 `X-11` / `R-BL-20`）**：`01` §4.2 由“整条候选是 `invalid_response`”改为“原生状态是 `wrong_dimension`，不得在 RC 层提前折叠；RK 折叠层才映射为 `invalid_response` + `cg-wrong-dimension`”。
2. **`unconvertible` × `IR` 冲突（CF-44 / 检索线 `X-10` / `R-BL-19`）**：从 `01` §3.3 折叠注册表与 `09` §3.2.2 的 `unconvertible` 行删除 `IR`；**没有**反向修改 §3.1 矩阵。
3. **`timeout` / `cancelled` 语义（CF-45 / 检索线 `X-9` / `SY-14`）**：`09` §3 的 `cancelled` 行删除“deadline / abort / 用户取消”混类描述，新增 7 行“唯一判定规则”表（自身 deadline → `timeout`；其余六类 → `cancelled` + 各自来源码）；`01` §3.3 与 `04` §6 同步；来源码所有权下放给各线文档（检索 `02` §3.5 / 压缩 manifest §10.1），共享契约不再枚举其成员。
4. **CF-39/40/41/42 状态重测**：四者均已在对方线第三轮闭合（命令与实测见 §2.1 的“跨线闭合验证”表）；本轮**未**提前标记，而是在实测后才改写。
5. **陈旧记录清理**：CF-09 / CF-15 / CF-25 / CF-31 保持已闭合；`scopeKey` 旧计数标为**历史陈旧记录**；新增 CF-43…CF-45 并全部标已闭合。
6. **证据条件保持未完成**：`10` 的条件 6 / 7 / 8 保持 `partial`；未新增任何 `satisfied`。
7. **独立复审标记**：`10` §0 新增本轮“已提交独立复审”状态位；四个闸门行原样保留。

本轮**没有**做：任何运行时代码改动；真实 provider / compaction / restore / promotion；评测长跑；fixture / gold / KB / hash 冻结或回填；Task / Run 创建；commit / push。

本轮遗留（本线不可自行闭合）：(a) ~~**CF-46 / CF-47**~~ → **已于轮五由压缩线闭合**（见 §1.4e）；(b) 检索线 `04` §2 L46 陈旧指针（`X-14`，需检索线授权扩展写集）；(c) CF-20 名称/schemaId 与 CF-23 编号裁定已落盘；(d) `10` 条件 6–8 的证据缺口（需 Host 轨道与真 fixture）。

### 1.4d P0 状态同步轮四（历史；仅文档）

写集：`05`、`10`（状态同步）；`01`、`04`、`09` 本轮**未改**（旧语义未重现，已逐条验证）；`07` §6 哈希表因写入而机械更新。**未写入**：`retrieval/**`、`compression/**`、`docs/migration/**`、`packages/**`、`00`、`02`、`03`、`06`、`08`、lockfile、全局配置、fixture / gold / KB / 评测结果。

本轮做了什么：

1. **先读盘再同步**：确认压缩线最后写入 = 15:47:40、检索线 = 15:54:04，**均早于**本轮读取（16:10），因此 CF-46 / CF-47 的开放不是“读数过期”。
2. **CF-46 维持开放**：`compression/context-unit-manifest-v1` **L516** 仍写 `SP / IR / RC / RK / OBS / ERM / PCR`；**新采集反证**：同文 **L505** 已写“只属 SP / OBS / RC / RK 层”——压缩线**自相矛盾**，不只是跨文件不一致。
3. **CF-47 维持开放**：同文 **L495** 仍写“上层取消（abort）而非 deadline”；且 `rg -n 'compression-[a-z-]*(timeout|deadline-exceeded)' compression` = **0**（`timeout` 来源码未登记，状态不可区分）。**本线不代为命名**新码。
4. **CF-39/40/41/42 逐条重测磁盘**后确认已闭合（未凭对方线回报而信）；证据已补上具体行号（`02:360`、`107/121`、`308/309/318/602`、`03:58/59/72–75`）。
5. **修正上一轮自身错误**：上轮把 **CF-23** 误列入“本轮新闭合”。实为 `FI-20.1` 子用例就位；CF-23 已裁定继续使用该子用例，不新增全局 FI-28。
6. **修正上一轮自身错误**：上轮 `活冲突残留` 标题曾写“共享契约层面无未闭合 schema 冲突”，与 CF-46 / CF-47 矛盾——已改为“共享契约自身无冲突，但消费方文档仍有 2 条”（→ 条件 3 必须保持 `partial`）。
7. **机械检查自引污染修正**：避免把登记表/本表自身的引用文字当作命中（命令限定到契约文件或明确排除自身）。
8. **证据条件不动**：`10` 的条件 6 / 7 / 8 保持 `partial`；未新增任何 `satisfied`。

本轮**没有**做：任何运行时代码改动；真实 provider / compaction / restore / promotion；评测长跑；fixture / gold / KB / hash 冻结或回填；Task / Run 创建；commit / push；替用户定名或编号。

> **重要事件（轮四期间发生）**：本线于 16:10 读取时 CF-46 / CF-47 仍开放；**压缩线在 16:21–16:24 写入**并闭合了这两项（本线轮四的判定当时正确，但已被轮五重测覆盖）。事件顺序与依据见 §1.4e。

### 1.4e P0 状态同步轮五（本轮；仅文档）

写集：**`05`、`09`、`10`** 三个文件（状态同步 + 修正本线陈旧断言）；`07` §6 哈希表因写入而机械更新。**本轮未改** `01` / `04`（其哈希与轮三一致：`01` = `276c2b164ed53b3b`、`04` = `5898985918c70197`，可机械核验），也**未写入** `retrieval/**`、`compression/**`、`docs/migration/**`、`packages/**`、`00`、`02`、`03`、`06`、`08`、lockfile、全局配置、fixture / gold / KB / 评测结果。

**关键事实（时间线；可复核磁盘 mtime）**：

| 时刻 | 事件 | 证据 |
| --- | --- | --- |
| 15:47:40 | 压缩线上一轮（第三轮）最后写入 | mtime |
| ~16:10 | 本线轮四读取：CF-46 / CF-47 **开放**（当时截图：`L516` = `SP / IR / RC…`；`L495` = “上层取消（abort）而非 deadline”） | 轮四回执 |
| **16:21:54 – 16:24:41** | **压缩线第四轮写入**（四个文件）；CF-46 / CF-47 已应用 | mtime + 实测命令归 0 |
| 16:25 – 16:35 | 本线轮五重测：CF-46 / CF-47 **闭合**；并新发现 CF-48 / CF-49 | 本节及 §2.1 |

本轮做了什么：

1. **CF-46 重测 → 闭合**：`compression/context-unit-manifest-v1` **L506**（适用性表）与 **L517**（§10.1 折叠表）均已写“**不含 `IR`**”，原生层统一为 SP / RC / RK / OBS / ERM / PCR；`rg -n 'SP / IR / RC' compression` = **0**。
2. **CF-47 重测 → 闭合**：同文新增 **L495 `timeout` 行**（码 `compression-deadline-exceeded`）、改写 **L496 `cancelled` 行**（六类触发）；§10.1 新增 **FD-5 唯一判定表 L531–542**，登记 `timeout` + 六个 `cancelled` 来源码，并显式作废旧表述（**L542**）。`rg -n '而非 deadline' compression` = **0**。
3. **逐行比对压缩线 FD-5 与 `09` §3 判定表**：七行**逐行对应**（自身 deadline / caller / 上层父级 deadline / operation / epoch fence / 预算 / early stop），无成员遗漏，也没有多出共享契约未承认的状态。
4. **修正本线自身陈旧断言**：`09` 唯一判定规则表的 `timeout` 行曾写“压缩线尚未登记 `timeout` 来源码”——已改为两线实际码并加注失效声明；同时把 `*-` 占位写法改为**逐项实际码**（与两线登记表可机械对齐）。
5. **历史快照（状态同步轮五，2026-10-09 16:25–16:35）**：当时发现 CF-48（检索线内部矛盾）：`retrieval/02` **L513** 的 decoder 负例 N-25 把**活跃码** `retrieval-cancelled-by-deadline` 列为“已移除”；该轮判定为开放。后续检索线已修复，当前已闭合。
6. **历史快照（状态同步轮五，2026-10-09 16:25–16:35）**：当时发现 CF-49（引用错位）：`retrieval/02` **L159 / L168 / L216** 引“`09` §3.2.2 **line 395**”。后续检索线已改正三处引用，当前已闭合；事件记录保留供审计。
7. **回归重测**：压缩线 16:21–16:24 的写入**未**回退 CF-38 / CF-39 / CF-40 / CF-41 / CF-42（逐条命令均仍归位）。
8. **证据条件不动**：`10` 的条件 6 / 7 / 8 保持 `partial`；未新增任何“证据类” `satisfied`。

本轮**没有**做：任何运行时代码改动；真实 provider / compaction / restore / promotion；评测长跑；fixture / gold / KB / hash 冻结或回填；Task / Run 创建；commit / push；修改 retrieval / compression 任何文件；替用户定名或编号。

## 2. 三条线的目录冲突地图

### 2.0 P0 期间三线写集（依据 `08` §4）

| 线 | P0 允许写入 | 与本线的关系 |
| --- | --- | --- |
| Implementation（本线） | `implementation/00–10` | — |
| Retrieval | `retrieval/01–12`（SemanticProvider 契约、Retrieval schema、generation/index、Inspect/freshness、candidate pipeline、fallback、Search→Fetch→Evidence、privacy/egress、readiness fixtures、evaluation matrix、legacy worker migration、blockers/unverified） | 其 `retrieval/02-retrieval-schema` 与本线 `01`/`09` 的 RP/RC/RK 同名；其 legacy worker migration 负责 `docs/migration/**` 的 P8/P9/P10 更正（本线只在 `07` §3.1 记录 erratum） |
| Compression & Memory | `context-unit-manifest-v1` / `compression-decision-chain-v1` / `compression-memory-evaluation-matrix-v1` / `compression-memory-legacy-migration` | 与本线 `01`/`09` 的 CU/CM/CJ/CDQ/CDR/CAR 同名；`05` 建议放入 `context-governance/compression/` 子目录（不具约束力）；P0 离场条件 4（exact/protected 确定性识别规则）由该线补齐（`10` §1） |

共同排除项（`08` §4）：`packages/**`、Worker 候选、`D:\MyHarness\**`、Provider 配置、lockfile、gold、分母、旧 run 目录、全局配置。

| 目录 / 文件 | 写入者 | 状态 | 冲突风险 |
| --- | --- | --- | --- |
| `context-governance/implementation/**` | Implementation（本线） | 重新基线轮 8 个 + P0 文档轮 3 个 = 共 11 个文件（`00`–`10`）；修复轮在 9 个文件上原地修订 | 无 |
| `context-governance/retrieval/**`（`00`–`12`，13 个文件） | Retrieval | 全部已写 | 其 `02-retrieval-schema` 与本线 `01` 的 RP / RC / RK 同名实体；`02` §3.1 的第二套 `FactStatusV1` 声明与 `RetrievalFactStatusV1` 已按 CF-08 作废，待检索线同步 |
| `context-governance/compression-memory-rebase-report.zh-CN.md`（根目录）与 `context-governance/compression/**`（4 个文件：`context-unit-manifest-v1`、`compression-decision-chain-v1`、`compression-memory-evaluation-matrix-v1`、`compression-memory-legacy-migration`） | Compression & Memory | 已写；4 个契约 / 矩阵文件位于 `compression/` 子目录，与 `retrieval/`、`implementation/` 对称（修复轮更正旧表述） | 与本线 `01` 的 CU / CM / CJ / CDQ / CDR / CAR 同名实体；矩阵与决策链中的字段 / 编号需按 §2.1 登记同步 |
| `docs/architecture/pactile-dual-product-architecture-design.zh-CN.md` | 架构文档（共享） | 本轮未改 | 三线都可能提出修订；须由一方合并 |
| `docs/migration/**` | 旧迁移记录（共享） | 本轮未改 | 两线拟更正桶名映射 / 增加状态行 |

**优先级规则（拟议）**：共用外壳、身份平面、一等状态与跨线不变量以 `implementation/01` 为准；各实体的**详细字段表与示例**以所属线的文档为准；两者冲突时回到评审，不得各自继续。

**建议（修复轮更新）**：Compression 线已把 4 个契约 / 矩阵文件放入 `context-governance/compression/` 子目录（仅报告留在根目录），建议得到落实，无需再确认。

### 2.1 跨线冲突登记表（P0 修复轮）

字段：冲突 ID · 文件与章节 · 左侧定义 · 右侧定义 · 影响的实体 / 状态 / 评测 · canonical owner · 裁定 · 需要同步的文档 · 是否仍阻断 P0 · 验证证据。

**读法**：`裁定` 列是本轮作为 Implementation Controller / 共享契约整合者给出的裁定，**全部需要独立 Reviewer 确认**；`是否仍阻断 P0` 指的是“是否还阻断 P0 离场”，不是指本表已通过。跨线同步项由对方线在自己的写集内完成，本线不改它们的文件。

| 冲突 ID | 文件与章节 | 左侧定义 | 右侧定义 | 影响 | owner | 裁定 | 需要同步的文档 | 仍阻断 P0 | 验证证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CF-01 | `09` §0 vs §1 | “17 个实体（12+5）” | 登记表 19 行 | 实体登记、AC-0.1 | Implementation | T1=12 / T2=9 / 登记 21 行；四层分类（`09` §1.1） | `01` §1、`03` AC-0.1、`10` §2（本轮已改）；`00` §2（待同步，见 CF-31） | 否（已裁定） | `09` §1.1；`09` §1 数据行 = 21 |
| CF-02 | `01` §4.5 vs `09` §2.4（Compression 文档 §4.2 记录） | `class ∈ {exact_required, protected, pointer_only, compressible, unknown}` | `protection ∈ {exact, protected, maskable, externalizable, lossy_eligible}` | CU、CM、CJ、CDQ、CAR、评测矩阵 | Implementation | 唯一枚举 = `01` §4.5 五值；动作许可移入 `PS.actions`（`09` §1.2.1） | `09` §2.4（已改）；`compression/context-unit-manifest-v1` §4/§4.2（**已同步**：五值 class；动作许可 = `actions.{mask,externalize,structuredProject,lossy}`，旧名已删） | 否（条件 4 仍 partial，待 Reviewer 确认） | `09` §2.4 CU 行；负例 #18 |
| CF-03 | compression `compression-decision-chain-v1` §S2/§7.1 vs `09` §1 | `PermissionSetV1`（未定义名） | `PermissionScopeV1`（PS） | CU 权限、CAR check #5、CDQ | Compression | 只保留 `PermissionScopeV1`；`PermissionSetV1` 作废 | compression 决策链 §S2 / §7.1、manifest §4.1 SP-5（**已同步**：`PermissionSetV1` 已废止） | 否（已裁定） | `09` §1.2.1；负例 #18 / #12 |
| CF-04 | `09` §2.4 / 检索线 `02` §2 / compression §4.1 | PS 三套形状（`{readable,withinScope,scopeId}` / `readScopes+maxClassification` / `scopeKey+布尔位`） | 同一实体三个字段集 | PS、IR、CU、CM、RP、CJ、PCS | Implementation | 唯一形状 = `09` §1.2.1；旧写法按映射表读入，不可写回 | 检索线 `01`/`02`/`04`/`05`/`06`/`08`（引用改）、compression §4.1/§7.2/§8.4（**已同步**：唯一形状；旧布尔名已删除） | 否（已裁定） | `09` §1.2.1 映射规则 4 |
| CF-05 | `01` §4.10 / `04` §8 vs compression 决策链 §7.1 | CAR 10 项 check | CAR 17 项 check | CAR、指标、fixture | Implementation | 取 17 项；10→17 映射见 `01` §4.10 AU-7 | 决策链 §7.5（其“待回填”已完成）、`04` §8（已改） | 否（已裁定） | `01` §4.10；`04` §8 |
| CF-06 | `01` §4.10/§4.9 vs 决策链 §7.4 | CAR verdict 6 项 | CAR verdict 7 项（+`review_required`） | CAR、CDR、CDQ | Implementation | 两个枚举均含 `review_required`，但不互换；允许值见 `01` §4.10 | 决策链 §7.4/§7.4.1、`09` §2.4（**已同步**：7 值 verdict + lifecycle/verdict/`review_required` 三关系 + CDR 两轴分离声明） | 否（已裁定） | `01` §4.10 verdict；`09` §2.4 表下注 |
| CF-07 | `10` 条件 5（未定义） vs 决策链 §S5 | 人工/Kernel 审批落点未定义 | “approval_request → waiting → 新 admission” | `review_required`、CDQ/CDR/CAR | Implementation + Kernel/Host | 契约级落点 = `01` §4.14；机制属 BL-05 | `04` §6（已改）；Kernel/Host 轨道 | 否（条件 5 保持 partial，不标 satisfied） | `01` §4.14 |
| CF-08 | 检索线 `02` §3.1/§3.2 vs `01` §3.3 | 第二套 `FactStatusV1`（11 成员）+ `RetrievalFactStatusV1` | 唯一 `FactStatusV1`（15 成员） | 全体状态消费方 | Implementation | `01` §3.3 唯一；第二套声明作废 | 检索线 `02` §3.1/§3.2、`12` R-BL-01（待同步） | 否（已裁定） | `01` §3.3 唯一来源段；`09` §3 开头 |
| CF-09 | `01` §4.6 vs compression §8.2（SYNC-02） | **修复轮裁定**：`supersedes: EntityRefV1 \| null`（含 schemaId/version/bodyHash；`supersedes.bodyHash` 必须等于前驱 `manifestHash`） | **修复前**：Compression 仍写 `string \| null`（引用的仍是 `01` §4.6 修订前的写法）并留 SYNC-02；**本轮已按本裁定同步** | CM、CMP、CAR #16、链完整性 | Implementation | **裁定 `EntityRefV1`**（理由：链校验需要 schema 身份 + `bodyHash`；合约内其他跨实体引用均为 `EntityRefV1`）；**已记入 `01` §4.6**。若 Review 逆转为 `string`，必须同时改回 `01` §4.6、并补一份 out-of-band schema 身份校验，否则不得执行 | `01` §4.6（已改）；compression §8.1/§8.2（**已同步为 `EntityRefV1 \| null`**，含 `bodyHash === 前驱 manifestHash` + `provenance.derivedFrom` 不变量） | **否（已闭合）**：compression 于 2026-10-09 本轮修复完成；`rg -n 'supersedes: string' .../compression` = 0 | `01` §4.6 不变量；compression §8.1/§8.2 |
| CF-10 | compression §8.1 vs `09` §2.4 | `permissionsSummary` 作为 CM 字段 | CM 权限 = “随单元并集” | CM、权限判据 | Implementation | 不是规范字段；若保留只能作只读聚合且不得作权限判据 | compression §8.1（**已同步**：`permissionsSummary` 已标为删除） | 否（已裁定） | `01` §4.6 不变量；负例 #27 |
| CF-11 | compression §8.1 vs `01` §3.6 | `basisManifestRef` 字段 | `provenance.derivedFrom` | CM、链完整性 | Implementation | 拒绝 `basisManifestRef`；由 `derivedFrom` + `supersedes` 承担 | compression §8.1（**已同步**：`basisManifestRef` 已标为删除） | 否（已裁定） | `01` §4.6 不变量 |
| CF-12 | `01` §4.4 IR vs `09` §4 | `IR.fileHashRaw` | `CU.sourceHash`（旧 `09` 称 source hash） | IR、CU、CAR #6、fence | Implementation | 同概念、不同字段名；不互换；不等 ⇒ `invalid_response` | 检索线 `02` §9#11（同样验） | 否（已裁定） | `09` §4 source hash 行 |
| CF-13 | `01` §4.5 vs compression §4 | `reopenable` | `recoverability` | CU、动作准入 | Implementation | 只留 `recoverability`；`reopenable` 为派生谓词 | compression §4/§7.4（**已同步**：字段只定义一次；类型定义指向 `01` §3.6）；`01` §4.5（已改） | 否（已裁定） | `01` §4.5 不变量 |
| CF-14 | compression §4/§8.1 | `ruleSetVersion` 只在 compression 文档 | 未入共享契约 | CU、CM、policyVersion、hash | Implementation | 入共享契约；更 `ruleSetVersion` 必须伴随新 `policyVersion` | `01` §4.5/§4.6（已改）；compression §4/§8.1（**已核对一致**） | 否（已裁定） | `01` §4.5 protection 块 |
| CF-15 | compression 旧字段名 vs 检索线 `02` §2 | `scopeKey` | `scopeId` | PS、RT、CMP、PCS | Implementation | `scopeId` 唯一 | compression §4.1/§7.2/§8.4（**已同步：本目录 `scopeKey` = 0**）；检索线 `02` §2（已用 `scopeId`） | **部分（残余，已不在 compression）**：残留旧名仅在 (a) `docs/migration/batch-2-context-compaction-memory.zh-CN.md` L116/L120（legacy 兼容描述）、(b) `docs/development/pi-agent-review-prompts.zh-CN.md` L18（兼容检查项）、(c) 运行时 host-neutral durability port 仍保留旧自由 `scopeKey` 以支持历史调用——三项均超出 compression 写集 | `09` §1.2.1 规则 3；`rg -n 'scopeKey' docs/architecture/context-governance/compression` = 0 |
| CF-16 | `01` §4.5 vs compression §8.1 | `cursor`（无 entryIds） | `transcriptCursor`（含 entryIds） | CU、CM、CAR #1 | Implementation | 统一 `TranscriptCursorV1`；CU.cursor 必须落在 CM 范围内 | compression §8.1（**已同步**：`TranscriptCursorV1` 已采用） | 否（已裁定） | `09` §1.2.5 TranscriptCursorV1 行 |
| CF-17 | compression §7.1/§7.2 vs `01` §4.4 | `PointerRefV1`（含 `scheme:"memory"`） | `SourcePointerV1`（4 schemes） | SP、CU、CM、memory.read | Implementation | `PointerRefV1` 退役；SP 新增 `memory` scheme（新 scheme 不得参与 ABI 转换） | compression §7.1/§7.2、决策链 S10（**已同步**：无 `PointerRefV1` 活用法；`memory` scheme 明写不参与 ABI 转换）；`01` §4.4（已改） | 否（已裁定） | `01` §4.4 规则段；负例 #22 |
| CF-18 | compression §7.2/§8.4 vs `09` §1 | `RestoreTokenV1` / `CurrentManifestPointerV1` 未登记 | 登记表无行 | 登记、AC-0.1 | Implementation | 升级为 T2（`09` §1.2.3/§1.2.4） | compression §1/§12（**已同步**：§12.1 登记表已标 T2 + Owner） | 否（已裁定） | `09` §1 数据行 21；§1.2 T2 表 |
| CF-19 | compression §6.1 | `AnchorKind` 无独立类型 | 22 个成员的内联枚举 | CU.protection、CM、CAR #2/#3 | Compression（内容）+ Implementation（归类） | T3 内联；由 `protection.ruleSetVersion` 版本化，不由 schema 版本化 | compression §6.1 已补“版本化方式”行（**已同步**） | 否（条件 4 仍 partial） | `01` §3.6 AnchorKind；`09` §1.2.5 |
| CF-20 | 检索线 `01`/`03`/`07`/`08`/`09` + compression 决策链 vs `09` §1 | 16 个线内 `schemaId`（+2 提案无 id） | 未登记 | 跨线引用、decoder | Implementation | 登记为 T4（`09` §1.3）；跨线引用前必须升级为 T2 | 各线自行确认归属；`DisclosureRecordV1` / `MemoryReadRecordV1` 已裁定并登记 schemaId；最小 runtime bridge 已生成 Artifact 并绑定 RunLedger Context Operation，完整失败/并发/crash-replay 证据仍开放 | 否（命名/schemaId 裁定已闭合；真实 RunLedger 产物与证据仍开放） | `09` §1.3 表 16 行 |
| CF-21 | `09` §3.1 vs retrieval `02` §3.2 ST-2 | RK `wrong_dimension` = `—`（不可表示） | RK 类型 `status: FactStatusV1`（包含它） | RK、FI-02、KB-6 | Implementation | 按 `09` §3 折叠：RK 的 `coverage[].status` / `rejected[].status` 用 `Exclude<FactStatusV1, "wrong_dimension">`（`01` §4.3 PK-7） | 检索线 `02` §3.2/§3.3、`10` FQ-16（兼容） | 否（已裁定） | `01` §4.3 PK-7/8；`09` §3.2.2 |
| CF-22 | `04` §6 FI-01 vs FI-27 | FI-01 预期 `stale` | FI-27 预期 `generation_mismatch`；两者描述重叠 | 故障注入、阶段 1a/2 | Implementation | 差异化为“静态旧 generation” vs “运行中漂移”，两者预期均为 `generation_mismatch`；`stale` 仅属 FI-08 | `04` §6（已改）；检索线 `10` §5 FQ-13/FQ-14 映射建议更新 | 否（已裁定） | `04` §6 FI-01 / FI-27 行；`09` §3 关系表 |
| CF-23 | `04` §6 / 检索线 `04` §8 / 负例 #22 | `unconvertible` 无 FI 归属 | 不得新增全局编号 | 阶段 1a 断言、指标 | Implementation | 归属 = FI-20 子用例 `FI-20.1`；不新增全局 FI-28，继续使用 FI-20.1 子用例 | 检索线 `10` §5 映射表、`04` §8；`04` §6（已改） | 否（编号裁定已闭合；真实 fixture/ERM 等证据仍开放） | `04` §6 FI-20.1 行；`01` §7 #22 |
| CF-24 | compression 矩阵 §6.3/§9 vs `03` §1.2 | `ZT-1…ZT-10`（无前缀） | CG 级零容忍清单（无编号） | 零容忍、阶段 fail 判据 | Implementation | 线内计数器必须带线内前缀（`ZT-CM-*`）；CG 清单为权威归并表 | compression 矩阵 §6.3（待同步）；`03` §1.2（已加说明） | 否（已裁定） | `03` §1.2 说明段 |
| CF-25 | `04` §10 vs 检索线 `10` §4/§10 | “A2 = A1 + Jev” | “A2 = Jev plan shadow + exact + structural” | 阶段 2/3 评测臂 | Implementation（权威裁定） | 命名空间化 `RET-A0…A3` / `CMP-A0…A5`；**`RET-A2` = Jev plan shadow + exact + structural（semantic 关闭）**，旧提案作废并降为可选 `RET-A3`；`04` §10 是唯一权威 | 检索线 `10` §4 AR-1 / AR-1b（**已同步**）、`12` `R-BL-03`（**已闭合**）；`04` §10（本轮已改，去双定义与“待 Review”措辞） | **否（已闭合）** | `04` §10 臂段；`rg -n 'A2 = A1 \+ Jev' docs` 仅应出现在“已作废”上下文 |
| CF-26 | `04` §4.4 / 检索线 `10` §1 / compression 矩阵 §3 | 伞形类别（10 类） | 线内 `FQ-*` / `CM-B*` | EC.category、分母 | Implementation | 三层不互换：伞形 = `EC.category`；线内 = line registry；线内编号不得写入 category | 各线保持（无需改） | 否（已裁定） | `04` §4.4 命名层次注 |
| CF-27 | `01` §2 ISO-2 vs `04` §6 FI-07/FI-16 | 评测实体禁止 `operationEpoch` | FI-07/FI-16 需仿真旧 epoch | EC/ERM/PCR、epoch fence | Implementation | 仿真 epoch 由 fake 端口 / fixture 内部记录承载，不写入评测实体 | `04` §6 末段（已改）；`01` §3.3（已加说明） | 否（已裁定） | `04` §6 末段；`01` §3.3 |
| CF-28 | 检索线 `12` §5 AC-0.1 vs `09` §1/§3 | “12 个实体 / 10 个非 ok 状态” | T1 12 + T2 9 / 14 非 ok | 检索线 P0 自检 | Retrieval | 按 `09` §1.1/§3 更新计数 | 检索线 `12` §5（待同步） | 否（已裁定） | `09` §1.1 / §3 |
| CF-29 | `06` §1 BL-01 行 vs `06` §1.1 | “三线尚未全部返回 READY_FOR_P0” | “已解除（`08` §2.6）” | 阻断清单一致性 | Implementation | BL-01 标为已解除；§1 保留历史快照 | `06` §1（本轮已改） | 否 | `06` §1 BL-01 行 |
| CF-30 | `05` §1.1/§2.0/§2.2/§7 vs 目录实况 | “本轮已写 8 个文件”；Compression 文档在根目录 | `implementation/` 11 个；compression 4 个在 `compression/` 子目录 | 写集地图 | Implementation | 按实况更正（§1.1–§1.4 / §2.0 / §2.2 / §7） | `05`（本轮已改） | 否 | `Get-ChildItem` 输出（§7） |
| CF-31 | `00` §2/§7/§10 vs 实况 | “01 的 12 个实体”；BL-01 未解除；`READY_FOR_P0` 待定 | `09` §1.1 的 21 登记项（T1 12 + T2 9）；`08` §2.6 已解除 | 本线文档一致性 | Implementation | **用户授权后本轮已同步 `00` L278**（“12 个实体” → “T1 12 + T2 9 = 21 登记项”）；`00` 其余历史结论不改 | `00`（本轮已改，仅计数句） | **否（已闭合）** | `rg -n '12 个实体' implementation/00-*` 应为 0 |
| CF-32 | `05` §3.1 / `06` BL-18 vs 实测 | 42 个文档缺 source map（10 个在 CG）；本线 8 个 | 62 个缺（30 个在 CG：implementation 11 / retrieval 13 / compression 4 / root 2）；32 个既有 | 文档门禁 | Implementation / 用户 | 按实测更新数字；三类失败与两个 drift / digest 值不变 | `06` BL-18（本轮已改）；`05` §3.1（已改） | 否（BL-18 不阻断 P0 文档） | `check-pactile-brand-surface` 只读输出（exit=1） |
| CF-33 | `04` §8 vs `01` §4.10 | post-audit 10 项 check id | 17 项 | 指标、fixture | Implementation | 按 17 项更新 | `04` §8（本轮已改） | 否 | `04` §8 post-audit 行 |
| CF-34 | `01` §1 vs `09` §1 | 支撑类型 7 项列表 | T2 9 项（含 PS / FR / RT / CMP） | 契约完整性 | Implementation | `01` §1 改为指向 `09` §1.1–§1.3 | `01` §1（本轮已改） | 否 | `01` §1 支撑类型段 |
| CF-35 | `01` §4.1 RP.egress / `01` §3.6 PCS.egress / compression `egressClass` / 检索线 `08` | 4 种外发形状（`remoteAllowed` / `{destination,authorized,authorizationRef}` / `egressClass` / `EgressAuthorizationV1`） | 同一授权语义 | RP、PCS、PS、egress、零容忍 | Implementation | 统一对象形状 = `{destination, authorized, authorizationRef}`；`remoteAllowed` 仅是计划意图，必须受 `authorized` 约束 | 检索线 `01`/`08`（对外发对象加引用）；compression §4.1（`egressClass` 映射） | 否（已裁定） | `09` §1.2.1 PS.egress；`02` F-13 |
| CF-36 | 检索线 `02` §8 SY-1/SY-8 vs `01`/`09` | 请求 `01` 同步 4 状态与 PS/FR | 本轮已完成同步 | 契约一致性 | Implementation | SY-1 / SY-8 可关闭；SY-2/SY-3/SY-4（IR 扩展、RK gaps、Egress 类型）仍开放 | 检索线 `02` §8、`12` R-BL-01/R-BL-02/R-BL-11（待更新） | 否（部分开放） | `01` §3.3；`09` §1.2.1/§1.2.2 |
| CF-37 | `09` §2 矩阵 vs 新增 T2 类型 | §2.1–§2.4 无 RT/CMP 行 | 新增 T2 类型 | 矩阵完整性 | Implementation | RT/CMP 已补入 §2.1–§2.4；§3.1 已并入 PS/FR/RT/CMP 四列（§3.2.3 分表已删除） | `09`（本轮已改） | 否 | `09` §1 数据行 21；`09` §3.1 表头 20 列 |
| CF-38 | 检索线 `02` §3.1 L91 vs `01` §3.3 | `type FactStatusV1 = /* 见 01 §3.3 */ unknown;`（占位声明，仍是本地声明） | `01` §3.3 是唯一类型声明；其他文档只能引用或写 `Exclude<…>` 子集 | 单一权威；条件 3 | Implementation（裁定） + Retrieval（执行） | 删除本地声明；`01` §3.3 / `09` §6 负例 #29 已把它列为缺陷 | 检索线 `02` §3.1（**已应用**）；`12` `R-BL-01` | **否（已闭合）** | `rg -n 'type FactStatusV1' .../retrieval` = **0**（15:56 实测） |
| CF-39 | 检索线 `02` §5.2 vs `01` §4.4 | 检索线曾自持一份 `InspectResultV1` / `InspectCheckV1` 声明体，并写明“本文件为字段表 Owner”、“上表 `id` 封闭枚举是检查项的唯一来源”（旧 `retrieval/02` L377 / L385 / L403 / L408） | `01` §4.4 现在是唯一完整字段表与 `id` 枚举唯一来源（修复轮二收编） | IR、`InspectCheckV1`、条件 2、decoder | Implementation（已收编） + Retrieval（已删重） | 检索线 §5.2 已改为**只引用**：删除两个 `interface` 声明体与 Owner 声明，改为指向 `01` §4.4 | 检索线 `02` §5.2 L360（**已应用**）；`12` `R-BL-27`；残余：检索线 `04` §2 line 46 仍写“id 枚举的唯一来源为 `02` §5.2”（其 `X-14`，**不在其本轮写集**） | **否（主冲突已闭合）**；残余指针 `X-14` 不构成共享契约双权威（它指向一份不再声明字段表的小节） | `rg -n 'interface Inspect(Result\|Check)V1' .../retrieval` = **0 声明体**（仅 `02:360` 与 `12:75` 的“不声明”说明文字；15:56 实测）；`02:360` 已写明“本文件不声明、不持有 Owner” |
| CF-40 | compression `context-unit-manifest-v1` §4.1 vs 同文 SP-4b | 曾声明第五个许可位 `promotionRecommendation: boolean` | SP-4b 已写“动作许可位只有四个” | PS、CU、CDQ、阶段 7 | Implementation（裁定） + Compression（已执行） | 删除 schema 块中的 `promotionRecommendation`（只留 `mask` / `externalize` / `structuredProject` / `lossy`）；memory promotion 属 Kernel command，不由 PS 表达 | compression §4.1（**已应用**）；§4.2.2 #2 / §11 #18c 把第五个键列为 decode 失败；`09` §1.2.1 / `01` §3.6（已改） | **否（已闭合）** | `rg -n '^\s+.*promotionRecommendation' .../compression` = **0 字段声明**（剩余 4 处均为“不得出现”的禁令文本：manifest L121/L156/L547、矩阵 L229；10:00 前实测） |
| CF-41 | `09` §1.2.3 vs ISO-2 / compression §7.2 | 旧文写“评测实体禁止携带 `operationEpoch`”，但 RT schema 要求 `operationEpoch: number` | 矛盾：两者不能同时成立 | RT、evaluation 平面、条件 2 | Implementation（裁定） + Compression（已执行） | 唯一规则 = RT 单一 schema + 平面互斥（`operationEpoch: number \| null`、`evaluationRunId: string \| null`，恰好一个非 null）；见 `09` §1.2.3 | `09` §1.2.3 / `01` §3.6（已改）；compression §7.2 L308–309（**已应用**：两个可空字段 + RT-1…RT-5 规则段） | **否（已闭合）** | compression manifest `RestoreTokenV1` 块 L308 / L309 同时含两个字段；`rg -n 'operationEpoch: number \| null' .../compression` ≥1 |
| CF-42 | 检索线 `03` §I 行 `supersedes: string \| null`（`SemanticGenerationV1`） vs `01` §4.6 / `09` §1.2.4 | 同一字段名 `supersedes` 在 CM 上是 `EntityRefV1 \| null`，在 generation 链上是 `string \| null` | 字段名同名异义；链校验代码会把二者混淆 | CM、CMP、generation 链、CAR #16 | Implementation（裁定） + Retrieval（已执行） | `supersedes` 字段名**保留给 CM/CMP 链**（`EntityRefV1 \| null`）；generation 链改名为 `previousGenerationId` / `nextGenerationId` | 检索线 `03` §1.1 L58（**已应用**）；`02` `SY-16`、`12` `R-BL-28`、`03` LG-1/LG-4/MAN-2b（命名隔离规则） | **否（已闭合）** | `rg -n 'supersedes: string' .../retrieval` = **0**（15:56 实测）；`rg -n 'previousGenerationId' .../retrieval/03` ≥1 |
| CF-43 | `01` §4.2 vs `09` §3.1 / §3.2.2（检索线 `X-11` / `R-BL-20`） | `01` 写“`semantic.embeddingDim` 不一致 → **整个候选是 `invalid_response`**” | `09` §3.1 矩阵 RC × `wrong_dimension` = ✓，RC 属原生承载层 | RC、RK、PCS、条件 3、decoder | Implementation（本轮已修） | 原生层（RC / PCS / RP / OBS / ERM / PCR）保留 `wrong_dimension`；只有 RK 折叠层折叠为 `invalid_response` + `cg-wrong-dimension` | `01` §4.2 L401（**已改**）；`09` §5 新增第 27 条、§6 负例 #31；`04` §6 L153 / L183（已一致） | **否（已闭合）** | `01:401` 含“原生状态是 `wrong_dimension`”且含“只发生在 RK 层”；`rg -n '否则整个候选是' .../implementation` = 0 |
| CF-44 | `09` §3.2.2 vs §3.1 矩阵（检索线 `X-10` / `R-BL-19`） | §3.2.2 的 `unconvertible` 行把 `IR` 列入原生承载层 | §3.1 矩阵 IR × `unconvertible` = `—` | IR、SP、decoder | Implementation（本轮已修） | 从 §3.2.2 删除 `IR`（原生层 = SP / RC / RK / OBS / ERM / PCR）；矩阵为权威，不得反向修改 | `09` §3.2.2 L401、§5 第 28 条、§6 负例 #32（**已改**）；`01` §3.3 折叠注册表 L118（已改） | **否（已闭合）** | `rg -n 'SP、IR、RC' .../implementation` = 0；`09:401` 含“`IR` 不在其中” |
| CF-45 | `09` §3 vs `01` §3.3 / 检索线 `02` §3.4（`X-9` / `R-BL-19` / `SY-14`） | `09` §3 的 `cancelled` 行把 deadline / abort / 用户取消混为一类 | `01` §3.3 与检索线 `TC-1` / `TC-10`：仅**自身** deadline 到期 = `timeout`；上层 / 父级 deadline 触发的 abort = `cancelled` | 全体状态消费方、取消上界统计、条件 3 | Implementation（本轮已修） | 删除混类描述；新增“唯一判定规则”表（7 行触发 → status + 来源码）；来源码所有权下放各线文档 | `09` §3 L327 / L345、§3.2.2 L393、§5 第 29 条、§6 负例 #33（**已改**）；`01` §3.3 L120 / L137–138 / L121；`04` §6 L177 / L183（已改）；检索线 `02` `SY-14` 可关闭 | **否（本侧已闭合）** | `rg -n '被调用方或上层取消' .../implementation` = 0；`09:345` 为“唯一判定规则”表 |
| CF-46 | compression `context-unit-manifest-v1` §10 / §10.1 vs `09` §3.2.2（已修） | 旧文：§10.1 的 `unconvertible` 行写“原生层 = SP / **IR** / RC / RK / OBS / ERM / PCR（`09` §3.2.2）”，且与同文 §10 适用性表自相矛盾 | `09` §3.1 矩阵 IR × `unconvertible` = `—`；修正后的 `09` §3.2.2 已删 `IR` | IR、SP、解码器、条件 3 | Compression（**已于 16:21–16:24 应用**） | 已从 §10 适用性表（**L506**）与 §10.1 折叠表（**L517**）删除 `IR`；原生层统一为 SP / RC / RK / OBS / ERM / PCR；新增 decoder 负例与矩阵条目 | compression **L506 / L517**（已改）、**L571** 负例 24、**L623** 自记闭合；决策链 **L564 / L589**；矩阵 **L230**；迁移 **L179** | **否（已闭合，16:25 实测）** | `rg -n 'SP / IR / RC' compression` = **0**（期望 0）；`rg -n '只属 SP / RC / RK / OBS / ERM / PCR' compression` ≥1 |
| CF-47 | compression `context-unit-manifest-v1` §10 / §10.1 vs `09` §3（已修） / 检索线 `TC-10` | 旧文：§10 的 `cancelled` 行写“上层取消（abort）**而非 deadline**”，把 deadline 完全排除在 `cancelled` 之外；且 §10.1 未登记任何 `timeout` 来源码 | `09` §3：上层 / 父级 deadline 触发的 abort = `cancelled` + `*-cancelled-by-deadline`；仅**自身** deadline = `timeout`；调用方 / operation / epoch fence / 预算 / early stop 各自来源码 | 全体状态消费方、取消上界统计、条件 3 | Compression（**已于 16:21–16:24 应用**） | 已新增 `timeout` 行（**L495**）、改写 `cancelled` 行为六类触发（**L496**）；§10.1 新增 **FD-5 唯一判定表（L531–542）**，登记 `compression-deadline-exceeded` + 六个 `cancelled` 码，并显式作废旧表述 | compression **L495 / L496 / L518 / L532–534 / L542**（已改）、**L572** 负例 25、**L624** 自记闭合；决策链 **L361 / L375 / L559 / L563 / L590**；矩阵 **L231 / L247 / L263**；迁移 **L180** | **否（已闭合，16:25 实测）** | `rg -n '而非 deadline' compression` = **0**（期望 0）；`rg -n 'compression-deadline-exceeded' compression` = **7**（期望 ≥1）；六个 `cancelled` 码各 ≥2 处 |

| CF-48 | 检索线 `02` §3.5 已移除码表（**L238–240**）与 decoder 负例 **N-25（L513）** vs 同文 §3.4 / §3.5 活跃登记 | N-25 把 `retrieval-cancelled-by-deadline` 列为“**已移除**的 reason.code” | 同文 §3.4 **L159**、TC-10 **L176**、§3.5 **L216** 均把它登为**活跃码**，且它**不在** L238–240 的已移除表中 | 取消来源码的合法集、`rejected[].status = cancelled` 的 decoder 规则、条件 3 | Retrieval（本线不改其文件） | 从 N-25（L513）的“已移除”清单删除 `retrieval-cancelled-by-deadline`；保留另三个（与 L238–240 一致，无误） | 检索线 `02` **L513**（后续已应用） | **否（后续已闭合）** | `rg -n '已移除的 reason.code' retrieval/02-retrieval-schema.zh-CN.md` 命中行中不得再含 `cancelled-by-deadline`；`rg -n 'retrieval-cancelled-by-deadline' retrieval/02` 仍应 ≥3 |
| CF-49 | 检索线 `02` **L159 / L168 / L216** 对 `09` 的 section/行号引用 vs `09` 实际结构 | 三处曾写“`retrieval-cancelled-by-caller` / `-by-deadline` 是 `09` **§3.2.2 line 395** 点名的两个” | `09` §3 的唯一判定规则表位于 **L345–357**；旧行号引用已删除 | 可追溯性、Review 重跑（**不影响字段/状态语义本身**） | Retrieval（本线不改其文件） | 三处改指 `09` §3 的唯一判定规则表（L345–357），或直接指向本节 §3.4 / §3.5 自己的登记表 | 检索线 `02` **L159 / L168 / L216**（后续已应用） | **否（已闭合）** | `rg -n '§3.2.2 line 395' retrieval` 历史实测曾为 3，后续复测为 **0** |
**登记表统计（当前磁盘事实）**：**49 条登记（CF-01…CF-49）**；**已闭合 47 条**，**仍开放 2 条（CF-20、CF-23）**。

- **本轮新闭合**：**CF-46**（压缩线 §10 / §10.1 已删 `IR`，16:21–16:24 落盘）、**CF-47**（压缩线已新增 `timeout` 行 + 六类 `cancelled` 行 + FD-5 来源码登记表）。两者均经 16:25 逐条重测磁盘确认。
- **历史快照：仍开放 4 条（状态同步轮五）**：
  - **CF-48（历史快照，后续已闭合）**：检索线 `02` **L513** 的 decoder 负例 N-25 曾把**活跃码** `retrieval-cancelled-by-deadline` 误列为“已移除”；
  - **CF-49（历史快照，后续已闭合）**：检索线 `02` **L159 / L168 / L216** 三处曾引“`09` §3.2.2 line 395”；
  - **CF-20**、**CF-23** 的实现与证据缺口（名称/schemaId 与 FI-20.1 编号已裁定，不属 schema 冲突）。
- **写集外陈旧项 X-14（已闭合）**：检索线 `04` §2 **L46** 已修复为指向 `01` §4.4，旧 Owner 搜索为 0；本条保留为历史登记，不计入当前开放数。

本线本轮只写入 `implementation/` 的 **`05` / `09` / `10`**（另 `07` 哈希表 2 行）；`01` / `04` 本轮**未改**，**未**修改 retrieval / compression 任何文件。

> 写入时间线（可复核 mtime）：implementation/09 = 16:26:18，05 = 16:32:49，10 = 16:33:29，07 = 16:33:38；压缩线 = 16:21:54–16:24:41；检索线 = 16:27:08–16:28:30。三线写入交错，但路径互不重叠。

> 时间点与测法：本节“已闭合 / 仍开放”判定以 **2026-10-09 16:35** 对磁盘的只读 `rg` / `Get-Content` 实测为准（**回执前最后一次重读 mtime + 关键行**）。
>
> **并发写入事件（必须保留）**：
> - 压缩线在 **16:21:54–16:24:41** 写入四个文件 → CF-46 / CF-47 从“开放”变为“已闭合”；
> - 检索线在 **16:27:08–16:28:30** 写入 `00` / `02` / `12` → 本线当时复读仍看到旧状态；随后检索线再次写入并修复 CF-48 / CF-49 / X-14，当前关键行已复测闭合；检索线 `12` 的 `X-10…X-15` 均标已闭合，与本线登记不矛盾。
>
> 结论：**任何跨线状态判定都必须以回执前最近一次重读为准**；对方线可能在同一时段并发写入。

**跨线闭合验证（状态同步轮五实测；每条给出可重跑的机械命令）**：

| 编号 | 验证命令（省略公共前缀 `docs/architecture/context-governance/`） | 实测结果 | 结论 |
| --- | --- | --- | --- |
| CF-38 | `rg -n 'type FactStatusV1' implementation retrieval` | `implementation/01:88` = 1；`retrieval` = **0** | 已闭合（单一声明） |
| CF-39 | `rg -n 'interface InspectResultV1\|interface InspectCheckV1' retrieval` | **0 个声明体**；仅 `02:360`“本文件**不声明**”与 `12:75` 的闭合记录 | 已闭合（主冲突） |
| CF-40 | `rg -n '^\s+.*promotionRecommendation' compression` | **0 字段声明**（4 处均为“不得出现”禁令）；§4.1 **L107** = 四位许可位 | 已闭合 |
| CF-41 | `rg -n 'operationEpoch: number \| null\|evaluationRunId: string \| null' compression/context-unit-manifest-v1.zh-CN.md` | **L308 / L309** 命中；同文 **L318** RT-2 单一 schema；压缩线自记 **L602** “本线已闭合” | 已闭合 |
| CF-42 | `rg -n 'supersedes: string' retrieval` | **0**；`03` **L58** = `previousGenerationId`、**L59** = `nextGenerationId`、**L72–75** LG-1…LG-4 命名隔离 | 已闭合 |
| CF-43 | `rg -n '否则整个候选是' implementation/01-contract-draft.zh-CN.md` | **0**；`01:401` = “原生状态是 `wrong_dimension` … 只发生在 RK 层” | 已闭合（本轮修复） |
| CF-44 | `rg -n 'SP、IR、RC\|SP / IR / RC' implementation/01-contract-draft.zh-CN.md implementation/09-contract-entities-v1.zh-CN.md` | **0**；`09:401` = “**`IR` 不在其中**” | 已闭合（本轮修复，共享侧） |
| CF-45 | `rg -n '被调用方或上层取消\|由 deadline 触发；' implementation/01-contract-draft.zh-CN.md implementation/09-contract-entities-v1.zh-CN.md`（**只在契约文件内**，避开本表自身引用文字） | **0**；`09:345` = “唯一判定规则”7 行表 | 已闭合（本轮修复） |
| CF-46 | `rg -n 'SP / IR / RC' compression` | **0**（期望 0） | ✅ 已闭合（压缩线 16:21–16:24） |
| CF-47 | `rg -n '而非 deadline' compression` = **0** 且 `rg -n 'compression-deadline-exceeded' compression` ≥ 1 | **0** / **7** | ✅ 已闭合（压缩线 16:21–16:24） |
| CF-48 | `rg -n '已移除的 reason.code' retrieval/02-retrieval-schema.zh-CN.md`（L513）| 命中行**不应**含 `cancelled-by-deadline`；历史实测曾包含，后续复测为 0 | ✅ **已闭合（检索线后续修复）** |
| CF-49 | `rg -n '§3.2.2 line 395' retrieval` | 期望 **0**；历史实测曾为 3，后续复测为 0 | ✅ **已闭合（检索线后续修复）** |
| CF-15 残余 | `rg -n 'scopeKey' implementation/09-contract-entities-v1.zh-CN.md` | 均属“历史名 / 不得使用”禁令或字段名统一记录；`compression/` 无活字段 | 历史陈旧记录（非活字段） |

**活冲突残留（2026-10-09 复读）**：**CF-46 / CF-47 已由压缩线于 16:21–16:24 闭合**（实测命令已归 0 / 已归位），因此压缩线侧**无未闭合契约冲突**。当前仅剩 **CF-20 / CF-23 两条完整产物与证据门槛**（CF-20 最小 runtime bridge 已落地，但完整失败/并发/crash-replay 证据仍缺）；CF-48 / CF-49 与 X-14 均为已闭合项：

| 编号 | 残余 | 磁盘证据（实测） | 责任方 |
| --- | --- | --- | --- |
| **CF-48** | 检索线 `02` N-25 曾把活跃码列入“已移除” | 后续复测：N-25 已修复，活跃登记与已移除表一致 | Retrieval（已闭合） |
| **CF-49** | 检索线 `02` 三处曾引用错误行号 | 后续复测：`rg -n '§3.2.2 line 395' retrieval` = 0 | Retrieval（已闭合） |
| CF-20 | `DisclosureRecordV1` / `MemoryReadRecordV1` 名称与 schemaId 已裁定并登记（保持 T4；最小 runtime bridge 已落地） | `09` §1.3 **L177–178** 已登记名称与 schemaId；最小 bridge 已生成 Artifact 并绑定 RunLedger Context Operation，完整失败/并发/crash-replay 证据仍开放 | 用户 / Review |
| CF-23 | 不新增全局 FI-28；继续由 `FI-20.1` 子用例承载 | `04` §6 **L172** `FI-20.1` 行；`09` §7 **L493** 已裁定项 | 用户 |
| X-14（写集外陈旧项） | 检索线 `04` §2 **L46** 已改为指向 `01` §4.4 | 旧 Owner 搜索为 0；`retrieval/12` 已同步闭合 | Retrieval（已闭合） |

> **一行话总结**：压缩线与检索线的 CF-46…CF-49、X-14 均已闭合；当前只剩 CF-20 / CF-23 的真实 RunLedger、fixture/gold/KB/ERM/PCR/hash 证据门槛。共享契约（`01` / `09`）自身无新的未闭合 schema 冲突。

以下为**历史陈旧记录**（不得再当作活计数）：`scopeKey` 在 `retrieval/12` `X-13` 旧版写的“compression 仍 7 处”——检索线已于第三轮重测为 **0 活字段**并改写该行（见其 L107）。

本轮新闭合（已核对，非本线写入对方文件）：CF-09、CF-15（compression `scopeKey` 活字段 = 0）、CF-25、CF-21 / CF-22、CF-18 / CF-19、**CF-38 / CF-39 / CF-40 / CF-41 / CF-42（对方线第三轮，15:46–15:54；本线已于 16:10 逐条重测磁盘确认）**。

> 更正：上一轮曾把 **CF-23** 误列入本组。压缩线/检索线已就位的是 `FI-20.1` **子用例**（`04` §6 L172、compression 矩阵 L225）；**CF-23 已裁定不新增全局编号，继续使用 `FI-20.1` 子用例。**

本轮本线自身修复（Implementation 侧缺陷，见 CF-43 / CF-44 / CF-45）：`01` §4.2 RC 维度不符的原生状态；`01` §3.3 + `09` §3.2.2 的 `unconvertible` × `IR`；`01` §3.3 + `09` §3 + `04` §6 的 `timeout` / `cancelled` 判定与来源码所有权。

已核对为**已同步**的项（对方线主动同步，非本线写入）：CF-03（`PermissionSetV1` 已废止，compression §4.1 SP-5 / 决策链 §7.1）、CF-05/CF-06/CF-33（compression 决策链 §7.5/§7.6、`04` §8）、CF-08（retrieval `02` §3.1 已删本地副本与别名，`12` R-BL-01 已闭合）、CF-10/CF-11（compression §8.1 已删除 `permissionsSummary` / `basisManifestRef`）、CF-13（compression 已改为 `recoverability`）、CF-22/CF-23（compression 矩阵已按 `generation_mismatch` / `FI-20.1` 更新）、CF-24（compression 已改用 `ZT-CM-01…12`）、CF-28/CF-36（retrieval `12` / `02` §8 已更新）。

## 3. 拟议的后续写集（P0 获准后；本轮不写）

| 目标 | 内容 | 写入者 | 需授权 |
| --- | --- | --- | --- |
| `docs/architecture/pactile-dual-product-architecture-design.zh-CN.md` | 把 §27.9 的调整落入 §23.1（Host 组件）、§23.3（RunLedger 关联）、§23.4（Context 故障恢复）、§24（分层性能指标）、§26.1（阻断条件）；以单独补丁形式，便于撤销 | Implementation | 是 |
| `docs/migration/retrieval-worker-d25d33.zh-CN.md`、`retrieval-worker-integration-design.zh-CN.md` | 更正 P8 / P9 / P10 的桶名映射；加注 “已被 Context Governance v1 取代为阶段 1 输入”（只改表述，不改证据） | Retrieval 提议，Implementation 认可 | 是 |
| `docs/migration/migration-batches.zh-CN.md`、`native-agent-gap-matrix.zh-CN.md`、`batch-2-context-compaction-memory.zh-CN.md` | 顶部追加状态行：已被重新基线，原文与证据保留 | Implementation / Compression | 是 |
| `docs/pactile/documentation-map.json` | 为 `docs/architecture/context-governance/**` 登记 source map（见下） | 待定 | **是**；该文件受 canonical contract digest 约束，**不得为了让检查通过而改写摘要** |
| 运行时代码 | 阶段 ≥ 1，按 `03` §1.4 的目录提案 | 各线 | 是，且需逐阶段授权 |

### 3.1 文档 source map 的现状与风险（本线实测）

`pnpm exec tsx scripts/check-pactile-brand-surface.ts`（2026-10-09，只读，退出码 1）**当前失败**，共三类：

1. `brand inventory snapshot drift`（期望 `1520e666…`，实际 `b369cde5…`）；
2. `documentation-map.json canonical contract digest mismatch`（期望 `10a8e04e…`，实际 `5ad5ac2c…`）；
3. `documentation source map missing`：**共 62 个文档**，其中 32 个是既有文档（含全部 `docs/architecture/*`、`docs/migration/*`、`docs/development/*` 等），30 个位于 `docs/architecture/context-governance/**`（修复轮只读实测：`implementation/` 11 个、`retrieval/` 13 个、`compression/` 4 个、根目录 2 个）。

第 1、2 类和 32 个既有缺口**早于**本轮；`context-governance/**` 的 30 个条目是三条线新增文档造成的（其中本线 11 个）。因此这不是本轮引入的失败，但本轮让失败列表变长了。本线**没有**修改映射表、摘要或脚本，也没有尝试让检查通过。处理方式（登记、豁免路径、或在映射表重新基线）需要用户决定（`06` BL-18）。

`documentation-parity` 与 `docs-smoke` 只遍历映射表内的路径，因此不受新增文档影响（本线只读核对了其路径来源）。

## 4. 重新基线前运行时改动：逐文件回退说明

> 先说明可行性：因为没有 git 基线，**回退只能靠人工反向编辑**，且 `service.ts`、`pi-session-manager.ts`、`native-agent.test.ts` 同时含有 Compression 线的改动，机械回退会连带破坏对方的工作。因此**首选处置是冻结，而不是回退**。以下说明仅用于让评审者判断“回退”的真实代价。

候选 tree hash 与逐文件 hash 见 `00-rebase-report.zh-CN.md` §0。

| 文件 | 本线改动 | 回退方式 | 回退风险 |
| --- | --- | --- | --- |
| `commands/agent.ts` | 新建 | 删除文件 | 与 `cli/index.ts` 的注册联动，必须同步回退 |
| `cli/index.ts` | 三处：`import { runNativeAgentCli }`；常量 `isNativeAgentRun` 与启动检查里的 `&& !isNativeAgentRun`；`agent` 子命令块（位于 `pi` 子命令之前） | 反向删除这三处 | 低；改动局部 |
| `agent/effects/contract.ts` | 新建 | 删除 | 被 `agent/index.ts` 与 `native-agent` 引用，需同步 |
| `agent/session/contracts.ts` | 新建 | 删除 | 被 `pi-session-manager.ts`、`service.ts`、`context-pipeline.ts` 引用，需同步 |
| `runtime/effect-receipts.ts` | 新建 | 删除 | 被 `runtime/index.ts`、`commands/agent.ts` 引用 |
| `agent/session/index.ts` | 增加 `export * from "./contracts.js"` | 删除该行 | 低 |
| `agent/index.ts` | 增加对 `session/index.js`、`effects/contract.js` 的导出 | 删除两行 | 低 |
| `runtime/index.ts` | 增加 `export * from "./effect-receipts.js"` | 删除该行 | 低 |
| `agent/context-pipeline.ts` | 增加类型 import 与 `checkpointWriterFromPiSession.write` 内的 `recordSnapshot` 调用块（含 DEF-IMPL-1 的占位 hash） | 反向删除 | 中；与 Compression 线对 `checkpointWriterFromPiSession` 的评估相关 |
| `agent/native-agent/contract.ts` | 选项增加 `session / effectReceipts / runId / operationEpoch` 及两个 import | 反向删除 | 低 |
| `agent/native-agent/service.ts` | 构造函数大幅扩展：会话绑定、transcript 持久化、effect 准入与回执、checkpoint 记录；**另含 Compression 线的 Provider-error 回滚补丁** | **无法机械回退**：Batch 2A 之后的原始版本只存在于本次会话的读取记录中，磁盘上没有副本 | 高 |
| `runtime/pi-session-manager.ts` | 本线：`FilePiSessionManager` 的 binding 旁路文件、transcript、`advanceOperationEpoch`；**另含 Compression 线的 `PactilePiSessionManagerAdapter`** | **无法机械回退**，同上 | 高 |
| `runtime/store-port.ts` | `RuntimeStorePutEffectInput` 增加可选 `lease?: RuntimeStoreLeaseProof` | 删除该字段 | 低；但 `repository.ts` 需同步 |
| `runtime/stores/sqlite/repository.ts` | `putEffect` 在写事务内校验 lease proof；`assertLeaseProof` 增加 `operation` 参数，把字面量 `"appendEvent"` 参数化 | 反向编辑 | 中；`appendEvent` 路径必须回归测试 |
| `test/.../native-agent.test.ts` | 含两条线的测试 | — | 与上同 |
| `test/.../pi-session-manager.test.ts` | Compression 线的测试 | — | 与上同 |

构建产物 `packages/cli/dist/**` 也包含这些改动；它是可再生的构建输出，不属于源码写集。

### 4.1 三个处置选项的代价

| 选项 | 做法 | 代价 / 风险 |
| --- | --- | --- |
| (a) 冻结 | 不再修改；作为 pre-P0 候选，在阶段 1 Review 时被评审、修复或剔除 | 保留 6 个已知缺陷（DEF-IMPL-1…6）和一个未经评审的 `agent` 命令面 |
| (b) 隔离 | 先快照；把候选从工作树取出为单独补丁，再从工作树移除 | 需要对 `service.ts` 等共享文件做人工拆分，容易误伤 Compression 线 |
| (c) 回退 | 反向编辑到重新基线之前 | `service.ts`、`pi-session-manager.ts` 无副本可恢复；需要重写；破坏性，必须明确授权 |

推荐（a）并在 `agent` 命令面上加显式的 “未评审、不可用于产品” 标注——**该标注本身也是运行时改动，需授权**。

## 5. 快照与恢复协议（若用户选择 (b) 或 (c)）

1. **先快照，后任何改动。** 把第 0 节的 16 个文件，加上 Compression 线披露的 4 个文件，**复制**到 `D:\pactile-evidence\context-governance\prerebase-snapshot-<timestamp>\`（保持相对路径），同时写 `snapshot-manifest.json`（路径、sha256、字节数、复制时间）。
2. 复制后**回读校验**：逐个重算 sha256，与源文件一致才算快照有效。
3. 记录快照的 tree hash（算法同 `00` §0）。
4. 只有在快照校验通过、且用户明确授权后，才对源文件做反向编辑。
5. 任何一步失败 → 停止，不继续改动，保留现场。
6. 快照目录只增不改；不得删除。

本协议写入仓库外的证据根，属于新增文件的写操作，本轮**未执行**，需授权（`00` §9#1）。

## 6. 各阶段回滚点（摘要；详见 `03`）

| 阶段 | 回滚点 |
| --- | --- |
| 0 | 文档均为新增；移除新增文件（先快照）；对架构文档的修订以独立补丁提交审查 |
| 1a | 新增代码与测试全部为新增文件；`contextGovernance.mode = off`；移除新增目录（先快照） |
| 1b | `mode: off`；已写 receipt 保留；Context 如被替换则用 Artifact 原文恢复 |
| 2 | semantic 分支 `shadow` → 移除分支配置；A0 路径始终可用 |
| 3 | 关闭 Jev provider 配置 → 回到阶段 2 |
| 4 | 关闭 Jev provider → 回到阶段 1b |
| 5 | `mode: shadow`；从 Artifact 原文恢复已 mask / externalize 的单元 |
| 6 | `mode: reversible`；从 Artifact 原文恢复 |
| 7 | 通过 revoke 命令撤销；`mode` 回到 lossy / reversible |

共同原则：证据（receipt、manifest、评测结果、旧 run）一律**不删除**；回滚改变的是**行为开关**与**上下文内容**，不是历史记录。

## 7. 观察到的文件状态（本轮结束时校验）

文件清单与大小在修复轮结束时用 `Get-ChildItem` 复核（`implementation/` 共 11 个文件 `00`–`10`），并在最终回执中引用；修复轮的最终哈希由 `07` §6 在**所有文件写入完成后**统一重算并回填（本轮修订了 9 个文件，故 §6 的旧哈希全部作废）。`07` 自身的哈希无法自包含，随回执报告。本轮只读核查结果：冻结候选 16 文件 tree hash 与 `00` §0 一致（未改动）；`packages/**` 无写入；未启动或终止任何进程；未读取 / 写入凭据。

### 2.1b 历史快照：P0 状态同步轮六（本次读取；仅实现文档同步）

本次先重读磁盘后同步：检索线 retrieval/02-retrieval-schema.zh-CN.md 的最后写入时间为 **2026-10-09 17:22:49**，但当时记录的关键内容尚未闭合（后续已修复；本段保留为历史快照）：

- **CF-48 仍开放**：N-25 仍把活跃码 retrieval-cancelled-by-deadline 列入“已移除的 reason.code”；同文 L159 / L176 / L216 仍将其登记为活跃码。
- **CF-49 仍开放**：L159 / L168 / L216 仍引用 09 §3.2.2 line 395；09 L395 为空，实际唯一判定规则表位于 09 §3 L345–357。

当时登记统计为 **49 条：已闭合 45 条、开放 4 条（CF-48、CF-49、CF-20、CF-23）**；写集外陈旧项 X-14 仍保持开放登记。CF-46 / CF-47 继续保持已闭合。本次未修改 retrieval / compression、runtime、Stage 1 或任何证据产物，未提交、未推送。

### 2.1c 读取更正（以当前磁盘为准）

复读 `retrieval/02-retrieval-schema.zh-CN.md` 后确认：CF-48 / CF-49 已由检索线落盘闭合。N-25 当前仅列三个确已移除码；`§3.2.2 line 395` 在 retrieval 目录命中为 0。此前轮六段落是读取时序中的陈旧判断，现以本节为准。CF-20、CF-23 的实现与证据仍开放，X-14 仍为写集外陈旧项。
