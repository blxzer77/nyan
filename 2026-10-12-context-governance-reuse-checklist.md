# 上下文治理整套复用清单：压缩、记忆、检索、Jev、embedding（2026-10-12）

**前提**：用户决定把 Pactile 的压缩、记忆、检索按**原来的实现、原来的设计、原来的思路**整套复用进 nyan，Jev 和检索里的 embedding 都要做。这份清单取代 [设计草案](2026-10-12-memory-compaction-retrieval-design.md) 里“省掉 RunLedger、不搬某些部分”的取舍。进度事实见 [进度报告](2026-10-12-pactile-context-governance-progress.md)。

**来源**
- `D:\pactile`：`packages/cli/src/pactile/**`、`packages/cli/test/**`、`docs/architecture/context-governance/**`。
- `D:\MyHarness\pactile\packages\retrieval-worker`。

行数用 `wc -l` 统计。

**标记**
- **移植**：代码基本照搬，只改命名、路径和导入。
- **改写**：设计和契约照旧，但要接到 nyan 的对应物上，代码要动。
- **新做**：原来只有设计，没有代码。
- **不在范围**：只服务 Pactile 的任务 Kernel，建议不搬。可以推翻。

---

## 0. nyan 里的落点（建议）

| 新位置 | 放什么 | 层（`layers.json`） |
| --- | --- | --- |
| `packages/context`（新包 `@ny4n/context`） | 与宿主无关的契约和编排：规范化 JSON 与指纹、压缩切点与快照、Policy、确定性摘要器、记忆耐久协议、artifact/回执/manifest/租约等端口、Context Pipeline、CDR/CAR 回执校验与生成 | 新层，放在 `agent-core` 和 `product-shell` 之间，只依赖 `@ny4n/ai/contracts` 和 `@ny4n/agent-core` 的类型 |
| `packages/retrieval`（新包 `@ny4n/retrieval`） | 检索 Worker（exact/structural/relation store）、Retrieval ABI V3 规划器/证据/pack、语义 Provider（embedding）、RRF 融合 | capabilities 层，零运行时依赖 |
| `packages/decision`（新包 `@ny4n/decision`），或并进 `@ny4n/context` | Jev 传输、出站校验、响应解析、决策门面、Rule/Composite Provider、Provider 策略上限与 assurance | capabilities 层 |
| `packages/coding-agent/src/core/context-governance/` | 宿主接线：SQLite RunLedger/RuntimeStore、文件 ArtifactStore、受治理 run session、memory_read/code_search 工具、和 `AgentSession` 压缩流程的对接、`review`/`reconcile` 命令、设置项 | product-shell（core 层，不依赖 modes/cli） |
| `packages/agent` | `context_update` 事件、工具结果省略 undefined 字段 | agent-core |
| `.agents/notes/`、`packages/coding-agent/docs/` | 设计决策记录（英文，按 nyan notes 格式）、用户文档 | — |

存储位置默认放用户目录 `~/.nyan/agent/context/<project-id>/`，包括 runtime.sqlite、artifacts/、retrieval/。跨会话记忆位置用户还没定，见第 9 节。

---

## 1. 设计与思路（文档，全部复用）

