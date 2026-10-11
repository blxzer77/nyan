---
name: nyan-upstream-sync
description: 安全同步 Pi 上游源码并保留 Nyan 局部修改、来源和验证证据。
---

# Nyan 上游同步

同步前记录当前 `main`、`upstream` 的确切提交和工作区状态。只把目标 Pi 提交引入临时分支；不得在未审查的情况下覆盖 Nyan 工作树。

每次同步更新 `.agents/upstream/` 中的来源清单，记录远程、tag 或提交、目标路径、局部修改、冲突处理和运行过的验证。上游实现存在不等于 Nyan 已接入；未经过 Nyan 入口的代码标记为 candidate。

冲突只在明确属于本次同步且有 Nyan 所有者的文件中解决。无法判断所有权时停止并保留现场。同步完成后至少运行 `npm run typecheck`、受影响包的聚焦测试、`npm run build` 和 `git diff --check`。
