# ContextUnit 与 ContextUnitManifestV1（P0 契约细化，proposed）

- 状态：proposed。本文只冻结 schema、字段语义、内容分类规则与失败语义，**不实现运行时代码**，不创建 decoder，不启动真实 compaction。
- 依据：架构 §27.1、§27.3、§27.4、§27.6、§27.7、§27.9#3；`implementation/01-contract-draft.zh-CN.md`（共用外壳、ISO-1…8、`ObservedV1`、CU/CM 草案）；`implementation/08-p0-admission-decision.zh-CN.md`（P0 写集与冻结语义）。
- 与 `01` 的关系：`01` 冻结共用外壳与不变量；本文提供 CU/CM 的**详细字段、hash 规则、生命周期与内容分类**。两者冲突时以 `01` 的不变量为准并回到评审；本文新增的支撑类型（§12）需要评审后回填 `01` 与 `02`。
- 本文所有 hash 值一律写成 `sha256:<pending>`；**没有任何真实 hash 被写入**，也不得把占位值当作证据。
- 术语边界：本文的 “unit / manifest / pointer / token” 都是 **Context Governance 的逻辑对象**，不是 Kernel fact，也不是第二套 Receipt 或 Lease authority。

## 1. 范围与非目标

范围：

1. `ContextUnit`（CU）的字段、身份、cursor、保护分类、可重开性和生命周期；
2. `ContextUnitManifestV1`（CM）的字段、版本链、`supersedes`、当前清单指针和 durable 语义；
3. pointer、restore token、mask、externalize、structured projection、lossy projection 的**契约定义**（不是执行）；
4. 内容分类与处置矩阵：哪些必须保留原文、哪些只能保存 pointer、哪些可 mask / externalize / structured project / 低风险 lossy、哪些必须 `request_review` 或 `block`；
5. exact / protected anchor 的确定性识别与禁止处置清单。

非目标：存储布局、SQLite schema、token 预算数值、压缩阈值、decoder 实现、Pi 适配器实现、评测结果。

## 2. 身份、命名与平面隔离

沿用 `01` §2 的 `plane` 判定与 ISO-1…8。本文涉及的标识：

| 标识 | 归属 | 语义 | 约束 |
| --- | --- | --- | --- |
| `runId` | 产品 | RunLedgerV1 中的真实 Agent 执行 | runtime 平面必填；evaluation 平面禁止出现（ISO-2） |
| `contextOperationId` | Context Operation | 一次 retrieval / unitize / compress / audit / memory.read 操作 | runtime 与 evaluation 各自命名空间；evaluation 使用 `eval-` 派生命名空间（ISO-3） |
| `evaluationRunId` | 离线评测 | 一次 fixture / 实验臂 / paired comparison | 产品实体禁止携带；不得从产品侧引用（ISO-2、ISO-6） |
| `unitId` | CU | 可寻址单元的**内容寻址**标识 | 见 §2.1；不透明，不携带语义 |
| `manifestId` | CM | 一次 Context Operation 的清单标识 | 见 §8.1 |
| `scopeId` | Host/Policy | 权限与 scope 的引用键 | 必须来自 Host/Policy 的授权事实；缺失 → `permission_denied` |
| `sessionId` / `branchId` | Session | transcript 容器与分支 | `branchId` 是 `ObservedV1`；未知时不得假设为 main |

### 2.1 `unitId` 派生规则（确定性）

```text
unitId = "cu-" + SHA-256(canonicalizePactileJsonV1([
  sessionId, branchId ?? null, startSeq, endSeq, startEntryId ?? null, endEntryId ?? null,
  kind, contentHash
]))[0..63]        // 输出 sha256 的 64 位十六进制
```

规则：

- **确定性**：相同输入（含内容 hash）必须得到相同 `unitId`；`bodyHash` 的 determinism 指标以此为前提。
- **内容寻址**：内容变化 → `contentHash` 变化 → 新 `unitId`；旧 unit 不被原地改写，只能作为历史或 `supersedes` 的前驱出现。
- `unitId` 不包含绝对路径；worktree 只以 `worktreeId`（逻辑 id）出现。
- 禁止用自然语言摘要、模型输出或时间戳参与 `unitId` 派生。
- Pi entry id 在 P0 只作为**不透明标识**参与派生；其稳定性属于 1b 的验证项（UV-03），P0 不据此放权。

## 3. 生命周期总图

```text
transcript / RetrievalPack / Artifact
        │  unitize（确定性，policyVersion + unitizerVersion）
        ▼
ContextUnit[]（只有 hash + pointer + 保护分类，不含全文）
        │  manifest 组装
        ▼
ContextUnitManifestV1（draft）
        │  Artifact 写入 + Manifest store CAS + read-back 身份比对
        ▼
CM.durable.status = ok  ──►  当前清单指针（CurrentManifestPointerV1）前进
        │
        ├─► 只有此时才允许向 Policy Gate 提交 CDQ（01 §4.6 不变量）
        │
        └─► 决策链（见 compression-decision-chain-v1.zh-CN.md）
```

不可颠倒的顺序：**unitize → manifest durable → 决策准入**。`durable.status != ok` 的清单不得作为任何动作的依据；也不存在 “先压缩，后补 manifest” 的路径。

## 4. `ContextUnit`（CU）

`schemaId = "pactile.cg.context-unit"`，`schemaVersion = 1`（与 `01` §4.5 一致；本文补充字段，不改变既有字段语义）。

| 字段 | 类型 | R/O | 语义 | 规则 |
| --- | --- | --- | --- | --- |
| `unitId` | string | R | 见 §2.1 | 内容寻址；确定性 |
| `kind` | 封闭枚举 | R | `system / user / assistant / tool_call / tool_result / retrieval_item / decision / approval / evidence_ref / summary / memory_pointer` | 不得新增未登记 kind；新增需要新 `schemaVersion` |
| `cursor` | `TranscriptCursorV1` | R | transcript 中的可寻址范围（`sessionId / branchId / startSeq / endSeq / startEntryId / endEntryId`） | `startSeq <= endSeq`；`branchId` 非 ok 时禁止任何改写类动作；必须落在所属 CM 的 `transcriptCursor` 范围内（CF-16） |
| `contentHash` | `sha256:<64hex>` | R | **该 unit 实际存储载荷**的 hash | 载荷只存于 Artifact；unit 本身不含全文（§27.9#3） |
| `sourceHash` | `sha256:<64hex>` | R | **来源原始字节**的 hash（transcript entry 原始字节 / 工作树文件原始字节 / provider 响应原始字节） | 见 §9.2；解码文本 hash 只能作为 `textHash` 观测，不能替代 |
| `byteLength` | number | R | 载荷字节数 | 不得为负；未知用 `ObservedV1` 包装（`tokenEstimate` 同例） |
| `tokenEstimate` | `ObservedV1<{ count, tokenizerId }>` | R | 估算 token | tokenizer 必须来自 capability snapshot；未知就是非 ok，不得用 `0` |
| `protection.class` | `exact_required / protected / pointer_only / compressible / unknown` | R | 保护分类 | `unknown` 一律按 `exact_required` 处理（fail-closed） |
| `protection.anchors[]` | `{ kind: AnchorKind, valueHash, ordinal }[]` | R | exact / protected anchor 的类别与 hash，**不含值** | 见 §6；`valueHash` 是 anchor 原文的 hash，用于 audit 比对 |
| `protection.reasons[]` | `ReasonV1[]` | R | 分类依据（规则 id + 版本） | `code` 来自封闭枚举；不写自由文本 |
| `protection.ruleSetVersion` | string | R | 识别规则集版本 | 变更**必须伴随**新 `policyVersion` + 新 manifest generation（CF-14）；不单独版本化 `AnchorKind` 所在 schema（CF-19） |
| `recoverability` | `ObservedV1<RecoverabilityV1>` | R | 见 §7.4；取代历史字段 `reopenable`（CF-13，`01` §4.5 已改） | 非 ok 或 `class != byte_exact` → 只能 `keep_full` / `block` |
| `permissions` | `ObservedV1<PermissionScopeV1>` | R | 见 §4.1（唯一形状 = `09` §1.2.1 / `01` §3.6） | 非 ok → 只能 `keep_full` 或 `block` |
| `freshness` | `FreshnessV1` | R | 见 §12.1；`verdict ∈ fresh / stale / unknown`（**不外包 `ObservedV1`**，与 `01` §4.5 一致） | `verdict = stale` 或与当前 generation 不一致 → `stale` / `generation_mismatch` |
| `state` | `"proposed" | "manifest_durable" | "superseded"` | R | 单元在清单中的生命周期状态 | 未 `manifest_durable` 的 unit 不得进入决策链 |
| `pairing` | `{ toolCallId: string \| null, pairedUnitId: string \| null }` | R | tool call 与 tool result 配对 | 未配对者不得作为 cut-point（沿用 `findValidCutPoints` 语义） |
| `provenance` | `ProvenanceV1` | R | 见 `01` §3.6 | `authority` 恒为 `deterministic`（unitize 是确定性过程）；模型输出不得成为 unit 的生产者 |
| `bodyHash` / `createdAt` / `plane` 等 | 见 `01` §3.5 | R | 共用外壳 | runtime 携带 runId/attemptId/turnId/operationEpoch；evaluation 携带 evaluationRunId/caseSetHash/fixtureHash |

### 4.1 `PermissionScopeV1`：权限事实（不是分类）