| # | Pactile 文档 | 内容 | nyan 去向 |
| --- | --- | --- | --- |
| D1 | `context-governance/compression/compression-decision-chain-v1`（54 KB） | 11 步决策链 S1–S11、8 种动作、13 种降级、Pi 压缩适配契约、17 项压缩后审计 | `.agents/notes/` 主设计 note + `@ny4n/context` 的 spec |
| D2 | `compression/context-unit-manifest-v1`（67 KB） | ContextUnit 切分、22 种 AnchorKind、20 条保护规则、RestoreToken、PermissionScope | 同上，作为 ContextUnitManifest 的规范 |
| D3 | `compression/compression-memory-evaluation-matrix-v1`（36 KB） | 压缩/记忆评测矩阵、CMP-A0…A5 对照臂、零容忍计数器 ZT-CM | 评测 harness 规范 |
| D4 | `compression/compression-memory-legacy-migration`（23 KB） | 旧 task/session-memory 迁移 | 参考，nyan 没有旧数据，只取规则 |
| D5 | `compression-memory-rebase-report`（29 KB） | 压缩线基线、历史问题、阻断项 | 参考 |
| D6 | `implementation/00`–`10`（共约 400 KB） | 共享契约（12 个 T1 实体 + 9 个 T2 类型、14 种非 ok 状态及折叠规则）、ownership 与依赖、阶段 0–7 计划、评测控制器（FI-01…27 故障注入、KB 阳性对照、paired 报告）、写集与回滚、阻断、P0 准入、P0 退出清单 | 契约部分进 spec；阶段计划和门槛改写成 nyan 的里程碑和测试要求 |
| D7 | `retrieval/00`–`12`（共约 260 KB） | 语义 Provider 契约、检索 schema、语义 generation 索引、Inspect/freshness fence、候选管线、降级、外部搜索证据、隐私与外发、readiness fixture、评测矩阵（RET-A0…A3）、旧 Worker 迁移、阻断 | `@ny4n/retrieval` 的 spec |
| D8 | `architecture/pactile-context-governance-agent-prompts`（17 KB） | 给各线 Agent 的交接提示词 | 改写成 `.agents/skills/` 的工作流 |
| D9 | `architecture/pactile-dual-product-architecture-design` §23–§27（106 KB 中的相关章节） | Context Governance 总体架构、Host 轨道 P0–P6、阶段映射、降级规则 | 主设计 note |
| D10 | `architecture/retrieval-bounded-context` | 检索 scope/provenance、纯 admission、稳定排序、adapter 端口 | `@ny4n/retrieval` spec |
| D11 | `docs/migration/retrieval-worker-d25d33`、`retrieval-worker-integration-design`（18 KB）、`batch-2-context-compaction-memory`、`batch-2a-provider-stream-audit`、`native-agent-gap-matrix` | Worker 接入设计、字段映射、批次记录、缺口矩阵 | 参考 + note |
| D12 | `.agents/notes/implemented/2026-10-11-*`（governed-agent-run-by-default、approval-grant-snapshot、evidence-claim-levels） | 已实现的决策 | 改写成 nyan notes |
| D13 | `docs/capabilities/retrieval`、`privacy-and-permissions`、`providers`、`bounded-workspace-requests` | 用户视角的能力说明 | 用户文档 `packages/coding-agent/docs/` |

## 2. 关键不变量（原来的思路，实现时必须保持）

1. 决策链每一步都有失败出口。`unknown`、`stale`、`missing`、`permission_denied`、`revision_mismatch`、`epoch_mismatch`、`manifest_conflict` 等 14 种都是一等结果，不能被折叠成成功。
2. 不静默成功：任何降级、fallback、部分结果都必须披露原因。
3. 未知副作用不自动重放，失败一律带 `reexecute: false`。
4. 提交顺序固定为 artifact → 回执 → manifest（CAS）。压缩只在三者都已持久化之后执行。
5. exact/protected 内容不能被改写；可逆动作要能逐字节还原。
6. Jev 和 embedding 只提建议：不改变分支、预算和动作取舍；低置信度、超时、schema 不符时，结果必须和不用它们时一致。
7. 检索候选不等于证据。Worker 看到的 hash 不算佐证；佐证只能来自独立的源码重读、Git 或可重复的测试。
8. 外发默认拒绝。只发查询和预算，不发源码、事实、路径、token。
9. 记忆只存结构化事实。prompt、transcript、凭据、绝对路径在写入前就拒绝；对外只暴露逻辑引用 `memory://`。
10. 摘要里只摘录用户写的文字。工具和模型的输出只记元数据。命中秘密的摘录整段丢弃，不做局部脱敏。
11. 评测平面和产品平面隔离：评测不写产品存储，`plane=evaluation` 的回执不入账。
12. 有损压缩、`drop`、记忆晋升、外发都要单独授权，授权不继承。

## 3. 代码：压缩与上下文管线

