# Implementation Controller 重新基线报告（REBASE_REPORT）

- 状态：proposed。本文件是基线报告，不是 P0 产物、实现、验收或发布声明。
- 角色：Implementation Controller（Pi Agent 执行体；Codex 只做派发、协调、审计和汇总）。
- 日期：2026-10-09（Asia/Shanghai）。
- 本轮动作：只读审计，加上写入 `docs/architecture/context-governance/implementation/` 下的文档。没有修改运行时代码、Provider、Worker、gold、分母或旧证据；没有启动评测、索引、compaction 或 promotion；没有终止或重启任何进程；没有读取凭据。
- 身份：本报告产生于 `contextOperationId` 之外的**文档线**，不是产品 Run，也不是 Evaluation Run；不携带 `runId`，也没有 `evaluationRunId`。

## 0. 自我披露：重新基线前的运行时写入

收到新指令前，本工作线（Implementation）仍按旧目标“Session/Checkpoint → Effect Receipt → `pactile agent run`”修改了运行时代码。按新规则，P0 通过前不允许修改运行时代码。这些改动**没有回滚，也没有继续修改**，自此冻结为**未评审候选**，不计入任何 P0 证据。

同一批文件还被 Compression & Memory 线在重新基线前改过（其报告 `compression-memory-rebase-report.zh-CN.md` §0 自行披露：`pi-session-manager.ts` 的 `PactilePiSessionManagerAdapter`、`service.ts` 的 Provider-error 回滚、两个测试文件）。两份披露中的哈希互相吻合（`service.ts` `30ca344c…`、`pi-session-manager.ts` `1001ca32…`），所以**同一组文件上有两条工作线交错写入**，所有权不清（见 BL-17）。

本线写入的冻结候选（sha256 前 16 位，2026-10-09 10:3x 用 `Get-FileHash` 观测；`develop` 无提交，只能用文件哈希锚定）：

| 文件 | sha256[0:16] | 本线改动 |
| --- | --- | --- |
| `packages/cli/src/commands/agent.ts` | `a56e16aa851e1ae3` | **新建**：`pactile agent run` 组合入口，含 `--loopback` 假 Provider |
| `packages/cli/src/cli/index.ts` | `a91f1af431e9a2d9` | 注册 `agent` 子命令（用户可见命令面） |
| `packages/cli/src/pactile/agent/effects/contract.ts` | `512e1e0ee1707bdf` | **新建**：Effect intent/receipt port |
| `packages/cli/src/pactile/agent/session/contracts.ts` | `8e8024124f28faec` | **新建**：Agent 会话绑定与 transcript port |
| `packages/cli/src/pactile/agent/session/index.ts` | `6725d67aa288d168` | barrel 增加导出 |
| `packages/cli/src/pactile/agent/index.ts` | `6ed11cf617fb35b9` | barrel 增加导出 |
| `packages/cli/src/pactile/agent/context-pipeline.ts` | `5d460294f19f0813` | checkpoint 写入后记录 snapshot |
| `packages/cli/src/pactile/agent/native-agent/contract.ts` | `15b14f54bb20d9a2` | Agent 选项增加 session/effectReceipts/runId/operationEpoch |
| `packages/cli/src/pactile/agent/native-agent/service.ts` | `30ca344ccaab4939` | 接入会话绑定、transcript 持久化、effect 准入与回执（含 Compression 线的回滚补丁） |
| `packages/cli/src/pactile/runtime/effect-receipts.ts` | `1e5708e12dbd7e46` | **新建**：RuntimeStore 支撑的 effect 回执 port 实现 |
| `packages/cli/src/pactile/runtime/index.ts` | `5ed2cb0aeffd667b` | barrel 增加导出 |
| `packages/cli/src/pactile/runtime/pi-session-manager.ts` | `1001ca32c813b9ea` | binding 旁路文件、transcript、`advanceOperationEpoch`（含 Compression 线的 adapter） |
| `packages/cli/src/pactile/runtime/store-port.ts` | `f8ad8cafd307c263` | `putEffect` 增加可选 lease proof |
| `packages/cli/src/pactile/runtime/stores/sqlite/repository.ts` | `e96450f0b1285b6e` | `putEffect` 在写事务内校验 lease proof |
| `packages/cli/test/pactile/agent/native-agent.test.ts` | `82812bd440adafce` | 含两条线的测试 |
| `packages/cli/test/pactile/runtime/pi-session-manager.test.ts` | `2031107e28b4b5b7` | Compression 线的测试 |

候选身份（tree hash，按路径排序后对 `路径 + 文件sha256` 行取 SHA-256，共 16 个文件）：`sha256:5997626548a43627a8da782ba7a82571c3e8b2ec7396ed0e522b576d884b48ed`。这只是现状快照，不是 `candidateSha`（见 BL-04）。

**现状检查（本线 2026-10-09 10:3x 实测）**：`pnpm --filter @blxzer/pactile typecheck` exit 0；`pnpm --filter @blxzer/pactile lint` exit 0。Retrieval 线报告里的阻断 B8（lint 在 `effects/contract.ts`、`native-agent/service.ts`、`session/contracts.ts` 失败）在这个时点已不成立。这两个结果只说明工作树当前可编译、可通过静态检查，**不说明设计正确**，也不构成 P0 证据。

