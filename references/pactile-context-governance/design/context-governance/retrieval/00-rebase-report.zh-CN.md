# Retrieval Controller 重新基线报告（REBASE_REPORT）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。本文件仅是基线报告，不是 P0 产物，不改变任何产品 Run、Kernel 或 Evidence。本轮为 Review-修复轮的只读基线快照，**§1–§10 不重写**；当前状态与文档索引以 §11 与 `12` 为准。
- 执行线：Retrieval Controller（Pi Agent 派发链路）。
- 生成时间：2026-10-09。
- 本报告没有修改 Worker、运行时代码、Provider 配置或任何评测证据，也没有启动评测、索引或 EmbeddingGemma 调用。

## 1. READ_FILES（含 SHA-256 前 16 位）

| 文件 | sha256[0:16] | 用途 |
| --- | --- | --- |
| `D:\pactile\docs\architecture\pactile-dual-product-architecture-design.zh-CN.md`（重点 §24–§27） | `804b7c6cd5f39dad` | 当前架构依据 |
| `D:\pactile\docs\architecture\pactile-context-governance-agent-prompts.zh-CN.md` | `40a5ae656419800b` | 三线提示词与闸门 |
| `D:\pactile\README.zh-CN.md` | `5f3feeca91ca2d46` | 产品边界与状态词汇 |
| `D:\MyHarness\AGENTS.md` | `80a0f03f1951f605` | 共享环境约束 |
| `D:\MyHarness\.pactile\workflow.md` | `1057840e96a4d4dc` | Task/Run/Review 规则 |
| `D:\pactile\docs\migration\retrieval-worker-integration-design.zh-CN.md` | `f63a453429100262` | 旧 Worker 接入设计 |
| `D:\pactile\docs\migration\retrieval-worker-d25d33.zh-CN.md` | `5a8afd171d502e59` | 旧冻结候选记录 |
| `D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json` | — | 冻结候选 digest |
| `D:\MyHarness\.tmp\retrieval-worker-audit\next-prompts\common-eval-boundaries.md`、`08-*`、`09-*`、`10-*` | — | 旧评测计划与旧 Prompt 2–10 定义 |
| 旧 P3 driver：`graph-03-20261007-171741\drivers\{run-p3.ps1,lib.mjs,verify.mjs,report.mjs}` | — | 旧 harness 结构 |
| 当前实现（只读）：见第 6 节 | 见第 6 节 | 当前代码基线 |

**未找到**：EmbeddingGemma 调研结论。已按名称在 `D:\pactile\docs`、`D:\pactile\.tmp`、`D:\pactile-evidence`、`D:\MyHarness\docs`、`D:\MyHarness\.tmp`（深度 3）、`D:\MyHarness\scratch`、`D:\MyHarness\.pactile\tasks` 中检索 `embed|gemma`，只命中架构 §27 和提示词文件中的引用；没有调研产物。

## 2. 旧目标与新目标的差异

| 维度 | 旧目标（Worker 接入线） | 新目标（Context Governance v1 Retrieval Controller） |
| --- | --- | --- |
| 对象 | 把冻结的 Retrieval Worker（exact + graph + rule decision）作为 capability provider 接入 ABI V3 | 设计多分支候选链路（exact/lexical/structural/relation/semantic/external），Worker 只是其中 exact/structural 分支的一个实现 |
| 语义能力 | 无；Worker 的 `DecisionProvider`（rule/LLM）负责意图规划，P7 评 LLM decision | 新增独立 `SemanticProvider/EmbeddingProvider`，与 `DecisionProvider` 分离；EmbeddingGemma 只是默认 profile |
| 身份 | 评测 runId（bucket-时间戳）兼作证据身份 | 产品 `runId`、上下文 `contextOperationId`、离线 `evaluationRunId` 分离 |
| 输出 | `LocalWorkerContextItemV1`、V3 claim assessment | `RetrievalPackV1`：只含已 Inspect 候选、来源指针、hash/revision/generation/freshness/permissions/coverage/rank provenance |
| 闸门 | P1–P10 桶评测后接入 Agent Context Pipeline | 阶段 0 契约/评测冻结 → 阶段 1 确定性 baseline → 阶段 2 semantic shadow；没有 fixture hash、gold/negative、manifest、paired report、故障注入和恢复证据不得放权 |
| 下一步动作 | 重跑 P1、处理 P3、推进 P8/P9/P10、接入 Context Pipeline | 暂停上述动作；先冻结契约、fixture、身份模型与证据格式 |

