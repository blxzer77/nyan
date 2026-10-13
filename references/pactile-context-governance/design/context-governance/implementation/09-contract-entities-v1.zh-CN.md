# Context Governance Contract v1 · 实体字段矩阵（P0 冻结候选）

- 状态：`proposed`（P0 冻结候选）。本文是 `01-contract-draft.zh-CN.md` 的**实体级补齐**，不替代 `01` 的身份平面、hash 依据与与既有权威的挂接论证。
- 权威依据：`08-p0-admission-decision.zh-CN.md`（P0 入场裁定 12 条）；架构 §27.4、§27.9、§23.3、§26.3。
- 读法：**R** 必填 · **O** 可选且有规则 · **X** 禁止出现 · **—** 不适用。上标数字指向脚注。
- 本文不实现任何 decoder，不产生任何真实 fixture 或 hash。
- 完成声明：本文覆盖 **T1 12 个 Controller/receipt/evaluation 实体 + T2 9 个独立支撑类型 = 登记表 21 行**，并对每个登记项逐项说明 18 个必述项（`schemaId`、`schemaVersion`、`workspaceId`、`runId`、`evaluationRunId`、`contextOperationId`、`sourceRevision`、`generation`、`policyVersion`、`manifestHash`、`candidateSha`、`dirtyWriteSet`、`providerCapabilitySnapshot`、`createdAt`、`provenance`、`freshness`、permission scope、status/lifecycle）。分层、计数与例外登记见 §1.1–§1.3。
- 修复轮声明：本文件在 P0 修复轮被修订（实体计数 17→21、保护分类唯一枚举、权限唯一形状、CAR 17 项与 verdict 7 项、状态折叠规则、RT/CMP 升级为 T2、T4 线内 `schemaId` 登记、hash 命名统一）。**本轮只做共享契约整合与裁定登记，不声称任何结论已通过独立 Review，也不改变 P0 闸门状态。**所有跨线同步义务与未决项见 `05` §2.1 冲突登记表。

## 1. 实体登记表

`plane` 列：`rt` = runtime、`ev` = evaluation、`both` = 两者共用同一 schema、`n/a` = 支撑类型不携带平面身份。

| 简称 | 名称 | schemaId | schemaVersion | plane | 角色 | 权威 / 持久化 | 生命周期字段 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RP | `ContextRetrievalPlanV2` | `pactile.cg.retrieval-plan` | **2** | both | 多分支检索计划 | 派生物：Artifact；RunLedger 仅记 `contextOperationId` | `lifecycle.status`（`drafted/active/superseded`） |
| RC | `RetrievalCandidate` | `pactile.cg.retrieval-candidate` | 1 | both | 候选与观测 | 派生物：Artifact | `inspect.status`、`candidateState` |
| RK | `RetrievalPackV1` | `pactile.cg.retrieval-pack` | 1 | both | 组装结果 | 派生物：Artifact（`packHash`） | `outcome` + `coverage[].status` |
| CU | `ContextUnit` | `pactile.cg.context-unit` | 1 | both | 单元化结果 | 不单独落库；以 `unitRefs` 进 CM，原文在 Artifact | `protection` + `state` |
| CM | `ContextUnitManifestV1` | `pactile.cg.context-unit-manifest` | 1 | both | 单元清单与 CAS | Manifest Port（现有 port，新增 manifest kind） | `durable.status`、`manifestGeneration` |
| CJ | `CompressionJudgment` | `pactile.cg.compression-judgment` | 1 | both | advisory 判断 | Artifact（advisory） | 只增不改：`recorded` |
| CDQ | `CompressionDecisionRequest` | `pactile.cg.compression-decision-request` | 1 | both | 准入请求 | Artifact；RunLedger 记 `requestId` | `submitted → admitted/blocked/review_required` |
| CDR | `CompressionDecisionReceipt` | `pactile.cg.compression-decision-receipt` | 1 | both | 决策 / 效果回执 | **RunLedger Effect ledger 条目** + Artifact payload | `pending → succeeded/failed/unknown → reverted/superseded` |
| CAR | `CompactionAuditReceipt` | `pactile.cg.compaction-audit-receipt` | 1 | both | 压缩后审计回执 | RunLedger Effect ledger 条目 + Artifact payload | `running → <verdict>`（7 值，见 `01` §4.10；`failed` 已删除 → `assurance_unknown`） |
| EC | `EvaluationCase` | `pactile.cg.evaluation-case` | 1 | ev | 用例与 labels | Evaluation Controller（评测事实） | `drafted → frozen → retired` |
| ERM | `EvaluationRunManifest` | `pactile.cg.evaluation-run-manifest` | 1 | ev | 预注册运行清单 | Evaluation Controller | `drafted → frozen → running → completed/aborted/invalid` |
| PCR | `PairedComparisonReport` | `pactile.cg.paired-comparison-report` | 1 | ev | 配对比较报告 | Evaluation Controller | `computed → published → superseded` |
| CARef | `CandidateRefV1` | `pactile.cg.candidate-ref` ¹ | 1 | both | 候选身份 | 结构类型；随宿主实体编解码 | — |
| SP | `SourcePointerV1` | `pactile.cg.source-pointer` ¹ | 1 | both | 来源定位（可失败转换） | 结构类型 | — |
| PCS | `ProviderCapabilitySnapshotV1` | `pactile.cg.provider-capability-snapshot` ¹ | 1 | both | provider 能力与可用性 | Artifact（`snapshotId` + `hash`） | `captured → superseded` |
| IR | `InspectResultV1` | `pactile.cg.inspect-result` ¹ | 1 | both | 工作树校验结果 | 派生物：Artifact | `status`（`ok` 或非 ok 一等状态） |
| OBS | `ObservedV1<T>` | `pactile.cg.observed` ¹ | 1 | both | 观测包装（无默认值） | 包装类型 | 承载 `FactStatusV1` |
| PS | `PermissionScopeV1` | `pactile.cg.permission-scope` ¹ ² | 1 | both | 读取 / 写入 / 外发作用域 | 结构类型 | — |
| FR | `FreshnessV1` | `pactile.cg.freshness` ¹ ² | 1 | both | 新鲜度判定与依据 | 结构类型；消费时重算 | `verdict ∈ fresh/stale/unknown` |
| RT | `RestoreTokenV1` | `pactile.cg.restore-token` ¹ ² | 1 | both | Memory Port 签发的重读句柄 | Host / Memory Port 事实；不新增 store | `issued → expired / revoked` |
| CMP | `CurrentManifestPointerV1` | `pactile.cg.current-manifest-pointer` ¹ ² | 1 | both | 当前清单指针（CAS） | Manifest Port（CAS + expected revision） | `advanced → superseded`（旧值只读保留） |

登记表共 **21 行**（T1 12 + T2 9）；实体计数只以 §1.1 为准。

脚注：
1. **P0 新增裁定（待 Review）**：`01` §3.6 把 CARef / SP / PCS / IR / OBS 定义为内联结构类型，没有独立 `schemaId`。为满足 `08` §5 离场条件 2（“所有实体具有 schema id、schema version、字段表、hash 规则和 provenance”），本文给它们分配独立 `schemaId` 与 `schemaVersion`，使支撑类型的演进与宿主实体**解耦**；同一 `schemaId` 内才比较版本（`01` §3.1）。若 Review 选择“仅内联”，必须显式记录该例外并说明离场条件 2 如何满足。
2. **P0 新增支撑类型**：`PermissionScopeV1`、`FreshnessV1` 是 P0 第一轮为满足“permission scope / freshness 必须逐实体可说明”而引入的显式结构；`RestoreTokenV1`、`CurrentManifestPointerV1` 是修复轮新增的 T2 类型（此前只由 Compression 线文档定义，未被本文登记，见 `05` §2.1 CF-18）。它们都不引入新的 store 或权威，只把原本隐含在 `ObservedV1.basis`、权限检查代码与压缩链路里的语义写成可冻结的字段。

### 1.1 分层与计数（修复轮裁定，回应“17 vs 19”）

修复轮之前，本文声明“17 个实体”，而登记表有 19 行，两者都不再使用。统一为四层，**计数只在本节声明一次**：

