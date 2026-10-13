# Retrieval schema（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。本文未通过独立 Review，不得描述为 P0 通过。
- 依据：`../implementation/01-contract-draft.zh-CN.md`（下称 `01`）、`../implementation/09-contract-entities-v1.zh-CN.md`（下称 `09`）、`../implementation/08-p0-admission-decision.zh-CN.md`（下称 `08`）、架构 §27.3–§27.5。
- 与 `01`/`09` 的关系：共用外壳、身份平面、**一等状态**与实体适用性以 `01` §3.3 与 `09` §3 / §3.1 为权威；本文只写 Retrieval 实体的字段细化、层级折叠规则与负例。本文提出的 additive 字段与同步要求集中在 §8。
- 全部 hash / 路径示例均为占位（`sha256:<pending>`）；本文不产生任何真实 hash、fixture 或分母。

## 1. 命名与版本裁定（回应 BL-06 / `08` §2.4）

| 名称 | schemaId | schemaVersion | 角色 |
| --- | --- | --- | --- |
| `RetrievalPlanV2`（文档名）/ `ContextRetrievalPlanV2`（TS 符号） | `pactile.cg.retrieval-plan` | `2` | Context Governance 的多分支检索计划（召回、融合、预算、降级） |
| `RetrievalPlanV3` | 现有 ABI（`RETRIEVAL_ABI_VERSION = 3`） | — | 单 claim 的证据验证链（`candidate → corroborate → classify-evidence → check-assurance → accept-or-stop`） |

规则：

1. 两者**不是升级关系**；`2` 与 `3` 只表示各自 schemaId 内的版本号，不跨 schemaId 比较（`01` §3.1）。
2. `ContextRetrievalPlanV2.abiPlan: RetrievalPlanV3 | null` 是唯一的引用点；不复制 V3 字段、不镜像 V3 枚举。
3. 不修改现有 ABI 文件、类型或语法；V3 的 ref 语法限制由 `SourcePointerV1` 吸收（§7）。
4. 任何「V2 是 V3 的新版本」「V3 已被取代」的表述都是错的，测试与文档必须按并存处理。

## 2. 身份字段

与 `01` §2 / §3.5 一致（ISO-1…ISO-8 适用）：

```text
plane = runtime      → workspaceId, sessionId, runId, attemptId, turnId, operationEpoch, contextOperationId, inputSnapshotHash
plane = evaluation   → evaluationRunId, candidateSha, dirtyWriteSet, seed, caseSetHash, fixtureHash
共用                  → sourceRevision, generation, policyVersion, manifestHash, providerCapabilitySnapshot,
                        createdAt, provenance, bodyHash
```

| 字段 | 类型 | runtime | evaluation | 规则 |
| --- | --- | --- | --- | --- |
| `schemaId` / `schemaVersion` | string / number | R | R | 未知值 → decode 失败（`invalid_response`） |
| `workspaceId` | string | R | R（快照副本 id） | evaluation 不得等于活工作区 |
| `runId` | string | R | X | — |
| `contextOperationId` | string | R | R（`eval-` 命名空间） | 一次 retrieval 操作的 id |
| `evaluationRunId` | string | X | R | 产品实体引用它即为 decode 失败 |
| `sourceRevision` | `ObservedV1<SourceRevisionRefV1>` | R | R | 允许 `unknown` / `stale`，但字段必须存在 |
| `generation` | `GenerationRefV1` | R（RC/RK）；O（RP） | 同左 | `index` 与 `semantic` 至少一个非 null（RC/RK） |
| `policyVersion` | string | O（RP/RC）；R（RK） | 同左 | 参与 `bodyHash` |
| `manifestHash` | string | O（RP/RC）；R（RK） | 同左 | 指向索引 / 计划清单 |
| `candidateSha` | `CandidateRefV1` | X | R | 见 `08` §2.3；禁止伪造 Git commit |
| `dirtyWriteSet` | `DirtyEntryV1[]` | X | R | 运行前后不一致 → run `invalid`（FI-13） |
| `provenance` | `ProvenanceV1` | R | R | `authority` 规则见 `01` §3.6 |
| `freshness` | `FreshnessV1`（引用；**形状见 §5.3**） | R（RC 起） | R | 缺失不是 0，是 `unknown` |
| `permissions` | `PermissionScopeV1`（引用；**形状见 §5.3**） | R（RC 起） | R | 不给默认值；`08` §3.4 要求读 scope 与外发 scope 一等 |
| `providerCapabilitySnapshot` | `SnapshotRefV1` | R（RP/RC/RK） | R | 与 semantic 字段交叉校验 |
| `bodyHash` | string | R | R | 不含 `createdAt` / `observedAt`（`01` §3.4） |

### 2.1 `CandidateRefV1`（tree-hash，P0 冻结）

```ts
type CandidateRefV1 =
  | { kind: "git-commit"; sha: string }
  | { kind: "tree-hash"; sha256: string; fileCount: number; listHash: string };
```

计算规则（`08` §2.3）：

```text
candidateSha = SHA-256( 按 UTF-8 字节序排序后的每一行: "<repo-relative-posix-path>\0<file-sha256>\n" )
listHash     = SHA-256( canonical 文件清单: 同样的相对路径列表，不含文件内容 hash )
```

| 规则 | 内容 |
| --- | --- |
| CR-1 | 路径必须仓库相对、使用 `/`、不使用盘符或 `..`；大小写保持原样。 |
| CR-2 | tree-hash **不等于** Git commit；`develop` 无提交时不得填写 `kind: "git-commit"`。 |
| CR-3 | `fileCount` 必须等于被包含文件数；与 `listHash` 重算不一致 → decode 失败。 |
| CR-4 | 每次评测重跑生成新的 tree-hash 与新 manifest；旧值只作为历史证据。 |
| CR-5 | `candidateSha` 只绑定候选快照（被测代码 / 文档），不绑定 fixture 或结果根。 |

### 2.2 `DirtyEntryV1`

```ts
interface DirtyEntryV1 { path: string; sha256: string | null; change: "added" | "modified" | "deleted" }
```

`dirtyWriteSet` 记录运行期间相对候选快照的写集。评测运行在快照副本上进行，**正常应为空**；非空时必须解释来源，且 `pre`/`post` 不一致即 FI-13。

## 3. 一等状态（单一权威，本线不声明）

### 3.1 共享状态：唯一来源为 `01` §3.3 / `09` §3（本文件不声明）

```text
FactStatusV1         → 01 §3.3（15 个成员：ok + 14 个非 ok）— 唯一权威声明
ObservedV1<T>        → 01 §3.3
实体适用性矩阵        → 09 §3.1 — 唯一权威
折叠规则与共享折叠码  → 09 §3.2.2 — 唯一权威
```

本文不声明、不枚举、不改写以上任何一项；检索线文档不得出现该共享类型名的本地声明（机械检查：在 `retrieval/` 下检索该类型名的声明形式，应无命中）。

