# Compression Decision Chain v1（P0 冻结草案，proposed）

- 状态：proposed。本文冻结**顺序、每一步的输入/输出/失败语义**、Jev/Embedding advisory shadow、post-compaction audit、以及 Receipt 与 RunLedger 的挂接方式。**不实现运行时代码**，不执行真实 Pi compaction，不执行 lossy action，不执行 restore 演练，不接真实 Jev / EmbeddingGemma / 远程 Provider。
- 依据：架构 §27.2、§27.6、§27.7、§27.9#3、§18.2、§18.3、§23.3.1；`implementation/01-contract-draft.zh-CN.md`（ISO-1…8、CDQ/CDR/CAR 草案、8 动作词汇）；`context-unit-manifest-v1.zh-CN.md`（CU/CM、durable、当前清单指针）。
- 与 `01` 的关系：`01` 冻结共用不变量；本文负责把链路细化到可评审的步骤规格。冲突时以 `01` 不变量为准并回到评审；本文对 CAR `checks[]` 枚举与 `verdict` 的细化需评审后回填 `01` §4.10（§7.5）。
- 所有 hash 值一律写成 `sha256:<pending>`；不得把占位值当证据。

## 1. 范围与不变量

### 1.1 冻结的链路

```text
S1  ContextOperation admitted
S2  ContextUnitManifest durable
S3  protected / exact / pointer policy check
S4  Jev / Embedding advisory shadow
S5  deterministic Policy Gate
S6  Artifact / Manifest / Receipt commit
S7  Pi compaction
S8  post-compaction audit
S9  disclosure
S10 deterministic memory.read（Host / Memory Port）
S11 Agent continuation
```

### 1.2 链路不变量

| ID | 不变量 |
| --- | --- |
| DC-1 | 顺序不可颠倒；S6 全部 durable 之前不得进入 S7（不可逆 compaction） |
| DC-2 | Compression Controller 只能提交 CDQ；准入、授权、effect 由 Host Policy Gate 与 EffectGateway 完成；Controller 不持有 lease、不写 Kernel |
| DC-3 | 每个 runtime 步骤记录 `contextOperationId` 与 `operationEpoch`；任一步观察到不同 epoch → `epoch_mismatch`，只记为 stale diagnostic |
| DC-4 | 任一步非 ok，后续步骤要么降级（确定性规则 / 保留 / 外化 / 扩大上下文 / review），要么进入 `blocked` / `waiting` / `assurance_unknown`；**不存在 “失败但继续”** |
| DC-5 | effect 结果不明时一律 `no_automatic_replay`（架构 §18.3）；重试只能由新的 admission 产生新 epoch |
| DC-6 | 评测事实（`evaluationRunId` 的报告）不能改变本链路的任何状态；ISO-6 / ISO-7 |
| DC-7 | 每一步的产物只通过 Artifact / Manifest / RunLedger / Receipt Port 传递；禁止隐式全局缓存或共享可变内存（架构 §27.2） |
| DC-8 | 摘要、token 节省、confidence、相似度、压缩率都不是事实、证据或权限（§4） |
| DC-9 | `protection.class` 与 `PermissionScopeV1.actions` 不得互相推导；class 只表达保留要求，动作许可只看权限位（`context-unit-manifest-v1` §4.2、PC-2） |
| DC-10 | 不可表达的一等状态必须在观察层显式折叠，并保留原始状态（`context-unit-manifest-v1` §10.1）；禁止静默丢失或改写 |
| DC-11 | 每个 runtime 步骤的 11 项必填字段（输入 / 输出 / 成功 / 失败 / 可重试 / 可恢复 / receipt / manifest / hash / operationEpoch / audit evidence）缺一不可；缺失按 `unknown` 处理，不得默认为成功（§2.12） |
| DC-12 | Pi compaction 的 intent 必须携带 `carryForwardUnitIds[]`；不能表达时只能 `blocked`（§6、PC-10） |

### 1.3 `ContextOperationV1`（支撑类型，建议回填 `01`）

```ts
interface ContextOperationV1 {                  // schemaId = "pactile.cg.context-operation", v1
  plane: "runtime" | "evaluation";
  contextOperationId: string;                   // runtime 与 evaluation 命名空间隔离（ISO-3）
  kind: "unitize" | "compress" | "audit" | "memory_read" | "disclosure" | "recover";
  runId?: string; attemptId?: string; turnId?: string; operationEpoch?: number;   // runtime
  evaluationRunId?: string;                                                       // evaluation
  inputSnapshotHash: string;
  state: OperationStateV1;
  idempotencyKey: string;
  manifestRefs: EntityRefV1[];
  receiptRefs: EntityRefV1[];
  createdAt: string; updatedAt: string;
  provenance: ProvenanceV1;
}

type OperationStateV1 =
  | "prepared" | "admitted"
  | "manifest_durable" | "checked" | "advised" | "gated" | "committed"
  | "compacting" | "auditing" | "disclosed" | "reading" | "continued"
  | "restored" | "expanded" | "blocked" | "waiting" | "assurance_unknown";
```

规则：一次 **Context Operation 只有一条状态线**；`contextOperationId` 在 S1 分配后不变。`RunLedgerV1` 记录这些状态转换（§8）；评审前不新增第二套 operation store。

## 2. 逐步规格

行格式固定为：输入 / 输出 / 成功状态 / 失败状态 / 可重试 / 可恢复 / receipt / manifest / hash / operationEpoch / audit evidence。

### S1 ContextOperation admitted

| 项 | 规格 |
| --- | --- |
| 输入 | `workspaceId`、`sessionId`、`runId`、`attemptId`、`turnId`、触发原因（token 预算 / 阈值 / 手工 / 恢复）、`inputSnapshotHash`、`scopeId`、`policyVersion`、`providerCapabilitySnapshot`、`idempotencyKey` |
| 输出 | `ContextOperationV1`（state=`admitted`）+ RunLedger 的 Context Operation 条目；分配 `contextOperationId` 与 `operationEpoch` |
| 成功状态 | RunLedger 条目 durable 且可 read-back；epoch 冻结 |
| 失败状态 | `permission_denied`（scope/policy 不允许）、`epoch_mismatch`（迟到的旧 operation）、`unknown`（ledger 写入结果不明）、`blocked`（策略拒绝） |
| 可重试 | 允许，但必须使用新的 `idempotencyKey`；`unknown` 不得自动重放 |
| 可恢复 | 是；旧 Context 未受影响 |
| receipt | RunLedger Context Operation 条目（不是 Effect Receipt；尚无副作用） |
| manifest | 无 |
| hash | `inputSnapshotHash`（transcript 基准 + policyVersion + capability snapshot 的 canonical hash） |
| operationEpoch | 分配并冻结；后续所有步骤必须携带同一值 |
| audit evidence | admission 记录 + `idempotencyKey` + 触发原因 + RunLedger 条目引用 |

### S2 ContextUnitManifest durable