## 3. 仍然有效的事实（均有证据）

1. d25d33 冻结候选 digest 仍与 `freeze.json` 一致：src `f00e7d83…`、dist `657f32c2…`、test `4189fbf9…`，文件数 10/40/1（2026-10-09 只读重算）。
2. 当前没有任何 retrieval-worker 评测进程在运行（2026-10-09 10:25 按命令行精确匹配 `retrieval-worker|graph-03|concurrency-05|workflow-08|e2e-09|final-10|embeddinggemma` 扫描，命中仅为无关 git 进程和扫描自身）。
3. 旧 Prompt 8（workflow/no-gold）、Prompt 9（e2e 关联）、Prompt 10（final 汇总）从未启动；评测根目录下不存在 `workflow-08-*`、`e2e-09-*`、`final-10-*`。
4. Worker 的事实边界仍成立：Worker hash/facts 不算 corroboration；`scope.root` 与宿主指纹 `worktreeId` 必须丢弃；只有 `rule` decision provider 被允许；abort/timeout 只能靠终止进程保证（RPC 无 cancel）。
5. 旧集成设计记录的 Worker 缺口 G1–G11 仍然有效，其中与新目标直接相关的是：G1（V3 ref 语法只允许小写、无行号）、G5（无 cancel）、G6（索引写入 workspace，与 `filesystem:"read"` 冲突）、G8（graph 目录 scope 语义错误）、G10（Worker 对 UTF-8 解码文本取 hash，与 Agent 原始字节 hash 不一致）。
6. Retrieval ABI V3 已经固定 verification chain：`candidate → corroborate → classify-evidence → check-assurance → accept-or-stop`，并把 provider score 排除在 assurance 之外。

## 4. 已过时的假设

1. “P1–P10 桶评测通过后即可接入 Agent Context Pipeline”：已被阶段 0–7 路线取代。
2. “Worker 是检索链路本身”：新架构中 Worker 只覆盖 exact/structural 分支，不覆盖 lexical/relation/semantic/external，也不拥有 RetrievalPack。
3. “bucket runId 可作为证据身份”：须补充 `evaluationRunId`、`caseSetHash`、`fixtureHash`、`candidateSha`、`dirtyWriteSet`、`providerCapabilitySnapshot`、`seed`。
4. “旧 Prompt 7（LLM DecisionProvider）是语义能力评测”：新架构中 DecisionProvider 与 SemanticProvider 分离；P7 不能代表 semantic 质量。
5. 旧文档中的桶名映射有误：`retrieval-worker-d25d33.zh-CN.md` 与集成设计把 P9 写成 “no-gold semantic”、P10 写成 “Agent correlation”；旧提示词定义实为 P8=workflow/no-gold、P9=e2e 关联、P10=final 汇总。需要更正（列入写集）。
6. “Pactile ABI V3 的 `RetrievalPlanV3` 可直接作为新契约”：架构 §27.4 写的是 `RetrievalPlanV2`，与现有 V3 命名冲突，需要裁定版本命名（见阻断项 B4）。

## 5. 未验证结论

- 旧 P1（contract）没有绑定 d25d33 的权威 run；`20261005T004500Z-contract01` 没有 `verification.json`。
- 旧 P3：116 pass / 2 contract-finding / 1 INCONCLUSIVE（`ABORT-large-fixture-in-flight`）；库内 graph abort 窗口未被证明。
- 旧 P7：冻结前约 11 小时的背景证据，70 PASS / 1 unverified，与早期“140/2”表述未调和。
- 当前代码在 Node 24.0.0 最低版本下的安装、full test、pack 未验证；full package test 仍失败（既有 JEV/P38 失败）。
- EmbeddingGemma 的模型 id、默认维度、task prefix、query/document 前缀差异、batch 与取消语义：无调研产物，全部未验证。
- 当前 `capability-smoke` 中 `fast-context`、`codegraph` 作为外部 semantic/structural provider 的 readiness 只做到命令可见性与 index marker，未做到 Inspect/generation fence。
- 本会话之前在 `D:\pactile` 写入的运行时改动（见第 6 节）只有 focused 测试证据，不是新架构的验收。

