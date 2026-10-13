# 三条线 ownership / dependency 表（proposed）

- 状态：proposed（P0 冻结候选）。本文是设计与证明义务，不表示任何强制机制已经实现。
- P0 裁定：`08-p0-admission-decision.zh-CN.md`；其中与 ownership 直接相关的 10 条收紧见本文 §0，契约字段见 `09-contract-entities-v1.zh-CN.md`。
- 依据：架构 §23.1、§23.3、§26.3、§27.2、§27.9；契约见 `01-contract-draft.zh-CN.md`。
- 读法：每个“目标”断言都标注**现状**。凡现状为“未实现”的，只能写成设计约束，不能写成已有保证（架构 §23.3.1 末段同理）。

## 0. P0 裁定后的 ownership 收紧（依据 `08`）

以下 10 条是 P0 冻结的 ownership 断言。它们不是新机制，而是对 §2 ownership 表与 §5 禁止项的收紧表述；每条都必须在对应阶段有证伪测试（§6）。

| # | 断言 | 机制 / 字段 | 现状 |
| --- | --- | --- | --- |
| O-1 | **Workspace Agent Host 是唯一运行时入口**（composition root）。三个 Controller 不能自建 Host、不能自启 Supervisor 或 Protocol Server | Host 构造注入；`02` §1 拓扑 | 未实现 |
| O-2 | **`RunLedgerV1` 是产品 Attempt / Effect / Receipt / Settlement 的唯一权威**，也是唯一 Lease/Epoch 权威；CDR / CAR 只是 Effect Receipt 的 typed payload | `operationId` 入账 + `EffectLedgerEntryV1` 对齐 | 未实现；现候选用 RuntimeStore（DEF-IMPL-2） |
| O-3 | **Coordinator 只负责编排**：admit → 派发 → 汇集 → 提交请求。其内部状态必须可从 RunLedger + Artifact 重建；`contextOperationId` 的**分配**在 RunLedger 记账 | F-3 / F-10 | 未实现 |
| O-4 | **Retrieval Controller 只负责**检索计划、候选发现与合并、Inspect、`RetrievalPackV1`；不授权、不改写上下文、不碰 Memory | F-1 / F-7；PK-1…6 | 部分（Worker 冻结候选） |
| O-5 | **Compression Controller 只提交 `CompressionDecisionRequest`**；不自行授权、不直接执行动作、不持 EffectGateway 句柄 | F-2 / F-7；CDQ 字面量 `submittedBy` | 未实现 |
| O-6 | **Evaluation Controller 只产生 evaluation fact**（`plane=evaluation`）；不改变产品 Run 状态、不改 gold、不提 Evidence | ISO-1…8；`affectsProductRun: false` | 未实现 |
| O-7 | **Jev 与 EmbeddingGemma 是 advisory / provider**：无权限、无事实、无 Evidence 权；失败只能降级为确定性路径 | `provenance.authority` 只允许 `advisory`；PCS `availability` 以 probe 为准 | 部分（`decision/contract.ts`） |
| O-8 | **Artifact / Manifest / Receipt / Evidence 通过既有 Port 关联**：不新增 store、不新增第二套 memory durability；Evidence 只由 Kernel 命令提交 | `01` §6 挂接表；C8 | 部分（port 已存在） |
| O-9 | **跨线互通只能走实体 + 端口**：禁止隐式全局缓存、共享可变内存、模块级单例、直接读 SQLite / Runtime Store 文件。产品数据只能经 `memory.read` 能力读取 | F-1 / F-3 / F-8 | 未实现 |
| O-10 | **不创建第二个 Host / Kernel / RunLedger / Memory / Receipt / Recovery authority**；迁移期旧 `RuntimeStore` 只能退为兼容读模型 | C2 / C9；架构 §23.3.1 | **目前不满足**（§26.3） |

三条附带的 P0 边界（写入 ownership 而非阶段计划）：

1. **唯一写入者**：同一运行时文件不得被两条线交错写入（BL-17）；阶段 1 前必须指定唯一写入者与新的 Review 入口（`08` §2.2）。
2. **阶段 1 不写 workspace index**：确定性 baseline 默认只读；后续两种方案（EffectGateway 写 effect / 外置 `indexDir`）只记录，不选择（`08` §3.2）。
3. **外发 deny-by-default**：没有 capability policy 与 `egress.authorizationRef` 时，任何组件都不得向远程端点发送源码、facts、路径或 transcript（`08` §3.4）。该规则是 ownership 级约束，不是配置默认值。

