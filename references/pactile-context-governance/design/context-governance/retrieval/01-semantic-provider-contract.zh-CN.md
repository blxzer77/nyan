# SemanticProvider / EmbeddingProvider 契约（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。只定义 schema 与不变量，不实现 adapter，不调用任何真实模型，不建索引。
- 依据：架构 §27.5、§27.6、§27.9#3；共享外壳 `../implementation/01-contract-draft.zh-CN.md`（下称 `01`）；共享状态 `../implementation/09-contract-entities-v1.zh-CN.md`（下称 `09`）；P0 裁定见 `../implementation/08-p0-admission-decision.zh-CN.md`（下称 `08`）。
- 状态引用：本文一律使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3，14 项非 ok + `ok`），**不定义本地状态成员**；层级折叠与 `timeout` / `cancelled` 判定见 `02` §3.3 / §3.4。
- 与 `01` 的关系：复用 `EnvelopeV1`、`ObservedV1<T>`、`GenerationRefV1`、`SnapshotRefV1`、`ArtifactRefV1`、`ProvenanceV1`、`ProviderCapabilitySnapshotV1`；本文新增的语义专属类型标注为 **additive**，需在 Review 时同步回 `01`（见 §10）。
- 本文出现的所有 hash / 数值示例均为占位（`sha256:<pending>`），不得被引用为证据。

## 1. 定位

`SemanticProvider` 是**可选的候选发现 provider**。它只能产生「像不像」的候选与排序信号，不是 DecisionProvider，不是总检索引擎，不是 Web Search Provider，不是 Evidence authority，不是当前源事实来源，不是无匹配证明，不是权限判断器，不是产品状态修改器。

```text
DecisionProvider   ── 产出 typed judgment（意图、动作、建议）        authority: advisory（判断）
SemanticProvider   ── 产出「相似候选 + 排序信号」                    authority: advisory（候选）
EmbeddingProvider  ── 产出「文本 → 向量」，不做排序、不做判断         authority: advisory（数值）
Deterministic 分支 ── exact / lexical / structural / relation        authority: deterministic
Host / Policy Gate ── 准入、授权、effect                             authority: host
Kernel             ── Evidence / Close / Settlement                   authority: kernel
```

分离规则（违反即为设计缺陷，不是配置问题）：

| 禁止 | 说明 |
| --- | --- |
| SEM-F1 | SemanticProvider 不得产出或建议 `intent`、分支启用、预算、deadline、`minimumAssurance`、`requestedPolicy`、`stopReasons`。这些属于 plan 与确定性规则。 |
| SEM-F2 | SemanticProvider 不得产出压缩动作（`keep_full` / `mask_reopenable` / …）；那是 `CompressionJudgment`（DecisionProvider 域）。 |
| SEM-F3 | SemanticProvider 不得作为 Evidence、corroboration、`requiredEvidenceKinds` 的来源，也不得填写 ABI V3 的 `evidenceRefs`。 |
| SEM-F4 | SemanticProvider 不得声明「无匹配」「文件不存在」「无权访问」。它只能说「在本次 return 中未观察到」。 |
| SEM-F5 | SemanticProvider 不得成为 Search/Fetch 通道；外部世界只能经 `07-external-search-fetch-evidence`。 |
| SEM-F6 | SemanticProvider 不得跳过 Inspect 直接进入 `RetrievalPackV1.items`。 |
| SEM-F7 | SemanticProvider 不得读写产品状态（Kernel / RunLedger / Memory / 运行时 store）。 |

## 2. 类型

### 2.1 `SemanticProviderStatus`

```ts
type SemanticProviderStatus =
  | "not_configured"     // 计划未启用该分支 —— 不是故障，不产生 fallback
  | "ready"              // 独立 probe 通过，且 generation 与 plan 期望一致
  | "degraded"           // 可用，但能力受限（batch 降低、部分 shard 缺失、维度 profile 回退）
  | "unavailable"        // 探测失败 / 超时 / 连接失败
  | "unsupported";       // 端点存在但不支持所需协议 / 维度 / task prefix
```