### 0.1 本线对自身候选的只读自审（未修复，仅记录）

| ID | 发现 | 证据 | 与新规则的冲突 |
| --- | --- | --- | --- |
| DEF-IMPL-1 | `checkpointWriterFromPiSession` 在缺少 snapshot hash 时写入 `sha256:` + 64 个 `0` 的占位值 | `context-pipeline.ts:695`（`grep` 复核） | 静默成功：应返回 `unknown`/`missing`，不能写入占位 hash |
| DEF-IMPL-2 | `PactileRuntimeEffectReceiptPort` 用 RuntimeStore `putEffect` 作为 effect 回执权威；`commands/agent.ts` 用 `putRun` 创建 `RuntimeStoreRun` | `effect-receipts.ts`、`agent.ts` | 复制了架构 §26.3 点名的“Run 权威分裂”：`RunLedgerV1`/`EffectGateway` 才是目标权威 |
| DEF-IMPL-3 | `agent.ts` 在 `errorMessage === undefined` 且 effect 已知时把 Run 记为 `completed` | `agent.ts`（`status` 推导） | “agent_end/idle 不是 settlement”：Controller 级结果被写成 completed，没有 Kernel evidence/gate/settlement |
| DEF-IMPL-4 | 工具无异常返回即写 `status:"succeeded"`、`assurance:"assurance_exact"` | `service.ts` `afterToolCall`、`effect-receipts.ts` | “只有 receipt 能证明已知结果”：返回值不等于已验证 effect，`exact` 过强 |
| DEF-IMPL-5 | 会话绑定写在 `<session>.jsonl.binding.json` 旁路文件，不与 JSONL 追加同一事务；与 `SessionRegistryV1` 的 binding 重复 | `pi-session-manager.ts` | 第二份 binding 权威；transcript 追加与 binding 写入之间崩溃会不一致 |
| DEF-IMPL-6 | `pactile agent run` 已注册为用户可见命令，但**从未被端到端执行**；只有单元级测试 | `cli/index.ts`；本线没有任何 `agent run` 执行记录 | 发布计划写明“尚未宣称 `agent run` 可用”；该命令面没有评审、没有 E2E、没有文档 |

未验证：新增的 `agent` 子命令是否影响现有 CLI 帮助/文档契约类测试——本线没有在加入命令后重跑全量测试（此前全量 `pnpm test` 本来也没有 PASS：300 秒超时，`pi-independent-review` 取消断言失败）。

**处置选项（需要用户决定，见 §9#1）**：(a) 原样冻结，作为 pre-P0 候选，在阶段 1 Review；(b) 隔离为单独补丁；(c) 回退。因为 `develop` 没有提交、所有文件都是 untracked，回退没有 git 基线可依赖，必须先做只读快照（见 `05-writeset-rollback.zh-CN.md` §4）。

## 1. READ_FILES

必读依据（sha256 前 16 位，本线重算）：

| 文件 | 大小(字节) | sha256[0:16] |
| --- | --- | --- |
| `D:\pactile\docs\architecture\pactile-dual-product-architecture-design.zh-CN.md`（1702 行；重点 §17.7.1、§23.3–23.5、§24–26.3、§27 全文） | 106788 | `804b7c6cd5f39dad` |
| `D:\pactile\docs\architecture\pactile-context-governance-agent-prompts.zh-CN.md`（209 行） | 16851 | `40a5ae656419800b` |
| `D:\pactile\README.zh-CN.md`（135 行） | 9285 | `5f3feeca91ca2d46` |
| `D:\MyHarness\AGENTS.md`（61 行） | 5565 | `80a0f03f1951f605` |
| `D:\MyHarness\.pactile\workflow.md`（63 行） | 4995 | `1057840e96a4d4dc` |

这五个哈希与 Retrieval 线报告 §1 记录的前 16 位逐项一致。

补充读取（只读）：

- 仓库：`D:\pactile\AGENTS.md`、`docs/pactile/documentation-map.md`、`docs/migration/{native-agent-gap-matrix, migration-batches, native-agent-release-plan, retrieval-worker-d25d33, batch-2-context-compaction-memory}.zh-CN.md`。
- 另外两条线的重新基线报告：`context-governance/retrieval/00-rebase-report.zh-CN.md`、`context-governance/compression-memory-rebase-report.zh-CN.md`。
- 旧评测证据：`D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json`；`D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408\{summary,verification,manifest}.json` 与 `harness-failures.md`；`D:\MyHarness\.tmp\retrieval-worker-evaluation\{exact-02-…-d25d33, lifecycle-04-20261007-190100, p6-budget-fault-06-20261007-183546-final}` 的文件清单；`D:\MyHarness\.pactile\tasks\10-04-pactile-retrieval-worker\{verification,evaluation-plan}.md`；`D:\MyHarness\.pactile\tasks\10-05-pactile-context-memory-evaluation\{b2-summary-v14, summary.rapid-evidence-closure-v64, summary.b4-v65-interrupted, goal-audit-rapid-v64}.json`、`run-manifest-v65-…-interrupted.json`、`gap-matrix.rapid-evidence-closure-v64.md`；`D:\MyHarness\.pactile\tasks\10-04-pactile-agent-context-memory-policy\kernel.json`。
- 代码（只读）：`packages/cli/src/pactile/{agent,runtime,retrieval,decision}/**` 的导出面与本线冻结候选。