## 1. 物理归属（目标）

```text
Workspace Agent Host                             ← 唯一运行时入口；每工作区一个 writer
  ├─ RunLedgerCoordinator / RunLedgerV1          ← 唯一 Run / Attempt / Effect / Receipt / Settlement 与 Lease·Epoch 权威
  ├─ Policy Gate (deterministic) / Approval      ← 对 CompressionDecisionRequest 做准入
  ├─ EffectGateway                               ← admission · lease · intent · receipt · 审计；副作用唯一出口
  ├─ Artifact Store + Manifest Port + Memory Port← 不可变内容 · Manifest CAS · memory.read / commit
  ├─ Product Kernel (store + commands)           ← 产品事实与 Evidence、Gate、Close、Settlement
  ├─ Context Governance Coordinator              ← 只做编排（admit → 派发 → 汇集 → 提交请求）
  │    ├─ Retrieval Controller + Workers         ← 候选发现 / 合并 / 排序 / Inspect / RetrievalPack
  │    ├─ Compression Controller + ContextUnitizer ← ContextUnit / Manifest / Judgment / DecisionRequest
  │    └─ Evaluation Controller（离线，plane=evaluation）← fixture · runner · paired · fault injection · report
  └─ Provider adapters                           ← DecisionProvider(Jev/rule) · SemanticProvider(EmbeddingGemma 可选) · Pi compaction · Search/Fetch
```

## 2. ownership 表

“拥有”只指**事实或副作用的权威**。Controller 的内部状态必须可由 RunLedger + Artifact 重建，不构成权威。

| # | 组件 | 角色 | 拥有（权威） | 明确不拥有 | 现状 |
| --- | --- | --- | --- | --- | --- |
| 1 | Workspace Agent Host | 运行时入口与 composition root | Session Registry、Runtime Store、Journal、Artifact Store、Worker Supervisor、Recovery、Protocol Server 的生命周期 | Kernel 事实的内容 | 未实现（`runtime-host-poc.ts` 为内存 PoC；`openPactileRuntimeHost` 仅 store 组合启动器） |
| 2 | RunLedgerCoordinator / `RunLedgerV1` | 产品执行提交入口 | Run 状态、Attempt、Effect ledger、receipt、dispatch outbox、**唯一** Lease/Epoch | ContextUnit 全文、embedding 向量、Controller 内部状态 | 未实现（§26.1#8、#9 未冻结） |
| 3 | Product Kernel | 产品事实 | Project/Goal/WorkItem/Block、policy、approval、Evidence、Gate、Close、CompletionDecision、Settlement | 评测结果、模型判断、检索相似度 | 部分（`SqliteProductKernelStore`、`settleRun`；未与 RunLedger 同一事务边界） |
| 4 | Policy Gate + Approval | 对 CDQ 的确定性准入 | 准入裁决（verdict）与 `policyVersion` | 候选发现、压缩提案、授权材料本身（grant 由用户 / Kernel 命令产生） | 未实现（`decideCompactionV1` 是纯函数；授权目前发生在 Pipeline 内，已过时，见 00 §4.2#4） |
| 5 | EffectGateway | 副作用出口 | effect intent / receipt、admission、审计 | 业务决策 | 未实现（本线冻结候选的 `PactileRuntimeEffectReceiptPort` 以 RuntimeStore 为基础，是迁移 seam，见 DEF-IMPL-2） |
| 6 | Artifact Store + Manifest Port | 内容与 Manifest | 内容 hash、不可变 artifact、Manifest CAS 版本 | 压缩决定、授权 | 部分（`FileArtifactStore` + SQLite receipt/manifest/audit；Node 24 验证） |
| 7 | Memory Port（`memory.read` / commit） | Host 提供的记忆访问 | pointer / manifest / 权限 / revision / generation / hash 的读取校验 | 记忆内容的解释 | 部分（durability port 与 `preflight`；未作为 Protocol 能力暴露） |
| 8 | Context Governance Coordinator | 编排 | 无（可重建的编排状态；`contextOperationId` 的**分配**在 RunLedger 里记账） | 任何 Run、receipt、evidence、lease | 未实现 |
| 9 | Retrieval Controller（+Workers） | 候选发现 | 无（pack 是派生物，落 Artifact） | 授权、Evidence、Context 改写、Memory | 部分（Worker 冻结候选 d25d33；`pactile/retrieval` adapter） |
| 10 | Compression Controller（+ContextUnitizer） | 单元化与提案 | 无 | 授权、副作用、receipt、lease、Kernel 写入 | 未实现（`PactileContextPipeline` 把提案、授权与执行揉在一起，已过时） |
| 11 | Evaluation Controller | 离线评测 | **仅** evaluation fact（`plane=evaluation` 的 EC/ERM/PCR 与评测期的 Controller 实体） | 产品 Run 状态、Policy、gold 的事后修改、Kernel Evidence | 未实现（旧 harness 是各桶的一次性 driver） |
| 12 | SemanticProvider（EmbeddingGemma 可选） | 可替换 provider | 无 | DecisionProvider 角色、总检索引擎、Evidence authority、Web Search | 未实现；无调研产物 |
| 13 | DecisionProvider（Jev / rule） | advisory typed judgment | 无 | 权限、事实、Evidence | 部分（`decision/contract.ts`；Rule provider；Jev smoke 为旧候选） |
| 14 | Pi compaction executor | 执行**已批准**的 compaction | 无 | 授权、摘要事实性 | 部分（外部 Pi RPC 路径；native 路径未接） |
| 15 | Retrieval Worker | exact/structural 分支实现 | 无 | RetrievalPack、corroboration | 冻结候选 |
| 16 | Protocol / Clients（TUI、App） | 只读 versioned snapshot / event | 无 | 写 Kernel、transcript、memory | 未实现 |

