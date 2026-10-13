# Compression & Memory Controller：重新基线报告（REBASE_REPORT）

- 状态：proposed；本文件只是重新基线报告，不是实现、验收或发布声明。
- P0 状态（2026-10-09 更新）：本文件的拟议写集已按 `implementation/08-p0-admission-decision.zh-CN.md` 的授权冻结为 **4 份 P0 文档 + 1 份重基线报告**。2026-10-09 11:3x 起，本线 P0 文档位于 `D:\pactile\docs\architecture\context-governance\compression\`（与 `retrieval/`、`implementation/` 子目录风格对齐；`implementation/05` 建议此布局）：
  - `compression/context-unit-manifest-v1.zh-CN.md`
  - `compression/compression-decision-chain-v1.zh-CN.md`
  - `compression/compression-memory-evaluation-matrix-v1.zh-CN.md`
  - `compression/compression-memory-legacy-migration.zh-CN.md`
- 本报告 §9 早期写的 `context-governance/` 根目录路径已被上述 `compression/` 子目录取代；文件内容与文件清单不变，本报告的冻结结论不变。
- 本轮未发现运行时代码修改、真实 Pi compaction、lossy action、restore 演练、memory promotion、真实 Provider / Jev / EmbeddingGemma 调用或长跑。
- **闸门状态（2026-10-09 修复轮）**：`P0_DOCUMENT_WRITE_COMPLETE` / `P0_REVIEW_BLOCKED` / `P0_EXIT_NOT_ALLOWED` / `STAGE_1_NOT_AUTHORIZED`。本轮的定位是**修复本轮 Review 发现的契约与文档阻断（findings F-01…F-22）**，不是实现、不是 Stage 1 准入、也不代表 P0 已通过；本线能声明的最高状态是 **READY_FOR_INDEPENDENT_REVIEW**。修改后的文件与哈希见 §12。
- 角色：Compression & Memory Controller（Pi Agent 执行体，Codex 只做派发、协调、审计和汇总）。
- 日期：2026-10-09（Asia/Shanghai）。
- 依据：架构设计第 27 节，以及 `pactile-context-governance-agent-prompts.zh-CN.md` 中的提示词二。
- 本轮动作：只读审计，并写入本报告。没有执行 Pi compaction、lossy action、memory promotion、Kernel 修改或长跑，也没有调用真实 Provider/Jev/EmbeddingGemma。

## 0. 自我披露：重新基线前的越界写入

收到新指令前，本工作线仍按旧 Batch 2 目标（“接通真实 Pi SessionManager 与 Provider fail-closed”）修改了运行时代码和测试。按新规则，P0 通过前不允许修改运行时代码。下列文件保持原样：没有回滚，也没有继续修改，冻结为**未评审候选**，不计入任何 P0 证据：

| 文件 | 改动 | sha256（2026-10-09 10:26 观察） | 当前检查 |
| --- | --- | --- | --- |
| `packages/cli/src/pactile/runtime/pi-session-manager.ts` | 新增 `PactilePiSessionManagerAdapter`（结构化包装 Pi SessionManager v3，附加 binding/checkpoint） | `1001ca32c813b9ead2dec12b9be1db2f422156ebfd194ec6227aa69f53839b2c` | typecheck/eslint 通过 |
| `packages/cli/src/pactile/agent/native-agent/service.ts` | Provider error/aborted 时回滚到压缩前的内存 Context；移除未使用的私有字段 | `30ca344ccaab49397c1727835b20d7ad502383217bd15c499a241b5ea8733b48` | typecheck/eslint 通过 |
| `packages/cli/test/pactile/runtime/pi-session-manager.test.ts` | 新增 adapter 树替身测试，以及“真实 Pi SessionManager”重开测试 | `2031107e28b4b5b7b5866a07a337b208b467e5fa637b2e88063ff38048819676` | 5/5 通过 |
| `packages/cli/test/pactile/agent/native-agent.test.ts` | 新增 Provider error 回滚测试和 transcript 重启测试 | `82812bd440adafce27a06cb62e82cffadf3ec2f5d782b28f40661d7c74a0e1a7` | 3/3 通过 |

聚焦复核：上述两个测试文件加上 `context-pipeline-native`、`provider-runtime`，共 4 files / 23 tests 通过（Node 24.3.0）。这些结果只说明工作树当前可运行，不说明设计正确。§4 已列出这些改动暴露或引入的问题。这些改动是保留、回滚还是转为 P1 候选，必须由用户或 Implementation Controller 决定（见 §8）。

## 1. READ_FILES

当前依据：

- `D:\pactile\docs\architecture\pactile-dual-product-architecture-design.zh-CN.md`：第 17.1–17.7.1 节（ID、Run、Attempt、Turn、RunLedgerV1/Effect ledger）、第 18 节（durable 顺序、恢复矩阵）、第 23.3–23.5 节、第 25–26 节（阶段与阻断条件、实现审计）、第 27 节（全文）。
- `D:\pactile\docs\architecture\pactile-context-governance-agent-prompts.zh-CN.md`（全文）。
- `D:\pactile\README.zh-CN.md`。
- `D:\MyHarness\AGENTS.md`。
- `D:\MyHarness\.pactile\workflow.md`。

旧压缩与记忆任务的设计、实现、审计与评测：

- `D:\pactile\docs\migration\batch-2-context-compaction-memory.zh-CN.md`，以及本线 Batch 2 的实现文件：`agent/context-pipeline.ts`、`agent/context/compaction.ts`、`agent/memory/durability/index.ts`、`agent/session/{checkpoint,contracts}.ts`、`agent/native-agent/service.ts`、`runtime/{pi-session-manager,runtime-host}.ts`。
- `D:\pactile\docs\migration\native-agent-gap-matrix.zh-CN.md`。
- `D:\pactile\docs\architecture\pactile-pi-runtime-adapter-adr.zh-CN.md`。
- `D:\MyHarness\docs\pi-context-memory-audit-response.md`：§5.1–5.4、§9.2–9.4、§10–12。
- `D:\MyHarness\.pactile\tasks\10-04-pactile-agent-context-memory-policy\{controller-verification.md, review-context-memory-policy.md, kernel.json}`。
- `D:\MyHarness\.pactile\tasks\10-05-pactile-context-memory-evaluation\design.md`。
- 同目录下的 `summary.v58-overall-context-memory-evaluation.json`、`summary.rapid-evidence-closure-v64.json`、`summary.b4-v65-interrupted.json`、`gap-matrix.rapid-evidence-closure-v64.md`、`gap-matrix.v58-independent-review.md`、`goal-audit-rapid-v64.json`。
- Pi 1.0.2 已安装文档 `docs/session-format.md`、`docs/sessions.md`，以及 `dist/core/{session-manager,agent-session}.d.ts`。只读，用于核对 SessionManager v3 的 `appendCompaction`/`firstKeptEntryId`/`context_edit` 语义。

运行观察：2026-10-09T10:26:33+08:00 按命令行关键字（`context-memory|b4-|v65|evaluation|rapid|pi-context|10-05`）检查，没有发现旧评测进程，没有终止或重启任何进程。v65（`20261006-b4-full-100-rounds-v65`）的状态以其 summary 为准：`unverified`，18/100 settled，按用户指示中止，并已排除在 gate 之外。

## 2. OLD_SCOPE → NEW_SCOPE

| 维度 | 旧目标 | 新目标（第 27 节） |
| --- | --- | --- |
| 角色 | Batch 2 实现者：直接打通 cut-point → summary → artifact → manifest CAS → receipt → checkpoint → Context 替换 | Compression & Memory Controller：只提交 `CompressionDecisionRequest`，不拥有授权、事实或副作用 |
| 授权点 | `ContextMemoryDurability.authorizeCompaction()` 和 `PactileContextPipeline` 自行决定 compact | Host 侧确定性 Policy Gate + EffectGateway；Controller 只提供输入 |
| 下一步 | 接真实 Pi SessionManager、真实 Provider、`pactile agent run`、并发与重启 | 先冻结 P0：ContextUnit/Manifest schema、决策链状态机、receipt 映射、fixture/gold/negative、评测矩阵；P0 通过前不写运行时代码 |
| 身份 | `runId` 混用：旧评测把 `20261006-…` 当作 runId；compaction receipt 只有 runId/contextOperationId | 产品 `runId`、上下文 `contextOperationId`、离线 `evaluationRunId` 三者分离，通过 Manifest/causation 关联 |
| Receipt | memory receipt、compaction receipt 写在 Runtime Store SQLite 的 memory audit 表 | 作为 RunLedger/Effect Receipt/Artifact Manifest/Kernel Evidence 的 typed payload；禁止形成第二套 Receipt authority |
| Lease | Runtime Store `acquireLease` 为 memory partition 做 fencing | Lease/Epoch 的唯一权威是 `RunLedgerCoordinator`（第 23.3.1、26.3 节） |
| 披露 | 摘要以 user-role 消息注入，携带 `memory://` 指针 | disclosure 指向 durable manifest 的 pointer；恢复只走 Host/Memory Port 的 deterministic `memory.read` |
| Jev/Embedding | 不在旧线范围 | 仅 advisory shadow；需定义降级规则 |
| 评测 | 旧 Goal：B0–B8；真实 GPT/DeepSeek/GLM；100 轮长跑；Rapid Evidence Closure | 先定 fixture hash、gold/negative 和预注册阈值，所有结果绑定 `evaluationRunId`；不重启长跑 |
| Promotion | 计划“最后开启” | 只能走 Kernel command/approval/evidence；本线不提交 |