**未找到**：EmbeddingGemma 调研产物。在 `D:\MyHarness\{.pactile,docs,scratch}`、`D:\pactile\docs`、`packages/cli/{src,test}` 中不截断地检索 `embeddinggemma|embedding-gemma|embedding gemma`，只命中 4 个文件：架构文档、提示词文件，以及两条线自己刚写的重新基线报告。**没有调研产物**。（对 `D:\MyHarness\.tmp` 和整盘文件名检索未在时限内完成，因此“不存在”**未被证明**，只能记为 unverified，见 BL-02。）

## 2. 架构 §27 对各部分新增的要求（逐项摘录）

| 主题 | §27 / §27.9 新增要求 | 当前代码/文档状态 |
| --- | --- | --- |
| Workspace Agent Host | §27.2：Context Governance 是 Host 内的 bounded context。Coordinator 下挂 Retrieval Controller（+Workers）、Compression Controller（+ContextUnitizer）、Evaluation Controller / Experiment Runner；Provider/Embedding/Jev adapter 在 Host 内；§27.9#2：§23.1 的 Workspace Host 需增加 Coordinator、Evaluation Controller 与其 Worker/Adapter | **未实现**。架构 §26.3 指出 `runtime-host-poc.ts` 是内存 PoC；`openPactileRuntimeHost` 只是 store 组合的启动器，不是 WorkspaceHost。本线冻结候选里的 `agent run` 是 CLI 组合，不是 Host |
| RunLedger | §27.3：`RunManifest` 不替代 `RunLedgerV1`；§27.9#3：RunLedger 承载 Context Operation、Decision Receipt、Compaction Audit Receipt 的**关联**，但不把 ContextUnit 全文或 embedding 向量写入高频 Kernel 事实 | **未实现**（§26.1#8 未冻结）。现有 RuntimeStore 的 `runs/effects/leases` 与 memory audit 表是兼容读模型的候选来源，不是 RunLedger |
| Recovery | §27.9#4：§23.4 增加 Jev/Embedding timeout、wrong dimension、stale generation、manifest conflict、memory.read missing/denied、compaction race；§27.8：阶段门槛增加 Context Operation crash/replay fixture、Pi compaction 与旧 Attempt/epoch 的 fence 测试、Evaluation Run 与产品 Run 隔离测试 | 现有 `recover()` 只返回 `waiting/assurance_unknown`，没有 Context Operation 恢复；上述三类 fixture 均不存在 |
| Contracts | §27.4：新增 `RetrievalPlanV2`、`RetrievalCandidate/RetrievalPackV1`、`ContextUnit/ContextUnitManifestV1`、`CompressionJudgment`、`CompressionDecisionRequest/Receipt`、`CompactionAuditReceipt`、`EvaluationCase/EvaluationRunManifest`；必带 `schemaVersion`、`workspaceId`、`runId/evaluationRunId`、`contextOperationId`、`sourceRevision`、`generation`、`policyVersion`、`manifestHash`、`createdAt`、provenance；`unknown/stale/missing/permission_denied/revision_mismatch/epoch_mismatch` 为一等结果；两类 Receipt 是 Effect Receipt / Artifact Manifest / Kernel Evidence 的 typed payload | 现有 `RetrievalPlanV3`/`RetrievalClaimAssessmentV3`/`DecisionReceiptV1`/`ContextSnapshotRefV1`/`MemoryContextCompactionReceiptV1` 覆盖部分语义，但**没有**上述一等状态，`RetrievalProvenance` 缺 `workspaceId/sourceRevision/permissions/providerCapabilitySnapshot/freshness/contextOperationId`（Retrieval 线 §6） |
| Context Operation | §27.3：`contextOperationId` 标识一次 retrieval / unitize / compress / audit / memory.read；必须关联 `workspaceId, sessionId, runId, attemptId, turnId, operationEpoch, inputSnapshotHash, manifestHash, policyVersion` | 现有 compaction receipt 含 `contextOperationId`，但缺 `attemptId/turnId/policyVersion/ContextUnitManifest hash` |
| Evaluation Run | §27.3：`evaluationRunId` 必带 `caseSetHash, fixtureHash, candidateSha, dirtyWriteSet, providerCapabilitySnapshot, seed` 和独立报告；可无 Session/Run；pass/fail 不得翻转 `RunV1` 的 completed/settled；§27.2 其状态只能是 `pass/fail/blocked/unverified` | 旧评测用 `bucket-时间戳` 作 runId；没有统一 manifest 字段；旧 v65 长跑 `preRunManifestPresent:false` |
| 性能矩阵 | §27.9#5：§24 增加 RetrievalPack、Embedding、Jev、ContextUnit、Pi compaction、post-audit、net token/latency benefit 的分层指标；§24.1：fake Provider harness、区分 cold/warm/steady/crash recovery、报告 p50/p95/p99 与失败样本、先建基线再定硬门槛 | 未建；旧 −17.7% token 数字来自 fail-open 的 v1 版本，不是受控实验（Compression 线 §6） |
| 阻断条件 | §27.9#6：§26.1 增加 Context Governance schema/fixture hash、Evaluation Run 隔离、Jev/Embedding shadow mode、Pi compaction audit、memory.read recovery、promotion authorization 证据（已落入 §26.1#14） | 全部未完成 |
| Pi compaction audit | §27.7：链路必须是 `ContextOperation admitted → ContextUnitManifest durable → protected/exact/pointer policy check → Jev/Embedding advisory → deterministic Policy Gate → Artifact/Manifest/Receipt commit → Pi compaction → post-compaction audit → disclosure + deterministic memory.read → continuation`；commit 前不得启动不可逆 compaction；audit 失败只能恢复原 Artifact、扩大 Context、进入 `blocked/waiting/assurance_unknown` 或生成 regression case | 现有 `PactileContextPipeline` 先替换 Context 再写 audit；没有 Policy Gate、没有 post-compaction audit（见 Compression 线 §4#2、§4#8） |
| memory.read recovery | §27.7：`memory.read` 必须经 Host/Memory Port，按 pointer、manifest、权限、source revision、generation、hash 读取；主 Agent 不得绕过 Protocol 读 Runtime Store、Transcript 文件或 Memory 内部对象；§27.9#4：恢复需覆盖 missing/denied | Memory Port 未作为 Protocol 能力暴露；只有 `preflight({disclose:true})` 的 focused 测试 |
| provider capability snapshot | §27.2：每个检索分支必须带 scope、deadline、取消、source revision、权限和 provider capability snapshot；§27.3：Evaluation Run 必带；§27.6：`embeddingModelId/embeddingDim/promptVersion/chunkerVersion/semanticGeneration`，变化须使 generation 失效 | 无 capability snapshot 实体；现有 probe 只做命令可见性与 index marker |

