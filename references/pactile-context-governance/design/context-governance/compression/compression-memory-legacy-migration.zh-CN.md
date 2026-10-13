# 压缩与记忆旧问题迁移表 v1（P0 冻结草案，proposed）

- 状态：proposed。本文只做映射与规则，**不修改、不删除、不重启**任何旧任务、旧证据、旧 gold 或旧分母。
- 依据：`compression-memory-rebase-report.zh-CN.md`（§4 的 12 项历史核查、B-CM-1…10）、`implementation/06-blockers.zh-CN.md`（BL-11…BL-15、BL-17、BL-19…BL-21）、`implementation/07-legacy-migration.zh-CN.md`（跨线一页说明，本文是其压缩/记忆线细化）、`compression-memory-evaluation-matrix-v1.zh-CN.md`（CM-B01…B21、ZT-CM-01…ZT-CM-10）。
- 规则：旧结果一律降级为**背景证据**；“通过”不可迁移（`07` R-1…R-8）。
- 本文不引入任何新 hash；旧证据的 hash 只按原样引用路径，不重新计算、不补写结论。

## 1. 结论先行

1. 旧压缩/记忆评测（B0–B8、Rapid Closure、独立复核）绑定的是 **MyHarness 候选 `0a1dd4c3…` 及其 dirty write set**，不是 `D:\pactile` 当前树；其 verdict 不可迁移。
2. 旧 Pi 扩展线（audit-response v4）的结论中，**方法论**仍然有效（外部校验、六态分类、静态门、故障注入测试台），但它证明的是**另一个实现**的 mask 管线，不是本架构的 ContextUnit/manifest 链路。
3. 旧 B4/v65 的长跑数字（含 `18/100`、`preRunManifestPresent:false`）不得在新文档中引用为收益或通过证据。
4. 本线的 12 项历史问题全部转为 P0 的 regression case 或阻断项（§3、§4）。
5. 旧 Kernel Task `10-04-pactile-agent-context-memory-policy` 已 Close；本文只把它当**证据引用**，不改状态、不重开。

## 2. 旧证据盘点（只读）

| 来源 | 位置 | 现有结论（原样） | 新用途 |
| --- | --- | --- | --- |
| 机制评测 B0/B2 | `D:\MyHarness\.pactile\tasks\10-05-...\verification.b0-v35-*`、`verification.b2-v28-glm-shared-root.json` | 候选绑定通过；B2 `pass`（确定性假 Provider，40/40） | 臂设计与 determinism 的**格式**参考 |
| 恢复 B3 | `verification.rapid-b3-v61-run-scope.json` | `run` scope 9/9，含一次真实进程中断；injected timeout 不算 strict pass | FI-14 / FI-19 fixture 形状参考 |
| 长会话 B4 | `verification.rapid-b4-v61-25-rounds.json`、`verification.b4-v65-interrupted.json` | 25/25 settled、8/8 compaction；v65 `unverified`（18/100） | 净收益指标的**问题定义**参考；**不引用数字** |
| Provider B5 | `verification.b5-v5x-*` | 多次 Connection error / 认证阻塞 | `ProviderCapabilitySnapshotV1.availability` 的语义来源 |
| 动作 B7 | `verification.rapid-b7-v60-gpt.json`、`verification.b7-v56-formal-restored-provider.json` | 单一 GPT seam 通过；DeepSeek/GLM 保留 Connection error | 可逆动作 fixture 的参考；保留负证据 |
| B8 / goal audit | `goal-audit-rapid-v64.json`、`summary.v58-*.json` | Rapid 7/7（仅缩小边界）；原始全量 open/deferred；严格门槛 1/4 | 被 PCR + Review 取代；“25%”不沿用 |
| 独立复核 | `verification.independent-review-v63-rapid.json` | 缩小边界内 pass | Review 流程参考 |
| Pi 扩展审计 | `D:\MyHarness\docs\pi-context-memory-audit-response.md` | v4：`verified 10/10`、mock 测试台 46/46、bash 单测 78/78、静态门 | 方法论来源（§5） |
| 政策层任务 | `D:\MyHarness\.pactile\tasks\10-04-...\review-context-memory-policy.md` | 策略函数 PASS（5/5）；native Pi bridge 未启动 | Policy Gate 规则设计输入；不改状态 |

