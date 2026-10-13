# Semantic generation 与索引设计（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。不建索引、不建 vector DB、不启动重建长跑、不修改 `packages/**`。
- 依据：架构 §27.5、§27.6、§27.9#3；`01-contract-draft`（`GenerationRefV1` / `SnapshotRefV1` / `manifest_conflict`）；`08-p0-admission-decision` §3.2（index 写入）；`01-semantic-provider-contract`（profile 字段）。
- 目标：任何会影响「向量含义」的变化都必须让旧 generation 失效、标记 stale、触发重建或 fallback，并阻止旧候选进入 `RetrievalPackV1`。

## 1. generation tuple

`semanticGeneration` 不是一个版本号字面量，而是下列 tuple 的规范指纹：

```ts
interface SemanticGenerationTupleV1 {
  embeddingModelId: string;        // 模型 id（含权重版本）
  embeddingDim: number;            // 768 只是 EmbeddingGemma 2 默认 profile，不是域常量
  precision: "float32" | "float16" | "int8";
  normalize: "l2" | "none";
  promptVersion: string;           // task prefix / 指令模板版本
  taskPrefix: { query: string | null; document: string | null; title: string | null };
  queryPreprocessVersion: string;
  documentPreprocessVersion: string;
  titlePreprocessVersion: string;
  chunkerVersion: string;
  indexSchemaVersion: number;      // 索引记录 / 字段布局
  sourceSnapshotHash: string;      // 建索引时的源快照（tree-hash 或 git commit）
  worktreeId: string;              // 逻辑 id
  scopeId: string;                 // 授权范围
}
```

```text
semanticGeneration = "semgen-" + SHA-256(canonicalizePactileJsonV1(tuple))[0..31]
```

规则：

| 规则 | 内容 |
| --- | --- |
| GEN-1 | 上表任一字段变化 → 新 generation；旧 generation 立即标 `stale`，不得继续服务新查询。 |
| GEN-2 | tuple 中不得出现绝对路径、端点、凭据、机器名、`Date.now()`、随机数；生成必须可复算（determinism 指标）。 |
| GEN-3 | `semanticGeneration` 只由 tuple 派生；禁止手写、自增或从 provider 响应直接抄写。 |
| GEN-4 | provider 自报的 generation 与本地派生不一致 → 以本地为准，并把该次响应记为 `generation_mismatch`。 |
| GEN-5 | 维度或 precision 变化不允许「部分兼容」：不得把旧向量与新向量混入同一比较空间。 |
| GEN-6 | `worktreeId` / `scopeId` 进入 tuple，意味着跨 worktree 复用索引必须显式重建，而不是共享缓存。（本机多 worktree 场景下这是主要失效来源。） |

### 1.1 `SemanticGenerationV1` 记录

```ts
interface SemanticGenerationV1 extends SchemaHeaderV1 {          // schemaId: "pactile.cg.semantic-generation", version 1
  plane: "runtime" | "evaluation";
  generationId: string;                                          // "semgen-…"
  tuple: SemanticGenerationTupleV1;
  tupleHash: string;
  worktreeId: string;
  branch: ObservedV1<string>;
  sourceRevision: ObservedV1<SourceRevisionRefV1>;
  scopeId: string;
  state: ObservedV1<"building" | "ready" | "stale" | "failed" | "superseded">;
  previousGenerationId: string | null;                           // generation 线性前驱（旧名 supersedes，CF-42 已废）
  nextGenerationId: string | null;                               // generation 线性后继（旧名 supersededBy）
  invalidatedBy: { trigger: GenerationTriggerV1; detailHash: string | null; at: string } | null;
  indexRef: SnapshotRefV1 | null;                                 // state=ready 时必须非 null
  builtFrom: { sourceSnapshotHash: string; fileCount: number; chunkCount: number | null } | null;
  manifestHash: string | null;                                    // 索引清单 CAS 值
  createdAt: string;
  provenance: ProvenanceV1;                                      // authority = "deterministic"
  bodyHash: string;
}
```