### 2.1 §27 对 §23/§24/§26 的调整（待写入架构文档，本轮不改）

1. §23.1：Workspace Host 增加 Context Governance Coordinator、Evaluation Controller 及其 Worker/Adapter。
2. §23.3：RunLedger 承载 Context Operation / Decision Receipt / Audit Receipt 的关联。
3. §23.4：Recovery 增加 6 类 Context 故障。
4. §24：性能矩阵增加 7 组分层指标。
5. §26.1：阻断条件增加 5 项证据（已有 #14）。
6. “主控最高权限”在 Pactile 中只解释为**最高协调权限**，不得越过 Kernel / Host / Policy Gate / Lease / EffectGateway。

这些修改属于架构文档，不在本轮写集内；本线只在 `05-writeset-rollback.zh-CN.md` 里列出拟议修订。

## 3. 旧目标 → 新目标

| 维度 | 旧目标（旧任务链） | 新目标（Context Governance v1） |
| --- | --- | --- |
| Implementation 线 | 推进 Session/Checkpoint → Effect Receipt → Lease/Idempotency → Recovery → `pactile agent run` → Native E2E → Release preflight（见 `native-agent-gap-matrix.zh-CN.md`） | 冻结契约、评测集、身份模型、阶段门槛与证据格式；编排三条线；P0 通过前不写运行时代码 |
| Run 权威 | 本线曾用 RuntimeStore 的 `putRun/putEffect` 作为 Run/Effect 记录 | `RunLedgerV1` 是唯一 Run/Attempt/Effect/Receipt/Settlement 权威；RuntimeStore 退为兼容读模型 |
| 身份 | 评测用 `bucket-时间戳` 兼作证据身份 | 三层身份：产品 `runId`、上下文 `contextOperationId`、离线 `evaluationRunId` |
| 检索 | Retrieval Worker 作为 capability provider 接入 ABI V3 | Worker 只是 exact/structural 分支之一；`SemanticProvider` 与 `DecisionProvider` 分离；`RetrievalPack` 只含已 Inspect 候选 |
| 压缩/记忆 | Pipeline 内自行授权并替换 Context | Controller 只提交 `CompressionDecisionRequest`；Host Policy Gate + EffectGateway 准入；Pi 只执行已批准的 compaction |
| 放权顺序 | 旧计划按桶评测通过即接入 | 阶段 0–7；无 fixture hash、gold/negative、manifest、paired report、故障注入和恢复证据不得放权 |
| 结果语义 | 桶级 PASS/FAIL 常被汇总成“通过” | 评测 pass/fail 只是 evaluation fact，不翻转产品 Run；Controller pass ≠ 产品完成 ≠ settlement |

## 4. 事实分类