## 3. 仍然有效的事实（有证据）

1. Context 替换受完整链约束：`PactileContextPipeline.#record()` 只在 artifact → memory receipt → manifest CAS → snapshot → checkpoint → audit receipt 全部成功后才返回新 Context；checkpoint、audit 或 memory 失败时，返回 `unknown`/`blocked` 并保留旧 Context。证据：`context-pipeline-native.test.ts`（2 tests），以及 Batch 2 记录中的 focused 7 files / 91 tests。
2. 失败结果统一携带 `reexecute:false`、`replayPolicy:"no_automatic_replay"`；tool 出错时 effect 记为 `unknown`。
3. SQLite RuntimeStore 在 `BEGIN IMMEDIATE` 写事务内复核 lease 的 owner/epoch/expiry/partition。已覆盖 stale CAS、并发 CAS、duplicate replay、artifact missing recovery 和 corrupt manifest（返回 `memory_manifest_corrupt` + `effect:"unknown"`），仅在 Node 24.3.0/SQLite 3.50.1 上验证。
4. FileArtifactStore 只写 canonical `.pactile/` 路径：fsync + atomic rename + hash 校验，拒绝 `.pactile/` 之外的路径（24 tests）。
5. cut-point 只选已闭合的 turn 边界；未配对的 tool call 不能作为 cut-point；mask 只替换 payload，并在 payload hash 过期时拒绝（6 tests）。
6. 旧 Pi 扩展线留下的结论继续有效：计数必须来自外部投影或 payload 校验，不能来自内部计数器；静态检查必须先于计数；令牌回显已废弃（`pi-context-memory-audit-response.md` §9.3、§10）。
7. 旧评测 Rapid Evidence Closure v1 只在缩小边界内通过：B3 run-scope 9/9（包含一次真实进程中断）、B4 25 轮、B7 单一 GPT seam。原始全量目标仍是 open/deferred，严格门槛 1/4（25%）。