## 3. 实体的生产 / 消费 / 持久化

| 实体 | 产生者 | 直接消费者 | 持久化与权威 |
| --- | --- | --- | --- |
| RP | Retrieval Controller（由 Coordinator 请求） | Retrieval Controller、Evaluation Controller（回放） | Artifact；RunLedger 仅记操作条目 |
| RC | Retrieval Controller / Worker 适配 | 同上 | Artifact |
| RK | Retrieval Controller | Compression Controller（作为 `retrieval_item` 输入）、Agent 上下文装配 | Artifact（`packHash`）；RunLedger 记 `packHash + outcome` |
| CU / CM | Compression Controller（ContextUnitizer） | Policy Gate（经 CDQ）、Evaluation Controller | CM → Artifact + Manifest Port；CU 以 `unitRefs` 进入 CM |
| CJ | DecisionProvider（经 Compression Controller 封装） | Compression Controller、Policy Gate（经 CDQ 引用） | Artifact（advisory） |
| CDQ | Compression Controller | Policy Gate | Artifact；RunLedger 记 `requestId` |
| CDR | Policy Gate（经 EffectGateway 入账） | Compression Controller、Pi compaction 调度、审计 | **RunLedger Effect ledger 条目** + Artifact payload |
| CAR | Compression Controller 的 audit 步骤（由 Host 触发） | Policy Gate（决定恢复 / 扩大 / 阻断）、Evaluation Controller | RunLedger Effect ledger 条目 + Artifact payload |
| EC / ERM / PCR | Evaluation Controller | Review（按 hash 引用） | 评测结果根目录；**不**进 RunLedger / Kernel |
| PS / FR（T2） | Host / Policy（PS）；消费方重算（FR） | Policy Gate、Memory Port、全部上下文实体 | 随宿主实体；**不**单独持久化为权威；`PS.actions` 唯一四位 |
| IR（T2） | Inspect 端口（Retrieval Controller 调用） | RK、CAR check、`memory.read` 对账 | 字段表唯一位置 = `01` §4.4（含 additive 字段与 `InspectCheckV1`）；检索线不得再列字段表 |
| RT（T2） | Host / Memory Port 签发 | Agent `memory.read`、CAR check #14 | 随 Host 记录；token 不是权限 / Evidence；runtime / evaluation **共用同一 schema**，平面互斥见 `09` §1.2.3 |
| CMP（T2） | Manifest Port（CAS） | `memory.read`、CAR check #13、S2 durable 对账 | Manifest store；不是 Kernel fact |

跨线数据只走这张表中的**实体与端口**。例如 Retrieval → Compression 的数据流是 “RK 落 Artifact → Compression Controller 通过 Artifact Port 读取”，不是共享内存。

## 4. 允许的依赖（调用方 → 被调用方，经哪个端口，携带什么实体）