| # | 文件 | 行数 | 标记 | nyan 目标 / 要点 |
| --- | --- | --- | --- | --- |
| C1 | `agent/context/compaction.ts` | 617 | 移植 | `@ny4n/context`：切点校验、快照引用、delta、指纹 |
| C2 | `agent/context/policy.ts` | 107 | 移植 | `@ny4n/context`：context surgery 决策 |
| C3 | `agent/context-pipeline.ts` | 893 | 改写 | `@ny4n/context`：Pipeline 本体照搬；它对接的 `prepareRequest`/`prepareNextTurn` 要换成 nyan `AgentSession` 的压缩入口（`agent-session.ts` 的 between-turn 检查和 overflow 恢复） |
| C4 | `agent/context-summarizer.ts` | 227 | 移植 | `@ny4n/context`：确定性摘要器 |
| C5 | `runtime/governed-context-pipeline.ts` | 202 | 改写 | coding-agent 宿主：每次压缩一个 Context Operation |
| C6 | `runtime/context-governance-policy.ts` | 235 | 移植 | `@ny4n/context`：阈值 Policy、admission gate |
| C7 | `runtime/context-governance-review.ts` | 676 | 改写 | 人工 review 被挂起的压缩：接到 nyan TUI（确认对话）和 RPC（`extension_ui`），另配 `/context review` 命令 |
| C8 | `runtime/context-governance-approval-grant.ts` | 175 | 移植 | 批准时写不可变 grant 快照 |
| C9 | `runtime/context-governance-receipts.ts` | 530 | 移植 | CDR/CAR 校验（含 17 项检查的结构） |
| C10 | `runtime/context-governance-producer.ts` + `-pipeline-producer.ts` | 344 + 490 | 移植 | CDR/CAR 生成并持久化 |
| C11 | `runtime/context-governance-artifact-intents.ts` + `-artifacts.ts` + `-record-support.ts` | 792 + 167 + 89 | 移植 | artifact intent 持久化与跨 run 对账 |
| C12 | 压缩后 17 项审计 | — | **新做** | 原来 CAR 固定写 `assurance_unknown`；按 D1 §7 实现，nyan 里可确定判定的先做（tool call 配对、exact 锚点、pointer 可达、回滚引用、manifest 指针、epoch） |
| C13 | ContextUnitManifest（单元切分、AnchorKind、保护规则） | — | **新做** | 按 D2 实现，是 8 种动作的前提 |
| C14 | 8 种动作中的可逆动作（`mask_reopenable`/`externalize`/`structured_project`）、`lossy_compress` | — | **新做** | 按 D1 §5 和阶段 5、6；nyan 会话文件保留原文，还原可直接读会话条目 |

## 4. 代码：记忆

| # | 文件 | 行数 | 标记 | nyan 目标 / 要点 |
| --- | --- | --- | --- | --- |
| M1 | `agent/memory/durability/index.ts` | 3985 | 移植 | `@ny4n/context`：事实文档 schema、安全扫描、提交/读取/预检/压缩授权/恢复。按 nyan 规范拆成多个文件 |
| M2 | `agent/memory/artifact-store/index.ts` | 777 | 移植 | `@ny4n/context`：ArtifactStore 端口与校验 |
| M3 | `agent/memory/scope.ts` | 214 | 改写 | 记忆范围：Pactile 是 workspace/project；nyan 用 git 根或 cwd 生成 project id |
| M4 | `agent/memory/read-tool.ts` | 200 | 改写 | `memory_read` 工具：改成 nyan 的 `ToolDefinition` 和渲染器 |
| M5 | `runtime/context-governance-memory.ts` / `-memory-commit.ts` / `-memory-read.ts` / `-memory-read-port.ts` | 562 + 448 + 172 + 178 | 移植 | 宿主侧记忆端口实现，绑定 RunLedger |
| M6 | 记忆晋升（阶段 7） | — | **新做** | 原设计走 Kernel 命令。nyan 没有 Kernel，晋升改成显式的用户命令（`/memory promote` 加确认），需要重新设计批准载体 |
| M7 | 记忆查看与删除（`/memory`） | — | **新做** | nyan 用户数据必须能查看、能删除 |

## 5. 代码：运行时宿主（RunLedger、存储、租约）

