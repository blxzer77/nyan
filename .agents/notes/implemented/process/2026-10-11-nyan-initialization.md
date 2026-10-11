# Agent Note: Nyan 初始化边界与 Pi v1.1.0 基线

Status: implemented

## Problem

Nyan 从 Pi Agent v1.1.0 Fork 开始。Pi 仓库同时包含运行时、上游组织治理、发行渠道、Nix 包装、Pi 专用开发助手、贡献者自动化和实验代码。完整保留这些内容会让 Nyan 的产品边界、验证入口和后续决策混在一起；一次性删除运行时包又会破坏真实 Agent 依赖图。

## Decision

Nyan 保留 Pi Agent Core、Provider、TUI、coding-agent CLI、协议、客户端、服务端、MCP、codemode、durable 和通用测试基础设施。Nyan 移除上游组织治理和发布外壳：根 `.pi/`、Nix 文件与目录、上游 GitHub 贡献者名单、Issue 自动化、Pi 专用本地测试入口以及上游二进制/环境发布工作流。

Nyan 使用根 `AGENTS.md` 作为当前开发规则，使用 `.agents/notes/` 保存生命周期化决策，使用 `.agents/skills/` 提供针对 Nyan 的预检、审查、错误处理和上游同步流程。`origin` 是 Nyan Fork，`upstream` 是官方 Pi 仓库；当前本地 `main` 固定在 `abe508e1b89912adde45528136c3221eb69acdd7`。

初始化当时保留了包名、`PI_*` 环境变量、`pi` CLI 和实验源码，把它们留给独立的产品化决策。该决策已实现，见 [Pi-to-Nyan productization](../architecture/2026-10-11-nyan-productization.md)；实验源码仍保留且仍是候选能力。

## Alternatives considered

**完整照搬 DeepSeek Harness 的 `.agents/`。** 放弃，因为其中的 Cordis、Python SDK、Web/desktop、Session snapshot 和包层级规则并不对应 Nyan 的 Node-only Pi 单仓库；只迁移生命周期、证据、错误所有权和文档纪律。

**删除全部 Pi 实验包、示例和 durable 源码。** 放弃，因为这些目录仍可能成为 Nyan 的 Session、扩展和恢复实现来源；在确认没有消费者前删除会制造不可见的能力回归。

**只改 README，不建立治理目录。** 放弃，因为 Nyan 的后续上游同步、实验能力晋级和恢复语义需要稳定的决策与证据位置。

## Consequences

Nyan 的工作树不再携带 Pi 上游的组织级 Issue、贡献者、Nix 和发布自动化。初始化本身不改产品身份；改名由上述产品化 Note 完成。新增能力必须先通过真实入口和最小证据，再从 candidate 变成 Nyan 产品能力。

## Verification

已运行并通过：`npm ci --ignore-scripts`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check`、`node --test scripts/local-package-install.test.mjs`（3/3）和 `git diff --check`。模型数据在本地按 `npm run hydrate:model-data` 生成，仍是忽略文件，不作为本批源代码证据。

Windows 上的完整 `npm test` 仍暴露 Pi v1.1.0 的平台基线限制，包括 Unix socket 权限、环境 daemon 未构建、路径分隔符和 TUI 路径断言；AI 模型价格断言还会随远端模型数据变化。CI 在 Ubuntu 上先构建环境 daemon，再运行完整测试和 MCP conformance。发布与远程推送仍需要独立的用户授权和凭据。