| 项 | 规格 |
| --- | --- |
| 输入 | transcript 基准快照（`transcriptHash` + cursor）、`unitizerVersion`、`policyVersion`、`ruleSetVersion`、`PermissionScopeV1` 观测、RetrievalPack 引用（如有）、预算 |
| 输出 | CM（draft）→ Artifact 写入 → Manifest store CAS → 当前清单指针前进（`context-unit-manifest-v1` §8） |
| 成功状态 | `durable.status = ok`：artifact 可读、CAS 成功、read-back 身份比对（manifestHash / generation / currentArtifactId / 指针）全部一致 |
| 失败状态 | `missing`（artifact 写入失败）、`manifest_conflict`（CAS 失败/指针前进）、`unknown`（read-back 不一致）、`permission_denied`（scope 不允许登记） |
| 可重试 | CAS 冲突允许 “重新读取 → 重做”；`unknown` 不得自动重放 |
| 可恢复 | 是；不产生任何不可逆效果 |
| receipt | 无 Effect Receipt；记录 manifest store revision 与 read-back 比对结果 |
| manifest | CM 本体（新 generation；`supersedes` 指向前一版） |
| hash | `manifestHash`、`transcriptHash`、`unitRefs` 聚合 hash |
| operationEpoch | 必须等于 S1 的 epoch |
| audit evidence | read-back 身份比对记录（4 项）+ CAS 返回值 + 指针前后值 |

### S3 protected / exact / pointer policy check

| 项 | 规格 |
| --- | --- |
| 输入 | CM 的 `unitRefs`（分类、anchor、recoverability、permissions、pointer） |
| 输出 | 每个 unit 的**处置候选集**与 `deterministicVerdict ∈ {allow, deny, review}`（per-unit，规则 id + ruleSetVersion） |
| 成功状态 | 每个 unit 都有明确分类与候选集；anchor 保留可行性已判定 |
| 失败状态 | `missing`（pointer 不可达）、`permission_denied`、`revision_mismatch`（source revision 不符）、分类 `unknown`（→ 该 unit 强制 `keep_full`，不算整链失败） |
| 可重试 | 是（修好来源后重建 CM 或重做检查） |
| 可恢复 | 是 |
| receipt | 无（无副作用）；检查结果 hash 写入 CDQ |
| manifest | 引用 `manifestRef`（EntityRefV1） |
| hash | `unitRefs` hash + 检查结果 hash |
| operationEpoch | 必须一致 |
| audit evidence | 每个 unit 的规则命中记录（规则 id、ruleSetVersion、anchor 列表） |

规则：**anchor 保留是硬约束**；判定为 “无法保留 anchor” 的 unit 只能 `deny` / `review` / `block`。`unknown` 分类按 `exact_required` 处理。

### S4 Jev / Embedding advisory shadow

| 项 | 规格 |
| --- | --- |
| 输入 | S3 之后的 unit 集合、capability snapshot（decision / embedding provider）、deadline、shadow 模式标记 |
| 输出 | `CompressionJudgment`（CJ）记录：action、confidence、rationale hash、输入/响应 hash、latency；**只记录，不执行** |
| 成功状态 | CJ `action.status = ok`（含 `drop` / `lossy_compress` 建议，仅记录） |
| 失败状态 | `provider_unavailable`、`timeout`、`invalid_response`（schema 不符 / 非有限浮点 / confidence 越界）、`stale`（wrong generation）、`invalid_response`（wrong dimension） |
| 可重试 | 是（advisory；重试不得改变最终决策的确定性） |
| 可恢复 | 不适用（无副作用） |
| receipt | 无（CJ 是 advisory artifact） |
| manifest | 引用 `manifestRef` |
| hash | `inputHash`、`responseHash`、`rationaleRef` |
| operationEpoch | 必须一致；不一致 → `epoch_mismatch`，CJ 作废 |
| audit evidence | CJ 记录 + provider capability snapshot 引用 + 降级原因（§5.3） |

规则：S4 的失败**不阻断链路**，但必须降级并记录；`shadow` 与 `authoritative` 必须在 plan/judgment 中显式标注，shadow 结果永不能进入执行动作（`01` §4.1）。

### S5 deterministic Policy Gate

| 项 | 规格 |
| --- | --- |
| 输入 | CDQ（`manifestRef` 必须是 durable 的 CM；proposals 含 action、effectClass、judgmentRefs、deterministicVerdict、rollbackRef）；`policyVersion`；permission 事实；epoch/lease 事实 |
| 输出 | 每个 proposal 的 `allow / deny / review` 判决 + 规则 id 列表；形成准入范围（v1 只允许 `effectClass ∈ {none, reversible}`） |
| 成功状态 | 判决为 `allow` 的 proposal 集合已冻结；判决可复现（同输入同 `bodyHash`） |
| 失败状态 | `blocked`（策略拒绝）、`epoch_mismatch`（lease/epoch 不符）、`manifest_conflict`、`unknown`（gate 结果不明 → 不得执行） |
| 可重试 | 是（确定性判决；重试必须给出相同结果，否则是 determinism 缺陷） |
| 可恢复 | 是 |
| receipt | 触发 CDR（host 侧生成）；gate 判决 hash 记录在 CDR.policy |
| manifest | 引用 `manifestRef` |
| hash | `policyVersion` + 判决 hash + CDQ `inputHash` |
| operationEpoch | 必须一致；lease epoch 由 RunLedgerCoordinator 判定（BL-05） |
| audit evidence | 逐 proposal 的规则命中 + 被覆盖的 CJ 列表 |

规则：**Gate 是唯一准入权威**。`drop`、`lossy_compress` 在 v1 一律 `deny` 或 `review`；`effectClass: "promotion_recommendation"`（它是 `01` §4.8 的 **CDQ proposal 意图字段**，**不是** `PermissionScopeV1.actions` 的许可位，见 `context-unit-manifest-v1` §4.1 SP-4c / CF-40）在 v1 同样只能得到 `deny` 或 `review`，且只能产生建议，不能提交 Kernel 命令。

`review` 判决的人工作业落点（契约级，回应 `10-p0-exit-checklist` 条件 5）：

```text
Gate verdict = review
  → RunLedger 写入 approval_request 条目（kind: context_operation_review，引用 CDQ / manifestRef / 待决 proposal）
  → Context Operation state = waiting（不执行任何 reversible / lossy 动作）
  → 人工或 Kernel 走正式审批命令（Kernel command / approval），产生 approvalRef + Evidence 要求
  → 获批后必须发起**新的 admission**（新 contextOperationId / 新 operationEpoch），重走 S2–S6
  → 拒绝则 state = blocked，保留旧 Context
```

约束：Controller 不能自批；审批活动不得由评测 `evaluationRunId` 或模型输出发起；`waiting` 期间不得启动 Pi compaction；审批结果只能通过 RunLedger / Kernel 记录，不得写在 CDR 的 `advisory` 字段里。`review_required` 在 CDR / CAR 中仅表示 “需要外部决定”，不表示已批准。

### S6 Artifact / Manifest / Receipt commit

| 项 | 规格 |
| --- | --- |
| 输入 | S5 的 `allow` 集合、rollback 引用、`idempotencyKey`、`operationEpoch`、lease/epoch 事实 |
| 输出 | （a）Artifact：被 mask / externalize / project 的载荷与 pointer；（b）新 CM generation（`supersedes` 指向前一版）；（c）CDR 作为 Effect Ledger 的 typed payload |
| 成功状态 | 三者全部 durable 且 read-back 一致；CDR.receiptHash 与 ledger 条目一致；当前清单指针前进并可再次 read-back |
| 失败状态 | 任一项 `unknown` → `assurance_unknown`，**不得进入 S7**；`manifest_conflict` → 重读重做；`missing` → 恢复 |
| 可重试 | 以 `idempotencyKey` 幂等；`unknown` 不得自动重放 |
| 可恢复 | 是；旧 Context 与旧清单仍然可读 |
| receipt | `CompressionDecisionReceipt`（CDR）+ RunLedger `EffectLedgerEntryV1` |
| manifest | CM v(n+1)（`supersedes` = v(n)） |
| hash | `receiptHash`、`manifestHash`、artifact `contentHash`、`inputHash` |
| operationEpoch | 必须一致；CDR 记录 leaseId + epoch + revision |
| audit evidence | 三份 read-back 记录 + ledger 条目引用 + 指针前后值 |