| 调用方 | 被调用方 | 端口 / 方式 | 实体 |
| --- | --- | --- | --- |
| Host | Coordinator | 构造注入 | — |
| Coordinator | RunLedger | `RunLedgerPort`（operation admit；读取 lease proof） | `contextOperationId` 条目 |
| Coordinator | Retrieval Controller | 进程内调用，带 deadline + cancel signal | RP → RK |
| Coordinator | Compression Controller | 进程内调用 | CM → CDQ |
| Coordinator | Policy Gate | `PolicyGatePort` | CDQ → CDR |
| Policy Gate | EffectGateway | `EffectGatewayPort` | effect intent / receipt |
| EffectGateway | RunLedger / Artifact / Manifest / Pi compaction executor | 各自端口 | receipt、manifest、compaction 请求 |
| Compression Controller | DecisionProvider | `DecisionProviderV1` 端口 | CJ（失败为 `ObservedV1` 非 ok） |
| Retrieval Controller | SemanticProvider | `SemanticProviderPort`（待定义，Retrieval 线 `01`） | RC.semantic |
| Retrieval Controller | Worker | 进程边界 RPC（abort/timeout 靠终止进程） | RC |
| Retrieval Controller | Inspect | 只读工作树读取端口 | `InspectResultV1` |
| 任意 Agent 读取记忆 | Memory Port | Host / Protocol 能力 `memory.read` | pointer → 内容（含校验） |
| Evaluation Controller | Controller 代码 | **库调用**，注入 evaluation 平面的 fake / 隔离端口 | 评测期实体 |
| Evaluation Controller | 产品数据 | **只读快照导出** | `snapshotHash` |
| Coordinator / Compression Controller | Manifest Port | `ManifestPort`（CAS current pointer + expected revision；只读向后验证） | `CurrentManifestPointerV1` |
| Agent 重读路径 | Memory Port | capability `memory.read` + Host 签发的句柄校验 | `RestoreTokenV1` → 校验后返回内容 |
| Clients | Host | Protocol（版本化命令 / 查询） | 只读投影 |
| 任意组件 | 远程 provider / Search / Fetch | `SemanticProviderPort` / `DecisionProviderV1` + capability policy | 需 `PCS.egress = { destination: "remote", authorized: true, authorizationRef }`；否则拒绝 |

## 5. 禁止的依赖与执行机制

| ID | 禁止 | 执行机制（设计） | 证伪测试（P0 起建） |
| --- | --- | --- | --- |
| F-1 | Controller 直接读写 Runtime Store / SQLite | 静态依赖规则：`context-governance/**` 不得 import `runtime/stores/**`、`node:sqlite`；只通过端口 | 依赖边界测试（沿用现有 `dependency-boundary.test.ts` 的做法） |
| F-2 | Controller 写 Kernel store 或持有 lease | Kernel store 的写入口只接受带 lease proof 的 Host 调用；Controller 构造时拿不到该端口 | 构造注入测试：Controller 工厂签名中不含 Kernel 写端口 |
| F-3 | Controller 之间共享可变内存、模块级缓存、全局单例 | 无环境状态规则：Controller 实例只持有构造注入的端口；缓存只能作为 Artifact | 双实例隔离测试：两个 Coordinator 并行运行，互不可见对方状态 |
| F-4 | 评测写产品 store、持有 lease / epoch | ISO-4 / ISO-5：评测使用独立结果根与 fake 端口；EffectGateway 拒绝 `plane=evaluation` | Evaluation / 产品 Run 隔离测试（§27.8 新增门槛） |
| F-5 | 产品状态读取评测报告来推进 | ISO-6 / ISO-7：产品侧实体没有 `evaluationRunId` 字段；`affectsProductRun` 恒 `false` | decoder 负例 #1、#15；静态检查：runtime 模块不 import `evaluation/**` |
| F-6 | Embedding / Jev / Pi / Worker / Provider 直接成为 Evidence 或 Kernel fact | `provenance.authority` 只允许 `advisory`；Evidence 只由 Kernel 命令提交 | 权限提升负例：`advisory` → `kernel` 被 decoder 与 Policy Gate 拒绝 |
| F-7 | Retrieval / Compression 绕过 Policy Gate 调 EffectGateway | EffectGateway 只接受带 `CDR` 引用的 admission；Controller 无 EffectGateway 句柄 | 构造注入测试；EffectGateway 拒绝无 CDR 的请求 |
| F-8 | 主 Agent 绕过 Protocol 读取 Runtime Store / Transcript 文件 / Memory 内部对象 | `memory.read` 是唯一读取能力；文件 / store 路径不对 Agent 暴露 | 路径探测测试：Agent 工具集中没有可读取这些位置的能力 |
| F-9 | Client / App 写 Kernel、transcript、memory | Protocol 只暴露版本化命令；Renderer 只读投影 | 架构 §27.1#1 与现有 App 边界约定；Protocol 线测试 |
| F-10 | Coordinator 把自身状态当权威 | 启动时从 RunLedger + Artifact 重建；重建结果与持久前状态一致 | crash/replay fixture（§27.8 新增门槛） |
| F-11 | 直接读 SQLite 文件、Runtime Store 文件或另建索引 DB 作为“互通”手段 | 跨线数据只能走实体 + 端口；索引仅为派生物，不得成为第二事实源（`08` §3.2） | 路径探测 + 依赖边界测试：不存在对 `*.sqlite` / store 文件的直接读取 |
| F-12 | 两条线交错写同一运行时文件（无唯一写入者） | 每个运行时文件在任意阶段只能有一个写入者；变更必须走候选快照 + Review（BL-17） | 写集核对：同一阶段内两个 line 的 write set 不得有交集 |
| F-13 | 未经 capability policy 的远程外发 | `PCS.egress.authorized` 必须为 true 且带 `authorizationRef`；否则拒绝（deny-by-default） | 负例 #23；故障注入 FI-22；外发违规计数器必须为 0 |
| F-14 | 用解码文本 hash（`textHash`）充当 freshness fence 或 source hash | `InspectResultV1.fileHashRaw` / `CU.sourceHash` 只接受原始字节 hash（`08` §3.3）；二者同概念但不互换 | 负例 #25；Worker 文本 hash 不得通过 fence |

