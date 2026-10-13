# Context Governance Contract 草案（v1，proposed）

- 状态：proposed。本文只提出 schema 草案，**不实现运行时代码**，不创建 decoder，不改变既有 Provider。
- 依据：架构 §27.3、§27.4、§27.6、§27.7、§17.7.1、§23.3；现有契约的命名与失败码（见 §8）。
- 与另外两线的关系：Retrieval 线的 `02-retrieval-schema` 与 Compression 线的 `context-unit-manifest-v1` 将给出各自实体的**详细字段与示例**；本文冻结的是**共用外壳、身份平面、一等状态、实体清单与跨线不变量**。若详细文档与本文冲突，以本文的不变量为准，并回到评审。
- 代码风格：下面的 TypeScript 只是 schema 表达，不是代码。真正的 decoder 将放在 Node-neutral 的 contracts 层（不 import `node:fs` 等），并复用现有的 `canonicalizePactileJsonV1` / `fingerprintPactileContractV1`。

## 1. 范围与非目标

范围：12 个 Controller / receipt / evaluation 实体（T1；分层、计数与例外登记见 `09` §1.1–§1.3）

| 缩写 | 实体 | 平面 | 性质 |
| --- | --- | --- | --- |
| RP | `RetrievalPlanV2` | runtime / evaluation | 计划（意图） |
| RC | `RetrievalCandidate` | runtime / evaluation | advisory 候选 |
| RK | `RetrievalPackV1` | runtime / evaluation | 已 Inspect 的候选集合 + 覆盖 + 降级披露 |
| CU | `ContextUnit` | runtime / evaluation | transcript 的可寻址单元（只含 hash 与 pointer，不含全文） |
| CM | `ContextUnitManifestV1` | runtime / evaluation | 一次 Context Operation 的单元清单（durable 后才可决策） |
| CJ | `CompressionJudgment` | runtime / evaluation | Jev / 规则 / 其他 provider 的 advisory 判断 |
| CDQ | `CompressionDecisionRequest` | runtime / evaluation | Compression Controller 唯一能提交的东西 |
| CDR | `CompressionDecisionReceipt` | runtime / evaluation | Effect Receipt 的 typed payload：哪个判断被采用、覆盖或阻断 |
| CAR | `CompactionAuditReceipt` | runtime / evaluation | Pi compaction 后的审计结果 |
| EC | `EvaluationCase` | evaluation only | 固定 fixture 用例与 gold/negative labels |
| ERM | `EvaluationRunManifest` | evaluation only | 一次离线评测运行的可复现清单 |
| PCR | `PairedComparisonReport` | evaluation only | 配对比较报告（评测事实，不是产品事实） |

支撑类型：**T2 独立登记类型 9 项**（`CandidateRefV1`、`SourcePointerV1`、`ProviderCapabilitySnapshotV1`、`InspectResultV1`、`ObservedV1<T>`、`PermissionScopeV1`、`FreshnessV1`、`RestoreTokenV1`、`CurrentManifestPointerV1`）与 **T3 内联结构**（`ProvenanceV1`、`ArtifactRefV1`、`EntityRefV1`、`SnapshotRefV1`、`SourceRevisionRefV1`、`GenerationRefV1`、`DirtyEntryV1`、`ReasonV1`、`ObservationBasisV1`、`RecoverabilityV1`、`AnchorKind`、`TranscriptCursorV1` 等）；分层、字段表归属、hash / provenance / plane / 生命周期与 T4 线内 `schemaId` 登记以 `09` §1.1–§1.3 为准。

非目标（本文不做）：存储布局、SQLite schema、API 路由、Protocol 事件定义、vector DB、token 预算数值、质量阈值。阈值只允许在阶段 1 的基线测量后以回归门槛形式设定（§24.1#5）。

## 2. 身份平面与隔离不变量

架构 §27.3 要求三层身份：

```text
product runId       = RunLedger 中的真实 Agent 执行
contextOperationId  = 一次 retrieval / unitize / compress / audit / memory.read 操作
evaluationRunId     = 一次 fixture、实验臂或 paired comparison 的离线运行
```

本文把它落实为一个**判别字段 `plane`**：

- `plane: "runtime"`：实体由 Host 内的 Controller 在产品 Run 中产生，带 `workspaceId, sessionId, runId, attemptId, turnId, operationEpoch, contextOperationId, inputSnapshotHash`。
- `plane: "evaluation"`：实体在离线评测中产生，带 `evaluationRunId, candidateSha, dirtyWriteSet, seed, caseSetHash, fixtureHash`。Controller 在评测中仍会产生 RP/RC/RK/CU/CM/CJ/CDQ/CDR/CAR，它们的 `contextOperationId` 使用评测命名空间。

| 不变量 | 内容 |
| --- | --- |
| ISO-1 | 一个实体只有一个平面；同时出现 runtime 与 evaluation 的身份字段是 decode 失败 |
| ISO-2 | evaluation 实体禁止携带 `runId / sessionId / attemptId / turnId / operationEpoch`；runtime 实体禁止携带 `evaluationRunId / candidateSha / seed / caseSetHash` |
| ISO-3 | evaluation 平面的 `contextOperationId` 必须是 `eval-` + `evaluationRunId` 派生的命名空间值，不可与任何产品 `contextOperationId` 相同（具体字符集待 P0 对照 `shared/validation.ts` 的 `PACTILE_LOGICAL_ID_PATTERN`） |
| ISO-4 | runtime 实体只通过 Host 端口（RunLedger / Artifact / Manifest / Receipt）持久化；evaluation 实体只写评测结果根目录。任一平面都不得向另一平面的存储写入 |
| ISO-5 | 评测不持有产品 store 的活句柄；需要产品数据时只读取**只读快照导出**（以 `snapshotHash` 标识）。评测 runner 不持有 lease / epoch |
| ISO-6 | 跨平面引用单向：evaluation → 产品快照 hash。产品侧任何实体不得引用 `evaluationRunId` 或评测报告来推进状态 |
| ISO-7 | `PairedComparisonReport.affectsProductRun` 恒为 `false`；评测 `pass/fail/blocked/unverified` 不得转写为 `RunV1` 的 `completed/settled`，也不是 Kernel Evidence。若某个 Task Review 想引用报告，只能走既有 Review 流程按 hash 引用 |
| ISO-8 | 评测产生的任何 receipt 都标注 `plane:"evaluation"`，EffectGateway / RunLedger 看到该标记必须拒绝入账 |

## 3. 共用约定

### 3.1 schema 标识与版本

```ts
interface SchemaHeaderV1 {
  schemaId: string;        // 例如 "pactile.cg.retrieval-candidate"
  schemaVersion: number;   // 按 schemaId 独立递增，正整数
}
```

`generation_mismatch` / `epoch_mismatch` / `stale` / `revision_mismatch` 互不替代；`cancelled` 与 `timeout` 必须可区分；`unconvertible` 的完整判定规则、状态→实体适用性矩阵见 `09-contract-entities-v1.zh-CN.md` §3。

规则：版本号**只在同一 `schemaId` 内比较**。未知 `schemaId` 或未知 `schemaVersion` 的 persisted 数据解码为 `invalid_response`（见 §3.3 的状态映射），不能当作空值或默认值。

### 3.2 命名裁定（拟议，回应阻断项 BL-06）

架构 §27.4 的 `RetrievalPlanV2` 与现有 ABI `RetrievalPlanV3`（`packages/cli/src/pactile/retrieval/types.ts`，验证链 `candidate → corroborate → classify-evidence → check-assurance → accept-or-stop`）同名系列，容易被读成 V2 < V3 的升级关系。拟议裁定：

1. 保持文档与评测里的名称 `RetrievalPlanV2`（与架构文档一致），其 `schemaId = "pactile.cg.retrieval-plan"`、`schemaVersion = 2`。TypeScript 符号建议为 `ContextRetrievalPlanV2`，以避免与 ABI 符号冲突。
2. 两者**不是**升级关系：`RetrievalPlanV3` 描述单个 claim 的证据验证链；`RetrievalPlanV2` 描述一次上下文检索的**多分支召回、融合、预算和降级**。
3. V2 通过 `abiPlan: RetrievalPlanV3 | null` 引用验证链（需要 claim 验证时），不复制其字段。
4. 对 ABI 的任何修改不属于本契约；ABI V3 的 ref 语法限制（不能表达行号/大写路径）由 §4.4 的 `SourcePointerV1` 吸收，**不静默重编码**。

该裁定需要评审确认；在确认前，所有文档把它称为“Context Governance 的 RetrievalPlanV2”。

### 3.3 一等状态：`ObservedV1<T>`

任何来自外部事实（工作树、provider、store、manifest）的值，都必须用 `ObservedV1<T>` 表达，**没有默认值**：

