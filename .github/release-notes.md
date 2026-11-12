## What's new in 0.2.1

**Breaking**

- Environment variables `CLAUDE_*` / `CLAUDE_CODE_*` are renamed to `NYAN_*` (e.g. `CLAUDE_CODE_SIMPLE` → `NYAN_SIMPLE`, `CLAUDE_DEBUG` → `NYAN_DEBUG`). Update your shell profiles, scripts and CI accordingly.
- The `claudeCodeHints` global config field and plugin hint recommendations are removed.

**Identity**

- UI copy and system prompts now identify the assistant as nyan.
- Requests no longer send the `x-app` header, and nyan no longer sends a Claude Code client fingerprint.
- MCP OAuth no longer uses Claude Code client metadata; a client metadata document is used only when `MCP_OAUTH_CLIENT_METADATA_URL` is set explicitly, otherwise dynamic client registration is used.

**Removed**

- The built-in Anthropic plugin marketplace, the official MCP registry and plugin recommendations. Marketplaces now come only from settings or `/plugin marketplace add`, and marketplace auto-update is opt-in.
- claude.ai account and subscription features: OAuth account, quota, voice mode, the claude.ai MCP connector, Claude in Chrome, Claude Desktop / mobile / Slack / GitHub app integrations, cloud remote sessions and tasks, and the feedback and survey features.
- Telemetry and GrowthBook.

**Fixes and security**

- Bash AST safety checks are now enabled for all users and fail closed on unsupported shell syntax.
- `nyan update --help` now shows help instead of running the updater.
- Teammate names are sanitized before de-duplication, so names such as `qa:frontend` and `qa-frontend` no longer collide.
- `rmcp` is bumped to 3.9.0 to fix RustSEC advisories (RUSTSEC-2026-0457, -0461, -0462).

## 0.2.1 更新内容

**不兼容变更**

- 环境变量 `CLAUDE_*` / `CLAUDE_CODE_*` 统一改名为 `NYAN_*`（如 `CLAUDE_CODE_SIMPLE` → `NYAN_SIMPLE`、`CLAUDE_DEBUG` → `NYAN_DEBUG`），请同步更新 shell 配置、脚本与 CI。
- 移除全局配置字段 `claudeCodeHints` 及插件提示推荐。

**身份**

- 界面文案与系统提示中的身份统一为 nyan。
- 请求不再发送 `x-app` 头，nyan 不再发送 Claude Code 客户端指纹。
- MCP OAuth 不再使用 Claude Code 客户端元数据；仅在显式设置 `MCP_OAUTH_CLIENT_METADATA_URL` 时使用客户端元数据文档，否则走动态客户端注册。

**移除**

- 内置 Anthropic 插件市场、官方 MCP 注册表与插件推荐。插件市场现在只来自设置或 `/plugin marketplace add`，市场自动更新需手动开启。
- claude.ai 账号与订阅相关功能：OAuth 账号、配额、语音模式、claude.ai MCP 连接器、Claude in Chrome、Claude Desktop / 移动端 / Slack / GitHub app 集成、云端远程会话与任务，以及反馈与问卷。
- 遥测与 GrowthBook。

**修复与安全**

- Bash AST 安全检查对所有用户启用，遇到不支持的 shell 语法时默认拒绝自动放行。
- `nyan update --help` 现在只显示帮助，不再运行更新器。
- 队友名称先清理再去重，`qa:frontend` 与 `qa-frontend` 不再冲突。
- `rmcp` 升级到 3.9.0，修复 RustSEC 公告（RUSTSEC-2026-0457、-0461、-0462）。

---

> **Platform notes**
>
> - The Windows build is **not code-signed** and has **not been tested on Windows**. Issues are welcome.
> - **macOS is not supported.**
>
> **平台说明**
>
> - Windows 构建**未做代码签名**，也**未在 Windows 上测试**，欢迎提交 issue。
> - **不支持 macOS**。
