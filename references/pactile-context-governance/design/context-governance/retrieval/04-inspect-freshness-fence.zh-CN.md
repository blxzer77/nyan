# Inspect 与 freshness / worktree fence（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。不实现 Inspect、不修改 `packages/**`、不读取真实工作区（本文只定义规则）。
- 状态引用：本文使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3）；层级折叠与 `timeout` / `cancelled` 判定见 `02` §3.3 / §3.4。
- 依据：架构 §27.3、§27.5；`01-contract-draft` §4.3 / §4.4；`02-retrieval-schema` §5.2 / §7；`08-p0-admission-decision` §3.1、§3.3。
- 核心规则：**任何候选（含 semantic 与 external）在进入 `RetrievalPackV1.items` 之前，必须回到当前工作树做一次 Inspect；Inspect 只信任当前工作树的原始字节 hash。**

## 1. Inspect 的输入与输出

```text
输入：RetrievalCandidateV1（含 SourcePointerV1、generation、sourceRevision、permissions、snapshot）
     + plan 的 scope / worktree / branch / generation 期望
     + 当前工作树（只读）
输出：ObservedV1<InspectResultV1>  →  ok | 一等失败状态
```

```ts
function inspectCandidateV1(
  candidate: RetrievalCandidateV1,
  expectation: { workspaceId: string; worktreeId: string; branch: ObservedV1<string>;
                 scopeId: string; generation: GenerationRefV1; snapshot: string | null;
                 sourceRevision: ObservedV1<SourceRevisionRefV1>; operationEpoch: number | null;
                 deadline: { deadlineAt: string } },
  fs: InspectFsPortV1,          // 只读端口：stat / readBytes / readSymbol / resolve
): Promise<ObservedV1<InspectResultV1>>;
```

## 2. 必须核对的项目（13 项）

| # | 检查 id | 内容 | 失败状态 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `path` | 路径存在、是普通文件、NFC 规范化后与候选一致 | `missing` / `invalid_response` | 目录、设备文件、符号链接越界均为失败 |
| 2 | `range` | 行范围存在且不越界（1-based 闭区间） | `revision_mismatch`（`retrieval-line-range-gone`） | 范围超出文件行数即失败 |
| 3 | `symbol` | 声明 symbol 时，其定义范围包含候选范围（或与候选一致） | `revision_mismatch`（`retrieval-symbol-gone`） | 无法解析 symbol 的语言 → `unknown`，不是 pass |
| 4 | `file_hash_raw` | **原始字节** sha256 与候选 / expectation 一致 | `revision_mismatch` / `stale` | 唯一权威 hash（回应 BL-10 / G10） |
| 5 | `source_revision` | worktree / 分支 / commit 与 expectation 一致 | `revision_mismatch` | 未知（无 VCS）时为 `unknown`，须显式允许 |
| 6 | `generation` | `GenerationRefV1` 四分量与 expectation 一致 | `generation_mismatch` | 见 `03` §3 |
| 7 | `worktree` | `worktreeId` 与 expectation 一致（逻辑 id，不含绝对路径） | `revision_mismatch`（`retrieval-worktree-mismatch`） | 跨 worktree 复用索引的主要拦截点 |
| 8 | `branch` | 当前分支与 expectation 一致 | `revision_mismatch`（`retrieval-branch-mismatch`） | 分支未知 → `unknown`；plan 未要求分支时可跳过并记录 |
| 9 | `workspace` | `workspaceId` 一致；路径未逃出 workspace / worktree 根 | `permission_denied`（`retrieval-path-outside-scope`） | 盘符、UNC、`..`、symlink 逃逸全部拒绝 |
| 10 | `permission` | 可读且 withinScope（语义按共享 `PermissionScopeV1`，`02` §5.3）；与 `scopeId` 一致 | `permission_denied` | 不把 `permission_denied` 降级为 `missing`；本线不定义 PS 成员形状 |
| 11 | `freshness` | 读取时的观测（mtime / size 等，属 `FreshnessV1`，`02` §5.3）与候选观测比较 | `stale`（无 hash 可比时） / 记录 | `mtime` 只是辅助；`fileHashRaw` 才是判据；本线不定义 FR 成员形状 |
| 12 | `operation_epoch` | runtime 平面 `operationEpoch` 与当前 operation 一致 | `epoch_mismatch` | evaluation 平面禁止携带该字段（ISO-2）；迟到结果按 `02` §3.4 TC-6 只记 stale diagnostic |
| 13 | `snapshot` | 候选 `snapshot` 与 expectation 一致（或 expectation 为 `null` 且候选为 `null`） | `generation_mismatch` / `stale` | 索引 snapshot 与工作树 snapshot 是不同概念，字段分开 |