## 3. 12 项历史问题的迁移（逐条）

“旧状态”取自 `compression-memory-rebase-report.zh-CN.md` §4；“新用途”指它在新矩阵里的位置。

| # | 旧问题 | 旧状态（保留） | 新用途 | 动作 |
| --- | --- | --- | --- | --- |
| 1 | pendingVerify 生命周期 | 旧线已闭合（六态外部校验 + 46/46 mock + 真实 `verified 10/10`）；native 线**不适用**（无 mask 执行路径） | 六态语义迁移为 CM 的 mask audit 状态：`verified / not_applied / dropped / compaction_superseded / branch_invalidated / unverified_at_shutdown` → CM-B02/B05/B11、ZT-CM-01 | 在 P0 契约中保留六态语义；1b 实现后重测 |
| 2 | compaction 生命周期 | 旧合同要求 durable 前置；native 线**OPEN**：摘要未进 session tree，重启后 transcript 与 checkpoint 不一致（B-CM-2） | CM-B09、CM-B10、HV-CM-4；决策链 S7 的 `treeEntryRef` 条件 | P0 冻结契约；1b 修复并重测（BL-13） |
| 3 | branch 生命周期 | 旧线 v4 已加 `session_before_switch/fork`；native 线**unverified**（无 fork/branch 测试） | CM-B09 / CM-B17 的 branch 变体；UV-03 | 1b 验证；P0 不声称支持 |
| 4 | silent success | 旧线因 `ReferenceError` 引入静态门；native 线发现 3 处（测试空通过、占位 hash、read-back 未比对）（B-CM-4） | CM-B06/B11、ZT-CM-02、HV-CM-1/2/6 | 1b 修复；P0 只冻结规则（BL-15） |
| 5 | fail closed | 内存层成立；durable 层 partial | CM-B05–B08、CM-B16 | 1b 补齐 durable 层 |
| 6 | unknown effect 禁止自动 replay | 语义成立；reconcile **unverified** | CM-B10、CM-B12、ZT-CM-06 | 1b 需要 reconcile 入口（BL-05） |
| 7 | 恢复后 deterministic memory.read | 旧 B3 Rapid 9/9（不同候选）；native 线 partial（未暴露为 Port 能力） | CM-B03、CM-B06、CM-B07；决策链 S10 | 1b/5 实现 Port 后重测 |
| 8 | 摘要被当成 exact fact | **OPEN（设计缺口）**：摘要以 user role 注入，无 anchor 校验 | CM-B02、CM-B11、ZT-CM-10；决策链 S9 禁止 user-role 摘要披露 | P0 契约冻结（§4 决策链 S9）；1b 移除旧注入① |
| 9 | Artifact 是否真正 durable | 已测（fsync + atomic rename）；未测 Windows 目录 fsync 与断电 | CM-B10、CM-B12、FI-19 | 1b 补断电/torn write |
| 10 | Manifest read-back | **OPEN**：只 decode，未比对 hash / revision / current artifact（B-CM-4） | CM-B08、ZT-CM-03、`context-unit-manifest-v1` §8.3 的四项比对 | 1b 修复（BL-15） |
| 11 | Receipt 与 revision/hash/epoch 一致 | 已校验 lease/epoch 与 receipt hash；但 `basisRevision`（消息条数）被当作 source revision，无 `policyVersion`/`unitManifestHash`/`evaluationRunId` 隔离 | 决策链 S6/§8；`context-unit-manifest-v1` §9.2 | 1b 按新 schema 重建 |
| 12 | stale revision / CAS conflict / missing receipt / corrupt manifest | 已有 focused tests（Node 24 边界内成立） | CM-B05/B08；FI-06/17/19 | 保留为回归来源；新 run 重测 |

① 旧注入路径指 `PactileContextPipeline` 的 summary message（user role）；其移除属于 1b 运行时任务，P0 不修改代码。