`not_configured` 与其余四态语义完全不同：前者表示「本次计划没有这条分支」，后者表示「这条分支被启用但没有可用能力」。只有后者触发 fallback 披露。`SemanticProviderStatus` 与 ABI 的 `RetrievalProviderStatusV3` **不是同一枚举**，二者的映射见 §7。

### 2.2 `ProviderCapabilitySnapshotV1`（引用共享登记，不另立形状）

`01` §3.6 已定义该类型。本文只补充 semantic / embedding 两个 role 的**必填**字段语义与检索侧使用规则（字段名与 `01` 一致，不另立类型）。

```ts
interface ProviderCapabilitySnapshotV1 {
  snapshotId: string;
  hash: string;
  capturedAt: string;
  providers: {
    role: "decision" | "semantic" | "embedding" | "search" | "summarizer" | "pi-compaction";
    providerId: string; kind: string;
    modelId: string | null;
    protocol: string;
    embeddingDim: number | null;
    promptVersion: string | null; chunkerVersion: string | null; semanticGeneration: string | null;
    limits: { maxInputTokens: number | null; maxBatch: number | null; timeoutMs: number | null };
    egress: { destination: "local" | "remote"; authorized: boolean; authorizationRef: ArtifactRefV1 | null };
    availability: ObservedV1<"ready" | "degraded">;
    probeRef: ArtifactRefV1 | null;
  }[];
}
```

检索侧必填与规则：

| 规则 | 内容 |
| --- | --- |
| PCS-1 | `role: "semantic"` / `"embedding"` 的记录必须带 `modelId`、`protocol`、`embeddingDim`、`promptVersion`、`chunkerVersion`、`semanticGeneration`；任一为 `null` 时该 provider 在检索语境中判为 `unsupported`，不得参与计划。 |
| PCS-2 | `availability` 必须来自**独立 probe**（`probeRef` 非 null），不得由「配置里写了这个 provider」推导。 |
| PCS-3 | `egress.destination = "remote"` 且 `authorized = false` 时，该 provider 判为 `unavailable`（策略拒绝，不是网络故障），且产生 `egress` 违规计数前先阻断。 |
| PCS-4 | snapshot 是 plan / candidate / pack 的**引用**（`SnapshotRefV1`），不得复制字段后各自演进；candidate 内的 `embeddingDim` 必须与该引用逐字一致。 |
| PCS-5 | snapshot 里不得出现 endpoint 明文、API key、Bearer token、绝对路径或 workspace 指纹；只允许 `providerId`（逻辑 id）与 `protocol`。 |
| PCS-6 | `768` 只是 EmbeddingGemma 2 的默认 profile 与离线基线，**不是 Domain truth**；`embeddingDim` 是数据字段，不是常量。 |

### 2.3 `EmbeddingProvider`

```ts
interface EmbeddingProvider {
  readonly providerId: string;               // 逻辑 id，不含端点与凭据
  readonly role: "embedding";
  describe(): Promise<ObservedV1<PcsProviderRecordV1>>;   // provider 元数据形状 = PCS（09 §1.2）；不另立 profile 类型
  embed(request: EmbeddingRequestV1, signal: CancellationSignalV1): Promise<EmbeddingResultV1>;
}

// PcsProviderRecordV1 := ProviderCapabilitySnapshotV1.providers[number]（01 §3.6 / 09 §1.2）
// 字段（唯一来源，本文件不重定义）：providerId、kind、modelId、protocol、embeddingDim、
// promptVersion、chunkerVersion、semanticGeneration、limits{maxInputTokens,maxBatch,timeoutMs}、
// egress{destination,authorized,authorizationRef}（CF-35）、availability、probeRef。
// 检索线额外的 generation 参数（precision / normalize / taskPrefix / 预处理版本 / indexSchemaVersion）
// 全部属于 03 §1 的 SemanticGenerationTupleV1（T4 已登记），不重复声明为 provider 字段。

interface EmbeddingRequestV1 {
  items: { itemId: string; kind: "query" | "document" | "title"; textHash: string; textRef: ArtifactRefV1 }[];
  semanticGeneration: string;
  deadlineMs: number;
  egress: EgressDecisionV1;                    // 见 08（引用 09 §1.2.1 PS.egress 形状）
}

interface EmbeddingResultV1 {
  modelId: string;
  dim: number;
  precision: string;
  batchSize: number;
  vectors: ObservedV1<number[][]>;             // status != ok 时不得带零向量占位
  inputHashes: string[];
  latencyMs: number;
  costMetadata: ObservedV1<CostMetadataV1>;
  responseHash: string | null;
}
```