| 规则 | 内容 |
| --- | --- |
| LG-1 | **命名隔离（CF-42）**：`previousGenerationId` / `nextGenerationId` 表达的是 **semantic generation 的线性链**（generation lineage），与 `ContextUnitManifestV1.supersedes: EntityRefV1 \| null`（`01` §4.6；上一版**清单**引用）**不是同一语义**，不得互相代替、不得共用校验逻辑、不得用同一字段名。 |
| LG-2 | 旧字段名 `supersedes` / `supersededBy` 在本实体上**已作废**；任何文档继续用旧名描述 generation 链即命名漂移，按 decode 失败处理。 |
| LG-3 | 本实体 `state` 枚举值 `"superseded"` 描述 **generation 自身的生命周期**，是状态值而非字段名，不与 CM 的 `supersedes` 字段同名；两者不得混用。 |
| LG-4 | 双向链必须一致：`B.previousGenerationId = A.generationId` ⇔ `A.nextGenerationId = B.generationId`；不一致 → `generation_mismatch`。链不得跨 `worktreeId` / `scopeId`（GEN-6）。 |

## 2. 失效触发（封闭枚举）

```ts
type GenerationTriggerV1 =
  | "model" | "dimension" | "precision" | "task_prefix" | "query_preprocess"
  | "document_preprocess" | "title_preprocess" | "chunker" | "source_snapshot"
  | "worktree" | "prompt_version" | "index_schema" | "scope" | "manual_invalidate";
```

| 触发 | 例子 | 旧 generation | 必须动作 | 是否允许 fallback 代替重建 |
| --- | --- | --- | --- | --- |
| `model` | EmbeddingGemma 2 → 其他模型 | `stale` | 重建 | 阶段 2 允许（exact + structural），但 semantic 分支必须报 `unavailable` |
| `dimension` | 768 → 512 / 256 / 128 profile | `stale` | 重建；旧向量不得复用 | 允许 fallback；**禁止**跨维度比较 |
| `precision` | float32 → float16 | `stale` | 重建（比较空间变化） | 允许 fallback |
| `task_prefix` | query/document 前缀变化 | `stale` | 重建（文档侧向量变化） | 允许 fallback |
| `query_preprocess` | 查询清洗 / 截断规则变化 | `stale` | query 侧重嵌入；若文档侧不变可只重建 query 路径（需显式记录） | 允许 fallback |
| `document_preprocess` | 文档规范化、注释剥离变化 | `stale` | 重建文档向量 | 允许 fallback |
| `title_preprocess` | 路径 / 标题拼接方式变化 | `stale` | 重建（含 title 的向量） | 允许 fallback |
| `chunker` | chunk 边界 / 重叠策略变化 | `stale` | 重建；旧 chunk 不再可引用 | 允许 fallback |
| `source_snapshot` | 工作树内容变化（tree-hash 变化） | `stale` | 增量或全量重建；未变文件可复用（需按文件 hash 判定） | 允许 fallback；Inspect 仍会拦截 |
| `worktree` | 切换 worktree / 新建 worktree | `stale` | 新 generation（索引不跨 worktree 共享） | 允许 fallback |
| `prompt_version` | 指令模板 / 任务描述变化 | `stale` | 重建 | 允许 fallback |
| `index_schema` | 索引记录布局变化 | `stale` | 重建（不可读旧格式） | 允许 fallback |
| `scope` | 授权范围变化（收窄或扩大） | `stale` | 重建或过滤；收窄时必须立即过滤 | 允许 fallback |
| `manual_invalidate` | 人工作废（评测对照、缺陷处置） | `stale` | 显式记录 actor 与理由 hash | 允许 fallback |

规则：

- TR-1 失效必须**可归因**：`invalidatedBy.trigger` + `detailHash` 必填其一。
- TR-2 失效后，旧 generation 的候选只能以 `generation_mismatch` 出现在 `rejected[]`，不得进入 `items`。
- TR-3 「重建」在阶段 1 与 P0 不执行；阶段 2 起由独立授权决定（见 `10-evaluation-matrix` 的 stage gate）。
- TR-4 不允许「静默降级」：`stale` 不得被改写成 `ok` 或 `degraded`。
- TR-5 `branch` 变化本身不在 tuple 内，但会改变 `sourceRevision` 与可用文件集合；因此分支切换应通过 `source_snapshot` / `worktree` 触发重建（见 `04` FI-21）。

## 3. generation fence

```text
候选携带 generation → 与 plan 期望 generation 比较 → 不一致 → generation_mismatch → rejected[]
                                                  └ 一致 → 进入 Inspect（04 再次核对 generation）
```

