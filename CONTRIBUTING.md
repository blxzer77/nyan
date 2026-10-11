# 为 Nyan 贡献代码

Nyan 是由 Pi Agent v1.1.0 派生的独立产品。请先阅读根 `AGENTS.md`，再查看目标包的规则和 `.agents/` 下的工作流。

## 分支

`main` 是唯一集成与发布分支。日常开发使用短生命周期特性分支；不要创建 `develop`。本地验证完成前不要请求合并。

## 变更范围

提交前明确真实入口、事实所有者和显式写集。运行时、Session、Provider、工具、子进程或持久化改动必须说明失败、取消、幂等、恢复和未知结果的处理。上游同步必须更新 `.agents/upstream/` 来源记录。

## 本地检查

```powershell
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run build
npm test
```

按改动范围选择最小检查，并在交接中报告实际运行的命令。不要使用真实 Provider 密钥提交测试结果或日志。

## 文档

当前行为写在 README、包文档和代码注释中；长期的所有权、协议、持久化和安全理由写入 `.agents/notes/`。不要把候选、示例或实验代码描述成稳定产品能力。