规则：

| 规则 | 内容 |
| --- | --- |
| EMB-1 | 向量必须是有限浮点数；出现 `NaN` / `Infinity`、批内条数不符、顺序不可对齐 → 整批 `invalid_response`（不是低分、不是部分接受）。 |
| EMB-2 | `embeddingDim` 与 PCS 记录不一致 → 原生层（`PCS` / `RC` / `RP` / `OBS` / `ERM` / `PCR`）`wrong_dimension`；**不得**进入向量比较；pack 层按 `09` §3.2.2 折叠为 `invalid_response` + `reason.code = "cg-wrong-dimension"`（不得提前折叠，也不得当成低分）。 |
| EMB-3 | 空输入（`items = []`）必须返回 `dim` 明确、`vectors = []` 的 `ok`，而不是报错或返回占位向量。 |
| EMB-4 | `EmbeddingProvider` 不排序、不解释、不做相似度判断；排序只在 `SemanticProvider` 或检索侧融合中发生。 |
| EMB-5 | 每次调用必须带 `semanticGeneration` 与 `deadlineMs`；无 deadline 的调用非法。 |
| EMB-6 | 请求只传 `textHash` + `textRef`；**是否允许传正文**由 `08` 的 egress 决策决定，本地 provider 可以直接读 `textRef`。 |
| EMB-7 | `costMetadata` 不得包含凭据、账户 id 或原始响应体；只允许 `unitPrice` / `units` / `currency` 或 `not_provided`。 |

### 2.4 `SemanticProvider`

```ts
interface SemanticProvider {
  readonly providerId: string;
  readonly role: "semantic";
  describe(): Promise<ObservedV1<PcsProviderRecordV1>>;   // 同上：PCS 为唯一形状
  search(request: SemanticSearchRequestV1, signal: CancellationSignalV1): Promise<SemanticSearchResultV1>;
}

// 早期草稿的 SemanticProviderProfileV1 已删除（未在任何共享文档登记）。
// provider 元数据 → PCS（01 §3.6 / 09 §1.2）；generation 参数与索引标识 → 03 §1 / §4.1（T4 已登记）。
// 索引可用性（indexId / builtAt / docCount / shardCount）由 SemanticIndexManifestV1（03 §4.1，T4 登记）承担；
// 不得写回 PCS，也不得由 provider 自报作为事实。
```

### 2.5 `SemanticSearchRequestV1`

```ts
interface SemanticSearchRequestV1 extends SchemaHeaderV1 {          // schemaId: "pactile.cg.semantic-search-request", version 1
  plane: "runtime" | "evaluation";
  requestId: string;
  contextOperationId: string;                                        // evaluation 平面为命名空间值（01 ISO-3）
  workspaceId: string;
  worktreeId: string;                                                // 逻辑 id；不得是绝对路径
  branch: ObservedV1<string>;
  scope: { pathScopes: SourcePointerPatternV1[] };                   // 与 plan 完全一致，不允许 provider 自行放宽
  query: { textHash: string; textRef: ArtifactRefV1 };               // 查询本身只以 hash / pointer 传入
  topK: number;
  minScore: ObservedV1<number>;                                      // 不设默认；由 plan 记录
  filters: { kinds: ("code" | "doc" | "config" | "test" | "external")[]; languages: string[] | null };
  generation: GenerationRefV1;                                       // 期望 generation
  semantic: { embeddingModelId: string; embeddingDim: number; promptVersion: string; chunkerVersion: string;
              taskPrefix: string | null; semanticGeneration: string };
  sourceRevision: ObservedV1<SourceRevisionRefV1>;
  permissions: PermissionScopeV1;                                     // 形状见 02 §5.3；不在此重定义
  scopeId: string;                                                   // = PermissionScopeV1.scopeId（09 §1.2.1）
  capabilitySnapshot: SnapshotRefV1;
  deadline: { deadlineMs: number; deadlineAt: string };
  cancellation: { signalRef: string; token: string | null };          // 见 §5
  egress: EgressDecisionV1;                                           // 见 08
  privacy: { allowRemoteText: boolean; redactionProfile: string; dataClasses: string[] };
}
```