| 层 | 定义 | 数量 | 成员 |
| --- | --- | --- | --- |
| **T1 Controller / receipt / evaluation 实体** | 有平面身份、有生命周期、有独立持久化或权威挂接 | **12** | RP、RC、RK、CU、CM、CJ、CDQ、CDR、CAR、EC、ERM、PCR |
| **T2 独立支撑类型** | 有独立 `schemaId` + `schemaVersion`；不带 `EnvelopeV1`（无 `bodyHash`/`createdAt`/`plane`）；可被跨线直接引用或独立持久化 | **9** | CARef、SP、PCS、IR、OBS、PS、FR、RT、CMP |
| **T3 内联结构** | 只作为字段出现；随宿主 `schemaVersion` 演进；无独立 `schemaId`（记录例外） | 见 §1.2.5 | `RecoverabilityV1`、`AnchorKind`、`TranscriptCursorV1`、`ProvenanceV1`、`ArtifactRefV1`、`EntityRefV1`、`SnapshotRefV1`、`SourceRevisionRefV1`、`GenerationRefV1`、`DirtyEntryV1`、`ReasonV1`、`ObservationBasisV1`、`InspectCheckV1`、`SourcePointerPatternV1` |
| **T4 线内注册 `schemaId`** | 由某一线的文档注册；跨线引用前必须升级为 T2 | 16 | 见 §1.3 |

- 登记表总行数 = T1 + T2 = **21**；`09` 的标题、表格与所有引用按 21 行对齐。
- `01` §1 的“12 个实体” = T1；其支撑类型列表 = T2（修复轮同步为 9 项，见 CF-34）。
- 任务书最初列出的 17 项 = T1 的 12 项 + T2 中当时列出的 5 项（CARef、SP、PCS、IR、OBS）。PS/FR 是 P0 第一轮新增，RT/CMP 是修复轮新增，因此 **“17”不再是当前计数**；任何文档不得再把它当作实体总数（`00` §2 的旧表述属历史遗留，`00` 不在本轮写集内，需后续同步，见 `05` §2.1 CF-31）。
- T2 类型“保留”不等于“已实现”：它们全部是 P0 契约冻结，运行时 decoder 尚未实现。

### 1.2 T2 独立支撑类型：字段表、hash、provenance、plane、生命周期

T2 类型不带 `EnvelopeV1`，其内容通过宿主实体的 `bodyHash` 参与 determinism；平面身份由宿主决定（§2.1 脚注 8）。每个类型必须满足：字段表 + hash 规则 + provenance 规则 + plane 适用性 + 生命周期。

| 类型 | `schemaId` / 版本 | 字段表位置 | hash 规则 | provenance | plane | 生命周期 |
| --- | --- | --- | --- | --- | --- | --- |
| CARef `CandidateRefV1` | `pactile.cg.candidate-ref` / 1 | `01` §3.6 | 定义值：tree-hash 公式（§4） | 由宿主 `provenance.inputs` 记录 | both；runtime 仍禁止 `candidateSha`（ISO-2） | —（不可变值） |
| SP `SourcePointerV1` | `pactile.cg.source-pointer` / 1 | `01` §4.4（修复轮新增 `memory` scheme） | 不可变值；参与宿主 `bodyHash` | 由宿主记录 | both；`external` scheme 需授权引用 | —（不可变值；re-anchor 产生新候选） |
| PCS `ProviderCapabilitySnapshotV1` | `pactile.cg.provider-capability-snapshot` / 1 | `01` §3.6；检索线 `01` §2.2（PCS-1…PCS-6） | `hash` = canonical 内容 hash；`snapshotId` 不透明 | `probeRef` = probe Artifact | 独立持久化时必须带平面身份（§2.1 脚注 8） | `captured → superseded` |
| IR `InspectResultV1` | `pactile.cg.inspect-result` / 1 | **`01` §4.4（唯一字段表，含 additive 字段与 `InspectCheckV1`）** | `fileHashRaw`（原始字节）/ `lineSliceHash` / `textHash`（仅诊断）；`inspectedAt` 不进 `bodyHash` | 由宿主记录；`authority = deterministic` | 独立持久化时带平面身份；**不携带 epoch 语义** | 每次 Inspect 重新产生；不原地改写 |
| OBS `ObservedV1<T>` | `pactile.cg.observed` / 1 | `01` §3.3 | 不含 `observedAt` 时参与宿主 `bodyHash`（`01` §3.4） | 承载 `basis` | both | 值 + 观测时间；重新观测产生新值 |
| PS `PermissionScopeV1` | `pactile.cg.permission-scope` / 1 | §1.2.1（本节） | 参与宿主 `bodyHash` | **`authority ∈ {host, kernel}`**：权限是授权事实，不是模型判断 | both（评测用快照 scope） | `issued → superseded / revoked` |
| FR `FreshnessV1` | `pactile.cg.freshness` / 1 | §1.2.2（本节） | 参与宿主 `bodyHash` | 由宿主记录；`authority = deterministic` | both | `verdict` 在消费时重算，不缓存为事实 |
| RT `RestoreTokenV1` | `pactile.cg.restore-token` / 1 | §1.2.3（本节）；Owner：Compression 线 `context-unit-manifest-v1` §7.2 | 参与宿主 `bodyHash`；token 自身不是 hash 容器 | `issuedBy` = Host / Memory Port（`authority = host`） | both；评测用 fake Memory Port 签发，禁止携带产品 `runId`（ISO-2） | `issued → expired / revoked`；跨 epoch 复用禁止 |
| CMP `CurrentManifestPointerV1` | `pactile.cg.current-manifest-pointer` / 1 | §1.2.4（本节）；Owner：Compression 线 `context-unit-manifest-v1` §8.4 | `manifestHash` 指向 CM；指针值参与对账 | `updatedBy.component = "host-manifest-port"`（`authority = host`） | both | 每次 CAS 前进产生新指针；旧值只读保留 |

#### 1.2.1 `PermissionScopeV1`（唯一权限形状）

```ts
interface PermissionScopeV1 {              // schemaId = "pactile.cg.permission-scope", v1
  scopeId: string;                         // 唯一键（替代历史名 scopeKey）
  readable: boolean;                       // 是否允许读取
  withinScope: boolean;                    // 是否在授权 scope 内
  readScopes: string[];                    // 允许读取的路径 / scope 集合；withinScope=true 时必须非空
  maxClassification: "public" | "internal" | "restricted";
  actions: {                               // 动作许可；缺省 = false（fail-closed）
    mask: boolean;
    externalize: boolean;
    structuredProject: boolean;
    lossy: boolean;                        // 仅阶段 6；v1 期望为 false
  };                                       // 唯一四个动作许可位；不得新增第五位（promotion 不是压缩动作许可）
  egress: {                                // 与 PCS.providers[].egress、EgressAuthorizationV1 同形状
    destination: "none" | "local" | "remote";
    authorized: boolean;
    authorizationRef: ArtifactRefV1 | null; // destination="remote" 且 authorized=true 时必须非 null
  };
  issuedAt: string;
}
```

规则：

1. **分类与许可分离**：内容“是什么”由 `protection.class`（`01` §4.5，五个值）表达；“允许做什么”由本类型表达。两套枚举不得混用（负例 #18）。
2. **无默认可放行**：任一 `actions.*` 缺失或未知按 `false` 处理；`destination="remote"` 而 `authorized != true` 或 `authorizationRef = null` → 拒绝（deny-by-default，`08` §3.4）。
3. **唯一键**：`scopeId` 是唯一名称；Compression 文档旧名 `scopeKey` 与 Retrieval 文档旧名 `scopeId` 统一为 `scopeId`（CF-15）。
4. **历史形状映射**：Retrieval 线的内联 `{ readable, withinScope, scopeId }` 是本类型的只读子集（可无损读入）；Compression 线旧名 `maskable / externalizable / structuredProjectable / lossyAllowed / egressClass` 分别映射到 `actions.{mask, externalize, structuredProject, lossy}` 与 `egress.destination`（`none`→`none`、`local-only`→`local`、`remote-authorized`→`remote` + `authorized: true`）。`promotionRecommendable` **不是**动作许可位，不得映射到任何字段：memory promotion 的批准属 Kernel command（`01` §5 补充段），不由 PS 表达。
5. 权限只由 Host / Policy / Kernel 产生；Controller、provider 与评测不得写入或放宽（`02` O-7 / F-6）。

#### 1.2.2 `FreshnessV1`（唯一新鲜度形状）

