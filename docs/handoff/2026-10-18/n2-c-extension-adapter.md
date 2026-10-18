> 2026-10-18 更新：批次 2a 已合并（PR #50，f8fae5da3），见 n2-c-batch2a.md。下文的批次 2 计划已被替换（2a/2b 拆分）；批次 1 的内容仍然有效。

# N2: 任务 C(扩展适配器)——批次 1 合并,批次 2/3 计划

## 状态

- **批次 1 已合并:PR #47,SHA `96de1e0a92e0c91aeb74febf4d2c631b1f3c43de`**。合并时 head `c6906217c`,Merge gate 绿(run 39112265513)。
  - 合并前已完成:按调用传递 scope(AsyncLocalStorage)+ 并发测试;暂停定时器 unref 偏差写进 PR;D-fix 合并后 rebase。
  - OCR 未完成:job 报告"子进程超时",无评论。OCR 不是合并条件,未重跑。**待重跑**(backlog A 节)。
- **批次 2 和批次 3 未开始。** N2 门禁保持打开:C 和 B 都未完成。
- 分支 `n2-extension-adapter` 保留(已合并,未删除)。

## 批次 1 做了什么

1. **services 每进程创建一次(S2)**:`OpenDurableOptions.services` 与 `OpenDurableResult.services`。RPC `new_session` / `switch_session` 复用第一次 open 的 services,扩展不重新加载。
2. **扩展宿主** `core/durable/extension-host.ts`:每次 open 一个 `ExtensionRunner`,绑定到该 open 的 controller。已接通:`session_start`(reason 为 `startup` 或 `resume`)、`session_shutdown`(reason 由 `close(reason)` 决定)。handler 报错变成 notice。
3. **适配器** `core/durable/extension-adapter.ts`:handler 映射为 `GenerationTask` 的 hook 成员,**只在有 handler 时注册**:`before_provider_request`(payload)、`before_provider_headers`、`after_provider_response`、`provider_stream_event`(带 provider、api、model)、`message_end`(仅 assistant)。
4. **provider 调用范围**:`ctx.model` / `ctx.signal` 来自进程级 `AsyncLocalStorage`,每个 provider 调用一份值。第一版是"共享变量 + 退出时恢复",并发时错误:先结束的调用会在另一个仍在运行的调用下面恢复外层值。并发测试在两个交错的调用里,于 await 前后各读一次 model 和 signal。
5. **CPA 暂停闸门**:`waitForPauseToEnd(agentDir, controller, signal)`;abort 立即 reject 并清除定时器;hook 传入 `ctx.signal`。
6. **偏差(已在 PR 中写明并接受)**:暂停定时器没有 unref。暂停中的请求必须保持进程存活,否则 print 模式会静默退出。

### 变异检查(批次 1)

| 变异体 | 结果 |
| --- | --- |
| 去掉 `before_provider_request` / `after_provider_response` / `provider_stream_event` 成员 | 杀死 |
| 去掉 `session_shutdown` | 杀死 |
| 去掉扩展错误监听 | 杀死 |
| 去掉 services 复用 | 杀死 |
| 暂停:去掉 abort 监听 | 杀死(定时器测试) |
| 暂停:不传 `ctx.signal` | 杀死 |
| 范围改回共享变量(旧设计) | 杀死(并发测试) |
| 暂停:abort 不清定时器 | 杀死(定时器测试) |

**注意**:子进程测试("abort 后进程能正常退出")在去掉 abort 监听时仍然通过,因为 `waitForPauseToEnd` 每次轮询(200 ms)都检查 signal,进程仍会退出。它是正向的冒烟测试;区分两个暂停变异体的是假定时器测试。

## 验收 A1–A12 状态(`n2-t3-cpa-acceptance.md`)

| 用例 | 状态 |
| --- | --- |
| A1 Fast | 桥接已接通,未测(没有在 durable 上设置 Fast 并检查 `service_tier`) |
| A2 暂停后发送 | 通过 |
| A3 暂停中 abort | 通过(运行以 unanswered/aborted 结束,无请求;定时器被清) |
| A4 暂停、关闭、重开、继续 | 未做 |
| A5 after_provider_response | 部分(handler 收到 200;未核对 quota 头) |
| A6 provider_stream_event | 部分(每个帧带 provider;未测首帧时间) |
| A7 retry normalizer | 未测 |
| A8 request record | 未测 |
| A9 before_agent_start | 未做(批次 3) |
| A10 agent_settled(unanswered 后) | 未做(批次 3) |
| A11 quota 节流跨 new_session | 部分(services 不重载已测;节流状态持久化在登录会话的清单里) |
| A12 无 handler 无成本 | 通过 |

