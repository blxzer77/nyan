# N4 压缩语义：定稿设计与切片

**状态：proposed（设计已定，实现未开始）**
**前置：N4 语义见 [`2026-10-21-n4-compaction-semantics.md`](2026-10-21-n4-compaction-semantics.md)；
现状见 `packages/durable/src/harness/compaction.ts`（543 行，select → summarize → retry 三段已存在）。**

本笔记替换 2026-10-22 的第一版草案：那一版把掩码设计成"外部化 + sha256 校验 + 回执文档 + blocked 状态"，
结论是全部砍掉。下面是砍完的样子、量化依据和切片。

## 一、量化结论（先量后设计）

数据：本机 22 个真实 durable 会话（`~/.nyan/agent/sessions-durable/**`），按条目还原模型上下文，
token 用 `字符数/4` 估算（与产品估算器同量级），统计"工具结果占上下文的比例"和"清掉旧工具结果能省多少"。

| 事实 | 数字 |
| --- | --- |
| 工具结果占全部估算上下文 | **94.9%**（22 个会话合计） |
| 单会话最高占比 | 99.7% |
| 200k 预算，清掉"上一轮之前且 ≥1% 预算"的工具结果 | 超预算会话 **1 → 0**，省 392k token |
| 128k 预算，同上 | **3 → 0**，省 504k token |
| 64k 预算，同上 | **9 → 3**，省 668k token |
| 阈值 1% vs 2% vs 5% | 1% 明显更好；5% 几乎无效（200k 下 1 → 1） |
| "保留最近 2 轮" vs "8 轮" | 差别很小（392k vs 329k）：要清的量在更早的地方 |

三个结论：

1. **"先清旧工具结果、再考虑摘要"不是优化，是主路径**：在 128k 以上，光清旧结果就把所有超预算会话拉回预算内，
   摘要模型根本不需要调用。
2. 现状的 `TOOL_RESULT_MAX_CHARS = 2000`（只截断发给摘要模型的文本）几乎没用：它不动 live context。
3. 既然要清的字节本来就在不可变的条目里，**掩码不需要外部化、不需要哈希、不需要读盘校验**。

## 二、定稿设计

### 1. 掩码 = 一条"不要发送"的标记，不复制字节

条目不可变且永不删除，所以被遮的内容一直都在数据库里，恢复路径就是条目本身（id 单调、内容不可变，无需校验）。
`nyan.mask` 条目只记：被遮的条目 id 列表、占位文本版本、理由。构建上下文时，被遮条目的模型消息被替换成

```
[tool result cleared: <toolName> <bytes> bytes, entry <id>]
```

外部参照（用户提供的 Claude Code 反编译分析，`MicroCompact`）：同样是"把旧工具输出内容替换成
`[Old tool result content cleared]`，原始内容仍保留在 transcript 中，只是不再发送给 API"，并带时间衰减
（越旧越先清）、大图片/PDF 也清。结论一致：**清而不删**。

真正需要外部化 + 哈希的场景只有一个：将来按保留期**删除**条目。那不在 N4 里，N3 的 artifact store 留给它。

### 2. 准入 = 四选三，没有 blocked

```
measure ──未超预算──▶ continue（不开 task）
        └─超预算──▶ mask（清可清项）──重新 measure──┬─回到预算内──▶ continue
                                                     └─仍超──▶ compact
```

砍掉 `blocked`：它原本要表达"操作没发生（缺前置条件）"。逐条检查后没有真正的产生者——
原件就在条目里（不存在读不到），遮完没降就直接继续走摘要，没有模型就是现有的 `failed`。
因此 `nyan.live.compactions` 与 RPC `get_state` 的形状**不变**，`--mode json` 的事件集合也不动。

### 3. 切点 = 三条不变量，不引入 turn 模型

1. tool_use / tool_result 成对（现有 `isCandidate`）。
2. 正在跑的那一轮（`nyan.live.run` 起点之后）一律不切、不遮。
3. 压缩提交时写一条 boundary 标记（等价 Claude Code 的 `CompactBoundary` + `preservedSegment`），
   恢复时以它为界重建，避免把已保留的段重复压缩。

外部证据同上：Claude Code 也没有"turn 对象"，靠的是 pairing + boundary marker + preservedSegment，
PTL 极端情况才退化成"截最老的"。

### 4. 来源绑定不用哈希

`SummaryRequest` 增加 `basis = { head, entryCount, tailId }`。提交时重算三者并比较：不等即
`failed(stale_basis)`，交给下一轮 `select`（不自动重试）。条目 id 单调 + 内容不可变，
这个三元组和内容指纹等价，且不需要计算 sha256。

### 5. 回执写进摘要条目自己的 `data`

`CompactionEntry` 已经有 `data`，回执放这里，于是"回执与摘要同事务"是免费的，不需要新文档类型、
不需要新的键空间、不需要 GC 策略。字段：`{reason, model, usage, tokensBefore, tokensAfterEstimate, basis,
maskedEntryIds, summaryHash?}`——`summaryHash` 可留空，只有需要跨会话比对时才加。

### 6. 摘要校验（保留）

`summary_truncated`、`summary_contains_tool_call` 独立成 reason（现在都塌成一句文本）。
失败面保持"上下文不变"，与现状一致。

## 三、切片

| 切片 | 内容 | 写集 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| **A. context 原语** | `isProtected(view, index)`（系统提示条目 / head 后第一条 user / 在飞那一轮）、`basisOf(view, cut)`、`decideAdmission(measure)` | 新 `packages/durable/src/context/**` | 无 | 表驱动：每种保护区一行；准入三分支各一行 |
| **B. 掩码** | 候选筛选（工具结果、早于在飞那一轮、≥ 阈值）+ `nyan.mask` 写入 + 上下文占位替换 | `src/context/mask.ts`、`src/types.ts`（entry kind 校验）、spec 一节 | A | 2、3、4、9 号验收；清而不删（条目仍在、内容仍可读） |
| **C. 来源绑定** | `basis` 进 checkpoint，提交前重算，`failed(stale_basis)` | `src/harness/compaction.ts` | A | 5 号验收：摘要进行中追加条目 → 不提交 |
| **D. 校验 + 回执** | 两个新 reason；回执进 entry `data` | `src/harness/compaction.ts` | C | 6、7 号验收；顺序反转（先摘要后回执）时有用例失败 |
| **E. 准入接线 + boundary** | 用 `decideAdmission` 替换"超阈值就摘要"；mask → 重新 measure → compact；写 boundary 标记 | `src/harness/compaction.ts`、`src/harness/live.ts` | A、B、C、D | 8 号验收；重启后只有"都没有"或"都在" |
| **F. 表面与文档** | TUI/RPC 用现有字段表达"已清理 N 条工具结果"；删掉 `TOOL_RESULT_MAX_CHARS` 的重复路径；docs + changelog | `packages/coding-agent`、`docs/` | E | 用户可见变化只有"上下文更省"与一条提示 |

**并行判断**：A 与 B 可以并行（A 全是新文件；B 的 spec/类型改动与 A 不重叠）。C → D → E 必须串行，
因为都在 `compaction.ts`。F 在另一个包，E 的字段定下来就能起。

## 四、下一步

1. 先做 A（纯函数、零冲突），同时起 B 的候选筛选纯函数部分。
2. A、B 合并后串 C → D → E。
3. F 与 E 尾部重叠。