```ts
interface FreshnessV1 {                    // schemaId = "pactile.cg.freshness", v1
  verdict: "fresh" | "stale" | "unknown";
  asOf: string;
  basis: { sourceRevision: SourceRevisionRefV1 | null;
           generation: GenerationRefV1 | null;
           operationEpoch: number | null } | null;
  mtimeMs: number | null;                  // 观测值；不得用 0 表示未知
}
```

规则：`verdict = "fresh"` 要求 `basis` 非 null 且与当前消费上下文一致；`unknown` 不得当作 `fresh`；`mtimeMs` 不是判定依据（判定依据是 revision / generation 比对）。

#### 1.2.3 `RestoreTokenV1`（升级为 T2）

字段表 Owner 为 Compression 线 `context-unit-manifest-v1` §7.2；本文登记其身份与不变量：

- 字段：`tokenId`、`unitId`、`pointer`（= `SourcePointerV1`；历史名 `pointerRef` 已废止，Owner 字段表见 `compression/context-unit-manifest-v1` §7.2 与 `01` §3.6）、`contentHash`、`manifestRef`、`scopeId`、`operationEpoch`、`evaluationRunId`、`issuedAt`、`expiresAt`、`issuedBy`。
- **平面规则（唯一）**：runtime 与 evaluation **共用同一个 schema**（不另立 `EvaluationRestoreTokenV1`）；平面差异只体现在两个字段上：

  | 字段 | runtime token | evaluation token |
  | --- | --- | --- |
  | `operationEpoch` | 必须为非空整数，等于所属 Context Operation 的 epoch | **必须为 `null`**（ISO-2） |
  | `evaluationRunId` | **必须为 `null`**（ISO-6） | 必须为非空字符串，等于所属 `evaluationRunId` |

  恰好一个非 null；两个都非 null 或都为 null ⇒ decode 失败（`invalid_response`）。“评测 token 必须带 epoch”与“评测 token 不得出现任何 epoch 字段”都不是正确规则；唯一规则是本表的平面互斥。
- 绑定不变量（runtime）：`(manifestRef, contentHash, scopeId, operationEpoch)` 任一不匹配 → `epoch_mismatch` / `manifest_conflict`，拒绝读取（负例 #13）。绑定不变量（evaluation）：`(manifestRef, contentHash, scopeId, evaluationRunId)` 任一不匹配 → `manifest_conflict`；FI-07 / FI-16 的 epoch fence 仿真由 fake Memory Port 的 fixture 内部记录承载，**不得**写入 token 字段（`05` §2.1 CF-27）。
- token 是**句柄**：不是权限、不是 Evidence、不是授权；`expiresAt = null` 只表示“与 scope 生命周期一致”。

#### 1.2.4 `CurrentManifestPointerV1`（升级为 T2）

字段表 Owner 为 Compression 线 `context-unit-manifest-v1` §8.4；本文登记其身份与不变量：

- `(scopeId, workspaceId, sessionId)` 内唯一的当前指针；`manifestGeneration` + `manifestHash` + `previous` 构成版本链。
- 由 Manifest Port 以 CAS 维护，Controller 只读；`previous` 必须与 CM 的 `supersedes` 一致，否则 `manifest_conflict`。
- 指针不是 Kernel fact，也不是“live context 已压缩”的证明（Pi compaction 结果由 CAR 判定）。
- 读者必须携带自己使用的指针版本；读取时指针已前进 → `manifest_conflict`，重新读取并重做（不得静默使用旧值）。

#### 1.2.5 T3 内联结构（无独立 `schemaId`，记录例外）

| 结构 | 归属 | 版本化方式 | 规则 |
| --- | --- | --- | --- |
| `RecoverabilityV1` | CU（`01` §4.5）/ CM.unitRefs 摘要 | 随宿主 `schemaVersion` | `class ∈ {byte_exact, semantic_only, none}` + `pointer` + `restoreTokenRef` + `verifiedAt` + `verificationHash`；承载 exact anchor 的 unit 必须 `byte_exact`，否则只允许 `keep_full` / `block` |
| `AnchorKind`（封闭枚举，22 个成员） | Compression 线 `context-unit-manifest-v1` §6.1 | **由 `protection.ruleSetVersion` 版本化，不由 schema 版本化**：新增成员必须产生新 `ruleSetVersion` + 新 manifest generation，并保留旧分类记录 | `valueHash` 只存 hash 不存值；成员列表不得原地改写历史清单 |
| `TranscriptCursorV1` | `CU.cursor` / `CM.transcriptCursor` | 随 `01` §4.5 / §4.6 的 `schemaVersion` | `{ sessionId, branchId: ObservedV1<string>, startSeq, endSeq, startEntryId, endEntryId }`；`CU.cursor` 必须落在其 manifest 的 `transcriptCursor` 范围内（CAR check #1 复核） |
| `ProvenanceV1`、`ArtifactRefV1`、`EntityRefV1`、`SnapshotRefV1`、`SourceRevisionRefV1`、`GenerationRefV1`、`DirtyEntryV1`、`ReasonV1`、`ObservationBasisV1` | `01` §3.3 / §3.6 | 随使用它们的宿主 `schemaVersion`；**不发放独立 `schemaId`** | 不得在跨线文档里另立同义结构；出现即按 `05` §2.1 冲突登记处理（ProvenanceV1 是否例外见 §7 未决项） |
| `InspectCheckV1`（13 项）、`SourcePointerPatternV1` | **共享声明位置 = `01` §4.4（修复轮收编）**；检索线 `04` §2 的 13 项检查逐项对应 | 随 IR / RP 的 `schemaVersion` | 共享类型：`id` 封闭枚举只声明一次（`01` §4.4）；其他线不得另立同义枚举（`05` §2.1 CF-39） |
| `PointerRefV1` | 修复轮**退役** | — | 语义并入 `SourcePointerV1`（新增 `scheme: "memory"`）；任何文档继续使用 `PointerRefV1` 名称必须在下一轮同步为 `SourcePointerV1`（CF-17） |

### 1.3 T4 线内注册 `schemaId`（登记或例外）

以下 `schemaId` 由某一线的文档注册使用。P0 处理：**不并入 T2**（避免扩大共享契约面），但必须在本表登记归属与升级条件；跨线引用前必须升级为 T2（补齐字段表 / hash / provenance / plane / 生命周期），否则 decode 视为 `invalid_response`。

| `schemaId` | 归属线 | 宿主 / 载体 | 说明 |
| --- | --- | --- | --- |
| `pactile.cg.egress-authorization` | Retrieval（`08-privacy-egress`） | PCS / PS | 外发授权记录；形状必须与 `PS.egress` 一致（CF-35） |
| `pactile.cg.egress-record` | Retrieval（`08`） | RunLedger / Artifact | 外发审计记录；不是 Effect Receipt |
| `pactile.cg.search-hit` | Retrieval（`07`） | RC（`search_hit`）/ 评测 | Fetch → Evidence 之前不可引用 |
| `pactile.cg.fetch-record` | Retrieval（`07`） | Artifact | Fetch 结果与 hash |
| `pactile.cg.external-evidence` | Retrieval（`07`） | Artifact | 可引用证据 |
| `pactile.cg.semantic-search-request` / `-result` | Retrieval（`01`） | SemanticProvider 端口 | 响应不得含未授权路径（SC-8） |
| `pactile.cg.semantic-candidate` | Retrieval（`01`） | provider → RC | provider 侧候选；`embeddingDim` 必须与 snapshot 一致 |
| `pactile.cg.semantic-generation` | Retrieval（`03`） | generation tuple | semantic generation 标识 |
| `pactile.cg.semantic-index-manifest` | Retrieval（`03`） | 索引方案 A/B/C | 索引清单；不得成为第二事实源（F-11） |
| `pactile.cg.readiness-fixture` / `-result` | Retrieval（`09`） | 评测 | readiness ≠ 质量 |
| `pactile.cg.context-operation` | Compression（决策链 §1.3） | RunLedger Context Operation 条目 | 建议类型：状态线由 RunLedger 承载；P0 只冻结状态集合与转移（Host 轨道义务，BL-05） |
| `pactile.cg.pi-compaction-record` | Compression（决策链 §6） | Artifact + Pi session tree | 建议类型：`treeEntryRef = null` ⇒ 未闭合（BL-13） |
| `DisclosureRecordV1` | `pactile.cg.disclosure-record` | Compression（决策链 S9） | Artifact + CM | 已裁定名称与 schemaId；最小 runtime bridge 已生成 Artifact 并绑定 RunLedger Context Operation，完整失败/并发/crash-replay 证据仍开放 |
| `MemoryReadRecordV1` | `pactile.cg.memory-read-record` | Compression（决策链 S10） | RunLedger Context Operation 条目 | 已裁定名称与 schemaId；最小 runtime bridge 已生成 Artifact 并绑定 RunLedger Context Operation，完整失败/并发/crash-replay 证据仍开放 |