`PermissionScopeV1` 只回答 **“Host/Policy 当前允许哪些动作”**；它不回答 “内容需要怎样被保留”（那是 §4.2 的 `protection.class`）。两者不得互相推导。

```ts
interface PermissionScopeV1 {              // 唯一形状 = `09` §1.2.1 / `01` §3.6；本线不重新声明成员
  scopeId: string;
  readable: boolean; withinScope: boolean; readScopes: string[];
  maxClassification: "public" | "internal" | "restricted";
  actions: { mask: boolean; externalize: boolean; structuredProject: boolean;
             lossy: boolean };              // 恰好四个许可位；**不存在第五位**（CF-40：不得新增或解析 promotion 相关键）
  egress: { destination: "none" | "local" | "remote"; authorized: boolean;
            authorizationRef: ArtifactRefV1 | null };
  issuedAt: string;
}
```

规则：

- **SP-1** `permissions` 是 **Host/Policy 的事实**（`authority ∈ {host, kernel}`），不是模型判断；Controller 不得自行放宽任何布尔值。
- **SP-2** 任一位缺失、未知或非 `ok`，按 `false` 处理（fail-closed）。
- **SP-3** `egress.destination = "remote"` 且 `authorized = true` 但没有 `authorizationRef` → decode 失败（deny-by-default；四种外发形状的合并仍属 CF-35）。
- **SP-4** “动作是否可执行” = `class`（§4.2） ∧ `actions.*` ∧ `recoverability`（§7.4） ∧ Policy Gate 准入；四项缺一不可，缺一即拒绝，而不是降级为更弱的动作。
- **SP-4b** `actions` 的键集合**恰好**是 `{ mask, externalize, structuredProject, lossy }`。出现第五个键——包括历史布尔名 `maskable` / `externalizable` / `structuredProjectable` / `lossyAllowed`，以及 `promotionRecommendation` 等任何 promotion 相关键——一律 **decode 失败**（`invalid_response`，§4.2.2 #2）；不得“标为 legacy / 后续同步”后继续解析，也不得作为有效字段保留在字段表里。
- **SP-4c** **promotion 建议不属于 `PermissionScopeV1`**（CF-40）：memory / project promotion 的批准属 Kernel command（阶段 7）。若需表达 “建议做 promotion”，唯一允许位置是 CDQ proposal 的 `effectClass: "promotion_recommendation"`（`01` §4.8 与其 §5 补充段）——它是**提案意图字段**，不是权限位，也不能放行任何动作。`PermissionScopeV1` 不得新增任何 promotion 字段；确需新增时必须走新字段 + 新 `schemaVersion`（属 Implementation 裁定，见 `09` §7 未决项）。
- **SP-5** 历史名 `PermissionSetV1` 为**未定义名称，已废止**（CF-03）；本线文档不得将该名称用作字段或类型（发现即按 §11 负例 #19 处理）。Compression 旧字段名统一为 `scopeId`（CF-15）；本目录不存在 `scopeKey` 字段用法（验证方式见回执的机械检查）。

### 4.2 `protection.class`：内容需要怎样被保留（唯一枚举）

**本线只使用一套 class 枚举**，取自 `01` §4.5：

```text
class ∈ { exact_required, protected, pointer_only, compressible, unknown }
```

**修复轮前**的旧写法 `protection ∈ {exact, protected, maskable, externalizable, lossy_eligible}` 不是 class 枚举：`exact` 是 `exact_required` 的旧名，`maskable` / `externalizable` / `lossy_eligible` 是**动作许可**，对应修复轮后的 `PermissionScopeV1.actions.{mask, externalize, lossy}`（映射规则见 `09` §1.2.1 规则 4）。`09` §2.4 现已改为同一五值枚举（本线已逐字核对）。把动作许可写进 `protection`，或使用旧名 → decode 失败（§11 负例 #18）。

#### 4.2.1 class → 保留要求 → 允许处置（唯一真值表）

| class | 含义（保留要求） | 允许的处置 | 需要的权限位 | 不需要权限位（无关） |
| --- | --- | --- | --- | --- |
| `exact_required` | 必须逐字节保留，且必须能在 Agent 上下文中直接读到 | `keep_full` | — | 全部 |
| `protected` | 必须逐字节保留，但不得被语义改写（可 mask / 外化 / 投影的前提是逐字节可还原） | `keep_full`；`mask_reopenable` / `externalize` / `structured_project`（三者均要求 `recoverability = byte_exact`） | `actions.mask` / `actions.externalize` / `actions.structuredProject`（按所选动作） | `actions.lossy` |
| `pointer_only` | 只需可经 pointer 重读；无需在上下文中保留原文 | `externalize`；`mask_reopenable` | `actions.externalize` / `actions.mask` | `actions.lossy` |
| `compressible` | 可经 Artifact 还原的非事实内容；允许非逐字节的编排 | `mask_reopenable` / `externalize` / `structured_project` | `actions.mask` / `actions.externalize` / `actions.structuredProject` | `actions.lossy` |
| `unknown` | 无法判定 | **按 `exact_required` 处理**：仅 `keep_full` | — | 全部 |

不变量：

- **PC-1** `unknown` 一律 fail-closed 为 `exact_required`；不得询问模型、不得用 confidence、不得用相似度提升为可压缩。
- **PC-2** 动作许可**不写进 class**。`class = protected` 不等于 “允许 mask”；它只说明 “若允许，则必须逐字节可还原”。
- **PC-3** `exact_required` 与 `unknown` 在任何阶段都**不参与** `mask_reopenable` / `externalize` / `structured_project` / `lossy_compress` / `drop`。
- **PC-4** `lossy_compress` / `drop` 在 v1 对**全部** class 都不执行（`drop` 只能作为 shadow judgment 或 `request_review` 输入）。
- **PC-5** class 只能由 §6.2 的确定性规则产生；模型输出、Jev judgment、Embedding 相似度和 confidence **不能**改变 class（既不能降也不能升）。

#### 4.2.2 decoder 规则

1. `class` 取值必须是上表五个之一；出现修复轮前的 `exact` / `maskable` / `externalizable` / `lossy_eligible` → `invalid_response` + `reason.code = "compression-protection-class-invalid"`（**线内诊断码**，前缀规则见 `09` §3.2.2；映射表见 `09` §1.2.1 规则 4）。
2. `actions` 的键集合必须**恰好**为 `{ mask, externalize, structuredProject, lossy }`；把动作许可写进 `protection` 字段、出现第五个键（含 `promotionRecommendation` / 历史布尔名）、或使用任何未登记许可名 → `invalid_response`（CF-40；`09` §6 负例 #30）。
3. `class` 与 `actions` 同时出现冲突（如 `class = pointer_only` 但 `actions.externalize = false`）时，**以 `false` 为准**（拒绝动作），并且不构成 decode 失败 —— 这是正常的保守组合。
4. `unknown` 必须显式序列化，不得被省略或以空值代替；省略 → `invalid_response`。
5. class 变化必须产生新的 manifest generation（§8.2），不得原地改写。

> **状态（CF-02 / CF-03 / CF-04）：已由 Implementation 修复轮裁定并已核对。** `01` §4.5 保持五值 `class`；`09` §2.4 的 CU 行现为同一五值枚举（旧枚举已删除）；动作许可归入 `PermissionScopeV1.actions`（唯一形状见 §4.1）；`PermissionSetV1` 废止（CF-03）。下文真值表与 decoder 规则即为本线执行口径。`scopeKey` → `scopeId` 的命名裁定（CF-15）见 §4.1 SP-5。

`09` §2.4 的 CU `state`（`proposed / manifest_durable / superseded`）与本文件 §4 的 `state` 字段一致，不需要裁定。

## 5. 内容分类与处置矩阵

八个处置（与 `01` §5 的动作词汇一致，**不新增词汇**）：

```text
keep_full | mask_reopenable | externalize | structured_project
| lossy_compress | drop | request_review | block
```

| 处置 | 效果等级 | 允许的内容 | 禁止的内容 | 硬前置 |
| --- | --- | --- | --- | --- |
| `keep_full` | none | 全部 | — | 默认；任何不确定的 unit 的兜底 |
| `mask_reopenable` | reversible | `protected`（逐字节可还原）、`pointer_only`、`compressible`，且 `actions.mask = true`、`recoverability = byte_exact` | `exact_required` / `unknown`；任何 `context_inline` anchor 所在 unit | manifest durable + Policy Gate 准入 + durable receipt + restore token + 保留 entry 身份与 `toolCallId` |
| `externalize` | reversible | `pointer_only`、`compressible`；`protected` 仅当 `actions.externalize = true` 且逐字节可还原 | `exact_required` / `unknown`；用户指令、权限、scope、Evidence 原文 | 同上；pointer 必须经 `memory.read` 可读 |
| `structured_project` | reversible | `pointer_only`、`compressible`；`protected` 仅当 `actions.structuredProject = true` 且投影保留全部 anchor 字面值 | `exact_required` / `unknown`；投影会丢失或改写 anchor 的情况 | 同上；原文必须保留于 Artifact |
| `lossy_compress` | lossy | **v1 不执行**（任何 class 均不执行） | 全部 | `01` §5：仅阶段 6 + 正式授权（`authorization.class = "lossy"`）+ `rollbackRef` 非空 + post-compaction audit 前置 |
| `drop` | lossy（破坏性） | 无 | 全部 | **v1 不开放**；只能作为 shadow judgment 或 `request_review` 输入 |
| `request_review` | control | 分类冲突、分类为 `unknown`、审计失败后的人工决策 | — | 不改变上下文 |
| `block` | control | 秘密 / 凭据、越 scope、provenance 缺失、不可恢复的 exact 内容 | — | 停止链路并记录 |

