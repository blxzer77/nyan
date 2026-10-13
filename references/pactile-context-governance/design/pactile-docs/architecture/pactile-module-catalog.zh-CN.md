# Pactile 功能模块总目录与开发状态

- 版本：`2026-10-14`
- 性质：架构盘点与开发导航；不是发布清单，也不是验收报告。
- canonical source：`D:\pactile\packages\cli\src\pactile\`
- UI source：`D:\pactile\apps\pactile-app\`
- 状态口径：`design`（只有设计）、`implementation`（源码存在）、`integrated`（已接入 canonical composition）、`invoked`（有真实调用观察）、`verified`（绑定当前候选和相关验证）、`published`（进入发布产物）。一个模块可以同时存在多个较低状态，但不能因为源码存在就升级状态。

本文以 [检索与搜索服务设计](context-governance/retrieval/13-retrieval-search-service-design.zh-CN.md) 为样例，把 Pactile 当前源码、目标架构和正在推进的功能线放在同一个模块视图中。凡是“目标目录”或“P0 契约”的内容，都不能写成已经接入产品运行时。

## 1. 总体分层和依赖方向

```text
shared / stable primitives
          ↓
contracts / protocol schemas / ports
          ↓
kernel facts  ·  agent use-cases  ·  capability policy
          ↓
runtime stores / Pi adapters / provider adapters / integrations
          ↓