| 规则 | 内容 |
| --- | --- |
| SRC-1 | 检索线文档不得出现 `FactStatusV1` 的声明或成员列表；需要引用时只写「共享状态（`01` §3.3）」并给出状态名。 |
| SRC-2 | 某条状态是否可用于某个实体，以 `09` §3.1 矩阵为唯一权威；`—` 表示该实体**不可表示**该状态。 |
| SRC-3 | 早期版本（< 2026-10-09）中的本地 11 项副本与 `RetrievalFactStatusV1` 别名已作废（`09` §3 第 1 段 / `09` §5 #17）。 |
| SRC-4 | 一律使用共享类型名 `FactStatusV1`；检索线不新增任何 `Retrieval*Status*` 别名。 |
| SRC-5 | 若 `09` §3.1 矩阵与 `09` §3.2.2 的散文描述冲突，**以 §3.1 矩阵为准**（`09` §3.2.1 规定折叠目标层必须在 §3.1 中为 `—`），并把冲突作为 Implementation 缺陷登记（本线已在 §8 SY-13 / SY-14 逐条给出位置）。 |

### 3.2 四个 P0 状态在检索实体上的适用性（引用 `09` §3.1）

下表是 `09` §3.1 在检索实体上的**投影**，不新增成员、不改变取值；`✓` = 可表示，`—` = 不可表示（decoder 收到即 `invalid_response`）。

| 实体 | `generation_mismatch` | `wrong_dimension` | `cancelled` | `unconvertible` |
| --- | --- | --- | --- | --- |
| RP（计划） | ✓ | ✓ | ✓ | — |
| RC（候选） | ✓ | ✓ | ✓ | ✓ |
| RK（pack `coverage` / `rejected`） | ✓ | **—** | ✓ | ✓ |
| SP（`SourcePointerV1`） | ✓ | — | ✓ | ✓ |
| PCS（能力快照） | ✓ | ✓ | ✓ | — |
| IR（`InspectResultV1`） | ✓ | — | ✓ | — |
| OBS（`ObservedV1`） | ✓ | ✓ | ✓ | ✓ |
| ERM / PCR（评测报告） | ✓ | ✓ | ✓ | ✓ |

解读（每条只陈述一次，其他文档不得重写）：

| 规则 | 内容 |
| --- | --- |
| AP-1 | `unconvertible` 的可承载实体 = **RC / RK / SP / OBS / ERM / PCR**；不可承载 = RP / PCS / IR / CU / CM / CJ / CDQ / CDR / CAR / EC / PS / FR / RT / CMP。**已闭合（`R-BL-19` / `X-10`）**：`09` 已修正，当前权威 = `09` §3.2.2 矩阵「`unconvertible`」行（含「**`IR` 不在其中**」；16:2x = `:403`）+ `09` §6 第 28 条（「**`IR` 不承载 `unconvertible`**」，`:465`）；本线自始按矩阵执行，无需改动。 |
| AP-2 | `wrong_dimension` 的**原生**承载层 = **PCS / RC / RP / OBS / ERM / PCR**（`09` §3.2.2）；RK 字段在 `01` §4.3 line 413/416 已收窄为 `Exclude<FactStatusV1, "ok" | "wrong_dimension">`，因此只能折叠（§3.3）。 |
| AP-3 | IR 不可表示 `wrong_dimension` / `unconvertible` / `epoch_mismatch`（`09` §3.1 三行均为 `—`）；Inspect 的维度与 ref 语法判定结果由 RC / PCS / OBS 承载，不写入 IR 值本身。 |
| AP-4 | `PS` / `FR` / `RT` / `CMP` 四列在 `09` §3.1 中只允许极少数状态（如 `RT` 的 `epoch_mismatch`）；检索线不得在这四列上写入其他状态或对其做折叠（`09` §3.2.1 已禁止“荒谬折叠”）。 |
| AP-5 | **永不折叠清单**（`09` §3.2.2）= `timeout` / `cancelled` / `invalid_response` / `unknown` / `stale` / `missing` / `permission_denied` / `revision_mismatch` / `epoch_mismatch` / `provider_unavailable` / `manifest_conflict` / `generation_mismatch`；其中 `cancelled` / `timeout` 的区分必须在所有层级保持。 |

### 3.3 `wrong_dimension` 的层级规则（回应 Review 发现 一.4；已与 `09` §3.2.2 对齐）

```text
provider 返回向量维度 ≠ snapshot 声明维度
  → 原生承载层（PCS / RC / RP / OBS / ERM / PCR）  : status = "wrong_dimension"（保留，不得提前折叠）
  → 折叠层（RK.coverage[].status / rejected[].status）: status = "invalid_response" + reason.code = "cg-wrong-dimension"
  → 评测报告                                      : 逐项分布必须在原生层（ERM / PCR）统计
```

机读表达**不新增包装类型**：折叠由 `01` §4.3 PK-7 已登记的字段承担——`status = "invalid_response"` + `reason.code = "cg-wrong-dimension"` + `reason.detailHash`（非空）。本线**不**定义 `StatusFoldV1` 之类的并行结构，避免与 `01` PK-7 / `09` §3.2.2 竞争。

| 规则 | 内容 |
| --- | --- |
| WD-1 | 原生承载层（`09` §3.2.2 列出的 PCS、RC、RP、OBS、ERM、PCR）**保留** `wrong_dimension`，不得提前折叠。 |
| WD-2 | RK 的 `coverage[].status` / `rejected[].status` 不可表达该状态（`09` §3.1 标 `—`；`01` §4.3 已收窄类型），只能按 `09` §3.2.2 记为 `invalid_response`。 |
| WD-3 | 折叠必须带 `reason.code = "cg-wrong-dimension"`（**共享折叠码**，`cg-` 前缀，`09` §3.2.2）与**非空** `reason.detailHash`；`detailHash` 指向记录「原始状态 + 期望维度 + 实际维度 + 实体引用」的 artifact，供 Review 还原原始状态。 |
| WD-3b | `retrieval-wrong-dimension` 是 `01` §3.3 声明的**只读历史别名**，仅用于解读已冻结样本；新写入一律用 `cg-wrong-dimension`。 |
| WD-4 | `reason.detailHash` 只允许含数值与逻辑引用：不得含端点、主机名、凭据、正文或未授权路径。 |
| WD-5 | 评测报告必须在原生层（`ERM` / `PCR`）保留逐项分布（`01` §4.3 PK-8）；`04` §9.2 的 `observed.status` 写**原生层**状态，pack 层折叠只在 pack 内表达。不得只写一层。 |
| WD-6 | 禁止把它当成**低分候选**、普通 `degraded`、`fallback` 成功、或「provider 没有结果」。折叠后的 `invalid_response` 必须在 `rejected[]` / `coverage[]` 中显式出现，且 `coverage.status` 非 ok；维度信息不得丢失。 |
| WD-7 | 折叠是**单向**的：不允许在 RK 层把 `invalid_response` 反向还原为 `wrong_dimension`；也不允许对同一候选同时记录两个层级状态于同一字段。 |
| WD-8 | 维度校验发生在 decode 之前（`04` FI-02）：维度不符时整批丢弃，不得先按低分接受再补校验。 |
| WD-9 | 除 `09` §3.2.2 外 **P0 不存在任何其他授权折叠**；不得自行扩展折叠对。 |