## 4. 阻断项（B-CM）与回归映射

| B-CM | 内容 | 迁移到 | owner | 解除条件 |
| --- | --- | --- | --- | --- |
| B-CM-1 | 重基线前 4 个运行时/测试改动未评审（已冻结隔离） | BL-03 / BL-17 | 用户 | 用户裁定保留/隔离/回退；裁定前不进入证据 |
| B-CM-2 | compaction 未进 session tree | CM-B09、HV-CM-4 | Compression + Host | 1b 定义并验证 `PiCompactionRecordV1` 与 tree 关系（BL-13） |
| B-CM-3 | Provider error 后无 supersession 记录 | CM-B10、决策链 S8 恢复路径 | Compression | CDR/CAR 增加 supersession 语义（BL-14） |
| B-CM-4 | read-back 未比对；占位 hash | ZT-CM-03、CM-B08 | Compression + Implementation | 1b 运行时修复（BL-15、DEF-IMPL-1） |
| B-CM-5 | 与 RunLedger/唯一 Lease 权威不一致 | CM-B18、§10.4 隔离 | Host | Host 轨道 P1/P2（BL-05）；1a 先行、1b 后置需评审接受 |
| B-CM-6 | 缺 CU/CM/anchor/policyVersion/generation schema | 本文 + `context-unit-manifest-v1` + 决策链 | Compression | P0 文档冻结 + Review |
| B-CM-7 | 无 fixture/gold/阈值 | `compression-memory-evaluation-matrix-v1` | Evaluation Controller | P0 §11 检查单全部满足（BL-12） |
| B-CM-8 | 秘密扫描策略未决 | ZT-CM-04 / §10.4 | 用户 | 冻结拒写/需确认/允许策略（BL-19） |
| B-CM-9 | 无 candidate SHA | ERM `CandidateRefV1` | 用户 | 采用 tree-hash 方案（BL-04，08 已裁定） |
| B-CM-10 | Pi 版本不一致（1.0.2 vs 1.0.4） | CM-B09、UV-03 | 用户 | 锁定版本（BL-20）；P0 只记 `unverified` |

## 5. 仍然有效的方法论（从旧审计迁移，不迁移结论）

以下来自 `pi-context-memory-audit-response.md` 的**方法**继续适用于新架构；结论本身只属于旧实现。

| 方法论 | 旧证据 | 新架构中的应用 |
| --- | --- | --- |
| 计数必须来自外部投影或 payload 校验，不能来自内部计数器 | `verified 10/10`、payload 证明 | audit 的 17 项 check 必须重读比对，不接受自报 |
| 静态检查先于计数 | v2/v3 的 `ReferenceError` → `check.sh` | 1b 起：任何 “计数” 结论前必须先通过 typecheck/lint |
| 六态分类取代汇总数字 | `verified / not_applied / dropped / compaction_superseded / branch_invalidated / unverified_at_shutdown` | CM-B02/B11 的 audit 状态词汇 |
| 故障注入测试台维护真实 Projection 并应用 edit | `test-pipeline-state.mjs` 46/46 | harness 的 HV-CM-* 与 FI-* 必须真实应用 edit，否则失败信号是噪音 |
| 令牌回显已废弃 | audit §10 | 不得再用 “模型复述 token” 作为遵守证据 |
| 阈值必须预注册，否则不做确认性 A/B | audit §11#3–4 | 矩阵 §6.2：数值阈值只在 1a 基线后设定并预注册 |
| 秘密扫描是记忆写入的硬前置 | audit §11#1 | ZT-CM-04、BL-19 |

## 6. 明确不迁移的内容

