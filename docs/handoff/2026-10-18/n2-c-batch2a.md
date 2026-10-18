# N2: 任务 C 批次 2a（扩展工具桥接与 MCP）— 2026-10-18

## 状态

- **PR #50 已 squash 合并**，SHA `f8fae5da3a7d36a11c779d860abbc79486c0056b`。合并时 head `1ce060d0b`，Merge gate 绿（run 39117998698）。
- 分支 `n2-extension-tools` 保留（未删除，未 force-push）。
- 批次 2b（codemode、tool-search）**未开始实现**。根因调查已完成（见下），结论：不需要在 2b 里修，由 backlog B 跟踪。
- 批次 3 未开始。B 未开始（`session-ops.ts` 未创建）。
- N2 门禁保持打开。

## 实测（主控第 2 条）

`packages/durable/test/registry-late-install.test.ts`（2 个用例，先于桥接写）：open 之后安装的扩展，在下一次请求里被模型看到；同名重装替换旧版本；run 中途安装的工具，在同一个 run 的下一次请求里可见。**结果：通过，spec 7.5 成立**。桥接按此实现，没有停下来。

## 字段映射（主控第 3 条）

映射表（逐字段，映射到哪里或丢弃的原因）和丢弃清单（R1–R15）写在 hooks note 的 `Tool bridge mapping (task C, batch 2a)` 一节。丢弃项 R1–R14 是 2a 的缩减清单；R15 是 MCP 的 codemode 自动激活（2b）。

- 渲染器（`renderShell`、`renderCall`、`renderResult`）留在宿主一侧（R3）。
- `tool_call`、`tool_result` 映射到 `beforeTool`、`afterTool`，只在 runner 有对应 handler 时注册（S5）。
- MCP 验收：`durable-mcp.test.ts` 在 coding-agent 测试里起一个本地 stdio 子进程（`process.execPath`，夹具复用 `packages/mcp/test/fixtures/stdio-server.mjs`，外面包一层记录 pid 的 wrapper），不连网络；工具在第一次请求里出现、被执行、结果回到模型；会话关闭后用 `process.kill(pid, 0)` 确认子进程已退出。Windows 本地通过，Linux 由 CI 验证。

## 两处更正（这一轮发现的，已在 PR 描述里写明）

1. **MCP 验收最初是假阳性。** MCP 的 `tool_call` 处理器读 `getAllTools()`，而宿主里它是 `unavailable`，处理器抛错，`beforeTool` 把它当成阻断，所以 MCP 工具从来没有执行。测试能通过，是因为断言在助手的工具调用参数里找 `via-mcp`，参数里本来就有这个字符串。修法（`c1b3db1de`）：实现 `getAllTools`、`getActiveTools`、`setActiveTools`（宿主维护激活集合，legacy 语义）；测试改为读取工具结果消息，并检查 `isError === false`。
2. **第一次 MCP 请求看不到 MCP 工具。** MCP 在 `before_agent_start` 里等待直接服务器连接完成。durable 之前不分发这个 hook，所以第一条 prompt 缺工具。修法：提交 prompt 前（`submit`、`submitAndWait`）先运行 `before_agent_start`，只应用"等待"这一部分；消息和 system prompt 的改动留给批次 3（R13、R14）。这是批次 3 的一部分提前做的，原因是 MCP 验收需要它。

## 验证

- `npm run check`：退出码 0。
- 相关测试：9 个文件，50 个用例通过（含 2a 新增、C 批次 1、D 的回归测试）。
- 变异检查 12 个（`mutate-2a-2.mjs`），每个都恢复了文件，全部被杀死：未在启动后同步；`refreshTools` 不同步；`tool_call`、`tool_result` 成员缺失；hidden 工具被安装（只有映射单元测试能杀死，行为测试区分不了"未安装"和"安装后 deferred"）；codemode 工具给了模型；prompt 片段缺失；输出 schema 检查缺失；去掉 `before_agent_start` 等待（MCP 测试）；`getAllTools` 不可用（MCP 测试）；`setActiveTools` 不生效；默认激活规则错误。
- 未验证：`onUpdate` 的流式分片；两个扩展注册同名工具；交互 TUI（工具调用在 durable TUI 里只以文本显示，R3）；完整 coding-agent 套件（CI 跑）。

## 对 D 的 CHANGELOG 与回归测试的修改

- `durable-resources.test.ts`：内置扩展列表原来期望 codemode、tool-search 被加载，现在期望不加载（它们在 2a 被 `disabledBuiltinExtensions` 禁用，原因见 2b 决定）。注释里写明了原因。
- CHANGELOG（Unreleased, Changed）：新增一条，说明 durable 路径向模型提供扩展工具（`direct` 与 `model-only`），MCP 的 `direct` 服务器在第一条 prompt 前连接；codemode、deferred 工具等 2b 之后生效。

