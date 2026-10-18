# 待集中处理:OCR 发现、不稳定测试、未验证项

主控维护。owner 决定(2026-10-18):OCR 不再是合并条件;OCR 发现和测试问题攒到一起,之后单独开任务处理。
各会话合并 PR 时,把没处理的 OCR 发现追加到本文件对应小节(写明 PR 号、文件、级别、一句话描述)。

## A. OCR 发现(未处理)

### PR #35(Bun 批次 1,retry/transport-error),合并后 e3969a613 上的 5 条
1. medium `packages/ai/src/utils/retry.ts`:状态码关键字没有词边界。Bun 的证书错误消息会带请求 URL,
   `code500.example.com`、`?status=500` 这类 URL 会被当成状态码,证书失败反而被重试。
   影响上限:等于 #35 之前的行为(证书失败被重试)。优先级最高。
2. medium `retry.ts`:Bedrock 的 `<prefix>: 503: <body>` 形式不被识别,503 正文提到证书时不再重试。
3. medium `packages/ai/src/api/mistral-conversations.ts`:`formatMistralError` 与 `normalizeProviderError`+`formatProviderError` 重复。
4. low:llama 与 provider-retry 共用一个 `isCertificateError`。
5. low:`isCertificateErrorCode` 多余的 export。
- 未被 OCR 覆盖:`error-body.ts`、`provider-retry.ts`(模型调用失败)。
- 详情:`bun-phase3-progress.md`。

### PR #31 / #38(CLIProxyAPI 登录),6 条
- 3 条 medium:WeakSet 标记在对象复制后丢失;`ProviderConfig` 没有声明新字段(要改 `core/extensions/*`,N2 的文件);
  只有配置 key 时标签短暂显示为 oauth。
- 3 条 low。
- 详情:`login-merge.md`、`login-ocr.md`(第 1–22 轮)。

### PR #36(N2 CI 稳定性,合并 `28ff7cfca`,合并时 head `73204a4b4`)

合并时已处理:OCR 在 `9a25c6ba7` 上的 8 条(见 PR 描述的处理表)。合并后 OCR 在 `73204a4b4` 上又给出 10 条(下面列出,均未修)。以下 3 条在之前的处理表中已写明不修,也一并记在这里:

- low `packages/coding-agent/src/core/bash-executor.ts`(UI):写入失败的说明只进 `output`;交互式 `setComplete` 不渲染 `result.output`,用户看不到。需要结构化字段(如 `outputSaveError`)由各模式渲染。
- low `.github/workflows/ci.yml`(结构):三个 shard job 的 `Ensure fd and ripgrep` 步骤各写一遍 apt 调用;组合 action 没做,列表变长时再做。
- low `packages/coding-agent/src/core/bash-executor.ts`(结构):与 `OutputAccumulator` 的临时文件生命周期重复,错误约定不同(reject 与 resolve);流式 bash 工具依赖 accumulator 的 reject。应合成一个 helper(`utils/output-files.ts`)。