| 项 | 原因 |
| --- | --- |
| 旧 B2/B3/B4/B7 verdict | 候选不同（MyHarness `0a1dd4c3…`），无新 manifest / `evaluationRunId` |
| v65 的任何数字（18/100、5 次 compaction 等） | `unverified`、`posthoc-invalid-for-gate`、无 pre-run manifest |
| 旧 Rapid Closure 的 7/7 | 仅限缩小边界；原始全量 open/deferred |
| 旧 “严格门槛 1/4 = 25%” | 口径不沿用 |
| 旧 −17.7% token 数字 | fail-open 版本、非受控实验、无随机化 |
| 旧 40/30/25/5 加权分 | 新矩阵不用加权综合分 |
| 旧 `verified 10/10` mask | 不同实现（Pi 扩展管线），非本架构链路 |
| 旧 gold / 分母 / 豁免 | 标注者与独立性无记载（BL-12）；只能作为新 labels 的**提案来源** |
| 旧注入路径（user-role 摘要） | 与决策链 S9 冲突，属过时设计 |

## 7. 迁移规则（本线补充 `07` R-1…R-8）

| ID | 规则 |
| --- | --- |
| R-CM-1 | 引用任一旧结论时必须同时写出：候选、fixture、runId、manifest、证据路径、分母；缺项只能称 “背景证据” |
| R-CM-2 | 旧桶名/时间戳形式的 `runId` 不得复用为 `evaluationRunId` |
| R-CM-3 | 旧问题 1–12 每一项都必须在新矩阵中有对应桶或阻断项；新增桶需要评审 |
| R-CM-4 | 旧 harness 缺陷转为 HV-CM-1…6 与 FI-* 检查项，不 “顺手修好” 后沉默通过 |
| R-CM-5 | 不得为通过检查而改写旧文档摘要、gold、分母或豁免（BL-18 同类约束） |
| R-CM-6 | 发现旧证据与新结论冲突时，新报告并列保留两者，不覆盖 |
| R-CM-7 | 在 P0 离场条件满足前，任何旧 PASS 只能作为背景或候选证据 |

## 8. 迁移顺序

1. 评审 `compression-memory-rebase-report`、`context-unit-manifest-v1`、`compression-decision-chain-v1`、`compression-memory-evaluation-matrix-v1` 与本文；
2. 用户裁定 B-CM-1（冻结隔离候选）与 B-CM-4 / BL-15 的运行时修复授权窗口；
3. P0 检查单（矩阵 §11）全部满足后，才讨论 stage 1a；
4. stage 1a 起，逐条把 §3 的 12 项作为 regression case 跑通；
5. 旧证据全程只读；新结果使用新的 `evaluationRunId` 与新 manifest。

## 9. P0 明文禁止的结论（与矩阵 §10.3 一致）

- 不得把旧 Rapid、v65、focused test 或 Pi 扩展线的 `verified 10/10` 写成新架构通过；
- 不得把旧 B3 的 “injected timeout 排除” 决定迁移（新矩阵中 timeout 是一等状态，必须测）；
- 不得把本文的映射表本身当作评测证据；
- 不得因本文存在而把任何 B-CM 阻断标记为已解除。

## 10. 与 P0 离场自检表的关系（`implementation/10-p0-exit-checklist.zh-CN.md`）

| 自检表条目 | 现状 | 本线提供的内容 |
| --- | --- | --- |
| 条件 4：exact/protected 的确定性识别与禁止处置 | 自检表原为 `partial`，owner = Compression 线 | `context-unit-manifest-v1` §6.2（20 条 AnchorKind × retention × 默认 class × 允许/禁止）、§6.3（误判失败出口）、§6.2.1（命名 anchor 禁止处置汇总）、§4.2（class 唯一枚举 + PC-1…PC-5）；旧 SYNC-01 / SYNC-03 已由 CF-02 / CF-04 裁定（见 `11.1`），**不再是开放项**；本线残留仅“需独立 Review 确认”，非本线可自批 |
| 条件 5：决策链每步失败出口（含 `review_required` 落点） | 自检表原为 `partial` | `compression-decision-chain-v1` §2.12（11 字段完整性矩阵）+ **§7.6（`review_required` 完整规格：产生者 / approval_request / 批准者 / 新 admission / epoch 绑定 / 批准前禁止 / 拒绝・超时・未知效果）** |
| 条件 7：fixture / labels / 标注者 / 盲审 | `partial`（规则已冻结，值未冻结） | 矩阵 §4 的 10 项必填字段与 §4.1 fixture 清单（全部 `sha256:<pending>`）；旧 gold 只能作为提案来源（R-CM-3） |
| 条件 8：ERM / paired report / 故障注入 / 阳性对照 | `10` §1 现为 `partial`（**格式已冻结；臂定义已统一；值 / 本体未冻结**） | 矩阵 §8（FI 映射，含 FI-25…27 + FI-20.1）与 §9（HV-CM-1…6）；**KB 本体、fixture、期望输出与 hash 均未冻结**（`04` §7.1） |

