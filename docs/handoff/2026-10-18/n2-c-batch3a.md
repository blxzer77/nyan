# N2: 任务 C 批次 3 第一片(宿主事件与 context)— 2026-10-18

## 状态

- **PR #56 已 squash 合并**，SHA `f069d94692a7efbb298e477b9d1c0972cd39bc3b`。合并时 head `edcefa609`，Merge gate 绿（run 39123701887）。
- 分支 `n2-host-events` 保留。
- **批次 3 未完成**（见"剩余"）。B 未开始。N2 门禁保持打开。

## 这一片做了什么

| 项 | 实现 | 说明 |
| --- | --- | --- |
| `agent_settled` | 每次 run 落定后发出，`{ aborted }` | 覆盖 `submit` 与 `submitAndWait`（RPC 走后者）。包括 unanswered——A10 的配额轮询依赖它 |
| `context` → `transformConversation` | 只在有 handler 时注册 | handler 看到的是去掉 system 消息的请求；返回的自定义消息被丢弃（durable 请求只承载 `Message`） |
| `ctx.isIdle()` | 运行计数器（运行中为 false） | 原来恒为 true |
| `ctx.isProjectTrusted()` | services 的 `projectTrusted` | 修了一个真实缺陷：需要解析信任时，原来只报初值 false，现在报解析结果 |

**`context` 的一个细节**：只有 handler 改变了列表才返回值。原样返回也会替换请求，而 durable 文档说明替换会把 system 条目合并成一条前置消息、改变 prompt 缓存前缀。

## 验证

- `npm run check`：退出码 0。
- 新测试 `durable-extension-events.test.ts` 4 个用例通过；2a/2b 相关文件 24 个用例通过。
- 变异检查 3 个，全部杀死：不发 `agent_settled`（2 个测试失败）；不注册 `context` 成员；信任答案恒为 false。

## 未验证

- `ctx.isIdle()` / `ctx.isProjectTrusted()` 没有直接通过 ctx getter 测试：在 provider hook 的 context 上读取时 handler 没有执行，原因未查（时间限制）。目前通过 services 与运行计数器间接验证。
- `agent_end`、`model_select` 未发。CPA 的每轮用量上报读 `agent_end`，这条尚未覆盖（R21）。

## 剩余（批次 3 续）

斜杠命令分发与 UI 子集（决定 4）、`before_agent_start` 的消息与 system prompt 修改（R13/R14）、提示模板（`--prompt-template` 回到 durable）、`agent_end`、`model_select`、`ctx.sessionManager` 的真实实现。完成后把 `--extension`、`--theme`、`--prompt-template` 放回 durable 路由，并做 A1–A12 全量验收。

## 影响其他会话的文件

- `core/durable/runtime.ts`：运行计数器与 `settle()`；B 的 `DurableController` 改动会碰到它。
- `core/durable/extension-host.ts`、`extension-adapter.ts`、`services.ts`（新增 `projectTrusted`）。
- `CHANGELOG.md`、`ROADMAP.md`、hooks note：已更新。

## OCR

- PR #56：没有 OCR 评论（#49 之后 OCR 对 main 分批运行）。
- PR #54（2b）：同样没有 OCR 评论，已记入 backlog A。