### S7 Pi compaction

| 项 | 规格 |
| --- | --- |
| 输入 | CDR 的 `allow` 结果、compaction intent（cut-point / `firstKeptEntryId` / 保留单元 / mask 计划）、版本锁定的 Pi adapter、lease/epoch fence |
| 输出 | Pi compaction 结果 + **session tree 的显式记录**；`PiCompactionRecordV1`（建议类型，见 §6） |
| 成功状态 | compaction 结果进入 session tree，其基准（cut-point、保留范围）与 intent 一致；pre-compaction `transcriptHash` 记录在案 |
| 失败状态 | Pi error / abort / `unknown`（无 receipt）；任何 `unknown` 都视为**不可逆的未决 effect**。其中 abort 按 CF-47 判源：调用方 / 上层 / 父级 deadline 触发的 abort → `cancelled` + 对应来源码；但中断后无 receipt 时 effect 仍未决，必须归入 `assurance_unknown`（DC-4 / §7.4.1） |
| 可重试 | **不允许自动重试**；重试必须由新的 admission（新 epoch）显式发起 |
| 可恢复 | 部分：原文与 pointer 已 durable，可经 S10 重建上下文；transcript 本身按 Pi 的 append-only tree 语义处理，不假设可回滚 |
| receipt | Pi commit receipt 引用 + `PiCompactionRecordV1`；审计结果见 S8 |
| manifest | 引用 CM（S6 的 generation）；不产生新清单 |
| hash | `beforeTranscriptHash`、`piCompactionId`、tree entry hash、intent hash |
| operationEpoch | 必须一致；旧 Attempt/epoch 的结果 → `epoch_mismatch`（只记 stale diagnostic） |
| audit evidence | compaction 前后 transcript hash、session tree 记录、Pi 版本与 adapter 版本 |

**P0 现状差距（BL-13 / B-CM-2）**：当前实现中摘要未进入 Pi session tree，重启后 transcript 与 checkpoint 不一致。本条要求 “compaction 必须有显式 session tree 记录”，属于 1b 运行时任务，P0 不修改代码。

### S8 post-compaction audit

| 项 | 规格 |
| --- | --- |
| 输入 | S6 的清单与 receipt、S7 的实际结果、当前工作树/transcript 观测、epoch/lease 事实 |
| 输出 | `CompactionAuditReceipt`（CAR），含 §7 的 17 项 check 与 verdict |
| 成功状态 | 全部 check `pass`；verdict=`accepted` |
| 失败状态 | check 非 pass → verdict ∈ `restored / expanded / blocked / waiting / assurance_unknown / review_required`（§7.4）；**不存在静默接受** |
| 可重试 | audit 本身可重跑（只读）；但重跑不改变已发生的 compaction 事实 |
| 可恢复 | 是：恢复原 Artifact / 扩大 Context / 进入 waiting；恢复动作产生**新的 CM generation** 记录恢复决策 |
| receipt | CAR（typed payload，挂到 RunLedger Effect Ledger） |
| manifest | 恢复路径下产生新的 CM（`supersedes` 指向 compacted 版；`provenance.causation` = 失败的 audit id） |
| hash | `snapshots.beforeHash` / `afterHash`、各 check 的 `detailHash`、`receiptHash` |
| operationEpoch | 必须一致；`epoch_fence` check 专门核验 |
| audit evidence | 17 项 check 的逐项记录 + 失败样本（regression case 引用） |

### S9 disclosure

| 项 | 规格 |
| --- | --- |
| 输入 | S8 verdict 为 `accepted`（或显式恢复决策）的 CM、restore token、when-to-read 指令、scope |
| 输出 | `DisclosureRecordV1`（schemaId = `pactile.cg.disclosure-record`；字段形状沿用本决策链）：指向 manifest pointer 与 token 的**结构化披露**；写入 Artifact 并可被 CM 引用 |
| 成功状态 | disclosure 记录 durable；pointer 可达；披露内容只含 pointer / hash / 指令，不含原文与摘要替代品 |
| 失败状态 | `missing`（`memory_disclosure_missing`）→ 链路进入 `blocked`，不得把未披露的压缩结果当作可信上下文 |
| 可重试 | 是（幂等） |
| 可恢复 | 是 |
| receipt | 无 Effect Receipt；披露记录引用写入 CM / Artifact |
| manifest | 引用 `manifestRef` |
| hash | disclosure `bodyHash`、token 引用、pointer 引用 |
| operationEpoch | 必须一致 |
| audit evidence | 披露记录 + pointer/token 引用 |

**禁止**：以 user-role 消息注入自然语言摘要或 “记忆更新提示” 充当披露（旧设计缺陷 #8：摘要被当作事实）。披露只允许结构化 pointer + 读取指令。

### S10 deterministic memory.read（Host / Memory Port）

| 项 | 规格 |
| --- | --- |
| 输入 | `memory.read` 请求：pointer / unitRef、期望 `manifestGeneration` + `manifestHash`、期望 `contentHash`、`scopeId`、**平面字段**（runtime：`operationEpoch`；evaluation：`evaluationRunId`；两者恰好一个非空，且必须与 token 同平面）、restore token、字节/时间预算 |
| 输出 | 内容（byte_exact 或 semantic_only）+ `MemoryReadRecordV1` 校验记录（schemaId = `pactile.cg.memory-read-record`；字段形状沿用本决策链） |
| 成功状态 | 校验全部通过：scope、权限、pointer 可读、revision、generation、hash、epoch、token 绑定一致 |
| 失败状态 | `missing`（artifact/pointer 不存在）、`permission_denied`、`stale`、`revision_mismatch`、`epoch_mismatch`、`manifest_conflict` |
| 可重试 | 是（只读） |
| 可恢复 | 是 |
| receipt | `MemoryReadRecordV1`（request/response hash + 校验结果），挂到 RunLedger 的 Context Operation 条目 |
| manifest | 引用并校验 `manifestRef` / 当前指针 |
| hash | request hash、response `contentHash`、校验结果 hash |
| operationEpoch | runtime 平面：必须与 token / 请求一致；evaluation 平面：本字段为 `null`，改用 `evaluationRunId` 与 token / 请求一致（`context-unit-manifest-v1` §7.2 RT-1/RT-3） |
| audit evidence | 逐项校验结果 + token 绑定记录 |

规则：

- **必须经 Host / Memory Port**：Agent 不得绕过 Protocol 读取 Runtime Store、transcript 文件、artifact 目录或内存对象（架构 §27.7）。
- 读取失败时**禁止**用 “搜索整个仓库猜位置” 代替；只能扩大上下文、恢复或 `block`（旧设计不变式：恢复只允许保留索引重读或确定性 `memory.read`）。
- `semantic_only` 结果必须显式标注，并禁止用于 exact anchor 的校验。

### S11 Agent continuation