## 6. 当前证据路径与代码基线

### 旧评测证据（均为 candidate 证据，不是新架构通过）

| 旧桶 | runId / 目录 | 状态 |
| --- | --- | --- |
| P1 contract | `D:\MyHarness\.tmp\retrieval-worker-evaluation\2026100{4,5}T*-contract*` | 背景证据；无权威 run |
| P2 exact | `…\exact-02-20261007-181929-d25d33` | PASS（480 + 75 行，verify 无失败） |
| P3 graph | `…\graph-03-20261007-171741` | 116 pass / 2 contract-finding / 1 INCONCLUSIVE；verify 42 项 0 失败 |
| P4 lifecycle | `…\lifecycle-04-20261007-190100` | PASS，46 sampleIds，orphans=0 |
| P5 concurrency | `D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408` | PASS（29/29、309/309）；`-180737` 背景，`-193019`/`-003926` VOID，`-004022` SUPERSEDED |
| P6 budget/fault | `…\p6-budget-fault-06-20261007-183546-final` | PASS，verify 104 项 0 失败 |
| P7 decision | `…\decision-07-20261007-054042` | 冻结前背景证据 |
| P8/P9/P10 | — | 未启动 |
| smoke | `D:\pactile-evidence\retrieval-worker-smoke\smoke-20261008-020605`（`-005125` 首次失败保留） | 2/2 candidate smoke |

### 当前实现文件（全部 untracked；`develop` 无提交，因此只能用文件 hash 锚定）

| 文件 | sha256[0:16] |
| --- | --- |
| `packages/cli/src/pactile/retrieval/adapters/local-worker.ts` | `e309884ff3733918` |
| `packages/cli/src/pactile/retrieval/adapters/local-worker-process.ts` | `1630f11808b818cb` |
| `packages/cli/src/pactile/retrieval/evidence.ts` | `0afe9ca377a949b3` |
| `packages/cli/src/pactile/retrieval/planner.ts` | `9520f3c4593e47bd` |
| `packages/cli/src/pactile/retrieval/types.ts` | `64b2bdcf66194f6f` |
| `packages/cli/src/pactile/agent/retrieval/adapter.ts` | `4f871b989579a225` |
| `packages/cli/src/pactile/agent/retrieval/router.ts` | `d4e1e87191b375e5` |
| `packages/cli/src/utils/readiness.ts` | `e4840bb8d1c4b3c5` |
| `packages/cli/src/commands/capability-smoke.ts` | `c781affdae9ec758` |

其中 `agent/retrieval/adapter.ts`、`agent/retrieval/router.ts`、`retrieval/evidence.ts`、`utils/readiness.ts`、`commands/capability-smoke.ts` 在本次重新基线之前、同一工作线中被修改过（scope/provenance/结果上限围栏、stale/failed resolution 拒绝、readiness 降级与脱敏）。按新边界，这些改动自此冻结，不再继续，也不自行回退；处理方式需要授权（见第 9 节）。

现有契约与新 schema 的主要缺口：`RetrievalProvenance` 只有 `source/adapterId/scope/evidenceRefs/generation:number|null/snapshot`，缺少 `workspaceId`、`worktreeId`/branch、`sourceRevision`、`permissions`、`providerCapabilitySnapshot`、`freshness`、`contextOperationId`；V3 ref 语法无法表示行号与大写路径；V3 中没有 semantic provider 的 generation/model/dim 概念。

## 7. 当前阻断项