每条检查写入 `InspectCheckV1[]`（字段与 id 枚举的唯一来源为共享 `InspectResultV1` / `InspectCheckV1`，见 `implementation/01-contract-draft` §4.4；`retrieval/02` §5.2 仅作字段映射与线内校验；本节 13 项与其逐项对应），包含 `result: ObservedV1<"pass" | "fail">`。任何 `result != ok` 的检查把整体判为对应的失败状态。

各检查失败时的 reason.code（封闭枚举见 `02` §3.5）：

| 检查 | 失败状态 | reason.code |
| --- | --- | --- |
| `path` | `missing`（文件不存在）/ `invalid_response`（路径非法）/ `permission_denied`（越界） | `retrieval-path-missing` / `retrieval-ref-unconvertible` **不适用**（AB-7）；越界用 `retrieval-path-outside-scope` |
| `range` | `revision_mismatch` | `retrieval-line-range-gone` |
| `symbol` | `revision_mismatch` | `retrieval-symbol-gone` |
| `file_hash_raw` | `revision_mismatch` / `stale` | `retrieval-source-stale` |
| `source_revision` | `revision_mismatch` / `unknown` | `retrieval-check-indeterminate` |
| `generation` | `generation_mismatch` | `retrieval-generation-mismatch` |
| `worktree` | `revision_mismatch` | `retrieval-worktree-mismatch` |
| `branch` | `revision_mismatch` | `retrieval-branch-mismatch` |
| `workspace` | `permission_denied` | `retrieval-path-outside-scope` |
| `permission` | `permission_denied` | `retrieval-path-outside-scope` |
| `freshness` | `stale` / `unknown` | `retrieval-source-stale` / `retrieval-check-indeterminate` |
| `operation_epoch` | `epoch_mismatch`（由包裹 IR 的 `ObservedV1` 承载；**IR 本身不可表示**，`02` §3.2） | `retrieval-epoch-fenced`（仅用于被中止的执行；迟到结果不写入当前输出，`TC-6`） |
| `snapshot` | `generation_mismatch` / `stale` | `retrieval-generation-mismatch` / `retrieval-source-stale` |

## 3. 判定与 fail-closed 规则

| 规则 | 内容 |
| --- | --- |
| IN-1 | Inspect 结果只有 `ok` 或明确失败状态；不允许「部分通过」。任一必需检查非 ok → 整体非 ok。 |
| IN-2 | 未知即失败：无法判定的检查记 `unknown`（`retrieval-check-indeterminate`），并使整体非 ok（fail-closed），不得当 pass。 |
| IN-3 | 允许「不适用」的检查（如无 VCS 时的 `source_revision`）只能在 plan 显式声明时跳过，并记为 `ObservedV1{status:"unknown"}`，同时整体状态降级为 `ok` 但 `coverage` 必须披露该分支的判定基础。 |
| IN-4 | `fileHashRaw` 是权威；`textHash`（解码文本 hash）只作为观测字段，永不参与 fence（回应 BL-10 / G10）。 |
| IN-5 | 大小写与编码：路径比较按 NFC 规范化后的字节精确比较，**不**做大小写折叠（Windows 上亦然）；大小写不匹配必须显式失败，不允许「碰巧能打开」就通过。 |
| IN-6 | 符号链接：解析后必须仍在 workspace / worktree 根内；解析失败或越界 → `permission_denied`。 |
| IN-7 | Inspect 必须只读：不得创建、修改、删除、加锁工作树内任何文件（阶段 1 默认不写索引，见 `03` §4）。 |
| IN-8 | Inspect 必须在 deadline 内完成；时间真的耗尽 → `timeout` + `retrieval-deadline-exceeded`；被取消 → `cancelled`（`02` §3.4），并丢弃该候选（不保留半读内容）。 |
| IN-9 | Inspect 不得读取候选未声明的路径（最小读：`path` + 必要的 symbol 表）。超出即为 scope 违规计数。 |
| IN-10 | Inspect 结果不复用缓存跨 operation：同一候选在两次 operation 之间必须重新 Inspect（缓存会导致陈旧通过）。 |