### 4.1 仍然有效的事实

| # | 事实 | 绑定 |
| --- | --- | --- |
| V1 | d25d33 冻结候选的 digest：src `f00e7d83…`（10 个文件）、dist `657f32c2…`（40）、test `4189fbf9…`（1）；`pactileHead=0a1dd4c350a115a3c53f9498570a8307bf438e0f`、Node `v24.3.0` | `D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json`（本线重新读取） |
| V2 | 权威 P5 并发评测：29/29 行 pass、309/309 断言为真，`verification.json` 34 项检查 0 失败；`summary.json` 的 **pre** 快照中三个 digest 与冻结一致（**post** 快照本线未逐项核对）；同一 `verification.json` 还记录 `fixtureMismatchCount=1`（见 §4.5，原因未核实） | candidate = retrieval-worker@d25d33；runId = `concurrency-05-20261008-004408`；目录 `D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408`；分母 29 行 / 309 断言 |
| V3 | P2 exact、P4 lifecycle、P6 budget/fault 存在绑定 d25d33 的通过记录（目录与 `verification.json` 存在，本线核实了文件清单） | `exact-02-20261007-181929-d25d33`、`lifecycle-04-20261007-190100`、`p6-budget-fault-06-20261007-183546-final`；分母以各自 `summary.json` 为准，本线**未**逐项重算 |
| V4 | Worker 事实边界：Worker 的 hash/facts 不算 corroboration；`scope.root` 与宿主指纹 `worktreeId` 必须丢弃；只有 `rule` provider 被允许；abort/timeout 只能靠终止进程保证 | `retrieval-worker-integration-design.zh-CN.md`（Retrieval 线 §3#4 复述） |
| V5 | Retrieval ABI V3 固定 `candidate → corroborate → classify-evidence → check-assurance → accept-or-stop`，provider score 不进入 assurance | `packages/cli/src/pactile/retrieval/types.ts`（导出 `RetrievalPlanV3`、`RetrievalClaimAssessmentV3` 等） |
| V6 | Context 替换只在完整链成功后发生，失败不替换（内存层） | `context-pipeline-native.test.ts` 2 tests；Compression 线 §3#1 |
| V7 | 旧 Rapid Evidence Closure v1 **仅在缩小边界内**通过：7/7 项，B3 9/9 选定行、B4 25/25 settled 与 8/8 压缩、B7 一个真实 GPT seam；独立复核 v63 pass；原始全量目标 open/deferred，严格门槛 1/4 = 25% | candidateHead `0a1dd4c3…`；`summary.rapid-evidence-closure-v64.json`、`goal-audit-rapid-v64.json` |
| V8 | 旧 B2 机制评测 `20261005-b2-mechanism-v14-b3-fix`：分母 40，通过 40，使用确定性假 Provider；真实 Provider 质量分母 0（`unverified`） | `b2-summary-v14.json`；candidateSha `0a1dd4c3…`，writeSetFingerprint `sha256:891602a7…` |
| V9 | 旧 Policy 任务 `10-04-pactile-agent-context-memory-policy`：Kernel schema 2；Run `a11e0688-1134-471d-afe7-f58b2386eed3` 状态 `completed`；1 个独立 Review（reviewer `controller-independent-review-context-memory-policy`，`independent:true`，decision `pass`）；**已 Close**（`phase=close`、`outcome=completed`，`task.closed` 事件 actor=`user`，2026-10-03T18:51:02Z）。其 Review 仅覆盖策略函数，native Pi bridge 未启动（引自 Compression 线 §7） | `D:\MyHarness\.pactile\tasks\10-04-pactile-agent-context-memory-policy\kernel.json`（本线重新读取 `closure`、`reviews`、`events`；候选 base `0a1dd4c3…`） |
| V10 | 工具环境：Node `v24.3.0`、pnpm `10.32.1`；`engines.node >=24.0.0` | 本机 |

### 4.2 已经过时的假设

1. “P1–P10 桶评测通过即可接入 Agent Context Pipeline”：被阶段 0–7 取代。
2. “Worker 就是检索链路”：新架构里它只覆盖 exact/structural 分支。
3. “bucket runId 可作证据身份”：必须补 `evaluationRunId, caseSetHash, fixtureHash, candidateSha, dirtyWriteSet, providerCapabilitySnapshot, seed`。
4. “在 Pipeline/durability port 内授权 compaction”：授权属于 Host Policy Gate。
5. “用 RuntimeStore 的 memory audit / lease 表作为 Receipt 与 fencing 权威”：唯一权威是 `RunLedgerCoordinator`。
6. “旧 MyHarness 候选 `0a1dd4c3…` 的通过结果可以代表 `D:\pactile` 代码”：布局不同（`packages/core/src/pactile/context-memory/**` 对 `packages/cli/src/pactile/agent/**`），且 `D:\pactile` 的 `develop` 没有提交。
7. “`basisRevision`（transcript 序号）等于 source revision”：它只是 transcript cursor。
8. 旧文档把 P9/P10 称为 “no-gold semantic / Agent correlation”，而旧提示词定义实为 P8=workflow/no-gold、P9=e2e 关联、P10=final 汇总（Retrieval 线 §4#5）。
9. 两份文档对压缩动作词汇不一致：§27.6 为 `lossy_compress`，任务书阶段 4 与 §27.8 表为 `drop`（见 BL-07）。