| 项 | 规格 |
| --- | --- |
| 输入 | verified 上下文（disclosure + read 结果）、CAR verdict、当前 Run/Attempt 状态 |
| 输出 | Agent 继续执行；或进入 `expanded` / `blocked` / `waiting` / `assurance_unknown` 明确状态 |
| 成功状态 | 继续执行基于已验证上下文；无未决 effect；无 “摘要替代事实” |
| 失败状态 | 任一前置非 ok → 必须显式进入恢复/阻断状态，不得继续 |
| 可重试 | 由新 admission 决定 |
| 可恢复 | 是 |
| receipt | RunLedger 的 Context Operation 状态转换（`continued` / `blocked` / …） |
| manifest | 引用最终生效的 CM |
| hash | `finalManifestHash` + `finalTranscriptHash` |
| operationEpoch | 关闭该 epoch；后续操作必须新 epoch |
| audit evidence | 链路终态记录 + 全部 receipt 引用链 |

### 2.12 十一个必填字段的完整性矩阵（回应任务书三.1）

● = 该步必须给出且非空；○ = 该步**明确不适用**（必须在步骤规格里写明理由，不得留空）。

| 步骤 | 输入 | 输出 | 成功 | 失败 | 重试 | 恢复 | receipt | manifest | hash | epoch | audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 admission | ● | ● | ● | ● | ● | ● | ○ 无副作用，不产生 Effect Receipt | ○ 尚无 manifest | ● | ● | ● |
| S2 manifest durable | ● | ● | ● | ● | ● | ● | ○ 记 manifest store revision | ● | ● | ● | ● |
| S3 policy check | ● | ● | ● | ● | ● | ● | ○ | ● | ● | ● | ● |
| S4 advisory shadow | ● | ● | ● | ● | ● | ○ 无副作用 | ○ | ● | ● | ● | ● |
| S5 Policy Gate | ● | ● | ● | ● | ● | ● | ● 触发 CDR | ● | ● | ● | ● |
| S6 commit | ● | ● | ● | ● | ● | ● | ● CDR | ● | ● | ● | ● |
| S7 Pi compaction | ● | ● | ● | ● | ○ 禁止自动重试 | ● 部分（依赖 S6） | ● Pi commit + `PiCompactionRecordV1` | ● | ● | ● | ● |
| S8 post-audit | ● | ● | ● | ● | ● 可重跑 | ● | ● CAR | ● | ● | ● | ● |
| S9 disclosure | ● | ● | ● | ● | ● | ● | ○ | ● | ● | ● | ● |
| S10 memory.read | ● | ● | ● | ● | ● | ● | ● `MemoryReadRecordV1` | ● | ● | ● | ● |
| S11 continuation | ● | ● | ● | ● | ● | ● | ● 状态转换 | ● | ● | ● | ● |

规则：任一 ● 字段缺失或非 ok → 该步按 `unknown` 处理并停止向下推进（不得默认为成功）；○ 必须在步骤规格中有明确理由（上表括号内即为理由）。

## 3. 端到端时序（文字版）

```text
Agent / Host                Compression Controller              Host / Policy / EffectGateway
    │ 触发压缩                       │                                    │
    ├───────────────────────────────►│ S1 admission（RunLedger 条目）      │
    │                                ├───────────────────────────────────►│
    │                                │ S2 unitize + CM durable + read-back │
    │                                │ S3 分类 / anchor / pointer 检查      │
    │                                │ S4 Jev/Embedding shadow（只记录）    │
    │                                │ S5 提交 CDQ ────────────────────────►│ Policy Gate 判决
    │                                │◄──── allow / deny / review ─────────┤
    │                                │ S6 Artifact/Manifest/CDR commit     │
    │                                │◄─────────── durable + read-back ────┤
    │                                │ S7 Pi compaction（Host 批准 + 版本锁定）
    │                                │◄─────────── compaction 结果 ────────┤
    │                                │ S8 post-compaction audit（CAR）      │
    │                                │ S9 disclosure（pointer + token）     │
    │◄──── disclosure ───────────────┤                                     │
    ├──── memory.read（经 Port）────►│ S10 校验 + 返回内容                  │
    │◄──── 内容 + 校验记录 ───────────┤                                     │
    └──── S11 continuation ──────────┴─────────────────────────────────────┘
```

## 4. 非替代规则

| 输出 | 不能替代 | 说明 |
| --- | --- | --- |
| Jev judgment | Policy、Receipt、Evidence、Kernel fact、Permission、source revision、generation、hash、epoch | advisory；只能被 CDR 引用为 “被采用/被覆盖” |
| EmbeddingGemma 相似度 | 同上 | 只影响候选排序；不能证明真实性、无匹配、权限 |
| Pi summary / token 节省 | 同上 | 模型可见投影；不是事实源，也不是回收证明 |
| confidence | 权限、事实、Evidence、Kernel fact、compaction approval、memory promotion authorization | 只用于降级判断；`confidence` 越界即 `invalid_response` |
| 压缩率 / 节省字节 | 验收门槛 | 只能作为指标报告，不能替代 audit 与授权 |
| Evaluation report | Kernel Evidence、产品 Run 状态 | ISO-6 / ISO-7；`affectsProductRun = false` |

## 5. Jev / Embedding advisory shadow（冻结）

### 5.1 八个 action

| 动作 | 效果等级 | 最早可执行阶段 | shadow 记录 | v1 执行 |
| --- | --- | --- | --- | --- |
| `keep_full` | none | — | 是 | 允许（默认） |
| `mask_reopenable` | reversible | 5 | 是 | 仅 stage 5 后 |
| `externalize` | reversible | 5 | 是 | 仅 stage 5 后 |
| `structured_project` | reversible | 5 | 是 | 仅 stage 5 后 |
| `lossy_compress` | lossy | 6 | 是 | 否（需 stage 6 + 正式授权 + post-audit） |
| `drop` | lossy（破坏性） | 不开放 | 是 | **否**：只能作为 shadow judgment 或 `request_review` 输入 |
| `request_review` | control | 4（记录）/ 随时 | 是 | 允许 |
| `block` | control | 随时 | 是 | 允许 |

### 5.2 advisory 输出（`CompressionJudgment`，`01` §4.7）

- `action` / `confidence` 都是 `ObservedV1`；非 ok 时不得伪造默认值。
- `provenance.authority` 恒为 `advisory`；任何把 CJ 提升为 `deterministic` / `host` / `kernel` 的写法都是 decode 失败。
- shadow 模式下，CJ 不得进入 `items` / 执行集合，只进入评测记录与 CDR 的 `adopted` / `overridden` 列表。

### 5.3 降级矩阵（13 个触发）