`plane` 与命名空间（`01` §2 的 ISO-1…8）：
- `rt` 实体必须且只能带 `runId / attemptId / turnId / operationEpoch`；
- `ev` 实体必须且只能带 `evaluationRunId`；
- `both` 实体按 `plane` 互斥地选择其中一组，禁止同时出现（负例 #1、#2）。

## 2. 18 个必述项：逐实体适用性矩阵

### 2.1 身份与版本

| 实体 | `schemaId` | `schemaVersion` | `workspaceId` | `runId` | `evaluationRunId` | `contextOperationId` |
| --- | --- | --- | --- | --- | --- | --- |
| RP | R | R（=`2`） | R（rt）/ O³（ev：快照身份） | R（rt）/ X（ev） | X（rt）/ R（ev） | R（两种平面，评测走 ISO-3 命名空间） |
| RC | R | R | R / O³ | R / X | X / R | R |
| RK | R | R | R / O³ | R / X | X / R | R |
| CU | R | R | R / O³ | R / X | X / R | R |
| CM | R | R | R / O³ | R / X | X / R | R |
| CJ | R | R | R / O³ | R / X | X / R | R |
| CDQ | R | R | R / O³ | R / X | X / R | R |
| CDR | R | R | R / O³ | R / X | X / R | R⁴ |
| CAR | R | R | R / O³ | R / X | X / R | R⁴ |
| EC | R | R | X | X | X⁵ | X |
| ERM | R | R | X | X | R | X |
| PCR | R | R | X | X | R⁶ | X |
| CARef | R | R | — | — | — | — |
| SP | R | R | R（经 `worktreeId`）⁷ | — | — | — |
| PCS | R | R | R（rt）/ O³（ev） | O⁸ | O⁸ | O⁸ |
| IR | R | R | R | O⁸ | O⁸ | O⁸ |
| OBS | R | R | — | — | — | — |
| PS | R | R | R（rt）/ O³（ev） | O⁸ | O⁸ | O⁸ |
| FR | R | R | — | — | — | — |
| RT | R | R | R（rt）/ O³（ev） | O⁸ | O⁸ | O⁸ |
| CMP | R | R | R（rt）/ O³（ev） | O⁸ | O⁸ | O⁸ |

3. 评测平面的 `workspaceId` 是**快照副本身份**（`workspace.kind = "snapshot"`），不得等于活的产品工作区（ISO-5）。
4. CDR / CAR 的 `contextOperationId` 由 RunLedger 记账；receipt 自身必须引用同一个 id，不得自造。
5. EC 属于 `caseSet`，可被多次运行复用，因此不含 `evaluationRunId`（`01` §3.5 脚注 2）。
6. PCR 自身带 `evaluationRunId`，并在 `arms[]` 中引用各臂的 `evaluationRunId` 与 `manifestHash`。
7. `SP.worktreeId` 是逻辑 id；绝对路径永不进入契约（`01` §3.6）。
8. 支撑类型本身不决定平面。当它作为某实体的字段出现时，其平面身份由宿主实体决定；**独立持久化**的 PCS / IR 必须带平面身份（用于对账与隔离测试）。

### 2.2 版本化快照与策略

| 实体 | `sourceRevision` | `generation` | `policyVersion` | `manifestHash` | `candidateSha` | `dirtyWriteSet` | `providerCapabilitySnapshot` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RP | R（`ObservedV1`） | R（`GenerationRefV1`，内部字段可 null） | R | R⁹ | X（rt）/ R（ev） | X（rt）/ R（ev） | R |
| RC | R | R | R | R⁹ | X / R | X / R | R |
| RK | R | R | R | R⁹ | X / R | X / R | R |
| CU | R | R（`manifest`） | R | R（自身所属 CM） | X / R | X / R | O¹⁰ |
| CM | R | R（`manifest` + `snapshot`） | R | R（自身 canonical hash） | X / R | X / R | O¹⁰ |
| CJ | R | R | R（判断所用的策略版本） | R¹¹ | X / R | X / R | R（必须记录 advisory provider 的能力快照） |
| CDQ | R | R | R（准入所用 `policyVersion`） | R（`manifestRef` 指向 durable CM） | X / R | X / R | R |
| CDR | R | R | R | R（被批准动作所依据的 CM） | X / R | X / R | R |
| CAR | R | R | R | R（audit 所依据的 CM） | X / R | X / R | O¹⁰ |
| EC | R（fixture 基线） | X | X（用 `rubricVersion`） | X（用 `caseSetHash` + `fixtureHash`） | X | X | X¹² |
| ERM | R | O（索引 / semantic 快照） | R（`policyVersions[]`） | R（自身 canonical hash） | R | R | R |
| PCR | R | X | R（`policyVersions[]`） | R（引用被比较的 ERM，逐臂） | R | R | R |
| CARef | X | X | X | X | 定义值 | X | X |
| SP | R（`worktreeId` / `branch` / `revision`） | O（`index` / `semantic`） | X | X | X | X | X |
| PCS | X | O（`semanticGeneration`） | X | X | X | X | 定义值（自包含） |
| IR | R（被校验时的工作树 revision） | O | X | O（校验所依据的 manifest） | X | X | X |
| OBS | O（经 `basis.sourceRevision`） | O（经 `basis.generation`） | X | X | X | X | X |
| PS | X | X | X | X | X | X | X |
| FR | O（来自 `basis`） | O（来自 `basis`） | X | X | X | X | X |
| RT | X（`unitId`/`contentHash`/`manifestRef` 代替） | X | X | X（由绑定不变量承担） | X | X | X |
| CMP | X | O（`manifestGeneration` / `manifestHash`） | X | X | X | X | X |

9. `manifestHash` 在这些实体中指向**当前 ContextUnitManifest 的 canonical hash**；它不是“某个字段的 hash”，而是准入前置（`01` §6）。
10. 当实体不接受 provider 输入（纯确定性路径）时，`providerCapabilitySnapshot` 为 `O` 且**必须为 null 并附原因**，不得省略字段；一旦使用任何 provider，立即变 `R`。
11. CJ 的 `manifestHash` 指向它所判断的 CM 版本；缺失即为 `unknown` → 判断不可用于准入。
12. EC 的 provider 能力在 ERM 层冻结一次（`providerCapabilitySnapshot`），避免同一 case 在不同 provider 状态下产生两个真相。

### 2.3 时间、来源、新鲜度

| 实体 | `createdAt` | `provenance` | `freshness` |
| --- | --- | --- | --- |
| RP | R | R（`authority: deterministic` 或 `host`） | R：`FreshnessV1`，依据 `basis = {sourceRevision, generation, operationEpoch}` |
| RC | R | R | R（`InspectResultV1.status` 与 `basis` 合成） |
| RK | R | R | R（由各分支 `coverage[].status` 合成；`stale` 分支拉低 pack 新鲜度） |
| CU | R | R | R |
| CM | R | R | R（`durable.status = ok` 且 `manifestGeneration` 为当前值才算 fresh） |
| CJ | R | R（`authority` 恒 `advisory`） | R |
| CDQ | R | R | R |
| CDR | R | R（`authority` 为 `host`，因为准入由 Policy Gate 作出） | R |
| CAR | R | R | R |
| EC | R | R（`annotator` / `labelProvenance` 另列） | O¹³ |
| ERM | R | R | R（`frozenAt` 早于一切结果，`01` §3.4） |
| PCR | R | R | R（`manifestHash` 逐臂核对，任一臂 manifest 失效即 `stale`） |
| CARef | — | — | — |
| SP | R（指向时刻） | R（`kind` + `id` 即来源） | R：`observedAt` + revision 比对 |
| PCS | R（`capturedAt`） | R（`probeRef`） | R：`availability` + `capturedAt`（provider 能力会过期） |
| IR | R | R | R：`observedAt` + `sourceRevision`；跨 revision 即 `stale` |
| OBS | R（`observedAt`） | R（`basis`） | 定义体（`status` 本身即新鲜度结论） |
| PS | R（签发时刻） | R | O（权限会随授权撤销过期） |
| FR | R（`asOf`） | R | 定义体 |
| RT | R（签发时的 scope 校验） | R（`issuedBy`） | R（`issuedAt` + `expiresAt`） |
| CMP | R（`updatedAt`） | R（`updatedBy`） | R（`manifestHash` / `manifestGeneration` 对账） |