| # | 阻断 | 影响阶段 | 解除条件 |
| --- | --- | --- | --- |
| B1 | EmbeddingGemma 调研产物缺失 | P0 中 readiness fixture 的期望值（模型 id、维度、前缀、batch/取消语义） | 提供调研产物路径；否则这些字段在 P0 中只能冻结为“参数 + unverified”，不得写入期望通过值 |
| B2 | 三条线尚未全部返回 `READY_FOR_P0`，Implementation Controller 尚未汇总依赖、写集、fixture/hash 和 Review 入口 | P0 开始 | Implementation Controller 汇总并确认 |
| B3 | 本线在重新基线前已有未经新闸门审查的运行时改动（第 6 节） | 阶段 1 baseline 的候选身份 | 用户决定：保留为 pre-P0 候选并在阶段 1 Review / 隔离到单独补丁 / 回退 |
| B4 | 契约命名冲突：架构 §27.4 的 `RetrievalPlanV2` 与现有 ABI `RetrievalPlanV3` | P0 schema 冻结 | Implementation Controller 裁定版本命名与兼容映射 |
| B5 | V3 logical ref 语法不能表达行号、大写或非 ASCII 路径（G1） | RetrievalPack 来源指针 | P0 定义版本化 source-pointer schema；不得静默重编码 |
| B6 | Worker 索引写入 workspace（G6），与只读检索策略冲突 | 阶段 1 structural 分支 | P0 中将 index init/sync 定义为受 EffectGateway 管理的写 effect，或要求外置 indexDir（Worker 改动需重新冻结） |
| B7 | file hash 语义不一致（G10：Worker 取 UTF-8 解码文本，Agent 取原始字节） | Inspect fence | P0 固定 Inspect 只信任当前工作树原始字节 hash |
| B8 | `pnpm --filter @blxzer/pactile lint` 当前失败于本线写集之外的文件（`agent/effects/contract.ts`、`agent/native-agent/service.ts`、`agent/session/contracts.ts`，修改时间 03:46–03:48，非本线写入） | 任何代码阶段的质量门 | 由对应工作线处理；本线不修改 |

旧 P1 无权威 run、旧 P3 INCONCLUSIVE、P8–P10 未运行，不再作为本线的直接阻断；它们降级为阶段 1 baseline 的输入证据，是否重跑由阶段 1 计划决定。

## 8. 拟修改的文档/契约写集（仅 `D:\pactile\docs`，P0 获准后写入）

```text
docs/architecture/context-governance/retrieval/
  00-rebase-report.zh-CN.md                 （本文件，已写入）
  01-semantic-provider-contract.zh-CN.md    SemanticProvider/EmbeddingProvider 接口草案（与 DecisionProvider 分离）
  02-retrieval-schema.zh-CN.md              RetrievalCandidate / RetrievalPackV1 / 计划命名映射 / 公共字段 / 一等失败状态
  03-semantic-generation-index.zh-CN.md     embeddingModelId/embeddingDim/promptVersion/chunkerVersion/semanticGeneration 失效与重建
  04-inspect-freshness-fence.zh-CN.md       path/行范围/字节 hash/revision/generation/worktree/branch/workspace/permission/epoch fence
  05-candidate-pipeline.zh-CN.md            六分支并行召回、预算/deadline/cancel、canonicalize、merge/dedupe、RRF、coverage、abstain
  06-fallback-degradation.zh-CN.md          provider 各失败态 → exact+structural fallback 与结果披露字段
  07-external-search-fetch-evidence.zh-CN.md  Search → Fetch → Evidence 边界
  08-privacy-egress.zh-CN.md                数据外发、日志脱敏、capability policy
  09-readiness-fixtures.zh-CN.md            EmbeddingGemma readiness fixture 定义（阶段 2 才执行）
  10-evaluation-matrix.zh-CN.md             fixture 类别、gold/negative 标注规则、指标口径、paired/ablation/对照臂、evaluationRunId manifest
  11-legacy-worker-migration.zh-CN.md       旧 Prompt 1–10 / 旧证据 → 新阶段迁移表
  12-blockers-unverified.zh-CN.md           阻断清单与未验证项
docs/migration/retrieval-worker-d25d33.zh-CN.md            更正 P8/P9/P10 桶名映射（只改表述，不改证据）
docs/migration/retrieval-worker-integration-design.zh-CN.md  同上，并加注“已被 Context Governance v1 取代为阶段 1 输入”
```