| # | 触发 | 观察到的状态 | 必须降级为 | 禁止 |
| --- | --- | --- | --- | --- |
| 1 | low confidence | `action.ok` 但 confidence 低于预注册阈值 | 确定性规则 / `keep_full` / `request_review` | 用低置信建议执行 reversible 动作 |
| 2 | provider unavailable | `provider_unavailable` | 确定性规则；披露原因 | 视为 “provider 说没有” |
| 3 | timeout（**该工作单元自身** deadline 到期） | `timeout` | 使用更低保证结果 + 披露；来源码 `compression-deadline-exceeded` | 当作空结果；当作无命中；把上层 / 父级 deadline 触发的 abort 写成 `timeout` |
| 4 | invalid response | `invalid_response`（非 JSON / schema 不符 / 非有限浮点 / confidence 越界） | 丢弃该响应；`keep_full` / `externalize` / `request_review` | 修补后部分接受 |
| 5 | schema mismatch | `invalid_response` | 同上 | 用旧 schema 解析后继续 |
| 6 | wrong generation | `generation_mismatch`（不是 `stale`；两者互不替代，`01` §3.3） | 失效该 judgment；重建 / 降级到确定性规则 | 当作有效建议；折叠为 `stale` 后丢掉原状态 |
| 7 | wrong dimension | 原生层 `wrong_dimension`（PCS / RC / RP / OBS / ERM / PCR，`09` §3.1） | 唯一折叠层 = **`CJ.action`**（`09` §3.2.2 第 2 行）：`fold = { foldRule: "fold-09-3.2.2-wrong-dimension", reason: { code: "cg-wrong-dimension", detailHash: <非空> } }`，status = `invalid_response`；整批丢弃；不进入任何动作 | 当作低分建议；截断/补零后接受；折叠后丢失原状态；使用非 `cg-` 前缀的折叠码 |
| 8 | stale source | `stale` / `revision_mismatch` | 重新 unitize / Inspect | 沿用旧分类 |
| 9 | pointer missing | `missing` | 恢复或 `block` | 把 missing 当 “无内容” |
| 10 | permission denied | `permission_denied` | `block` + 请求授权 | 绕过 Port 读取 |
| 11 | source revision mismatch | `revision_mismatch` | 重新 Inspect / 重建 CM | 当作 fresh |
| 12 | operation epoch mismatch | `epoch_mismatch` | 作废该 judgment / 结果；记 stale diagnostic | 合并进当前 Attempt |
| 13 | manifest conflict | `manifest_conflict` | 重新读取并重做 | 覆盖写入；静默取最后写入者 |
| 14 | 不可表达状态（`wrong_dimension` / `unconvertible` / `epoch_mismatch` on CU） | 观察层保留原状态 | 按 `context-unit-manifest-v1` §10.1 显式折叠 + `reason.code` + `detailHash` | 静默折叠、丢掉原状态、把折叠值当原值上报 |
| 15 | carry-forward 无法表达 | Pi 适配层不支持 `carryForwardUnitIds` | `blocked`；保留旧 Context | 用摘要代替 `exact_required` 单元；先压缩后补记录 |
| 16 | judgment 迟到（旧 epoch / Attempt） | `epoch_mismatch` 属 CM / CDQ / CDR / CAR；CJ **不可表达** | 作废该 judgment；由消费层（CDR）记 `epoch_mismatch`；CJ 本体不得写入该状态 | 把 lease/Attempt 语义写进 CJ；合并进当前 Attempt |
| 17 | 取消（调用方取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop） | `cancelled`（与 `timeout` 可区分；来源码见 `context-unit-manifest-v1` §10.1 FD-5） | 使用已有的更低保证结果并披露；取消响应有上界 | 折叠为 `timeout` / `ok`；当作空结果；把 `timeout` 写成 `cancelled` |

### 5.4 confidence 边界

`confidence` **不得**被解释为：权限（permission）、事实（fact）、Evidence、Kernel fact、compaction approval、memory promotion authorization。它只能参与 “是否需要降级到确定性路径” 的判断，且阈值必须预注册（`compression-memory-evaluation-matrix-v1.zh-CN.md` §6）。

## 6. Pi compaction 适配契约（P0 冻结语义）

1. **只有 Host 批准的 compaction 才能执行**；Controller 不能直接调用 Pi compaction。
2. Pi 返回的摘要、token 节省、模型判断都不是 Kernel fact；`summary` 只能作为 `ContextUnit`（`kind = "summary"`）被引用，且永远不是 exact 内容。
3. compaction 必须有**显式 session tree 记录**：`PiCompactionRecordV1`（建议类型）

```ts
interface PiCompactionRecordV1 {               // schemaId = "pactile.cg.pi-compaction-record", v1；**平面：runtime 专有**（evaluation 平面不存在 Pi compaction）
  piCompactionId: string;                      // Pi 侧标识（不透明）
  sessionId: string; branchId: ObservedV1<string>;
  adapter: { package: string; version: string; apiVersion: string };   // P0：1.0.2 与 provenance 不一致 → unverified（BL-20）
  intentHash: string;                          // cut-point / firstKeptEntryId / 保留集合
  beforeTranscriptHash: string; afterTranscriptHash: ObservedV1<string>;
  treeEntryRef: ArtifactRefV1 | null;          // session tree 记录引用；null → 视为未闭合
  commitReceiptRef: ArtifactRefV1 | null;
  contextOperationId: string; operationEpoch: number;   // runtime 专有，因此 epoch 必填；不得与 RestoreTokenV1 的平面互斥规则（§7.2 RT-1）混用
}
```

4. compaction intent 必须携带 `carryForwardUnitIds[]`（全部 `exact_required` 单元）与 `keptUnitIds[]`；二者在压缩后必须逐字节重新出现（PC-10）。
5. `treeEntryRef = null` 或 `afterTranscriptHash` 非 ok：该 compaction **未闭合**；不得标记为成功，必须进入 S8 的失败出口（BL-13）。
6. 版本不一致（已安装 1.0.2 vs provenance 1.0.4）在 P0 只记录为 `unverified`；真实 compaction 证据必须锁定版本（BL-20）。
7. compaction 不可逆，所以 S7 之前必须完成 S6 的全部 durable 提交（DC-1）。

## 7. post-compaction audit（`CompactionAuditReceipt` 细化）

`schemaId = "pactile.cg.compaction-audit-receipt"`，`schemaVersion = 1`（与 `01` §4.10 一致）。

### 7.1 17 项 check

| # | check id | 比较对象 | pass 条件 | 非 pass 状态 |
| --- | --- | --- | --- | --- |
| 1 | `source_cursor` | 压缩后 context 的 cursor 与 CM `transcriptCursor` | 保留范围与 intent 一致，未越界 | `revision_mismatch` |
| 2 | `exact_anchor` | 每个 `exact_required` unit 的 anchor `valueHash` | 重读后重算 hash 全部一致 | 任一丢失 → `fail`（不可接受） |
| 3 | `protected_content` | `protected` unit 的语义完整性 | 原文或 byte_exact pointer 可读且未被改写 | `fail` |
| 4 | `tool_call_pairing` | `toolCallId` 与配对关系 | 配对完整、id 未变、无孤立 result | `fail` |
| 5 | `permission` | `PermissionScopeV1`（`context-unit-manifest-v1` §4.1；早前草案的 `PermissionSetV1` 已废弃） | 压缩后未扩大读取范围、未降低保护 | `fail` |
| 6 | `source_hash` | `sourceHash`（原始字节） | 与压缩前记录一致 | `fail`（篡改或错误 hash） |
| 7 | `source_revision` | `SourceRevisionRefV1` | 与 CM 基准一致 | `revision_mismatch` |
| 8 | `generation` | `GenerationRefV1` | manifest/index/semantic generation 一致 | `generation_mismatch`（不得折叠为 `stale`） |
| 9 | `worktree_fence` | worktree / branch 观测 | 与 CM 基准一致，未切换分支 | `revision_mismatch` |
| 10 | `semantic_drift` | 残存单元与新 summary 的语义关系（确定性可判定部分） | 语义漂移在预注册界限内；无法判定 → 非 ok | `unknown`（不得判 pass） |
| 11 | `jev_preservation` | 被 CDR 采纳/覆盖的 CJ 与结果 | 采纳与被覆盖关系可复现；advisory 未被升级 | `fail` |
| 12 | `pointer_reachability` | 每个 pointer（`01` §4.10 AU-7：旧名 `pointer_readable` → 本名；本线早前草案的 `pointer_reachability` 写法即为最终名） | 经 Memory Port 可读（只读元数据，不读原文） | `missing` |
| 13 | `manifest_current_pointer` | 当前清单指针 | 指针 hash/generation 与 CM 一致 | `manifest_conflict` |
| 14 | `memory_read_probe` | 每个 restore token 的抽样重读 | 校验全部通过且 `contentHash` 一致 | 非 ok 即 `fail` |
| 15 | `epoch_fence` | `operationEpoch` / lease epoch / Attempt | 与 S1 冻结值一致 | `epoch_mismatch`（结果只记 stale diagnostic） |
| 16 | `supersedes_relation` | CM 版本链 | 前驱/后继关系完整、无断裂 | `manifest_conflict` |
| 17 | `rollback_reference` | `rollbackRef` 与恢复路径 | 恢复引用可解析、可读取（不执行恢复） | `missing` |