## 4. 历史问题核查（保留结论 + 当前状态）

| # | 问题 | 旧结论与出处 | Pactile native 线当前状态 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | pendingVerify 生命周期 | v3 在 `session_compact` 清空 pending/ready/pendingVerify，被审计判定为“把 bug 转成统计”；v4 改为外部校验六态（`verified/not_applied/dropped/compaction_superseded/branch_invalidated/unverified_at_shutdown`），`not_applied/dropped` 时 halt 并排队 restore（audit-response §5.1#8、§9.2#5–7；mock 测试台 46/46；真实运行 verified 10/10） | native 没有 mask 执行路径（pipeline 遇到 maskable 时返回 `mask_required` blocked），因此没有 pendingVerify 等价物 | 旧结论保留；native **unverified / 不适用**。P0 必须把六态迁移为 ContextUnit mask 的 audit 状态 |
| 2 | compaction 生命周期 | 旧合同：compaction 前必须先完成 durable artifact/manifest/hash/权限/epoch/receipt/disclosure | （a）checkpoint 失败时不替换 Context（已测）。（b）**新发现**：摘要消息没有写入 session transcript，也没有使用 Pi `appendCompaction`/`firstKeptEntryId`；重启后 transcript replay 得到压缩前的完整历史，而 checkpoint 记录的是压缩后 snapshot hash，两者在重启后不一致。（c）**新发现**：§0 的回滚补丁在 Provider error 后恢复内存 Context，但已提交的 compaction receipt 和 checkpoint 仍指向压缩后 snapshot，也没有 supersession/rollback receipt | **OPEN（阻断）**：生命周期在 durable 层没有闭合 |
| 3 | branch 生命周期 | v4 新增 `session_before_switch/fork`，使 branch-bound 状态失效 | `FilePiSessionManager` 是线性的；adapter 读取 `buildSessionContext()`（active leaf），但 branch/fork/navigateTree 均未测；checkpoint 不绑定 `branchLeafEntryId` | **unverified** |
| 4 | silent success | v2/v3 的 `ReferenceError` 导致虚假遮罩计数，因此增加静态门 | 新发现 3 处：（a）“真实 Pi SessionManager”测试在包缺失时直接 return，导致空通过；且实际使用全局安装的 pi-coding-agent **1.0.2**，与 provenance 中 pinned 的 1.0.4 不一致。（b）`checkpointWriterFromPiSession` 在缺少 snapshot hash 时写入 `sha256:000…` 占位值。（c）Manifest read-back 只做 decode，见 #10 | **OPEN** |
| 5 | fail closed | 旧策略层：missing/pending/unknown/malformed 返回 `blocked/assurance_unknown` | memory/audit/checkpoint/summary/measure 失败都不替换 Context（已测）；回滚补丁让 Provider error 也不保留压缩后 Context（已测，但 durable 层未闭合，见 #2c） | 内存层成立；durable 层 **partial** |
| 6 | unknown effect 禁止自动 replay | 架构第 18.3、23.3 节 | replayPolicy 已标注；没有 reconcile API，也没有 effect intent/receipt 与 RunLedger 的合流 | 语义成立；reconcile **unverified** |
| 7 | 恢复后 deterministic memory.read | 旧 B3 Rapid：run-scope 9/9，含真实中断（`verification.rapid-b3-v61-run-scope.json`）；绑定 MyHarness 候选 `0a1dd4c…` | native：重开 store 后 `preflight({disclose:true})` 校验通过（1 test）；`memory.read` 尚未作为 Host/Memory Port 的 Protocol 能力暴露，Agent 恢复后也没有经 Port 读取 | 旧证据**不可直接迁移**（候选不同）；native **partial** |
| 8 | 摘要被当成 exact fact | 合同：摘要是模型可见投影，不是事实源 | 摘要以 **user role** 注入，模型可能把它当作用户指令或事实；没有 exact/protected anchor 保留校验；summarizer 只是测试实现 | **OPEN（设计缺口）** |
| 9 | Artifact 是否真正 durable | 旧：不可变 JSON + fsync + atomic rename | 同上，已测；未测 Windows 目录 fsync 和断电 | durable（在已测边界内） |
| 10 | Manifest 是否经过 read-back | — | CAS 后执行 `readCurrent` + decode；**没有**断言 persisted manifest 与刚写入的 manifest 在 hash、revision 和 current artifact 上一致；并发写入者推进 manifest 后，仍可能返回成功（`durability/index.ts` 约 2885–2913 行） | **OPEN** |
| 11 | Receipt 与当前 revision/hash/epoch 一致 | — | 已校验 lease epoch/owner 和 receipt hash；但 `committedSourceRevision = cutPoint.basisRevision`（消息条数），不是工作树 source revision/generation；没有 `policyVersion`、ContextUnitManifest hash 或 `evaluationRunId` 隔离 | 不满足新 schema |
| 12 | stale revision / CAS conflict / missing receipt / corrupt manifest | — | SQLite/FileArtifactStore focused tests 覆盖（见 §3.3）；missing receipt 返回 unknown | 成立（仅 Node 24） |

