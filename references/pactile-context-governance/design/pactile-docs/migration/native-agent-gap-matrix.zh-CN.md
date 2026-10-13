# Native Agent Runtime Gap Matrix

## 本轮结论与证据口径

本轮在完成只读审计后，写入并验证了 Batch 2A Provider/Stream seam；这不是完整发布闭环。`D:\pactile` 为 canonical repository，当前 `develop` 尚无提交；本工作线未修改 `D:\MyHarness`、App 或全局 Agent 配置，未执行 commit/push/merge/tag/publish/deploy。

| 状态 | 本轮结论 |
| --- | --- |
| 代码存在 | Provider port、Pi AI adapter、wrapper 接线和 focused tests 存在 |
| focused test 通过 | Provider/Agent/dependency/probe/compaction focused 命令 5 files、24 tests 通过；本轮 Lifecycle/Projection/Ownership/Context/Native integration focused 命令 21 files、178 tests 通过，另有 durability 1 file、50 tests PASS；另有 typecheck/lint/build/docs smoke PASS |
| native loop 已接入 | `PactileNativeAgent({ providerRuntime })` 使用同一个 Pi-derived loop；显式 `streamFn` 仍只作测试/custom-host seam |
| 真实运行已验证 | 否；Models 和 stream 均为 fake/scripted，没有真实 Provider、网络、进程重启或并发主链证据 |
| E2E 已通过 | 否；既有 integration 不是 native Agent E2E |
| 可发布 | 否 |
| 已发布 | 否；`0.6.5` 仅是当前包版本 |

历史 332/167/74/42 tests 仍只作历史基线，不作为本轮 Provider 集成证据。下表“测试存在”与“本轮通过”继续分列。

路径缩写：`C/` = `packages/cli/src/core/pactile/`，`P/` = `packages/cli/src/pactile/`，`T/` = `packages/cli/test/`。

## 主链 Gap Matrix