### 7.2 check 的通用规则

- 每个 check 的结果是 `ObservedV1<"pass" | "fail">`；**没有默认值**，无法判定就是非 ok。
- **AU-8（本线，避免与 `01` 的 AU-6/AU-7 冲突）不适用不得静默省略**：不对该动作类别生效的 check 必须显式记录为 `not_applicable` + 理由，不得直接不写（否则无法区分 “通过” 与 “没跑”）。
- `semantic_drift` 与 `jev_preservation` 中任何依赖模型的部分只允许作为**辅助诊断**；不能把 “模型说没漂移” 写成 pass（P0 允许 `unknown` 并据此进入 review）。
- **AU-9（本线）精确比对优先**：`exact_anchor` 必须同时校验 “audit 重读后 hash 一致” 与 “`carryForwardUnitIds` 在压缩后的 Context 中逐字节存在”；两个子条件任一不成立即 `fail`。
- Check 只读；audit 期间不得修改 Context、transcript、manifest 或 artifact（与 `01` §4.10 AU-3 同口径）。

### 7.3 audit 证据

- 每项 check 记录：输入 hash、比较结果、`detailHash`（差异样本的 hash，不落原文）。
- 失败样本必须生成 regression case 引用（EC），并在 `verdict` 的 `regressionCaseRef` 记录。
- 证据索引追加式，不删除、不改写。

### 7.4 verdict 与失败出口

| verdict | 触发 | 必须的后续动作 | 禁止 |
| --- | --- | --- | --- |
| `accepted` | 17 项全部 pass | 进入 S9 disclosure | 存在任一非 pass 时使用 |
| `restored` | exact/protected 内容丢失但 Artifact 可恢复 | 恢复原 Artifact；产生新 CM generation 记录恢复决策 | 假装压缩成功 |
| `expanded` | 恢复不足，需要扩大 Context | 重新 unitize / 扩大保留范围；新 CM | 用摘要填补缺口 |
| `blocked` | 权限、provenance、不可恢复内容 | 停止链路；Run 进入 blocked | 继续执行副作用 |
| `waiting` | 依赖不可用（provider/store） | 等待并保留旧 Context | 超时后静默成功 |
| `assurance_unknown` | effect 结果不明（含 compaction 无 receipt）**或 audit 自身未能得出结论**（检查执行失败 / 依赖不可用且不可等待） | 人工 reconcile；`no_automatic_replay` | 自动重试 compaction；写成 `failed` / `error` |
| `review_required`（CF-06：`01` §4.10 已列入 verdict 枚举） | 需要人工/外部判定（如 `semantic_drift` 无法判定、或 Policy Gate 对某 proposal 给出 `review`） | 人工 review + approval 流程（**完整规格见 §7.6；契约落点 = `01` §4.14**）；期间不执行新动作 | 自动放行；未获批就重走 S6；把 “已发请求” 当授权 |

> 出口清单与任务要求一致：恢复原 Artifact / 扩大 Context / `blocked` / `waiting` / `assurance_unknown` / 生成 regression case / 请求人工 review。**不得静默接受无法重读的摘要。**

#### 7.4.1 lifecycle / verdict / `review_required` 三者关系（唯一规定）

| 概念 | 取值 | 关系与禁止 |
| --- | --- | --- |
| lifecycle（处理进展） | 非终态 `running`；终态 **= verdict** | CAR 的终态名只有一个来源：上表 7 值。**不存在 `failed` / `error` / `unknown` 作为 lifecycle 词**；audit 自身未能得出结论时必须写 `assurance_unknown`（不是 `failed`、也不是 `blocked`） |
| verdict（审计结论） | `accepted` / `restored` / `expanded` / `blocked` / `waiting` / `assurance_unknown` / `review_required`（`01` §4.10，7 值） | `accepted` 仅当 17 项全 `pass`；其余六值均为非成功结论，各自对应上面的后续动作 |
| `review_required` |  verdict 之一（**不是独立 lifecycle 分支，也不是 `waiting` 的同义词**） | `waiting` = 依赖暂不可用、可恢复等待；`review_required` = 必须由外部（人 / Kernel）决定。两者不得互换、不得合并。`review_required` 写出后不得被审批追溯改为 `accepted`（`01` §4.10 AU-6） |

`failed → assurance_unknown` 的唯一映射理由：audit 进程 / 依赖失败时，“结论未知”而不是“确定拒绝”；`blocked` 保留给确定性拒绝（权限、provenance、不可恢复内容）。

### 7.5 与 `01` §4.10 的对应（17 项；CF-05 / CF-06 已裁定）

`01` §4.10 已经修复轮统一为 **17 项**（CF-05 / CF-33），旧 10 → 新 17 的映射见其 AU-7。本文不再提出“合并提案”，只保留逐项职责说明，并标注与 `01` 的对应：

| 合并后 id | 来源 | 变更 | 新增登记要点 |
| --- | --- | --- | --- |
| `source_cursor` | `01` #1 | 保留 | — |
| `exact_anchor` | `01` #2 | 保留 + 扩展 | 增加 “`carryForwardUnitIds` 在压缩后 Context 中逐字节存在” 子条件（AU-7） |
| `protected_content` | 新增 | — | `protected` 单元的语义完整性；与 `exact_anchor` 的区别：后者比 hash，前者比 “未被语义改写” |
| `tool_call_pairing` | 新增 | — | `toolCallId` 与 call/result 配对完整；对齐 `findValidCutPoints` 不变量 |
| `permission` | `01` #3 | 保留 | 比较对象改为 `PermissionScopeV1`（原引用 `PermissionSetV1` 已废弃） |
| `source_hash` | `01` #4 `hash` | **重命名 + 收窄** | 只校验源原始字节 hash；`textHash` 不得充当（`09` §4） |
| `source_revision` | `01` #5 | 保留 | — |
| `generation` | 新增 | — | manifest / index / semantic generation 一致；非 pass 用 `generation_mismatch` |
| `worktree_fence` | 新增 | — | worktree / branch 与 CM 基准一致 |
| `semantic_drift` | `01` #6 | 保留 | 依赖模型的部分只能是辅助诊断（§7.2） |
| `jev_preservation` | `01` #7 | 保留 | advisory 未被升级为 deterministic / host |
| `pointer_readable` | `01` #8 | 保留（本线早前别名 `pointer_reachability` 已撤回） | 经 Memory Port 可读；不读原文 |
| `manifest_current_pointer` | 新增 | — | 指针与 CM 一致；指针语义与 “不是” 清单见 `context-unit-manifest-v1` §8.4 |
| `memory_read_probe` | `01` #10 | 保留 | 抽样重读；包含 artifact 内容 hash 校验 |
| `epoch_fence` | `01` #9 | 保留 | 失败 → `epoch_mismatch`，只记 stale diagnostic |
| `supersedes_relation` | 新增 | — | 链完整性（前驱可解析 + generation 连续 + `bodyHash === 上一版 manifestHash`）；`supersedes` 类型见 CF-09（`EntityRefV1`） |
| `rollback_reference` | 新增 | — | `rollbackRef` 可解析、可读（**不执行**恢复） |

