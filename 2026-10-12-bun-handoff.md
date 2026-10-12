# 交接：修复各包在 Bun 下的测试差异

给接手的 agent。目标是让 mcp、chord、durable、ai、coding-agent 这五个包在 Bun 下的测试和 Node 下一样通过，修好一个就把它加进 `scripts/test-bun.mjs`，CI 的 `bun` 任务会自动跑到它。

## 背景

- 方向（Blxze，2026-10-12）：Node 和 Bun 都支持，重点做 Bun。Node 行为不能变，npm 包继续支持 Node >= 22.19。
- 已完成：[PR #10](https://github.com/blxzer77/nyan/pull/10) 已合并，CI 新增 `bun` 任务（`npm run test:bun`，脚本 `scripts/test-bun.mjs`），目前覆盖 agent、client、codemode、protocol、server、telemetry、tui，这 7 个包在 Bun 1.4.2 下全绿。
- 整体计划：[2026-10-12-bun-first-plan.md](2026-10-12-bun-first-plan.md)；现状分析：[2026-10-12-project-state-and-bun.md](2026-10-12-project-state-and-bun.md)。你要做的是计划里阶段 1 的第 2 步。
- 先读仓库根 `AGENTS.md` 和要改的包的 `AGENTS.md`（ai、coding-agent、tui、durable 各有一份）。

## 工作方式和规则（摘自 AGENTS.md）

- 没有 Blxze 要求不要 commit、push、打 tag、发布；开 PR 需要他同意。合并 PR 要他逐个点头。
- 不要用 `git reset --hard`、`git add -A`、`git add .`、`git stash`、force-push。只暂存自己改的文件。
- 改代码后跑 `npm run check`，完整输出，全部通过。npm 依赖和锁文件改动要先问。
- 不要为了让 Bun 通过而跳过、禁用或削弱测试；真实的 Bun 差异要在代码里解决，只是断言写法依赖 Node 的，改成两边都成立的断言。
- 改动影响 Node 行为、CLI 参数、会话文件、导出时要先告诉 Blxze。
- 提交信息格式：`fix(<package>): <message>` 之类，`<package>` 是 `packages/` 下的目录名。

## 环境准备

```bash
npm ci --ignore-scripts
# packages/ai/src/providers/data/ 被 gitignore，需要 models.dev 网络。云端拿不到时：
mkdir -p /tmp/aipack && cd /tmp/aipack && npm pack @ny4n/ai@1.1.0 && tar xzf ny4n-ai-1.1.0.tgz
cp -r package/dist/providers/data/. <repo>/packages/ai/src/providers/data/   # 含 .manifest.json
cd <repo> && npm run build:offline
```

在 Bun 下跑某个包（在包目录里）：

```bash
bun --bun ../../node_modules/vitest/vitest.mjs --run            # 整个包
bun --bun ../../node_modules/vitest/vitest.mjs --run test/x.test.ts
```

对照 Node：同一目录 `../../node_modules/.bin/vitest --run`。注意环境里如果有 `ANTHROPIC_API_KEY`、`AWS_*` 等凭据，provider e2e 测试会跑并花钱，先 unset。

## 差异清单

下面的数字来自 2026-10-12 在 Linux、Bun 1.4.2、Node 22.22.0 上的实测。Node 下本身就失败的测试不在任务内（环境相关，见最后一节）。

### 1. mcp，21 个失败（Node 全绿）

文件：`packages/mcp/test/oauth.test.ts`（8 个）、`packages/mcp/test/streamable-http.test.ts`（13 个）。

已确认的现象：所有失败都以 `Error: Server is not running.` 结束，位置在 `test/helpers.ts:36`，`closeServers()` 里先 `server.closeAllConnections()` 再 `server.close(cb)`，Bun 的 `node:http` 在服务器已被前一步关掉时给 `close` 回调传了错误，Node 不会。

还没确认：这是否是失败的全部原因。先让 `closeServers` 容忍这个错误（`close` 回调里忽略 `ERR_SERVER_NOT_RUNNING`），再看哪些测试还失败；如果还有，说明真实的传输层行为有差异，要去读 `packages/mcp/src` 里的 streamable-http 实现。

### 2. chord，2 个失败（Node 全绿）

文件：`packages/chord/test/delta-tracker/retention.test.ts`，用例 `validates retained-settled-proxy retention semantics` 和 `validates stale-unprepared-change retention semantics`。

现象：断言 `released change data is still retained`。测试靠 `global.gc()` + `WeakRef` 判断对象被释放，30 次 `setImmediate` + `gc()` 后 Bun 仍认为对象在。JavaScriptCore 的 GC 和 V8 不同，`global.gc` 在 Bun 里是否可用、是否同步回收需要查。可选做法：Bun 下用 `Bun.gc(true)`，或把测试改成不依赖具体 GC 时机的断言。先判断是测试问题还是 delta tracker 真的持有了引用。

### 3. durable，2 个失败（Node 全绿）

两个都是断言写法依赖 Node 的细节，已读过输出：

- `test/env-node.test.ts:321`，`creates temporary directories and files`：`expect(access(tempDir)).resolves.toBeUndefined()` 在 Bun 下收到 `null`。改成不依赖返回值，比如 `await access(tempDir)` 不抛错即可。
- `test/sqlite-storage.test.ts:325`，`rolls SQL rows and sequence allocation back as one transaction`：期望错误信息包含 `circular structure`，Bun 的 `JSON.stringify` 报 `JSON.stringify cannot serialize cyclic structures.`。改成匹配两种信息，或断言抛出了错误并且事务已回滚（后面两行已经在断言回滚）。

durable 的 `npm test` 是 `vitest --run && node scripts/test-without-document-retention.mjs`，后半段是 Node 启动器，Bun 下单独验证它是否需要处理。

### 4. ai，比 Node 多 15 个失败

- `test/lazy-module-load.test.ts`（5 个）：测试起子进程，子进程用到 `node:module` 的 `registerHooks`，Bun 报 `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`。需要换一种隔离加载的办法，或在 Bun 下用 Bun 的等价机制（`Bun.plugin`）。
- `test/openai-codex-stream.test.ts`（10 个）：测试用 `MockWebSocket` 替换 `globalThis.WebSocket`，但 `packages/ai/src/api/openai-codex-responses.ts` 约 999 行 `getWebSocketConstructor` 在 Bun 下走专门分支，`class extends WebSocket` 并传 `proxy` 选项，绕开了替换（连接数期望 2 实际 0）。修的时候要保住该分支存在的原因（Bun 的 WebSocket 不读代理环境变量，oven-sh/bun#15489）。让测试能注入构造函数，或让分支在子类化时取到被替换的全局。
- `packages/ai` 要能在浏览器里加载，`npm run check` 里有浏览器 smoke，不能因此引入顶层 Node 内置模块导入。

### 5. coding-agent，比 Node 多 63 个失败

按文件，括号里是 Bun 独有失败数：

- `test/experimental-remote-runtime.test.ts`（24）：`Error: Coordinator exited during startup`。测试用 `process.execPath` 起子进程跑源码，经过 `src/experimental/source-resolver.ts`，那里用了 Bun 没有的 `registerHooks`。同一原因还涉及 `experimental-cli-entry`（3）、`session-file-invalid`（1）、`experimental-internal-process`（1）、`experimental-presentation-facets`（1）以及其他起子进程的用例，建议先修这个根因再看剩下的。
- `test/package-command-paths.test.ts`（10）和 `test/config.test.ts`（8）：`detectInstallMethod()`（`src/config.ts` 约 80 行）一看到 `isBunRuntime` 就返回 `bun`，测试在 Bun 下跑时预期 `npm` 或 `unknown`。测试要在 Bun 下也能控制探测输入（比如注入运行时标记），不要改产品行为。
- `test/http-dispatcher.test.ts`（2）：`dispatcher.close is not a function`，以及一个超时用例该拒绝却返回了 `Response`。`src/core/http-dispatcher.ts` 用 npm `undici` 的 `EnvHttpProxyAgent` 和 `undici.install()` 替换全局 fetch。这是唯一确认会影响产品行为的一处（Bun 下代理和空闲超时是否生效）。AGENTS.md 要求更新 `undici` 前先读发布说明；在决定“Bun 下继续用 undici 还是改用原生 fetch”之前先问 Blxze，不要擅自换。
- 其余各 1–2 个：`stdout-cleanliness`（2）、`footer-data-provider`（2）、`extensions-input-event`（2）、`fswatch-error-crash`、`startup-session-name`、`session-id-readonly`、`paths`、`mcp-extension`、`mcp-command`、`clipboard-command`。没有逐个诊断，多半与子进程、`registerHooks` 或 `process.execPath` 有关，修完上面几个根因后再重跑看剩多少。

## Node 下本来就失败的测试（不要当成 Bun 问题）

在测试环境里 Node 也失败，原因是环境，不是代码：

- ai：24 个，主要是 Amazon Bedrock 的 e2e（环境里有 `AWS_*` 凭据所以会跑但连不上）和 `cross-provider-handoff`。
- coding-agent：17 个，`test/tools.test.ts`（7）、`find-path-glob`（4）、`find-nested-gitignore`（2）、`model-selector` 相关（2）、`models-json-hot-reload`、`config.test.ts` 里一个“npm 安装路径不可写”的用例（以 root 运行所以可写）。多半是缺 `fd`/`rg` 或以 root 运行。CI 的 Ubuntu 任务装了 `fd-find`、`ripgrep`，且不是 root。

比较时以“Node 下通过、Bun 下失败”为准。

## 完成标准和收尾

1. 每个包修完后：该包在 Bun 下的测试全绿，Node 下的结果和修改前一致，`npm run check` 通过。
2. 把该包加进 `scripts/test-bun.mjs` 的 `SUITES`，并更新 `AGENTS.md` 里 Bun 那一行（它说明了哪些包已覆盖）。
3. 如果有 Node 用户可见的行为变化，在 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]` 下加条目。
4. 如果引入新的运行时抽象（计划阶段 2），先在 `docs/architecture/layers.json` 写规则和理由，并在 `.agents/notes/` 记一条设计说明。
5. 最后不要自己合并，PR 交给 Blxze 审。

## 建议顺序

durable（2 个，断言问题，最快）→ mcp（先改测试辅助函数）→ chord（先判断是测试还是产品问题）→ ai（WebSocket 和 `registerHooks`）→ coding-agent（先解决 `registerHooks` 这个共同根因，再处理 `detectInstallMethod` 测试，最后 HTTP dispatcher 的方向需要问 Blxze）。