规则：

- **anchor 优先于处置**：任何单元的处置都必须先满足其全部 anchor 的保留要求；做不到就必须降级为 `keep_full` / `request_review` / `block`，不得“部分保留”。
- **不可逆动作在 v1 一律不开放**：`drop` 与 `lossy_compress` 在 P0/P1/v1 范围内只记录、不执行。
- **兜底单调性**：分类从 `exact_required` 向 `compressible` 的**降级只能由确定性规则产生**，不能由模型输出、相似度或 confidence 产生。

## 6. exact / protected anchor：确定性识别与禁止处置

### 6.1 AnchorKind 封闭枚举

```text
user_goal | user_constraint | file_path | symbol | line_number | content_hash | revision
| version_string | port | url | json_literal | patch_hunk | tool_call_id | test_assertion
| error_code | config_value | rejected_approach | current_value | previous_value
| evidence_text | permission | scope
```

`anchor.valueHash = sha256(anchor 原文的规范化字节)`；`anchor.ordinal` 是 anchor 在该 unit 内的出现序号（保证重复值可定位）。anchor **只存 kind + hash + 序号**，值仍只存在于 Artifact；audit 通过 “重新读取 → 重算 hash → 比对” 验证保留，而不是在清单里复制秘密或源码。

与共享契约的关系（CF-19）：`AnchorKind` 是 **T3 内联枚举（22 个成员）**，为 `01` §3.6 的**唯一声明**，本线不重新声明；它由 `protection.ruleSetVersion` 版本化（不是 schema 版本）。本文 §6.2 的 **20 条识别规则**中，`current_value` 与 `previous_value` 是两个成员、共用一条规则，因此 22 成员 → 20 行。

### 6.2 识别规则、保留模式与默认分类（确定性，不依赖模型）

每个 AnchorKind 先归入一种**保留模式**（retention），再由保留模式推出默认 class：

```text
retention = context_inline     → 默认 class = exact_required（必须在 Agent 上下文中逐字节可读）
retention = reopenable_only    → 默认 class = protected     （必须逐字节可还原，由 audit 重读校验）
```

| # | AnchorKind | 识别规则（确定性） | retention | 默认 class | 允许处置 | 禁止处置 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `user_goal` | `kind = user` 且来源为 Kernel Goal/WorkItem 命令或本轮用户指令 | context_inline | `exact_required` | `keep_full` | 改写 / mask / 外化 / 投影 / 丢失 |
| 2 | `user_constraint` | `kind = user` 且属于约束语句（Kernel/Policy 显式标记，或 user 单元默认） | context_inline | `exact_required` | `keep_full` | 同上 |
| 3 | `file_path` | 词法识别路径形状（POSIX/Windows），或与 RetrievalPack / Inspect 的 path 一致 | reopenable_only | `protected` | `keep_full`；`mask_reopenable` / `externalize`（需权限位 + byte_exact）；`structured_project` | 改写大小写、NFC 重编码、截断、丢失、`lossy_compress`、`drop` |
| 4 | `symbol` | 词法识别标识符 + 与 worktree Inspect 的符号一致 | reopenable_only | `protected` | `keep_full` / `structured_project`（保留原 token）；mask / 外化（需权限位 + byte_exact） | 丢失、改写、近似替换、`lossy_compress`、`drop` |
| 5 | `line_number` | 词法识别行号/范围数值 | reopenable_only | `protected` | 同 #3 | 重算、偏移、近似、丢失 |
| 6 | `content_hash` | `sha256:<64hex>` / git sha 形状 | reopenable_only | `protected` | 同 #3 | 截断、改写、重新计算后替换、丢失 |
| 7 | `revision` | commit / revision / generation 标识形状 | reopenable_only | `protected` | 同 #3 | 同上 |
| 8 | `version_string` | 语义化版本 / 工具版本 / schemaVersion 形状 | reopenable_only | `protected` | 同 #3 | 省略 patch 位、改写、丢失 |
| 9 | `port` | 端口数值 + 上下文（`:` 或 `port=`） | reopenable_only | `protected` | 同 #3 | 改写、范围近似、丢失 |
| 10 | `url` | URI 形状（含路径与查询串） | reopenable_only | `protected` | 同 #3 | 改写、截断查询串、去参数、丢失 |
| 11 | `json_literal` | 可解析的 JSON 片段（含 tool 参数与配置片段） | reopenable_only | `protected` | `keep_full`；`structured_project` 仅在字段白名单全部保留时；mask / 外化（需权限位 + byte_exact） | 重新序列化后丢弃字段 / 键序不明、丢失 |
| 12 | `patch_hunk` | unified diff 形状 | reopenable_only | `protected` | 同 #3 | 摘要化、重排 hunk、丢失 |
| 13 | `tool_call_id` | Pi/tool 协议中的 call id 形状 | context_inline | `exact_required` | `keep_full` | 丢失、重编号、mask（包括随载荷被 mask） |
| 14 | `test_assertion` | 测试文件中断言语句（由 Inspect 定位到测试文件） | reopenable_only | `protected` | `keep_full` / `structured_project`（保留表达式原文）；mask / 外化（需权限位 + byte_exact） | 语义等价替换、丢失 |
| 15 | `error_code` | 既有失败码封闭枚举 / 错误码形状 | reopenable_only | `protected` | 同 #3 | 概括、翻译、映射到新码、丢失 |
| 16 | `config_value` | 配置键值（含默认值与开关） | reopenable_only | `protected` | 同 #3 | 改写、省略、丢失 |
| 17 | `rejected_approach` | Kernel Decision/Review 标记为 rejected 的记录 | context_inline | `exact_required` | `keep_full` | 改写、省略失败原因、mask、外化 |
| 18 | `current_value` / `previous_value` | `memory.update` 历史条目中的当前值与前一值 | context_inline | `exact_required` | `keep_full`；两者必须成对保留 | 只留当前值、丢弃 previous、mask、外化 |
| 19 | `evidence_text` | 被 Kernel Evidence / Artifact 引用的原文 | context_inline | `exact_required` | `keep_full` | 摘要替代原文、二次转写、mask、外化替代引用 |
| 20 | `permission` / `scope` | Policy/Host 授权记录与 scope id | context_inline | `exact_required` | `keep_full` | 一切改写 / mask / 外化 / 投影 / 丢失 |

补充规则：

- **PC-6 单元下限**：`kind ∈ {system, user, decision, approval, evidence_ref, memory_pointer, tool_call}` 的单元下限为 `exact_required`；`kind ∈ {assistant, summary, tool_result, retrieval_item}` 的下限为 `protected`。**实际 class = min(单元下限, anchor 推出的 class)**（取更严者）；单元内任一 `context_inline` anchor 使 `tool_result` / `retrieval_item` 升为 `exact_required`。
- **PC-7 不可分离**：anchor 与载荷不可分离时，整个 unit 按该 anchor 的 class 处理；`omittedFields[]` 不得含 anchor。
- **PC-8 规则集版本化**：本表随 `protection.ruleSetVersion` 冻结；规则变化必须产生新 manifest generation 并保留旧分类记录（追加式，不覆盖）。
- **PC-9 不得用模型判断改变分类**：Jev / Embedding / Pi summary 可以**建议**，但不能改变分类结果（`01` §4.7）。
- **PC-10 压缩前置（与决策链 S7 联动）**：Pi compaction 的 intent 必须携带 `carryForwardUnitIds[]`（全部 `exact_required` 单元），它们在压缩后必须逐字节重新出现在 Context 中；无法在 Pi 适配层表达 carry-forward 时，该操作只能 `blocked`，不得退化为 “摘要代替原文”。`carryForwardUnitIds` 的字段表与校验属决策链 S7/CAR（`compression-decision-chain-v1` §6/§7），需一并 Review。

### 6.2.1 命名 anchor 的禁止处置清单（汇总视图；§6.2 的逐项核对表）

| AnchorKind | 绝对禁止 | 有条件允许（全部条件必须同时满足） |
| --- | --- | --- |
| `user_goal` / `user_constraint` | 一切非 `keep_full` 处置 | — |
| `permission` / `scope` | 一切非 `keep_full` 处置；写入 Kernel 表（越权） | — |
| `evidence_text` | 用摘要/改写替代引用；将 `externalize` 作为引用的替代 | — |
| `tool_call_id` | 丢失、重编号、随载荷 mask；破坏 call/result 配对 | — |
| `rejected_approach` | 省略失败原因；改写为 “已尝试” 等模糊表述 | — |
| `current_value` / `previous_value` | 只留当前值；丢 `previous` | — |
| `file_path` / `revision` / `content_hash` / `version_string` | 改写、截断、重编码、丢失、`lossy_compress`、`drop` | `mask_reopenable` / `externalize` / `structured_project`：需 `actions.*` 位 + `recoverability = byte_exact` + Policy Gate 准入 + audit `exact_anchor` 重读通过 |
| `line_number` / `symbol` / `port` / `url` / `json_literal` / `patch_hunk` / `test_assertion` / `error_code` / `config_value` | 改写、近似、摘要化、丢失、`lossy_compress`、`drop` | 同上 |

规则：表中 “有条件允许” 不是默认许可 —— 四项条件缺一即拒绝（`PermissionScopeV1` SP-4）；拒绝后的唯一出口是 `keep_full` / `request_review` / `block`。