`verdict` 枚举：`01` §4.10 为 **7 项**（CF-06），与本文件 §7.4 逐字一致。**CAR lifecycle 与 verdict 的关系已闭合（见 §7.4.1）**：`09` §2.4 的 `failed` 已按本线提议删除，唯一映射为 `assurance_unknown`；`running` 是唯一非终态，终态名 = verdict。

> **状态（CF-05 / CF-06 / CF-33）：已裁定。** `01` §4.10 与 `04` §8 已采用 17 项与 `review_required`；检查枚举以 `01` 为准，本表为其职责说明。两个 verdict 枚举（CDR / CAR）均含 `review_required` **但不得互换**（CDR = 决策结果轴；CAR = 审计结论轴），见 SYNC-07 的残余项。

> **残余（CF-06 部分）：已闭合。** `01` §4.9 的 CDR `verdict`（决策结果轴）与 `09` §2.4 的 CDR lifecycle（effect 推进轴：`pending → succeeded/failed/unknown → reverted/superseded`）是两个轴；两轴分离声明已写入 `09` §2.4 表下注（本轮）。此处保留 CDR lifecycle 中的 `failed` 是**effect 轴**取值，与 CAR 已删除的 `failed` 无关。

### 7.6 `review_required` 完整规格（回应任务书三.2）

`review_required` 是 “需要外部决定才能继续” 的一等结论，不是成功也不是失败。

| 问题 | 规定 |
| --- | --- |
| 谁产生 | （a）S5 Policy Gate 对某 proposal 给出 `review` → CDR.verdict = `review_required`；（b）S8 audit 因检查无法判定（如 `semantic_drift`）→ CAR.verdict = `review_required`。**不得**由模型、Jev/Embedding、评测报告或 Controller 自行产生或代为决定 |
| 进入哪个 approval_request | RunLedger 的 approval 条目（`kind = context_operation_review`），必须携带 `approvalId / runId / attemptId / operationEpoch / requestHash`（架构 §17.9）；并引用 `operationId / contextOperationId / manifestHash / requestedActions[] / blockingCheckIds[]` |
| 谁批准 | Host/Kernel approval 能力 + `approve` 模式的 client attachment（架构 §17.9 的 `mode: "approve"`）。**不得**是 Controller、模型、Jev、Embedding 或评测结果 |
| 是否创建新 admission | **是**。批准只授权“可以执行某动作”，不继续旧操作；必须发起新的 Context Operation（新 `contextOperationId` + 新 `idempotencyKey`），重走 S2–S6，并在 S5 重新过确定性门（携带 `grantRef`） |
| 是否创建新 operation epoch | 按 `01` §4.14：获批后，对**尚未执行**的提案必须发起**新的 admission**（新 `contextOperationId` / 新 `operationEpoch`）；对**已发生的 compaction**（CAR）只允许选择恢复 / 扩大 / 阻断之一，**不得**追溯改变 audit 结论。审批绑定到申请时的 `(operationId, requestHash, operationEpoch)`；若 epoch 在此期间已变（Attempt 被替换 / 接管），旧批准按 §17.9 判 stale 并重新申请 |
| 批准前禁止什么 | 禁止 S6 写入 / 任何 `effectClass ∈ {reversible, lossy}` 的执行 / Pi compaction / disclosure；仅允许只读、unitize、分类、shadow。v1 整操作挂起：同一 CDQ 内任一 proposal 为 `review` 时，**其他 proposal 也不得先提交**（部分准入列为待评审） |
| 拒绝怎么处理 | 操作终态 `blocked`；保留旧 Context；记录拒绝理由 hash；要重试必须新 admission（新 CDQ） |
| 超时怎么处理 | `waiting` + 显式 deadline；**超时不得当作批准也不得当作拒绝**；deadline 到期 → `blocked`（`reason.code = "approval_timeout"`），不执行任何动作 |
| 未知效果怎么处理 | 批准已记但 commit 结果不明 → `assurance_unknown` + `no_automatic_replay` + 人工 reconcile（架构 §18.3）；不得自动重放或自动撤单 |
| 迟到 / hash 不符的响应 | 按 §17.9：返回 stale，**不产生副作用**；不得覆盖已有结论 |
| 与 `lossy` / `drop` 的关系 | v1 不得批准 `lossy_compress` / `drop`；`drop` 只能得到 `request_review`（`08` §2.5） |
| Wait 期间的 Agent 行为 | 继续使用旧 Context；不得把任何未审的压缩结果当可信上下文；不得以 “已发 approval 请求” 为由执行 |

> **契约落点**：本节与 `01` §4.14（`review_required` 的人工 / Kernel 审批落点）一致；`01` §4.14 是共享契约的权威表述，本表是 Compression 侧的职责分解。RunLedger 的 `approval_request` 载荷属于 Host / Kernel 轨道（BL-05），**机制未实现**，不得据此把 `10-p0-exit-checklist` 的条件 5 标为 satisfied（与 `01` §4.14 同口径）。

## 8. Receipt 与 RunLedger 映射（唯一权威）

### 8.1 映射表

| 对象 | 载体 | 权威 | 说明 |
| --- | --- | --- | --- |
| `CompressionDecisionReceipt`（CDR） | RunLedger Effect Ledger 条目的 typed payload（条目只存 `payloadHash` + `payloadType`） | `RunLedgerV1` / EffectGateway | 记录哪个 CJ 被采用/覆盖/阻断；`verdict ∈ {admitted, overridden}` 时必须在 ledger 找到同一 `operationId`，否则为 `missing` |
| `CompactionAuditReceipt`（CAR） | 同上（`payloadType = "pactile.cg.compaction-audit-receipt"`） | `RunLedgerV1` | 记录 17 项 check 与 verdict；不得单独建表作为权威 |
| `ContextUnitManifestV1` | Artifact + Manifest store（新增 manifest kind，不新增 store） | Manifest Port | `durable.status = ok` 是准入前置；当前清单指针由 Manifest Port CAS 维护 |
| Effect Receipt | `EffectLedgerEntryV1` | `RunLedgerV1` | `operationId / attemptId / turnId / operationEpoch / inputHash / status / receiptId / idempotencyKey` 是执行事实 |
| Kernel Evidence | Kernel 命令（Review / Close 流程） | Kernel | 只有 Kernel/Host 通过正式命令提交；本链路的任何对象都不自动成为 Evidence |
| `PiCompactionRecordV1` | Artifact（引用 session tree entry） | Artifact + Pi session tree | 不新增 Receipt 权威 |
| `DisclosureRecordV1` / `MemoryReadRecordV1` | Artifact + RunLedger Context Operation 条目 | Artifact / RunLedger | 只读操作记录，不是 Effect Receipt |

### 8.2 禁止形成第二套权威