```ts
type FactStatusV1 =
  | "ok"
  | "unknown" | "stale" | "missing" | "permission_denied"
  | "revision_mismatch" | "epoch_mismatch"
  | "generation_mismatch" | "wrong_dimension"      // P0 新增（见 09 §3）
  | "provider_unavailable" | "invalid_response" | "timeout" | "cancelled"
  | "unconvertible"                                // P0 新增（见 09 §3）
  | "manifest_conflict";

type ObservedV1<T> =
  | { status: "ok"; value: T; observedAt: string; basis: ObservationBasisV1 }
  | { status: Exclude<FactStatusV1, "ok">; reason: ReasonV1; observedAt: string;
      basis: ObservationBasisV1 | null; evidenceRef: ArtifactRefV1 | null };

interface ObservationBasisV1 {            // 观测依据（用于判断 stale / mismatch）
  sourceRevision: SourceRevisionRefV1 | null;
  generation: GenerationRefV1 | null;
  operationEpoch: number | null;          // runtime 平面必填
}
interface ReasonV1 { code: string; detailHash: string | null }   // code 来自封闭枚举（各线定义），不写自由文本
```

**唯一来源与适用范围（修复轮）**：

- 上面的 `FactStatusV1`（15 成员）是本契约的**唯一类型声明**；`09` §3 是语义与适用性登记。其他文档只能引用，或声明本实体的**适用子集**（用 `Exclude<FactStatusV1, ...>` 表达，例如 `RetrievalPackV1.coverage[].status` 排除 `wrong_dimension`）。任何重新声明成员列表的写法（含检索线的 `RetrievalFactStatusV1`）作废（`05` §2.1 CF-07）。
- **折叠注册表（封闭；唯一）**：P0 只存在两条折叠，且只能在 `09` §3.2.2 列出的折叠层执行（判据 = 目标层在 `09` §3.1 中为 `—`）：

  | 源状态 | 折叠目标 | `reason.code` | 允许折叠的层 | 原生层（**不得**折叠） |
  | --- | --- | --- | --- | --- |
  | `wrong_dimension` | `invalid_response` | **`cg-wrong-dimension`**（两线共用同一个码） | `RK.coverage[]` / `RK.rejected[]`；`CJ.action`；压缩内容实体 `CU` / `CM` / `CDQ` / `CDR` / `CAR` | `PCS` / `RC` / `RP` / `OBS` / `ERM` / `PCR` |
  | `unconvertible` | `invalid_response` | `compression-pointer-unconvertible`（仅压缩线发生此折叠；检索线原生可表达） | 压缩内容实体 `CU` / `CM` / `CJ` / `CDQ` / `CDR` / `CAR` | `SP` / `RC` / `RK` / `OBS` / `ERM` / `PCR`（原 pointer 原样保留）；**`IR` 不在原生层内**——`IR` 不承载 `unconvertible`（`09` §3.1 矩阵该格为 `—`；检索线 `02` §3.2 AP-3） |

- **永不折叠**：`timeout`、`cancelled`、`invalid_response`、`unknown`、`stale`、`missing`、`permission_denied`、`revision_mismatch`、`epoch_mismatch`、`provider_unavailable`、`manifest_conflict`、`generation_mismatch` 在所有实体上保持原值。`timeout` ≠ `cancelled`（**该工作单元自身** deadline 到期 = `timeout`；调用方取消、上层 / 父级 deadline 触发的 abort、operation 撤销、epoch fence、预算耗尽、early stop = `cancelled`，取消源用线内诊断码记录）、`generation_mismatch` ≠ `stale`、`unconvertible` ≠ `missing`；互换一律是缺陷。
- **`reason.code` 命名空间**：跨线共享码只用 `cg-` 前缀；P0 唯一值的完整集合 = `cg-wrong-dimension`。取消 / 超时的**来源码**是线内诊断码，所有权属各线自己的文档（检索线 `02` §3.4 / §3.5 的 `retrieval-*`；压缩线 `context-unit-manifest-v1` §10.1 的 `compression-*`），本节不另行枚举其成员——它们**不得**被当作折叠码，也不得跨线复制；新增共享码或新增折叠必须同时修改本节与 `09` §3.2.2。已冻结 fixture 中的历史字符串（`retrieval-wrong-dimension`、`compression-wrong-dimension`）只作为只读别名存在，**新写入一律用 `cg-*`**。
- 评测平面不得携带 `operationEpoch`（ISO-2）；仿真 epoch 由 fake 端口的**fixture 内部记录**承载，不得写入 EC / ERM / PCR（`05` §2.1 CF-27）。


| 状态 | 含义 | 允许的处理 | 禁止的转换 |
| --- | --- | --- | --- |
| `unknown` | 无法判定（含 `pending`、effect 结果不明） | 保持、扩大上下文、进入 `waiting` / `assurance_unknown`、人工 reconcile | 转成成功或失败；转成 0 分 |
| `stale` | 来源已过期：generation / freshness 不再有效 | 重建索引、重新 Inspect、降级到 exact + structural | 当作有效候选；静默重用 |
| `missing` | 应存在的对象不存在（artifact、pointer、receipt、文件） | 恢复、报告缺口、阻断 | 返回空数组；当作“无匹配” |
| `permission_denied` | 权限或 scope 不允许 | 阻断、请求授权 | 绕过 Port 直接读取；当作 missing |
| `revision_mismatch` | source revision / branch / worktree 与期望不符 | 重新 Inspect、阻断 | 当作 fresh |
| `epoch_mismatch` | `operationEpoch` / lease epoch / fencing 不符（旧 Attempt、迟到消息） | 拒绝并记为 stale diagnostic | 合并进当前 Attempt |
| `generation_mismatch` | index / semantic / manifest generation 与当前不一致（同 revision 内的 generation 漂移） | 重建该 generation、丢弃候选、降级确定性分支 | 当作低分候选；静默混合两个 generation |
| `wrong_dimension` | embedding 维度与 `ProviderCapabilitySnapshotV1` 不符 | 整批丢弃；降级；记录 provider 缺陷 | 截断 / 补齐维度后接受；当作低分候选 |
| `provider_unavailable` | 依赖的 provider / adapter / store 不可用 | 降级到确定性 fallback，披露原因 | 当作“provider 说没有” |
| `invalid_response` | 返回内容无法 decode，或 hash / scope / 维度校验失败 | 丢弃该响应，降级 | 修补后接受；部分接受 |
| `timeout` | **该工作单元自身**的 deadline 到期 | 使用已有的更低保证结果并披露 | 当作空结果；把上层 / 父级 deadline 触发的 abort 写成 `timeout` |
| `cancelled` | 被取消 / 被停止：调用方（用户 / 上层命令）取消、上层 / 父级 deadline 触发的 abort（取消源是 deadline、机制是 abort）、operation 撤销、epoch fence、预算耗尽、early stop | 使用已有的更低保证结果并披露；取消来源用线内诊断码记录（所有权见下） | 折叠为 `timeout` 或 `ok`；取消后仍产出 `pack_ready`；把自身 deadline 到期写成 `cancelled` |
| `unconvertible` | `SourcePointerV1` → ABI ref 无法表达（行号、大小写、非 ASCII、worktree）；是**转换**失败，不是数据失败 | 显式失败，保留原指针，要求消费方接受 `SourcePointerV1` | 截断行号、改大小写、静默重编码 |
| `manifest_conflict` | Manifest CAS / 身份冲突 | 重新读取并重做，或阻断 | 覆盖写入；静默取最后写入者 |

规则：

- 任何 `score`、`confidence`、`count` 都不得用 `0` 表示“未知”；未知就是 `status != ok`。
- 空列表只有在**覆盖证明**下才有意义（见 RK 的 `coverage` 与 `outcome`）。
- 消费方必须穷尽 `switch`；新增状态需要新的 `schemaVersion`。
- “无匹配”永远只是“在这些分支、这个 generation、这个 revision 下未观察到”，不是“证明不存在”（§27.5：相似度不能证明无匹配）。

#### 与现有 memory durability 失败码的映射（草案，P0 逐项核对）

现有 `agent/memory/durability/index.ts` 的失败码可无损映射到上面的状态：

| 现有码 | → `FactStatusV1` | 备注 |
| --- | --- | --- |
| `memory_artifact_missing` / `memory_manifest_absent` / `memory_receipt_absent` / `memory_disclosure_missing` | `missing` | |
| `memory_artifact_stale` / `memory_manifest_stale` | `stale` | |
| `memory_cas_conflict` / `memory_artifact_conflict` / `memory_receipt_conflict` / `memory_request_conflict` | `manifest_conflict` | `reason.code` 保留原码 |
| `memory_lease_missing` / `memory_lease_fenced` / `memory_lease_expired` | `epoch_mismatch` | |
| `memory_store_denied` | `permission_denied` | |
| `memory_store_unavailable` | `provider_unavailable` | store 视作 adapter 依赖 |
| `memory_basis_conflict` | `revision_mismatch` | |
| `memory_*_corrupt` / `memory_*_hash_mismatch` / `memory_artifact_scope_mismatch` / `memory_scope_mismatch` / `memory_invalid_input` / `memory_content_rejected` | `invalid_response` | |
| `memory_not_durable` / `memory_receipt_pending` / `memory_audit_write_failed` | `unknown` | effect 结果不明，禁止自动 replay |

