# AGENTS.md

Nyan 是由 Pi Agent v1.1.0 派生的独立开发产品。Pi 是来源基线，不是 Nyan 的产品边界；Nyan 的行为、配置、持久化和发布规则由本文件与 `.agents/` 维护。

## 指令优先级

先读取本文件，再读取目标目录下更具体的 `AGENTS.md`、相关 Agent Note 和适用 skill。当前用户指令优先于仓库规则。没有用户明确授权，不提交、推送、合并、打标签、发布或部署。

## 产品边界

- `packages/coding-agent` 是当前面向用户的 Agent CLI 与 SDK 入口。
- `packages/agent` 负责 Agent Core 的循环、工具调用和状态转换。
- `packages/ai` 负责模型、Provider、认证和流式响应。
- `packages/tui` 负责终端交互；`packages/mcp`、`packages/codemode`、`packages/protocol`、`packages/client`、`packages/server` 和 `packages/durable` 提供可复用运行时能力。
- 产品身份是 `nyan`：可执行文件 `nyan`、`NYAN_*` 环境变量、用户目录 `~/.nyan` 与项目目录 `.nyan`、`nyan.*` 持久化与协议标识、`@nyan/*` 包名。Nyan 不读取 Pi 的 `.pi` 目录或 `PI_*` 变量，不提供 `pi` 别名，也没有 Pi 扩展生态的兼容承诺。
- Nyan 不假设任何托管服务：版本源、安装器、分享查看器、模型目录、MCP 客户端元数据和 Radius 网关都没有内置默认地址，必须由运营者通过 `NYAN_*` 配置；未配置时对应功能关闭或明确报错，不会连接 Pi 或其他未拥有的域名。
- 扩展、实验目录和示例是候选能力；在真实入口、持久化行为和恢复路径验证前，不得描述为 Nyan 的稳定产品能力。
- 一次模型请求可见的输入必须能够从 Session 或其他明确的持久化事实重建。未知副作用必须显式暴露，不能当成成功。

## 依赖方向与分层

依赖必须指向更稳定的一侧。包级分层、包内模块分层、稳定入口和已知例外都记录在 [`docs/architecture/layers.json`](docs/architecture/layers.json)，由 `npm run check:architecture`（已包含在 `npm run check`）强制执行：

- 包只能依赖其层 `mayDependOn` 中列出的层；同层依赖必须逐条列在 `internal`；每条跨包边的目标不得比来源更不稳定（不稳定度 I = Ce / (Ca + Ce)，由源码导入实测）。
- 跨包导入必须落在目标包 `exports` 声明的子路径上，且源码导入的工作区包必须在 manifest 中声明。
- `agent` 只能经 `@nyan/ai/contracts` 使用模型层；`durable` 只能经 `contracts` 与 `utils` 子路径。
- `ai`、`durable`、`coding-agent` 有包内模块层；`coding-agent` 的无头 `core` 不得依赖 `modes`、`cli` 或终端展示。
- 静态运行时导入环被禁止；唯一已记录的环（durable 运行生命周期）与例外必须在 `layers.json` 写明原因，消除它们需要独立的 Agent Note。

新增依赖、包或模块时先改 `layers.json` 并说明理由，不要为让检查通过而放宽规则。

## 上游与分支

- `origin` 指向 Nyan Fork，`upstream` 指向 `https://github.com/earendil-works/pi.git`（只读来源，不是 Nyan 的依赖）。
- 当前基线是 Pi `v1.1.0`，提交 `abe508e1b89912adde45528136c3221eb69acdd7`；来源清单在 `.agents/upstream/pi-v1.1.0.json`。
- `main` 是唯一集成与发布分支。开发使用短生命周期特性分支；不创建 `develop`。
- 上游同步必须记录来源提交、目标文件、局部修改、冲突处理、验证结果和未接入能力。禁止直接覆盖 Nyan 改动。

## 开发流程

1. 先说明问题、真实入口、所有者和显式写集；检查已有 Agent Note，避免重复决策。
2. 先改事实所有者，再改派生文档、快照或生成文件。跨包行为变化要同时更新使用方。
3. 运行与变更匹配的最小证据：类型检查、lint、聚焦测试、构建或真实 CLI smoke。不要用“源码存在”代替“入口可调用”。
4. 汇报实际运行的命令、通过项、跳过项、阻塞项和仍未知的行为。

## 运行时与恢复

涉及 Session、Provider、工具、子进程、并发或持久化时，必须说明 admission、所有权、取消、幂等、重启恢复、lease/epoch（如果适用）和未知结果的处理。捕获异常不等于恢复；只有状态所有者可以证明继续执行安全。失败报告要指出影响、确定性、当前处置和下一步。

## 文档与 Agent Notes

Agent Note 只记录代码和普通文档无法承载、且会影响未来决策的理由、替代方案、后果和验证。生命周期目录为 `proposed/`、`implemented/`、`rejected/`、`archived/`；归档内容冻结。机械改动、临时清单和实现过程不写成 Agent Note。文档只陈述当前已验证行为；未来计划放在 proposed Note。

## 代码约定

- 使用 ESM、严格 TypeScript 和显式类型；不要新增 `any` 或对 `unknown` 的无依据断言。
- 在扩展点增加行为，除非 Agent Note 说明了所有权变化，不直接把产品逻辑塞进 Agent loop。
- 跨包 ID、Session 事件、工具结果和错误使用稳定的判别字段；通过判别字段分派，闭合联合在默认分支暴露未处理情况。
- 配置缺失在最早可判定的位置报错；不要静默回退到另一种产品行为。
- 注释只说明非显然的所有权、时序、失败保证或安全原因；不要复述代码。

## 本地验证命令

```text
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run build
npm test
```

按变更范围选择最小集合；不要为了“看起来完整”重复已通过的命令。真实 Provider 测试需要用户明确提供凭据和范围，凭据不得写入仓库。

## 上游特性清理

上游项目的组织治理、发布站点、Nix 包装、Pi 专用开发助手和贡献者策略不属于 Nyan，已从工作树移除。运行时源码、通用扩展、测试基础设施和可复用包只有在确认没有 Nyan 消费者后才可删除；删除前必须更新对应 Agent Note 与验证。
