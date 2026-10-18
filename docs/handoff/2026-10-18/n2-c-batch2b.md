# N2: 任务 C 批次 2b（durable 上的 codemode 与 tool search）— 2026-10-18

## 状态

- **PR #54 已 squash 合并**，SHA `a616f5ee43ed2e5e29c64d9dcbec581f1e361c09`。合并时 head `e1db0b179`（已并入 main 的 #52），Merge gate 绿（run 39122305273）。
- 分支 `n2-codemode-tool-search` 保留。
- **批次 3 未开始**。B 未开始。N2 门禁保持打开。

## 按裁决落实的部分

1. **R15 方案 A。** `codemode` 与 `tool_search` 作为 `ToolInfo` 纳入 `getAllTools`、`getActiveTools`、`setActiveTools`，使用与桥接工具**同一个激活集合**；MCP 的自动激活逻辑一行未改。
   - 激活 = 安装对应的 durable 扩展；未激活 = 用同名空扩展替换（registry 里什么都没有）。
   - 默认不激活，与 legacy 一致（`model-only` + `defaultActive: false`）。
2. **2b 一个 PR，分别测试与变异检查。** 四个测试文件：`durable-codemode`（4）、`durable-codemode-workers`（2）、`durable-tool-search`（2）、`durable-mcp`（+1，默认 codemode 暴露经 codemode 到达）。
3. **wasm 与 worker 路径复用 `config.ts`**：`createCodemodeSandbox()` 调用与 legacy 相同的 `getQuickJSWasmPath()`、`getCodemodeWorkerSpecifier()`，没有重写。
4. **worker 上限保持当前行为**：两个并发，第三个被拒绝（不排队）。槽位计数器、上限、内存常量搬到 `core/codemode-workers.ts`，legacy 与 durable 共用；legacy `execute.ts` 只做导入与重导出，行为不变。测试覆盖：正常执行、两个并发、第三个被拒绝、worker 退出后可再次执行。
5. **测试基础设施未改**；worker limit 与 usage undefined 不在 2b 里修。
6. **before_agent_start 的生命周期边界**已写进 hooks note（见下）。

## 生命周期边界（主控第 4 条，已写进 hooks note）

- **提交 prompt 前**（`submit`、`submitAndWait`）：运行 `before_agent_start`，**只应用等待**。MCP 等待直接服务器属于首个模型请求的准备阶段。
- **尚未应用**（批次 3）：handler 对消息与 system prompt 的修改（R13），以及它们添加的 prompt section（R14）。
- 该事件对每个提交的 prompt 都触发，包括排在运行中 turn 后面的；A9（每次 prompt 一次、不是每个 tool round 一次）留给批次 3。

## 验证

- `npm run check`：退出码 0。
- 新增测试 8 个用例通过（Node）。2a 与 C 批次 1 的测试仍然通过。
- legacy codemode 套件：Node 上 25/25（三次）；Bun 上 3 次里 2 次通过（见"未解决"）。
- 变异检查 10 个（`mutate-2b.mjs`），每个都恢复文件，全部被杀死：
  - codemode：激活后不安装；`getAllTools` 不含它；namespace 没传；默认激活。
  - worker：durable sandbox 不申请槽位；上限改成 3。
  - tool search：激活后不安装；`getAllTools` 不含它；默认激活。
  - R15：`getAllTools` 不含 codemode，MCP 无法自动激活（MCP 默认暴露用例失败）。
- 未验证：durable codemode 在真实负载下（CI 的 Linux 与 Bun 已跑）；R16、R17、R19；启动成本（`native-tools.ts` 静态导入 `@ny4n/codemode`，legacy 是懒加载，未测）。

## 未解决（已记入 backlog B）

Bun 下 legacy `agent-session-codemode.test.ts` 三次里失败一次（"loads the values written on the current branch"，`Codemode worker limit reached`）。这是已知的测试间干扰症状（`afterEach` 已等待计数归零，失败发生在用例开始时）。**重构前 Bun 三次全过，重构后三次中两次通过**；样本太小，不能断定搬家改变了频率。按裁决没有改测试基础设施。

## 缩减清单状态（R1–R20，详见 hooks note）

- 已完成：R5（namespace 用名字作前缀）、R8（native 工具的 `reachesTools`）、R15（MCP 自动激活）。
- 尚未：R13、R14（批次 3）；R16（`models` 全局、分类器、图像生成）；R17（`codemode.mode: "only"`）；R18（tool search 只加载 deferred 工具，legacy 也会加载 codemode 暴露的工具）；R19（codemode 的 `reachesTools` 是 `"all"`，legacy 会按脚本收窄）；R20（`inlineBudget` 读设置，`mode` 设置未用）。

## 需要主控知道

1. **R19 的取舍**：codemode 的 `reachesTools` 用 `"all"`，MCP 会在 codemode 调用前等待**所有**服务器（更慢但不会错）。要贴近 legacy，需要把 legacy 的 `getScriptReach(input.code)` 暴露出来复用。
2. **R18**：legacy 的 tool search 会把 `codemode` 暴露的工具加载给模型；durable 版本只加载 deferred。这是 durable codemode 的内部设计，不改的话 codemode 暴露的工具只能经脚本到达。
3. **启动成本**：`core/durable/native-tools.ts` 静态导入 `@ny4n/codemode`（拿 `CodemodeSandbox`、`loadQuickJSWasm`）。如果启动耗时明显，改成首次激活时动态导入（批次 3 或之后）。

## 影响其他会话的文件

- `core/codemode-workers.ts`（新）：槽位与内存常量，两个路径共用。
- `extensions/codemode/execute.ts`：导入与重导出，行为不变（登录会话的文件，但本批次只动了这一处）。
- `core/durable/native-tools.ts`（新）、`core/durable/extension-host.ts`：批次 3 会继续改后者。
- `CHANGELOG.md`、`ROADMAP.md`、hooks note：已更新。

## OCR

- PR #54：没有 OCR 评论（#49 之后 OCR 对 main 分批运行）。已记入 backlog A。