73204a4b4 上 OCR 的 10 条(`ocr36-final.md` 原文在 `D:\nyan-tmp\n2\tmp\`):

1. medium `scripts/apt-install.test.mjs:L32`:stub 只记录子命令,不记录包名;去掉 `"$@"` 不会被测出。建议记录完整参数并断言 `install pkg1 pkg2`。
2. medium `packages/coding-agent/src/core/bash-executor.ts:L85-86`:`closeTempFile()` 没有超时,若 fd 关闭或写回调挂起,命令结束后结果永远不返回,TUI 停在“运行中”。建议加有限超时并按“文件不可用”处理。**产品问题,优先级最高。**
3. medium `.github/scripts/apt-install.sh:L41`:`sudo` 没有 `-n`(自托管 runner 需要密码时会挂住);没有 `DEBIAN_FRONTEND=noninteractive`;apt 的 stdin 未指向 `/dev/null`。建议 `sudo -n`、导出 `DEBIAN_FRONTEND`、stdin 重定向。
4. medium `scripts/apt-install.test.mjs:L95`:install 的不可重试错误路径没有用例(与 update 对称的那条),deadline 放弃分支也没有用例。
5. low `.github/scripts/apt-install.sh:L16`:`APT_RETRY_DELAY` 未校验,非数字时在 `set -u` 下以难懂的错误退出。建议校验并补用例。
6. low `.github/scripts/apt-install.sh:L24-25`:单次 apt 调用没有超时上限,deadline 只在失败后检查。建议 `timeout` 包一层,124 归入可重试。
7. low `scripts/apt-install.test.mjs:L50-51`:`spawnSync` 没有 `timeout`,重试退化时测试会挂住而不是快速失败。
8. low `scripts/apt-install.test.mjs:L102-104`:自定义 `assert` 没有差异输出;仓库其他脚本测试用 `node:assert/strict`。
9. low `packages/coding-agent/src/core/bash-executor.ts:L154-156`:命令失败的分支忽略 `closeTempFile()` 的结果,完整输出文件会留在临时目录里。建议删除该文件。
10. low `packages/coding-agent/src/core/bash-executor.ts:L172`:`truncated === false` 时仍追加 “Full output was not saved”,会误报截断。建议只在 `truncated` 为真时追加。

### PR #56（N2 批次 3 第一片，合并 `f069d9469`，合并时 head `edcefa609`）

- 没有 OCR 评论（#49 之后 OCR 对 main 分批运行）。Merge gate 绿、Deep verification 绿。

### PR #54（N2 批次 2b，合并 `a616f5ee4`，合并时 head `e1db0b179`）

- 没有 OCR 评论（#49 之后 OCR 对 main 分批运行，PR 上不触发）。Merge gate 绿。

### PR #50（N2 批次 2a，合并 `f8fae5da3`，合并时 head `1ce060d0b`）

- 没有 OCR 评论：#49 之后 OCR 改为对 main 分批运行，PR 上不再触发（本 PR 的 OCR 检查结果是 pass，但没有产生审阅）。下一批次的 OCR 结果会在 main 的批次里出现，届时按规则记入本节。
- 本 PR 修过的一个假阳性（已在 PR 描述里更正）：MCP 测试最初因为 `getAllTools` 不可用而阻断了所有 MCP 工具调用，但断言误读了助手的工具调用参数，所以测试通过。现在断言读取工具结果消息。

### PR #47（N2 任务 C 第一批，合并 `96de1e0a9`，合并时 head `c6906217c`）

#47：OCR 子进程超时，没有被覆盖（不重跑，按主控裁决；Merge gate 绿）。

### PR #46（N2 D-fix，合并 `350da52f0`，合并时 head `1bae69093`）

OCR 在 `1bae69093` 上 1 条（`D:\nyan-tmp\n2\tmp\ocr46.md`），已核实为有效:
- low `packages/coding-agent/src/core/durable/services.ts:L110`：同一份损坏的 settings 文件在构造和每次 `reload()` 时都会被 `recordError`，`drainErrors()` 返回多份相同错误；durable 路径直接展示，用户会看到 2~3 条相同的 warning。legacy 用 `deduplicateDiagnostics` 去重。建议：`deduplicateDiagnostics(collectSettingsDiagnostics(settingsManager))`。**未修**，下一次触碰 services 时一并修（这是一行 + 一个测试）。

### PR #40（N2 任务 D，合并 `519456b1b`，合并时 head `30ab1f15d`）

OCR 在 `30ab1f15d` 上 12 条（文件列表和原文在 `D:\nyan-tmp\n2\tmp\ocr40.md`）。**OCR 未覆盖 `core/durable/runtime.ts` 与 `harness-setup.ts`**（模型调用失败）。以下条目已对照代码核实：

- **high — 回归**（D 引入）`packages/coding-agent/src/core/durable/prompt.ts:45-46`：`--append-system-prompt` 与设置中的 append 在 durable 路径被静默丢弃，`KEYS` 不含 `addendum`（`system-prompt.ts:172` 写入的段）。CHANGELOG 写着该旗标已被读取。建议：`addendum` 加入 `KEYS`（`docs` 之后），并测试 append。**优先级最高，建议先修。**
- **medium — 回归**（D 引入）`main.ts:199-202`、`services.ts:66`、`modes/durable/main.ts:4`：`--use-theme` 的内存覆盖写在 `startupSettingsManager` 上，`createDurableServices` 新建了 SettingsManager，durable 交互模式下该旗标被静默忽略（之前 durable 路径能生效）。建议：传递设置覆盖并在 services 创建后 `applyOverrides`。
- **medium — 未实现**（D 引入路由）`main.ts:202`：`--theme <路径>` 加载的自定义主题文件在 durable TUI 中从不注册（`modes/durable/tui.ts` 只调 `themes.applyFromSettings()`，无 `setRegisteredThemes`），legacy 则调用。CHANGELOG 写了“加载主题”。
- **medium — 未实现**（D 引入路由）`main.ts:201`：`--prompt-template` / `--no-prompt-templates` 路由到 durable，但 durable 从不读取 `getPrompts()`，也不展开模板；静默忽略。CHANGELOG 写了“加载模板”。
- **medium — 回归**（D 引入）`services.ts:104-117`：settings.json 解析错误未收集（legacy 的 `collectSettingsDiagnostics`，`main.ts:953`），durable 路径下损坏的 settings 不再报错。
- **medium**（D 引入）`main.ts:177-178`：`runDurableCommand` 中 `process.exit(1)`。`main()` 是包入口导出，`experimental/cli.ts` 也复用，会连带杀掉宿主进程。建议：打印后设 `process.exitCode = 1` 并返回。
- **medium**（D 引入）`services.ts:128-132`：`bindProviderActions` 没有 try/catch，晚到的注册报错会变成 unhandled rejection，不进入 diagnostics。建议与 `createAgentSessionServices` 一样捕获并上报。
- **medium — 已知限制（owner 决定 2/4 已确认）**`main.ts:199`：`--extension` / `--no-mcp` 路由到 durable，扩展工具、命令、事件不连接（等 C），用户显式传 `--extensions` 时比 legacy 少功能。CHANGELOG 已说明工具/命令/事件不可用。需要 owner 决定：C 完成前是否改回 legacy。
- **medium（可维护性）**`services.ts:104-117` 与 `main.ts:954-961`：扩展诊断映射重复，`main.ts:1067` 依赖 `Failed to load extension` 文案。抽成共享函数。
- low（可维护性）`main.ts:166-169`：`printDurableDiagnostic` 把 info 标成 Warning；应复用 `reportDiagnostics`。
- low（用户体验）`main.ts:193-195`：只传 `--provider` 不传 `--model` 时报 `Could not resolve model:`（空），legacy 为 `--provider requires --model`。

### PR #48(Bun 批次 2,HTTP 后端拆分,合并 `f8416a835be12f81d8de69cf4df416352faff3d9`,合并时 head `a1ed435e6`),2 条
OCR 在合并后出结果(8 个文件里 `core/http/undici.ts` 因模型调用失败未被审阅)。
1. low `packages/coding-agent/src/core/http/native.ts`:`resetNativeFetchForTests()` 的注释写"让下一次调用从头配置",但它不恢复 `globalThis.fetch`。wrapper 仍是全局 fetch 时调用它,下一次 `configureNativeFetch` 会因 `current !== originalGlobalFetch` 直接返回,超时不再安装;现在靠测试在调用后手动 `globalThis.fetch = originalFetch`(`http-dispatcher.test.ts`)。修法:reset 里一并恢复全局 fetch。
2. low `native.ts` 与 `undici.ts`:"全局 fetch 是否仍是我们装的,否则让位"的判断写了两遍(拆分前在一个文件里)。可抽成 `http/` 下的小函数共用。
- 详情:`bun-phase3-progress.md`。
## B. 不稳定或非封闭的测试

| 测试 | 现象 | 状态 |
|---|---|---|
| durable `tools-images` "prepares in a worker thread" | 原 100 ms 断言，CI 上 130–303 ms；当前 Deep 负载下比例 0.49 | **最高优先级。#36 按比例判断的修法无效**（Deep 负载下比例为 0.49，job 117414754292，`loop gap with the worker (606 ms) against inline (1244 ms)`）。遇到就重跑，本轮不查。 |
| coding-agent `experimental-remote-runtime` "stops an idle Session worker…" | 进程退出时序(测试问题:退出后 `kill(pid,0)` 单次检查) | 已修(#36 合并:轮询 10 s;仅 Ubuntu 运行) |
| self-hosted runner apt-get 锁 | Install system dependencies 失败 | 已修(#36 合并:`apt-install.sh`;main 已改为 hosted,脚本仍用于 ci.yml 三处与 native.yml 一处) |
| coding-agent `agent-session-codemode`（Bun 与 Node）：`Codemode worker limit reached`，以及 "adds the usage of nested results" 的 `result.usage` 为 undefined | **已定性为测试间干扰，main 上已有修法（afterEach 等待 `codemodeWorkersInFlight()` 归零，见 `074fa787d`）**。证据：Deep 第 2 次（job 117416710977）与第 3 次（job 117421022493）都在 head `7d33a133b` 上失败，该 head 没有这个等待；当前 main 上有。本地在 Node 与 Bun 下各连跑 3 次，文件 25/25 全部通过。`usage` 为 undefined 很可能是同一个根因：脚本没有启动，所以没有工具调用，也没有 usage（推断，Deep 日志里没有结果体）。host.ts 的槽位获取与释放成对，没有泄漏分支。**未修、不在 2b 里修**。待 owner 决定的产品问题：超过两个并发脚本时是直接拒绝（现状），还是排队？ |
| coding-agent `agent-session-codemode`（Bun）：`loads the values written on the current branch` 失败于 `Codemode worker limit reached` | 与上一行同一类测试间干扰。**2026-10-18 的观察**：把槽位计数器搬到 `core/codemode-workers.ts`（逻辑不变）后，Bun 本地三次中失败一次；搬家前三次全过。样本太小，不能断定搬家改变了频率。`afterEach` 的等待仍在。**未修**，需要一次专门排查（用 `--sequence.shuffle` 复刻，或给 `acquireWorker` 加调用栈日志）。 |
| `nightly.yml`、`release.yml` 的 apt 调用 | 未用 apt-install.sh | 见 C 节 |
| coding-agent `suite/agent-session-codemode` "adds the usage of nested results" | Node 和 Bun 都偶发,`result.usage` 为 undefined;本地 Bun 报 `Script sandbox failed` | 产品问题嫌疑;main 上 074fa787d 记录了 codemode 根因,待核对 |
| durable `codemode.test.ts` | Bun 下偶发 | 待查 |
| MCP conformance | 一次失败,重跑通过 | 待查 |
| coding-agent `package-command-paths` | 依赖真实 home,home 指向空目录就失败 | 非封闭测试 |
| durable `provider-session-cache-e2e` | `~/.nyan/agent/auth.json` 有 openai-codex 凭据就跑真实请求,清环境变量挡不住 | 非封闭,会花钱 |
| durable `harness-tools` "records how long execute() took" | < 100 ms,本机负载下失败 | 待查 |
| 多个 durable/coding-agent 用例 | 本机高负载下 5 秒超时 | 本机现象,CI 未见 |
| Deep verification 的 `Run Bun critical parity tests` 步骤 | 步骤脚本是 5 行 `npm run test:bun -- <包>`(ai、agent、durable、coding-agent、protocol),每行只跑一个包;`-- ai` 的过滤有效(`==> ai` 只跑 ai)。agent、durable、coding-agent 之所以也跑,是因为脚本逐行列出了它们,不是过滤失效。codemode 的 FAIL 出现在第 4 行(coding-agent),job 117421022493,14:39:56。 | 已查清,无需修 `test-bun.mjs` |

| durable `sqlite-runtime-adapter` "int64 min" | Node 24.3.0(本机,SQLite 3.50.1)读 int64 min 抛 RangeError;CI 的 Node 24.x 返回精确 double(-2^63 是 2 的幂)。#57 的测试改为断言"不丢精度"(抛错或能精确还原),适配器仍抛错 | 已记录,后续 Node 升级需复核 |
| coding-agent `durable-resources`、`durable-extension-host`(Windows+Bun) | 基线在 Windows+Bun 下 11 个用例因删除临时 home 报 EBUSY 失败(未关闭的 node:sqlite 连接锁文件) | **已修**:#57 让 Bun 走 `bun:sqlite` 并在关闭前 finalize,15/15 通过;main 的 #55 另修了 ENOTEMPTY 重试 |
## C. 延后的功能项(不是 OCR)

- CPA 配额节流状态持久化(`{ rejectedFingerprint, bannedUntil }`,见 `n2-t3-cpa-acceptance.md` 恢复问题 2)。
- 被拒绝的凭据覆盖旧凭据(决定 D,方案见 `login-2-rollback-plan.md`)。
- Bun:`--use-system-ca` 的验证 owner 已批准(2026-10-18),在批次 2 里用临时测试 CA 做,测完删除;undici 只在 Node 加载（Phase 4）。
- CI:`nightly.yml`(2 处)与 `release.yml`(2 处)的 `Ensure fd and ripgrep` 仍直接调 `sudo apt-get`,未改用 `.github/scripts/apt-install.sh`（#36 未触发这两个文件）。改动是每处一行;release 的发布路径需要 owner 确认。
- N2 任务 C（第一批已合并 #47，`96de1e0a9`，详见 `n2-c-extension-adapter.md`）未做的项：`before_agent_start`（A9）、`agent_settled`（A10）、turn/settle 边界、工具事件与工具桥（MCP 工具在 `session_start` 后出现，S6）、`context`、命令与斑杠分发、UI 子集（决定 4）、在 durable 上安装 codemode 与 tool-search（决定 3）、`ctx.sessionManager` 的真实实现（当前全部报错）、`isIdle` / `isProjectTrusted` 的真实值。（并行问题已修：provider 调用范围改为 AsyncLocalStorage，#47 带着并发测试）。以上在 C 第二批处理。

## D. 读日志的规则(各会话已通知)

判定"挂起"前,先在 job 日志里搜 `Failed Tests`、`FAIL `、`##[error]`。vitest 在 CI 里是点状输出,
"RUN 之后没有文字"不等于挂起。2026-10-17 有两次误判(PR #31 的 ai、PR #36 的 Deep verification),
实际都是已知的不稳定测试失败。
