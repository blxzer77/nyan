# N2: D-fix(#40 的回归修复),2026-10-18

## 状态

- **PR #46 已 squash 合并**,SHA `350da52f0173c2c896023ee32674179f59ecf3bc`。合并时 head `1bae69093`(已 merge `origin/main` 的 #41),Merge gate 绿(run 39111223785)。
- 分支 `n2-d-fix` 保留。

## 修了什么(主控第 1 条)

| 项 | 修前 | 修后 | 测试 | 变异 |
| --- | --- | --- | --- | --- |
| `--append-system-prompt` | 文本被丢弃:prompt 的 section 列表里没有 `addendum` | `addendum` 进入 `KEYS`,顺序与 `buildSystemPromptSections` 一致(docs 之后) | "--append-system-prompt text reaches the request" | 去掉 `addendum`:失败 |
| `--use-theme`(交互模式) | 被忽略:durable 自建 SettingsManager,legacy 的覆盖写在启动用的 manager 上 | `OpenDurableOptions.settingsOverrides` 在 session 打开前应用到 durable 的 manager 上;`durableOptions()` 只在交互模式传入(与 legacy 一致) | "settingsOverrides apply to the session's settings"; "--use-theme reaches the durable settings only in the interactive mode" | 覆盖不应用:失败;`main` 不传:失败 |
| settings.json 解析错误 | 被吞掉:启动 manager 已 drain,durable 的 manager 从未 drain | `createDurableServices` 把 manager 的错误收进诊断(与 legacy `createRuntime` 相同) | "an invalid settings file is reported as a diagnostic, not dropped" | 去掉收集:失败 |
| `--extension`、`--theme`、`--prompt-template` | 路由到 durable,在那里被静默忽略 | 改回 legacy 路由;`canRunDurableProductPath` 上有注释写明"C 完成后放回";CHANGELOG 同样写明 | `test/durable-route.test.ts`(3 个 legacy,7 个留在 durable) | 把 `--extension` 放回 durable:失败 |

`--no-mcp`、`--no-extensions`、`--no-themes`、`--no-prompt-templates` 留在 durable:它们只是禁用 durable 本来就不加载的东西,没有被静默丢弃的功能。

## CHANGELOG(主控第 1 条:更正 D 的条目)

Unreleased / Changed 里的 D 条目改为:列出 durable 路径实际读取的旗标(`--skill`、`--no-skills`、`--no-context-files`、`--system-prompt`、`--append-system-prompt`、`--no-extensions`、`--no-mcp`、`--no-themes`、`--no-prompt-templates`、`--approve`、`--no-approve`);写明 `--use-theme`(交互模式)与 settings 错误报告已生效;写明 `--extension`、`--theme`、`--prompt-template`、会话旗标仍走 legacy。旧条目说这三个 flag 在 durable 上生效,是错的。

ROADMAP 的 N2 行:D 的句子改为与实际一致,并注明三个旗标留在 legacy,直到 C 完成。

## 验证

- `npm run check`:exit 0。
- `npx vitest --run test/durable test/cliproxyapi test/durable-route.test.ts test/durable-resources.test.ts test/args.test.ts`:8 个文件,224 个用例通过。
- 变异检查 5 个(F1–F5),全部被杀死,每个都在恢复后确认文件与提交一致。F5 的锚点被 biome 重排过一次,改用 `? {}` 的替换后重跑通过。
- 未跑:完整 coding-agent 套件(CI 跑);交互 TUI(没有终端,`--use-theme` 只在 settings 层验证——TUI 的主题控制器读的就是这个 settings 对象)。

## OCR

- 合并时 OCR(`1bae69093`)有 1 条 low:同一份损坏的 settings 文件被多次 `recordError`,durable 路径会展示 2–3 条相同的 warning。**有效,未修**,已写入 `backlog-ocr-tests.md` 的 PR #46 小节。修法是一行 `deduplicateDiagnostics(...)` 加一个测试,等下一次碰 services 时一并修。

## 合并过程中的小事

- 第一次尝试 `gh pr merge --match-head-commit` 时,我手写的 SHA 不完整,gh 拒绝了合并,没有副作用。之后用真实 head 重试并成功。
- PR 开出后 main 又前进了 #41(`packages/client`,与本 PR 无关),PR 变为 BEHIND。我用 merge 把 main 并入 `n2-d-fix`(已推送,没有 force-push),重跑 CI,Merge gate 绿后合并。

## 没做

- 其余 OCR 发现(见 backlog)。
- 本 PR 不处理 C 的任何内容(C 在 #47)。