### 2.6 `SemanticSearchResultV1` 与 `SemanticCandidateV1`

```ts
interface SemanticSearchResultV1 extends SchemaHeaderV1 {           // schemaId: "pactile.cg.semantic-search-result", version 1
  plane: "runtime" | "evaluation";
  requestId: string;
  status: SemanticProviderStatus;
  provider: { providerId: string; modelId: string; protocol: string; precision: string };
  semanticGeneration: string;
  dim: number;
  candidates: SemanticCandidateV1[];                                  // status != "ready" 时最多为空数组
  coverage: ObservedV1<{ requested: number; returned: number; shardsSearched: number | null; shardsTotal: number | null }>;
  latencyMs: number;
  cost: ObservedV1<CostMetadataV1>;
  responseHash: string | null;
  failure: null | { status: Exclude<FactStatusV1, "ok">; reason: ReasonV1 };   // status != ready 时必填
  capabilitySnapshot: SnapshotRefV1;
  egressRecord: EgressRecordV1 | null;                                // 见 08
}

interface SemanticCandidateV1 extends SchemaHeaderV1 {              // schemaId: "pactile.cg.semantic-candidate", version 1
  candidateId: string;                                                // = hash(requestId, 规范 locator)
  locator: SourcePointerV1;                                           // 必须可被 Inspect 解析
  branch: "semantic";
  matchKind: "embedding";
  similarity: ObservedV1<number>;                                     // advisory，仅用于排序
  similarityMetric: "cosine" | "dot" | "l2";
  chunk: { chunkerVersion: string; chunkId: string; range: { startLine: number; endLine: number } | null;
           contentHash: string | null };                              // 只允许 hash，不允许正文
  generation: GenerationRefV1;
  semantic: { embeddingModelId: string; embeddingDim: number; promptVersion: string; chunkerVersion: string;
              taskPrefix: string | null; semanticGeneration: string };
  sourceRevision: ObservedV1<SourceRevisionRefV1>;
  worktreeId: string; branchName: ObservedV1<string>;
  snapshot: string | null;                                            // 索引 snapshot id
  freshness: FreshnessV1;                                            // 形状见 02 §5.3；不在此重定义
  permissions: PermissionScopeV1;                                    // 形状见 02 §5.3；不在此重定义
  scopeId: string;                                                  // = PermissionScopeV1.scopeId（09 §1.2.1）
  provenance: ProvenanceV1;                                           // authority 恒为 advisory
  capabilitySnapshot: SnapshotRefV1;
}
```

规则：

| 规则 | 内容 |
| --- | --- |
| SC-1 | `SemanticCandidateV1` **不是** `RetrievalCandidateV1`。检索侧必须经 §4 的转换函数生成 `RetrievalCandidateV1`，并保留 `matchKind: "embedding"`。 |
| SC-2 | `similarity` 只能用于排序、去重、聚类、Fetch 优先级与 coverage 统计；不得写入 `RetrievalPackV1.items[].inspect`，不得作为 Evidence，不得影响 `assurance`。 |
| SC-3 | 候选必须携带能被 Inspect 解析的 `locator`（worktree 相对路径 + 行范围，`04`）。缺 locator、只有 embedding id、只有 URL 的候选一律 `invalid_response`（数据 / 契约缺陷），不进入候选池；`unconvertible` **仅**用于「pointer 合法但 ABI V3 ref 语法装不下」（`02` §7 AB-7）。 |
| SC-4 | `status != "ready"` 时 `candidates` 必须为空；不得返回「降级但仍可用的低质量候选」而不标注（如确要返回部分结果，必须用 `status: "degraded"` 且 `coverage` 标明缺口）。 |
| SC-5 | `dim` 与 request / snapshot 不一致时为 `wrong_dimension`；provider 不得自行截断或补零。 |
| SC-6 | provider 返回的错误文本不得进入 `reason.detailHash` 以外的字段；`reason.code` 来自封闭枚举。原始响应体不得入库或入日志。 |
| SC-7 | `similarityMetric` 不同的候选不得直接比较分数；融合只用 rank（§5 的 RRF）。 |
| SC-8 | 结果里不得包含未授权路径：不满足 `permissions.withinScope` 的候选在 provider 侧就被过滤，并由检索侧再次 Inspect 确认。 |