### 6.3 误判与失败出口（回应 `10-p0-exit-checklist` 条件 4）

| 误判 | 检测方式 | 后果与出口 | 禁止 |
| --- | --- | --- | --- |
| **漏判 exact**（把必须保留原文的内容当作可压缩） | audit `exact_anchor` / `protected_content`；重读后重算 `valueHash` 不一致 | 该次操作 verdict 只能 `restored` / `expanded` / `review_required`；生成 regression case；不得 `accepted` | 用摘要补位；把漏判记为 “可接受漂移” |
| **误判 protected**（把可压缩内容当作必须保留） | 分类记录与规则不匹配（规则未命中却标 exact） | 只造成额外开销；按 `keep_full` 处理；记为诊断，不改变规则 | 为提高压缩率而放宽规则；用模型判断把精确分类降级 |
| **分类未知** | `class = unknown` | 一律按 `exact_required`；只允许 `keep_full` / `request_review` | 任何 reversible / lossy 动作 |
| **规则集漂移**（同一 unit 在新旧 `ruleSetVersion` 下分类不同） | audit `generation` + 分类记录比对 | 视为 `generation_mismatch`：作废旧清单，重建 manifest；旧分类记录保留 | 静默复用旧分类 |

规则：**误判的失败出口必须可执行**——出口是 “降级保留 + 生成 regression case + 人工 review”，不是自动改写分类规则。`exact` 漏判属于零容忍项（ZT-CM-01），无论压缩收益如何都判 `fail`。

## 7. pointer、restore token 与四个动作的定义

### 7.1 `SourcePointerV1`（含 `memory` scheme；`PointerRefV1` 已退役）

本线**不定义**自己的 pointer 类型。以 `01` §4.4 的 `SourcePointerV1` 为唯一类型；本线只新增一个 **scheme**：

```ts
// 唯一 pointer 类型：SourcePointerV1（`01` §4.4 / retrieval `02` §5.1）；本线不另立别名或并行类型。
// 本线新增唯一 scheme（已入 `01` §3.6 / §4.4）：
//   { scheme: "memory"; unitId: string; manifestRef: EntityRefV1 }
```

与本文早前草案的差异（**已按 CF-17 撤销**）：

| 撤销项 | 处置 |
| --- | --- |
| `PointerRefV1` / `MemoryPointerV1` 作为独立类型名 | 退役；不得出现在新的 decoder 输出中 |
| `artifact.byteRange` | 删除（Artifact 是整体对象） |
| `transcript.startEntryId / endEntryId` | 移入 `TranscriptCursorV1`（CF-16） |
| `worktree.fileHashRaw / revision / lineRange` | 移出 pointer：hash / revision 是校验值，属 `01` §4.4 的 `fileHashRaw`（与 `CU.sourceHash` 同概念，CF-12）与 `CU` / `CM` 的 `sourceRevision` |

规则：

- **PR-1** pointer 本身**不授予权限**；`memory.read` 必须重新校验 scope、权限、revision、generation 与 hash（架构 §27.7）。
- **PR-2** `scheme: "memory"` 只指向同一 `scopeId` 的已提交清单；**不得**作为检索候选 locator（候选必须能 Inspect）。（CF-17）
- **PR-3** `scheme: "memory"` **不得**参与 ABI 转换（直接 `unconvertible`，不得重编码）；`unconvertible` 的故障注入归属为 `FI-20.1`（CF-23）。
- **PR-4** `SourcePointerV1` 的不可变性（SPo-5）同样适用于本条；重新锚定必须产生新 unit。

### 7.2 `RestoreTokenV1`

```ts
interface RestoreTokenV1 {                      // schemaId = "pactile.cg.restore-token", v1；字段表 Owner = 本文（共享形状 `01` §3.6；身份登记 `09` §1.2.3）
  tokenId: string;
  unitId: string; pointer: SourcePointerV1;
  contentHash: string; manifestRef: EntityRefV1;
  scopeId: string;
  operationEpoch: number | null;                 // runtime 平面：非空整数；evaluation 平面：必须为 null
  evaluationRunId: string | null;                 // evaluation 平面：非空字符串；runtime 平面：必须为 null
  issuedAt: string; expiresAt: string | null;
  issuedBy: { component: "host-memory-port"; version: string };
}
```

规则（CF-41；与 `01` §3.6 RT-1…RT-5、`09` §1.2.3 同一规则集）：

- **RT-1 平面互斥**：`operationEpoch` 与 `evaluationRunId` **恰好一个非 null**；两者都非 null 或都为 null → decode 失败（`invalid_response`；`09` §6 负例 #30）。
- **RT-2 单一 schema**：runtime token 与 evaluation token **共用本 schema**；不得另立 `EvaluationRestoreTokenV1`，也不得用平面区分字段集合。因此旧说法—— “runtime token 只带 `operationEpoch`”、“`operationEpoch` 必填（无 null）”、“evaluation token 不得出现任何 epoch 字段”——**全部作废**；`evaluationRunId` 与 `operationEpoch` 都是本 schema 的必填字段（值按平面取 null）。
- **RT-3 绑定（按平面）**：runtime = `(manifestRef, contentHash, scopeId, operationEpoch)`；evaluation = `(manifestRef, contentHash, scopeId, evaluationRunId)`。任一不匹配：runtime → `epoch_mismatch` / `manifest_conflict`；evaluation → `manifest_conflict`；一律拒绝读取。请求与 token 必须同平面（不允许 runtime 请求持 evaluation token）。
- **RT-4 ISO-2 的唯一表达**：孤立规则 “评测实体禁止 `operationEpoch`” 在本类型上表达为 `operationEpoch = null`（不是删字段）；FI-07 / FI-16 需要的旧 epoch 仿真由 fake Memory Port 的 fixture 内部记录承载，**不得**写入 token 字段（CF-27）。
- **RT-5 复用边界**：token 不能跨 Attempt / 跨 `operationEpoch` 复用；evaluation token 不能跨 `evaluationRunId` 复用（`01` §3.3 的 `epoch_mismatch` / `manifest_conflict` 语义）。
- **RT-6 句柄语义**：token 是 **Memory Port 签发的不透明句柄**，用于让 Agent 在 disclosure 之后请求重读；它不是授权，不是 Evidence，也不能替代 scope/permission 校验；不含原文、不含密钥、不写入 Kernel 事实；`expiresAt = null` 只表示 “与 scope 生命周期一致”。

### 7.3 mask / externalize / structured projection 的定义

| 动作 | 契约含义 | 必须记录 | 禁止 |
| --- | --- | --- | --- |
| `mask_reopenable` | 用占位符替换**载荷**，索引与身份不变 | `placeholderId`、`preserveShape{ entryCount, toolCallId, argIndex, permissions }`、`pointer`、`restoreTokenRef` | 改变 entry 数 / 顺序、丢失 `toolCallId`、改变权限或目标 |
| `externalize` | 原文移入 Artifact，Context 只留 pointer + hash + token | `artifactRef`、`contentHash`、`pointer`、`restoreTokenRef` | 移走 exact anchor 所在 unit 的全部内容 |
| `structured_project` | 以确定性投影替换载荷，原文保留 | `projectionSchemaId`、`projectionSchemaVersion`、`keptFields[]`、`omittedFields[]`、`projectionHash`、`originalPreserved: true` | 投影成为事实来源；`omittedFields` 含任何 anchor |

`lossy_compress` / `drop` 在 v1 不执行；如未来开放，`lossy` 记录必须包含 `lostFieldClasses[]`、`approvalRef`、`irreversible: true` 与 post-audit 要求（见决策链文档 §6）。

### 7.4 `RecoverabilityV1`：类型定义唯一来源与动作门

类型定义（含字段表、`class` 枚举、`pointer` / `restoreTokenRef` / `verifiedAt` / `verificationHash`）**唯一来源 = `01` §3.6**（T3 内联，随宿主 `schemaVersion` 版本化；语义归属 CU，`CM.unitRefs[].recoverabilityClass` 只存摘要——`09` §1.2.5）。**本线不重复声明接口**；本节只写本线的动作门与消费规则。

| class | 含义 | 允许的动作 | 含 exact anchor 时的要求 |
| --- | --- | --- | --- |
| `byte_exact` | 可经 Memory Port 逐字节还原（hash 已校验） | mask / externalize / structured_project | 满足 |
| `semantic_only` | 只能重读近似内容（例如已被改写过的来源） | 仅 `keep_full`；可作为阅读辅助 | **不允许**：必须 `keep_full` 或 `block` |
| `none` | 不可重开 | 仅 `keep_full` | 必须 `block`（不得压缩） |

## 8. `ContextUnitManifestV1`（CM）

`schemaId = "pactile.cg.context-unit-manifest"`，`schemaVersion = 1`（与 `01` §4.6 一致；本文补充 §8.2/§8.3）。

### 8.1 字段表

