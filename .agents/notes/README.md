# Nyan Agent Notes

`.agents/notes/` 保存会影响未来实现的长期决策，不保存任务清单或实现流水账。根 `AGENTS.md` 是当前行为规则；Agent Note 只补充“为什么这样决定、放弃了什么、如何证明”。

## 生命周期

- `proposed/`：尚未交付的提案。
- `implemented/`：已经交付，正文必须使用现在时态描述真实代码。
- `rejected/`：明确否决但仍能防止重复犯错的提案。
- `archived/`：冻结的历史记录，只读，不是当前行为来源。

## 分类

用 `architecture/` 记录源码边界和运行时所有权，用 `process/` 记录 CI、上游同步、依赖或发布流程，用 `feature/`、`bug-fix/`、`simplification/`、`testing/` 记录相应决策。不要使用 `refactor/` 作为分类。

## 文件格式

活跃 Note 的前三行必须是：

```markdown
# Agent Note: <title>

Status: proposed
```

或 `Status: implemented`、`Status: rejected — <reason>`。正文从 `## Problem` 开始，必须包含 `## Alternatives considered`。提案使用 `## Proposal`、`## Acceptance criteria`、`## Risks`；已实现决策使用 `## Decision`、`## Consequences`。英文文件是事实主文件；中文对侧文件只有在真正维护双语时才创建，不能复制一份失真的翻译。

## 创建与更新

新增 Note 前搜索活跃目录，确认没有同一决策的旧记录。只更新同一决策的事实时修改原 Note；决策反转或替代时新建 Note 并互相链接。归档或删除必须保留仍能防止错误决策的理由，并先修复入站链接。