## 3. 公共字段总表（任务书要求的字段 → 落点）

| 要求字段 | 落点 | 说明 |
| --- | --- | --- |
| `embeddingModelId` | `SemanticSearchRequestV1.semantic` / `SemanticCandidateV1.semantic` / snapshot | 参与 generation tuple（`03`） |
| `embeddingDim` | 同上 + `SemanticSearchResultV1.dim` | 768 仅默认 profile |
| `promptVersion` | 同上 | 变化使 generation 失效 |
| `chunkerVersion` | 同上 + `SemanticCandidateV1.chunk.chunkerVersion` | 变化使 generation 失效 |
| `semanticGeneration` | request / result / candidate / snapshot | 变化使 generation 失效 |
| `sourceRevision` | `ObservedV1<SourceRevisionRefV1>` | 计划、请求、候选、Inspect 各层都带 |
| `generation` | `GenerationRefV1` | `index` / `semantic` / `manifest` / `snapshot` |
| `worktreeId` | request / candidate | 逻辑 id，不含绝对路径 |
| `branch` | `ObservedV1<string>` | 未知用 `unknown`，不用空串 |
| `snapshot` | request / candidate / pack | 索引 snapshot id |
| `freshness` | candidate / InspectResult | 一等观测 |
| `permissions` | request / candidate / InspectResult | `readable` + `withinScope` + `scopeId` |
| `provenance` | 全部实体 | `authority = "advisory"` |
| `capabilitySnapshot` | request / result / candidate / pack | `SnapshotRefV1` |
| `deadline` | request | `deadlineMs` + 绝对时间；必须有界 |
| `cancellation` | request + `CancellationSignalV1` | 见 §5 |
| `privacy / egress state` | request.egress / request.privacy / result.egressRecord | 见 `08` |

## 4. 与检索侧的转换

```ts
function toRetrievalCandidateV1(
  candidate: SemanticCandidateV1,
  plan: ContextRetrievalPlanV2,
  snapshot: SnapshotRefV1,
): { status: "ok"; candidate: RetrievalCandidateV1 }
 | { status: "invalid_response" | "wrong_dimension" | "generation_mismatch" | "revision_mismatch" | "permission_denied"; reason: ReasonV1 };
```

转换规则：

| 规则 | 内容 |
| --- | --- |
| CV-1 | 只做字段搬迁与校验，不做补全、不做推断、不做路径改写。 |
| CV-2 | `dim` 不符 → `wrong_dimension`；`semanticGeneration` / `snapshot` 不符 → `generation_mismatch`；`worktreeId` / revision 不符 → `revision_mismatch`。**不得**用 `unconvertible` 表示这四类不一致（`02` §7 AB-7）。 |
| CV-3 | `locator` 包含绝对路径、盘符、UNC、`..` 逃逸、符号链接越界 → `permission_denied`（`retrieval-path-outside-scope`），并记一次 scope 违规计数；格式非法但未越界 → `invalid_response`。两者都不是 `unconvertible`。 |
| CV-4 | 转换结果 `inspect.status = "not_inspected"`；任何 provider 宣称的 `inspected` 标记必须丢弃。 |
| CV-5 | 转换后 `provenance.inputs[]` 必须记录 provider 响应 hash、请求 hash、snapshot hash。 |

## 5. deadline 与 cancellation