| 顺序/能力 | 当前 contract | 当前实现 | 接入 native loop | focused test 存在/本轮结果 | 真实 host / restart / concurrency 证据 | 迁移风险、seam 状态 | 最小下一批写集（计划，非已完成） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Provider/Stream | `P/agent/loop/provider-port.ts`、`P/agent/pi/types.ts::StreamFn`；固定 Pi AI 1.0.4 的 `Models.streamSimple` | `P/adapters/provider/pi-ai.ts` 使用 `Models.streamSimple`，builtin composition 使用 `builtinModels()`；旧 `P/providers/probes.ts` 仍只是 probe | 是；`PactileNativeAgent` 接受 `providerRuntime`，与显式 `streamFn` 互斥 | `T/pactile/agent/provider-runtime.test.ts` 13 + native 1 + dependency 3 + probe 1 + compaction 6 = 24 tests 通过 | 无真实 Provider；无重启/并发运行证据 | port/失败码/secret-safe diagnostics/deadline/result/终态已冻结；仍是 migration seam，不能提升为真实 Provider 或发布证据 | 下一步转 Session/Checkpoint；保持 adapter 只在组合入口注入，不让 Agent 依赖具体 adapter |
| 2 Session/Checkpoint | `C/pi-session-checkpoint.ts::PiSessionManagerPort/PiRunCheckpoint`；`C/session-registry.ts` | `P/runtime/session-registry.ts` 保存绑定/租约事件；未找到 native SessionManager/transcript host；checkpoint helper 仅自身与测试引用 | 否 | `T/core/pactile/pi-session-checkpoint.test.ts` 存在，本轮未重跑；Registry 10 tests 仅为历史基线 | 其中 3 个 SQLite tests，含同进程 close/reopen、lease proof fencing；**不是 Agent restart**；无本轮并发证据 | 缺 session/branch/leaf 与 repositoryRoot/cwd/worktree/generation/snapshot 的统一绑定；migration seam | `agent/session/{contracts,port,index}.ts`；具体存储适配放 `adapters/session/`，协调端口放 `runtime-store/`；不得在旧 `runtime/` 添加新架构语义 |
| 3 ContextSnapshot | Pi `AgentContext`、`PrepareRequest`、`transformContext`；`C/context-memory/` durability/policy；`P/agent/context-pipeline.ts` | 可选 Context/Memory/Compaction pipeline 已存在并调用 artifact/receipt/manifest/checkpoint ports；本轮只修正 snapshot builder 参数缺口 | 可选 hook 已接入 wrapper；不是所有 AgentRun 都绑定 durable host | `T/core/pactile/context-memory/compaction.test.ts` 6 tests 通过；无 native durable read-back test | 无 Agent snapshot read-back/CAS/恢复证据 | Pi 内存 messages 不能充当 durable snapshot；当前 pipeline 依赖注入 host，仍不能宣称 Session/Recovery 完成 | 下一步闭合 Session/Checkpoint 与真实 host，再验证 pipeline 的 CAS、lease、重启读回 |
| 4 Pi native loop 接线 | `P/agent/pi/{agent,agent-loop,types,stream-fn,index}.ts`；provenance 已 pinned | `P/agent/index.ts::PactileNativeAgent` → `Agent.prompt/runAgentLoop`；Provider runtime 已在 wrapper 构造路径接入，Pi loop 仍只有一套 | loop + Provider seam 已接入；完整 Session/Context/Receipt 主链否 | `T/pactile/agent/native-agent.test.ts` 与 Provider composition test 通过 | 无真实 Provider/Session 主链；无 native crash/concurrency 验证 | `agent_end`/idle 不是 product settlement；Provider failure 虽在 stream protocol 内结束，也不代表 prompt 成功或 Kernel settlement | 下一步绑定 Session/Checkpoint、turn admission 和 durable receipt，不新增第二个 loop |
| 5 Tool/Effect Receipt | Pi before/after tool hooks、`AgentTool.replay`；`C/runtime-store-port.ts::RuntimeStoreEffectReceipt` | native loop 会调用 tool.execute；但没有 Pactile durable intent/receipt/admission guard；RuntimeStore effect 表独立存在 | 工具调用已在 loop；**治理与 receipt 未接入** | compatibility executor 32 tests 仅为历史基线；IO/effect adapter 测试存在但未全部重跑；native effect 测试缺失 | 无真实 effect → receipt → checkpoint 链 | `tool_execution_end` 不证明 effect 已持久化；失败/异常后效果可能 unknown；`putEffect` 尚无 lease proof 入参；migration seam | `agent/effects` 和 `agent/receipts` contracts/ports；在 tool boundary 写 intent、校验策略、记录 receipt/result hash；不以 UI 回调确认 effect |
| 6 Lease/Idempotency | `C/agent-lifecycle-bridge.ts`、`runtime-store-port.ts`、`product-kernel-store.ts` | 内存 LifecycleBridge/Executor maps；SQLite Store、Registry 有独立 fence；Persistent runner 在旧 RPC 调用之后记 facts | 否 | runner 15、executor 32、Registry 10、persistent runner 2 tests 仅为历史基线（与其他行共享，勿重复累加）；独立 SQLite 套件未重跑 | Registry 有 SQLite stale proof 检查；真实 native 多进程并发、duplicate request 未验证 | 内存 map 不提供 crash-safe idempotency；admission、session 和 Kernel/Runtime epochs 未统一；migration seam | `agent/turn` admission/dispatch port；`runtime-store` coordination port + `adapters/runtime-store` fenced mutation；duplicate request 在 effect 前 durable 登记 |
| 7 Recovery/Resume | `decidePiRunResume`；`LifecycleBridge.resumeOrCreate`；RuntimeStore `recover()` | 纯决策、只读恢复分类存在；Persistent runner 不从存储重建 LifecycleBridge；无 native supervisor/session restoration | 否 | Registry/persistent adapter 局部通过；checkpoint 纯测试存在但本轮未跑 | SQLite close/reopen ≠ 进程 kill/restart；native restart/concurrency 均未验证 | 不能把新建 Run 或恢复事件列表当恢复 Agent；重复 prompt/effect 风险；migration seam | `agent/recovery` contracts/orchestrator；进程隔离适配在 `adapters/`，如需 supervisor 则执行同一 native loop，而非另起旧 RPC 主链 |
| 8 Unknown Effect Reconcile | RuntimeStore `unknown/pending`、`reexecute:false/no_automatic_replay` | `recover()` 返回 waiting/assurance_unknown；没有真实 effect query/reconcile 流程 | 否 | persistent runner 中 unknown/no-replay test 仅为历史局部证据；它只读预先写入的 unknown 行 | 无真实 interrupted effect 或 reconciliation 证据 | “不重放”不等于“已 reconcile”；缺 receipt/evidence 时必须 BLOCK | `agent/recovery` reconcile port；`agent/receipts` reconciliation receipt；每项效果有身份与证据，不自动重发未知 effect |
| 9 `pactile agent run` | release plan 目标命令；当前 CLI 无此注册 | `src/cli/index.ts` 只有 `pi` compatibility entry 和既有命令 | 否 | native command 测试不存在 | 无 | CLI 不能绕过 admission；stdout JSONL 与 stderr 必须分离；BLOCK | `commands/agent.ts`、CLI 注册和组合入口：注入 adapters/ports；显式 root/cwd/session/provider；不在 Orchestrator new SQLite |
| 10 Native Agent E2E | release plan A—F | 当前 integration 是 foundation、安装/投影组合；无 native 最小闭环 | 否 | 历史 integration 3 文件共 9 tests 通过，但不属于 native E2E | 无真实 native E2E | mock、HTTP 200、command accepted、组件 mounted 均不能提升证据等级；BLOCK | `T/pactile/integration/native-agent-*.test.ts`：admission → Provider → tool/receipt → checkpoint → process exit/reopen → resume/reconcile → settlement |
| 11 Release preflight | package engines `>=24.0.0`、build/docs/pack scripts、来源清单 | 脚本存在；本轮 typecheck/lint/focused test/build/docs smoke 通过，artifact/install/pack 证据仍有限 | 不适用，依赖前述闭环 | build 与 docs smoke 已通过；pack/full release gate 未执行 | Node 24.3.0 本机测试；Node 24.0.0 最低版本未单独安装验收 | Agent package 仍声明 Node 24.0；Worker 是独立 capability process，不能把 candidate 当 Product/Kernel truth；BLOCK | E2E 后 full test/pack/tarball/干净安装/真实 Provider read-back；不自动 tag/publish |