## 5. 已过时的假设

1. 在 Pipeline 或 durability port 内授权 compaction。现在必须由 Host Policy Gate 授权。
2. 用 Runtime Store 的 memory audit/lease 表作为 compaction receipt 与 fencing 的权威。现在必须挂到 RunLedger 和唯一 Lease 权威上。
3. 由 `summaryMessage`（user role）充当 disclosure。现在必须使用 manifest pointer + `memory.read`。
4. 在 P0 前接真实 Pi SessionManager、Provider 和 CLI。现在冻结到 P0 之后。
5. 旧评测的 runId 命名和 40/30/25/5 加权分。新 gate 不采用，旧结果只作历史证据。
6. 旧 MyHarness 候选 `0a1dd4c…` 的通过结果可以代表 `D:\pactile` 代码。实际上候选不同，`D:\pactile` 的 `develop` 还没有提交，必须改用文件 hash/candidate snapshot 绑定。
7. 把 `basisRevision`（transcript 消息序号）视作 source revision。它只是 transcript cursor，必须与工作树 sourceRevision/generation 分开。

## 6. 未验证结论（不得写成 pass）

- 真实 Pi SessionManager v3 的 tree/branch/fork 与 Pactile checkpoint 的互操作。当前只有 1.0.2 版本、可能空通过的测试。
- 真实 Provider stream、abort 和 timeout 下的 compaction 链；Node 22 的 `node:sqlite`。
- 重启后 transcript 与 checkpoint snapshot 的一致性（已知不一致，见 §4#2b）。
- 多 run 并发、duplicate request、半写入恢复、unknown effect reconcile。
- 净 token/延迟收益：旧 −17.7% 来自 v1 fail-open 版本，非受控实验，fail-closed 版本未测。
- 旧 B4 100 轮稳定性、跨 Provider action 可靠性（v56 DeepSeek/GLM Connection error 仍保留）、B8 全量结算。
- 宿主侧秘密扫描（旧审计列为记忆管线实装的硬阻塞，至今未决）。