文档门禁（BL-18）：`check-pactile-brand-surface` 仍失败（inventory snapshot drift、canonical contract digest mismatch、source map 缺失）；本线新增的 5 个文档（压缩目录 4 + 本目录根报告 1）会出现在 “missing source map” 列表中。这是文档层的事实，**不阻断 P0 文档本身，也不得为通过检查而改写摘要**；是否登记 source map 需用户裁定（本轮未动）。

## 11. 本轮修复映射（findings → 修改位置）

说明：仓库内**不存在独立的 Review 报告文件**（已检索 `docs/**` 与 `context-governance/**`，无 `*review*` / `*finding*` 产物）。因此本文的 findings 取自（a）本轮任务书列出的四类问题，（b）本线对 `01` / `09` / `04` / retrieval `02` 的逐行核对。每一项都附文件、章节与行号范围。**下表 “修改位置” 列中的 SYNC-xx 为历史登记号（现已由 CF-xx 裁定或闭合），不表示仍有开放冲突；当前开放项以 `11.1` 与 `compression-memory-rebase-report` §8.1 为准。**

| ID | finding | 修改位置 |
| --- | --- | --- |
| F-01 | 保护分类两套枚举并存（`exact_required/protected/pointer_only/compressible/unknown` vs `exact/protected/maskable/externalizable/lossy_eligible`） | `context-unit-manifest-v1` §4.2（唯一枚举 + 真值表 + decoder 规则）、§4.2.1、§4.2.2、§11 #18；冲突登记 SYNC-01 |
| F-02 | class 与动作许可混用（`maskable` 等被当作 class） | 同上 §4.1（`PermissionScopeV1.actions`）、PC-2、§6.2.1；SYNC-03 |
| F-03 | 20 类 anchor 的保留模式 / 默认 class / 禁止列表不完整 | §6.2（retention 列 + PC-6 单元下限 + PC-7）、§6.2.1（汇总禁止清单）、§11 #23 |
| F-04 | 误判（尤其漏判 exact）缺可执行出口 | §6.3（漏判→不得 `accepted`；`restored`/`expanded`/`review_required`/`blocked` + regression case）；矩阵 CM-B02 / CM-B25、ZT-CM-01、ZT-CM-12 |
| F-05 | `supersedes` 类型不唯一（`EntityRefV1` vs `string`） | §8.1（`EntityRefV1 \| null`）、§8.2（`resolve` + `bodyHash` + `derivedFrom`）；已按 CF-09 裁定同步 |
| F-06 | 新增字段未登记（`sourceHash` / `recoverability` / `ruleSetVersion` / `permissions` / `transcriptCursor` / `basisManifestRef` / `permissionsSummary` / durable read-back） | §8.1.1 新增字段登记表；§12.1；SYNC-09 |
| F-07 | 支撑类型无 schema 归属 / 字段表 / hash 规则 | §12.1（`PermissionScopeV1` / `FreshnessV1` / `RecoverabilityV1` / `PointerRefV1` / `MemoryPointerV1` / `RestoreTokenV1` / `CurrentManifestPointerV1` / `AnchorKind`）；SYNC-03/04/05/09 |
| F-08 | `PointerRefV1` 与 `SourcePointerV1` 关系不明，且自定义了额外字段 | §7.1（撤回`byteRange`/entryIds/`fileHashRaw`/`revision`；`memory` scheme 已按 CF-17 并入共享 `SourcePointerV1`，**不是** Compression 专用扩展）；SYNC-05 |
| F-09 | 未定义名称（`PermissionSetV1`）仍出现 | §4.1 SP-5（已废弃）；决策链 §7.1 第 5 行已改为 `PermissionScopeV1`；§11 #19 |
| F-10 | 当前清单指针可能被误读为 Kernel fact / Receipt / “已压缩”证明 | §8.4（“它不是”表）+ §11 #20 |
| F-11 | durable 四项 read-back 身份校验不显式 | §8.3（字段名对齐 `01` §4.6 的 `readBackHash` / `readBackRevision` / `currentArtifactId` + R1–R4 + 失败状态）；决策链 §7.1 #14、§8.1 |
| F-12 | `memory.read` 必须经 Host / Memory Port 的边界未复用同一处 | §7.1 PR-1/PR-2、§7.2；决策链 S10；矩阵 CM-B07 |
| F-13 | 决策链 11 项必填字段未逐项可核对 | 决策链 §2.12（完整性矩阵）+ DC-11 |
| F-14 | `review_required` 无产生者 / 批准者 / epoch / 超时 / 未知效果规定 | 决策链 §7.6（全表）+ DC-11；矩阵 CM-B24、ZT-CM-11 |
| F-15 | CAR 10 项 vs 17 项未说明合并；新 check 未登记；`pointer_reachability` 与 `pointer_readable` 双命名 | 决策链 §7.5（合并提案表 + 重命名说明）；§7.1；§7.4；SYNC-06 |
| F-16 | `wrong_dimension` / `unconvertible` / `cancelled` 可能在矩阵中被静默折叠 | `context-unit-manifest-v1` §10.1（折叠与原始状态追踪 + FD-1…FD-4）；决策链 §5.3 #7/#14/#17；矩阵 CM-B23、CM-EV-11 |
| F-17 | `drop` / `lossy_compress` 的 v1 边界未在矩阵中回归 | 矩阵 CM-B22（drop/lossy admitted → ZT-CM-09） |
| F-18 | 矩阵缺 13 项指定 fixture / negative / regression | 矩阵 §4.1（新增 8 个 fixture）、§8.1（十三项逐一映射 + `FI_MAPPING_REQUIRED`）、桶 CM-B22…B26 |
| F-19 | 可能新增全局 FI 编号 | 矩阵 CM-EV-12 + §8.1（不新增；不可映射记 `FI_MAPPING_REQUIRED`）；§6.3 ZT_CM_MAPPING_REQUIRED |
| F-20 | 两轴混写（CDR / CAR 的 verdict 与 lifecycle） | 决策链 §7.5（SYNC-07）+ §10 #19 |
| F-21 | 不可表达状态的折叠责任未写入共享契约 | §10.1 + §12.3 SYNC-11 |
| F-22 | `carryForwardUnitIds` 缺失且无 Pi 侧能力验证（BL-13） | `context-unit-manifest-v1` PC-10；决策链 §6 第 4 项、DC-12；矩阵 CM-B25；SYNC-10 |