## 横向边界 Gap Matrix

| 能力 | 当前 contract / 实现 | native 接入 / focused test | 真实证据与风险 | 最小后续写集 |
| --- | --- | --- | --- | --- |
| Memory / Compaction | `C/context-memory/durability.ts::ContextMemoryDurabilityPort`；`P/runtime/file-artifact-store.ts` 是 artifact adapter，不能替代 receipt/manifest/lease host | native 未接；fake host durability tests 存在，本轮未跑 | 真实完整 host、事务内 lease、并发 manifest CAS、cut-point/summary/receipt 全链未验证；migration seam | 在第 3—4 步通过 `agent/memory`、`agent/compaction` ports 接 `adapters/` 中真实 host；仍由 Agent 编排 |
| Retrieval | `P/retrieval/types.ts` V3、planner、evidence/pack；CLI context 可消费离线 pack | native 未接；focused tests 存在，本轮未专项重跑 | Worker candidate 未在本轮导入；generation/snapshot/freshness → source facts → context 无真实证据 | `agent/retrieval/{contracts,port,index}.ts`、Worker capability adapter、ContextSnapshot 引用；Worker 不写 Kernel |
| Kernel / Settlement | `C/work-model.ts`、`ProductKernelStorePort`；SQLite Kernel `settleRun`；既有 `core/task` 仍是 0.6.x Task Kernel | native 未接；compatibility runner 的 terminal/evidence/gate 拒绝测试通过，Kernel 独立套件本轮未跑 | settlement 入参仍含 `evidenceAccepted/gateAccepted` 布尔事实，native receipt 校验缺失；多种 AgentRun 表达需统一身份，不能各自生成产品真相 | `kernel` 纯 contract/port/barrel + adapter 映射；Runtime Store 存运行协调状态，Kernel 作产品决策；禁止 App 或 bridge boolean 自行充当 Evidence |
| 模块依赖 | 当前 `core/pactile/index.ts` 导出 `trace-runtime`，后者 import `node:fs/path`；尚无 Agent-owned Provider port | 目标多数子目录尚未建立；无新架构 dependency guard | Domain barrel 可到达 Node I/O；不能因目录改名宣称单向依赖已满足 | 新 barrel 逐符号导出 contract/port，不 `export *` 旧混合 barrel；先将 Provider 实现放 `adapters/provider`，新增静态依赖测试 |
| Protocol / App | 当前 IO Envelope 是局部契约，未找到本线 `P/protocol` 统一 API | 无 native Snapshot/Delta/Attention 命令闭环；本轮未实现 UI，也未审计并行 App 修改 | App 不参与事实写入是已确认规则，**尚无本轮架构测试证明**；不能宣称 App 已正式接入 | 后续 `protocol` contract/barrel 与 dependency guard；App 只消费 typed command/Projection，禁止导入 Kernel/Runtime Store 实现 |