## 7. CURRENT_EVIDENCE（路径）

- Native 实现与测试（`D:\pactile`，未提交、无 SHA）：`packages/cli/src/pactile/agent/{context-pipeline.ts, context/compaction.ts, memory/durability/index.ts, session/*, native-agent/service.ts}`、`packages/cli/src/pactile/runtime/{pi-session-manager.ts, runtime-host.ts, file-artifact-store.ts, sqlite-runtime-store.ts}`；测试位于 `packages/cli/test/pactile/{agent,runtime}/` 与 `packages/cli/test/core/pactile/context-memory/`。
- Batch 2 记录：`docs/migration/batch-2-context-compaction-memory.zh-CN.md`（sha256 `1ca674ddc873b835684daa6adc312f1f8e5b524b8dab9d4c0b49eac0a0e5e393`）。
- 旧评测：`D:\MyHarness\.pactile\tasks\10-05-pactile-context-memory-evaluation\`。相关文件包括 `goal-audit-rapid-v64.json`、`summary.v58-overall-context-memory-evaluation.json`、`verification.rapid-b3-v61-run-scope.json`、`verification.rapid-b4-v61-25-rounds.json`、`verification.rapid-b7-v60-gpt.json`、`verification.independent-review-v63-rapid.json`、`verification.b4-v65-interrupted.json`。
- 旧策略：`D:\MyHarness\.pactile\tasks\10-04-pactile-agent-context-memory-policy\review-context-memory-policy.md`（PASS 仅覆盖策略函数，并注明 native Pi bridge 未启动）。
- 旧机制审计：`D:\MyHarness\docs\pi-context-memory-audit-response.md`。
- Pi provenance：`docs/migration/native-agent-provenance.json`（pi-agent-core 1.0.4，upstream commit `27c7b6ff…`）。本机全局 pi-coding-agent 为 1.0.2。

## 8. BLOCKERS

1. **B-CM-1**：§0 的越界写入需要决策（保留冻结 / 回滚 / 转为 P1 候选）。在决策前，它们不进入任何证据或 Review。
2. **B-CM-2**：compaction 没有进入 durable session tree；重启后 transcript 与 checkpoint 不一致（§4#2b）。
3. **B-CM-3**：Provider error 后内存已回滚，但 durable receipt/checkpoint 没有 supersession 记录（§4#2c）。
4. **B-CM-4**：Manifest read-back 没有做身份比对（§4#10）；checkpoint 写入 `sha256:000…` 占位值（§4#4b）。
5. **B-CM-5**：现有 receipt、lease 和 audit 表与 RunLedger/唯一 Lease 权威不一致（第 26.3 节：Run 权威分裂、Lease 权威重复），存在形成第二套 Receipt/Lease authority 的风险。
6. **B-CM-6**：缺少 ContextUnit、ContextUnitManifestV1、exact/protected anchor、`policyVersion`、generation 和 `evaluationRunId` 的 schema；摘要以 user role 注入（§4#8）。
7. **B-CM-7**：没有 fixture registry、gold/negative labels、预注册阈值或停止条件（旧审计 §11#3–4 同样未决）。
8. **B-CM-8**：宿主侧秘密扫描策略（拒写还是需确认）未决，阻断任何 memory 写入管线。
9. **B-CM-9**：`D:\pactile` 无提交，无法提供 candidate SHA；证据只能用文件 hash 加 candidate snapshot 绑定，格式需要在 P0 冻结。
10. **B-CM-10**：Pi coding-agent 版本未锁定（已安装 1.0.2，provenance 为 1.0.4）。真实 Pi compaction/SessionManager 证据必须先锁定版本。

### 8.1 共享契约同步状态（CF 对齐；完整表见 `compression/context-unit-manifest-v1.zh-CN.md` §12.3）

本线原提的 SYNC-01…SYNC-11 已被 Implementation 修复轮（`implementation/05-writeset-rollback.zh-CN.md` §2.1 的 CF-01…CF-37）逐项裁定或部分裁定；本线不再提异议。

| 本线 ID | 内容 | CF | 状态 |
| --- | --- | --- | --- |
| SYNC-01 | `protection.class` 两套枚举 | CF-02 | 已裁定（唯一五值枚举） |
| SYNC-02 | `supersedes` 类型 | CF-09 | 已裁定（`EntityRefV1`；本线已同步） |
| SYNC-03 | `PermissionScopeV1` 三种形状 | CF-04 / CF-15 | 已裁定（唯一形状 `09` §1.2.1；`scopeId` 唯一） |
| SYNC-04 | `FreshnessV1` 形状与包装 | — | 已裁定（`01` §3.6 / `09` §1.2.2；不外包 `ObservedV1`） |
| SYNC-05 | pointer 类型与 `memory` scheme | CF-17 | 已裁定（`PointerRefV1` 退役；scheme 入 SP） |
| SYNC-06 | CAR 10 vs 17；`review_required`；`failed` | CF-05 / CF-06 / CF-33 | **已闭合**：17 项 + 7 值 verdict；CAR lifecycle = `running → <verdict>`；`failed` 已删除，唯一映射 = `assurance_unknown`；lifecycle / verdict / `review_required` 三关系见决策链 §7.4.1 |
| SYNC-07 | verdict 与 lifecycle 两轴 | CF-06 | **已闭合**：CAR 三概念已写入决策链 §7.4.1 与 `09` §2.4 表下注；CDR 两轴分离也已写入 `09` §2.4 表下注 |
| SYNC-08 | `reason.code` 的 `compression-*` 枚举 | — | **已闭合**：共享折叠码 = `cg-wrong-dimension`（`09` §3.2.2 唯一登记）；线内诊断码保留 `compression-*`；非 `cg-` 前缀的折叠码一律非法 |
| SYNC-09 | 新增字段与支撑类型归属 | CF-10 / 11 / 13 / 14 / 16 / 18 | 已裁定（除 `carryForwardUnitIds`） |
| SYNC-10 | `carryForwardUnitIds` 与 Pi 适配层 | — | **仍开放**（Host 轨道 / 1b） |
| SYNC-11 | 不可表达状态的折叠责任 | CF-21 | 已裁定 |

本轮新增、仍需 Implementation Controller 处理的线内项：`CF-20` 的 `DisclosureRecordV1` / `MemoryReadRecordV1` T4 登记；`ZT-CM-*` 计数器与 `03` §1.2 的归并（CF-24）。

## 9. PROPOSED_WRITE_SET（仅文档/契约/评测计划，P0 用；获确认前不写）

全部位于 `D:\pactile\docs\architecture\context-governance\`：

1. `compression-memory-rebase-report.zh-CN.md`：本文件（已写）。
2. `context-unit-manifest-v1.zh-CN.md`：ContextUnit、ContextUnitManifestV1、pointer、source cursor、exact/protected anchor、mask、externalize、structured projection、restore token、CompressionJudgment、CompressionDecisionRequest/Receipt、CompactionAuditReceipt 的字段表（含 schemaVersion、unitId、contextOperationId、runId、evaluationRunId、sourceRevision、generation、policyVersion、manifestHash、sourceHash、permissions、freshness、recoverability、provenance、createdAt），以及 content class 处置表（原文 / pointer / mask / externalize / projection / lossy / block / review）。
3. `compression-decision-chain-v1.zh-CN.md`：11 步决策链的状态机与时序，逐步列出输入、输出、成功/失败状态、可重试性、可恢复性、receipt、manifest、hash、operationEpoch 和 audit evidence；Jev/Embedding 的 9 个 action 与降级矩阵；post-compaction audit 比较项和允许出口；`memory.read` 前置校验；receipt 作为 RunLedger/Effect Receipt/Artifact Manifest/Kernel Evidence typed payload 的映射与反证条款。
4. `compression-memory-evaluation-matrix-v1.zh-CN.md`：20 个评测桶的 fixture/hash 注册格式、gold/negative label 规则（标注者、盲审、修订记录）、paired comparison、故障注入点、预注册阈值与停止条件、`evaluationRunId` 隔离测试、证据格式。
5. `compression-memory-legacy-migration.zh-CN.md`：把 §4 的旧问题迁移为 P0 regression case；把旧 B0–B8 证据标为“历史、不同候选、不可迁移”的映射。
6. 可选：在 `docs/migration/batch-2-context-compaction-memory.zh-CN.md` 顶部追加一行状态说明，指向本报告，说明 Batch 2 已冻结并重新基线；原文与证据不删除、不改写。

不在写集内：任何 `packages/**` 源码或测试、`D:\MyHarness` 内的文件、全局配置、lockfile、gold 文件或旧证据。

## 10. HIGH_IMPACT_ACTIONS_REQUIRING_AUTHORIZATION

1. 处置 §0 的 4 个运行时/测试改动（保留冻结、回滚或转为 P1 候选）。回滚属于破坏性操作，需要明确授权。
2. 任何运行时代码修改（P1 起），包括修复 B-CM-2/3/4。
3. 锁定或升级 Pi coding-agent 版本，改动 lockfile 或安装依赖。
4. 执行真实 Pi compaction、lossy action 或 restore 演练。
5. 调用真实 Provider、Jev 或 EmbeddingGemma（数据外发与成本）；续跑或新启长跑（包括 v65 类 100 轮）。
6. memory promotion、scope 变更或 Kernel command。
7. 宿主侧秘密扫描策略决策（拒写还是需确认）。
8. 预注册质量回退、重读增量和零容忍项的阈值与停止条件。
9. Retention/purge 策略（当前无自动删除；immutable artifact 永久保留不等于 retention 已完成）。

## 11. NEXT_GATE（P0：Contract & Evaluation freeze）

进入 P0 文档写作需要满足：用户或 Implementation Controller 确认 §9 写集，并对 §10#1 作出决策。

P0 通过条件（全部满足才能讨论 P1）：

1. §9 第 2–5 项文档完成，并通过独立 Review；每个实体都有字段表、版本、hash 规则、provenance，并把 `unknown/stale/missing/permission_denied/revision_mismatch/epoch_mismatch` 作为一等结果。
2. 列出的 exact/protected 内容类别（用户目标、约束、工作树路径、文件路径、symbol、行号、hash、revision、版本号、端口、URL、JSON、patch、tool call ID、测试断言、错误码、配置值、失败方案及原因、Evidence 原文、权限与 scope）都有确定性的识别规则和禁止处置清单。
3. 决策链中的每一步都有失败出口，且不存在“失败但继续”的路径；Pi 的摘要、token 节省、confidence、压缩率和“已保留/不重要”判断都被明确排除在 Kernel fact/Evidence 之外。
4. Receipt 映射证明 RunLedgerV1 仍是唯一 Attempt/Effect/Receipt/Settlement 权威，并给出现有 SQLite memory audit 表的迁移或降级方案。
5. 评测矩阵的 fixture 有 hash，gold/negative label 有来源与盲审规则，阈值预注册，`evaluationRunId` 隔离测试设计完整，§4 的 OPEN 项都转成 regression case。
6. 三条线都给出 `READY_FOR_P0` 后，由 Implementation Controller 汇总依赖、写集、fixture/hash 和 Review 入口。

## 12. 本轮修复轮的文件与哈希（本轮写集）

本轮只修改以下 5 个文件；**未修改** `implementation/**`、`retrieval/**`、`docs/migration/**`、`packages/**`、运行时代码、Memory Port、Pi runtime、Provider 配置、lockfile、gold、评测结果；**未执行**真实 Pi compaction、lossy action、restore、memory promotion 或长跑；**未进入** Stage 1。

| 文件 | 行数 | sha256 |
| --- | --- | --- |
| `compression/context-unit-manifest-v1.zh-CN.md` | 604 | `d6b639e91907fa7176b74e5d66e8d60ac84df071bcb1be2166b3583728308759` |
| `compression/compression-decision-chain-v1.zh-CN.md` | 592 | `6a851bd36dfe533ad495dc5d06d598832c0c95e252d847f5f4ace4a7afd676c6` |
| `compression/compression-memory-evaluation-matrix-v1.zh-CN.md` | 322 | `49081b43af7fb1cf4778a8f5932e29ae4de4e5c03221975a6e4236c0bcae948e` |
| `compression/compression-memory-legacy-migration.zh-CN.md` | 185 | `b6f8a8d669cf729df60a1075cd77250028d511eec62ba6f9b5f6c8b185283804` |
| `compression-memory-rebase-report.zh-CN.md`（本文件） | 见回执 | 自身哈希随本轮回执报告 |

受限运行环境侧事实（本轮观察）：

- 4 个冻结的运行时 / 测试候选文件哈希与重基线时一致（`pi-session-manager.ts` `1001ca32…`、`native-agent/service.ts` `30ca344c…`）；
- `packages/**` 在过去 40 分钟内无任何 `.ts/.js/.json` 写入；
- `implementation/**` 与 `retrieval/**` 在 13:45–13:47 被其它线并发更新（本线只读），因此本报告引用的 CF 编号以 `implementation/05-writeset-rollback.zh-CN.md` §2.1 为准；若它们再次变动，Review 时必须重新核对 CF 裁定状态。

未验证项（不得写成 pass）：

- 无独立 Review 产物：仓库内不存在独立的 Review 报告文件；§11 的 findings 来自任务书与本线逐行核对，**不等于**独立复审结论。
- `Kernel Evidence`、`RunLedgerV1`、EffectGateway、Policy Gate、`memory.read` Port 均**未实现**（BL-05）；本报告不声称任何 receipt 已产生。
- Pi 版本仍不一致（本机 1.0.2 vs provenance 1.0.4）；真实 Pi compaction / SessionManager tree / branch / fork 仍为 `unverified`（BL-20、UV-03）。
- 所有 fixture / gold / `fixtureHash` / `caseSetHash` 仍为 `sha256:<pending>`；未伪造任何真实 hash。
- `reason.code` 的 `compression-*` 枚举、`carryForwardUnitIds` 字段表、`DisclosureRecordV1` / `MemoryReadRecordV1` 的 T4→T2 登记均仍开放（§8.1）。