13. EC 的 freshness 是 `O`：用例本身是冻结资产，不因时间过期；但如果 `fixtureHash` 指向的 fixture 被替换，则该 case 变为 `stale` 并禁止进入新分母（只能以新 `caseSetHash` 重发）。

### 2.4 权限作用域与状态 / 生命周期

| 实体 | permission scope | status / lifecycle |
| --- | --- | --- |
| RP | R：`readScopes`（允许检索的路径 / scope 集合）；`egress` 默认 `local-only` | `drafted → active → superseded`；非法状态组合 → `invalid_response` |
| RC | R：`readScopes` = 候选所在 scope；`egress` 继承 PCS 授权 | `discovered → inspected(ok) → packed`；任一非 ok 状态留在 `rejected[]` |
| RK | R：并集 = 各候选 scope 的并集；任一分量越权即整体 `permission_denied` | `outcome ∈ {pack_ready, pack_empty_observed, pack_degraded, pack_blocked}`（`01` §4.3） |
| CU | R：`PermissionScopeV1`（`readScopes` + `maxClassification` + `actions`） | `protection.class ∈ {exact_required, protected, pointer_only, compressible, unknown}`（唯一枚举，见 `01` §4.5）+ `protection.ruleSetVersion`；`state ∈ {proposed, manifest_durable, superseded}`；动作许可（mask / externalize / …）**不在** class 里 |
| CM | R：`scopeId` + 单元权限的聚合视图（`ObservedV1`）；聚合不是权限判据 | `durable.status ∈ ok / pending / 非 ok 一等状态`；CAS 冲突 → `manifest_conflict`；`permissionsSummary` 不得作为权限判据（CF-10） |
| CJ | R：只读 scope；`egress` 按 `08` §3.4 deny-by-default | `recorded`（不可改）；重放产生新的 CJ，不覆盖 |
| CDQ | R | `submitted → admitted / blocked / review_required`；`drop` 只能得到 `request_review`（`08` §2.5） |
| CDR | R | `pending → succeeded / failed / unknown → reverted / superseded`；`result: succeeded` 才可 `assurance_exact` |
| CAR | R | `running → <verdict>`；verdict ∈ `{accepted, restored, expanded, blocked, waiting, assurance_unknown, review_required}`（`01` §4.10）；任一检查失败不得 `accepted`（负例 #14）；历史 `failed` 已删除，唯一映射 = `assurance_unknown`（`compression-decision-chain-v1` §7.4.1） |
| EC | R：`mustNotLeak[]` + labels 可见性 | `drafted → frozen → retired(superseded)` |
| ERM | R（评测只读快照） | `drafted → frozen → running → completed / aborted / invalid`（`04` §13） |
| PCR | R（`affectsProductRun: false`） | `computed → published → superseded` |
| CARef | — | — |
| SP | R：`scheme` 决定权限类型（`worktree` / `artifact` / `transcript` / `external`）；`external` 需 `authorizationRef` | — |
| PCS | R：`egress.{destination, authorized, authorizationRef}` | `captured → superseded` |
| IR | R：Inspect 所用只读 scope | `status`（`ok` 或非 ok 一等状态） |
| OBS | —（由宿主实体承担） | `status ∈ FactStatusV1` |
| PS | 定义体 | — |
| FR | — | `verdict ∈ fresh / stale / unknown` |
| RT | R（签发时的 scope 校验） | `issued → expired / revoked`；绑定不匹配 → `epoch_mismatch` / `manifest_conflict` |
| CMP | R（Manifest Port 只读） | `advanced → superseded`；CAS 失败 / 指针前进 → `manifest_conflict` |

> 权限列的统一读法：所有“权限”列都是 `PermissionScopeV1`（§1.2.1）的投影；历史写法 `scopeKey` / `egressClass` / 布尔许可位在修复轮统一为 `scopeId` / `egress.destination` / `actions.*`（跨线同步见 `05` §2.1 CF-03、CF-15、CF-35）。

> CAR 三概念关系（唯一读法，压缩线 `compression-decision-chain-v1` §7.4.1 为 Owner）：`lifecycle` 只有非终态 `running` 与终态；**终态名 = verdict**（7 值）。`review_required` 是 verdict 之一，**不是** lifecycle 分支、也不是 `waiting` 的同义词（`waiting` = 依赖不可用可恢复等待；`review_required` = 必须外部决定）。`failed` 不是 CAR 的合法词：audit 自身未能得出结论 → `assurance_unknown`；确定性拒绝 → `blocked`。

> CDR 两轴分离（与 CAR 无关，防止与 CAR 的 `failed` 删除混淆）：CDR 的 `verdict`（`01` §4.9：`admitted / overridden / blocked / review_required / unknown`）是**决策结果轴**；CDR 的 lifecycle（`pending → succeeded / failed / unknown → reverted / superseded`）是**effect 推进轴**。两轴不得互相推导或覆盖；CDR lifecycle 中的 `failed` 属 effect 轴，**不是** CAR 被删除的生命周期词。

## 3. 一等状态：14 项登记表

**唯一来源**：`FactStatusV1` 的类型声明只允许出现在 `01` §3.3（15 个成员：`ok` + 14 个非 ok 状态）。本文登记语义、禁止转换与实体适用性，**不重新声明成员**。修复轮之前检索线文档中的第二套声明（11 成员）与别名类型 `RetrievalFactStatusV1` 作废（CF-07）。

`generation_mismatch`、`wrong_dimension`、`cancelled`、`unconvertible` 是 P0 新增项；`01` §3.3 已在修复轮同步为 15 成员枚举。

| 状态 | 含义 | 允许的处理 | 禁止的转换 | 典型出现处 |
| --- | --- | --- | --- | --- |
| `unknown` | 无法判定（含 `pending`、effect 结果不明） | 保持、扩大上下文、`waiting` / `assurance_unknown`、人工 reconcile | 转成成功或失败；转成 0 分 | CDR.pending、OBS |
| `stale` | generation / freshness 过期 | 重建索引、重新 Inspect、降级 exact + structural | 当作有效候选；静默重用 | RC、RK、IR、CM |
| `missing` | 应存在的对象不存在 | 恢复、报告缺口、阻断 | 返回空集合；当作“无匹配” | `memory.read`、Artifact、pointer |
| `permission_denied` | 权限或 scope 不允许 | 阻断、请求授权 | 绕过 Port 直读；当作 missing | IR、PS、`memory.read` |
| `revision_mismatch` | source revision / branch / worktree 与期望不符 | 重新 Inspect、阻断 | 当作 fresh | IR、SP、CM |
| `epoch_mismatch` | `operationEpoch` / lease epoch / fencing 不符 | 拒绝并记为 stale diagnostic | 合并进当前 Attempt | CDR、CAR、迟到消息 |
| `generation_mismatch` ¹ | **索引 / semantic / manifest generation 与当前不一致**（同 revision 内的 generation 漂移） | 重建该 generation、丢弃候选、降级确定性分支 | 当作低分候选；静默混合两个 generation 的结果 | RC.semantic、RK.coverage、CM |
| `wrong_dimension` ¹ | embedding 维度与 capability snapshot 不符 | 整批丢弃；降级；记录 provider 缺陷 | 截断 / 补齐维度后接受；当作低分候选 | RC.semantic、PCS |
| `cancelled` ¹ | 被取消 / 被停止：调用方（用户 / 上层命令）取消、上层 / 父级 deadline 触发的 abort、operation 撤销、epoch fence、预算耗尽、early stop | 使用已有的更低保证结果并披露；取消源用线内诊断码记录 | 当作 `timeout` 或空结果；当作 `ok`；把**自身** deadline 到期写成 `cancelled` | 检索分支、provider 调用、评测 runner |
| `invalid_response` | 无法 decode，或 hash / scope 校验失败 | 丢弃该响应，降级 | 修补后接受；部分接受 | CJ、PCS、IR |
| `provider_unavailable` | 依赖的 provider / adapter / store 不可用 | 降级确定性 fallback，披露 | 当作“provider 说没有” | PCS.availability、CJ |
| `timeout` | **该工作单元自身**的 deadline 到期 | 使用已有的更低保证结果并披露 | 当作空结果；把上层 / 父级 deadline 触发的 abort 写成 `timeout` | 分支、provider |
| `manifest_conflict` | Manifest CAS / 身份冲突 | 重新读取并重做，或阻断 | 覆盖写入；取最后写入者 | CM、CDR |
| `unconvertible` ¹ | `SourcePointerV1` → ABI ref 无法表达（行号、大小写、非 ASCII、worktree） | 显式失败；保留原指针；要求消费方接受 `SourcePointerV1` | 截断行号、改大小写、静默重编码（`08` §3.1） | SP、Retrieval → ABI 映射层 |