## 4. `matchesCandidate` 语义

`matchesCandidate = true` 当且仅当：

1. `fileHashRaw` 等于候选 / expectation 的 hash；且
2. `lineSliceHash` 等于候选声明的 slice hash（若候选未声明 slice hash，则本条不适用并记录）；且
3. 若候选声明 symbol，则 symbol 检查 pass。

`matchesCandidate = false` 的候选：不进入 `items`，进入 `rejected`，状态取第 2 节中最具体的一项（优先 `generation_mismatch` → `revision_mismatch` → `stale`）。

重新锚定（re-anchor）规则：

| 规则 | 内容 |
| --- | --- |
| RA-1 | 内容变化后「行号漂移」不允许在 Inspect 内自动修正；只能产生**新候选**（由新的检索轮次产生）或明确拒绝。 |
| RA-2 | 若实现方要做行号重定位，必须作为**独立步骤**，产出新的 `SourcePointerV1` 与新 `candidateId`，并把旧候选记为 `stale`。 |
| RA-3 | 重定位不得扩大范围（例如从 10 行扩到整文件）；扩范围必须由调用方显式请求并计入字节预算。 |

## 5. epoch / lease fence（runtime 平面）

| 规则 | 内容 |
| --- | --- |
| EP-1 | runtime 平面的每次 Inspect 必须记录 `operationEpoch`；与当前 operation 不一致 → `epoch_mismatch`（该状态在 `IR` 上不可表示，`09` §3.1；因此以包裹它的 `ObservedV1` 承载，`IR` 值不写入）。 |
| EP-2 | 旧 Attempt / 旧 epoch 的迟到结果一律拒绝，只记 stale diagnostic；不得写入当前 operation 的任何输出（包括 `RK.coverage` / `RK.rejected`）。已开始的迟到执行被中止时记 `cancelled` + `retrieval-epoch-fenced`（`02` §3.4）。 |
| EP-3 | evaluation 平面禁止 `operationEpoch` / `lease` 字段（ISO-2）；评测运行不持有 lease。 |
| EP-4 | P0 与阶段 1a 不引入真实 lease；此处只冻结**字段与拒绝语义**，租约与 fencing 的权威属 Host 轨道（`BL-05`）。 |

## 6. freshness 语义

| 情形 | 状态 | 处理 |
| --- | --- | --- |
| hash 一致、revision 一致、generation 一致 | `ok` | 进入 `items` |
| hash 一致但 `mtime` 变新（例如 touch） | `ok`，`freshness` 记录差异 | 不因 `mtime` 拒绝（内容未变） |
| hash 不一致 | `revision_mismatch`（若 revision 也变）或 `stale`（`retrieval-source-stale`） | 拒绝；按需重新检索 |
| revision 未知（无 VCS / 无快照） | `unknown`（`retrieval-check-indeterminate`） | 只有在 plan 显式允许时才可继续；`coverage` 必须披露 |
| generation 不符 | `generation_mismatch`（`retrieval-generation-mismatch`） | 拒绝；触发重建或 fallback |
| 文件被删除 | `missing`（`retrieval-path-missing`） | 拒绝；不当作「无匹配」 |
| 无读权限 / 越出 scope | `permission_denied`（`retrieval-path-outside-scope`） | 拒绝；不当作 `missing` |
| 读取超时 / 中断 | `timeout`（`retrieval-deadline-exceeded`） | 拒绝；披露；被取消则记 `cancelled`（`02` §3.4） |
| 无法按约定解码 / 分析（非 UTF-8 文本、无法解析） | `invalid_response`（`retrieval-binary-or-undecodable`） | 拒绝；不当作「无匹配」 |
| 检查项无法判定（fail-closed） | `unknown`（`retrieval-check-indeterminate`） | 整体非 ok（`IN-2`）；不得当作 pass |

