# @blxzer/pactile-retrieval-worker

独立的本地代码检索 Worker。当前包不依赖 Electron、Renderer、Agent 主循环、Product Kernel 或 Plane。

## 本地运行

要求 Node `>=24.0.0`。在 Pactile workspace 根目录安装后：

```powershell
pnpm --filter @blxzer/pactile-retrieval-worker build
pnpm --filter @blxzer/pactile-retrieval-worker test
pnpm --filter @blxzer/pactile-retrieval-worker lint
```

直接运行 JSONL RPC：

```powershell
'{"id":1,"method":"init"}' |
  node packages/retrieval-worker/dist/bin/retrieval-worker.js D:\path\to\workspace
```

支持的方法是 `open`、`init`、`sync`、`list`、`search`、`read`、`inspect`、`graph`、`execute`、`stats`、`watch.start`、`watch.stop` 和 `close`。每行输入对应一行 JSON 响应；错误响应形如 `{ "id": ..., "error": "..." }`。

## TypeScript 入口

从 `src/index.ts` 导出 `RetrievalWorker`、请求/结果类型、`RuleDecisionProvider`、`CompositeDecisionProvider`、`HttpDecisionProvider`、`SystemOneDecisionProvider`、原生 parser 接缝和 `serveStdio`。`WorkerOptions.decisionProvider` 可以注入同步或异步的自定义 DecisionProvider。Provider 只输出 intent、预算和 rationale；候选的 hash/bytes/lineCount facts 始终由 Worker 对当前工作树 inspect 产生。

JSONL RPC 在设置 `PACTILE_DECISION_API_KEY` 时会启用语义规划器。`PACTILE_DECISION_BASE_URL` 包含 `/systemone` 时自动选择 Jev/System One 协议，并通过同一 host 的 `/health` 探测模型；也可以显式设置 `PACTILE_DECISION_PROTOCOL=system-one` 和 `PACTILE_DECISION_MODEL`。其他地址使用 OpenAI-compatible `/chat/completions`。不设置 key 时保持本地 Rule provider，不发起网络请求。两种语义规划器都只发送查询和预算边界，不发送源码内容。

Worker 在 `.pactile/retrieval/<worktreeId>/relations.sqlite` 保存 relation store，使用 WAL、单写队列和只读连接池。`init`/`sync` 发布 generation 和 snapshot；`execute` 在 generation 变化时返回 `stale`，并保留开始时的 scope，避免把迟到结果伪装成当前索引。

Exact 搜索优先调用 `rg`；没有 `rg` 时会回退到受 workspace 边界、ignore 规则、文件大小和二进制检查约束的本地遍历，因此 README/配置等文本文件也能被检索。取消或超时不会发布新的 ready generation。`stats().activeReads` 报告当前在途的 `read()`/`inspect()` 调用数，`stats().queueDepth` 报告当前正在执行或在排队等待执行的 `sync()` 数量（执行中的 pass 计为 1，其后每个等待者各计 1），两者空闲时均为 0。结构索引（`graph`/`execute`）与索引写入（`init`/`sync`）不计入 `activeReads`。

当前结构提取器是确定性的语言级 symbol/import/call parser，用于提供可审计的第一阶段实现；它不声称覆盖完整 CodeGraph 的 Tree-sitter 语义。分桶评测、no-gold、语义 Provider 和端到端关联评测按根任务的 [`evaluation-plan.md`](../../../.pactile/tasks/10-04-pactile-retrieval-worker/evaluation-plan.md) 由独立 Agent 运行。