### 3.4 canonical 化与 hash

- 序列化：`canonicalizePactileJsonV1`；hash：`fingerprintPactileContractV1`，形如 `sha256:<64hex>`。
- 每个实体有 `bodyHash`：对**去掉 `bodyHash`、`createdAt`、各处 `observedAt`** 的 canonical 形式取 hash。因此相同输入（含 provider 响应的 hash）、相同 `policyVersion`、相同 `seed`，在确定性阶段必须得到相同 `bodyHash`——这是 determinism 指标的判据。
- Receipt 类实体另有 `receiptHash`，**包含** `createdAt`。
- 全文不进契约：ContextUnit、候选片段、摘要、rationale、embedding 向量都只以 hash 与 `ArtifactRefV1` 出现（§27.9#3）。

### 3.5 共用外壳与字段矩阵

```ts
interface EnvelopeV1 extends SchemaHeaderV1 {
  plane: "runtime" | "evaluation";
  // —— runtime 身份（plane = runtime）——
  workspaceId?: string; sessionId?: string; runId?: string;
  attemptId?: string; turnId?: string; operationEpoch?: number;
  inputSnapshotHash?: string;
  // —— evaluation 身份（plane = evaluation）——
  evaluationRunId?: string; candidateSha?: CandidateRefV1; dirtyWriteSet?: DirtyEntryV1[];
  seed?: number; caseSetHash?: string; fixtureHash?: string;
  // —— 共用 ——
  contextOperationId?: string;
  sourceRevision?: ObservedV1<SourceRevisionRefV1>;
  generation?: GenerationRefV1;
  policyVersion?: string;
  manifestHash?: string;
  providerCapabilitySnapshot?: SnapshotRefV1;     // { snapshotId, hash }
  createdAt: string;
  provenance: ProvenanceV1;
  bodyHash: string;
}
```

`R` = 必填，`O` = 可选且有规则，`X` = 禁止出现，`—` = 不适用。表头 “A” 指 9 个 Controller 实体（RP/RC/RK/CU/CM/CJ/CDQ/CDR/CAR）。

| 字段 | A · runtime | A · evaluation | EC | ERM | PCR |
| --- | --- | --- | --- | --- | --- |
| `schemaVersion`（及 `schemaId`） | R | R | R | R | R |
| `workspaceId` | R | R¹ | X | X | X |
| `runId` | R | X | X | X | X |
| `evaluationRunId` | X | R | X² | R | R³ |
| `contextOperationId` | R | R⁴ | X | X | X |
| `attemptId` | R | X | X | X | X |
| `turnId` | R | X | X | X | X |
| `operationEpoch` | R | X | X | X | X |
| `sourceRevision` | R⁵ | R⁵ | R⁶ | R⁶ | R⁶ |
| `generation` | 见 §4 各实体 | 同左 | X | O⁷ | X |
| `policyVersion` | 见 §4 各实体 | 同左 | X⁸ | R⁹ | R⁹ |
| `manifestHash` | 见 §4 各实体 | 同左 | X¹⁰ | R¹¹ | R¹² |
| `candidateSha` | X¹³ | R | X | R | R |
| `providerCapabilitySnapshot` | 见 §4 各实体 | 同左 | X | R | R |
| `createdAt` | R | R | R | R | R |
| `provenance` | R | R | R | R | R |
| `caseSetHash` / `fixtureHash` / `seed` / `dirtyWriteSet` | X | R | R（case 自身：`caseSetHash`、`fixtureHash`） | R | R（引用） |

脚注：
1. 评测平面的 `workspaceId` 必须是**快照副本**身份（`workspace.kind = "snapshot"`），不得等于任何活的产品工作区。
2. EC 属于 caseSet，可被多次运行复用，因此不含 `evaluationRunId`。
3. PCR 自己有 `evaluationRunId`，并在 `arms[]` 里引用各臂的 `evaluationRunId`。
4. 评测平面的 `contextOperationId` 使用 ISO-3 的命名空间。
5. 值为 `ObservedV1`：计划时可为 `unknown` / `stale`，但字段本身必须存在。
6. EC / ERM / PCR 里的 `sourceRevision` 指被固定的 fixture 基线（例如 git base commit）；若 fixture 不是 git 仓库则用 `tree-hash`。
7. ERM 的 `generation` 记录评测所用的索引 / semantic generation 快照，可空。
8. EC 使用 `rubricVersion` 而不是 `policyVersion`。
9. 此处为**被测策略集合** `policyVersions[]`，而不是单个运行时策略。
10. EC 使用 `caseSetHash` + `fixtureHash`。
11. ERM 的 `manifestHash` 是其自身 canonical 内容的 hash。
12. PCR 的 `manifestHash` 引用被比较的 ERM；每个臂各自带一个。
13. runtime 平面不用 `candidateSha`；产品代码版本写在 `provenance.producer.buildId`。

### 3.6 支撑类型

```ts
type CandidateRefV1 =                         // develop 目前没有提交，因此必须同时支持 tree-hash（BL-04）
  | { kind: "git-commit"; sha: string }
  | { kind: "tree-hash"; sha256: string; fileCount: number; listHash: string };

interface DirtyEntryV1 { path: string; sha256: string | null; change: "added" | "modified" | "deleted" }

interface SourceRevisionRefV1 {
  kind: "git-commit" | "worktree-snapshot" | "transcript-cursor" | "external-fetch";
  id: string;                                 // commit sha / snapshot hash / `sessionId:seq` / response hash
  worktreeId: string | null;                  // 逻辑 id，不含绝对路径
  branch: string | null;
}

interface GenerationRefV1 {                   // null 表示“不适用”，未知用 ObservedV1 包装
  index: number | null;                       // 结构索引 generation
  semantic: string | null;                    // semanticGeneration（模型 / 维度 / prompt / chunker 任何变化都使其失效）
  manifest: number | null;                    // ContextUnitManifest 的 manifestGeneration
  snapshot: string | null;                    // 索引 snapshot id
}

interface SnapshotRefV1 { snapshotId: string; hash: string }
interface ArtifactRefV1 { artifactId: string; version: number; contentHash: string; storageRef: string }

interface ProvenanceV1 {
  producer: { component: string; version: string; buildId: string | null };
  inputs: { kind: string; hash: string; ref: ArtifactRefV1 | null }[];   // 全部以 hash 引用
  derivedFrom: EntityRefV1[];                                             // 上游实体
  authority: "advisory" | "deterministic" | "host" | "kernel";
  causation: string | null;                                               // 触发该实体的上游 id
  correlation: string;                                                    // 跨线关联 id（不等同于 runId）
}
interface EntityRefV1 { schemaId: string; schemaVersion: number; id: string; bodyHash: string }

interface ProviderCapabilitySnapshotV1 {
  snapshotId: string; hash: string; capturedAt: string;
  providers: {
    role: "decision" | "semantic" | "embedding" | "search" | "summarizer" | "pi-compaction";
    providerId: string; kind: string;
    modelId: string | null;
    protocol: string;
    embeddingDim: number | null;                    // 768 只是 EmbeddingGemma 的默认 profile，不是 Domain truth
    promptVersion: string | null; chunkerVersion: string | null; semanticGeneration: string | null;
    limits: { maxInputTokens: number | null; maxBatch: number | null; timeoutMs: number | null };
    egress: { destination: "local" | "remote"; authorized: boolean; authorizationRef: ArtifactRefV1 | null };
    availability: ObservedV1<"ready" | "degraded">;   // 以独立 probe 为准，不看配置里是否出现名字
    probeRef: ArtifactRefV1 | null;
  }[];
}

// —— T2 独立支撑类型（schemaId 见 09 §1；本节只给共享形状）——
interface PermissionScopeV1 {          // pactile.cg.permission-scope, v1（全文与规则见 09 §1.2.1）
  scopeId: string; readable: boolean; withinScope: boolean; readScopes: string[];
  maxClassification: "public" | "internal" | "restricted";
  actions: { mask: boolean; externalize: boolean; structuredProject: boolean; lossy: boolean };   // 唯一四个动作许可位；不得新增第五位
  egress: { destination: "none" | "local" | "remote"; authorized: boolean; authorizationRef: ArtifactRefV1 | null };
  issuedAt: string;
}

interface FreshnessV1 {                // pactile.cg.freshness, v1（全文见 09 §1.2.2）
  verdict: "fresh" | "stale" | "unknown"; asOf: string;
  basis: { sourceRevision: SourceRevisionRefV1 | null; generation: GenerationRefV1 | null; operationEpoch: number | null } | null;
  mtimeMs: number | null;              // 不得用 0 表示未知
}

interface RestoreTokenV1 {             // pactile.cg.restore-token, v1（Owner 字段表：压缩线 context-unit-manifest-v1 §7.2；本节为共享形状）
  tokenId: string; unitId: string; pointer: SourcePointerV1; contentHash: string;
  manifestRef: EntityRefV1; scopeId: string;
  operationEpoch: number | null;       // runtime 平面：必须为非空整数；evaluation 平面：必须为 null
  evaluationRunId: string | null;      // evaluation 平面：必须非 null；runtime 平面：必须为 null
  issuedAt: string; expiresAt: string | null;
  issuedBy: { component: "host-memory-port"; version: string };
}
// RT-1 平面互斥：operationEpoch 与 evaluationRunId 恰好一个非 null（两者都非 null 或都为 null → decode 失败）。
// RT-2 绑定：runtime = (manifestRef, contentHash, scopeId, operationEpoch)；evaluation = (manifestRef, contentHash, scopeId, evaluationRunId)。
// RT-3 单一 schema：runtime 与 evaluation 共用本 schema，平面差异只体现在 RT-1 的两个字段上（不另立 EvaluationRestoreTokenV1）。
// RT-4 ISO-2 的「评测实体禁止 operationEpoch」在本类型上表达为 operationEpoch = null；仿真 epoch 由 fake 端口内部记录承载，不得写入 token 字段。
// RT-5 字段名唯一为 pointer（历史名 pointerRef 已废止）；见负例 #13。

interface CurrentManifestPointerV1 {   // pactile.cg.current-manifest-pointer, v1（Owner 全文：压缩线 context-unit-manifest-v1 §8.4）
  scopeId: string; workspaceId: string; sessionId: string;
  manifestGeneration: number; manifestHash: string; updatedAt: string;
  updatedBy: { component: "host-manifest-port"; hostOperationId: string };
  previous: { manifestGeneration: number; manifestHash: string } | null;
}

// —— T3 内联结构（无独立 schemaId，随宿主版本化；例外登记见 09 §1.2.5）——
interface RecoverabilityV1 {
  class: "byte_exact" | "semantic_only" | "none";
  pointer: SourcePointerV1 | null;
  restoreTokenRef: EntityRefV1 | null;
  verifiedAt: string | null; verificationHash: string | null;
}

interface TranscriptCursorV1 {
  sessionId: string; branchId: ObservedV1<string>;
  startSeq: number; endSeq: number; startEntryId: string | null; endEntryId: string | null;
}

type AnchorKind =                        // 封闭枚举，22 个成员；由 protection.ruleSetVersion 版本化（非 schema 版本）
  | "user_goal" | "user_constraint" | "file_path" | "symbol" | "line_number" | "content_hash"
  | "revision" | "version_string" | "port" | "url" | "json_literal" | "patch_hunk"
  | "tool_call_id" | "test_assertion" | "error_code" | "config_value" | "rejected_approach"
  | "current_value" | "previous_value" | "evidence_text" | "permission" | "scope";

// 历史名退役：PointerRefV1 的字段语义并入 SourcePointerV1（新增 scheme: "memory"），
// `reopenable` 并入 CU.recoverability；两者不得在新的 decoder 输出中出现（CF-13 / CF-17）。
```