### 3.4 `timeout` 与 `cancelled` 的判定（回应 Review 发现 一.5）

| 归属 | 触发 | 状态 | reason.code |
| --- | --- | --- | --- |
| **时间耗尽** | 分支 / operation / Inspect **自身的 deadline 到期** | `timeout` | `retrieval-deadline-exceeded` |
| **被取消** | 调用方（用户 / 上层命令）主动取消 | `cancelled` | `retrieval-cancelled-by-caller` |
| **被取消** | 上层 / 父级 deadline 触发的 abort（取消源是 deadline，机制是 abort） | `cancelled` | `retrieval-cancelled-by-deadline`（`09` §3 唯一判定规则表 L345–357 已列为线内诊断码） |
| **被取消** | operation 被撤销（上游 abort，非 deadline） | `cancelled` | `retrieval-cancelled-by-operation` |
| **被取消** | epoch fence（旧 Attempt / 旧 epoch 的迟到执行） | `cancelled` | `retrieval-epoch-fenced` |
| **被取消** | 预算耗尽导致分支未完成或未启动 | `cancelled` | `retrieval-budget-exhausted` |
| **被取消** | plan 显式 early stop 提前停止剩余分支 | `cancelled` | `retrieval-early-stopped` |

| 规则 | 内容 |
| --- | --- |
| TC-1 | `timeout` **只**表示「时间真的用完了」；`cancelled` **只**表示「被取消 / 被停止」。二者不得互换、不得混写。 |
| TC-2 | 取消**源**用线内诊断码记录（`retrieval-cancelled-by-caller` / `-by-deadline` 是 `09` §3 唯一判定规则表 L345–357 点名的两个；本线另加 `-by-operation` / `-epoch-fenced` / `-budget-exhausted` / `-early-stopped`，均属线内诊断码，**不是**折叠码）：它们只解释原因，不改变 `status = cancelled`。 |
| TC-3 | 预算耗尽与 early stop **不是** timeout：分支没有超时，只是被停止，因此记 `cancelled`。`05` §3 BU-4、§4、§8 CO-3、§9 与 `06` §2 的这一项已按本表统一（见 §8 SY-4）。 |
| TC-4 | 两者都必须可归因（`reason.code` 非空），且都不得被表述为 `ok`、空结果或 0 分。 |
| TC-5 | 取消响应必须有上界（架构 §24：“取消有上界”）；该上界在阶段 1a 只记录，不设阈值。 |
| TC-6 | 迟到结果（旧 Attempt / 旧 epoch）的原生状态是 `epoch_mismatch`（`09` §3），**不是** `cancelled`；它只记 stale diagnostic，永不写入当前 operation 输出（`04` EP-2）。 |
| TC-7 | `05` §4 的「已完成候选保留、未完成部分丢弃」规则仍适用；但被停止分支的 `coverage.status` 必须是 `cancelled`，不能因为「部分有结果」而写 `ok`。 |
| TC-8 | `epoch_mismatch` **不折叠、不进 pack 字段**（`09` §3.1：RK / RC / IR 均为 `—`）；评测平面的 epoch 仿真由 fake 端口 / fixture 内部记录承载，**不得**写入 `EC` / `ERM` / `PCR`（`04` §6 末段、CF-27）。 |
| TC-9 | `timeout` / `cancelled` / `invalid_response` **均不参与任何折叠**（`09` §3.2.2 的“永不折叠”清单；§3.2 AP-5）；把它们互换或折叠即缺陷。 |
| TC-10 | 本表的「时间耗尽 → `timeout`」只适用于**该工作单元自身**的 deadline；上层 / 父级 deadline 触发的 abort 属 `cancelled` + `retrieval-cancelled-by-deadline`（不得写成 `timeout`）。 |

### 3.5 `reason.code` 的封闭枚举与字符集（回应 Review 发现 三.7）

字符集：`^(retrieval)-[a-z0-9]+(?:-[a-z0-9]+)*$`；全小写、kebab-case、`retrieval-` 前缀、长度 ≤ 64。该形状是共享逻辑 id 模式 `PACTILE_LOGICAL_ID_PATTERN`（`packages/cli/src/pactile/shared/validation.ts:296`，静态只读核对）的子集，因此可直接承载于 `ReasonV1.code`。

与共享 `ReasonV1` 的关系（`01` §3.3）：

| 规则 | 内容 |
| --- | --- |
| RS-1 | `ReasonV1.code` 在 `01` 中只规定「来自封闭枚举、不写自由文本」，**没有**规定命名规则；各线自带封闭集。检索线的封闭集即本表。 |
| RS-2 | 检索线不得使用未在本表登记的 `retrieval-*` 代码；decoder 收到未登记代码 → `invalid_response`。 |
| RS-3 | 不得使用其他线的前缀；凭据 / 端点 / 正文 / 自由文本永不进入 `code`（只允许通过 `detailHash` 指向 artifact）。 |
| RS-4 | 新增代码只通过新的 `schemaVersion` 或本文件的 Review 修订；不得在运行时代码里「顺手」加。 |

> 命名空间说明：本文的 `RS-*` 前缀专用于 reason-code 规则；候选自身规则使用 §4.2 的 `RC-*`，两者不得混用。

封闭枚举（每个代码恰好映射一个状态）：