## 7. `RetrievalPackV1` 的准入约束

`items[]` 只能包含：

```text
已 Inspect 的候选 = { candidateRef, inspect: InspectResultV1(ok), rank }
```

并且每个 item 必须同时携带：

| 字段 | 来源 |
| --- | --- |
| source pointer | 候选 `locator`（`SourcePointerV1`，原样保留大小写 / 非 ASCII / 行范围 / worktree） |
| source hash | `InspectResultV1.fileHashRaw` |
| source revision | `InspectResultV1.sourceRevision` |
| generation | `InspectResultV1.generation` |
| freshness | `InspectResultV1.freshness` |
| permissions | `InspectResultV1.permissions` + `scopeId` |
| coverage | pack `coverage[]`（该候选所属分支） |
| dedupe / rank provenance | `fusion.merged[]` + `items[].rank` + 各分支 `inputs[]` |
| inspect result | `InspectResultV1`（含 `checks[]`） |
| 降级原因 | `fallback.reasons[]`（若该分支曾降级） |
| 缺口与不确定性 | 非 ok 的 `coverage[].status` + `reason.code`；无法归入 `coverage` / `rejected` 的观察缺口走 `RK.gaps[]`（`01` §4.3 line 422，PK-9/PK-10） |

规则：

| 规则 | 内容 |
| --- | --- |
| PK-IN-1 | `items` 中任何候选缺上述任一项 → pack 构造失败（`pack_blocked`），不得发出不完整 pack。 |
| PK-IN-2 | `rejected[]` 必须覆盖所有未被接受的候选，并保留其状态与 reason（`02` PK-7 / PK-9）。 |
| PK-IN-3 | shadow 分支的候选即使 Inspect ok 也不进入 `items`（`01` PK-5）。 |
| PK-IN-4 | `search_hit` 在 Fetch → Evidence 之前不得进入 `items`（`01` PK-6 / `07`）。 |
| PK-IN-5 | 若「全部 authoritative 分支 ok 且零命中」，可 `pack_empty_observed`；否则至少 `pack_degraded`（`01` PK-2）。 |

## 8. ABI V3 ref 转换与 `unconvertible`

现行 V3 语法只接受 `^(artifact|evidence|source|git|test)://<小写段>$`、长度 ≤ 256、且拒绝含敏感词的路径段。因此：

| 情形 | 结果 |
| --- | --- |
| 路径含大写、非 ASCII、空格或其他非法字符 | `unconvertible`（`retrieval-ref-unconvertible`） |
| pointer 的 `range` 非 `null`（行号 / 列号） | `unconvertible`（`02` §7 AB-3：不得先截断再转换；文件级 ref 必须显式构造新 pointer） |
| `worktreeId` 需要随 ref 传递 | `unconvertible`（worktree 走独立字段） |
| 路径长度 > 256 | `unconvertible` |
| 路径段含 `credential` / `password` / `secret` / `token` 等 | `unconvertible`（`retrieval-ref-sensitive-term`） |

禁止的「凑语法」手段（任一出现即设计缺陷）：

```text
lowercasing            slugify / kebab-case       URL / percent 编码
丢行号 / 丢列号         丢 worktreeId              截断到 256
NFC→NFD / 反向规范化    ../ 折叠                  盘符或 UNC 改写
```