`authority` 的取值规则：模型 / embedding / Jev 的输出恒为 `advisory`；确定性规则为 `deterministic`；Policy Gate / EffectGateway 的结果为 `host`；只有 Kernel 命令的结果为 `kernel`。任何实体不得把 `advisory` 升级为 `host` / `kernel`。

## 4. 实体草案

### 4.1 `RetrievalPlanV2`（RP）

```ts
interface ContextRetrievalPlanV2 extends EnvelopeV1 {
  schemaId: "pactile.cg.retrieval-plan"; schemaVersion: 2;
  planId: string;
  requestRef: ArtifactRefV1;                           // 查询只以 hash / pointer 出现
  scope: {
    worktreeId: string; branch: ObservedV1<string>;
    pathScopes: SourcePointerPatternV1[];
    kinds: ("code" | "doc" | "config" | "test" | "external")[];
  };
  branches: {
    branch: "exact" | "lexical" | "structural" | "relation" | "semantic" | "external_search";
    mode: "authoritative" | "shadow";                   // shadow：只记录，不进入 pack
    deadlineMs: number; maxCandidates: number;
    providerRef: SnapshotRefV1 | null;                  // 指向 capability snapshot
    fallbackFor: string | null;
  }[];
  fusion: { method: "rrf" | "none"; k: number | null; dedupe: "canonical-locator" };
  budget: { maxCandidates: number; maxBytes: number; maxTokens: number | null; deadlineMs: number };
  abstain: { allowed: boolean; requireFullCoverage: boolean };
  egress: { remoteAllowed: boolean; authorizationRef: ArtifactRefV1 | null };
  abiPlan: RetrievalPlanV3 | null;                      // 验证链计划，不复制其字段（§3.2）
}
```

适用字段：`policyVersion` R；`providerCapabilitySnapshot` R；`generation` O；`manifestHash` O；`sourceRevision` R。`k` 不设默认值，由评测基线选定并记录在 ERM。

不变量：`semantic` 分支在阶段 2 初期只能 `mode:"shadow"`；`external_search` 分支缺少 `egress.remoteAllowed` 与授权引用时不得执行；每个分支必须有 `deadlineMs`，且最小的分支 deadline 不得超过 `budget.deadlineMs`。

### 4.2 `RetrievalCandidate`（RC）

```ts
interface RetrievalCandidateV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.retrieval-candidate"; schemaVersion: 1;
  candidateId: string;                                  // = hash(planId, branch, 规范化 locator)
  branch: "exact" | "lexical" | "structural" | "relation" | "semantic" | "external_search";
  locator: SourcePointerV1;                             // §4.4
  matchKind: "exact" | "lexical" | "symbol" | "edge" | "embedding" | "search_hit";
  branchRank: ObservedV1<number>; branchScore: ObservedV1<number>;   // 仅用于排序，advisory
  semantic: null | {
    embeddingModelId: string; embeddingDim: number;
    promptVersion: string; chunkerVersion: string; semanticGeneration: string;
    similarity: ObservedV1<number>;
  };
  inspect: { status: "not_inspected" } | ObservedV1<InspectResultV1>;
}
```

适用字段：`generation` R（`index` 与 `semantic` 至少一个非 null）；`providerCapabilitySnapshot` R；`policyVersion` O；`manifestHash` O。`provenance.authority` 恒为 `advisory`。

不变量：`semantic.embeddingDim` 必须等于 snapshot 中对应 provider 的 `embeddingDim`；不一致时该候选的原生状态是 `wrong_dimension`（不是低分候选，**不得**在 RC 层提前折叠为 `invalid_response`），进入 `RK` 时按 `09` §3.2.2 折叠为 `invalid_response` + `reason.code = "cg-wrong-dimension"`（折叠只发生在 RK 层）；`search_hit` 在拿到 Fetch → Evidence 之前恒为 `inspect.status = "not_inspected"`，且不得进入 RK.items。

### 4.3 `RetrievalPackV1`（RK）

```ts
type PackOutcomeV1 = "pack_ready" | "pack_empty_observed" | "pack_degraded" | "pack_blocked";

interface RetrievalPackV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.retrieval-pack"; schemaVersion: 1;
  packId: string; planRef: EntityRefV1;
  outcome: PackOutcomeV1;
  items: { candidateRef: EntityRefV1; inspect: InspectResultV1; rank: number }[];   // 只含 Inspect ok 的候选
  rejected: { candidateRef: EntityRefV1; status: Exclude<FactStatusV1, "ok" | "wrong_dimension">; reason: ReasonV1 }[];
  coverage: {
    branch: string; mode: "authoritative" | "shadow";
    status: Exclude<FactStatusV1, "wrong_dimension">; reason: ReasonV1 | null;
    requested: number; returned: number; deadlineMs: number; elapsedMs: number;
  }[];
  fusion: { method: "rrf" | "none"; k: number | null; inputs: { branch: string; candidateIds: string[] }[];
            merged: { keptId: string; mergedIds: string[] }[] };
  fallback: { used: boolean; from: string[]; reasons: ReasonV1[] };
  gaps: { status: Exclude<FactStatusV1, "ok" | "wrong_dimension">; reason: ReasonV1; detailHash: string | null }[];   // 无法归入 rejected / coverage 的缺口（如 provider 报了 coverage 但未给 shard 明细）；**与 rejected 不重叠**
  budget: { usedCandidates: number; usedBytes: number; usedTokens: ObservedV1<number> };
  abstain: { decided: boolean; basis: "full_coverage_no_match" | "insufficient_coverage" | "not_applicable" };
  packHash: string;                                     // 不含 createdAt
}
```

