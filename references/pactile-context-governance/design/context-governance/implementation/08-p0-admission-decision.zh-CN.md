# P0 文档冻结入场裁定

- 状态：`P0_DOCUMENT_WRITE_ADMITTED`
- 适用范围：只允许写 Context Governance v1 的文档、契约草案、fixture、评测矩阵和迁移说明。
- 不表示：运行时代码通过、Provider ready、产品 Run 完成、Kernel settlement、真实 Pi compaction 通过或阶段 1 已获准。
- 裁定角色：Implementation Controller（协调与闸门裁定，不拥有 Kernel/Host/Policy Gate/EffectGateway 的事实或副作用权限）。
- 日期：2026-10-09（Asia/Shanghai）

## 1. 入场结论

三条线的回执均已完成重新基线，且都把执行体明确为 Pi Agent。它们可以进入 **P0 文档写作**，但不能把 `READY_FOR_P0` 解释为无条件解除所有阻断，也不能启动运行时工作。

本裁定只批准以下动作：

1. 在 `D:\pactile\docs\architecture\context-governance\` 内完成冻结中的文档和契约草案；
2. 为 fixture、gold/negative labels、EvaluationRunManifest、paired report、fault injection 和 regression case 编写规范；
3. 更正旧文档中的 P8/P9/P10 桶名映射，并标注旧目标已被 Context Governance v1 取代；
4. 记录候选身份、hash 语义、版本映射、权限和外发边界。

以下动作仍然禁止：

- 修改 `packages/**` 或 Worker 运行时代码；
- 回滚、合并或隔离现有运行时改动以外的代码操作；
- 调用真实 Jev、EmbeddingGemma、远程 embedding 或读取凭据；
- 建立 vector DB 或第二套 indexing pipeline；
- 执行真实 Pi compaction、lossy action、restore 演练或 memory promotion；
- 启动旧 P1/P3/P8/P9/P10、阶段 1 baseline 或任何长跑；
- 创建 V2 Task/Run，除非用户另行批准该 Task 提案；
- commit、push、merge、tag、publish、deploy。

## 2. 对进入条件的裁定

### 2.1 EmbeddingGemma 调研缺失（BL-02 / B1）

接受 P0 以“参数 + `unverified`”方式冻结 readiness fixture：

- 模型 id、维度、task prefix、query/document 前缀、batch、取消、隐私和成本字段可以进入 schema；
- 它们不能写成已验证的期望值；
- readiness fixture 的 verdict 必须允许 `unverified`；
- 阶段 2 semantic shadow 前必须补充研究来源或实际 readiness evidence；
- 当前不调用模型、不读取远程端点、不读取凭据。

### 2.2 重新基线前的运行时改动（BL-03 / B3 / B-CM-1）

选择 **冻结并隔离为阶段 1 的未评审候选**：

- 不回滚，因为当前 `develop` 没有可依赖的基线提交，回滚会成为破坏性操作；
- 不把这些文件纳入 P0 evidence、fixture、Review candidate 或通过结论；
- 不再允许两条线继续交错修改这些文件；
- P0 文档只能记录它们的路径、tree hash、已知缺陷和归属冲突；
- 阶段 1 前必须建立独立候选快照、唯一写入者和新的 Review 入口；
- 修复 DEF-IMPL-1…6、B-CM-2/3/4 仍然属于后续运行时任务，需要单独授权。

### 2.3 候选身份（BL-04 / B-CM-9）

P0 采用 `CandidateRefV1` 的 **tree-hash** 方案，不创建基线提交：

```text
candidateSha = SHA-256 of sorted lines:
  <relative-path> + "\\0" + <file-sha256> + "\\n"

CandidateRefV1 = {
  kind: "tree-hash",
  sha256: candidateSha,
  fileCount: number,
  listHash: SHA-256 of the canonical file list
}
```

规则：

- 路径必须是仓库相对路径、使用 `/`、按字节序排序；
- 每个文件的内容 hash 使用 SHA-256；
- tree hash 只绑定候选快照，不等价于 Git commit；
- 没有 Git commit 时不得伪造 `candidateSha`；
- 阶段 1 每次重跑必须生成新的 manifest 和 tree hash。

### 2.4 `RetrievalPlanV2` 与 ABI `RetrievalPlanV3`（BL-06 / B4）

接受并冻结两者并存，不将其解释为升级关系：

- `RetrievalPlanV2` 是 Context Governance 的多分支检索计划；
- TypeScript 符号使用 `ContextRetrievalPlanV2`；
- schema id 为 `pactile.cg.retrieval-plan`，schema version 为 `2`；
- 现有 `RetrievalPlanV3` 保留为 ABI 的 claim/evidence verification chain；
- V2 通过 `abiPlan: RetrievalPlanV3 | null` 引用 V3，不复制 V3 字段；
- 不修改现有 ABI；
- 二者之间的转换必须显式、可失败，不允许静默降级或重编码。

### 2.5 压缩动作词汇（BL-07）

P0 记录八个 action 的并集：

```text
keep_full
mask_reopenable
externalize
structured_project
lossy_compress
drop
request_review
block
```

`drop` 在 v1 中只允许作为 shadow judgment 或 `request_review` 的输入，不开放执行。`lossy_compress` 只能在阶段 6、低风险范围、Policy Gate、正式授权和 post-compaction audit 全部满足时讨论。

### 2.6 三线回执与静态检查状态（BL-01 / B2 / B8）

当前收到的三份重新基线回执都带有 `REBASE_STATUS: READY_FOR_P0`，因此“等待三线回执”不再阻止 P0 文档写作。它们仍然必须经过独立 Review，才能离开 P0。

Retrieval 回执中的旧 lint 阻断与 Implementation 回执的较新观测不一致。采用较新观测：2026-10-09 10:3x 的 typecheck 与 lint 均为 exit 0；这只解除“当前 lint 失败”的文档阻断，不证明设计正确，也不替代 P0 Review。旧失败保留为历史观察，不修改旧证据。

P5 的 `fixtureMismatchCount=1` 原因仍未核实，继续作为未解释的背景证据；在原因查明前不能写成“fixture 未漂移”或作为新架构的通过依据。

## 3. P0 中冻结的技术语义

### 3.1 SourcePointer 与 ABI ref（BL-08 / B5）

使用 `SourcePointerV1` 表达：

- 大写路径；
- 非 ASCII 路径；
- NFC 规范化路径；
- 行号、列号和范围；
- worktree/branch；
- artifact、transcript 和 external source。

转换到 ABI V3 ref 必须是显式函数。表达不了时返回 `unconvertible`，不得静默截断行号、改大小写或重编码路径。

### 3.2 Index 写入（BL-09 / B6 / G6）

阶段 1 的确定性 baseline 默认不执行 workspace index 写入。P0 文档同时定义两种后续方案，但不选择性执行：

1. 将 index init/sync 声明为 EffectGateway 管理的写 effect；或
2. 使用明确的外置 `indexDir`，并记录 owner、generation、source revision、权限和恢复策略。

任何实际选择都属于阶段 1/2 的新写集，需要重新冻结候选和评测。

### 3.3 File hash（BL-10 / B7 / G10）

当前工作树 Inspect 的 canonical source hash 使用 **原始字节 hash**。如果需要 UTF-8 解码文本 hash，只能作为单独的 `textHash` 观测字段，不能替代 source hash，也不能让 Worker 的解码文本 hash 通过 freshness fence。

### 3.4 外发和秘密扫描（BL-16 / BL-19 / B-CM-8）

P0 采用 deny-by-default：

- 没有明确 capability policy 和 `egress.authorizationRef` 时拒绝远程外发；
- Provider 日志不得记录凭据、原始敏感文本、未授权源码和完整 transcript；
- 秘密扫描策略在 P0 记录为未决策略，不能作为“已保护”事实；
- 阶段 2 前必须冻结拒写/需确认/允许的策略和审计字段。

### 3.5 Pi 版本（BL-20 / B-CM-10）

P0 只记录当前安装版本与 provenance 的不一致：

- 当前本机观察到的版本：Pi coding-agent 1.0.2；
- provenance 记录：1.0.4；
- 版本不一致的测试不能作为真实 compaction 通过证据；
- 不在 P0 锁定、升级或修改 lockfile；
- 阶段 1b/真实 Pi compaction 前必须另行确定版本和 candidate snapshot。

## 4. 写集确认

### Implementation Controller

保留已有 `implementation/00–07`，新增本裁定文件 `implementation/08-p0-admission-decision.zh-CN.md`。P0 允许继续写：

- Contract 草案补充；
- ownership/dependency；
- 阶段计划；
- Evaluation Controller；
- 写集/回滚；
- blockers；
- legacy migration；
- 本裁定。

### Retrieval Controller

P0 允许写入 `retrieval/01–12`：

- SemanticProvider 契约；
- Retrieval schema；
- generation/index 设计；
- Inspect/freshness fence；
- candidate pipeline；
- fallback；
- Search → Fetch → Evidence；
- privacy/egress；
- readiness fixtures；
- evaluation matrix；
- legacy worker migration；
- blockers/unverified。

旧 migration 文档只做表述更正和“已被 Context Governance v1 取代”的状态标记，不改旧证据、gold、分母或结果。

### Compression & Memory Controller

P0 允许写入：

- `context-unit-manifest-v1.zh-CN.md`；
- `compression-decision-chain-v1.zh-CN.md`；
- `compression-memory-evaluation-matrix-v1.zh-CN.md`；
- `compression-memory-legacy-migration.zh-CN.md`。

可以在旧 Batch 2 文档顶部增加状态指针，但不能改写或删除旧证据。

### 共同排除项

三条线的共同排除项：

- `packages/**`；
- Worker 候选；
- `D:\MyHarness\**`；
- Provider 配置；
- lockfile；
- gold 文件；
- 评测分母；
- 旧 run 目录；
- 全局 Agent/Pi/npm/git/系统配置。

## 5. P0 离场条件

P0 文档冻结完成前，必须满足：

1. 各线文档通过独立 Review；
2. 所有实体具有 schema id、schema version、字段表、hash 规则和 provenance；
3. `unknown`、`stale`、`missing`、`permission_denied`、`revision_mismatch`、`epoch_mismatch` 是一等结果；
4. exact/protected 内容有确定性识别规则和禁止处置清单；
5. 决策链每一步都有失败出口；
6. Receipt 映射证明 RunLedgerV1 是唯一 Attempt/Effect/Receipt/Settlement 权威；
7. fixture、gold/negative labels、来源、标注者、盲审规则和 sha256 已冻结；
8. EvaluationRunManifest、paired report、fault injection 和阳性对照已冻结；
9. P0 全程没有运行时代码修改、真实 provider、真实 compaction 或长跑；
10. 阶段 1 的启动仍需单独授权。

在 P0 离场条件满足前，任何旧 PASS 都只能作为背景或 candidate 证据，不能升级为新架构通过。