| 规则 | 内容 |
| --- | --- |
| GF-1 | fence 至少做两次：候选入池时（廉价校验）与 Inspect 时（权威校验）。两次都必须记录。 |
| GF-2 | fence 比较的是 `GenerationRefV1` 的四个分量（`index` / `semantic` / `manifest` / `snapshot`），不是单一字符串。 |
| GF-3 | `semantic` 分量必须逐字相等；`index` / `manifest` / `snapshot` 允许 plan 显式声明为 `null`（表示不适用），但不允许「候选带了值、plan 为 null」后静默接受。 |
| GF-4 | generation fence 违规是零容忍计数器（`03-stage-plan` §1.2），任一非零 → 阶段 `fail`。 |
| GF-5 | 阶段 2 的 semantic 分支为 `shadow` 时，fence 违规仍必须计数，只是不影响 pack 的 authoritative 判定。 |

## 4. 索引方案（P0 只定义，**不选择、不执行**）

阶段 1 的确定性 baseline **默认不写 workspace index**（`08` §3.2；`02-ownership-dependency:28`；`01-contract-draft:769`）。后续方案**只有两种**（共享枚举，本线不得增添）：

| 方案 | 形态 | 优点 | 风险 | 准入阶段 |
| --- | --- | --- | --- | --- |
| **S1. EffectGateway 管理的写 effect** | 索引写入作为受管 effect，带 lease / epoch / receipt | 与 Host recovery 一致 | 需要 Host P2（`BL-05`）；当前不可用 | 阶段 1b 之后（需 Host 轨道） |
| **S2. 外置 `indexDir`** | 仓库外独立目录，带 owner / generation / sourceRevision / 权限 / 恢复策略 | 可复用、可审计、不污染工作树 | 需要 owner 与并发策略；需清理与磁盘预算 | 阶段 2（需授权） |

| 规则 | 内容 |
| --- | --- |
| SC-1 | **选择未定**：`BL-09`（Owner = 用户 + Host 轨道；触发 = 阶段 1b/2 写集冻结）。选择前不得实现任一种。 |
| SC-2 | 早期草稿的第三种“操作内临时索引”**已删除**：它不在 `08` §3.2 的枚举内；若确实需要，必须先扩展共享枚举（`implementation/08` / `02-ownership`）。 |
| SC-3 | 阶段 1a 离线评测**不建任何索引**；需要索引的评测跳到阶段 2 并先完成 `SC-1`。 |

共同要求（无论采用哪种方案）：

| 规则 | 内容 |
| --- | --- |
| IX-1 | 索引写入**永不**发生在用户工作树内；默认目标是仓库外结果根或临时目录。 |
| IX-2 | 索引必须携带 `SemanticIndexManifestV1`：`indexId`、`generationId`、`worktreeId`、`scopeId`、`sourceSnapshotHash`、`fileCount`、`chunkCount`、`builtAt`、`owner`、`recovery`。 |
| IX-3 | 清理策略必须显式：过期 generation 的索引保留策略、磁盘上限、孤儿索引识别方式。 |
| IX-4 | 删除索引不得删除任何 Artifact / Evidence / receipt；索引是可重建的派生物。 |
| IX-5 | 检索路径在索引不存在时返回 `index_unavailable`，降级到 exact + structural，**不得**隐式触发全量重建。 |
| IX-6 | 重建触发必须是显式动作（带 actor、reason、预算），不允许「查询时顺手重建」。 |
| IX-7 | 索引内不得存放正文以外的敏感信息（凭据、`.env`、私钥）；索引器必须使用与检索相同的 permission scope。 |

### 4.1 `SemanticIndexManifestV1`

```ts
interface SemanticIndexManifestV1 extends SchemaHeaderV1 {       // schemaId: "pactile.cg.semantic-index-manifest", version 1
  indexId: string;
  generationId: string;
  generationTupleHash: string;
  worktreeId: string;
  scopeId: string;
  sourceSnapshotHash: string;                                     // CandidateRefV1 或 git commit
  sourceRevision: ObservedV1<SourceRevisionRefV1>;
  counts: { fileCount: number; chunkCount: number; skippedFiles: number };
  chunkerVersion: string;
  indexSchemaVersion: number;
  storageRef: string;                                             // 逻辑引用，不含绝对路径（runtime 平面）
  owner: { component: string; version: string; buildId: string | null };
  recovery: { strategy: "rebuild" | "discard"; maxRebuildMs: number | null };
  state: "ready" | "building" | "abandoned";
  manifestHash: string;
  createdAt: string;
  provenance: ProvenanceV1;                                       // authority = "deterministic"
}
```