适用字段：`generation` R；`policyVersion` R；`manifestHash` R（引用产生该 pack 的 plan / 索引清单）；`providerCapabilitySnapshot` R。

不变量：
- PK-1 `coverage` 与 plan 中**启用的分支**逐一对应，不多不少。
- PK-2 `pack_empty_observed` 要求所有 `authoritative` 分支 `coverage.status = ok` 且 `items = []`；**任一 authoritative 分支非 ok，则 outcome 至少是 `pack_degraded`**，不得表述为“无匹配”。
- PK-3 `items` 只含 `inspect.status = ok`；其余必须出现在 `rejected`，不得静默丢弃。
- PK-4 `semantic` 分支的相似度、`branchScore` 不进入 `items[].inspect`，也不作为 evidence。
- PK-5 `shadow` 分支的候选只出现在 `coverage` 与评测记录中，不进入 `items`。
- PK-6 `abstain.decided = true` 且 `basis = full_coverage_no_match` 才能表示 no-gold 的“正确 abstain”；它是评测可比较的**观察**，不是事实证明。
- PK-7 `coverage[].status` 与 `rejected[].status` **不得出现** `wrong_dimension`：该状态必须在 `RC` / `PCS` / `OBS` 层保留，进入 pack 前按 `09` §3.2.2 折叠为 `invalid_response` + `reason.code = "cg-wrong-dimension"`，并在 `reason` / `detailHash` 中保留原始维度证据。
- PK-8 折叠是可逆的**观测**而不是可逆的**解码**：评测报告的逐项分布必须在原生层（`ERM` / `PCR`）统计，pack 内的折叠结果不得作为候选缺陷的唯一判据。
- PK-9 `gaps[]` 与 `rejected[]` 互斥：同一缺口不得同时出现在两处；`gaps[]` 只承载「无法归入策略条目的观察缺口」；`gaps[].status` 与 `coverage[].status`、`rejected[].status` 同样受 PK-7 约束。
- PK-10 同一候选在同一 pack 内只能出现在 `items[]`、`rejected[]`、`gaps[]`、`fusion.merged[].mergedIds` 四处中的**恰好一处**（重复候选按 RC-5 走 `mergedIds`）；违反 → decode 失败。

### 4.4 `SourcePointerV1` 与 `InspectResultV1`（支撑；回应 Retrieval B5/B7）

```ts
type SourcePointerV1 =
  | { scheme: "worktree"; worktreeId: string; pathNfc: string;           // NFC 规范化，保留大小写与非 ASCII
      range: { startLine: number; endLine: number; startCol?: number; endCol?: number } | null }
  | { scheme: "artifact"; artifact: ArtifactRefV1 }
  | { scheme: "transcript"; sessionId: string; startSeq: number; endSeq: number }
  | { scheme: "external"; urlHash: string; fetchEvidenceRef: ArtifactRefV1 | null }
  | { scheme: "memory"; unitId: string; manifestRef: EntityRefV1 };      // 修复轮新增：取代 PointerRefV1（CF-17）

interface SourcePointerPatternV1 {              // RP.scope.pathScopes 使用：范围限定，不是具体位置
  scheme: "worktree"; worktreeId: string; pathGlobNfc: string;
}

interface InspectResultV1 {          // 完整字段表（唯一权威；T2 独立支撑类型，schemaId = pactile.cg.inspect-result）
  // —— 身份与位置 ——
  workspaceId: string;               // 快照 / 活工作区身份（09 §2.1 IR 行 = R）
  worktreeId: string; branch: string;
  path: string;                      // 工作树相对路径（保留原始大小写）
  pathNfc: string;                   // NFC 规范化路径；必须等于 NFC(path)，否则 invalid_response
  range: { startLine: number; endLine: number } | null;   // 1-based 闭区间；null = 整文件
  rangeExists: boolean;              // 该 range 在 Inspect 时刻是否仍存在
  symbol: ObservedV1<{ name: string; kind: string; range: { startLine: number; endLine: number } } | null>;
                                     // null = 候选未声明 symbol；非 ok = 无法判定
  // —— hash 与 revision ——
  fileHashRaw: string;               // 来源**原始字节** sha256（与 CU.sourceHash 同概念；不是解码文本 hash，回应 G10）
  lineSliceHash: string | null;      // 行切片 hash；null = 未声明
  textHash: string | null;           // 解码文本 hash；**仅诊断**，不参与 freshness fence、不参与 bodyHash
  sourceRevision: SourceRevisionRefV1;
  generation: GenerationRefV1;       // 索引 / semantic / manifest 快照（`snapshot` 语义由 generation.snapshot 成员承担）
  manifestHash: string | null;       // 校验所依据的 manifest
  // —— 观测 ——
  freshness: FreshnessV1;            // 唯一新鲜度形状（09 §1.2.2）；历史内联 {observedAt, mtimeMs} 映射为 asOf / mtimeMs
  permissions: PermissionScopeV1;    // 唯一权限形状（09 §1.2.1）；内联 {readable, withinScope, scopeId} 是其只读子集
  matchesCandidate: boolean;         // 指针指向的内容是否仍与候选一致
  checks: InspectCheckV1[];          // 逐项检查结果；13 项与检索线 04 §2 逐项对应
  inspectedAt: string;               // Inspect 完成时刻；**不进入 bodyHash**（同 observedAt 规则）
}

interface InspectCheckV1 {           // T3 内联结构，**共享声明位置 = 本节**（随 IR 的 schemaVersion 演进）
  id: "path" | "range" | "symbol" | "file_hash_raw" | "source_revision" | "generation" | "worktree"
    | "branch" | "workspace" | "permission" | "freshness" | "operation_epoch" | "snapshot";
  result: ObservedV1<"pass" | "fail">;
  detailHash: string | null;
}
```

规则：

- `SourcePointerV1` 到 ABI V3 ref 的转换是**显式且可失败**的函数；ref 语法装不下时返回 `unconvertible`，不静默改写（故障注入归属 `FI-20.1`，`04` §6）。`scheme = "memory"` 只指向同一 scope 的已提交清单，**不得**作为检索候选 locator（检索候选必须能 Inspect），也**不得**参与 ABI 转换（直接 `unconvertible`，不得重编码）。
- Inspect 只信任当前工作树的原始字节；Worker 或 provider 给出的 hash、行号只是提示；`fileHashRaw`（原始字节）与 `textHash`（解码文本）不得互相冒充（负例 #25）；`path` 与 `pathNfc` 不得互相冒充（NFC 不符即 `invalid_response`）。
- **唯一字段表**：`InspectResultV1` 与 `InspectCheckV1` 的字段只在本节定义。其他文档（含检索线）只能引用，不得再列一份字段表或改列 `id` 枚举；`InspectCheckV1.id` 的封闭枚举是检查项的唯一来源，检索线 `04` §2 的 13 项检查与该枚举逐项对应（见 `05` §2.1 CF-39）。
- **已删除字段（不得恢复）**：`scopeId`（改用 `permissions.scopeId`）、`snapshot`（改用 `generation.snapshot`）、`operationEpoch`（IR 不携带 epoch 语义：`09` §3.1 IR × `epoch_mismatch` = `—`；epoch 检查结果通过 `checks[].id = "operation_epoch"` 记录，状态由 `ObservedV1` 承载）。

### 4.5 `ContextUnit`（CU）

```ts
interface ContextUnitV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.context-unit"; schemaVersion: 1;
  unitId: string;
  kind: "system" | "user" | "assistant" | "tool_call" | "tool_result" | "retrieval_item"
      | "decision" | "approval" | "evidence_ref" | "summary" | "memory_pointer";
  cursor: TranscriptCursorV1;                           // 必须落在所属 manifest 的 transcriptCursor 范围内
  contentHash: string; byteLength: number;              // 载荷 hash；原文只在 Artifact，不在 unit 里
  sourceHash: string;                                   // 来源**原始字节** hash（与 IR.fileHashRaw 同概念，不同时则 invalid_response）
  tokenEstimate: ObservedV1<{ count: number; tokenizerId: string }>;
  protection: {
    class: "exact_required" | "protected" | "pointer_only" | "compressible" | "unknown";  // 唯一枚举
    ruleSetVersion: string;                             // 变更必须伴随新 policyVersion + 新 manifest generation
    anchors: { kind: AnchorKind; valueHash: string; ordinal: number }[];  // 只存 hash 与序号，不含值
    reasons: ReasonV1[];
  };
  state: "proposed" | "manifest_durable" | "superseded";
  recoverability: ObservedV1<RecoverabilityV1>;         // 取代历史字段 reopenable（CF-13）
  permissions: ObservedV1<PermissionScopeV1>;           // Host / Policy 事实；非 ok → 只能 keep_full / block
  freshness: FreshnessV1;
  pairing: { toolCallId: string | null; pairedUnitId: string | null };
}
```