## 批次 2:工具桥接、codemode 与 tool-search(未开始)

调研结果(只读,未改代码):

- **工具形状不同。** legacy `ToolDefinition`(`core/extensions/types.ts`)有 `label`、`promptSnippet`、`promptGuidelines`、`renderShell`、`exposure`、`namespace`、`outputSchema`、`constrainedSampling`,执行函数签名是 `(toolCallId, params, signal, onUpdate, ctx)`。durable `ToolRegistration`(`harness/types.ts:299`)有 `replay`、`executionMode`、`prepareArguments`、`structuredOutputSchema`、可调用范围,执行是 `defineTool({ execute: (args, api, context) })`。桥接需要两边的映射:结果形状、流式更新(`onToolUpdate`)、`exposure` 与延迟加载、`namespace`。渲染器留在宿主侧。
- **注册时机。** MCP 工具在 `session_start` 后才注册(`mcp_servers_change` 也会改变工具集)。Harness 接受 open 之后的新工具,依据是 spec 7.5(同名替换),**未经运行验证**(设计风险第 2 条)。这是 S6 的验收点。
- **tool_call / tool_result** 映射到已有的 `beforeTool` / `afterTool`。legacy 的 `tool_call` 可以返回 `{ block, reason }` 并改写 input;durable 的 `beforeTool` 返回 `{ arguments?, block? }`,映射可行。
- **codemode。** durable 的 `createCodemodeExtension(options: CodemodeToolOptions)` 需要 `sandbox: CodemodeSandboxBase`(Node 上是 `CodemodeSandbox`)。legacy 的 codemode 扩展在 `config.ts` 里计算 wasm 与 worker 路径;durable 侧要用同样的路径构造沙箱。tool-search 同理。
- **失败原因已知的 codemode 问题**(backlog B):worker 上限把仍在退出中的 worker 也计入,会让后续用例拿到 `Codemode worker limit reached`。这和 codemode 的安装不是同一件事,但安装 durable 版本会把它带到 durable 路径上,需要一起看。

**建议拆成两个 PR**:
- **2a 工具桥接**:`core/durable/extension-tools.ts`(legacy 工具 → durable 工具)、`extension-host` 在 `session_start` 后安装成员扩展、`tool_call`/`tool_result` 映射到 `beforeTool`/`afterTool`、MCP 验收(S6)。不含 codemode。
- **2b codemode 与 tool-search 安装**:沙箱构造(路径与 legacy 相同)、`createCodemodeExtension` 与 tool-search 的安装,legacy 的 codemode/tool-search 在 durable 路径上让位(S5 的成本开关)。先在本地 Bun 连续跑 `agent-session-codemode` 5 次,确认 worker 上限问题后再合。

**需要主控决定:**
1. 2a 与 2b 分开两个 PR,还是合并为一个?(建议分开:2a 不依赖沙箱,2b 有 backlog B 的已知问题。)
2. codemode 的 worker 上限问题:先在 2b 之前单独修,还是 2b 内一起修?
3. 2a 的 MCP 验收需要 MCP 服务器的测试桩(`packages/mcp`)。是否允许在 coding-agent 的测试里起一个最小 stdio MCP 服务器?

## 批次 3(未开始)

斜杠命令分发与 UI 子集(决定 4)、提示模板(`--prompt-template` 回到 durable 的前提)、`before_agent_start`(一次 run 的第一个请求,A9)、`agent_settled`(每次 run 结束都发,包括 unanswered,A10)、turn 与 settle 边界(`onBoundary`)、`context`、`isIdle` / `isProjectTrusted` 的真实值、`ctx.sessionManager` 的真实实现(当前全部报错)。批次 3 完成后:`--extension`、`--theme`、`--prompt-template` 放回 durable 路由,A1–A12 全部验收。

RPC `new_session` 的 `session_start` reason 当前是 `startup`(应为 `new`),在批次 3 与其他会话事件一起修。

## 影响其他会话的文件(批次 1,已合并)

- `core/extensions/runner.ts`:构造参数与字段类型改为 `ReadonlySessionManager`。
- `core/durable/runtime.ts`:`services`、`close(reason)`、宿主的创建与生命周期。B 的 `DurableController` 与 `OpenDurableResult` 改动要与之衔接。
- `modes/durable/rpc.ts`:`replaceSession` 复用 services。
- `extensions/cliproxyapi/pause.ts`、`index.ts`:**登录会话的文件**。`waitForPauseToEnd` 新增可选 `signal` 参数,一处调用已更新。

## B(并行)

主控第 4 条:B 在 `core/durable/session-ops.ts` 里先做,不碰 `rpc.ts` 与 `runtime.ts`。**本轮未开始 B**:优先级是 C。