| # | 文件 | 行数 | 标记 | nyan 目标 / 要点 |
| --- | --- | --- | --- | --- |
| H1 | `runtime/run-ledger.ts` | ~1100（44 KB） | 移植 | coding-agent 宿主：RunLedgerV1，`BEGIN IMMEDIATE`，revision fence |
| H2 | `runtime/run-ledger-effect-receipts.ts`、`effect-receipts.ts`、`agent/effects/contract.ts` | 261 + 244 + 128 | 移植 | 工具副作用 intent/receipt；接 nyan 的 `beforeToolCall`/`afterToolCall` |
| H3 | `runtime/store-port.ts`、`stores/sqlite/*`（repository 2078、schema 208、codec 297、capability 272、types 94） | ~2950 | 移植 | SQLite RuntimeStore，用 `node:sqlite`（Node ≥22.13 和 Bun 1.4.2 都可用）；路径改到 `~/.nyan/agent/context/` |
| H4 | `runtime/stores/artifact/*`（repository 763、filesystem 192、types 76） | ~1030 | 移植 | 文件 ArtifactStore |
| H5 | `runtime/paths.ts`、`canonical-paths.ts`、`case-fold.ts`、`unicode-nfc*.ts` | 321 + ~330 + ~330 + 大表 | 移植 | 路径规范化；先核对 nyan 已有的路径工具，能复用就复用 |
| H6 | `runtime/runtime-host.ts`、`governed-run-session.ts` | 166 + 503 | 改写 | 一次受治理 session 的组合根：从 Pactile 的 `agent run` 改成 nyan 的 `AgentSession` 生命周期（打开时恢复，关闭时 finish） |
| H7 | `agent/session/checkpoint.ts`、`contracts.ts` | 167 + 205 | 改写 | checkpoint 写进 nyan 会话 JSONL 的自定义条目，不另建 Pi session 文件 |
| H8 | `shared/validation.ts` | 543 | 移植 | 规范化 JSON、指纹、logical id 校验；去掉 `PACTILE_` 前缀 |
| H9 | `runtime/settlement-outbox-projector.ts`、Product Kernel SQLite store | 245 + … | 不在范围 | Kernel→Runtime 结算投影；nyan 没有 Kernel |

## 6. 代码：Pi agent 接缝

| # | 内容 | 标记 | 要点 |
| --- | --- | --- | --- |
| P1 | `context_update` 事件（`agent-loop.ts`、`agent.ts`、`types.ts` 约 20 行） | 移植 | 进 `packages/agent`，写 note 说明为什么改 loop |
| P2 | 工具结果省略 undefined 的 `details`/`usage` | 移植 | 同上，否则 transcript 指纹会拒绝 |
| P3 | `PactileNativeAgent` 包装（`native-agent/service.ts` 334） | 改写 | nyan 不另包一层 Agent，把它挂的 session/pipeline/effect 接线放进 `AgentSession` 和扩展点 |
| P4 | `agent/loop/provider-port.ts`、`adapters/provider/pi-ai.ts` | 不需要 | nyan 直接用 `@ny4n/ai` |

## 7. 代码：检索

| # | 文件 | 行数 | 标记 | nyan 目标 / 要点 |
| --- | --- | --- | --- | --- |
| R1 | `retrieval-worker/src`：worker 673、graph 624、exact 480、decision 379、types 255、store 252、util 171、rpc 77 | ~2900 | 移植 | `@ny4n/retrieval`；relation store 移到用户目录；`PACTILE_DECISION_*` 改成 `NYAN_*` |
| R2 | `retrieval-worker/test/worker.test.ts` | 1413 | 移植 | |
| R3 | `retrieval/planner.ts`、`types.ts`、`evidence.ts`、`pack.ts`、`envelope.ts`、`boundary.ts`、`jev-planning.ts` | 1094 + 181 + 422 + 247 + 99 + 117 + 160 | 移植 | Retrieval ABI V3 |
| R4 | `retrieval/adapters/local-worker.ts`、`local-worker-process.ts` | 1182 + 584 | 改写 | 进程模型：Node 下用子进程；Bun 二进制下要“自己调自己”，参照 codemode worker 的做法 |
| R5 | `agent/retrieval/*`（adapter 211、contract 93、policy 71、ranking 65、router 58、explain 27） | ~525 | 移植 | Agent 侧检索边界 |
| R6 | `utils/codebase-retrieval-router.ts`、`retrieval-result-ranking.ts`、`retrieval-tool-classification.ts`、`retrieval-execution-telemetry.ts`、`retrieval-agent-instructions.ts`、`semantic-plan-gate.ts` | ~600 | 改写 | 给模型的检索指令、工具分类、遥测；遥测改接 `@ny4n/telemetry` |
| R7 | `code_search`（也许再加 `code_graph`）工具 | — | **新做** | 工具定义、渲染、系统提示片段 |
| R8 | 语义 Provider（EmbeddingGemma）：`SemanticProvider` 端口、readiness probe、`semanticGeneration`（模型/维度/prompt/chunker 变化即失效）、chunker、向量存储、RRF 融合、exact+structural fallback | — | **新做** | 原来只有 D7 的 `01`/`03`/`05`/`06`/`09` 设计和一个探测脚本；参数（维度 768/512/256/128、task prefix、batch）都还是“未验证” |
| R9 | 索引写入方案（S1 走 EffectGateway 写 effect，或 S2 外置 indexDir） | — | 待决定 | 原来就没定（R-BL-09） |
| R10 | 外部 Search/Fetch 证据（D7 `07`） | — | **新做** | 原来只有设计 |