## 6. 证明义务：每条 “ownership” 断言如何被证实

| # | 断言 | 机制 | 证伪测试 / 证据 | 必须存在的阶段 | 现状 |
| --- | --- | --- | --- | --- | --- |
| C1 | Workspace Agent Host 仍是运行时入口 | Host 是 composition root；三个 Controller 只由 Host 构造 | Host composition 测试：没有 Host 就无法实例化 Controller | 阶段 1b | **未实现**（Host 本身尚无） |
| C2 | RunLedgerV1 仍是 Attempt / Effect / Receipt / Settlement 的权威 | CDR / CAR 只作 Effect Receipt 的 typed payload；入账靠 `operationId` | 对账测试：任一 runtime CDR 在 ledger 里必有对应 `operationId`，反之无孤儿 | 阶段 1b | **未实现**；现候选用 RuntimeStore（DEF-IMPL-2） |
| C3 | Coordinator 只做编排 | F-3、F-10 | 双实例隔离 + 重建测试 | 阶段 1b | 未实现 |
| C4 | Evaluation Controller 只产生 evaluation fact | ISO-1…8 | 隔离测试：评测运行前后，产品 store 的字节级 hash 不变；EffectGateway 拒绝 `plane=evaluation` | **阶段 1a**（评测先行） | 未实现 |
| C5 | Retrieval Controller 只负责候选发现、合并、排序、Inspect、RetrievalPack | PK-1…6；F-1、F-7 | 越权探测：Retrieval 代码路径中不存在对 Context / Memory / Kernel 的写端口 | 阶段 1a | 未实现 |
| C6 | Compression Controller 只提交 CDQ | CDQ 字面量 `submittedBy`；F-2、F-7 | 构造注入测试 | 阶段 1b | 未实现 |
| C7 | Embedding 与 Jev 是可替换 provider / advisory input | `authority:"advisory"`；provider 经 capability snapshot；失败为 `ObservedV1` 非 ok 并降级 | 替换测试：把 provider 换成 rule / noop，系统仍通过确定性 baseline；provider 故障注入 | 阶段 2 / 3 | 未实现 |
| C8 | Artifact / Manifest / Receipt / Evidence 通过已有 Port 关联 | 第 01 号 §6 的挂接表；不新增 store | 端口清单对账：新增的 manifest kind 之外，无新增 store / 表 | 阶段 1b | 部分（Artifact/Manifest/Receipt port 已存在；Evidence 只经 Kernel 命令） |
| C9 | 不存在第二套 Kernel / RunLedger / Memory Store / Receipt authority | F-1、F-2、C2、C8 | 同上 + 迁移期“旧 RuntimeStore 退为读模型”的对账（架构 §23.3.1） | 阶段 1b | **目前不满足**：RuntimeStore 同时存 Run、Effect、memory receipt、lease（§26.3） |
| C10 | 无隐式共享内存、全局缓存、直接读 SQLite | F-1、F-3 | 静态依赖规则 + 双实例隔离 | 阶段 1a 起 | 未实现 |

