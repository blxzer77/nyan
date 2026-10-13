# Batch 2A：Native Agent Provider/Stream 接线记录

## 状态边界

Batch 2A 的 Provider/Stream 代码已写入当前 checkout，并通过本轮 focused typecheck、lint、协议测试、build、docs smoke 和既有 integration smoke；本批次仍不是可发布闭环。测试使用注入的 `Models`/scripted stream，不是真实 Provider、网络、重启或并发证据。

本记录只覆盖 Provider/Stream 与 `PactileNativeAgent` 的第一段接线，不宣称 Session、Checkpoint、Recovery、Tool/Effect Receipt、Kernel settlement 或发布闭环完成。

- **代码存在**：表示 port、Pi AI adapter、wrapper 接线和测试源码存在。
- **测试通过**：只指本记录列出的最新命令在当前 checkout 通过。
- **已接入 Agent**：表示 `PactileNativeAgent({ providerRuntime })` 的实际构造路径使用同一个 Pi-derived loop。
- **真实运行验证**：仍要求真实 Provider/网络或真实进程/持久化重启证据，本批次没有。
- **可发布**：仍要求 Native E2E、recovery、receipt、settlement 和 release preflight，本批次没有。
- **已发布**：本批次没有用户授权后的 artifact/publish/read-back。

## 当前实现与证据

| 能力 | Contract / 实现 | Focused test | 接入 `PactileNativeAgent` | 真实 host/restart/concurrency | 结论 |
| --- | --- | --- | --- | --- | --- |
| Pi Agent loop | `packages/cli/src/pactile/agent/pi/` 的 Pi-derived loop | `test/pactile/agent/native-agent.test.ts`、Provider composition test | 是；Provider runtime 与显式 `streamFn` 共用同一个 loop | 否；使用 scripted stream | migration seam，非 settlement |
| Provider port | `pactile/agent/loop/provider-port.ts`：固定失败码、abort/timeout/断流/协议终态和 secret-safe diagnostics | `test/pactile/agent/provider-runtime.test.ts` | 是；wrapper 只依赖 `PactileProviderRuntime` | 否 | port 已存在，仍未接真实 Provider |
| Pi AI adapter | `pactile/adapters/provider/pi-ai.ts`：`Models.streamSimple`、`builtinModels`、模型绑定、deadline、result/stream normalization | Provider runtime focused tests 13 tests | 是；由组合入口注入，不创建第二套 Agent | 否；Models 为 fake，source 为 scripted stream | Batch 2A 代码已接入 |
| 兼容 probe | `pactile/providers/probes.ts` | `test/pactile/providers/provider-probes.test.ts` | 否；仅 capability probe，不是 Agent stream | 否 | 保留兼容边界 |
| Session/Checkpoint | `core/pactile/pi-session-checkpoint.ts` 等既有 port | 既有 focused tests；未作为本批次闭环 | 否；Provider runtime 不伪装 Session | 否；SQLite close/reopen 不等于 Agent restart | 后续批次 |
| Context/Memory/Compaction | `agent/context-pipeline.ts` 可选注入，依赖 durability/audit/checkpoint ports | 本轮仅复跑 compaction 6 tests | 可选 hook 已存在，但没有真实 durable host 主链证据 | 否 | 不因 wrapper hook 宣称 durable recovery |
| `pactile agent run` / Native E2E | 当前 CLI 尚无 `agent` 命令和 native E2E | 无 | 否 | 否 | BLOCK |

## Decision / Rationale / Risk：Provider 负向验收补强（已完成）

复用既有 Pi AI 1.0.4 来源决策及其 `Models`、`AssistantMessageEventStream`，不另造 Provider 协议或 Agent loop。检查本地 pinned API/source 后补齐了 `result()` rejection、终态身份校验、错误 metadata 过滤、默认 deadline 和依赖边界；最终 focused 命令 24 tests 通过。

- 每个调用有独立 AbortController 和总 deadline（含 setup、iterator、result）；默认 120 秒，runtime 可配置，单次 timeout 只能缩短预算；adapter 明确传 `maxRetries: 0`，不启用应用层自动重试。
- 成功须 `start → updates* → done` 且 `result()` 与终态的身份/stopReason 一致；EOF 无终态、非法顺序/结构、deferred（尚无 resume port）均 fail closed。取消/超时后只输出一次终态，清理 timer/listener，best-effort 关闭源，不宣称远端效果撤销。
- 原始 exception、errorMessage、diagnostics 不出边界；partial/done 仅保留协议白名单字段。模型生成内容及显式注入的原始观测 callback 仍属调用方信任边界，不宣称通用 DLP。
- Provider admission 仅绑定显式 model；lease/epoch、durable idempotency、crash/recovery、unknown effect reconcile 仍未接入。本批不持久化、不重放，也不负责 Kernel settlement。
- 新增依赖测试只约束 Provider port/adapter/wrapper 导入，不冒充全仓 Kernel/App 架构门禁。