适用字段：`sourceRevision` R（transcript cursor 版本）；`generation` O；`policyVersion` O；`manifestHash` R；`providerCapabilitySnapshot` O（仅在 tokenizer 等 provider 参与时）。

不变量：`protection.class = "unknown"` 一律按 `exact_required` 处理（fail-closed）；`recoverability.class != "byte_exact"` 的单元不得进入任何 reversible / structured_project 动作，承载 exact anchor 且不可 `byte_exact` 时只能 `keep_full` / `block`；`permissions` 非 ok 时只能 `keep_full` / `block`；`cursor` 必须落在所属 manifest 的 `transcriptCursor` 范围内；tool call 与其 result 必须成对（`pairing`），未配对的不能成为 cut-point（沿用现有 `findValidCutPoints` 语义）。exact / protected 的确定性识别与误判出口唯一引用 Compression 线 `context-unit-manifest-v1` §6.1–§6.3（22 个 `AnchorKind` 成员、 20 条识别规则、误判出口），本节不复述规则内容。

### 4.6 `ContextUnitManifestV1`（CM）

```ts
interface ContextUnitManifestV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.context-unit-manifest"; schemaVersion: 1;
  manifestId: string; manifestGeneration: number;
  supersedes: EntityRefV1 | null;                       // 上一版清单（EntityRefV1）；首版为 null（CF-09）
  unitRefs: { unitId: string; contentHash: string; sourceHash: string;
              protectionClass: "exact_required" | "protected" | "pointer_only" | "compressible" | "unknown";
              recoverabilityClass: "byte_exact" | "semantic_only" | "none";
              pointer: SourcePointerV1 | null }[];
  transcriptHash: string;                               // 对应 `contextSnapshotHashV1(messages)` 的语义
  transcriptCursor: TranscriptCursorV1;                 // 覆盖 unitRefs 的 cursor 并集
  ruleSetVersion: string;                               // 必须与各 unit 的 protection.ruleSetVersion 一致
  coverage: ObservedV1<{ units: number; bytes: number; exactUnits: number; protectedUnits: number; unknownUnits: number }>;
  unitizerVersion: string;
  durable: ObservedV1<{ artifact: ArtifactRefV1; manifestStoreRevision: number;
                        readBackHash: string; readBackRevision: number; currentArtifactId: string }>;  // durable 提交后才为 ok
}
```

适用字段：`manifestHash` 即自身内容 hash；`generation.manifest` R；`policyVersion` R；`providerCapabilitySnapshot` O。

不变量：**`durable.status = ok` 之前，不得向 Policy Gate 提交 CDQ**；`durable.status = ok` 要求 artifact 可读、CAS 成功、read-back 身份比对（`readBackHash` / `readBackRevision` / `currentArtifactId` / 当前指针）全部一致；写入使用 CAS，失败为 `manifest_conflict`，不覆盖。`supersedes` 的 `bodyHash` 必须等于上一版清单的 `manifestHash`，且该 `EntityRefV1` 必须同时出现在 `provenance.derivedFrom` 中；链断裂（前驱缺失、hash 不符、generation 不连续）→ `manifest_conflict`。`basisManifestRef` 与 `permissionsSummary` **不是**本 schema 的规范字段：前者由 `provenance.derivedFrom` 承担，后者若出现只能是显式标记为派生的只读聚合，且不得作为权限 / 权威判据（CF-10 / CF-11）。这对应 §27.7 链路里的 “ContextUnitManifest durable” 一步。

### 4.7 `CompressionJudgment`（CJ）

```ts
type CompressionActionV1 =        // 见 §5：与 §27.6 / 任务书阶段 4 的词汇对齐
  | "keep_full" | "mask_reopenable" | "externalize" | "structured_project"
  | "lossy_compress" | "drop" | "request_review" | "block";

interface CompressionJudgmentV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.compression-judgment"; schemaVersion: 1;
  judgmentId: string;
  subject: { unitIds: string[]; rangeHash: string };
  provider: SnapshotRefV1;                                  // capability snapshot 中的 decision provider
  action: ObservedV1<CompressionActionV1>;                  // 失败时为 timeout / provider_unavailable / invalid_response
  confidence: ObservedV1<{ value: number; calibrationRef: ArtifactRefV1 | null }>;   // value ∈ [0, 1]
  rationaleRef: ArtifactRefV1 | null;
  inputHash: string; responseHash: string | null; latencyMs: number;
}
```

`provenance.authority` 恒为 `advisory`；`confidence` 不是权限、事实或 Evidence。低置信度、schema 不符、超时、provider 不可用都必须降级为确定性规则、保留、外化或 review（§27.6）。

### 4.8 `CompressionDecisionRequest`（CDQ）

```ts
interface CompressionDecisionRequestV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.compression-decision-request"; schemaVersion: 1;
  requestId: string; idempotencyKey: string;
  manifestRef: EntityRefV1;                                  // 必须是 durable 的 CM
  proposals: {
    unitIds: string[]; action: CompressionActionV1;
    effectClass: "none" | "reversible" | "lossy" | "promotion_recommendation";
    judgmentRefs: EntityRefV1[];
    deterministicVerdict: { rule: string; verdict: "allow" | "deny" | "review"; ruleVersion: string };
    rollbackRef: ArtifactRefV1 | null;                       // reversible / lossy 必须非 null
  }[];
  expected: { tokensSaved: ObservedV1<number>; latencyMs: ObservedV1<number> };
  submittedBy: "compression_controller";                     // 字面量
}
```

CDQ 是 Compression Controller **唯一**可以提交的东西。Controller 不持有 lease、不写 Kernel、不调用 EffectGateway；准入由 Host 的 Policy Gate 完成。

### 4.9 `CompressionDecisionReceipt`（CDR）

```ts
interface CompressionDecisionReceiptV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.compression-decision-receipt"; schemaVersion: 1;
  receiptId: string; requestRef: EntityRefV1;
  verdict: "admitted" | "overridden" | "blocked" | "review_required" | "unknown";
  adopted: EntityRefV1[]; overridden: EntityRefV1[];        // 被采用 / 被覆盖的 CJ
  policy: { policyVersion: string; ruleIds: string[] };
  authorization: { class: "none" | "reversible" | "lossy" | "promotion"; grantRef: ArtifactRefV1 | null };
  effect: { operationId: string; ledgerReceiptId: string | null };   // 指向 RunLedger 的 EffectLedgerEntryV1
  lease: { leaseId: string; epoch: number; revision: number };       // runtime 平面必填；evaluation 平面 X
  receiptHash: string;
}
```

这是 **Effect Receipt 的 typed payload**，不是第二套 Receipt authority：权威仍是 RunLedger 的 `EffectLedgerEntryV1`（`operationId, attemptId, turnId, operationEpoch, inputHash, status, receiptId`）；CDR 只补充“采用 / 覆盖 / 阻断了哪个 judgment、依据哪条策略”。`verdict ∈ {admitted, overridden}` 的 runtime CDR 必须能在 ledger 中找到对应 `operationId`，否则视为 `missing`。`review_required` 的人工 / Kernel 审批落点见 §4.14。

### 4.10 `CompactionAuditReceipt`（CAR）

```ts
interface CompactionAuditReceiptV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.compaction-audit-receipt"; schemaVersion: 1;
  auditId: string;
  decisionRef: EntityRefV1;                                  // 对应的 CDR
  compaction: { piCompactionId: string; commitReceiptRef: ArtifactRefV1 | null };   // 与现有 context compaction commit receipt 区分
  snapshots: { beforeHash: string; afterHash: string };
  checks: {
    id: "source_cursor" | "exact_anchor" | "protected_content" | "tool_call_pairing" | "permission"
      | "source_hash" | "source_revision" | "generation" | "worktree_fence" | "semantic_drift"
      | "jev_preservation" | "pointer_reachability" | "manifest_current_pointer" | "memory_read_probe"
      | "epoch_fence" | "supersedes_relation" | "rollback_reference";   // 17 项（修复轮统一）
    result: ObservedV1<"pass" | "fail">; detailHash: string | null;    // 无法判定 = 非 ok，无默认 pass
  }[];
  verdict: "accepted" | "restored" | "expanded" | "blocked" | "waiting" | "assurance_unknown" | "review_required";
  regressionCaseRef: EntityRefV1 | null;                     // EC 的引用（失败时生成）
  receiptHash: string;
}
```