composition root / CLI / Protocol / App projections
```

依赖必须指向更稳定的层：

- `shared` 只放稳定基础类型、hash、时间、路径、纯校验和序列化原语。
- `contracts` 和 `ports` 描述事实和能力，不依赖 SQLite、Pi、Provider SDK、Electron 或网络实现。
- `kernel` 拥有 Project、Goal、WorkItem、Block、Evidence、Gate、Close、CompletionDecision、Settlement 等产品事实，不依赖 Agent Runtime。
- `agent` 拥有 Agent loop、Session、Context、Retrieval、Compression、Memory 的用例编排，只通过 Port 使用外部能力。
- `capabilities` 拥有 admission、authorization、write set、effect 和 receipt 规则；高影响动作必须经过 lease/epoch 和 unknown-effect 边界。
- `runtime` 和 `integrations` 实现 Port，承载 SQLite、文件、Pi、Provider、Jev、Search/Fetch 等外部细节。
- `projections`、Protocol 和 App 只读取版本化 snapshot、delta、receipt 和 event；Renderer 不写 Kernel、Transcript、Memory 或 Runtime Store。
- `compat` 只能向 canonical 模块转发；`migration` 只能读取旧格式并迁移；新模块不得反向依赖它们。

目标边界来自 [功能点多模块架构与迁移基线](pactile-feature-modular-monolith.zh-CN.md) 和 [ownership / dependency 表](context-governance/implementation/02-ownership-dependency.zh-CN.md)。

### 1.1 稳定基础、合同和内容边界

| 模块 | 当前代码 / 目标位置 | 职责与稳定边界 | 当前状态 |
| --- | --- | --- | --- |
| Shared primitives | `packages/cli/src/pactile/shared/`；目标还包括 `shared/ids`、`hash`、`time`、`serialization`、`paths` | Node-neutral 的基础值、hash、时间、路径、纯校验和序列化 | `implementation` / 部分边界债务；不得放领域规则 |
| Contracts | 目标 `packages/cli/src/pactile/contracts/`；当前分散在 `agent/**`、`kernel/**`、`retrieval/**`、`protocol/**` | Kernel、Agent、Context、Compaction、Memory、Capability、Storage、Protocol 的稳定 schema/port | `design` / `partial implementation`；canonical contracts 目录尚未完全形成 |
| Protocol contracts | `packages/cli/src/pactile/protocol/`、App `protocol/` | IO envelope、versioned snapshot/delta、command response、receipt 和 event 的跨进程边界 | `implementation` / `partial integration`；Agent 正式 schema 仍需统一 |
| Artifact domain/projection | `packages/cli/src/pactile/artifacts/` | Artifact schema、reader、documents、projection 和公共 artifact 类型 | `implementation`；物理存储由 runtime adapter 实现 |

## 2. 核心产品模块

### 2.1 产品 Kernel

| 模块 | 当前代码 | 职责与稳定边界 | 依赖方向 | 当前状态 |
| --- | --- | --- | --- | --- |
| Product Kernel domain | `packages/cli/src/pactile/kernel/model/` | Project、Goal、WorkItem、Block、Run、Evidence、Gate、Close、Settlement 的类型、校验、fold 和策略 | 只依赖 shared/contracts | `implementation`；与 RunLedger 的统一事务边界尚未闭合 |
| Product Kernel store | `packages/cli/src/pactile/kernel/store/product/` | 产品事实、命令、观察、snapshot、recovery、settlement | Kernel Port ← runtime store adapter | `implementation`；SQLite adapter 已拆分，完整 Host 接入未完成 |
| Task Kernel | `packages/cli/src/pactile/kernel/task/` | Task schema v2、Task/Run/Review/Workspace 结构、Task 服务和写集 | Kernel model/ports | `implementation`；schema 拆分已完成，旧入口只作兼容层 |
| Task scheduling / admission | `packages/cli/src/pactile/scheduler/` | Task map、wave dispatch、project lease、start/admission 和运行调度 | Kernel facts + capability/admission ports | `implementation`；唯一 RunLedger/Lease authority 尚未替代现有 RuntimeStore seam |
| Exit / settlement | `packages/cli/src/pactile/exit/` | 运行退出、receipt、settlement 结果和终态服务 | Kernel settlement + Runtime receipts | `implementation`；不能单独决定产品 Close |

Kernel 不读取 transcript、embedding、SearchHit 或模型判断；检索、压缩、评测的产物只能通过正式命令和 Evidence 端口进入 Kernel。

### 2.2 Agent 核心

| 模块 | 当前代码 | 职责与公共面 | 依赖方向 | 当前状态 |
| --- | --- | --- | --- | --- |
| Agent loop | `packages/cli/src/pactile/agent/loop/` | turn loop、Provider stream port、停止与结果边界 | Agent contracts → Provider Port | `implementation`；native Agent composition 仍在整合 |
| Native Agent service | `packages/cli/src/pactile/agent/native-agent/` | Pactile Agent service contract 和执行入口 | Agent contracts、Session、Context pipeline | `implementation`；不能写 Kernel 或绕过 Host |
| Agent session | `packages/cli/src/pactile/agent/session/` | Session contract、checkpoint、branch/session 状态 seam | Agent contracts ← Runtime Session adapter | `implementation`；真实 Pi tree/branch/fork 互操作仍未验证 |
| Agent lifecycle bridge | `packages/cli/src/pactile/agent/lifecycle-bridge.ts` | Agent 生命周期事实、receipt 和旧生命周期兼容 | Agent ↔ Runtime/Kernel ports | `implementation`；仍需收敛到 canonical composition |
| Agent effects | `packages/cli/src/pactile/agent/effects/` | Effect intent/receipt contract，不拥有最终副作用权威 | Capability/EffectGateway Port | `implementation`；当前是迁移 seam，不是最终 EffectGateway |
| Agent memory | `packages/cli/src/pactile/agent/memory/` | memory scope、artifact、durability、read tool 和记忆 Port | Memory/Artifact Port | `implementation` / `partial integration`；Protocol `memory.read` 尚未成为唯一公开能力 |
| Agent context | `packages/cli/src/pactile/agent/context/`、`context-pipeline.ts` | Context 组装、policy、summary、compaction 调用边界 | Retrieval + Compression + Memory ports | `implementation`；现有 pipeline 仍混合提案、授权和执行，目标是拆分 Controller |
| Agent retrieval | `packages/cli/src/pactile/agent/retrieval/` | Agent 侧请求、scope、policy、route、ranking、explain 和 adapter Port | Retrieval contracts → provider/worker ports | `implementation` / `local integration seam`；详见[检索 bounded context](retrieval-bounded-context.zh-CN.md) |
| Native Pi agent | `packages/cli/src/pactile/agent/pi/` | Pi-derived loop、agent、stream 和类型适配 | Agent Port ← Pi runtime adapter | `implementation`；Pi 源码仍是可修改的 vendored runtime，未宣称完整接入 |

## 3. Context Governance 模块

Context Governance 是当前最重要的跨模块开发线，包含 Retrieval、Compression、Memory、DecisionProvider 和 Evaluation 五个相互协作但不能互相越权的模块。

### 3.1 Retrieval / Search

| 子模块 | 当前代码 / 文档 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Retrieval contract | `agent/retrieval/contract.ts`、`retrieval/types.ts` | Request、candidate、provenance、Retrieval ABI V3 | `implementation` |
| Retrieval policy | `agent/retrieval/policy.ts`、`retrieval/planner.ts` | readiness、assurance、policy ceiling、plan decode 和 fingerprint；fail closed | `implementation` |
| Retrieval router/ranking/explain | `agent/retrieval/{router,ranking,explain}.ts` | canonical intent order、稳定排序和脱敏计划解释 | `implementation` |
| Local Worker | `retrieval/adapters/local-worker.ts`、`local-worker-process.ts` | exact/structural 分支、进程隔离、abort/timeout、generation fence | `implementation`；本地候选适配器已冻结，完整 Controller 接入仍需证据 |
| SemanticProvider | 设计：[01-semantic-provider-contract](context-governance/retrieval/01-semantic-provider-contract.zh-CN.md) | Embedding 候选发现、排序、去重和聚类建议 | `design`；阶段 2 shadow，未接真实模型/索引 |
| DecisionProvider retrieval planning | `pactile/decision/`、`retrieval/jev-planning.ts`、`task/session-retrieval-jev.ts` | Jev/rule 对检索计划给 typed judgment；不能直接搜索、授权或增加 external | `implementation` / `design shadow` |
| External Search | [13-retrieval-search-service-design](context-governance/retrieval/13-retrieval-search-service-design.zh-CN.md)、[07 Search→Fetch→Evidence](context-governance/retrieval/07-external-search-fetch-evidence.zh-CN.md) | SearchHit、FetchRecord、EvidenceRecord 和外部 citation | `design`；`P0_REVIEW_BLOCKED`，没有真实 provider、Fetch adapter 或外部调用 |
| Inspect/freshness/fence | [04-inspect-freshness-fence](context-governance/retrieval/04-inspect-freshness-fence.zh-CN.md) | 当前源读取、scope、revision、generation、hash 和 freshness 检查 | `design` / 部分 Port seam |
| Candidate fusion/fallback | [05](context-governance/retrieval/05-candidate-pipeline.zh-CN.md)、[06](context-governance/retrieval/06-fallback-degradation.zh-CN.md) | canonicalize、dedupe、RRF、coverage、abstain、degraded/blocked | `design` / P0 blocked |

检索 Controller 只拥有候选发现、合并、Inspect 和 `RetrievalPackV1`；不拥有权限、Evidence、Context 改写或 Memory。

### 3.2 Compression / ContextUnitizer

| 子模块 | 设计位置 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| ContextUnitizer | 目标 `agent/compression`；现逻辑仍散在 `agent/context` / pipeline | 将 transcript、RetrievalPack、Artifact 变成带 cursor、hash、anchor、protection class 的 ContextUnit | `design`；P0 契约已写，运行时 decoder/Controller 未闭合 |
| ContextUnitManifestV1 | `docs/architecture/context-governance/compression/context-unit-manifest-v1.zh-CN.md` | unit identity、manifest generation、supersedes、CAS、read-back 和 pointer | `design`；全部 hash 仍是 pending，占位值不是证据 |
| Protection / anchor policy | 同上 §4–§6 | exact/protected/pointer_only/compressible/unknown 分类和 anchor 保留 | `design`；必须 deterministic，unknown fail closed |
| Compression Controller | 目标 `agent/compression/controller` | 只提交 `CompressionDecisionRequest`，不授权、不执行动作、不持 lease | `design`；当前 pipeline 仍是过渡实现 |
| Compression Decision Chain | `compression-decision-chain-v1.zh-CN.md` | S1 admission → S2 manifest → S3 policy check → S4 advisory → S5 gate → S6 commit → S7 Pi → S8 audit → S9 disclosure → S10 memory.read → S11 continuation | `design`；P0 不执行真实 compaction |
| Policy Gate / Approval | 目标 `capabilities/policy` | 对 CDQ 做确定性 allow/deny/review；`review_required` 必须新 admission | `design`；当前缺最终 Host/EffectGateway |
| Pi compaction executor | `runtime/pi-session-manager.ts`、`runtime/pi-executor*`、`agent/pi/` | 执行已批准的 compaction，写入 session tree，提供版本和 epoch fence | `implementation` / `partial`；session tree、版本锁定和恢复仍有阻断 |
| Post-compaction audit | 目标 `agent/compression/audit` | 17 项 CAR 检查、恢复/扩大/阻断、supersession 和 regression case | `design`；未形成完整运行时权威 |

### 3.3 Memory / Memory Port

| 子模块 | 当前代码 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Memory scope | `agent/memory/scope.ts` | scope、权限、可读范围和 policy 约束 | `implementation` / `partial integration` |
| Artifact store | `agent/memory/artifact-store*`、`runtime/stores/artifact/` | immutable content、hash、读回和 staged write | `implementation`；ArtifactStore 物理拆分已有 focused 验证记录 |
| Manifest durability | `agent/memory/durability*`、`runtime/context-governance-artifacts.ts` | Manifest CAS、receipt、audit 和 current pointer | `implementation` / `partial`；read-back identity、RunLedger 对账仍是阻断 |
| `memory.read` | `agent/memory/read-tool.ts`、`runtime/context-governance-memory-read*.ts` | pointer + manifest + generation + hash + scope 校验后的确定性读取 | `implementation` / `partial`；尚未作为唯一 Protocol capability 暴露 |
| Memory commit/promotion | `runtime/context-governance-memory-commit.ts`、Kernel command 目标 | 记忆写入、promotion、scope 变更和审批 | `design`；promotion 只能由 Kernel command/approval/evidence 完成 |
| Memory retention/purge | 文档开放问题 | Artifact 保留期、失效 citation 和清理 | `design`；尚无完成的 retention 策略 |

记忆内容不是第二个 Kernel。Memory Port 只负责 pointer、manifest、权限、revision、generation 和 hash 的读取校验；Agent 不能绕过 Protocol 读取 Runtime Store、transcript 文件或 Artifact 目录。

### 3.4 Evaluation Controller

| 子模块 | 设计位置 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Evaluation Controller | `implementation/04-evaluation-controller.zh-CN.md`；目标 `context-governance/evaluation/` | fixture registry、paired run、fault injection、report 和 `plane=evaluation` facts | `design`；旧 harness 不是当前产品 Controller |
| Retrieval evaluation | `retrieval/10-evaluation-matrix.zh-CN.md` | exact/structural/semantic/fallback 的分支指标和负例 | `design` / P0 blocked |
| Compression & Memory evaluation | `compression/compression-memory-evaluation-matrix-v1.zh-CN.md` | CM-B01…B26、fixture/gold/negative、zero-tolerance 和 paired arms | `design`；fixture/hash 仍 pending |
| Evidence / review binding | `review/`、Kernel Review services | 把 candidate、fixture、evaluationRunId、manifest 和报告绑定给 Review | `implementation` / `partial` |

Evaluation 只能产生 evaluation facts，不能写产品 Run、Kernel Evidence、receipt 或改变 runtime 状态。

## 4. Runtime 与持久化模块

| 模块 | 当前代码 | 作用 | 目标权威 | 当前状态 |
| --- | --- | --- | --- | --- |
| Workspace Agent Host | `runtime/runtime-host.ts`、`workspace-admission.ts` | composition root、每 workspace writer、Worker Supervisor、Recovery、Protocol Server 生命周期 | 唯一 Host | `implementation` / `PoC`；完整 Host 尚未实现 |
| RunLedger / Effect ledger | `runtime/run-ledger.ts`、`run-ledger-effect-receipts.ts` | Run、Attempt、Effect、Receipt、Settlement、Lease/Epoch 和 outbox | `RunLedgerV1` 唯一权威 | `implementation seam`；设计文档仍标为未实现，当前 RuntimeStore 不能当最终权威 |
| Runtime Store | `runtime/sqlite-runtime-store.ts`、`runtime/stores/sqlite/`、`store-port.ts` | 迁移期 Session、Checkpoint、Artifact、Manifest、Receipt、audit 等协调数据 | 兼容读模型/适配器 | `implementation`；SQLite 物理拆分已有 focused 验证，权威收敛仍未完成 |
| Product Kernel adapter | `runtime/sqlite-product-kernel-store.ts`、`runtime/stores/kernel/` | SQLite 到 Product Kernel Port 的映射 | Kernel Port implementation | `implementation`；与 RunLedger 事务边界仍需统一 |
| Artifact adapter | `runtime/file-artifact-store.ts`、`runtime/stores/artifact/` | content-addressed 文件、fsync/atomic rename、读回校验 | Artifact Port implementation | `implementation`；P8 物理拆分已有 focused 验证记录 |
| Pi executor/runtime | `runtime/pi-executor*`、`runtime/pi-rpc-host.ts` | Pi process/RPC、binding、attempt、idempotency、outcome、result | Pi Executor Port | `implementation` / `partial integration` |
| Pi Session Manager | `runtime/pi-session-manager.ts` | Pi SessionManager v3 adapter、checkpoint/tree seam | Session Port | `implementation candidate`；真实 tree/branch/fork 与版本锁定未验证 |
| Recovery / settlement outbox | `runtime/settlement-outbox-projector.ts`、runtime recovery helpers | unknown effect、settlement projection、重启恢复和只读重建 | RunLedger/Host | `implementation seam`；完整 reconcile 未闭合 |
| Canonical paths / Unicode | `runtime/canonical-paths.ts`、`case-fold.ts`、`unicode-nfc*` | 跨平台路径、安全边界、NFC 和生成数据 | shared/runtime adapter | `implementation`；不得被上层当业务事实 |

## 5. Capability、Provider 与 Integration 模块

| 模块 | 当前代码 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Capability catalog/contract | `capabilities/contract.ts`、`bounded-contract.ts`、`shared.ts` | 能力描述、schema、scope、bounded input/output | `implementation` / `partial` |
| Capability discovery/read | `capabilities/discover.ts`、`read.ts`、`workspace.ts`、`node.ts` | 宿主 capability 事实和可用性观察 | `implementation` |
| Capability command/executor | `capabilities/command.ts`、`claim.ts`、`receipts.ts` | command、claim、effect receipt 和可审计出口 | `implementation seam`；最终 EffectGateway 尚未闭合 |
| Provider registry/probes | `providers/`、`adapters/provider/` | Provider descriptor、探测、Pi AI adapter 和健康观察 | `implementation` / `partial` |
| DecisionProvider registry | `decision/provider-registry.ts`、`rule-provider.ts`、`model-catalog.ts` | rule/model/external provider 注册、model profile 和 typed advice | `implementation`；Jev retrieval shadow 仍是设计阶段 |
| Jev integration | `jev/`、`task/session-jev*`、`retrieval/jev-planning.ts` | Jev outbound、project policy、response decode、scheduler/retrieval advice | `implementation` / `partial`；外发必须独立授权，旧 smoke 不能代表质量 |
| SemanticProvider integration | 目标 `integrations/semantic`；当前无真实 adapter | embedding、generation、index、readiness、fallback | `design`；未接真实模型/索引 |
| Search/Fetch integration | 目标 `integrations/search-fetch`；当前只有 capabilities/search 与文档 seam | 外部 Search、Fetch、Evidence、SSRF/egress | `design`；P0 blocked |
| Local Worker integration | `retrieval/adapters/local-worker*` | exact/structural worker 进程、transport、abort、late answer discard | `implementation candidate` |
| Middleware/resolver | `middleware/` | manifest load、input validation、provider resolution、candidate policy、redaction | `implementation`；属于准入边界，不是 Kernel |
| Generic adapters | `adapters/` | 外部 Provider/SDK 到内部 Port 的映射 | runtime/integration → contracts | `implementation` / `partial` |

所有远程 Provider、Jev、Search、Fetch 都必须经过 capability snapshot 和 `egress.authorizationRef`。没有授权时，任何组件都不能向远程端点发送源码、facts、路径、transcript 或 query 上下文。

## 6. 编排、接口和客户端模块

| 模块 | 当前代码 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Context Governance Coordinator | 目标 `context-governance/coordinator/`；当前逻辑散在 `context-pipeline.ts`、runtime producer | admission → retrieval → unitize → compression request → audit → continuation 的编排 | `design`；现有 pipeline 是迁移过渡，不是最终 Coordinator |
| Coordination / ledger / trace | `coordination/` | message ledger、journal、state、trace、kernel resume 和 runtime tracing | `implementation`；与旧 ledger 语义仍有重叠，需收敛唯一事实源 |
| Lifecycle | `lifecycle/` | command runner、default adapters、host skill renderer、project files 和迁移生命周期 | `implementation`；用例和 composition root 仍需分离 |
| CLI / Task use-cases | `task/`、`exit/`、CLI command 入口 | task creation、session context/pack、strategy、workflow phase、Jev receipt 和用户命令 | `implementation`；不能绕过 Kernel/Host 直接写事实 |
| Parallel execution | `parallel/` | batch、并行策略、bounded execution | `implementation`；只负责执行策略，不拥有任务事实 |
| Worktree | `worktree/` | git probe、manager、lifecycle、cleanup、integration evidence | `implementation`；工作区边界和证据，不是产品 Kernel |
| Verification | `verification/` | Git observer、Jev advice、verification planner、receipt 和 types | `implementation` / `partial`；结果必须绑定 candidate/fixture/evidence |
| Review | `review/` | review contract、evidence 关联和审查输入 | `implementation` / `partial`；不能自行 Close Task |
| Projection | `projection/` | versioned snapshot、delta、ledger、operation、ownership、plan 和 managed block | `implementation`；只读事实投影 |
| Protocol | `protocol/` | IO envelope、interface 和客户端可消费 contract | `implementation` / `partial`；正式 Agent schema 尚需统一 |
| Registry / composition metadata | `registry.ts` | 模块、adapter、provider 或 public export 的注册入口 | `implementation`；只能作为组合入口，不持有领域事实 |
| Tile compiler/selection | `tiles/` | tile catalog、YAML 安全解析、编译、selection、Jev advice 和 receipts | `implementation`；属于建议/配置能力，不拥有 Kernel 事实 |

## 7. Pactile App 模块

`apps/pactile-app/` 是并行 UI 产品面，不是第二个 Agent。

| 模块 | 当前目录 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| App Protocol | `apps/pactile-app/protocol/` | snapshot、delta、receipt、runtime event、command tracker、replay、selector 和 validator | `implementation`；fixture/replay 测试与 renderer build 已有文档证据 |
| App Renderer | `apps/pactile-app/renderer/` | React 页面、Attention、Project/Goal history、Receipt/Runtime event disclosure、UI primitives | `implementation`；不能写 Agent facts |
| App Fixtures | `apps/pactile-app/fixtures/` | protocol fixture、demo bridge、workbench 和故障场景 | `implementation` / `fixture only`；不等于真实 Agent 接入 |
| App Main | `apps/pactile-app/main/` | Electron Main、Agent transport 目标 | `design` / `not implemented` |
| App Preload | `apps/pactile-app/preload/` | contextIsolation 下的窄桥目标 | `design` / `not implemented` |
| App release boundary | app root / CI allowlist | 独立 lockfile、verify、发布 artifact 和根 CI 纳入决策 | `design` / `partial`；尚未接真实 Agent transport |

Renderer 只能读取版本化 Protocol；它不读取 Runtime Store、Transcript、Memory、Artifact 或 Kernel 文件，也不自行推导“完成”“结算”或“可执行动作”。

## 8. 迁移、兼容和安全边界模块

| 模块 | 当前代码 | 作用 | 当前状态 |
| --- | --- | --- | --- |
| Compatibility | `compat/`、`core/pactile`、`core/task` barrels | 保持旧包路径、任务格式和外部 API 的转发/版本映射 | `implementation`；只能 re-export，不能新增业务规则 |
| Migration | `migration/`、`kernel/task/legacy/` | 旧 Task、旧 lifecycle、旧 batch 和旧 artifact 的读取/迁移 | `implementation` / historical support；不是新的 Node-only active path |
| Adoption | `adoption/` | source discovery、inventory、bindings、safety 和 adoption workflow | `implementation` / tooling；不属于 Agent Runtime truth |
| Pi policy | `pi/policy/` | container、launch、paths、extension、sandbox、decision、receipt policy | `implementation` / partial integration |
| Pi bridge | `pi/bridge/`、`pi/rpc.ts`、`pi/v2-dispatch.ts` | Pi task bridge、RPC、dispatch、review workspace 和 evidence | `implementation`；P7 bridge 子职责拆分已有 focused 记录，完整产品接入仍需 Runtime/Host |
| Release / CI/CD | `.github/`、package scripts、release docs | `main` 单分支保护、feature merge、typecheck/lint/test/build、发布 | `design / repository governance`；不属于 Agent Runtime 模块 |

兼容和迁移模块可以依赖 canonical 模块，但 canonical 模块不能依赖兼容层。历史证据、旧 harness、旧 MyHarness 候选不能自动升级为当前 Pactile 的 verified 或 published 证据。

## 9. 当前开发主线与先后关系

```text
P0 contract / fixture / ownership freeze
          ↓
1a deterministic baseline
  exact + structural + Inspect + artifact/manifest dry-run
          ↓
1b Host runtime baseline
  RunLedger + lease/epoch + EffectGateway + recovery
          ↓
2 SemanticProvider shadow
          ↓
3 DecisionProvider / Jev retrieval shadow
          ↓
4 Jev compression shadow
          ↓
5 reversible compression + deterministic memory.read
          ↓
6 low-risk lossy（需正式授权）
          ↓
7 Kernel-routed memory promotion
```

外部 Search/Fetch/Evidence 是独立能力线：必须先完成 P0 的 egress、URL canonicalization、Artifact retention、SSRF/redirect/timeout/cancel 和 evidence invalidation 规则，再进入适配器实现。它不能因为 SemanticProvider 或 Jev 已存在就自动开启。

## 10. 目前最重要的结构性阻断

1. `RunLedgerV1`、唯一 Lease/Epoch、EffectGateway、Policy Gate 和 Workspace Agent Host 尚未成为最终运行时权威；当前 RuntimeStore 仍是迁移期 seam。
2. Compression Controller、ContextUnit/Manifest、Pi session tree compaction、post-compaction audit 和 deterministic `memory.read` 还没有形成完整可恢复链路。
3. Retrieval Controller 的本地候选 seam 存在，但 external Search/Fetch、SemanticProvider 和完整 Agent Context 接入没有 verified evidence。
4. Evaluation Controller、fixture registry、gold/negative labels、candidate tree hash 和正式 evaluationRun 证据仍需 P0 冻结。
5. App 有 fixture/replay 和 renderer build 证据，但尚未接入真实 Agent Protocol、Electron Main/Preload 或生产发布链路。
6. 旧 `core/*`、`compat`、`migration`、RuntimeStore、message ledger 和部分 lifecycle 仍需继续收敛，不能把兼容入口误认为新的稳定边界。

## 11. 模块变更的统一验收规则

每个模块的变更都应绑定：

- design record、owner、显式 write set 和稳定 public surface；
- typecheck、lint、受影响 focused tests、build 和 integration evidence；
- 运行时模块的 admission、lease/epoch、幂等、crash/recovery、unknown-effect reconciliation；
- Provider/外发模块的 capability snapshot、privacy/egress、failure/fallback 和日志脱敏；
- 跨模块实体的 source hash、generation、revision、provenance、receipt 和可恢复指针；
- `implementation`、`integrated`、`invoked`、`verified`、`published` 的分别证明。

模块目录清晰不等于模块已经完成。当前最高可以直接确认的是：canonical 源码和设计边界已经盘点；具体模块仍需按各自 gate 逐步升级状态。

## 12. 主要参考

- [功能点多模块架构与迁移基线](pactile-feature-modular-monolith.zh-CN.md)
- [物理目录拆分计划](pactile-physical-decomposition-plan-20261008.zh-CN.md)
- [ownership / dependency 表](context-governance/implementation/02-ownership-dependency.zh-CN.md)
- [Context Governance 阶段计划](context-governance/implementation/03-stage-plan.zh-CN.md)
- [Compression & Memory 重新基线报告](context-governance/compression-memory-rebase-report.zh-CN.md)
- [Compression Decision Chain v1](context-governance/compression/compression-decision-chain-v1.zh-CN.md)
- [ContextUnit 与 Manifest](context-governance/compression/context-unit-manifest-v1.zh-CN.md)
- [检索与搜索服务设计](context-governance/retrieval/13-retrieval-search-service-design.zh-CN.md)
- [Pactile App README](../../apps/pactile-app/README.zh-CN.md)