| reason.code | 状态 | 触发场景 | 出现处 |
| --- | --- | --- | --- |
| `retrieval-generation-mismatch` | `generation_mismatch` | 索引 / semantic generation 与 plan 不符 | `03`、`05`、`10` |
| `cg-wrong-dimension` | **共享折叠码**（不单独构成状态，列在本表仅为完整性） | 向量维度 ≠ snapshot；**只**用在 `09` §3.2.2 的折叠层（RK coverage / rejected） | §3.3、`01` §3.3、`09` §3.2.2、`10` |
| `retrieval-ref-unconvertible` | `unconvertible` | ABI ref 语法无法表达该 pointer | §7、`04` §8 |
| `retrieval-ref-sensitive-term` | `unconvertible` | 路径段含敏感词（规则见 §7） | §7、`04` §8 |
| `retrieval-path-outside-scope` | `permission_denied` | 路径越出 workspace / worktree 或 scope | `04` §2 |
| `retrieval-egress-denied` | `permission_denied` | 无授权外发（拒绝前不产生请求） | `06` §2、`08` |
| `retrieval-worktree-mismatch` | `revision_mismatch` | worktree 不符 | `04` §2 |
| `retrieval-branch-mismatch` | `revision_mismatch` | 分支不符 | `04` §2 |
| `retrieval-line-range-gone` | `revision_mismatch` | 行范围越界或已不存在 | `04` §2 |
| `retrieval-symbol-gone` | `revision_mismatch` | 声明的 symbol 不再包含该范围 | `04` §2 |
| `retrieval-source-stale` | `stale` | 原始字节 hash 与候选不一致 | `04` §6 |
| `retrieval-path-missing` | `missing` | 文件不存在（不是无权限） | `04` §6 |
| `retrieval-check-indeterminate` | `unknown` | 检查无法判定（fail-closed） | `04` §3 |
| `retrieval-binary-or-undecodable` | `invalid_response` | 匹配到文件但无法按约定解码 / 分析 | `04` §2 |
| `retrieval-provider-protocol-mismatch` | `provider_unavailable` | provider 声明协议 / 维度 / 前缀与 plan 不符（`unsupported` 是 provider 状态，**不是** `FactStatusV1` 成员，不构成折叠） | `01` §6 |
| `retrieval-provider-unavailable` | `provider_unavailable` | provider 不可达 / probe 失败 | `01` §6、`06` §2 |
| `retrieval-index-unavailable` | `provider_unavailable` | 索引不存在或不可读（不隐式重建） | `03` §7、`06` §2 |
| `retrieval-deadline-exceeded` | `timeout` | deadline 到期（分支 / operation / Inspect） | §3.4、`04`、`05` |
| `retrieval-cancelled-by-caller` | `cancelled` | 调用方取消 | §3.4、`05` §4 |
| `retrieval-cancelled-by-deadline` | `cancelled` | 上层 / 父级 deadline 触发的 abort（取消源是 deadline） | `09` §3 唯一判定规则表 L345–357、§3.4 TC-10 |
| `retrieval-cancelled-by-operation` | `cancelled` | operation 被撤销 | §3.4、`05` §4 |
| `retrieval-epoch-fenced` | `cancelled` | 旧 Attempt / 旧 epoch | §3.4、`05` §4 |
| `retrieval-budget-exhausted` | `cancelled` | 预算耗尽停止分支 | §3.4、`05` §3/§4/§8/§9 |
| `retrieval-early-stopped` | `cancelled` | plan 显式 early stop | §3.4、`05` §9 |
| `retrieval-coverage-incomplete` | `unknown` | 覆盖无法证明（如缺 shard 明细） | `05` §8、`06` §5、`10` |
| `retrieval-truncated-by-budget` | `cancelled` | 分支因候选 / 字节 / token 上限而**实际完成但被截断**（与 `retrieval-budget-exhausted` 的区别：后者是分支未完成 / 未启动） | `05` §3、`06` §2、`10` |

重建语义**不新增类型**：由下列已登记码直接表达（取代早期草稿的 `RebuildSignalV1`）：

| 码 | 重建语义 |
| --- | --- |
| `retrieval-generation-mismatch` | 需要重建该 generation（`03` §2 / §6） |
| `cg-wrong-dimension` | 需要重建（维度是 generation tuple 成员，`03` §1） |
| `retrieval-index-unavailable` | **不**隐式重建；需显式重建请求（`03` IX-5 / IX-6） |
| 其他非 ok 码 | 默认**不**要求重建（先探测恢复，`06` RS-3） |

已从枚举中移除（不得再使用）：

| 旧代码 | 移除原因 |
| --- | --- |
| `retrieval-wrong-dimension` | 提升为**共享折叠码** `cg-wrong-dimension`（`09` §3.2.2）；仅保留为只读历史别名（`WD-3b`） |
| `retrieval-duplicate-candidate` | 重复候选属于去重（`fusion.merged[]`），不是失败状态，**不得**进 `rejected[]`（`RC-5` 已改） |
| `retrieval-not-configured` | 未启用分支根本不产生 `coverage` 条目，不是失败（`01` SP-1） |
| `retrieval-fixture-drift` | 属于 harness / 评测 verdict（FI-26），不是 `FactStatusV1` 的 reason |
| `retrieval-provider-protocol-mismatch`（作为独立状态） | 保留为代码，但状态一律 `provider_unavailable`，不新增状态（`unsupported` 不属 `FactStatusV1`） |
| `RebuildSignalV1` 类型 | 已取消：重建语义由上表的已登记码表达，不另立类型（避免与 `01` §4.3 字段竞争） |

## 4. 实体字段表

### 4.1 `ContextRetrievalPlanV2`（RP）

`01` §4.1 为权威定义；下表为检索线细化（字段名一致）。

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `planId` | string | R | 逻辑 id |
| `requestRef` | `ArtifactRefV1` | R | 查询文本只以 hash / pointer 出现 |
| `scope.worktreeId` | string | R | 逻辑 id |
| `scope.branch` | `ObservedV1<string>` | R | 未知用 `unknown` |
| `scope.pathScopes` | `SourcePointerPatternV1[]` | R | 空数组 = 全 worktree；不得为 `null` |
| `scope.kinds` | enum[] | R | `code/doc/config/test/external` |
| `branches[]` | 见下 | R | ≥ 1；每条启用分支恰好对应一个 `coverage` 条目 |
| `fusion` | `{method, k, dedupe}` | R | `method ∈ {rrf, none}`；`k` 无默认值 |
| `budget` | `{maxCandidates, maxBytes, maxTokens, deadlineMs}` | R | 各分支 `deadlineMs` 之和不受限，但每条 ≤ `budget.deadlineMs` |
| `abstain` | `{allowed, requireFullCoverage}` | R | `requireFullCoverage` 为 `true` 时，任一 authoritative 分支非 ok → 不得 abstain |
| `egress` | `{remoteAllowed, authorizationRef}` | R | `remoteAllowed=false` 时 remote 分支不执行 |
| `abiPlan` | `RetrievalPlanV3 \| null` | R | 需要 claim 验证时非 null；不复制字段 |

`branches[]` 元素：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `branch` | `exact \| lexical \| structural \| relation \| semantic \| external_search` | 六类之一；同一 plan 内不可重复 |
| `mode` | `authoritative \| shadow` | 阶段 2 初期 `semantic` 只允许 `shadow`；`shadow` 候选不进入 pack |
| `deadlineMs` | number | > 0；必须 ≤ plan 总 deadline |
| `maxCandidates` | number | > 0 |
| `providerRef` | `SnapshotRefV1 \| null` | 确定性分支为 `null`；semantic / external 必须非 null |
| `fallbackFor` | string \| null | 声明该分支是为哪条分支准备的 fallback（如 `exact` 为 `semantic` 兜底时记 `"semantic"`） |

### 4.2 `RetrievalCandidateV1`（RC）