不变量：
- AU-1 只要任一 `checks[].result.status != ok`，或 `value != "pass"`，`verdict` 不得是 `accepted`；`accepted` 的唯一条件是 17 项全部 `pass`。
- AU-2 `verdict ∈ {restored, expanded, blocked, waiting, assurance_unknown, review_required}` 之一，且不存在“静默接受无法重读的结果”的路径（§27.7）。
- AU-3 `memory_read_probe` 必须经 Host / Memory Port 完成，pointer、manifest、权限、source revision、generation、hash 全部校验；`protected_content` / `tool_call_pairing` / `generation` / `worktree_fence` / `manifest_current_pointer` / `supersedes_relation` / `rollback_reference` 均只读检查，audit 期间不得修改 Context / transcript / manifest / artifact。
- AU-4 `epoch_fence` 失败（旧 Attempt / 旧 epoch 的 compaction 结果）→ `epoch_mismatch`，结果只记为 stale diagnostic。
- AU-5 现有 `MemoryContextCompactionReceiptV1`（`kind: "context_compaction_receipt_v1"`）是**提交**回执；CAR 是**审计**回执，二者是不同对象。
- AU-6 `review_required` 只表示“需要外部决定”，**不表示已批准**；它的人工 / Kernel 审批落点见 §4.14，且审批不能把 CAR 追溯改为 `accepted`。
- AU-8 **CAR 没有 `failed` 终态**：audit 自身未能得出结论（检查执行失败 / 依赖不可用且不可等待）唯一映射为 `assurance_unknown`；`blocked` 只保留给确定性拒绝（权限、provenance、不可恢复内容）。任何文档写入 CAR `failed` / `error` 都是缺陷（`09` §2.4、`compression-decision-chain-v1` §7.4.1）。
- AU-7 **旧 10 项 → 新 17 项的映射（不得静默丢弃检查）**：`source_cursor`→`source_cursor`；`exact_anchor`→`exact_anchor`；`permission`→`permission`；`hash`→拆为 `source_hash`（原始字节）+ artifact `contentHash` 比对（后者合入 `memory_read_probe`）；`source_revision`→`source_revision`；`semantic_drift`→`semantic_drift`；`jev_preservation`→`jev_preservation`；`pointer_readable`→`pointer_reachability`（更名）；`epoch_fence`→`epoch_fence`；`memory_read_probe`→`memory_read_probe`；新增 7 项：`protected_content`、`tool_call_pairing`、`generation`、`worktree_fence`、`manifest_current_pointer`、`supersedes_relation`、`rollback_reference`（权威细化见 `compression-decision-chain-v1` §7.1 / §7.5）。旧 10 项名不再使用；`tool_call_pairing` 与 §4.5 的 `pairing` 同源。

### 4.11 `EvaluationCase`（EC）

```ts
interface EvaluationCaseV1 extends SchemaHeaderV1 {
  schemaId: "pactile.cg.evaluation-case"; schemaVersion: 1;
  plane: "evaluation";
  caseId: string; caseSetHash: string; fixtureHash: string;
  category: string;                                          // 封闭枚举，由各线的评测矩阵定义
  repo: { fixtureRepoId: string; baseRevision: SourceRevisionRefV1; snapshotHash: string };
  inputRef: ArtifactRefV1;                                   // 查询 / 对话 / 单元清单，只引用
  labels: {
    gold: { locator: SourcePointerV1; tier: "core" | "optional"; lineMapping: string | null }[];
    negative: { locator: SourcePointerV1; reason: string }[];
    noGold: boolean; wrongRepository: boolean;
    mustPreserveAnchors: string[]; mustNotLeak: string[];
  };
  expect: { allowedStatuses: FactStatusV1[]; outcome: string };   // outcome 来自 RK / CAR 的枚举
  faults: string[];                                          // 故障注入 id（见 04）
  labelProvenance: {
    annotator: string; independentOfCandidateAuthor: boolean | "unknown";
    blind: boolean; baseRevision: string; revisionHistory: { at: string; by: string; changeHash: string }[];
  };
  rubricVersion: string; createdAt: string; provenance: ProvenanceV1; bodyHash: string;
}
```

规则：no-gold 与 wrong-repository 用例有**独立分母**，不混入正样本的 MRR / Recall；gold 在任何运行开始前冻结，修改只能以新 `caseSetHash` 出现，旧版本保留。

### 4.12 `EvaluationRunManifest`（ERM）

```ts
interface EvaluationRunManifestV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.evaluation-run-manifest"; schemaVersion: 1;
  plane: "evaluation";
  evaluationRunId: string;
  candidateSha: CandidateRefV1; dirtyWriteSet: DirtyEntryV1[];
  sourceHashes: { path: string; sha256: string }[];
  caseSetHash: string; fixtureHash: string; seed: number;
  arms: { armId: string; config: unknown; policyVersions: string[] }[];
  providerCapabilitySnapshot: SnapshotRefV1;
  runtime: { node: string; os: string; sqlite: string | null };
  isolation: { workspaceKind: "snapshot"; resultRoot: string; productStoreAccess: "none" | "readonly-export" };
  plannedDenominators: { metric: string; n: number; excludedCases: { caseId: string; reason: ReasonV1 }[] }[];
  stopRules: { id: string; condition: string; action: "stop" | "mark_unverified" }[];
  frozenAt: string;                                          // 必须早于任何结果文件的时间
}
```

规则：**预注册**——`frozenAt` 之后产生的结果才有效；没有 pre-run manifest 的运行一律 `unverified`（旧 v65 的教训：`preRunManifestPresent:false`）。`isolation.productStoreAccess` 不得为活句柄。

### 4.13 `PairedComparisonReport`（PCR）

```ts
interface PairedComparisonReportV1 extends EnvelopeV1 {
  schemaId: "pactile.cg.paired-comparison-report"; schemaVersion: 1;
  plane: "evaluation";
  reportId: string; evaluationRunId: string;
  arms: { role: "baseline" | "treatment"; evaluationRunId: string; manifestHash: string }[];
  pairing: { key: "caseId+seed"; n: number; excluded: { caseId: string; reason: ReasonV1 }[] };
  metrics: {
    name: string; layer: string;
    baseline: ObservedV1<number>; treatment: ObservedV1<number>; delta: ObservedV1<number>;
    n: number; interval: { method: string; seed: number; low: number; high: number } | null;
  }[];
  zeroTolerance: { id: string; violations: number }[];       // generation fence、egress、silent success 等
  gates: { id: string; result: "pass" | "fail" | "blocked" | "unverified"; basis: string }[];
  verdict: "pass" | "fail" | "blocked" | "unverified";
  affectsProductRun: false;                                  // 字面量（ISO-7）
}
```

规则：分母显式；被排除的用例必须列出理由；provider 不可用的臂是 `unverified`，**不是 0 分**；`verdict` 只有 `pass / fail / blocked / unverified`，不含 `completed / settled`。

### 4.14 `review_required` 的人工 / Kernel 审批落点（P0 契约级，回应离场条件 5）

`review_required` 出现在三处：Policy Gate 判决 `review` → CDQ 生命周期状态 `review_required`；CDR `verdict = review_required`；CAR `verdict = review_required`。三处共用同一条路径：

```text
Gate verdict = review / CAR verdict = review_required
  → RunLedger 写入 approval_request 条目（kind: context_operation_review，引用 CDQ / manifestRef / CAR auditId）
  → Context Operation state = waiting；期间不执行任何 reversible / lossy / 新 compaction
  → 人工或 Kernel 走正式审批命令（Kernel command / approval），产生 approvalRef + Evidence 要求
  → 获批：对“尚未执行”的提案必须发起新的 admission（新 contextOperationId / 新 operationEpoch）重走 S2–S6；
         对“已发生的 compaction”（CAR）只允许选择恢复 / 扩大 / 阻断之一，不得追溯改变 audit 结论
  → 拒绝或审批过期：state = blocked，保留旧 Context
```

约束：Controller 不能自批；审批不得由评测 `evaluationRunId`、provider 输出或模型判断发起；审批结果只能经 RunLedger / Kernel 记录，不得写入 CDR 的 `advisory` 字段。**本节的 RunLedger `approval_request` 载荷属于 Host / Kernel 轨道（BL-05）；本节只冻结共享契约与禁止路径，不声称机制已实现，也不得据此把离场条件 5 标为 satisfied。**

## 5. 压缩动作词汇与效果等级（P0 冻结，回应 BL-07；依据 `08` §2.5）

两处词汇不一致：架构 §27.6 列出 `lossy_compress`，任务书阶段 4 与架构 §27.8 表写的是 `drop`。**P0 冻结裁定（`08` §2.5）**：取并集，共 8 个动作；阶段 4 的 shadow 记录全部 8 个。

| 动作 | 效果等级 | 最早可执行阶段 | 准入 |
| --- | --- | --- | --- |
| `keep_full` | none | — | 默认 |
| `mask_reopenable` | reversible | 5 | Policy Gate + durable receipt；原文保留于 Artifact，可逐字节还原 |
| `externalize` | reversible | 5 | 同上；pointer 必须经 `memory.read` 可读 |
| `structured_project` | reversible | 5 | 同上；投影不得成为事实源，原文保留 |
| `lossy_compress` | lossy | 6 | Policy Gate + 正式授权 + post-compaction audit；只限已有 pointer、非事实、低风险说明 |
| `drop` | lossy（破坏性） | **v1 范围内不开放** | 只能作为 shadow judgment 或 `request_review` 的输入（`08` §2.5）；是否开放需要单独决定 |
| `request_review` | control | 4（记录）/ 随时 | 进入人工审查，不改变上下文 |
| `block` | control | 随时 | 不执行任何动作 |