不在写集内：任何 `packages/**` 源码、`D:\MyHarness\pactile\packages\retrieval-worker`、旧 run 目录、gold、分母、Provider 配置。

## 9. 需要用户授权的高影响动作

1. 处置第 6 节的 pre-rebase 运行时改动（保留并在阶段 1 Review / 隔离 / 回退）。
2. 任何运行时或 Worker 代码修改；Worker 修改还意味着重新冻结候选并重跑受影响评测。
3. 调用真实 EmbeddingGemma 或任何远程 embedding 端点（涉及源码/查询外发），以及读取 `provider.env` 等凭据。
4. 新建 vector DB、embedding 索引或第二条 indexing pipeline；把 Worker index init/sync 作为写 effect 运行。
5. 启动任何评测长跑（包括旧 P1/P3 重跑、P8/P9 或阶段 1 baseline 全量 run）。
6. 接入 Agent Context Pipeline、产品流量或 App。
7. commit、push、merge、tag、publish、deploy。

## 10. 下一阶段闸门

**进入 P0 的条件**

- 三条线均返回 `READY_FOR_P0`，Implementation Controller 汇总依赖、写集、fixture/hash 与 Review 入口；
- B4 命名裁定；B3 处置决定；B1 提供调研产物或接受“参数 + unverified”方案。

**P0 完成（离开 P0）的条件（当前均未满足；状态为 `P0_REVIEW_BLOCKED` / `P0_EXIT_NOT_ALLOWED`）**

- 第 8 节 01–12 文档通过 Review，且全部状态为 proposed/frozen-draft；
- 评测 fixture 清单、gold/negative 标注在任何检索运行之前冻结并记录 sha256、来源和标注者；
- `evaluationRunId` manifest 字段、paired report 格式、故障注入清单（provider timeout/unavailable、wrong dimension、stale generation、cancellation、wrong repository、deleted/renamed file、branch switch）冻结；
- 明确声明：P0 不改运行时代码、不接真实 provider、不运行长跑；离线报告 pass/fail 不影响产品 Run 或 Kernel。

阶段 1（exact + structural + Inspect baseline）只能在 P0 冻结物通过 Review 后，另获授权启动。

## 11. 文档索引与状态（2026-10-09 更新；Review-修复轮）

P0 文档写作已获准入（`../implementation/08-p0-admission-decision.zh-CN.md`），本目录文档状态如下：

| 文档 | 状态 | 覆盖内容 |
| --- | --- | --- |
| `00-rebase-report`（本文件） | proposed · P0_REVIEW_BLOCKED | 重新基线、证据路径、旧目标映射 |
| `01-semantic-provider-contract` | proposed · P0_REVIEW_BLOCKED | SemanticProvider / EmbeddingProvider / 状态 / 请求结果 / 能力 snapshot；与 DecisionProvider 分离 |
| `02-retrieval-schema` | proposed · P0_REVIEW_BLOCKED | RP/RC/RK、SourcePointerV1、`InspectResultV1`/`InspectCheckV1` 的**字段映射与引用**（字段表与 `id` 枚举以 `01` §4.4 为准；本线不声明接口，CF-39）、CandidateRefV1、ObservedV1 引用、14 项共享状态与层级折叠、reason.code 封闭枚举、27 条负例 |
| `03-semantic-generation-index` | proposed · P0_REVIEW_BLOCKED | generation tuple、14 类失效触发、fence、generation lineage（`previousGenerationId` / `nextGenerationId`，CF-42）、索引方案 S1/S2（共享枚举，选择未定 = `BL-09`）、manifest CAS |
| `04-inspect-freshness-fence` | proposed · P0_REVIEW_BLOCKED | 13 项 Inspect 检查、fail-closed、epoch fence、`unconvertible` 与禁止变换 |
| `05-candidate-pipeline` | proposed · P0_REVIEW_BLOCKED | 六分支、预算/deadline/取消、canonicalization、去重、RRF、coverage、early stop、abstain |
| `06-fallback-degradation` | proposed · P0_REVIEW_BLOCKED | 触发→出口表、披露字段、重建信号、`unverified` 判定 |
| `07-external-search-fetch-evidence` | proposed · P0_REVIEW_BLOCKED | SearchHit / FetchRecord / EvidenceRecord、citation、embedding 允许与禁止角色 |
| `08-privacy-egress` | proposed · P0_REVIEW_BLOCKED | deny-by-default、数据分类 D0–D7、授权/记录 schema、日志 allowlist |
| `09-readiness-fixtures` | proposed · P0_REVIEW_BLOCKED | RF-01…RF-26（blocking 集仅为提案）、profile 参数、HTTP 200 ≠ ready |
| `10-evaluation-matrix` | proposed · P0_REVIEW_BLOCKED | FQ-01…FQ-23、CX-01…03、绑定字段、状态层级（原生 / pack）、19 项指标、`RET-A0…A3` 对照臂（`RET-A2` 已闭合）、FI subcase 映射 |
| `11-legacy-worker-migration` | proposed · P0_REVIEW_BLOCKED | 旧 Prompt 1–10 映射、旧缺陷映射、复用规则、编号所有权、行动项 RG-01…RG-08 |
| `12-blockers-unverified` | proposed · P0_REVIEW_BLOCKED | 共享 BL 映射（含 `BL-05`）、§3.1 已闭合 24 行 / §3.2 未闭合 5 行、§3.3 冲突 15 行（已闭合 15 / 未闭合 0）、§4 未验证 16 行、P0 自检 |