### 4.3 已验证结论（带绑定）

| 结论 | candidate | fixture/manifest | run | 证据目录 | 分母与结果 |
| --- | --- | --- | --- | --- | --- |
| P5 并发评测 PASS（附 `fixtureMismatchCount=1`，原因未核实） | retrieval-worker@d25d33（src/dist/test digest 见 V1；pre 快照已核对） | `…\concurrency-05-20261008-004408\manifest.json` | `concurrency-05-20261008-004408` | `D:\pactile-evidence\retrieval-worker-evaluation\` 下同名目录 | 29 行全 pass；309/309 断言为真；34 项 verification 检查 0 失败 |
| B2 机制（确定性假 Provider） | MyHarness@`0a1dd4c3…` + dirty write set | `b2-summary-v14.json` | `20261005-b2-mechanism-v14-b3-fix` | `D:\MyHarness\.pactile\tasks\10-05-pactile-context-memory-evaluation\` | 40/40 通过；5 臂各 8 trials；真实 Provider 0/40 有效 |
| Rapid Evidence Closure v1（缩小边界） | MyHarness@`0a1dd4c3…` | `goal-audit-rapid-v64.json` | v64（汇总）；子项见 v60/v61/v63 | 同上 | 必需 7 项全过；**原始目标仍 open/deferred** |
| 本线冻结候选可编译 | `D:\pactile` tree hash `sha256:59976265…`（§0） | — | 无（命令执行，非 Evaluation Run） | 终端输出 | typecheck exit 0；lint exit 0；**不是**设计正确性证据 |

### 4.4 未验证结论

- EmbeddingGemma 的模型 id、维度、task prefix、batch/取消语义、隐私和成本：无调研产物。
- 旧 P1（contract）没有权威 run；旧 P3 为 116 pass / 2 contract-finding / 1 INCONCLUSIVE（graph abort 窗口未证明）；P7 是冻结前背景证据，其内部数字与早期表述未调和；P8/P9/P10 从未启动（Retrieval 线 §5，本线未重算）。
- 真实 Provider 质量、真实 Pi compaction、真实 Pi SessionManager v3 的 tree/branch/fork 互操作、重启后 transcript 与 checkpoint 一致性（Compression 线 §4#2b 已知不一致）。
- 多 run 并发、duplicate request、半写入恢复、unknown effect reconcile 在 native 路径上的行为。
- 净 token/延迟收益（受控实验）。
- Node 24.0.0 最低版本的干净安装、全量测试、pack。
- 加入 `agent` 子命令后的全量测试（见 §0.1）。

### 4.5 harness 自身问题

| 项 | 内容 | 证据 |
| --- | --- | --- |
| H-P5 | P5 权威 run 的 `harness-failures.md` 记录 P5-H1…H13，均声明“在权威 run 前已纠正”；其中 H3 是“窗口先于重置导致断言空真”，H6 是“拼错 fixture 目录导致假超时”，H7 是“Tee-Object 懒建日志导致缺失产物未被检出” | `harness-failures.md` |
| H-P5-fixture | 同一 run 的 `verification.json` 有 `fixtureMismatchCount=1`：fixture `slow` 的 `d00/f000.ts` 期望 `a835b094…`、实际 `bfd840f9…`；`exitCode=0` 的含义被声明为“证据链完整”，候选观测另列 | `verification.json` 的 `fixtureMismatches`。**该差异的原因本线未核实**（可能是场景合法变异后的观测，也可能是 fixture 漂移），不得当作已解释 |
| H-P3 | 旧 P3 曾因 harness 的端点格式不一致，使“幽灵边”比较静默失效，修正后才暴露 G1–G3 | `verification.md` 桶 03 节 |
| H-v65 | v65 长跑 `preRunManifestPresent:false`，状态 `posthoc-invalid-for-gate` | `run-manifest-v65-…-interrupted.json` |
| H-P5-old | 旧 `concurrency-05-20261007-180737` 的 verdict 与 verdictNote 自相矛盾；`-193019`、`-003926` VOID；`-004022` SUPERSEDED | `retrieval-worker-d25d33.zh-CN.md`；Retrieval 线 §6 |
| H-系统 | 因此新的 Evaluation Controller 必须有“已知坏候选必须被判失败”的阳性对照（见 `04-evaluation-controller.zh-CN.md` §7） | — |

### 4.6 候选实现问题

- Worker 缺口 G1–G11 中与新目标直接相关的：G1（V3 ref 语法不能表达行号/大写路径）、G5（无 cancel）、G6（索引写入 workspace，与只读检索策略冲突）、G8（graph 目录 scope 语义）、G10（Worker 对解码文本取 hash，与 Agent 原始字节 hash 不一致）。
- Compression 线 §4：compaction 未进入 durable session tree；Provider error 后内存已回滚但 durable receipt 无 supersession；manifest read-back 无身份比对；摘要以 user role 注入；“真实 Pi SessionManager”测试可能空通过且版本为 1.0.2（provenance 为 1.0.4）。
- 本线 DEF-IMPL-1…6（§0.1）。

### 4.7 仍然缺失的证据

fixture registry 与 hash；gold/negative labels（标注者、来源、盲审）；`EvaluationRunManifest`；paired report 格式；故障注入集；`RunLedgerV1`/EffectGateway/Policy Gate 的任何实现证据；Context Operation crash/replay；Pi compaction 的 epoch fence；Evaluation Run 与产品 Run 的隔离测试；EmbeddingGemma 调研；candidate SHA；真实 Provider 质量分母。

## 5. 旧实现与旧评测的运行状态（精确观测，未触碰）

观测时点：2026-10-09T10:26–10:32+08:00。方法：`Get-CimInstance Win32_Process` 读取完整命令行，用以下关键字做**精确匹配**：`v65-b4`、`b4-full-100`、`rpc-driver.mjs`、`trace-extension.mjs`、`context-memory-evaluation`、`retrieval-worker`、`graph-03`、`concurrency-05`、`workflow-08`、`e2e-09`、`final-10`、`exact-02`、`lifecycle-04`、`p6-budget`、`embeddinggemma`。

| 线 | 结果 |
| --- | --- |
| 旧实现（native Agent / Batch 2） | 无与上述 runId/目录相关的进程。本线早先的构建/测试/lint 命令均已退出；10:27 曾见一次针对 `pi-session-manager.ts`、`service.ts` 的 `eslint`（PID 2488，父链已消失，疑为另一条线的检查，本线未启动，已退出） |
| 压缩/记忆评测（含 v65） | 无匹配进程。v65 `20261006-b4-full-100-rounds-v65` 状态 `unverified`，18/100 settled，5 次压缩，按用户指示中止，已排除在 gate 之外 |
| retrieval-worker 评测 | 无匹配进程。评测根目录下不存在 `workflow-08-*`、`e2e-09-*`、`final-10-*` 目录 |
| EmbeddingGemma 调研 | 无匹配进程；无调研产物（§1） |
| 其他 | 7 个 `pi-coding-agent` 进程在运行（PID 14556、24952、29524、11020、22016 启动于 09:22；34720 于 10:15；3288 于 10:26），属于派发链路中的各 Pi 会话；本线无法把它们逐一映射到具体线，**未触碰**。`python.exe celery`（PID 7376、39896）属于无关项目 `mulan-sse-experience`，关键字宽匹配误中，未触碰 |

没有重复启动任何 run，没有终止任何进程，没有覆盖任何旧证据。

## 6. 当前证据路径（索引）

```text
冻结候选与评测（只读）
  D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json
  D:\MyHarness\.tmp\retrieval-worker-evaluation\exact-02-20261007-181929-d25d33\
  D:\MyHarness\.tmp\retrieval-worker-evaluation\lifecycle-04-20261007-190100\
  D:\MyHarness\.tmp\retrieval-worker-evaluation\p6-budget-fault-06-20261007-183546-final\
  D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408\
  D:\pactile-evidence\retrieval-worker-smoke\smoke-20261008-020605\