`01` §4.2 为权威定义。检索线补充与细化：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `candidateId` | string | `hash(planId, branch, canonicalLocatorKey)`；确定性、可复算 |
| `branch` | 六类枚举 | 与 plan 中启用分支一致 |
| `locator` | `SourcePointerV1` | 必须能 Inspect；pointer 本身无法规范化（非 ABI 表达问题）→ `invalid_response`，ABI 表达不了 → `unconvertible`（§7） |
| `matchKind` | `exact \| lexical \| symbol \| edge \| embedding \| search_hit` | `semantic` 分支必须为 `embedding` |
| `branchRank` / `branchScore` | `ObservedV1<number>` | advisory；只用于排序与融合 |
| `semantic` | `null \| {...}` | 非 null 时必须与 snapshot 逐字一致 |
| `inspect` | `{status:"not_inspected"} \| ObservedV1<InspectResultV1>` | 进入 pack 前必须为 `ok` |
| `freshness` / `permissions` | 一等观测（§5.3） | 见 §2 |
| `coverageHint` | `ObservedV1<{shardsSearched, shardsTotal}>` | 仅供 `coverage` 汇总；不得用于 abstain |

补充规则：

| 规则 | 内容 |
| --- | --- |
| RC-1 | `search_hit` 在 Fetch → Evidence 之前恒为 `not_inspected`，且不得进入 `RetrievalPackV1.items`。 |
| RC-2 | `semantic.embeddingDim` 与 snapshot 不一致 → 整条候选 `wrong_dimension`（不是低分）；进 RK 时按 §3.3 折叠。 |
| RC-3 | 候选不得携带正文；只允许 pointer + hash（`01` §3.4）。 |
| RC-4 | 候选不得携带 provider 原始响应、端点、凭据或绝对路径。 |
| RC-5 | 同一 `candidateId` 重复出现时**不是失败**：保留 provenance 最完整的一条作为 `keptId`，其余 id 记入 `fusion.merged[].mergedIds`（`05` DD-1/DD-2）。重复候选**不得**写入 `rejected[]`，也不得产生 reason.code。 |

### 4.3 `RetrievalPackV1`（RK）

`01` §4.3 为权威定义（`outcome ∈ {pack_ready, pack_empty_observed, pack_degraded, pack_blocked}`，PK-1…PK-6）。检索线补充：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `items[]` | `{candidateRef, inspect, rank}` | 只含 `inspect.status = ok`；`rank` 为融合后的确定性排名 |
| `rejected[]` | `{candidateRef, status, reason}` | 字段集以 `01` §4.3 为权威（**不**增加 `fold` 等包装字段）；必须覆盖所有未进入 items 的候选；`status` 受 §3.2 约束（不得出现 `wrong_dimension`）；发生折叠时 `reason.code = "cg-wrong-dimension"` 且 `reason.detailHash` 非空（§3.3 WD-3） |
| `coverage[]` | 每启用分支一条 | `status` 为共享状态且受 §3.2 约束；`reason` 为 null 仅当 ok |
| `fusion.inputs[]` | 每分支的候选 id 列表 | 供复算 RRF |
| `fusion.merged[]` | `{keptId, mergedIds}` | 去重必须可回溯，禁止静默合并 |
| `fallback` | `{used, from[], reasons[]}` | `used=false` 时 `from` 必须为空 |
| `budget` | `{usedCandidates, usedBytes, usedTokens}` | 超预算必须披露，不得静默截断 |
| `abstain` | `{decided, basis}` | 只在 `requireFullCoverage` 满足时 `decided=true` |
| `gaps` | `{status, reason, detailHash}[]` | **已在 `01` §4.3 line 422 登记**（字段形状以 `01` 为准）；不变量：PK-9（`gaps[]` 与 `rejected[]` 互斥）与 PK-10（同一候选只能在 `items[]` / `rejected[]` / `gaps[]` / `fusion.merged[].mergedIds` 四处中恰好一处，`01` §4.3 line 440/441）。`gaps[].status` 受 §3.2 约束（不得出现 `wrong_dimension`）；`reason.code` 来自 §3.5 |
| `packHash` | string | 不含 `createdAt`；确定性复算的判据 |

不变量（补充 `01` 的 PK-1…PK-6；同步要求见 §8 SY-5）：

| ID | 内容 |
| --- | --- |
| PK-7 | `rejected` 必须包含所有 `inspect.status != ok` 的候选；数量与各分支返回数一致（可复算）。**例外**：重复候选走 `fusion.merged[]`（RC-5），不进 `rejected`。 |
| PK-8 | `coverage[].status` 非 ok 时 `outcome` 至少为 `pack_degraded`，除非该分支为 `shadow`（shadow 不参与 outcome 判定，但仍必须记录）。 |
| PK-9 | `unconvertible` 候选必须保留原始 `SourcePointerV1`（大写 / 非 ASCII / 行号 / worktree 全部原样）供人工与评测查看。 |
| PK-10 | `packHash` 复算不一致 → 评测 `invalid`，不是候选缺陷。 |
| PK-11 | `coverage[].status` / `rejected[].status` 出现 `wrong_dimension` → decode 失败（§3.2 AP-2）；必须改为 §3.3 的折叠形态并带 `reason.code = "cg-wrong-dimension"`。 |
| PK-12 | `rejected[].status` 为 `cancelled` 时 `reason.code` 必须来自 §3.4 的取消代码，不得使用 `retrieval-deadline-exceeded`。 |
| PK-13 | 折叠不得改变原生层证据：评测逐项分布必须在 `ERM` / `PCR` 统计（`01` PK-8）；维度信息必须通过 `reason.detailHash` 可还原，不得因折叠而丢失。 |

> 命名空间说明：`02` §4.2 的 `RC-*` 是候选规则；§3.5 的 reason-code 规则用 `RS-*`。早期草稿曾在两处同时使用 `RC-*`，已修正。

## 5. 支撑类型

### 5.1 `SourcePointerV1`（`01` §4.4 为权威）

```ts
type SourcePointerV1 =
  | { scheme: "worktree"; worktreeId: string; pathNfc: string;
      range: { startLine: number; endLine: number; startCol?: number; endCol?: number } | null }
  | { scheme: "artifact"; artifact: ArtifactRefV1 }
  | { scheme: "transcript"; sessionId: string; startSeq: number; endSeq: number }
  | { scheme: "external"; urlHash: string; fetchEvidenceRef: ArtifactRefV1 | null }
  | { scheme: "memory"; unitId: string; manifestRef: EntityRefV1 };   // 与 01 §4.4 同步（修复轮新增）
```

| 规则 | 内容 |
| --- | --- |
| SPo-1 | `pathNfc` 是 NFC 规范化后的路径，**保留原始大小写与非 ASCII 字符**；不做 lowercasing、不做 slug、不做 URL 编码。 |
| SPo-2 | `range` 为 1-based 闭区间；`null` 表示整文件。列号可选，出现时必须与行号同时出现。 |
| SPo-3 | `worktreeId` 是逻辑 id；不得是绝对路径、盘符或 UNC。 |
| SPo-4 | `external` 必须带 `fetchEvidenceRef`（Fetch 之后）或 `null`（Fetch 之前）；`null` 时该 pointer 只能用于候选，不能用于 citation。 |
| SPo-5 | `SourcePointerV1` 是不可变值；重新锚定（re-anchor）必须产生**新候选**，不得就地修改旧 pointer。 |
| SPo-6 | `scheme = "memory"` 只指向同一 scope 的已提交清单：**不得**作为检索候选 locator（检索候选必须能 Inspect），也**不得**参与 ABI 转换（直接 `unconvertible`，不得重编码）——与 `01` §4.4 一致。 |