| 字段 | 类型 | R/O | 语义 |
| --- | --- | --- | --- |
| `manifestId` | string | R | `cm-` + 内容 hash 派生；不透明 |
| `manifestGeneration` | number | R | 同一 `(workspaceId, sessionId, scopeId)` 内**单调递增**；由 Manifest Port 分配 |
| `supersedes` | `EntityRefV1 \| null` | R | 上一版清单的 `EntityRefV1`；首版为 `null`（CF-09；`01` §4.6 已改）。不变量：其 `bodyHash` 必须等于上一版清单的 `manifestHash`，且必须同时出现在 `provenance.derivedFrom` |
| ~~`basisManifestRef`~~ | — | — | **删除**（CF-11）：改由 `provenance.derivedFrom` + `supersedes` 承担 |
| `unitRefs[]` | `{ unitId, contentHash, sourceHash, protectionClass, recoverabilityClass, pointer: SourcePointerV1 \| null }[]` | R | 清单只存引用，不存全文（CF-17）；`protectionClass` / `recoverabilityClass` 取值同 `01` §4.6 |
| `transcriptHash` | `sha256:<64hex>` | R | 本次操作基准 transcript 的规范化 hash（语义等同现有 `contextSnapshotHashV1(messages)`） |
| `transcriptCursor` | `TranscriptCursorV1` | R | 基准范围，覆盖 `unitRefs` 的 cursor 并集（CF-16）；CU.cursor 必须落在该范围内 |
| `coverage` | `ObservedV1<{ units, bytes, exactUnits, protectedUnits, unknownUnits }>` | R | 覆盖统计；`unknownUnits > 0` 时禁止 reversible 动作 |
| `unitizerVersion` | string | R | unitize 实现版本 |
| `ruleSetVersion` | string | R | §6 分类规则集版本 |
| `policyVersion` | string | R | 本清单使用的策略版本（含分类与准入规则） |
| `generation` | `GenerationRefV1` | R | `manifest` 位必填（= 本清单 generation）；`index` / `semantic` 按需 |
| `durable` | `ObservedV1<{ artifact: ArtifactRefV1; manifestStoreRevision: number; readBackHash: string; readBackRevision: number; currentArtifactId: string }>` | R | 字段名以 `01` §4.6 为准；**4 项身份校验与 R1–R4 映射见 §8.3** |
| ~~`permissionsSummary`~~ | — | — | **不是规范字段**（CF-10）；如保留只能是显式标记为派生的只读聚合，且不得作为权限 / 权威判据 |
| `provenance` | `ProvenanceV1` | R | `authority = deterministic`；`producer.component = context-unitizer` |
| 共用外壳 | 见 `01` §3.5 | R | runtime / evaluation 身份按 ISO-1…8 |

#### 8.1.1 新增字段登记（哪些需要回填共享契约）

| 字段 | 载体 | 修复轮结论 | 本线动作 |
| --- | --- | --- | --- |
| `sourceHash` | CU / `unitRefs[]` | 已入 `01` §4.5/§4.6；与 `IR.fileHashRaw` 同概念（CF-12） | 采用；二者不同时 → `invalid_response` |
| `recoverability` | CU | 已入；**取代 `reopenable`**（CF-13） | 采用；`reopenable` 视为派生谓词，不再输出 |
| `ruleSetVersion` | CU / CM | 已入；变更必须伴随新 `policyVersion` + 新 generation（CF-14） | 采用（PC-8 同步） |
| `permissions` | CU / CM | 唯一形状 `09` §1.2.1（CF-04） | 采用 §4.1 |
| ~~`permissionsSummary`~~ | CM | 不是规范字段（CF-10） | 删除（§8.1） |
| `transcriptCursor` | CM | 统一 `TranscriptCursorV1`（CF-16） | 采用 |
| ~~`basisManifestRef`~~ | CM | 拒绝，改用 `provenance.derivedFrom`（CF-11） | 删除（§8.1） |
| `durable.readBackHash/readBackRevision/currentArtifactId` | CM | 已入 `01` §4.6；实现属 1b（BL-15） | 采用；R1–R4 见 §8.3 |
| `cursor.startEntryId/endEntryId`、`anchors[].ordinal`、`state` | CU | 已入 `01` §4.5 | 采用 |
| `carryForwardUnitIds[]` | compaction intent（S7） | 线内字段，宿主类型 `PiCompactionRecordV1` 属 T4 登记（`09` §1.3 / CF-20）；**非跨线共享字段**，无第二套定义 | 登记已裁定（CF-20）；Pi 适配层表达能力验证属 1b |

### 8.2 `supersedes` 与版本链

1. 每次 Context Operation 产生**一个新 generation**；旧清单不删除、不原地改写。
2. **`supersedes` 类型 = `EntityRefV1 | null`**（CF-09；`01` §4.6 已改）。不变量：其 `bodyHash` 必须等于上一版清单的 `manifestHash`，且必须同时出现在 `provenance.derivedFrom` 中；本文早前草案的 `string | null` 已作废（负例 #19）。
3. 链完整性校验必须通过 Manifest Port 解析前驱：`resolve(ref)` → 比对 `workspaceId / sessionId / scopeId` 相同、`predecessor.manifestGeneration = current − 1`、且 `bodyHash === 上一版 manifestHash`。断链（前驱缺失、hash 不符、generation 不连续、跨 scope/session）→ `manifest_conflict`；当前清单不得用于放权。
4. 恢复动作（“恢复原 Artifact” / “扩大 Context”）同样产生**新清单**，在 `provenance.reasons` / `causation` 记录触发它的失败 audit，而不是回退指针。

### 8.3 durable 与 4 项 read-back 身份校验（BL-15 的契约化）

```ts
interface ReadBackV1 {
  artifactContentHash: string;     // R1：由 unitRefs[] 聚合推导（不另存字段）
  readBackHash: string;            // R2：manifest 自身 canonical hash（`01` §4.6 字段名）
  readBackRevision: number;        // R3：Manifest Port CAS revision（`01` §4.6 字段名）
  currentArtifactId: string;       // R4：当前指针指向的 artifact（`01` §4.6 字段名）
}
```

`durable.status = ok` 的必要条件（四项全部成立，缺一不可）：

| # | 校验 | 期望 | 实际来源 | 不成立时 |
| --- | --- | --- | --- | --- |
| R1 | artifact 内容 hash | `= ` `unitRefs[]` 聚合出的内容 hash | Artifact port 重读 | `missing` / `invalid_response` |
| R2 | manifest hash | `= 本清单 manifestHash` | Manifest Port 重读（decode 后重算） | `unknown`（禁止回放） |
| R3 | manifest revision / generation | `= CAS 返回的 revision` 且 `= 本清单 manifestGeneration` | Manifest Port 重读 | `manifest_conflict` |
| R4 | current artifact id / current pointer | `= 本清单 artifact.artifactId` 且指针 `manifestHash` 一致 | 当前清单指针重读 | `manifest_conflict` |

任何一项不成立：`durable.status ∈ {missing, unknown, manifest_conflict, invalid_response}`，并且：

- 不得向 Policy Gate 提交 CDQ；
- 不得启动 Pi compaction；
- 不得把该清单作为 memory.read 的基准；
- effect 结果不明时按 `no_automatic_replay` 处理（架构 §18.3）。

> 现状差距：`agent/memory/durability/index.ts` 的 read-back 目前只做 decode，未做身份比对；且现有 `MemoryCurrentManifestV1`（同文件 `interface MemoryCurrentManifestV1`，约 1025 行）已有 `revision / previousRevision / manifestHash` 链。读-back 四项校验的运行时实现属 1b（BL-15 / B-CM-4）。**P0 只冻结契约，不修改代码。**

### 8.4 当前清单指针（`CurrentManifestPointerV1`）

```ts
interface CurrentManifestPointerV1 {            // schemaId = "pactile.cg.current-manifest-pointer", v1（类型定义与字段名唯一来源 = `09` §1.2.4 + 本文 §8.4 作为 Owner）
  scopeId: string; workspaceId: string; sessionId: string;
  manifestGeneration: number; manifestHash: string;
  updatedAt: string;
  updatedBy: { component: "host-manifest-port"; hostOperationId: string };
  previous: { manifestGeneration: number; manifestHash: string } | null;
}
```

所有权与字段语义（唯一，不得出现第二种说法）：

| 项 | 唯一规定 |
| --- | --- |
| 所有权 | **Host / Manifest Port**。以 CAS + expected revision 维护；Compression Controller 只读，不写、不续租、不代持 |
| 唯一键 | `(scopeId, workspaceId, sessionId)` 内唯一 |
| 字段名 | 上表七个字段名即唯一名称；不得用 `scopeKey`、`pointerRef`、`pointerHash` 等旧名 |
| `previous` 与 CM 的关系 | `previous` 必须与对应 CM 的 `supersedes` 一致（同一 `bodyHash`）；不一致 → `manifest_conflict`（`09` §1.2.4） |
| `manifestGeneration` 与 CAS `revision` | **两个不同的量**：`manifestGeneration` 是清单链的逻辑版本，`revision` 是 Manifest Port 的 CAS 计数。二者不得互相替代，也不得声称相等（§8.3 R3 分别校验） |
| recoverability 语义 | 指针**不携带** recoverability。`recoverability` 的唯一类型定义 = `01` §3.6；语义归属 = CU（§7.4）；CM 只存 `unitRefs[].recoverabilityClass` 摘要 |
| 持久化载体 | 沿用现有 Manifest Port 的 CAS 记录（现有 `MemoryCurrentManifestV1`，字段 `revision` / `previousRevision` / `manifestHash`）；**不新增 store、不新增第二套指针**。底层记录与指针字段的对应关系属 1b 实现，且不得改变本表语义 |

规则：

- 读者必须携带自己使用的指针版本；读取时指针已前进 → `manifest_conflict`，必须重新读取并重做，不得静默使用旧值。

**它不是（负例 #20）：**