## 2b：codemode 根因调查（主控补充第 1 条）

结论：**两个症状是同一个测试间干扰，不是产品缺陷；不在 2b 里修，记入 backlog B。**

- 证据一：Deep 第 2 次（job 117416710977）与第 3 次（job 117421022493）都在 head `7d33a133b` 上失败。该 head 的 `agent-session-codemode.test.ts` 没有 `codemodeWorkersInFlight` 等待；当前 main 有（`074fa787d` 的记录，afterEach 等待计数器归零）。失败发生在修法之前。
- 证据二：本地复现。Node 上连跑 3 次、Bun（`bun --bun vitest`）上连跑 3 次，全部 25/25 通过。
- 证据三：`host.ts` 的槽位获取与释放成对。`acquireWorker` 之后 `new Worker` 失败会立即释放；`exit` 事件之后释放。没有"获取后永不释放"的分支。
- "usage 为 undefined"：很可能是同一个根因。脚本没有启动，就没有工具调用，也就没有 usage。这一点是推断：Deep 日志里没有结果体。
- 产品问题（待 owner 决定，不在 2b 修）：超过两个并发脚本时直接拒绝（现状），而不是排队。并行的 codemode 调用可能撞上这个限制。

## 2b 实际要做的事（未开始）

1. **安装 durable codemode。** `createCodemodeExtension({ sandbox, namespaces, inlineBudget, globals })`。沙箱的 wasm 与 worker 路径**复用** `config.ts` 里现有的计算（`getQuickJSWasmPath()`、`getCodemodeWorkerSpecifier()`），不再写一份。worker 上限（两个槽位）的位置要定：现在在 legacy `execute.ts` 的模块级计数器里，durable 路径要么复用它，要么提取成共享模块。
2. **安装 durable tool-search**，同样的 `disabledBuiltinExtensions` 替换。
3. **R5（namespace）**：MCP 服务器的 namespace 映射为 codemode 的 `CodemodeNamespace`（名字、别名、描述、instructions）。
4. **R15（MCP 的 codemode 自动激活）**：MCP 查找名为 `codemode`、`tool_search`、且带 `reachesTools` 的 nyan 工具。durable 版本是 Harness 的工具，不是 runner 的工具，所以 MCP 看不见它们。两种办法（需要决定）：
   - (a) 把 durable 的 codemode 与 tool-search 也以 `ToolInfo` 形式报告给 `getAllTools`（带 `reachesTools`），`setActiveTools` 的 `codemode` 激活改为切换它的可见性；
   - (b) 改 MCP 的自动激活逻辑，让它直接读 durable 的状态。
5. **R7、R8**：`prepareLoadout` 与 `reachesTools` 在 codemode 与 tool-search 中使用。
6. **验收**：MCP 默认 `codemode` 暴露的工具通过 codemode 到达模型（现在的 MCP 测试用的是 `direct`，2b 要补一个默认暴露的用例）。

## 需要主控决定

1. **R15 的办法 (a) 还是 (b)。** 我倾向 (a)：它保留 MCP 扩展的逻辑不变，改动在宿主。
2. **worker 上限**：保持"直接拒绝"，还是改成排队？排队需要改产品行为，我建议先保持现状，在 backlog B 里记为待决定。
3. **2b 的 PR 数量**：codemode 与 tool-search 放一个 PR，还是分两个？

## 影响其他会话的文件（2a）

- `core/durable/extension-host.ts`、`runtime.ts`：2a 加了 `installTools`、`beforePrompt`、tool 钩子；`submit` 与 `submitAndWait` 先运行 `before_agent_start`（B 的 `DurableController` 改动要与之衔接）。
- `core/durable/services.ts`：`disabledBuiltinExtensions` 固定包含 `codemode`、`tool-search`。
- `core/durable/extension-tools.ts`、`extension-adapter.ts`（新文件与改动）。
- 登录会话的文件：没有新改动（`pause.ts` 的改动在批次 1 已合并）。
- `CHANGELOG.md`、`ROADMAP.md`、hooks note：已更新。

## OCR

- PR #50：没有 OCR 评论。#49 之后 OCR 改为对 main 分批运行，PR 上不再触发。已写入 backlog A。
- PR #47：OCR 子进程超时，没有被覆盖，已写入 backlog A（不重跑，按主控裁决）。
- tools-images：按主控第 5 条，本轮不查，backlog 标为最高优先级，写明"#36 按比例的修法无效，Deep 负载下比例 0.49"。

## 报告文件

- `D:\nyan-orchestration\n2-c-batch2a.md`（本文件，新）
- `D:\nyan-orchestration\backlog-ocr-tests.md`（已更新：A 节 PR #50、PR #47；B 节 codemode 行改为根因结论；tools-images 行最高优先级）