### 5.2 `InspectResultV1` 与 `InspectCheckV1`：字段映射与检索线校验规则

**字段表与 `InspectCheckV1.id` 枚举的唯一声明位置 = `implementation/01-contract-draft.zh-CN.md` §4.4**（唯一字段表，已收编历史「additive / T3 线内」字段与 `InspectCheckV1`）；登记与适用性见 `09` §1.2（IR 行）与 `09` §1.2.5（`InspectCheckV1` 的共享声明位置 = `01` §4.4）。

本文件**不声明** `interface InspectResultV1` / `interface InspectCheckV1`，也**不持有**字段表或 `id` 枚举的 Owner 身份；本节只保留「检索线如何使用这些字段」的映射与检索线自有的校验规则（CF-39）。

字段映射（每一行的权威来源均为 `01` §4.4；右列为检索线用途，不是字段定义）：

| 字段 | 检索线用途（不是定义） |
| --- | --- |
| `workspaceId` | 与 plan 的 workspace 对齐；跨 workspace → `permission_denied` |
| `worktreeId` / `branch` | worktree / 分支 fence（`04` §2 检查 7、8） |
| `path` | 工作树相对路径（保留原始大小写）；与 `pathNfc` 不得互相冒充 |
| `pathNfc` | NFC 规范化路径；`!= NFC(path)` → `invalid_response`（IR-4） |
| `range` / `rangeExists` | 行范围 fence（`04` §2 检查 2） |
| `symbol` | symbol fence（`04` §2 检查 3）；`null` = 候选未声明 symbol |
| `fileHashRaw` | 唯一权威内容 hash；`matchesCandidate` 的判据（`04` IN-4） |
| `lineSliceHash` | 行切片复核 |
| `textHash` | **仅诊断**，不参与 fence（§5.4 TH-1…TH-5） |
| `sourceRevision` | revision fence（`04` §2 检查 5） |
| `generation` | generation fence（`04` §2 检查 6）；索引 snapshot 由 `generation.snapshot` 成员承担 |
| `manifestHash` | 校验所依据的 manifest |
| `freshness` | `FreshnessV1`（`09` §1.2.2）；`unknown` 不得当作 `fresh` |
| `permissions` | `PermissionScopeV1`（`09` §1.2.1）；`scopeId` 是其唯一键 |
| `matchesCandidate` | 是否进入 `RK.items[]` 的必要条件（`04` §7） |
| `checks[]` | 逐项检查结果；13 项 id 与 `04` §2 逐项对应 |
| `inspectedAt` | 不进入 `bodyHash` |

已在早期草稿中存在、现已**删除**的字段（不要恢复）：`scopeId`（改为 `permissions.scopeId`）、`snapshot`（改为 `generation.snapshot`）、`operationEpoch`（IR 不可携带 epoch 语义：`09` §3.1 IR × `epoch_mismatch` = `—`；epoch 检查结果通过 `checks[].id = "operation_epoch"` 记录，状态由 `ObservedV1` 承载）。

检索线自有的校验规则（不重复声明共享 schema；这些规则属于本线，必须保留）：

| 规则 | 内容 |
| --- | --- |
| IR-1 | `InspectCheckV1.id` 的 13 项封闭枚举以 `01` §4.4 为**唯一来源**；`04` §2 的 13 项检查必须与其逐项对应。检索线**不得**新增、改名或再列一份该枚举；需要新检查项时按 IR-2 走共享修订。 |
| IR-2 | 检索线不得在本地新增或删除 `InspectResultV1` 字段。需要新增字段时，先修订 `01` §4.4（由 `09` §1.2 登记），再回填本节映射表。 |
| IR-3 | 共享字段的形状不得在检索线重新定义；形状以 `01` §4.4 为准，登记与适用性以 `09` §1.2 / §2 为准。 |
| IR-4 | `pathNfc` 不替代 `path`；两者不一致（NFC 规范化结果不符）即 `invalid_response`。 |
| IR-5 | 检索线不得把本节的映射表当作字段表引用（例如写「见 `02` §5.2 的字段列表」）。任何字段清单或 `id` 枚举的引用必须指向 `01` §4.4。 |

### 5.3 权限与新鲜度：形状已冻结，只引用不重定义

| 类型 | 唯一权威 | 检索线规则 |
| --- | --- | --- |
| `PermissionScopeV1` | `09` §1.2.1（Shape 已冻结；`schemaId = pactile.cg.permission-scope`） | 检索线**不定义成员**。**`scopeId` 是该类型的唯一键**（替代历史名 `scopeKey`）；`readable` / `withinScope` / `readScopes` / `maxClassification` / `actions` / `egress` / `issuedAt` 均以 `09` §1.2.1 为准。检索文档出现任何内联 `{readable, withinScope, ...}` 形状均为漂移。 |
| `FreshnessV1` | `09` §1.2.2（Shape 已冻结；`schemaId = pactile.cg.freshness`） | 成员 = `verdict` / `asOf` / `basis` / `mtimeMs`；`unknown` 不得当作 `fresh`；`mtimeMs` 不是判定依据；不得用 `0` 表示未知。 |
| `egress` | `09` §1.2.1 `PS.egress`（CF-35） | 唯一形状 = `{destination: none\|local\|remote, authorized, authorizationRef}`；检索线 `01` / `08` 的对外发对象必须引用该形状。 |

| 规则 | 内容 |
| --- | --- |
| SY-PS-1 | 检索文档不得出现 PS / FR 的第二套形状；`scopeId` 一律指 `PermissionScopeV1.scopeId`。 |
| SY-PS-2 | 凡以 `scopeId` 作为值的字段（如 generation tuple、branch run scope），必须在本线内声明它是 `PermissionScopeV1.scopeId` 的副本；不得另立“检索线 scopeId”。 |
| SY-PS-3 | PS / FR 的形状或 `schemaId` 变更只通过 `09` 修订；检索线只跟进引用。 |

### 5.4 `textHash` 的边界（回应 Review 发现 二.4）

| 规则 | 内容 |
| --- | --- |
| TH-1 | `textHash` 是**诊断字段**：用于解释「为什么原始字节 hash 变了」（如换行符、BOM、编码变化）。 |
| TH-2 | `textHash` **不得**替代 `fileHashRaw`（原始字节 source hash），不得写入 source hash 字段，不得作为 freshness fence 依据。 |
| TH-3 | `textHash` 与 `fileHashRaw` 不一致时以 `fileHashRaw` 为准，并记一条 `invalid_response` 诊断（`09` §4）。 |
| TH-4 | `textHash` 不参与 `matchesCandidate` 判定，不参与 generation / revision / epoch fence。 |
| TH-5 | Worker 侧对解码文本取的 hash 只作提示，永不通过 fence（`04` IN-4）。 |