| 现状对象 | P0 裁定 | 规则 |
| --- | --- | --- |
| Runtime Store `memory` audit 表 | **兼容读模型 / 迁移输入** | 只能用于历史读取与一次性迁移映射；不得作为 CDR/CAR 的权威，不得新增 “第二份 receipt” |
| Runtime Store lease 表 | **不能成为唯一 Lease authority** | Lease/Epoch 的唯一权威是 `RunLedgerCoordinator`（架构 §23.3.1、§26.3）；memory partition 的 lease 只作为局部兼容 |
| Evaluation report（PCR / summary） | evaluation fact only | 不能写 Kernel Evidence（ISO-7）；不能改产品 Run 状态 |
| Pi summary | 模型可见投影 | 不能写 Kernel Evidence；只能作为 `kind = "summary"` 的 CU 引用 |
| Jev judgment | advisory | 不能写 Kernel Evidence；不能授权动作 |

### 8.3 迁移说明（不执行，只登记）

- 现有 `memory_receipt` / `memory_manifest` / `memory_audit` 的字段可以**映射**到新 schema 的字段表；映射必须显式、可失败，不能静默降级（`01` §3.4）。
- 迁移只在 1b/2 阶段、在授权范围内进行；P0 不修改代码、不迁移数据。
- 迁移后旧表的角色写死为 “只读兼容”；任何写路径都必须经过 RunLedger / EffectGateway。

## 9. 失败码与状态映射（链路级）

| 链路事件 | `FactStatusV1` | 允许出口 |
| --- | --- | --- |
| admission 被拒 | `permission_denied` | `blocked` / 请求授权 |
| ledger 写入结果不明 | `unknown` | `assurance_unknown`；不自动重放 |
| CM read-back 不一致 | `unknown` / `manifest_conflict` | 重建 / `blocked` |
| anchor 无法保留 | `fail`（audit） | `restored` / `expanded` / `review_required` |
| pointer 不可达 | `missing` | 恢复 / `blocked` |
| provider 超时/不可用 | `timeout`（**本工作单元自身** deadline 到期，来源码 `compression-deadline-exceeded`）/ `provider_unavailable` | 降级到确定性规则并披露 |
| 旧 epoch 结果迟到 | `epoch_mismatch` | 记为 stale diagnostic；拒绝 |
| compaction 无 receipt | `unknown` | `assurance_unknown`；人工 reconcile |
| 同 revision 内 generation 漂移 | `generation_mismatch`（`09` §3） | 作废旧清单/建议；重建；不得混合 generation |
| 上层 abort / 用户取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop | `cancelled`（`09` §3；来源码六值见 `context-unit-manifest-v1` §10.1 FD-5。注意：`timeout` **仅**用于该工作单元自身 deadline 到期，上层 / 父级 deadline 触发的 abort **不是** `timeout`） | 使用更低保证结果并披露；取消响应有上界 |
| 指针无法转换为 ABI ref | `unconvertible`（`09` §3；原生层 = SP / RC / RK / OBS / ERM / PCR，**不含 `IR`**，CF-46） | 显式失败；保留 `SourcePointerV1`；不得截断/重编码 |
| memory.read 权限不允许 | `permission_denied` | `blocked` |

## 10. 负例与禁止路径（将转为 EC）

1. 任何在 S6 之前调用 Pi compaction 的路径（DC-1）。
2. `drop` / `lossy_compress` 在 v1 被 `allow`。
3. audit 存在非 pass 却 `verdict = accepted`（AU-1）。
4. compaction 无 session tree 记录却被标记成功（BL-13）。
5. 用摘要消息（user role）替代 disclosure，或把摘要用于 anchor 校验。
6. 绕过 Host/Memory Port 直接读取 Runtime Store / transcript / artifact 目录。
7. 旧 epoch 的结果被合并进当前 Attempt。
8. `unknown` effect 被自动重放。
9. CDR 声称 `admitted` 但 RunLedger 中不存在同 `operationId` 的 ledger 条目。
10. 评测 `evaluationRunId` 出现在 runtime 实体，或评测结论写入 Kernel Evidence。
11. CI / 文档把 `confidence` 写成 “已批准”。
12. 恢复动作回退当前清单指针（而不是产生新 generation）。
13. `review` 判决被当成 `allow` 执行，或未获批就重走 S6（§2 S5 勘定）。
14. 把 `01` §4.5 与 `09` §2.4 两套 CU protection 枚举混读（见 `context-unit-manifest-v1` §4.2）。
15. 折叠不可表达状态时丢掉原始状态，或把折叠值当原值上报（§5.3 #14、DC-10）。
16. compaction 缺 `carryForwardUnitIds` 或用摘要代替 `exact_required` 单元，却报成功（DC-12 / PC-10）。
17. 不适用的 check 被直接省略，使 “未跑” 与 “通过” 无法区分（AU-6）。
18. 用 `protection.class` 推导 `actions.*`，或反之（DC-9 / PC-2）。
19. 用一个轴（verdict）的值去覆盖另一个轴（lifecycle）的状态（SYNC-07）。
20. `review_required` 未经批准就重走 S6，或以 “已发 approval 请求” 为由执行 reversible / lossy 动作（§7.6）。
21. `IR` 承载 `unconvertible`，或把指针 → ABI ref 的转换失败记到 `IR`（CF-46；`09` §3.1 / §7 第 28 条；检索线 `02` §3.2 `AP-3`）。
22. 自身 deadline 到期与取消互换（把上层 / 父级 deadline 触发的 abort、调用方取消、epoch fence、预算耗尽、early stop 写成 `timeout`，或反之），或用取消来源码充当折叠码（CF-47；`context-unit-manifest-v1` §10.1 FD-5；检索线 `02` `TC-1` / `TC-9` / `TC-10`）。

## 11. 待评审问题

1. `ContextOperationV1` / `PiCompactionRecordV1` / `DisclosureRecordV1` / `MemoryReadRecordV1` 四个支撑类型是否接受为 P0 支撑类型，以及回填 `01` / `02` 的方式（与 `context-unit-manifest-v1` §12.3 的 SYNC-09 同一组）。
2. §7.5 的 17 项职责表与 `review_required` 是否接受（CF-05 / CF-06；已裁定）；CAR lifecycle `failed → assurance_unknown` 的唯一映射（§7.4.1）是否得到独立 Review 确认。
3. S4 shadow 的 “失败不阻断链路” 是否与 “no silent success” 冲突；本文的处理是：shadow 失败必须记录并降级，且不得产生执行动作。
4. `semantic_drift` / `jev_preservation` 的确定性判定边界（P0 允许 `unknown` → review）。
5. `MemoryReadRecordV1` 是否需要在 RunLedger 单独建 kind，或复用 Context Operation 条目。
6. **部分准入**：v1 采用 “同一 CDQ 内任一 proposal 为 `review` 则整操作挂起”（§7.6）；是否接受，或允许按 proposal 分别挂起。
7. `carryForwardUnitIds[]` 的归属（CM intent / CM 本体 / PiCompactionRecord）与字段表（SYNC-10）。
8. `approval_request` 的 `kind` 命名与字段集是否需写入 RunLedger 契约（当前架构 §17.9 只给了 Approval 的通用字段）。
9. Pi compaction 的 `firstKeptEntryId` 语义在 1b 的验证方式（需要锁定版本，BL-20）。
10. 当前清单指针由 Manifest Port 还是 RunLedger 维护（与 `context-unit-manifest-v1` §13 同一问题，需一并裁定）。
11. 本线 `reason.code` 的 `compression-*` 前缀枚举（FD-3 / SYNC-08）的字符集与登记方式。