| 规则 | 内容 |
| --- | --- |
| MAN-1 | 写入使用 CAS（比较 `generationId` + `sourceSnapshotHash`）；冲突返回 `manifest_conflict`，重试或阻断，不覆盖。 |
| MAN-2 | `sourceSnapshotHash` 必须能被复算（重建 tree-hash）；无法复算 → `invalid_response`。 |
| MAN-2b | **本实体不携带 generation lineage 字段**（CF-42 副产物）：`SemanticIndexManifestV1` 只通过 `generationId` / `generationTupleHash` 指向一个 generation；前驱 / 后继链**只**存在于 `SemanticGenerationV1.previousGenerationId` / `nextGenerationId`（§1.1 `LG-1`）。不得在本实体重新引入 `supersedes` / `supersededBy`（同名异义，与 `CM.supersedes` 混淆）。 |
| MAN-3 | `skippedFiles` 必须记录原因分类（二进制、过大、权限、忽略规则），不得静默跳过。 |
| MAN-4 | `state = "building"` 且超过预算的索引视为 `abandoned`，必须显式清理，不参与检索。 |
| MAN-5 | `storageRef` 在 runtime 平面是逻辑引用；绝对路径只允许出现在本地审计 artifact 中。 |

## 5. chunker 与预处理

| 组件 | 版本字段 | 变化影响 | P0 要求 |
| --- | --- | --- | --- |
| chunker | `chunkerVersion` | 文档向量、chunk 边界、候选范围 | 参数化；具体实现与默认值未定（`unverified`） |
| query 预处理 | `queryPreprocessVersion` | 查询向量 | 记录规则 hash；禁止自由文本 |
| document 预处理 | `documentPreprocessVersion` | 文档向量 | 同上 |
| title 预处理 | `titlePreprocessVersion` | 含标题的向量 | 同上 |
| prompt / task prefix | `promptVersion` + `taskPrefix` | 查询与文档两侧 | EmbeddingGemma 的 query/document 前缀差异**未验证**（`BL-02`）：只作为参数冻结，禁止写期望值 |

规则：

| 规则 | 内容 |
| --- | --- |
| CH-1 | chunk 必须可映射回 `SourcePointerV1`（文件 + 行范围），否则该 chunk 不可成为候选。 |
| CH-2 | chunk 不得跨文件；跨文件语义单元只能作为 relation / structural 分支的结果。 |
| CH-3 | chunk 记录只存 hash 与范围，不存正文（`01` §3.4）。 |
| CH-4 | 同一文件在不同 chunker 下产生不同 chunk id，禁止跨 chunker 复用 chunk id。 |
| CH-5 | chunk 边界变化属于 generation 失效源，必须触发重建（`chunker` 触发）。 |
| CH-6 | 二进制 / 超大文件 / 越权路径必须在预处理阶段分类 `skippedFiles`，而不是在检索时静默丢弃。 |

## 6. 重建编排（阶段 2 起；**需授权，未执行**）

> 命名空间：本节用 `RB-*`（rebuild orchestration）；重建**信号**规则用 `06` §4 的 `RS-*`；readiness 绑定用 `09` §5 的 `RDB-*`。

```text
invalidate(trigger) → new generation tuple → plan rebuild（预算 / deadline / scope / egress）
  → build（chunk → embed → write index）
  → manifest CAS → state=ready → 旧 generation 标 superseded
  └ 任一步失败 → state=failed → 旧索引保留为 stale、检索走 fallback
```