### 5.5 `ProviderCapabilitySnapshotV1`

完全复用 `01` §3.6；检索侧必填与规则见 `01-semantic-provider-contract.zh-CN.md` §2.2（PCS-1…PCS-6）。本文不重定义。

## 6. 持久化挂接

| 实体 | 位置 | 权威 |
| --- | --- | --- |
| RP / RC / RK | 冷路径：候选与 pack 落 Artifact；RunLedger 只记 `contextOperationId + packHash + outcome` | Artifact / RunLedger |
| `packHash` / `bodyHash` | 写入对应 artifact header | — |
| Inspect 结果 | 随 pack 落 Artifact；源文件内容不入库 | Artifact |
| `StatusFoldV1` | **已删除** | 折叠由 `01` §4.3 PK-7 的字段承担（`reason.code` + `reason.detailHash`），不另立类型 |
| embedding 向量 | **不入**任何 Kernel / RunLedger 事实；仅在索引或 provider 内部 | provider / 索引（阶段 2 起） |
| 评测实体 | `04-evaluation-controller` 的结果根 | Evaluation Controller |

## 7. ABI V3 转换与 `unconvertible`

现行 V3 logical ref 语法（`packages/cli/src/pactile/retrieval/evidence.ts`）：

```text
^(artifact|evidence|source|git|test)://<小写路径段>$      长度 ≤ 256；路径段只允许 [a-z0-9] 与 [._-]
并额外拒绝包含 credential / credentials / passwd / password / secret / token 的段
```

因此以下信息**无法**在 V3 ref 中表达：大写字母、非 ASCII 字符、行号 / 列号、worktree id、超过 256 字符的路径、含敏感词的路径段。转换函数必须显式失败：

```ts
function toAbiEvidenceRefV3(pointer: SourcePointerV1):
  | { status: "ok"; ref: string }
  | { status: "unconvertible"; reason: ReasonV1; detail: { pointer: SourcePointerV1; failing: string[] } };
```

| 规则 | 内容 |
| --- | --- |
| AB-1 | 禁止 lowercasing、NFC→NFD、丢行号、丢 worktree、截断路径、URL 编码、`..` 折叠来「凑」语法。 |
| AB-2 | 不可表达 → `unconvertible`，原始 pointer 原样保留在 `rejected[]`。 |
| AB-3 | 行号与列号以独立字段随候选传递（如 `lineRange`），不塞进 ref 字符串；**但**只要 pointer 的 `range` 非 `null`，其 ABI ref 转换即 `unconvertible`（`09` §3：不得「先截断再转换」）。若调用方需要文件级 ref，必须显式构造不带 range 的**新** pointer，并记录该事实，不得由转换函数静默丢弃。 |
| AB-4 | `unconvertible` 计数进入评测指标；阶段 1a 必须报告该比率，不得因为「0 个候选」而跳过。 |
| AB-5 | 只允许在 `plane=evaluation` 的报告里保留不可表达 pointer 的原文；runtime 侧只保留 `detailHash` 与逻辑 worktree id。 |
| AB-6 | 语法规则若未来变化，只能通过新版本 ABI 或新 schemaId；不得在本契约内修改现有 ABI。 |
| AB-7 | `unconvertible` 是**转换**失败，不是数据失败：pointer 本身可以是 `ok`（`04` §8），因此不得改写为 `invalid_response` / `missing`；RK 层级完全可表达它（§3.2）。 |

## 8. 与 `01` / `09` / `04` 的关系（逐项状态，无“待同步”模糊项）

| 编号 | 内容 | 状态 | 唯一权威 / 阻断点 |
| --- | --- | --- | --- |
| SY-1 | 共享状态声明 | **已闭合** | `01` §3.3（声明）/ `09` §3.1（适用性）；本文 §3.1 不再声明任何类型 |
| SY-2 | `InspectResultV1` / `InspectCheckV1` 字段归属 | **已闭合（CF-39）** | 唯一字段表与 `id` 枚举声明位置 = `01` §4.4（历史「additive / T3 线内」字段 `pathNfc` / `symbol` / `textHash` / `rangeExists` / `checks[]` / `inspectedAt` 已全部收编）；登记与适用性 = `09` §1.2（IR 行）/ §1.2.5。本线只保留映射与自有校验规则（`IR-1…IR-5`），**不声明接口、不持有 Owner 身份** |
| SY-15 | 检索线对 `01` §4.4 的引用纪律 | **已闭合（CF-39）** | 本线唯一合法的字段引用形式 = 「`01` §4.4」；`02` §5.2 `IR-5` 禁止把本节的映射表当作字段表引用；全目录 `interface Inspect(Result\|Check)V1` 声明数 = 0 |
| SY-16 | generation lineage 字段命名（CF-42） | **已闭合** | `03` §1.1：`previousGenerationId` / `nextGenerationId`（旧名 `supersedes` / `supersededBy` 作废）；与 `CM.supersedes: EntityRefV1 \| null`（`01` §4.6）不是同一语义 |
| SY-3 | 评测结果行的状态层级 | **已闭合（不新增字段）** | `04` §9.2 的 `observed.status` 写**原生层**状态；pack 层折叠在 pack 内用 `reason.code = cg-wrong-dimension` 表达（`01` PK-7/PK-8）；早期草稿的 `rawStatus` / `entityStatus` / `fold` 三字段提案已删除 |
| SY-4 | `timeout` / `cancelled` 判定 | **已闭合（本线）** | 判定表 = 本文 §3.4；共享侧措词缺陷 = SY-14 |
| SY-5 | `RK.gaps[]` | **已闭合** | `01` §4.3 line 422 已登记字段；不变量 PK-9 / PK-10 见 line 440/441；本线 §4.3 行已改为引用 |
| SY-6 | PS / FR 形状 | **已闭合** | `09` §1.2.1 / §1.2.2（本文 §5.3 只引用） |
| SY-7 | `IR.fileHashRaw` vs `CU.sourceHash` | **已闭合** | `01` §4.4 / §4.5 + `09` §4：同概念、不同字段名，**不得互换** |
| SY-8 | `scopeId` 唯一性 | **已闭合** | `09` §1.2.1 规则 3（`scopeId` 为 PS 唯一键，取代 `scopeKey`）；本文 §5.3 SY-PS-1/2 |
| SY-9 | 本文 §9 的 27 条负例编号 | **未闭合（编号归属）** | 编号权威 = `01` §7（已用 #19–#28）；Owner = Implementation；本文只给出本线序号 N-01…N-27 |
| SY-10 | `SourcePointerV1.scheme = "memory"` | **已闭合** | `01` §4.4 + `09` §1.2.5（CF-17） |
| SY-11 | 共享折叠码 | **已闭合** | `09` §3.2.2 + `01` §3.3（`cg-wrong-dimension`；本文 §3.5） |
| SY-12 | provider profile 类型 | **已闭合（本线删除）** | 早期草稿的 `SemanticProviderProfileV1` / `EmbeddingProviderProfileV1` 已从 `01` §2.3 / §2.4 删除，改为引用 `PCS` provider 记录 + `03` §1 generation tuple |
| SY-13 | `09` §3.2.2 曾把 `unconvertible` 列入 `IR` | **已闭合（`R-BL-19` / `X-10`）** | Implementation 已修：矩阵「`unconvertible`」行明写「`IR` 不在其中」（16:2x = `:403`）、§6 第 28 条登记该裁定（`:465`）；`09` §3.1 矩阵与散文现已一致；本线 §3.2 AP-1 / AP-3 不变 |
| SY-14 | `09` §3 的 `cancelled` 描述曾含「deadline /」 | **已闭合（`R-BL-17` / `X-9`）** | Implementation 已修：`09` §3.2.2 的 `cancelled` 行（`:327`）现为「上层 / 父级 deadline 触发的 abort」，与 §3.2.2 唯一判定规则（`:345`）及 §6 第 29 条（`:466`）一致；本线 §3.4 TC-1 / TC-10 不变 |