> **读法（修复轮）**：本表只说明每条断言的**证伪测试计划**，不代表已经执行。`现状` 列的取值只有 `未实现` / `部分` / `目前不满足` 三种，**没有任何一行是“已验证”**。执行状态与证据由 `03` 的各阶段 AC 与本线 `04` 的评测运行产生；截至本轮（P0 修复轮），全部行保持**未执行**。凡把本表任一行写成“已有证据 / 已证明”的叙述都是错的。

## 7. 实现顺序与跨轨依赖

Context Governance 的运行时动作（带 durable receipt 的 mask / externalize 等）依赖 Host 轨道的 `RunLedgerV1`、EffectGateway、Policy Gate；这些在架构 §25 中属于 P0–P2。因此阶段 1 被拆成两部分（见 `03-stage-plan.zh-CN.md`）：

| Context Governance 阶段 | 依赖的 Host 轨道前置 | 说明 |
| --- | --- | --- |
| 0 契约与评测冻结 | 无（文档）；CDR 对 `EffectLedgerEntryV1` 的引用以“按名未解析”冻结，待 Host P0 冻结后对齐 | 不改代码 |
| 1a 离线确定性 baseline（evaluation 平面） | 无 | 纯函数 + fake 端口；不产生任何产品 receipt；**默认不写 workspace index**（`08` §3.2） |
| 1b 运行时确定性 baseline（runtime 平面） | Host P1（lease / epoch）+ P2（intent / receipt / checkpoint / recovery scan） | 需要 RunLedger、EffectGateway、Policy Gate |
| 2 / 3 / 4 shadow | 评测平面无；运行时 shadow 需 Host P2 | shadow 不改变动作 |
| 5 可逆动作 | Host P2 + 1b 完成 | 首个有 lossless 恢复义务的运行时副作用 |
| 6 低风险 lossy | 同 5 + post-compaction audit 基础设施 | |
| 7 promotion | Kernel command 路由（Product Kernel） | Context Controller 不提交 |

这一拆分是**拟议**，需要评审（`06-blockers.zh-CN.md` BL-05）。

## 8. 现有端口清单（用于对账）

| 已存在 | 位置 | 用途 / 局限 |
| --- | --- | --- |
| `ContextMemoryDurabilityPort`（artifacts / receipts / manifests / audits / leases） | `agent/memory/durability` | Artifact、Manifest CAS、memory receipt；lease 仍是 Runtime Store 的，不是 RunLedger 的 |
| `RuntimeStorePort` | `runtime/store-port.ts` | 迁移后应退为兼容读模型 |
| `ProductKernelStorePort` | `kernel/store/product/port.ts` | Kernel 事实与 `settleRun` |
| `PiSessionManagerPort` / `PactileAgentSessionPort` | `agent/session/*` | 会话与 checkpoint seam（冻结候选） |
| `PactileProviderPort` | `agent/loop/provider-port.ts` | Provider/Stream（Batch 2A，已完成并有 focused 证据） |
| `DecisionProviderV1` | `decision/contract.ts` | Jev / rule 的 advisory 接口 |
| `PactileEffectReceiptPort` | `agent/effects/contract.ts` | **冻结候选**，非目标 EffectGateway |

| 缺失 | 说明 |
| --- | --- |
| `RunLedgerPort` / `RunLedgerV1` | Host 轨道 P0 |
| `EffectGatewayPort`、`PolicyGatePort` | Host 轨道 P2 / 本契约 CDQ→CDR |
| `SemanticProviderPort` | Retrieval 线 `01` 定义 |
| 只读工作树 Inspect 端口 | Retrieval 线 `04` 定义 |
| fixture registry、只读快照导出、评测结果根 | 本线 `04` 定义 |
| Protocol 的 `memory.read` 能力 | Protocol 线 |