## 当前实际调用链（仍非完整产品链）

```text
目标 CLI agent run/admission：缺失
  ×→ PactileNativeAgent
       → providerRuntime.streamFn 或显式 test/custom-host StreamFn
       → Pi-derived Agent.prompt / runAgentLoop
       → Provider port failure/terminal normalization
       → tools.execute / lifecycle events     [Pactile effect/receipt gate 未接]
       ×→ durable Session/Checkpoint/ContextSnapshot 主链
       ×→ Recovery/Resume/Reconcile
       ×→ Kernel settlement
```

兼容链 `pactile pi → commands/pi → pactile/pi/bridge → PiRpcClient` 与迁入的 `runtime/pi-agent-runner → PactilePiRpcHost` 不是上述 native 主链的证据。本轮不复用它们，不创建新的 RPC 默认路径。

## Batch 2A Provider/Stream 实施记录与下一批边界

**Decision**：单包 `@blxzer/pactile`；Pi-derived source 是内部运行时；Agent 依赖 port，具体 Pi AI Provider adapter 由组合入口注入。**Rationale**：复用已有 pinned Pi loop/Pi AI 1.0.4 来源决策及本地依赖 API 检查，不做第二套 Provider 协议、第二套 loop 或 npm 拆包；本轮未做新外部评测。

以下 Batch 2A 文件已创建并纳入当前写集；Session 及后续文件仍是计划：

1. `P/agent/loop/provider-port.ts`、`P/agent/loop/index.ts`：已明确 model/stream/error/abort/timeout contract，未导入 Node I/O 或具体 Provider factory。
2. `P/adapters/provider/pi-ai.ts`、`P/adapters/provider/index.ts`：已接入 Pi AI `Models.streamSimple` 和显式 `builtinModels()` composition；错误全生命周期、无隐式 model fallback、无秘密 diagnostics。
3. `P/agent/index.ts`：已依赖结构化 Provider port，不依赖具体 adapter class；冲突的 `streamFn`/`providerRuntime` 和模型身份 fail closed。
4. `T/pactile/agent/provider-runtime.test.ts`、`dependency-boundary.test.ts` 与现有 Agent/probe/compaction focused tests：已覆盖成功/失败/取消/超时/断流、`result()` rejection、终态身份、错误序列、配置冲突、依赖边界和 Agent 构造路径；没有把它们升级成真实 Provider 或 E2E。
5. 本矩阵、Batch 2A 记录、migration batches 已记录当前命令/结果/未确认项；未修改 vendored Pi 文件，因此不更新 provenance hash。下一批转 Session/Checkpoint，不扩张本批次。

Batch 2A focused tests 已对同步 setup throw、stream 内 error、iterator throw、断流无终态、abort/timeout 和配置冲突建模；诊断固定为 port failure code，不能回显任意 Error 文本。它们仍是 scripted/fake evidence，不能替代真实 Provider、网络、重启或并发验收。

真实 Provider 验收需显式授权的 endpoint/model/凭据来源与可发送内容。当前不读取全局认证文件、不输出密钥、不作外部计费请求；本地 scripted Provider/loopback 仅是协议或传输测试，不等于真实模型验收。

## 后续强制负向验收（不跨依赖抢跑）