### 11.1 与 Implementation 修复轮（CF）的对齐

本线完成本轮修复时，Implementation 线同时完成了自己的修复轮，并在 `implementation/05-writeset-rollback.zh-CN.md` §2.1 登记了 CF-01…CF-37。本线 findings 与 CF 的对应：

| finding | CF | 结果 |
| --- | --- | --- |
| F-01 / F-02 | CF-02 / CF-03 / CF-04 / CF-15 | 已裁定：唯一五值 class + `PermissionScopeV1.actions` + `scopeId` |
| F-05 | CF-09 | 已裁定：`supersedes: EntityRefV1`（本线已从早前 `string` 写法同步） |
| F-06 / F-07 | CF-10 / 11 / 13 / 14 / 16 / 18 | 已裁定：`recoverability` 取代 `reopenable`；`ruleSetVersion` 入契约；`basisManifestRef` / `permissionsSummary` 删除；`TranscriptCursorV1` 统一；RT / CMP 升为 T2 |
| F-08 | CF-17 | 已裁定：`PointerRefV1` 退役；`memory` scheme 入 `SourcePointerV1`（不参与 ABI 转换） |
| F-11 | `01` §4.6 / BL-15 | 契约侧已入字段名（`readBackHash` / `readBackRevision` / `currentArtifactId`）；**实现仍属 1b** |
| F-15 | CF-05 / CF-06 / CF-33 | 已裁定：CAR 17 项 + `review_required`；旧名 `pointer_readable` → `pointer_reachability`；CAR lifecycle = `running → <verdict>`（Q7.4.1） |
| F-16 | CF-08 / CF-21 | 已裁定：`FactStatusV1` 15 成员唯一声明；RK 用 `Exclude<…>` 折叠 |
| F-18 / F-19 | CF-23 / CF-24 / CF-26 | 已裁定：`unconvertible` → `FI-20.1`；线内计数器改前缀 `ZT-CM-*`；三层命名不互换 |
| F-20 | CF-06 | **已闭合**：CAR 三概念（lifecycle / verdict / `review_required`）见决策链 §7.4.1 与 `09` §2.4 表下注；CDR 两轴分离也已写入 `09` §2.4 表下注 |
| F-04 / F-12 / F-13 / F-14 / F-17 / F-21 / F-22 | CF-07 / CF-19 / CF-20 | 部分裁定：F-14 的契约落点 = `01` §4.14（机制属 BL-05）；`AnchorKind` 为 22 成员 T3 内联；`DisclosureRecordV1` / `MemoryReadRecordV1` 已登记为 T4，schemaId 分别为 `pactile.cg.disclosure-record` / `pactile.cg.memory-read-record`；最小 runtime bridge 已生成 Artifact 并绑定 RunLedger Context Operation，完整失败/并发/crash-replay 证据仍开放 |
| F-19（`PS.actions` 许可位集合） | CF-40 | **本线已闭合**：`context-unit-manifest-v1` §4.1 schema 块删除 `promotionRecommendation`；§4.2.2 #2 / §11 #18c 定“第五个键即 decode 失败”；promotion 建议唯一位置 = CDQ `effectClass`（§4.1 SP-4c） |
| F-11（`RestoreTokenV1` 平面字段） | CF-41 | **本线已闭合**：同文 §7.2 改为 `operationEpoch: number \| null` + `evaluationRunId: string \| null` + 平面互斥（RT-1…RT-6）；删除“只带 epoch / epoch 必填 / 评测 token 禁 epoch 字段”旧说法 |
| F-16（`unconvertible` 原生层） | CF-46 | **本线已闭合**：`context-unit-manifest-v1` §10 适用性表与 §10.1 删 `IR`，原生层统一为 SP / RC / RK / OBS / ERM / PCR（对齐 `09` §3.1 / §7 第 28 条）；**未修改 shared matrix** |
| F-16（`timeout` / `cancelled` 判定） | CF-47 | **本线已闭合**：同文 §10 新增 `timeout` 行、改写 `cancelled` 行；§10.1 FD-5 为本线唯一判定表与来源码登记处（`compression-deadline-exceeded` + `cancelled` 六值）；已删除把“上层取消”与 deadline 对立起来的反向排除表述（改用“取消源是 deadline 时仍为 `cancelled`”的正确口径） |

因此，本表（§11）的 finding 不得被读成“仍待修”——已在共享契约侧裁定或本线闭合；仍未闭合的只有 CF-15（残余在 `docs/migration/**` 与运行时 port，超出压缩线写集）、CF-25（retrieval 侧未同步）与 CF-20/CF-23 的实现与证据缺口（名称/schemaId 与 FI-20.1 编号已裁定）。旧证据降级规则（§1–§9）不受影响。

## 12. 待评审问题

1. §3 的 12 项是否都需要独立的 EC 文件，或可按桶合并（本文按桶映射，未逐项建 case）。
2. 旧 B3 的 “真实进程中断” 证据在新候选下是否允许作为 fixture **形状**参考（不迁移结果）。
3. §5 方法论的落地位置（harness 规范 vs 矩阵 §9）是否需要合并到 `04`。
4. 旧政策任务 `10-04` 的 Policy Gate 规则是否作为 v1 规则集的输入（需 Kernel 记录引用方式）。
