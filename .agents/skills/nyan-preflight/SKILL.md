---
name: nyan-preflight
description: 为 Nyan 选择与变更范围匹配的最小验证，并报告实际证据。
---

# Nyan 变更预检

先运行 `git status --short --branch` 和 `git diff --stat`，确认分支、基线和写集。阅读变更文件的完整上下文，确认真实入口和所有受影响的包。

按表面选择证据：

- TypeScript、导出、依赖或构建入口：`npm run typecheck`，必要时 `npm run build`。
- 格式、注释或文档规则：`npm run lint` 和 `git diff --check`。
- 具体行为：运行拥有该行为的聚焦测试；测试应经过真实 CLI、Session 或扩展加载路径。
- Session、Provider、工具、子进程或恢复：增加 admission、取消、重启、重复请求和未知结果的测试或明确证据。
- 发布路径：在提交或推送前运行 `npm run build` 和可执行产物 smoke；没有发布凭据时只报告未发布。

不要为了覆盖率数字缩小测试范围，也不要把完整测试套件当作所有变更的默认动作。报告通过、跳过、失败和无法证明的部分。