本次补强写集：下列 Provider port/adapter/barrel、wrapper、`test/pactile/agent/provider-runtime.test.ts`，新增 `test/pactile/agent/dependency-boundary.test.ts`，以及本记录、gap matrix、migration batches。**不再修改 Context/Session/Pi vendored/包 engines 或并行工作文件。**

## 本批次最小写集

1. 新增 `packages/cli/src/pactile/agent/loop/provider-port.ts` 与 barrel：定义 Provider runtime、固定失败码、abort/timeout/断流/协议错误和 secret-safe terminal message。
2. 新增 `packages/cli/src/pactile/adapters/provider/pi-ai.ts` 与 barrel：以 Pi AI `Models.streamSimple` 为适配器，并由 `createBuiltinPactileProviderRuntime()` 显式使用 `builtinModels()`；没有隐式 provider/model fallback。
3. 更新 `packages/cli/src/pactile/agent/index.ts`：`providerRuntime` 与显式 `streamFn` 互斥，模型身份冲突 fail closed，仍使用同一个 Pi-derived Agent loop。
4. 新增 `test/pactile/agent/provider-runtime.test.ts`：成功、setup/stream failure、abort、timeout、断流、协议配置冲突、秘密安全和 Native Agent 构造路径。
5. 修正 ContextSnapshot builder 的新增 `contextBasisHash/sourceCursor` 调用缺口，使当前包 typecheck 可复现通过；这不是 Session/Recovery 完成证据。

## 明确不在本批次

- 不新增或修改 `D:\MyHarness` 内容。
- 不接 `pactile agent run` CLI；它依赖 Session/Checkpoint 与 admission/settlement 主链。
- 不把 `pactile pi` RPC、旧 Host、provider probe 或 fake `Models` 当作真实 Native Provider 运行。
- 不把 mock stream、fixture、HTTP 200、command accepted 或 `agent_end` 单独当作真实完成。
- 不 commit、push、merge、tag、publish 或 deploy。

## 最新验证记录

环境：PowerShell 7.6.6、Node 24.3.0、pnpm 10.32.1。重新读取 package.json 确认当前 engines 已是 `>=24.0.0`；前次写入的 Node 22.19 说明有误，现更正，不修改并行工作线的 engines。未单独验证 Node 24.0.0，也没有读取全局认证文件或输出密钥。

| 命令 / 范围 | 结果与限度 |
| --- | --- |
| `pnpm --filter @blxzer/pactile typecheck` | PASS；含 package 与 scripts TypeScript 检查 |
| `pnpm --filter @blxzer/pactile lint` | PASS |
| `pnpm --filter @blxzer/pactile exec vitest run test/pactile/agent/provider-runtime.test.ts test/pactile/agent/native-agent.test.ts test/pactile/agent/dependency-boundary.test.ts test/pactile/providers/provider-probes.test.ts test/core/pactile/context-memory/compaction.test.ts --maxWorkers=4` | PASS；5 files、24 tests；含 13 Provider、1 Native Agent、3 dependency boundary、1 probe、6 compaction |
| `pnpm --filter @blxzer/pactile build` | PASS；生成 dist，但不等于 release artifact/read-back |
| `pnpm --filter @blxzer/pactile docs:smoke` | PASS；6 documented commands、6 executions |
| integration foundation/composition/lifecycle focused tests | PASS；3 files、9 tests；不是 Native Agent E2E |
| `pnpm --filter @blxzer/pactile test` | 未形成 PASS；300 秒超时，输出中 `test/commands/pi-independent-review.test.ts` 有 1 个 cancellation assertion failure；单独复跑该用例仍失败（line 1593，期望 correction.attempted=true，实际 correction=null），未证明它在改动前已失败，也未改断言规避；full-suite gate 仍是 BLOCK |
| pack / release preflight | 未执行 |
| 真实 Provider、网络、进程 kill/restart、并发 lease、unknown effect reconcile | 未验证 |

## 当前结论

Provider/Stream **代码存在：是**；focused tests **最新通过：是（24 tests）**；通过 `providerRuntime` **已接入同一个 Native Agent loop：是**；typecheck/lint/build/docs smoke/integration smoke **通过：是**；真实 Provider/网络、Native E2E、重启恢复、receipt/settlement、可发布、已发布：**否**。

固定后续顺序仍为：Session/Checkpoint → ContextSnapshot durable host → Pi native loop full seam → Tool/Effect Receipt → Lease/Idempotency → Recovery/Resume → Unknown Effect Reconcile → `pactile agent run` → Native E2E → Release preflight。