## 9. 负例清单（本线序号 N-01…N-27；全局编号由 `01` §7 分配）

`01` §7 已用 #1–#18，`09` §6 已用 #19–#28（`01` §7 line 740）。本线**不占用全局编号**，以 `N-nn` 引用，等待 Implementation 分配 #29+。

| 本线序号 | 负例 |
| --- | --- |
| N-01 | `RetrievalCandidateV1.semantic.embeddingDim` 与 snapshot 不一致，却被接受为低分候选（应 `wrong_dimension`） |
| N-02 | `SemanticSearchResultV1.status = "unavailable"` 但 `candidates.length > 0` |
| N-03 | `RP.branches` 启用 `semantic`，但 `providerRef` 为 `null` |
| N-04 | `RP` 中两条分支 `branch` 相同（重复启用） |
| N-05 | `RK.coverage` 缺少某条启用分支，或包含未启用分支（PK-1） |
| N-06 | `RK.items` 含 `inspect.status = "not_inspected"` 的候选（PK-3） |
| N-07 | `RK.rejected` 缺失某个 `unconvertible` 候选（PK-7 / PK-9） |
| N-08 | `SourcePointerV1.pathNfc` 被 lowercasing 或被 slug 化（应保留原始大小写与非 ASCII） |
| N-09 | `toAbiEvidenceRefV3` 对含大写路径返回 `ok`（应 `unconvertible`） |
| N-10 | ref 长度 > 256 或含敏感词段时返回 `ok`（应 `unconvertible`） |
| N-11 | `observedAt` / `createdAt` 被计入 `bodyHash`，或 `observedAt` 缺失 |
| N-12 | `permissions` 缺失（无默认值），或越权路径被当作可读 |
| N-13 | `freshness.verdict` 为 `unknown` 时被填入 `fresh` 或任何默认值 |
| N-14 | `candidateId` 无法由 `(planId, branch, canonicalLocatorKey)` 复算 |
| N-15 | `similarity` 出现在 `RK.items[].inspect` 或 evidence 字段（PK-4） |
| N-16 | `plane = "evaluation"` 的 pack 带 `runId` / `operationEpoch`（ISO-2） |
| N-17 | `CandidateRefV1.kind = "git-commit"` 而仓库无提交（BL-04） |
| N-18 | `fusion.merged` 中有 `mergedIds` 未出现在任何分支的 `inputs`（融合不可复算） |
| N-19 | `fallback.used = true` 但 `from` 为空，或 `used = false` 但 `reasons` 非空 |
| N-20 | `coverage[].status` 为 `cancelled` 却使用 `retrieval-deadline-exceeded`（§3.4 TC-1 / PK-12） |
| N-21 | `coverage[].status` 或 `rejected[].status` 直接写成 `wrong_dimension`（应折叠为 `invalid_response` + `cg-wrong-dimension`，PK-11） |
| N-22 | 折叠缺少 `reason.code = "cg-wrong-dimension"`，或 `reason.detailHash` 为空（§3.3 WD-3） |
| N-23 | 评测结果行把 pack 层折叠值写入原生层分布位置（`04` §9.2 `observed.status` 应为原生层；§3.3 WD-5） |
| N-24 | 重复候选被写入 `rejected[]`（RC-5：应进 `fusion.merged[]`） |
| N-25 | 使用已移除的 reason.code（`retrieval-duplicate-candidate` / `retrieval-not-configured` / `retrieval-fixture-drift`） |
| N-26 | `textHash` 被写入 source hash 字段或参与 fence（§5.4 TH-2） |
| N-27 | `range` 非 `null` 的 pointer 被静默转换为文件级 ref 而不记录（§7 AB-3） |

## 10. 本线开放问题（每条都有唯一 owner）

| 编号 | 内容 | Owner | 解除条件 |
| --- | --- | --- | --- |
| `RS-R1` | ~~`RK.gaps[]` 是否在 `01` §4.3 登记~~ | — | **已闭合**：已在 `01` §4.3 line 422 登记（§8 SY-5） |
| RS-R2 | `InspectCheckV1` 保留为数组还是压缩为 hash | Retrieval（本线裁定） | **已定**：保留数组——`04` §8 指标要求逐项分布；不再列为开放项 |
| RS-R3 | runtime 平面 `RK.rejected[]` 是否保留 pointer 原文 | Retrieval（本线裁定） | **已定**：评测平面保留原文；runtime 只留 `reason.detailHash` + 逻辑 worktree id（AB-5）；见 `04` UN-1/UN-2 |
| RS-R4 | `coverageHint` 是否进入共享契约 | Retrieval | 保留为 RC 的 T3 线内字段（`05` §2）；如果跨线使用则先在 `09` §1.2.5 登记 |
| RS-R5 | reason.code 封闭枚举的登记方式 | Implementation | 按 `09` §3.2.2 命名空间（线内 `retrieval-*` 可不入共享表）；若要求共享登记则依本节清单 |
| RS-R6 | `abstain.requireFullCoverage = true` 是否排除 `shadow` 分支 | Retrieval（本线裁定） | **已定**：排除（`01` PK-2 只约束 `authoritative`） |
| RS-R7 | `01` §4.4 的 `freshness` / `permissions` 与 `09` §1.2.1/§1.2.2 的形状对齐 | Implementation | 已对齐（CF-04 / CF-15）；剩余仅为 `01` §4.4 注释旧称，不影响语义 |
| RS-R8 | §9 的 N-01…N-27 全局编号区间 | Implementation | 按 `01` §7 line 740 的机制分配 #29+ |