`unconvertible` 的真实含义是「本 ABI 语法无法表达该 pointer」，**不是**「该候选无效」。因此：

| 规则 | 内容 |
| --- | --- |
| UN-1 | 候选进入 `rejected[]`，`status = "unconvertible"`（RK 可表达，`02` §3.2），原始 pointer 原样保留（评测平面）。 |
| UN-2 | runtime 平面只保留 `detailHash` 与逻辑 worktree id，不落原文。 |
| UN-3 | `unconvertible` 比率进入评测指标（`10-evaluation-matrix`），不得因分母为 0 而省略报告。 |
| UN-4 | `unconvertible` 永远不会被「修复」成合法 ref 后重试；修复只能通过新 ABI 版本。 |
| UN-5 | Inspect 本身不依赖 ABI ref 语法：Inspect 使用 `SourcePointerV1`，转换只发生在需要向 ABI 交付证据的边界（`02` §3.2 AP-1：IR 不可表达 `unconvertible`）。 |
| UN-6 | `unconvertible` **不得**用于表示数据缺陷：缺 locator / 格式非法 → `invalid_response`；越出 scope → `permission_denied`（`02` §7 AB-7）。独立测试情形见 `implementation/04-evaluation-controller` §6 的 **`FI-20.1`**（`FI-20` 的子用例）与 `10` §5 `FQ-23`。 |

## 9. 与 Worker（structural / exact 分支）的关系

| 项 | 现状（`11-legacy-worker-migration`） | Inspect 的处理 |
| --- | --- | --- |
| Worker 的 `hash` 字段 | Worker 对 UTF-8 解码文本取 hash（G10） | 仅作提示；权威是 `fileHashRaw` |
| Worker 的 `line` | 1-based 行号，不含列 | 作为候选提示；Inspect 复核范围 |
| Worker 的 `ref` | `source://<路径>`，小写语法 | 若不可表达 → `unconvertible`，不做改写 |
| Worker 的 scope | 可能返回 workspace root 与宿主指纹（G1/G8） | 必须丢弃；只接受 worktree 相对路径 |
| Worker 的 decision | 只允许 `rule` provider | 与 Inspect 无关；DecisionProvider 不参与 fence |

## 10. 不变量汇总（可测试）

| ID | 不变量 |
| --- | --- |
| IF-1 | 每个 `items[]` 元素都有一条 `ok` 的 `InspectResultV1` |
| IF-2 | `fileHashRaw` 是唯一权威内容 hash；`textHash` 不参与判定 |
| IF-3 | 未知 / 无法判定一律 fail-closed |
| IF-4 | `epoch_mismatch` 结果永不进入当前 operation 输出（由 `ObservedV1` 承载，不写入 `IR` 值，也不进 `RK`） |
| IF-5 | `permission_denied` 与 `missing` 不可互换 |
| IF-6 | 无 lowercasing、无路径重编码、无行号丢弃；不可表达即 `unconvertible` |
| IF-7 | Inspect 只读，且只读候选声明的路径 |
| IF-8 | Inspect 结果不跨 operation 复用 |

## 11. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| IF-R1 | `InspectCheckV1` 的 13 项是否为最小集（是否需要 size / inode / device 等平台检查） |
| IF-R2 | 无 VCS 环境（纯目录快照）下 `source_revision` 的表达：`worktree-snapshot` + tree-hash 是否足够 |
| IF-R3 | symbol 解析失败时用 `unknown`（fail-closed）是否在阶段 1a 造成过多不可用候选；需要在基线里量化 |
| IF-R4 | Windows 大小写不敏感文件系统的处理：是否额外记录 `caseMismatchDetected` 观测（本文按「精确比较、不折叠」处理） |
| IF-R5 | `rangeExists` 与 `lineSliceHash` 在候选未声明范围时的取值 |
| IF-R6 | 是否需要 Inspect 级别的速率/并发限制（避免大量 stat / read 影响用户工作区） |