## 8. 代码：Jev / 决策 Provider

| # | 文件 | 行数 | 标记 | nyan 目标 / 要点 |
| --- | --- | --- | --- | --- |
| J1 | `jev/contracts.ts`、`transport.ts`、`http.ts`、`outbound.ts`、`response.ts`、`decision.ts`、`project-policy.ts`、`index.ts` | 200 + 135 + 268 + 312 + 377 + 261 + 60 + 31 | 改写 | `@ny4n/decision`。**`JEV_ENDPOINT_V1` 写死了 `https://api.commandcode.ai/provider/v1/systemone`**，违反 nyan“没有默认托管服务”的规则，必须改成用户配置（如 `NYAN_JEV_URL`），不配置就关闭 |
| J2 | `decision/contract.ts`、`rule-provider.ts`、`provider-registry.ts`、`model-catalog.ts` | 61 + 15 + 51 + 146 | 移植 | 决策 Provider 注册与规则兜底 |
| J3 | `providers/contract.ts`、`probes.ts` | 692 + 260 | 移植 | 策略上限（网络/凭据/文件系统/隐私/成本/遥测）、assurance 等级、Provider readiness |
| J4 | Worker 里的 `HttpDecisionProvider`/`SystemOneDecisionProvider`/`CompositeDecisionProvider` | 在 R1 里 | 合并 | 和 J1 是两套 Jev 客户端，合并成一套 |
| J5 | Jev 检索 shadow（阶段 3）、Jev 压缩 shadow（阶段 4，8 种动作建议 + 反事实回放） | — | **新做** | 原来只有设计和一次端点探测 |
| J6 | `jev/scheduler-advice.ts`、`tiles/jev-selection.ts`、`verification/jev-advice.ts`、`task/session-jev*.ts`、`task/session-retrieval-jev*.ts` | 518 + … | 不在范围 | 服务 Kernel 的 tile/调度/验证节点；`retrieval-planning` 节点保留 |

## 9. 测试

| # | Pactile 测试 | 大小 | 去向 |
| --- | --- | --- | --- |
| T1 | `test/core/pactile/context-memory/durability.test.ts`、`compaction.test.ts`、`context-memory-policy.test.ts`、`artifact-store.test.ts`、`validation-runtime.test.ts`、`decision/decision-provider.test.ts`、`pi-session-checkpoint.test.ts` | 77 KB 等 | `@ny4n/context` |
| T2 | `test/pactile/agent/context-governance-pipeline.integration`、`context-pipeline-native`、`context-policy-review.integration`、`context-summarizer`、`memory/scope`、`tool-result-fingerprint`、`retrieval/modular` | 25–33 KB | `@ny4n/context` / coding-agent |
| T3 | `test/pactile/runtime/context-governance-*`（artifact-intents、producer 95 KB、receipts、reconcile-all、review）、`context-memory-sqlite`、`file-artifact-store`、`governed-*`（context-pipeline、memory-read-tool、run-scope、run-session）、`run-ledger*`、`runtime-host`、`sqlite-runtime-store`、`stores`、`paths`、`review-regressions` | 合计约 400 KB | coding-agent 宿主 |
| T4 | `test/pactile/retrieval/*`（evidence、guard、jev-planning、local-worker-adapter 32 KB、local-worker-candidate.smoke、local-worker-process、pack-node、parity、planner） | 合计约 100 KB | `@ny4n/retrieval` |
| T5 | `test/pactile/jev/*`（decision、public-api、transport 24 KB）、`providers/provider-probes` | | `@ny4n/decision` |
| T6 | `settlement-outbox-projector`、`sqlite-product-kernel-store`、`pi-executor`、`pi-rpc-host` 等 Kernel/旧 RPC 测试 | | 不在范围 |