| 验收 | 对应主链步骤 | 当前缺口 |
| --- | --- | --- |
| Provider setup/stream failure、abort/timeout、断流无终态 | 1 | focused protocol tests 已通过；真实 Provider/网络仍缺失 |
| Session resume、checkpoint stale、cwd/repositoryRoot/worktree/generation/snapshot mismatch | 2—4 | 只有 port/pure tests，native 持久化/恢复缺失 |
| receipt/evidence 不完整不能 settlement | 5—8 | 兼容 boolean gate 测试不等于真实 receipt 链 |
| lease fencing、duplicate request（含并发/重启） | 6 | 独立 adapter 部分覆盖，native 主链未覆盖 |
| process exit、unknown effect、restart 后不自动 replay | 7—8 | FakeChild exit 与 SQLite reopen 不构成真实进程恢复证据 |
| App 不参与事实写入 | 1 起增补 dependency guard，9—10 验证 typed command | 规则已定，自动化约束未建立 |

## 本轮验证记录

环境：PowerShell 7.6.6、Node 24.3.0、pnpm 10.32.1。包当前声明 `engines.node >=24.0.0`；未单独安装 Node 24.0.0 验收，也未读取全局认证文件。

| 时点 | 命令/范围 | 结果与限度 |
| --- | --- | --- |
| 本轮 | `pnpm --filter @blxzer/pactile typecheck` | PASS；package 与 scripts TypeScript 检查 |
| 本轮 | `pnpm --filter @blxzer/pactile lint` | PASS |
| 本轮 | `pnpm --filter @blxzer/pactile exec vitest run test/pactile/agent/provider-runtime.test.ts test/pactile/agent/native-agent.test.ts test/pactile/agent/dependency-boundary.test.ts test/pactile/providers/provider-probes.test.ts test/core/pactile/context-memory/compaction.test.ts --maxWorkers=4` | PASS；5 files、24 tests；Provider/Models 使用 fake/scripted seam |
| 本轮 | `pnpm --filter @blxzer/pactile build` | PASS；生成 dist，但不等于 release artifact/read-back |
| 本轮 | `pnpm --filter @blxzer/pactile docs:smoke` | PASS；6 documented commands、6 executions |
| 本轮 | integration foundation/composition/lifecycle focused tests | PASS；3 files、9 tests；不是 Native Agent E2E |
| 本轮续接 | Lifecycle/Projection/Ownership/Context/Native integration focused 命令 | PASS；21 files、178 tests；已迁移活动 conformance fixtures 到 Pactile Native Agent，并覆盖真实 SQLite/FileArtifactStore Context pipeline |
| 本轮续接 | ArtifactStore/runtime 与 durable memory 兼容性修复 | PASS；修复 `FileArtifactStore` options runtime narrowing，以及 compaction receipt 的合法 `authorization` 字段被 secret-key scan 错拒；durability 50 tests PASS；无 debug 输出残留 |
| 本轮 | `pnpm --filter @blxzer/pactile test` | 未形成 PASS；300 秒超时，输出中 `test/commands/pi-independent-review.test.ts` 有 1 个 cancellation assertion failure；full-suite gate 仍 BLOCK，未将其误报为 Provider focused failure |
| 本轮 | pack / native E2E / 真实 Provider | **未执行，unverified/BLOCK**；不形成可发布或已发布证据 |

```powershell
pnpm --filter @blxzer/pactile exec vitest run test/pactile/agent/provider-runtime.test.ts test/pactile/agent/native-agent.test.ts test/pactile/agent/dependency-boundary.test.ts test/pactile/providers/provider-probes.test.ts test/core/pactile/context-memory/compaction.test.ts --maxWorkers=4
```

Provider runtime 13；Native Agent 1；dependency boundary 3；probe 1；Context compaction 6，共 24 tests。测试覆盖 stream 协议和 wrapper 接线，但不构成真实 Pi/Provider、进程重启或并发 lease 证据。

当前根目录 `node_modules` 存在以供验证；本轮未运行 Git clean/reset/stash，未清理 source workspace，也未操作并行 `apps/` 内容。

## 固定顺序

Provider/Stream → Session/Checkpoint → ContextSnapshot → Pi native loop 接线 → Tool/Effect Receipt → Lease/Idempotency → Recovery/Resume → Unknown Effect Reconcile → `pactile agent run` → Native Agent E2E → Release preflight。

这 11 个阶段的端到端门槛当前均未关闭；审计矩阵覆盖完整，不代表实现完成度。Memory/Compaction/Retrieval 与 Kernel/Protocol 横向边界必须随相关阶段验收，不因未单列阶段而豁免。