编号说明：

1. 本目录早期版本（`00` §7）使用 B1–B8；自 `12` 起统一使用共享清单的 `BL-xx` 编号，并在 `12` §2 给出对照。两套编号不得混用。
2. 本线自有编号族：`FQ-*` / `CX-*`（`10`）、`RF-*` / `RD-*` / `RDB-*`（`09`）、`SY-*` / `RS-*` / `RC-*` / `ST-*` / `TC-*` / `WD-*` / `AB-*` / `SPo-*` / `IR-*` / `PK-*`（`02`）、`R-BL-*`（`12`）。
3. **不属于本线拥有**的编号族：`FI-*` / `KB-*` / `HV-*`（`implementation/04`）、`BL-*`（`implementation/06`）。本线只引用与映射（`10` §5 `FR-5`/`FR-6`、`11` §7.1）。

当前闸门（与用户裁定一致）：`P0_DOCUMENT_WRITE_COMPLETE` · `P0_REVIEW_BLOCKED` · `P0_EXIT_NOT_ALLOWED` · `STAGE_1_NOT_AUTHORIZED`。

本目录文档已完成**四轮** Review-修复（第二轮：共享状态单一权威、`RET-A2` 定义闭合、`unconvertible` / `wrong_dimension` / `cancelled` 映射单值化、臂命名空间化；**第三轮：CF-39 — `InspectResultV1` / `InspectCheckV1` 字段表与 `id` 枚举收归 `01` §4.4，本线删除本地声明与 Owner 声明，只保留字段映射；CF-42 — generation lineage 改名 `previousGenerationId` / `nextGenerationId`；CF-15 — 陈旧权限键名计数清理**；**第四轮：只读一致性复核 + 证据状态登记 — 新增 `BL-05` 映射行与 `UV-16`（RunLedgerV1 未实现 / `operationId` 对账未产生）、AC-0.5 / AC-0.6 实例缺失声明、四项禁止声明、条件六 / 七证据行；`X-14` 已修复并闭合，原为陈旧引用，非 schema 冲突；同步 Implementation 侧 16:0x–16:2x 的修正（`R-BL-17` / `R-BL-19` / `R-BL-20` / `X-6` / `X-9` / `X-10` / `X-11` / `X-15` 均已闭合）**），**但尚未通过独立 Review**；`12` §3.2 的 5 行未闭合阻断、§3.3 的 0 行未闭合冲突与 §4 的 16 项未验证全部有效。本文件的 §1–§10 保留首次基线内容，修复轮以本节与 `12` 为准。
