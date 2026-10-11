# Nyan Agent Governance

Nyan 将 Agent 工作分成三层：

- 根 `AGENTS.md`：所有贡献者和 Agent 都必须遵守的当前规则。
- `.agents/notes/`：只保存需要长期记忆的决策、替代方案、后果和证据。
- `.agents/skills/`：可复用的工作流指导；skill 不替代代码、测试或用户授权。
- `docs/`：当前事实、架构基线和文档导航；不承载尚未实现的未来行为。

每次工作先确认真实入口和写集，再执行最小验证。源码存在、类型通过、测试通过、构建产物可调用和已发布是不同证据等级。

文档事实的归属、当前架构和改名状态见 [`docs/README.md`](../docs/README.md)。`proposed` 阶段的 Note 不能在 README 或发布说明中写成已完成能力。