```ts
interface CancellationSignalV1 {
  signalId: string;
  deadlineAt: string;                 // 绝对时间，由 plan 派生
  abort: (reason: CancellationReasonV1) => void;
  readonly aborted: boolean;
  readonly reason: CancellationReasonV1 | null;
  onAbort(listener: (reason: CancellationReasonV1) => void): () => void;
}
type CancellationReasonV1 = "deadline" | "caller" | "budget_exhausted" | "operation_cancelled" | "epoch_fenced" | "early_stopped";

// 到状态的映射（权威表见 02 §3.4）：
//   deadline            → timeout   + retrieval-deadline-exceeded
//   caller              → cancelled + retrieval-cancelled-by-caller
//   operation_cancelled → cancelled + retrieval-cancelled-by-operation
//   epoch_fenced        → cancelled + retrieval-epoch-fenced
//   budget_exhausted    → cancelled + retrieval-budget-exhausted
//   early_stopped       → cancelled + retrieval-early-stopped
```

| 规则 | 内容 |
| --- | --- |
| DL-1 | 每次 semantic / embedding 调用必须同时携带 deadline 与 signal；缺一即为非法计划。 |
| DL-2 | 只有 `deadline` 触发 `timeout`（`retrieval-deadline-exceeded`）；`caller` / `operation_cancelled` / `epoch_fenced` / `budget_exhausted` / `early_stopped` 一并触发 `cancelled`（`02` §3.4）。两者在结果里必须可区分，不得都写成 `timeout`，也不得把预算耗尽或 early stop 写成 `timeout`（`02` TC-1…TC-3）。 |
| DL-3 | provider 不支持协作取消时（例如同步计算的子进程），必须用**进程终止**实现有界取消，并把「以 kill 实现取消」记录在 snapshot 的 `protocol` 与结果行中。 |
| DL-4 | 取消后返回的部分候选一律丢弃，不进入候选池；不得「先记住一部分」。 |
| DL-5 | `epoch_fenced` 取消（旧 Attempt / 旧 epoch）永远不得写入当前 operation 的结果。 |
| DL-6 | 重试只允许在 provider 侧无副作用时进行（embedding / search 均为只读），且必须有上界与退避；重试次数、退避与上限写入 `03` / `09` 的 profile 参数，不设隐含默认。 |

## 6. 失败与降级出口

| provider 观察 | 检索侧状态 | 行为 |
| --- | --- | --- |
| `status: not_configured` | 无分支条目 | 计划未启用；不产生 fallback、不计降级 |
| `status: ready` | `ok` | 正常融合 |
| `status: degraded` | `ok`（附 `coverage` 缺口） | 候选可用，但 pack 记为 `pack_degraded` 若缺口影响 authoritative 覆盖 |
| `status: unavailable` | `provider_unavailable` | 丢弃该分支全部候选；exact + structural fallback；披露原因 |
| `status: unsupported` | `provider_unavailable`（`retrieval-provider-protocol-mismatch`） | 同上；并阻止该 provider 在同一 operation 内被重试 |
| `dim` 不符 | 原生层（`PCS` / `RC` / `RP` / `OBS` / `ERM` / `PCR`）`wrong_dimension` | 整批丢弃；不得比较向量；pack 层按 `09` §3.2.2 折叠为 `invalid_response` + `reason.code = "cg-wrong-dimension"`；原生层分布不得丢失（`02` WD-5） |
| generation 不符 | `generation_mismatch` | 丢弃候选；触发重建或 fallback；`04` 的 fence 复查 |
| 超时 | `timeout` | 丢弃部分结果；披露 |
| 取消 | `cancelled` | 丢弃；若为 `epoch_fenced` 只记 stale diagnostic |
| 响应无法 decode / 非有限浮点 / schema 不符 | `invalid_response` | 整批丢弃，不部分接受 |
| locator 无法用 ABI 语法表达 | `unconvertible` | 该候选 `rejected`（不丢行号、不改大小写、不重编码）；仅限 ABI 转换失败（`02` §7 AB-7） |
| locator 越出 scope | `permission_denied` | `retrieval-path-outside-scope`；记 scope 违规计数 |

完整 fallback 语义见 `06-fallback-degradation.zh-CN.md`。

## 7. 与 ABI / DecisionProvider 的映射