| 误读 | 事实 |
| --- | --- |
| Kernel fact | 不是。不写入 Kernel 表，不参与 Close / CompletionDecision。 |
| Receipt / Effect | 不是。它不证明任何动作发生；不是 `EffectLedgerEntryV1` 的替代。 |
| Lease / Epoch 权威 | 不是。Lease/Epoch 唯一权威是 `RunLedgerCoordinator`（架构 §23.3.1）。 |
| “live context 已压缩”的证明 | 不是。Pi compaction 是否成功是 S7 的事实，由 CAR 判定。 |
| 恢复授权 | 不是。恢复必须看 CAR verdict + Receipt + Port 重读，而不是指针前进。 |
| 事实可信度 | 不是。指针前进只说明 Manifest Port 记了一个新 revision。 |

> **CF 对齐（已闭合）**：`01` §9#5 的“manifest kind vs 扩展 `MemoryCurrentManifestV1`”按上表收口：**类型与字段语义唯一**（`09` §1.2.4 + 本表），**持久化沿用现有 Manifest Port 的 CAS 记录**，不新增 store / kind / 第二套指针。新增字段与支撑类型的裁定取 CF-10/11/13/14/16/18（RT / CMP 升 T2）。

## 9. hash 与 canonical 化

### 9.1 规则

- 序列化：`canonicalizePactileJsonV1`；hash：`fingerprintPactileContractV1`（`sha256:<64hex>`）。
- `bodyHash` 与 `receiptHash` 沿用 `01` §3.4：`bodyHash` 排除 `bodyHash`、`createdAt`、`observedAt`；receipt 包含 `createdAt`。
- 相同输入（同一 transcript、同一 `policyVersion`、同一 `unitizerVersion`）在确定性阶段必须得到相同 `bodyHash`。

### 9.2 `sourceHash` / `contentHash` / `textHash` 的区分（回应 BL-10）

| 名称 | 定义 | 用途 | 禁止 |
| --- | --- | --- | --- |
| `sourceHash` | 来源**原始字节**的 sha256（transcript entry 原始字节 / 文件原始字节 / provider 响应原始字节） | freshness fence、audit 比对 | 用解码文本 hash 替代 |
| `contentHash` | 该 unit 在 Artifact 中**存储载荷**的 sha256 | memory.read 校验、artifact 完整性 | 用来源 hash 冒充 |
| `textHash` | 解码文本的 sha256（观测字段，可选） | 辅助诊断 | 作为 freshness fence 或 audit 判据 |
| `transcriptHash` | 清单基准 transcript 的规范化 hash | 恢复与比对 | 作为单元内容 hash |

### 9.3 全文与秘密

- 清单、receipt、日志与 Protocol 投影**不得**包含：原文、embedding 向量、凭据、`provider.env`、完整 URL 查询串中的密钥参数。
- 秘密扫描策略仍未决（BL-19 / B-CM-8）；在策略冻结前，任何写入路径都按 “可能含秘密” 处理：只登记 hash 与 pointer。

## 10. 一等失败状态（fail-closed）

| 状态 | 触发（本文范围） | 允许的下一步 | 禁止 |
| --- | --- | --- | --- |
| `unknown` | 分类不确定、durable 结果不明、unitize 未完成 | `keep_full`；`request_review` | 任何 reversible / lossy 动作 |
| `stale` | `freshness` / generation 与当前清单不符 | 重新 unitize / 重建 manifest | 当作有效清单继续 |
| `missing` | pointer / artifact / 前驱清单 / receipt 不存在 | 恢复或 `block` | 返回空数组当 “无内容” |
| `permission_denied` | `permissions` 非 ok、scope 不符 | `block`；请求授权 | 绕过 Port 直接读取 |
| `revision_mismatch` | `sourceRevision` 与期望不符 | 重新 Inspect | 当作 fresh |
| `epoch_mismatch` | runtime token / pointer 的 `operationEpoch` 与当前 Attempt 不符（evaluation token 的 `operationEpoch` 恒为 `null`，其平面字段是 `evaluationRunId`，不符属 `manifest_conflict`） | 记为 stale diagnostic；拒绝 | 合并进当前 Attempt |
| `manifest_conflict` | CAS 失败、指针前进、链断裂 | 重新读取并重做 | 覆盖写入；静默取最后写入者 |
| `generation_mismatch` | 同 revision 内 index / semantic / manifest generation 漂移 | 作废旧清单/分类，重建 | 混合两个 generation；当作低分内容 |
| `timeout` | **该工作单元自身**的 deadline 到期（来源码 `compression-deadline-exceeded`，§10.1 FD-5） | 使用更低保证结果并披露 | 当作空结果；把上层 / 父级 deadline 触发的 abort 写成 `timeout`；折回 `cancelled` |
| `cancelled` | 被取消 / 被停止：调用方（用户 / 上层命令）取消、**上层或父级 deadline 触发的 abort**（取消源是 deadline、机制是 abort）、operation 撤销、epoch fence（旧 Attempt / 旧 epoch 迟到执行）、预算耗尽、plan 显式 early stop（来源码见 §10.1 FD-5） | 使用更低保证结果并披露；取消有上界 | 折叠为 `timeout` 或 `ok`；当作空结果；把 `timeout` 写成 `cancelled` |

适用性（按 `09` §3.1 的“状态 → 实体”矩阵逐格核对，引用行号为该矩阵 196–209 行）：

| 状态 | CU | CM | 处理 |
| --- | --- | --- | --- |
| `unknown` / `stale` / `missing` / `permission_denied` / `revision_mismatch` / `generation_mismatch` / `cancelled` / `invalid_response` / `timeout` / `manifest_conflict` | ✓ | ✓ | 直接表达 |
| `epoch_mismatch` | **—** | ✓ | CU 不可表达 → 在产生处折叠（§10.1），不得写入 CU 字段；CM 可直接表达 lease/Attempt 不符 |
| `provider_unavailable` | **—** | ✓ | CU 不可表达；由“tokenizer / provider 不可用”推出的不可判分类 → 记为 `unknown`（fail-closed），并在 chain 层保留原状态 |
| `wrong_dimension` | **—** | **—** | CU / CM 都不可表达 → 只能在 CJ / PCS / OBS 层观察，到本线实体前必须显式折叠（§10.1） |
| `unconvertible` | **—** | **—** | 同上；`SourcePointerV1` → ABI ref 转换失败只属 SP / RC / RK / OBS / ERM / PCR 层；**`IR` 不在其中**（`09` §3.1 矩阵该格为 `—`、`09` §7 登记表第 28 条；检索线 `02` §3.2 `AP-3`；CF-46 / R-BL-19 / X-10） |

`—` 的含义与 `09` §3.1 一致：decoder 收到即 `invalid_response` —— 即**上游必须先折叠**，不得把 lease / embedding / 转换语义写进内容实体。

### 10.1 不可表达状态的显式折叠与原始状态追踪（回应任务书三.5）

折叠不是 “丢掉状态”，而是 “换一个可表达的载体 + 留下可还原的原始状态”。三个 additive 状态在本线的处理（`reason.code` 命名空间按 `09` §3.2.2）：

| 原始状态 | 原生层（保留原状态） | 唯一折叠层 | 折叠目标（`ObservedV1.status`） | `reason.code` | 原始状态追踪 | 不得 |
| --- | --- | --- | --- | --- | --- | --- |
| `wrong_dimension` | PCS / RC / RP / OBS / ERM / PCR（`09` §3.1） | 观察层 = **`CJ.action`**（`09` §3.2.2 第 2 行，`fold` 记录写在这里）；若该状态出现在压缩内容实体上（`09` §3.2.2 第 3 行：`CU` / `CM` / `CDQ` / `CDR` / `CAR`），折叠值同样为 `invalid_response` + 同一 `cg-wrong-dimension`，**不产生第二套码、不追加第二个 `fold` 记录** | `invalid_response` | **`cg-wrong-dimension`**（`09` §3.2.2 登记的**唯一共享折叠码**） | `CJ.action` 上的 `fold` 记录：`foldRule = "fold-09-3.2.2-wrong-dimension"`、`reason.code = "cg-wrong-dimension"`、**`detailHash` 必填且非空**（指向「原始状态 + 期望维度 + 实际维度 + 实体引用」artifact）；评测结果行同时保留原生层计数（矩阵 §8.1） | 截断/补零维度后接受；当作低分内容；静默消失；使用任何非 `cg-` 前缀的折叠码 |
| `unconvertible` | SP / RC / RK / OBS / ERM / PCR（`09` §3.2.2 第 4 行；**不含 `IR`**——CF-46：`IR` 不承载 `unconvertible`，ABI 转换失败属上述层，`IR` 只记录自身 `checks[].id = "range"` 等检查结果；原生层不得提前折叠） | 压缩内容实体 `CU` / `CM` / `CJ` / `CDQ` / `CDR` / `CAR`（`09` §3.2.2 第 4 行；不得在检索层提前折叠） | `invalid_response` | 线内诊断码 `compression-pointer-unconvertible`（仅压缩线使用；`09` §3.2.2 已登记） | 原 `SourcePointerV1` 原样保留在 Artifact（retrieval `02` PK-9）；`detailHash` 指向失败转换记录 | 折叠为 `missing`；改写大小写、丢行号、重编码路径；把 `IR` 列为原生承载层；在检索层提前折叠 |
| `timeout` | 全线可表达（不需要折叠） | — | `timeout` | 线内诊断码 `compression-deadline-exceeded`（**本线 `timeout` 来源码的唯一登记处**） | 自身 deadline 值、到期时刻与上界记入 CAR / 评测记录 | 折回 `cancelled` 或 `ok`；当作空结果；把上层 / 父级 deadline 触发的 abort 写成 `timeout` |
| `cancelled` | 全线可表达（不需要折叠） | — | `cancelled` | 线内诊断码六值：`compression-cancelled-by-caller` / `compression-cancelled-by-deadline` / `compression-cancelled-by-operation` / `compression-epoch-fenced` / `compression-budget-exhausted` / `compression-early-stopped` | 取消来源（源码）+ 上界记入 CAR / 评测记录 | 折叠为 `timeout` 或 `ok`；当作空结果；把 `timeout` 写成 `cancelled`；用来源码当折叠码 |