## 10. 评测资产与证据

| # | 内容 | 去向 |
| --- | --- | --- |
| E1 | `evidence/p1a/`：fixtures（negative 33 条、known-bad 7 条）、labels、catalogs、ERM/PCR、freeze-manifest、results | `packages/context/test/fixtures/cg-p1a/`，作为确定性基线的回归用例 |
| E2 | `evidence/p0/`：P0 fixture、labels、盲审与静态复审记录 | 同上，作为 P0 资产 |
| E3 | `evidence/provider-shadow/provider-readiness-probe.mjs` + 回执 | 改写成 nyan 的 Provider readiness 检查。脚本里**写死了 tailnet 内网 IP `100.71.213.27:50007`**，不能带进仓库 |
| E4 | 阶段 1a 评测 runner（产生 ERM/PCR 的程序） | **不在 `D:\pactile` 里**。可能在 `D:\MyHarness\.pactile\tasks\`，还没找到 |
| E5 | 阶段 2–7 的评测（paired、故障注入 FI-01…27、crash/replay） | 新做，按 D3、D6 `04`、D7 `10` |

## 11. 跨模块的统一改动

- 命名：`Pactile*`、`PACTILE_*` 错误码和环境变量、`.pactile/` 路径、`memory://`/`session://` 引用格式，统一改成 nyan 标识，由 `identity.ts` 管理。类型名的 `V1` 后缀是否保留，要定一个规则。
- 文件拆分：nyan 规范要求小文件、单一职责。`durability/index.ts`（3985 行）、`sqlite/repository.ts`（2078 行）、`retrieval/planner.ts`（1094 行）、`local-worker.ts`（1182 行）都要拆。
- 运行时：原来只支持 Node 24。nyan 要求 Node ≥22.19 加 Bun。`node:sqlite`、`node:child_process`、路径大小写和 NFC 处理要在两边都测过。
- 依赖：这几块只用了 `typebox`（nyan 已有）和 Node 内置模块，不需要新的外部依赖。
- 分层：在 `layers.json` 里先登记三个新包和 coding-agent 的新模块，再写代码。
- 文档：nyan 的用户文档和 notes 是英文，中文设计文档要改写成英文。保留原文档作为附录，还是只留链接，要定。

## 12. 需要用户决定

1. 跨会话记忆存放位置：`~/.nyan/agent/memory/`（推荐）或项目内 `.nyan/memory/`。
2. 以后这块只在 nyan 里开发（推荐），Pactile 停止开发这部分。
3. Pactile 原来的闸门流程（独立 Review、预注册、paired 报告、零容忍计数器）是照搬，还是改成 nyan 的测试 + note？推荐保留评测资产和零容忍规则作为测试，不保留逐轮复审回执。
4. Jev 和 embedding 端点：nyan 不能内置默认地址，需要你提供配置方式（环境变量名）和测试用的凭据范围。
5. 阶段 1a 评测 runner 在哪里（E4）。
6. 三个新包是分开还是合并：`@ny4n/decision` 并进 `@ny4n/context` 也可以。

## 13. 建议的批次

| 批 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | 分层登记 + `@ny4n/context` 契约层（H8、C1、C2、C4、C6、C9、M1、M2、M3）+ T1 + E1 回归 | 无 |
| 2 | 宿主：RunLedger/SQLite/ArtifactStore（H1–H5）+ T3 的对应部分 | 1 |
| 3 | 接线：P1/P2、C3/C5/C10/C11、M4/M5、H6/H7，接进 `AgentSession`；`memory_read` 可用 | 2 |
| 4 | review/reconcile（C7、C8）+ 17 项审计（C12） | 3 |
| 5 | `@ny4n/retrieval`：Worker + ABI V3 + `code_search`（R1–R7） | 1（可与 2–4 并行） |
| 6 | `@ny4n/decision`：Jev + Provider 策略（J1–J4），只做 readiness 和 shadow 记录 | 1 |
| 7 | embedding 语义检索（R8）+ Jev 检索 shadow（J5 前半） | 5、6 |
| 8 | ContextUnitManifest + 可逆动作（C13、C14 可逆部分）+ Jev 压缩 shadow（J5 后半） | 4、6 |
| 9 | 有损压缩、记忆晋升、`/memory`（C14 有损、M6、M7） | 8 |
