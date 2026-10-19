# N2: 任务 D(durable 路径加载资源与扩展 provider)— 最终状态

> **已更新(2026-10-18):** 本文中“回归未修”的部分已由 PR #46 修复,见 `n2-d-fix.md`。CHANGELOG 中关于 `--append-system-prompt`、`--theme`、`--prompt-template` 的说法已更正。

## 状态

- **PR #40 已 squash 合并**,SHA `519456b1ba4e52130f78decee31371fd684422fb`。合并时 head `30ab1f15d`,Merge gate 绿(run 39076626511),Deep verification 绿。
- 分支 `n2-durable-resources` 保留(未删除、未 force-push)。
- 提交:`78ea293ca` feat(代码+测试),`30ab1f15d` docs(ROADMAP N2 行 + CHANGELOG)。rebase 到 `28ff7cfca`(#36)时无冲突。
- ROADMAP N2 行:D 已完成;C、B 未做;N2 门禁保持打开。

## 合并后发现的回归(需要你们决定)

OCR 在 `30ab1f15d` 上给出 12 条发现(原文 `D:\nyan-tmp\n2\tmp\ocr40.md`,已写入 `backlog-ocr-tests.md` 的 PR #40 小节)。我对其中关键项做了代码核实,确认下面几条**是 D 引入的回归**,而且与 CHANGELOG 中的说法矛盾:

| 旗标 | 现象 | 核实 | 级别 |
| --- | --- | --- | --- |
| `--append-system-prompt` | 静默丢弃 | `prompt.ts` 的 `KEYS` 不含 `addendum`;`system-prompt.ts:172` 写入的是 `addendum` | high |
| `--use-theme` | 静默忽略(交互模式) | `main.ts:773` 对 `startupSettingsManager` 做内存覆盖,durable 不再使用它 | medium |
| `--theme <路径>` | 加载但不生效 | `modes/durable/tui.ts` 无 `setRegisteredThemes`(legacy 有) | medium |
| `--prompt-template` | 加载但不展开 | durable 目录内无 `getPrompts`/模板展开 | medium |
| settings.json 错误 | 不再报告 | 无 `collectSettingsDiagnostics` | medium |

另外 `process.exit(1)`(`runDurableCommand`)会在 `main()` 被复用时杀掉宿主进程;`bindProviderActions` 缺 try/catch。两条都是 medium,已入 backlog。

**我没有直接改代码。** 原因:owner 已裁决 OCR 单独开任务处理;而 `--theme` 和 `--prompt-template` 的去向(实现,还是改回 legacy 路由)需要你们决定。我的建议:

1. 先开一个小 PR(D-fix)修 `addendum`(一行加 `KEYS` + 测试)和 `--use-theme`(把覆盖透传给 services),并修正 CHANGELOG 中关于 `--append-system-prompt`、`--theme`、`--prompt-template` 的句子。**在 C 之前完成**,因为 C 会动同一批文件。
2. `--theme` 与 `--prompt-template`:二选一。要么把这两个旗标从 durable 路由中拿掉(回到 legacy,改动只在 `canRunDurableProductPath`,owner 需确认改变了已确认的清单),要么在 durable TUI 注册主题、展开模板(工作量较大,放进 C 之后)。
3. `--extensions` 与 `--no-mcp`:C 完成前,扩展工具和命令不可用。owner 决定是否在 C 之前把它们改回 legacy 路由。

## 未覆盖与未验证

- OCR 未审阅 `core/durable/runtime.ts` 与 `harness-setup.ts`。
- 交互 TUI 的信任提示、`test:bun` for coding-agent、`--mode rpc/json` 完整流程、bundle 启动检查:未跑。
- 已知设计缺口(给 C):`openDurable()` 每次新建 services(RPC `new_session` 会重复跑扩展 factory,违反 S2);`close()` 不释放 services。

## 操作记录

- 我曾用一个手写的不完整 SHA 调用 `gh pr merge --match-head-commit`,gh 拒绝了合并,没有产生副作用;随后用真实 head 重试并成功。