规则：

- **FD-1** 折叠单向：只允许在**观察层**（CJ / PCS / OBS）保留原状态，在其上消费的内容实体上折叠；不得下推。
- **FD-2** 折叠必须可还原：`reason.code` + `reason.detailHash` 必须足以让 Review 重建原状态；不得只留一个 `invalid_response`。
- **FD-3** `reason.code` 命名空间（`09` §3.2.2）：共享折叠码只用 `cg-` 前缀，P0 唯一值 = `cg-wrong-dimension`；线内诊断码继续用 `compression-*` 前缀（如 `compression-pointer-unconvertible` / `compression-protection-class-invalid`），**`timeout` / `cancelled` 的来源码以 §10.1 与 FD-5 为唯一登记处**（`compression-deadline-exceeded`、`compression-cancelled-by-*`、`compression-epoch-fenced`、`compression-budget-exhausted`、`compression-early-stopped`）。新增共享折叠码必须同时修改 `09` §3.2.2 与 `01` §3.3；不得另立同义码。
- **FD-4** 评测矩阵必须单独报告三类状态的原始状态计数（矩阵 §8.1），不得只报折叠后的 `invalid_response` 总数。

**FD-5（CF-47）`timeout` / `cancelled` 的唯一判定表**（与 `01` §3.3、`09` §3 第 28/29 条与 §3.2.2、检索线 `02` §3.4 `TC-1` / `TC-9` / `TC-10` 一致；本表是压缩线来源码的唯一登记处）：

| 触发 | 状态 | 线内来源码 |
| --- | --- | --- |
| **该工作单元自身**的 deadline 到期 | `timeout` | `compression-deadline-exceeded` |
| 调用方（用户 / 上层命令）主动取消 | `cancelled` | `compression-cancelled-by-caller` |
| 上层 / 父级 deadline 触发的 abort（取消源是 deadline、机制是 abort） | `cancelled` | `compression-cancelled-by-deadline` |
| operation 被撤销（上游 abort，非 deadline） | `cancelled` | `compression-cancelled-by-operation` |
| epoch fence（旧 Attempt / 旧 epoch 的迟到执行） | `cancelled` | `compression-epoch-fenced` |
| 预算耗尽导致分支未完成 / 未启动 | `cancelled` | `compression-budget-exhausted` |
| plan 显式 early stop 提前停止剩余分支 | `cancelled` | `compression-early-stopped` |

- `timeout` / `cancelled` / `invalid_response` **永不参与任何折叠**（`09` §3.2.2 “永不折叠”清单；检索线 `02` `TC-9`）；来源码是**诊断码**，不得充当折叠码或 `reason.code` 的折叠值。
- 预算耗尽 / early stop **不是** `timeout`：分支没有超时，只是被停止（检索线 `02` `TC-3` 同口径）；旧 Attempt / 旧 epoch 迟到结果的原生状态是 `epoch_mismatch`，**不是** `cancelled`（检索线 `02` `TC-6`）。
- 旧表述作废（CF-47）：此前把“上层取消（abort）”与 deadline 对立起来的写法会反向排除父级 deadline 触发的 abort，已删除；正确口径是：**取消源是 deadline 时状态仍为 `cancelled`**，只有**自身** deadline 到期才是 `timeout`。

## 11. decoder 必须拒绝的负例（将转为 EC）

1. `durable.status = ok` 但缺少 `readBackHash` / `readBackRevision` / `currentArtifactId`（§8.3）。
2. `readBackHash` 与 `manifestHash` 不等却被接受（BL-15 的回归）。
3. `protection.class = unknown` 的 unit 被任何 reversible 动作采纳。
4. `recoverability.class = semantic_only` 或 `none` 的 unit 承载 exact anchor 却未 `block`。
5. `mask` 记录缺少 `preserveShape.toolCallId` 或改变了 `entryCount`。
6. `structured_project` 的 `omittedFields[]` 含 anchor。
7. `externalize` 移走含 exact anchor 的 unit 全部内容。
8. `lossy_compress` / `drop` 在 v1 阶段被 `admitted`。
9. `supersedes` 跨 scope / 跨 session / generation 不连续。
10. `unitId` 与 `(cursor, kind, contentHash)` 派生结果不符（不可复现的 unit）。
11. `sourceHash` 用 `textHash` 填充，或反之。
12. `permissions` 缺失/非 ok 却被当作 “允许”。
13. `restoreToken` 的 `scopeId` 与请求不符、runtime token 的 `operationEpoch` 不符、或 evaluation token 的 `evaluationRunId` 不符却被接受；或 token 同时带非空 `operationEpoch` 与非空 `evaluationRunId`（或两者都为空）；或请求与 token 平面不同（§7.2 RT-1/RT-3）。
14. `transcriptHash` 与 `transcriptCursor` 描述的范围不一致。
15. 清单包含任一 `promotion` 字段或写入 Kernel 表（越权）。
16. 任何 hash 字段为全零占位（`sha256:` + 64×`0`）或缺席却被当作 `ok`（对齐 `09` §4、`01` 负例 #26）。
17. CU 上出现 `epoch_mismatch` / `provider_unavailable` / `wrong_dimension` / `unconvertible`；或 CM 上出现 `wrong_dimension` / `unconvertible`（§10 适用性；应按 §10.1 在观察层折叠）。
18. `protection.class` 出现修复轮前的 `exact` / `maskable` / `externalizable` / `lossy_eligible`，或动作许可位被写进 `protection` 而不是 `PermissionScopeV1.actions`（§4.2.2 #1/#2）。
18b. `wrong_dimension` 折叠时使用非 `cg-` 前缀的折叠码（如 `compression-wrong-dimension`），或 `fold` 缺 `foldRule = "fold-09-3.2.2-wrong-dimension"` / 缺非空 `detailHash`（§10.1）。
18c. `PermissionScopeV1.actions` 的键集合不是恰好 `{ mask, externalize, structuredProject, lossy }`：出现第五个键（`promotionRecommendation` 或其它 promotion 键）或历史布尔名（CF-40；§4.1 SP-4b / §4.2.2 #2）。
19. `supersedes` 出现 `EntityRefV1` 与 `string` 两种类型混用（CF-09），或出现已废止的 `PermissionSetV1` 名称（§4.1 SP-5 / CF-03）。
20. 把当前清单指针当作 Kernel fact、Receipt、Lease 权威、“已压缩”证明或恢复授权（§8.4）。
21. `durable.readBack` 缺任一 R1–R4 字段，或只做 decode 不做身份比对却报 `ok`（§8.3）。
22. 把 `carryForwardUnitIds` 缺失的 compaction 结果报为成功，或用摘要代替 `exact_required` 单元（PC-10）。
23. 单元 class 低于其下限（如 `tool_call` 单元被标 `compressible`），或 `context_inline` anchor 所在单元被标 `pointer_only` / `compressible`（PC-6）。
24. `IR` 承载 `unconvertible`，或把 `SourcePointerV1` → ABI ref 的转换失败归到 `IR`（CF-46；`09` §3.1 该格为 `—`、§7 第 28 条；检索线 `02` §3.2 `AP-3`）。
25. 把**自身** deadline 到期写成 `cancelled`，或把上层 / 父级 deadline 触发的 abort、调用方取消、operation 撤销、epoch fence、预算耗尽、early stop 写成 `timeout`；或用取消来源码充当折叠码 / `reason.code`（CF-47；§10.1 FD-5；`09` §6 负例 #33；检索线 `02` `TC-1` / `TC-9` / `TC-10`）。

## 12. 支撑类型登记与共享契约同步

### 12.1 类型登记表