1. P0 新增，必须同时进入 `01` §3.7 的 decoder 负例与 `04` §6 的故障注入。

`generation_mismatch` 与 `epoch_mismatch`、`stale` 的关系（**互不替代**）：

| 现象 | 正确状态 |
| --- | --- |
| 文件内容变了（同一路径，新 revision） | `revision_mismatch`（若期望 revision 不一致）/ `stale`（若 freshness 过期） |
| 文件没变，但 index / semantic generation 变了 | `generation_mismatch` |
| 旧 Attempt / 旧 lease epoch 的消息到达 | `epoch_mismatch` |
| provider 返回的向量维度 != snapshot 的维度 | `wrong_dimension`，且**不得**降级为 `invalid_response` 之外的“低分” |

`cancelled` 与 `timeout` 的唯一判定规则（与 `01` §3.3、检索线 `02` §3.4 `TC-1` / `TC-10`、压缩线 `context-unit-manifest-v1` §10.1 FD-5 一致；不得再把 deadline / abort / 用户取消混为一类）：

| 触发 | `status` | 来源码（线内诊断码；完整成员表所有权属各线文档） |
| --- | --- | --- |
| **该工作单元自身**的 deadline 到期 | `timeout` | 检索线 `retrieval-deadline-exceeded`（`02` §3.4）；压缩线 `compression-deadline-exceeded`（manifest §10.1 FD-5） |
| 调用方（用户 / 上层命令）主动取消 | `cancelled` | `retrieval-cancelled-by-caller` / `compression-cancelled-by-caller` |
| 上层 / 父级 deadline 触发的 abort（取消源是 deadline，机制是 abort） | `cancelled` | `retrieval-cancelled-by-deadline` / `compression-cancelled-by-deadline` |
| operation 被撤销（上游 abort，非 deadline） | `cancelled` | `retrieval-cancelled-by-operation` / `compression-cancelled-by-operation` |
| epoch fence（旧 Attempt / 旧 epoch 的迟到执行） | `cancelled` | `retrieval-epoch-fenced` / `compression-epoch-fenced` |
| 预算耗尽导致分支未完成 / 未启动 | `cancelled` | `retrieval-budget-exhausted` / `compression-budget-exhausted` |
| plan 显式 early stop 提前停止剩余分支 | `cancelled` | `retrieval-early-stopped` / `compression-early-stopped` |

来源码只解释取消原因，**不改变** `status`，也不是折叠码。二者都不得被折叠为 `ok` 或 0 分，但必须可区分，以便评测统计取消响应上界（架构 §24 的 “取消有上界”）。迟到结果的 `epoch_mismatch` 与本表无关（见上表的 `epoch_mismatch` 行）；预算耗尽 / early stop **不是** `timeout`（分支并未超时，只是被停止）。**成员表所有权**：`retrieval-*` = 检索线 `02` §3.4 / §3.5；`compression-*` = 压缩线 `context-unit-manifest-v1` §10.1 FD-5（**两线均已登记，本列表与 FD-5 逐行对应**）；共享契约不代为登记具体成员。

> 本表在 P0 状态同步轮五按压缩线 16:21–16:24 的落盘重写：此前该行曾写“压缩线的 `timeout` 来源码尚未登记（CF-47）”，该断言已失效（CF-47 已闭合）。

`unconvertible` 的边界：它是**转换**的失败，不是数据的失败。`SourcePointerV1` 本身可以是 `ok`，同时它的 ABI 转换是 `unconvertible`。消费方必须显式处理，禁止 fallback 到“先截断再转换”。

### 3.1 状态 → 实体适用性（统一矩阵，含全部 T2 类型）