| 规则 | 内容 |
| --- | --- |
| RB-1 | 重建是独立操作，有自己的 `contextOperationId`（runtime）或 `evaluationRunId`（evaluation），不得寄生在用户查询里。 |
| RB-2 | 重建必须有预算（文件数、字节数、batch、wall-clock）、deadline 与取消；取消后产出部分索引必须标 `abandoned`。 |
| RB-3 | 重建失败不得使检索不可用：exact + structural 必须始终可用。 |
| RB-4 | 重建期间的查询使用旧 generation 会得到 `stale`；plan 必须显式决定「等重建」还是「走 fallback」，默认 fallback。 |
| RB-5 | 重建不得读取未授权路径；索引器使用与 Inspect 相同的 `scopeId` 与权限判定。 |
| RB-6 | 重建的进度与结果只写本地审计与 Artifact；不得把源码发往远程端点（除非显式 egress 授权，见 `08`）。 |
| RB-7 | P0 与阶段 1 不执行任何重建；本节点只冻结编排语义。 |

## 7. 失败状态与出口

| 观察 | 状态 | 出口 |
| --- | --- | --- |
| 索引不存在 | `index_unavailable`（`provider_unavailable` 细分） | fallback 到 exact + structural；披露 `retrieval-index-unavailable` |
| generation 不符 | `generation_mismatch` | 丢弃候选；重建或 fallback；`stale` diagnostic |
| 维度不符 | `wrong_dimension` | 整批丢弃；标记重建需求 |
| manifest CAS 冲突 | `manifest_conflict` | 重读重做或阻断 |
| 重建超预算 | `timeout` | 索引用 `abandoned`；检索走 fallback |
| 重建被取消 | `cancelled` | 同上；记录取消来源 |
| scope 收窄 | `stale` + 重新过滤 | 立即从索引剔除越权条目；未剔除前不得服务 |

## 8. 不变量汇总

| ID | 不变量 |
| --- | --- |
| GI-1 | generation 由 tuple 派生、可复算；不符即为 `generation_mismatch` |
| GI-2 | 旧 generation 的候选永远不进入 `items` |
| GI-3 | 维度 / precision 不同的向量永不混入同一比较空间 |
| GI-4 | 索引是可重建派生物，不是事实源；删除索引不删除 Artifact / Evidence / receipt |
| GI-5 | 阶段 1 默认不写 workspace index；任何写入方案需要单独授权与重新冻结 |
| GI-6 | 索引 manifest 使用 CAS，不覆盖 |
| GI-7 | 检索路径不隐式触发重建 |
| GI-8 | 重建期间 exact + structural 始终可用 |

## 9. 未验证项（不得写成期望值）

| 编号 | 内容 | 原因 |
| --- | --- | --- |
| UV-G1 | EmbeddingGemma 2 的模型 id、维度 profile 语义（768/512/256/128 是否为同一模型的不同输出维度或独立模型） | 无调研产物（`BL-02`） |
| UV-G2 | query / document / title 的 task prefix 具体字符串与是否必须成对出现 | 同上 |
| UV-G3 | batch 上限、单条最大 token、是否支持异步与取消 | 同上 |
| UV-G4 | precision / 量化对召回的影响 | 同上 |
| UV-G5 | 索引规模上限与 rebuild 时间 | 未测量 |
| UV-G6 | 增量重建的复用正确性（文件 hash 复用策略） | 未实现 |

## 10. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 | Owner | 解除条件 |
| --- | --- | --- | --- |
| GI-R1 | 索引写入方案 S1 / S2 的选择 | 用户 + Host 轨道 | `BL-09`；阶段 1b/2 写集冻结时定（§4 `SC-1`） |
| GI-R2 | `precision` / `normalize` 是否进入 tuple | Retrieval | **已定**：均进入（§1 tuple）；变更使 generation 失效（§2） |
| GI-R3 | 索引清理与保留策略（磁盘上限 / 过期 / 孤儿识别） | Retrieval | 阶段 2 索引写集冻结前；当前无索引可清理 |
| GI-R4 | `source_snapshot` 变化时增量重建的复用单位 | Retrieval | 阶段 2 重建实现前；当前未实现重建 |
| GI-R5 | 多 worktree 并发重建的资源与锁 | Retrieval + Host | 阶段 2；若写入方案 = S1，lease 由 Host 提供 |
| GI-R6 | `SemanticIndexManifestV1` 是否复用 manifest store | Implementation + Retrieval | `09` §1.3 已将其登记为 T4（线内 `schemaId`）；“共用 store”属实现层决定，需与 `01` §4.6 的 CM store 对齐 |