| 本契约 | ABI V3 / 现有实现 | 映射规则 |
| --- | --- | --- |
| `SemanticProviderStatus` | `RetrievalProviderStatusV3` | `ready→ready`；`degraded→degraded`；`unavailable→unavailable`；`unsupported→unsupported`；`not_configured→` **无对应值**（该 provider 不进入 `RetrievalRequestV3.intents` 的 provider 需求） |
| semantic 候选 | ABI 的 `candidateRefs` | 只允许作为 `candidate` 阶段输入；不得直接作为 corroboration |
| `similarity` | ABI 的 `providerScore` | 语义相同：**接受但不参与 assurance**（ABI 已明确排除） |
| `SemanticProvider` | `DecisionProvider`（Worker / Jev） | 不同 role、不同 schema、不同 snapshot 条目；不得复用同一 adapter 实例或同一配置键 |

## 8. 不变量汇总（可测试）

| ID | 不变量 |
| --- | --- |
| SP-1 | 未启用分支（`not_configured`）不产生 fallback 披露，也不计入降级率分母 |
| SP-2 | 任何 semantic 候选进入 pack 前必须有一次 Inspect，且 Inspect 用的是当前工作树原始字节 hash |
| SP-3 | `similarity` 不出现在 `RetrievalPackV1.items[].inspect` 与任何 evidence 字段 |
| SP-4 | `embeddingDim` / `semanticGeneration` / `worktreeId` 三者在 request、result、candidate、snapshot 之间必须逐字一致，否则整批丢弃 |
| SP-5 | `status != ready` 与 `candidates.length > 0` 只在 `degraded` 下允许，且必须带 coverage 缺口 |
| SP-6 | provider 日志与结果中不得出现凭据、正文、未授权路径、完整 transcript |
| SP-7 | 每个请求必须有 deadline 与 cancellation；结果必须区分 `timeout` 与 `cancelled` |
| SP-8 | `provenance.authority` 恒为 `advisory`；任何提升为 `host` / `kernel` 的路径是 decode 失败 |
| SP-9 | 远程 provider 在无授权引用时判为 `unavailable`，且不产生任何网络请求 |

## 9. 非目标

- 不定义向量存储格式、索引文件布局、分片策略、ANN 参数；
- 不定义具体模型、端点、协议实现（阶段 2 由 readiness fixture 固定）；
- 不定义 tokenizer、chunker 的具体实现；
- 不定义向量写入 Kernel 事实（明确禁止）；
- 不定义质量阈值（只由阶段 1 基线后预注册）。

## 10. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 | 归属 | 状态 / 解除条件 |
| --- | --- | --- | --- |
| SP-R1 | `SemanticProviderStatus` 与 ABI `RETRIEVAL_PROVIDER_STATUSES_V3` 的映射（含 `not_configured`） | Retrieval | 本线已定：映射表见 §7；`not_configured` 不进入 ABI（不产生 provider 需求），非错误 |
| SP-R2 | ~~`SemanticProviderProfileV1` / `EmbeddingProviderProfileV1`~~ | — | **已闭合**：两类型已删除；`describe()` 返回 `PCS` provider 记录（`01` §3.6 / `09` §1.2）；generation 参数归 `03` §1（§2.3 / §2.4） |
| SP-R3 | `EgressDecisionV1` / `EgressRecordV1` / `CostMetadataV1` 的字段 | Retrieval（`08`） | 已按 CF-35 对齐：外发对象形状 = `{destination, authorized, authorizationRef}`（= `09` §1.2.1 `PS.egress`）；`08` §3 为字段表 Owner，`09` §1.3 已登记两个 `schemaId` |
| SP-R4 | `taskPrefix = null` 与「显式空前缀」是否区分 | 用户 / 调研产物 | 无调研产物前保持 `unverified`（`BL-02`）；不得写入期望值 |
| SP-R5 | `precision` 是否进入 generation tuple | Retrieval | **已定**：进入（`03` §1 tuple 成员）；变更使 generation 失效（`03` §2） |
| SP-R6 | 重试上限、退避与 `maxBatch` 的数值来源 | Retrieval + 调研产物 | 无调研产物前保持参数 + `unverified`（`09` `RF-17`） |
| SP-R7 | `PcsProviderRecordV1` 作为类型名的使用 | Retrieval | 它只是 `ProviderCapabilitySnapshotV1.providers[number]` 的**局部别名**；不单独发放 `schemaId`（`09` §1.2 已限定 PCS 为唯一形状） |