| 类型 | 归属 / 层级 | 独立 `schemaId` | Owner 字段表 | hash / provenance | 裁定状态 |
| --- | --- | --- | --- | --- | --- |
| `PermissionScopeV1` | T2 共享（`09` §1.2.1 / `01` §3.6） | 是（`pactile.cg.permission-scope` v1） | §4.1（本线为消费视图） | 参与宿主 `bodyHash`；`authority ∈ {host, kernel}` | 已裁定（CF-04 / CF-15） |
| `FreshnessV1` | T2 共享（`09` §1.2.2 / `01` §3.6） | 是（`pactile.cg.freshness` v1） | `{ verdict, asOf, basis, mtimeMs }`（以 `01` §3.6 为准；**不外包 ObservedV1**） | 由宿主记录；`verdict` 消费时重算，不缓存为事实 | 已裁定 |
| `RecoverabilityV1` | **T3 内联**：类型定义唯一来源 = `01` §3.6；语义归属 = CU（`01` §4.5），`CM.unitRefs[].recoverabilityClass` 只存摘要（`09` §1.2.5） | 否 | 本线 §7.4 **不重复定义**，只写动作门 | 随 CU `bodyHash`；`class` 变化必须新 generation | 已裁定（CF-13） |
| ~~`PointerRefV1`~~ / ~~`MemoryPointerV1`~~ | 退役 | 否 | — | — | 已裁定（CF-17）：并入 `SourcePointerV1` + `memory` scheme |
| `SourcePointerV1`（新增 `memory` scheme） | T2 共享 + 本线新增 scheme | 是（既有） | `01` §4.4 + 本文 §7.1 | pointer 不单独取 hash | 已裁定（CF-17） |
| `RestoreTokenV1` | T2（`09` §1.2.3；**Owner = 本文 §7.2**） | 是（`pactile.cg.restore-token` v1） | §7.2 | `issuedAt` 排除于内容 hash；`authority = host`；**单一 schema + 平面互斥**（`operationEpoch` / `evaluationRunId` 恰好一个非 null） | 已裁定（CF-18；CF-41 本轮闭合） |
| `CurrentManifestPointerV1` | T2（`09` §1.2.4；**Owner = 本文 §8.4**） | 是（`pactile.cg.current-manifest-pointer` v1） | §8.4 | `updatedAt` / `updatedBy` 排除于内容 hash | 已裁定（CF-18） |
| `AnchorKind` | **T3 内联**封闭枚举（22 成员，`01` §3.6） | 否 | §6.1 / §6.2 | 由 `protection.ruleSetVersion` 版本化（非 schema 版本） | 已裁定（CF-19） |
| `PiCompactionRecordV1` / `DisclosureRecordV1` / `MemoryReadRecordV1` | 线内 `schemaId` → **T4 登记**（`09` §1.3） | 见 CF-20 | 决策链 §6 / S9 / S10 | — | T4 登记名称与 schemaId 已裁定（CF-20）；最小 runtime bridge 已生成 Artifact 并绑定 RunLedger Context Operation，但完整失败/并发/crash-replay 证据仍开放 |

规则：本线不得自行冻结共享契约。上表中已裁定项一律以 `01` / `09` 为准；`DisclosureRecordV1` 与 `MemoryReadRecordV1` 在升级为 T2 前不得被跨线引用（CF-20）。

### 12.2 与现状的差距（1b 运行时任务，非 P0 工作）

| 差距 | 现状 | 需要的运行时变更 | 关联阻断 |
| --- | --- | --- | --- |
| durable 4 项 read-back 身份比对 | 只 decode | 补 R1–R4（§8.3） | BL-15、B-CM-4 |
| checkpoint 占位 hash | `sha256:` + 64×`0`（`context-pipeline.ts` 约 695 行） | 改为一等 `unknown` / `missing` | BL-15、DEF-IMPL-1 |
| compaction 与 session tree | 摘要未进入 Pi tree | 定义 `PiCompactionRecordV1` 与 tree entry 关系 | BL-13、B-CM-2 |
| carry-forward | 无字段 | compaction intent 增加 `carryForwardUnitIds[]`（PC-10） | BL-13 |
| supersession 记录 | 无 | CDR/CAR 增加 supersession 语义 | BL-14、B-CM-3 |
| unitize 实现 | 只有 cut-point / snapshot / delta | 需要 CU/CM 的新实现 | 阶段 1b |
| 当前清单指针 | 无独立指针对象 | Manifest Port 增加 CAS 指针，或复用 `MemoryCurrentManifestV1` | 阶段 1b / Host 轨道 |

### 12.3 跨线冲突的裁定状态（与 `implementation/05-writeset-rollback.zh-CN.md` §2.1 的 CF 表对齐）

本线原提的 SYNC-01…SYNC-11 已被 Implementation 修复轮以 CF-xx 编号逐项裁定（部分仅部分裁定）。下表为本线侧的执行状态；**本线不再提异议**，未裁定项保留为待办。

| 本线 ID | 内容 | CF | 状态 / 本线动作 |
| --- | --- | --- | --- |
| SYNC-01 | `protection.class` 两套枚举 | CF-02 | 已裁定：唯一五值枚举；§4.2 已改为“已裁定”口径 |
| SYNC-02 | `supersedes` 类型 | CF-09 | 已裁定：`EntityRefV1`；§8.1/§8.2 已同步（早前 `string` 写法作废） |
| SYNC-03 | `PermissionScopeV1` 三种形状 | CF-04 / CF-15 | 已裁定：唯一形状 `09` §1.2.1；§4.1 已同步 |
| SYNC-04 | `FreshnessV1` 形状与包装 | — | 已裁定：`01` §3.6 / `09` §1.2.2；§4 已改为不外包 `ObservedV1` |
| SYNC-05 | pointer 类型（`PointerRefV1` / `memory` scheme） | CF-17 | 已裁定：`PointerRefV1` 退役；`memory` scheme 入 SP；§7.1 已同步 |
| SYNC-06 | CAR 10 vs 17；`review_required`；`failed` | CF-05 / CF-06 / CF-33 | **已闭合**：17 项 + 7 值 verdict；CAR lifecycle = `running → <verdict>`；`failed` 已删除，唯一映射为 `assurance_unknown`（本轮已写入 `09` §2.4 与决策链 §7.4/§7.5） |
| SYNC-07 | verdict 与 lifecycle 两轴 | CF-06 | **已闭合**：CAR 三概念（lifecycle / verdict / `review_required`）见决策链 §7.4.1 与 `09` §2.4 表下注；CDR 两轴分离声明也已写入 `09` §2.4 表下注 |
| SYNC-08 | `reason.code` 命名空间 | `09` §3.2.2 | **已闭合**：共享折叠码 = `cg-wrong-dimension`（`09` §3.2.2 为唯一登记处）；线内诊断码保留 `compression-*`（见 §10.1 FD-3）；本目录不得使用非 `cg-` 前缀的折叠码 |
| SYNC-09 | 新增字段与支撑类型归属 | CF-10 / 11 / 13 / 14 / 16 / 18 | 已裁定（除 `carryForwardUnitIds`）；§8.1.1 / §12.1 已同步 |
| SYNC-10 | `carryForwardUnitIds` 与 Pi 适配层能力 | — | **仍开放**：属 Host 轨道 / 1b（BL-13） |
| SYNC-11 | 不可表达状态的折叠责任 | CF-21 | 已裁定（RK 折叠规则）；本线 §10.1 为 Compression 侧对应实现 |
| CF-40 | `PS.actions` 第五个许可位（`promotionRecommendation`） | CF-40 | **本线已闭合**：§4.1 schema 块删除该字段；§4.2.2 #2 与 §11 #18c 把 “第五个键” 列为 decode 失败；promotion 建议唯一位置 = CDQ `effectClass`（§4.1 SP-4c）。**注意：`05` §2.1 / `10` §3 仍标为 “待应用”，属 Implementation 待同步状态** |
| CF-41 | `RestoreTokenV1` 平面字段与 ISO-2 矛盾 | CF-41 | **本线已闭合**：§7.2 改为 `operationEpoch: number \| null` + `evaluationRunId: string \| null` + 平面互斥（RT-1…RT-6）；`01` §3.6 / `09` §1.2.3 已裁定。**注意：`05` §2.1 / `10` §3 仍标为 “待应用”，属 Implementation 待同步状态** |
| CF-46 | `unconvertible` 原生承载层多列了 `IR` | CF-46 | **本线已闭合**：§10 适用性表与 §10.1 折叠表均删 `IR`，原生层统一为 SP / RC / RK / OBS / ERM / PCR（与 `09` §3.1 / §3.2.2 第 4 行 / §7 第 28 条、检索线 `02` §3.2 `AP-1` / `AP-3` 一致）；同步把 §10.1 的“折叠层”列改为 `09` §3.2.2 第 3/4 行的口径（压缩内容实体 `CU`/`CM`/`CJ`/`CDQ`/`CDR`/`CAR`），并删除“不折叠”旧写法；§11 新增负例 #24。**未修改 shared matrix；Implementation 侧状态待同步** |
| CF-47 | `cancelled` / `timeout` 判定边界与来源码 | CF-47 | **本线已闭合**：§10 新增 `timeout` 行并改写 `cancelled` 行；§10.1 新增 `timeout` 来源码 `compression-deadline-exceeded` 与 `cancelled` 六值来源码；FD-5 为本线唯一判定表；§11 新增负例 #25。**Implementation 需同步 `09` §3 第 29 条附注（“压缩线 timeout 来源码尚未登记”已不成立）** |

完整阻断索引（B-CM / BL / UV）见 `compression-memory-rebase-report.zh-CN.md` §8 与 `implementation/06-blockers`。

## 13. 待评审问题

1. `unitId` 派生是否接受 “含 `contentHash` 的内容寻址”（内容微变即产生新 unit；替代方案是 cursor-only 身份 + 版本链）。
2. §6.2 的 retention 划分（`reopenable_only` 的 path / hash / revision 等允许 mask 但要求 byte_exact 重读校验）是否接受；或是否应把其中部分提升为 `context_inline`。
3. `evidence_text` 在保留 `exact_required` 的同时是否允许 “pointer 伴随而非替代”（当前 §6.2.1 定为不允许）。
4. `carryForwardUnitIds` 的字段表最终放在 CM intent（S7）还是 CM 本身（SYNC-10）。
5. `DisclosureRecordV1` / `MemoryReadRecordV1` 是否升为 T2（CF-20）；T4 名称与 schemaId 已裁定。
6. `reason.code` 的 `compression-*` 枚举字符集与登记方式（SYNC-08）。
7. `scopeId` 与现有运行时 `scopeId`（`MemoryCurrentManifestV1`）是否需要别名或迁移。