| 状态 | RP | RC | RK | CU | CM | CJ | CDQ | CDR | CAR | EC | ERM | PCR | SP | PCS | IR | OBS | PS | FR | RT | CMP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `unknown` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stale` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `missing` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `permission_denied` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| `revision_mismatch` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `epoch_mismatch` | — | — | — | — | ✓ | — | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ | — | — | ✓ | — |
| `generation_mismatch` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ |
| `wrong_dimension` | ✓ | ✓ | — | — | — | — | — | — | — | — | ✓ | ✓ | — | ✓ | — | ✓ | — | — | — | — |
| `cancelled` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `invalid_response` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `provider_unavailable` | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | ✓ | — | ✓ | — | — | — | — |
| `timeout` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `manifest_conflict` | — | — | — | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | ✓ | — | — | ✓ | ✓ |
| `unconvertible` | — | ✓ | ✓ | — | — | — | — | — | — | — | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | — |

`—` 表示该状态在该实体上**不可表示**；decoder 收到即 `invalid_response`（例如 CU 上出现 `epoch_mismatch` 说明上游把 lease 语义写进了内容实体）。

列语义（消除歧义；不允许只在正文段落补充而不进入本矩阵）：

- **PS / FR 列**表示“该类型作为 `ObservedV1<PS>` / `ObservedV1<FR>` 承载时允许出现的 `status`”，`—` 的状态不得写在包装层（例如 `FR` 上不得出现 `permission_denied`）。
- **RT / CMP 列**是 §1.2.3 / §1.2.4 两个 T2 类型自身的适用性：`epoch_mismatch` 属 `RT`（`operationEpoch` 绑定）而**不**属 `CMP`；`provider_unavailable` 由消费方实体（Context Operation）承载，不写在 token / 指针上。
- 本矩阵是“原生可表达”的唯一判定表；它**不**授予折叠权（折叠只按 §3.2.2 的封闭表）。

### 3.2 折叠规则、共享折叠码与适用性补充

#### 3.2.1 折叠不是换名

折叠只允许改变**承载实体**，不改变被观察事实。折叠必须同时满足：目标层在 §3.1 中是 `—`（必要非充分）；该条折叠已在 §3.2.2 的封闭表中登记；原始状态可被 Review 从 `detailHash` / `evidenceRef` 还原。**§3.2.2 的表是 P0 折叠的完备清单**——矩阵里的 `—` 不自动授予折叠权（否则会在 PS / FR / RT / CMP 上产生荒谬折叠）。

#### 3.2.2 唯一授权折叠

| 源状态 | 原生承载层（保留原状态，不得提前折叠） | 折叠层 | 折叠后的值 | 必须记录的 `reason.code` | 禁止 |
| --- | --- | --- | --- | --- | --- |
| `wrong_dimension` | PCS、RC、RP、OBS、ERM、PCR | `RetrievalPackV1.coverage[].status` / `rejected[].status` | `invalid_response` | **`cg-wrong-dimension`**（两线共用的唯一共享折叠码） | 当作低分候选；截断 / 补齐维度；在 RC / OBS / PCS / ERM / PCR 层提前折叠；在 `gaps[]` 丢维度信息；使用非 `cg-` 前缀的折叠码 |
| `wrong_dimension` | 同上 | `CJ.action`（compression advisory） | `invalid_response` | **`cg-wrong-dimension`** | 把 advisory 当作低分建议继续使用（决策链 §5.3#7） |
| `wrong_dimension` | 同上 | 压缩内容实体 `CU` / `CM` / `CDQ` / `CDR` / `CAR` | `invalid_response` | **`cg-wrong-dimension`** | 静默消失；当作低分内容；丢失维度证据（`detailHash` 必填） |
| `unconvertible` | SP、RC、RK、OBS、ERM、PCR（**原生可表达，不得折叠**；**`IR` 不在其中**——`IR` 不承载 `unconvertible`，`09` §3.1 矩阵该格为 `—`，见检索线 `02` §3.2 `AP-3`） | 压缩内容实体 `CU` / `CM` / `CJ` / `CDQ` / `CDR` / `CAR` | `invalid_response` | `compression-pointer-unconvertible`（仅压缩线使用） | 折叠为 `missing`；改写大小写 / 丢行号 / 重编码路径；在检索层提前折叠；把 `IR` 列为原生承载层 |

- **永不折叠（封闭）**：`timeout`、`cancelled`、`invalid_response`、`unknown`、`stale`、`missing`、`permission_denied`、`revision_mismatch`、`epoch_mismatch`、`provider_unavailable`、`manifest_conflict`、`generation_mismatch`。其中：
  - `invalid_response` 是两条折叠的**目标值**，自身不得再折叠；
  - `timeout`（**该工作单元自身** deadline 到期）与 `cancelled`（调用方取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop）必须在所有层级保持区分；取消来源用**线内诊断码**记录（完整成员表：检索线 `02` §3.5、压缩线 `context-unit-manifest-v1` §10.1），这些码**不是**折叠码，不得由折叠产生。
- 除本表外没有其他折叠：`cancelled`≠`timeout`、`generation_mismatch`≠`stale`≠`revision_mismatch`、`unconvertible`≠`missing`；互换一律是缺陷（`01` §3.3 禁止转换列）。
- `reason.code` 命名空间：共享折叠码只用 `cg-` 前缀（P0 完整集合 = `cg-wrong-dimension`）；线内诊断码继续用线内前缀（`retrieval-*`、`compression-*`）；新增共享码或新增折叠必须同时修改本节与 `01` §3.3。
- 折叠是单向的：折叠层不得反向“还原”为原生状态；评测报告的逐项分布必须在原生层统计（ERM / PCR 属原生承载层）。

### 3.3 T2 语义说明（§3.1 矩阵的解释；不含独立 ✓/— 判定）

`RT` 与 `CMP` 的完整 ✓/— 已在 §3.1（P0 修复轮的矩阵已把 PS / FR / RT / CMP 作为列并入，不再另立分表）。本节只解释为何某些状态不在矩阵中：

- `provider_unavailable`：由**消费方实体**（`memory.read` 所在 Context Operation）承载；token / 指针只表达自己的存在性与一致性。
- `revision_mismatch`：RT / CMP 只断言 `manifestRef` / generation 绑定，不断言 source revision，因此收到即 decode 失败。
- `cancelled` / `timeout`：读取动作的取消 / 超时属于请求层（Context Operation），不属于被读取的句柄。

## 4. hash 规则（P0 冻结）

| 规则 | 内容 |
| --- | --- |
| canonical 化 | `canonicalizePactileJsonV1`；hash 为 `fingerprintPactileContractV1`（`sha256:<64hex>`） |
| `bodyHash` | 去掉 `bodyHash`、`createdAt`、所有 `observedAt`、`IR.inspectedAt`、`RT.issuedAt`、`CMP.updatedAt` / `CMP.updatedBy` 后取 hash → 同输入 / 同 `policyVersion` / 同 seed 必须得到相同 `bodyHash`（determinism 判据） |
| `receiptHash` | CDR / CAR 另算，**包含** `createdAt`；receipt 的幂等键不含 `createdAt` |
| `packHash` / `manifestHash` | 对对应实体的 canonical 形式取 hash，作为跨实体引用键；不得用截断 hash |
| **source hash（`IR` / CU）** | **原始字节 hash**（工作树文件 / transcript entry / provider 响应；`08` §3.3）。字段名归属：`IR.fileHashRaw`、`CU.sourceHash`；二者描述同一概念（当单元来源是该文件时必须相等，否则 `invalid_response`），**不得互相冒充**。UTF-8 解码文本 hash 只能作为独立字段 `textHash` 出现（观测，不参与 freshness fence） |
| Worker 文本 hash | 不得通过 freshness fence；`textHash` 与 `sourceHash` 不一致时以 `sourceHash` 为准并记录 `invalid_response` 诊断 |
| 候选身份 | `CandidateRefV1.kind = "tree-hash"`：`<relative-path>\0<file-sha256>\n` 按路径字节序排序后取 SHA-256；路径用 `/`、仓库相对、按字节序排序（`08` §2.3）。不得伪造 git `candidateSha` |
| **占位 hash 禁止** | 缺失 hash 一律 `ObservedV1` 非 ok（`unknown` / `missing`），禁止写入 `sha256:` + 64×`0` 之类的占位值（DEF-IMPL-1 的教训）；decoder 拒绝全零 hash |
| 向量与全文 | ContextUnit 全文、摘要、embedding 向量不进契约，只以 hash + `ArtifactRefV1` 出现（架构 §27.9#3） |

## 5. P0 冻结语义（对应 `08` 的 12 条裁定）

| # | 冻结语义 | 影响的实体 / 阶段 |
| --- | --- | --- |
| 1 | EmbeddingGemma readiness 字段只冻结为**参数 + `unverified`**，不写期望通过值 | PCS、ERM；阶段 2 |
| 2 | 重新基线前的运行时改动冻结并隔离为阶段 1 未评审候选，不回滚、不进 evidence、不继续交错修改 | 所有实体（不得引用其行为作为权威） |
| 3 | 候选身份用 `CandidateRefV1` tree-hash，不伪造 git `candidateSha` | CARef、ERM、PCR |
| 4 | `ContextRetrievalPlanV2`，`schemaId = pactile.cg.retrieval-plan`，`schemaVersion = 2` | RP |
| 5 | 保留 ABI `RetrievalPlanV3` 作为 claim/evidence verification chain，经 `abiPlan` 显式引用；非升级关系，不改 ABI | RP、SP |
| 6 | 压缩动作 8 项并集 | CJ、CDQ、CDR |
| 7 | `drop` 在 v1 只作为 shadow judgment 或 `request_review` 输入，不开放执行 | CDQ、Stage 4 |
| 8 | `SourcePointerV1` 显式表达大小写、非 ASCII、行列范围与 worktree；不可转换时 `unconvertible`，不静默重编码 | SP、RC、RK（**不含 `IR`**，见第 28 条） |
| 9 | 阶段 1 确定性 baseline 默认不写 workspace index；两种后续方案只记录不执行 | RP、Stage 1 |
| 10 | Inspect canonical source hash 用原始字节 hash；解码文本 hash 只能作为 `textHash` | IR |
| 11 | 远程外发 deny-by-default；无 capability policy 与 `egress.authorizationRef` 时拒绝 | PCS、PS、RP、CJ、Stage 2/3/4 |
| 12 | Pi 版本与 provenance 不一致只标 `unverified`；P0 不锁定版本、不升级、不改 lockfile | PCS（`role: pi-compaction`）、ERM |
| 13 | `protection.class` 唯一枚举 = `01` §4.5 的五个值；动作许可由 `PermissionScopeV1.actions` 承担（CF-02 / CF-03） | CU、CM、CJ、CDQ、PS |
| 14 | exact / protected 的确定性识别与误判出口唯一引用 Compression 线 `context-unit-manifest-v1` §6.1（22 个 `AnchorKind`）/ §6.2（20 条规则）/ §6.3（误判出口）；`01` / `09` 不复述规则内容（条件 4） | CU、CM、CAR、EC |
| 15 | CAR `checks[]` = **17 项**（权威细化：`compression-decision-chain-v1` §7.1）；`01` §4.10 与 `04` §8 同步为 17，旧 10 项→新 17 项映射见 `01` §4.10（CF-04） | CAR |
| 16 | CAR `verdict`（7 项）与 CDR `verdict`（5 项）是两个枚举，均含 `review_required`；`review_required` 的人工 / Kernel 审批落点见 `01` §4.14（CF-05 / CF-06） | CAR、CDR、CDQ |
| 17 | `FactStatusV1` 唯一权威 = `01` §3.3（15 成员）；第二套声明与 `RetrievalFactStatusV1` 作废（CF-07） | 全体 |
| 18 | 折叠唯一规则 + 共享折叠码 `cg-wrong-dimension`（§3.2）；除该表外的折叠均为缺陷（CF-08） | RK、CJ、ERM、PCR |
| 24 | `PS.actions` 唯一四个动作许可位 `mask` / `externalize` / `structuredProject` / `lossy`；`promotionRecommendation` 不得存在（CF-40） | PS、CU、CDQ |
| 25 | `RT` 单一 schema + 平面互斥（`operationEpoch` / `evaluationRunId` 恰好一个非 null）；字段名唯一为 `pointer`（CF-41） | RT、CU、CM、memory.read |
| 26 | `IR` / `InspectCheckV1` 字段表与 `id` 枚举唯一声明位置 = `01` §4.4；新增 `IR.gaps[]` 已入 `01` §4.3（CF-39） | IR、RK、检索线 |
| 19 | `RestoreTokenV1` / `CurrentManifestPointerV1` 升级为 T2（独立 `schemaId`）；`PointerRefV1` 并入 `SourcePointerV1`（新增 `memory` scheme）；`RecoverabilityV1` / `AnchorKind` / `TranscriptCursorV1` 为 T3 内联（CF-17 / CF-18 / CF-19） | CU、CM、SP、RT、CMP |
| 20 | `CM.supersedes: EntityRefV1`；`basisManifestRef` 与 `permissionsSummary` 不作为规范字段（分别归入 `provenance.derivedFrom` 与只读聚合）（CF-09 / CF-10 / CF-11） | CM |
| 21 | 字段命名统一：`scopeKey`→`scopeId`；`reopenable`→`recoverability`；`sourceHash` / `fileHashRaw` 等价但不互换；`ruleSetVersion` 变更必须伴随新 `policyVersion`（CF-12…CF-15） | CU、CM、IR、PS |
| 22 | `unconvertible` 的故障注入归属 = FI-20 的**子用例 `FI-20.1`**（不新增全局编号）；CF-23 裁定继续使用该子用例，不新增全局 FI-28 | SP、RC、RK、评测（**不含 `IR`**） |
| 23 | T4 线内 `schemaId` 必须登记（§1.3）；跨线引用前必须升级为 T2，否则 `invalid_response`（CF-20） | 全体 |
| 27 | `wrong_dimension` 的原生层 = PCS / RC / RP / OBS / ERM / PCR；**RC 层不得写 `invalid_response`**（`01` §4.2 已改正，X-11 / R-BL-20）；只有 RK 折叠层可折叠（§3.2.2） | RC、RK、PCS |
| 28 | **`IR` 不承载 `unconvertible`**（§3.1 矩阵该格 = `—`，X-10 / R-BL-19）；`unconvertible` 原生层 = SP / RC / RK / OBS / ERM / PCR | IR、SP |
| 29 | `timeout` = **该工作单元自身** deadline 到期；`cancelled` = 调用方取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop（X-9 / R-BL-19 / 检索线 `SY-14`）；取消来源码所有权属各线文档 | 全体 |

## 6. decoder 负例（P0 冻结；在 `01` §7 的 18 条之上新增 10 条，#19–#28）

19. `generation_mismatch` 被当作低分候选接受，或被合并为一个混合 generation 的 pack。
20. `wrong_dimension` 被截断 / 补齐维度后接受；或在 §3.2.2 未授权的层级、提前折叠；或折叠时缺失 `reason.code = "cg-wrong-dimension"`（维度不符必须可区分、可还原）。
21. `cancelled` 被折叠为 `timeout` 或 `ok`；或取消后仍产出 `pack_ready`。
22. `SourcePointerV1` → ABI ref 转换失败时静默截断行号、改写大小写或重编码路径，而不是返回 `unconvertible`（故障注入归属 `FI-20.1`，`04` §6）。
23. `egress: { destination: "remote", authorized: true }` 但没有 `authorizationRef`（负例：无授权的远程外发）。
24. 阶段 1 的确定性 baseline 实体带 `indexWrite: true` 或任何 workspace 写入意图。
25. `textHash` 被写入 `IR.sourceHash`，或作为 freshness fence 的依据。
26. 任何 hash 字段为全零占位（`sha256:000…0`）或缺席但被当作 `ok`。
27. `CJ.provenance.authority != "advisory"`；`CDR`/`CAR` 的 `authority` 被写成 `advisory`；或把派生摘要（`permissionsSummary`、任一 `ObservedV1` 聚合、manifest 内联统计）当作权限 / 权威判据使用。
28. `PCS` 的 `availability` 由配置中出现 provider 名字推断为 `ready`（必须来自 probe）。
29. 任何文档重新声明 `FactStatusV1` 成员列表或另立本地副本（包括 `type FactStatusV1 = /* 见 01 §3.3 */ unknown;` 这类占位声明）；或把 `wrong_dimension` 折叠为 `cg-wrong-dimension` 以外的码。
30. `PS.actions` 出现 `promotionRecommendation` 或任何第五个许可位；或 `RT` 同时带非空 `operationEpoch` 与非空 `evaluationRunId`（或两者都为空）。
31. `RC.semantic.embeddingDim` 与 snapshot 不一致时，整条候选被写成 `invalid_response`（必须在原生层保留 `wrong_dimension`，只在 RK 折叠层折叠）。
32. `IR` 承载 `unconvertible`（矩阵该格为 `—`；ABI 转换失败属 SP / RC / RK / OBS / ERM / PCR 层，`IR` 只记录 `checks[].id = "range"` 等自身检查结果）。
33. 把**自身** deadline 到期写成 `cancelled`，或把上层 / 父级 deadline 触发的 abort、调用方取消写成 `timeout`；或把取消**来源码**当作折叠码使用。

## 7. 未验证项与待评审

| 项 | 状态 |
| --- | --- |
| 支撑类型的独立 `schemaId`（脚注 1，含 T2 9 项） | 修复轮已裁定为 T2 登记（§1.1 / §1.2 / §1.3）；仍需 Review 确认 |
| `PermissionScopeV1` / `FreshnessV1` 的形状（脚注 2） | 修复轮已统一（§1.2.1 / §1.2.2）；仍需与 Policy Gate 授权模型（`02` §8）对齐并由 Review 确认 |
| `ProvenanceV1` / `ArtifactRefV1` 是否也发放独立 `schemaId` | 未决：修复轮按 T3 内联处理（§1.2.5），Review 可要求升级为 T2 |
| `unconvertible` 的独立 FI 编号 | 已裁定：继续以 `FI-20.1` 子用例承载（`04` §6），不新增全局 FI-28 |
| 跨线同步义务（retrieval / compression 文档的字段与编号对齐） | 已闭合：CF-38…CF-49 与 X-14 均已按当前磁盘事实同步；`retrieval/04` §2 L46 已指向 `01` §4.4，旧 Owner 搜索为 0。逐条证据见 `05` §2.1 |
| `PS.actions` 四位的实现侧含义（是否需要单独表达 memory promotion 建议） | 未决：本轮裁定 promotion 建议**不经** PS 表达（属 Kernel command）；若 Host 轨道需要显式建议位，必须走新增字段 + 新 `schemaVersion` |
| `evaluationRunId` / `contextOperationId` 与 `PACTILE_LOGICAL_ID_PATTERN` 的字符集 | 未验证（`01` §9#3） |
| CM 新增 manifest kind vs 扩展现有 `MemoryCurrentManifestV1` | 未决（`01` §9#5） |
| `tokenEstimate` tokenizer 来源 | 未决（`01` §9#6） |
| EmbeddingGemma 参数真值 | `unverified`（裁定 1） |
| Pi 版本一致性 | `unverified`（裁定 12） |
| 本文任何 hash、fixture、分母 | 共享契约本文未产生；P0 准备资产另见 `evidence/p0/`，仍未冻结运行 hash 或分母 |

> **历史快照（状态同步轮六，2026-10-09）**：本轮读取时记录检索线旧状态；当时 CF-48（N-25 将活跃 retrieval-cancelled-by-deadline 列入已移除码）与 CF-49（三处错误引用 09 §3.2.2 line 395）仍开放。该判断随后被检索线落盘修复覆盖；本文不代改检索文件。CF-20 / CF-23 的命名与编号裁定已落盘；四行闸门保持原样.

> **当前磁盘更正**：复读检索线后，CF-48 / CF-49 已闭合；本注记此前“仍开放”的轮六判断已被后续落盘覆盖。
