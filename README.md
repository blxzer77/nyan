# Nyan

Nyan 是由 [Pi Agent v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0) 派生的独立 Agent 产品，使用 Node.js/TypeScript。产品身份已完整改为 `nyan`（可执行文件、`NYAN_*` 环境变量、`~/.nyan` 目录、`@ny4n/*` 包名、`nyan.*` 标识）；上游组织治理、Nix 包装、Pi 专用开发助手、发布自动化和 Pi 托管服务的默认地址已移除。依赖按功能分层并由检查强制执行，见 [`docs/architecture/current-state.md`](docs/architecture/current-state.md)。

## 当前基线

- 本地目录：`D:\Nyan`
- 本地分支：`main`
- 上游版本：`v1.1.0`
- 上游提交：`abe508e1b89912adde45528136c3221eb69acdd7`
- `origin`：Nyan Fork
- `upstream`：官方 Pi 仓库（只读来源，仅作出处记录；Nyan 不再跟随 Pi）

来源、局部修改和已知限制见 `.agents/upstream/pi-v1.1.0.json`；长期决策见 `.agents/notes/`。

## 开发

```powershell
npm ci --ignore-scripts
npm run check        # lint、类型、依赖、分层、入口图、安装锁
npm run build
npm test
```

只运行与当前改动相关的最小检查。需要 Provider 凭据的测试必须明确声明，凭据不能写入仓库。

## 代码结构

- `packages/coding-agent`：CLI、Session、工具和扩展入口。
- `packages/agent`：Agent Core 循环和工具调用状态。
- `packages/ai`：Provider、模型和流式响应。
- `packages/tui`：终端 UI。
- `packages/mcp`、`packages/codemode`、`packages/protocol`、`packages/client`、`packages/server`、`packages/durable`：运行时支撑包。

分层与依赖方向见 `docs/architecture/layers.json`；示例和实验目录是候选实现，不自动代表稳定的 Nyan 能力。

## 运行时配置

`nyan` 读取 `~/.nyan/agent` 与项目内 `.nyan`，环境变量使用 `NYAN_` 前缀。Nyan 不内置任何托管服务地址；安装器、分享查看器、模型目录和 MCP 客户端元数据分别由 `NYAN_INSTALLER_API_BASE`、`NYAN_SHARE_VIEWER_URL`、`NYAN_CATALOG_BASE_URL`、`NYAN_MCP_CLIENT_METADATA_URL` 配置，未配置时对应功能关闭；版本检查默认询问 npm registry；独立二进制随 GitHub Release 发布，其 `nyan update` 默认从本仓库的 Release 下载（`NYAN_RELEASE_BASE_URL` 可改源）。

## 贡献规则

先读根 `AGENTS.md` 和目标目录规则。开发使用特性分支，`main` 是唯一集成分支。没有明确授权，不提交、推送、合并、打标签、发布或部署。
