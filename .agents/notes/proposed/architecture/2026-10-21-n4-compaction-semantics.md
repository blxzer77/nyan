# N4 压缩语义：把已有的 compaction task 变成受治理的上下文操作

**状态：proposed（设计，不是实现）**
**前置：N3 artifact store（`packages/durable/src/artifacts/**`）。本笔记只描述 N4 要加什么、按什么顺序失败。**

## 现状（已核实，不重做）

`packages/durable/src/harness/compaction.ts` 已经是一个分阶段、有 checkpoint 的 durable task：

- 三个阶段：`select`（选切点）→ `summarize`（请求被 `SummaryRequest` 钉住：model、thinkingLevel、streamOptions、
  maxTokens、`tail`、`firstKept`）→ `retry`（`until` 到点重试）。
- 切点已经不会切断 tool 弧：`isCandidate()` 拒绝切在 tool result 上，也拒绝切在一个"其前序 assistant 调用的 result 仍在后面"的
  user 条目上。
- 上下文大小用 `estimateContext()`（最新带 usage 的 assistant + 后续估算），压缩后的摘要以 `CompactionEntry` 提交，
  并在 `nyan.live` 里维护 `compactionStatus`（attempt / retry / blocking）。
- 失败路径已经区分 `failed`（`model_error`）、`aborted`、`retry`。

也就是说 N4 不是"从零写压缩"，而是给这条已有链路补上：**准入策略、掩码、来源绑定、回执、以及失败时不变的保证**。

## N4 要加的六件事

### 1. 准入策略（C6）：`continue / mask / compact / block`

现在是"超过阈值就摘要"。改成先用掩码、必要时才摘要、前置条件不满足就显式 block：

```
measure → 未超预算      → continue
        → 超预算但有可掩码项 → mask（外置后重新 measure）
        → 重新 measure 仍超   → compact（摘要）
        → 缺少前置条件       → block（具名理由，不静默降级）
```

"可掩码项"= 满足全部条件的大 tool result：内容已在 N3 store 里（hash 可读且校验通过）、不是受保护区域、
不是当前 turn 的调用结果。**没有可读 artifact 的 tool result 永远不可掩码**——这就是"masking without a
hash-bound recovery path is rejected"。

### 2. 受保护区域（C13）

不可进摘要、不可掩码的条目：系统提示所在条目、head 之后的第一个 user 条目、当前 turn 的 assistant/tool 对、
以及 `protected` 标记的事实条目（N5 会写入，N4 先定义接口）。保护规则必须能对任意切点回答"这个切点在不在保护区内"，
并作为单独的判定函数测试，而不是藏在 `selectCut` 里面。

### 3. 来源绑定（C13）

摘要请求必须在 checkpoint 里钉住**它到底总结了哪一段**：`tail`（选段时上下文的最新条目）与 `firstKept`。
新增：被摘要前缀的**内容指纹**（对 `view.contributions[0..cut)` 的模型消息做规范化 hash）。提交时重新计算：

- 前缀指纹变了（追加、重写、并发压缩、head 移动）→ 视为 **stale basis**，不提交摘要，重新 `select`。
- `firstKept` 指向的条目已不存在 → 同上。

这条把"并发跑两次压缩""延迟编辑"两种竞态变成可判定状态，而不是"谁先提交谁赢"。

### 4. 掩码与回执（C10、C11）

> 注意：N4 依赖 N3 的 store 已经能在读时校验 hash 与长度。掩码的产物是一条 entry 级改写（保留 `toolName`、
> `toolCallId`、原始字节数与 artifact 引用），而不是删除条目。

每次压缩/掩码都要留下**一条回执**（durable 文档，键 `nyan.compaction.${taskId}` 或无 task 的 deterministic key）：

```
{ reason, model, usage, tokensBefore, tokensAfterEstimate,
  cut: { firstKept, prefixFingerprint, summarizedEntryIds },
  masked: [{ entryId, artifactKey, bytes }], summaryHash, decidedAt }
```

回执的作用不是给人看，而是让"事后审计为什么这次压缩是安全的"可重放：只要回执在，就能重算前缀指纹与前后的 token 数。

### 5. 失败时上下文不变（C12）

每个失败都必须落在"live context 未变 + 具名状态"上，不允许"部分应用"：

| 失败 | 期望 |
| --- | --- |
| 摘要 provider 报错 / 重试耗尽 | 不提交摘要条目，`failed(model_error)`，上下文不变（现有行为，保持） |
| 摘要被截断（`stopReason` 不是正常结束，或没有预期章节） | 不提交，`failed(summary_truncated)` |
| 摘要里含 tool call | 不提交，`failed(summary_contains_tool_call)` |
| 提交时前缀指纹变了 | 不提交，`failed(stale_basis)`，交给下一轮 `select` |
| 掩码时 artifact 读不到或 hash 不符 | 不掩码，整个操作 `blocked(artifact_unavailable)`，上下文不变 |
| 掩码后 measure 没有下降 | 视为掩码无效，`blocked(mask_ineffective)`，不写回执的 masked 段 |
| 回执写入失败 | 摘要也不提交（回执先于摘要提交，同一个 tx） |

不可用（`blocked`）不是失败：它是"这次操作没有发生"的显式陈述，TUI 与 RPC 都要能区分 `blocked` 与 `failed`。

### 6. 恢复

已有 checkpoint 覆盖"崩溃在 select/summarize/retry 之间"。N4 新增一条：**回执与摘要条目在同一个事务里提交**，
所以重启后只有两种情况——两者都在（操作已生效），或两者都不在（操作未发生，下一轮重新 `select`）。
不存在"有摘要没回执"的中间态。掩码的 entry 改写与回执同样同事务。

## 验收（每条都要有会失败的用例）

1. 切点检查：受保护区域内的任何位置都不是切点（表驱动，每个保护区一种）。
2. 掩码优先：预算超限但存在可掩码项时，先掩码；断言没有调用摘要 provider。
3. 掩码后再测：断言 `tokensAfterEstimate < tokensBefore`，否则 `blocked(mask_ineffective)`。
4. 无 artifact 不可掩码：删掉 artifact 后重跑 → `blocked(artifact_unavailable)`，上下文与条目内容都不变。
5. stale basis：摘要请求进行中追加一条 user 条目（或并发第二个压缩先提交）→ `failed(stale_basis)`，无摘要条目。
6. 截断摘要、含 tool call 的摘要：各自 `failed(...)`，上下文不变。
7. 回执：成功路径上回执可重算前缀指纹与 token 数；把回执写入改到摘要之后（顺序反转）→ 有一个用例失败。
8. 重启恢复：在 `summarize` 阶段关掉 Harness 再打开 → 只有"都没有"或"都在"两种状态，断言不出现半个操作。
9. 保护区域与 N5 的接口：给一个"受保护事实条目"，断言它从不进摘要、从不被掩码。

## 不在 N4 范围内

- 记忆提取与提升（N5，Decision #11）。
- 检索（N6）与外部证据（N8）。
- 回执的用户界面（N9 的 operations overlay）。
- 多客户端/多进程的压缩互斥：durable 的 conversation 只有一个写者，N4 不引入锁。