压缩/记忆评测（只读）
  D:\MyHarness\.pactile\tasks\10-05-pactile-context-memory-evaluation\
  D:\MyHarness\.tmp\context-memory-evaluation\20261006-context-memory-v65-b4-full-100-rounds\
  D:\MyHarness\.pactile\tasks\10-04-pactile-agent-context-memory-policy\kernel.json
当前设计与另两条线的基线报告
  D:\pactile\docs\architecture\context-governance\retrieval\00-rebase-report.zh-CN.md
  D:\pactile\docs\architecture\context-governance\compression-memory-rebase-report.zh-CN.md
本线冻结的运行时候选
  见 §0 表格与 tree hash
```

## 7. 当前阻断项

完整清单见 `06-blockers.zh-CN.md`。会直接阻止进入 P0 冻结的是：

| ID | 阻断 | 解除条件 |
| --- | --- | --- |
| BL-01 | 三条线都尚未返回 `READY_FOR_P0`：Retrieval 与 Compression 两份报告都没有 `REBASE_STATUS` 行，并把汇总留给本线 | 两线各自返回 `READY_FOR_P0`；本线汇总 |
| BL-02 | EmbeddingGemma 调研产物缺失（Retrieval B1） | 提供路径，或接受“参数 + unverified”的冻结方式 |
| BL-03 | 重新基线前的运行时改动（本线 §0 + Compression 线 §0）处置未决 | 用户决定：冻结 / 隔离 / 回退 |
| BL-04 | `develop` 无提交，`candidateSha` 不可用 | P0 选定候选身份：tree hash 方案，或获授权建立基线提交 |
| BL-05 | `RunLedgerV1`、EffectGateway、Policy Gate、WorkspaceHost 均未实现 | 阶段 1b 之后的运行时 receipt 依赖它们；见阶段拆分 |
| BL-06 | 契约命名冲突：`RetrievalPlanV2`（§27.4）对 `RetrievalPlanV3`（现有 ABI）（Retrieval B4） | 评审 `01-contract-draft.zh-CN.md` §3.2 的拟议裁定 |
| BL-07 | 压缩动作词汇不一致：`lossy_compress` 与 `drop` | 评审 `01-contract-draft.zh-CN.md` §5.4 的拟议裁定 |

## 8. 拟修改的文档/契约写集

本轮已写入（均在 `D:\pactile\docs\architecture\context-governance\implementation\`）：

```text
00-rebase-report.zh-CN.md          本文件
01-contract-draft.zh-CN.md         Context Governance Contract 草案
02-ownership-dependency.zh-CN.md   三条线 ownership / dependency 表
03-stage-plan.zh-CN.md             阶段 0–7 计划
04-evaluation-controller.zh-CN.md  Evaluation Controller 设计、fixture 与报告格式
05-writeset-rollback.zh-CN.md      写集、回滚与冲突地图
06-blockers.zh-CN.md               阻断清单与未验证项
07-legacy-migration.zh-CN.md       旧任务到新任务的迁移说明
```

P0 获准后才会写（本轮**不写**）：对 `pactile-dual-product-architecture-design.zh-CN.md` 的 §23.1/§23.3/§23.4/§24/§26.1 修订；对 `retrieval-worker-d25d33` 与 `retrieval-worker-integration-design` 的 P8/P9/P10 桶名更正（Retrieval 线提议，本线认可）；`docs/migration/migration-batches.zh-CN.md` 与 `native-agent-gap-matrix.zh-CN.md` 增加“已被 Context Governance v1 重新基线”的状态行。

不在写集内：`packages/**` 源码与测试、`D:\MyHarness\**`、全局配置、lockfile、gold、分母、旧证据。

## 9. 需要用户授权的高影响动作

1. 处置重新基线前的运行时改动（本线 §0 的 16 个文件，及 Compression 线的 4 个）：冻结、隔离为补丁或回退。回退没有 git 基线，属破坏性操作。
2. 任何运行时或 Worker 代码修改（含修复 DEF-IMPL-1…6 与 Compression 线的 B-CM-2/3/4）。
3. 创建 Pactile V2 Task / Run（`workflow.md`：只有用户同意提案后才能创建 Task）；`03-stage-plan` 里的 Task 只是提案。
4. 建立基线 git 提交（为获得 `candidateSha`），以及任何 commit/push/merge/tag/publish/deploy。
5. 调用真实 EmbeddingGemma / Jev / 任何远程 embedding 端点（数据外发与成本），读取 `provider.env` 等凭据。
6. 新建 vector DB、embedding 索引或第二条 indexing pipeline；让 Worker 的 index init/sync 作为写 effect 运行。
7. 启动任何评测长跑（含旧 P1/P3 重跑、P8/P9、阶段 1 全量 run、v65 类 100 轮）。
8. 执行真实 Pi compaction、lossy action、restore 演练、memory promotion。
9. 锁定/升级 Pi coding-agent 版本，或改动 lockfile。
10. 修改架构文档 §23/§24/§26 与 `docs/migration/**`。

## 10. 下一阶段闸门

**进入 P0 冻结的条件**

1. 本线 01–07 经过独立 Review；
2. Retrieval 与 Compression 两线各自明确返回 `READY_FOR_P0`；
3. BL-03 有用户决定；BL-04 选定候选身份方案；BL-06、BL-07 获裁定；BL-02 有路径或被明确接受为“参数 + unverified”；
4. 三线写集无冲突（`05-writeset-rollback.zh-CN.md` §2 的冲突地图）。

**离开 P0 的条件**（详见 `03-stage-plan.zh-CN.md` 阶段 0）

- 01 的 **T1 12 个实体 + T2 9 个独立支撑类型（登记表 21 行，见 `implementation/09-contract-entities-v1.zh-CN.md` §1.1）**与各线详细契约通过 Review，全部状态为 `proposed/frozen-draft`；
- fixture 清单与 gold/negative labels 在任何检索/压缩运行之前冻结，并记录 sha256、来源、标注者、盲审；
- `EvaluationRunManifest`、paired report、故障注入清单、阳性对照冻结；
- 声明：P0 不改运行时代码、不接真实 Provider、不运行长跑；离线报告 pass/fail 不影响产品 Run 或 Kernel。

阶段 1 只能在 P0 冻结物通过 Review 后，另获授权启动。

## 11. 本报告的限度

- 没有产品 Run 和 Evaluation Run 与本报告相关；本报告不是任何 Run 的证据。
- “仍然有效/已验证”只限于已列出的绑定对象；其他旧 PASS 一律视为背景证据。
- 进程观测是 2026-10-09 10:26–10:32 的瞬时快照，不排除之后启动的进程。
- 以上 V3（P2/P4/P6 通过记录）本线只核实了目录与文件存在，没有逐项重算分母。