补充：`promotion`（memory / project promotion）不是压缩动作，属于阶段 7 的 Kernel command，因此 CDQ 的 `effectClass: "promotion_recommendation"` 只能产生**建议**。

## 6. 与既有权威的挂接（不新建第二套事实链）

| 实体 | 持久化位置 | 权威 | 说明 |
| --- | --- | --- | --- |
| CDR / CAR | RunLedger 的 Effect ledger 条目（`payloadType` 指向本 schema）+ Artifact 中的 payload；条目里只存 `payloadHash` | `RunLedgerV1` / EffectGateway | 与 `EffectLedgerEntryV1` 的 `operationId / attemptId / turnId / operationEpoch / inputHash / receiptId / idempotencyKey` 对齐 |
| CM | Artifact + Manifest store（经现有 `ContextMemoryDurabilityPort` 的 manifest CAS 形态；新增 manifest **kind**，不新增 store） | Manifest port | `durable.status = ok` 是准入前置 |
| CU | 不单独落库：以 `unitRefs` 的形式进入 CM；原文在 Artifact | Artifact | 满足 §27.9#3：不把 ContextUnit 全文写进高频 Kernel 事实 |
| RP / RC / RK | 冷路径：pack 与候选落 Artifact；RunLedger 只记 `contextOperationId + packHash + outcome` 的操作条目 | Artifact / RunLedger | 嵌入向量不入库到 Kernel 事实 |
| CJ / CDQ | Artifact（advisory 记录） | — | 非事实；只被 CDR 引用 |
| EC / ERM / PCR | 评测结果根目录 | Evaluation Controller（仅限评测事实） | ISO-4 / ISO-7 |
| Kernel Evidence | 只通过 Kernel 命令（Review / Close 流程）提交 | Kernel | 任何本契约实体都不自动成为 Evidence |

## 7. decoder 必须拒绝的负例（P0 将转成 fixture）

1. 同时带 `runId` 与 `evaluationRunId`（ISO-1）。
2. evaluation 实体带 `attemptId` / `operationEpoch`（ISO-2）。
3. `ObservedV1` 中 `status: "ok"` 却没有 `value`；或非 ok 却带了默认 `value: 0` / `[]`。
4. 未知 `schemaId` / `schemaVersion` 被当作空对象接受。
5. RK 的 `coverage` 缺少 plan 中启用的分支（PK-1）。
6. RK 中某 authoritative 分支为 `timeout`，outcome 却是 `pack_empty_observed`（PK-2）。
7. RK.items 中包含 `inspect.status != ok` 的候选（PK-3）。
8. RC 带 `semantic.similarity`，却被直接放入 `items` 的证据字段（PK-4）。
9. RC 的 `embeddingDim` 与 capability snapshot 不一致，却被接受为低分候选；或未在 `RC` / `PCS` / `OBS` 层记为 `wrong_dimension`；或折叠时未按 `09` §3.2.2 带 `reason.code = "cg-wrong-dimension"`。
10. `search_hit` 在没有 Fetch → Evidence 的情况下进入 RK.items。
11. CJ 的 `provenance.authority` 不是 `advisory`；`confidence` 超出 [0, 1] 或为 `NaN`。
12. CDQ 的 `manifestRef` 指向非 durable 的 CM；`rollbackRef` 对 reversible / lossy 为 null。
13. runtime 平面的 CDR 缺 `lease`；evaluation 平面的 CDR 带 `lease`；evaluation 的 receipt 被 EffectGateway 入账（ISO-8）。
14. CAR 在存在失败检查时 `verdict: "accepted"`（AU-1）。
15. PCR 的 `affectsProductRun` 为 `true`，或 `verdict` 为 `completed` / `settled`。
16. ERM 的 `frozenAt` 晚于任一结果文件时间；或 `productStoreAccess` 为活句柄。
17. `bodyHash` 与 canonical 内容不一致；`createdAt` 被计入 `bodyHash`。
18. `drop` 动作被 Policy Gate `admitted`（§5）。

P0 冻结时在此列表之上追加 #19–#28（`generation_mismatch` / `wrong_dimension` / `cancelled` / `unconvertible` / 无授权的外部外发 / 阶段 1 索引写入 / `textHash` 冒充 source hash / 全零占位 hash 等），编号延续，见 `09-contract-entities-v1.zh-CN.md` §6。

## 8. 与现有契约的映射与差距

| 新实体 | 现有最近对应物 | 差距 |
| --- | --- | --- |
| RP | `RetrievalPlanV3`（ABI） | 无多分支、融合、预算、降级、egress；无 `workspaceId / sourceRevision / providerCapabilitySnapshot` |
| RC / RK | `LocalWorkerContextItemV1`、`RetrievalClaimAssessmentV3`、`RetrievalProvenance` | 无一等失败状态；`generation` 为可空 `number`；无 permissions / freshness / contextOperationId |
| CU / CM | `ContextCutPointV1`、`ContextSnapshotRefV1`、`ContextDeltaV1`（`agent/context/compaction.ts`） | 无 unit 粒度、protection、pointer、manifest generation |
| CJ | `DecisionAdviceV1` / `DecisionReceiptV1`（`decision/contract.ts`） | 无 compression 专用 action 词汇与 `ObservedV1` 失败语义 |
| CDQ / CDR | `CompactionDecisionV1`、`decideCompactionV1` | 授权发生在 Pipeline 内；无 Policy Gate、无 effect 关联 |
| CAR | 无（现有只有提交回执 `MemoryContextCompactionReceiptV1`） | 全新 |
| EC / ERM / PCR | 旧评测的 `manifest.json / summary.json / verification.json`（非统一 schema） | 字段不统一；旧 bucket runId 兼作证据身份 |
| `ProviderCapabilitySnapshotV1` | `providers/probes.ts` 的 probe 结果 | probe 只到命令可见性与 index marker，无 egress / 维度 / generation |

## 9. 待评审的问题

已由 `08` 裁定冻结的项标记为“已冻结”；仍有实质选择空间的项保留为待评审。

1. ~~§3.2 的命名裁定是否接受（`RetrievalPlanV2` 与 ABI V3 并存）。~~ **已冻结**（`08` §2.4）；仍需独立 Review 确认表述无歧义。
2. ~~§5 的 8 动作词汇与 `drop` 在 v1 不开放的裁定。~~ **已冻结**（`08` §2.5）。
3. ISO-3 评测命名空间的具体字符集与 `PACTILE_LOGICAL_ID_PATTERN` 的关系。
4. ~~`CandidateRefV1` 的 tree-hash 方案（`listHash` 的定义）是否足够，或是否授权建立基线提交（BL-04）。~~ **已冻结**（`08` §2.3）；tree hash 算法与 `listHash` 定义已写入 `09` §4。
5. CM 是否新增 manifest kind，还是扩展现有 `MemoryCurrentManifestV1`。
6. `tokenEstimate` 的 tokenizer 来源：来自 provider capability snapshot，还是 Host 内置。
7. `RK.items[].rank` 与融合参数 `k` 的取值只记录、不设默认；是否接受由基线测量决定。
8. `09` 脚注 1：支撑类型是否接受独立 `schemaId`，或改为内联并记录例外。**修复轮已裁定**：T2 = 9 项（新增 PS / FR / RT / CMP，`09` §1.1 / §1.2）；T3 内联结构的例外列表见 `09` §1.2.5；仍需 Review 确认。
9. `09` 脚注 2：`PermissionScopeV1` / `FreshnessV1` 的形状是否接受。**修复轮已裁定**：唯一形状见 `09` §1.2.1 / §1.2.2，并与 PCS、检索线内联子集、Compression 布尔许可位建立映射；仍需与 Policy Gate 授权模型对齐（`02` §8）并由 Review 确认。
11. 新增（修复轮）：`protection.class` 唯一枚举、`supersedes: EntityRefV1`、`recoverability` 取代 `reopenable`、`scopeId` 统一、`ruleSetVersion` 与 `policyVersion` 耦合（§4.5）、CAR 17 项与 `review_required` 落点（§4.10 / §4.14）——均需独立 Review 确认；跨线同步义务与验证证据见 `05` §2.1。
10. `08` §3.2 的两种 index 方案（EffectGateway 写 effect / 外置 `indexDir`）在阶段 1 / 2 的选择：P0 只冻结“阶段 1 不写 index”，不预定选择。

另见：`09-contract-entities-v1.zh-CN.md`（实体字段矩阵、14 状态登记表、hash 规则）、`08-p0-admission-decision.zh-CN.md`（P0 入场裁定）。
8. 这些实体在 Protocol / Snapshot 里的暴露面（只读投影）由 Protocol 线单独定义，不在本文内。
