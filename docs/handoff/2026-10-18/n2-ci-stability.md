# N2: CI 稳定性 PR #36(更正版,2026-10-18)

## 结论

- PR #36 已 squash 合并。**Merge SHA: `28ff7cfca96812ab90c58aa52c99cfdb62a3775a`**(合并时 head `73204a4b4`,Merge gate 绿,run 39075529861,Deep verification 也绿)。
- 分支 `ci-stability` 保留(未删除,未 force-push)。`D:\nyan-n2-ci` worktree 已移除。

## 更正:Deep verification 的失败(主控第 0 条)

上一版报告写"Deep verification 三次失败,日志里没有测试失败行,无法确认是 codemode"。**这是错的。** 原因:我用 `gh run view --job <id> --log` 读日志,它在 Bun 步骤的 `RUN` 行之后就截断了,我没有看到 FAIL 行。完整日志要用:

    gh api repos/blxzer77/nyan/actions/jobs/<job-id>/logs

用完整日志核对,三次 Deep 尝试(run 39037616190,head `7d33a133b`,合并前)各自失败在不同的测试上:

| 尝试 | job | 失败步骤 | 失败测试 | 断言 / 错误 |
| --- | --- | --- | --- | --- |
| 1 | 117414754292 | `Run critical recovery and package tests`(Bun 步骤因此被跳过) | durable `tools-images` "prepares in a worker thread" | `loop gap with the worker (606 ms) against inline (1244 ms)`:比例 0.49,超过 1/3 |
| 2 | 117416710977 | `Run Bun critical parity tests` | coding-agent `agent-session-codemode` "attaches only the images the script passes to image()…" | `Script sandbox failed: Codemode worker limit reached (2 workers are still running or shutting down)` |
| 3 | 117421022493 | `Run Bun critical parity tests` | coding-agent `agent-session-codemode` "adds the usage of nested results to the codemode result" | `expected undefined to match object` |

我在上一版里对尝试 1 和 2 的描述("只到 ai、无测试名")同样是截断造成的,也不对。

### 对主控的说明:`-- ai` 过滤

Bun 步骤的脚本是**一个 `run: |` 块,五行**,按顺序执行 `npm run test:bun -- ai`、`-- agent`、`-- durable`、`-- coding-agent`、`-- protocol`(见 `7d33a133b` 的 `.github/workflows/ci.yml` 第 365 行附近)。每一行的过滤都生效:`==> ai` 只跑 ai。agent、durable、coding-agent 之所以也跑,是因为脚本列了它们,不是过滤失效。失败发生在第 4 行 coding-agent。`scripts/test-bun.mjs` 不需要改。

### 这三次失败说明什么

- 同一个文件 `agent-session-codemode` 在两次尝试里失败在不同用例上;错误信息里反复出现 `Codemode worker limit reached (2 workers are still running or shutting down)`。**假设(未验证)**:codemode 的 worker 上限把仍在退出中的 worker 也计入,前一个用例的 worker 还没退出时,下一个用例的脚本就被拒绝。这可能是产品行为,也可能是测试隔离问题。要先查 `packages/codemode` 的 worker 上限与退出等待。
- `tools-images` 的相对比例判据(我在 #36 里改的)在 Deep 的负载下仍然不稳:比例 0.49。之前写的"已修"不成立。
- 合并 head `73204a4b4` 上的 Deep verification 通过(run 39075529861),codemode 的失败没有在那次运行里复现。

## 本轮做了什么

1. `origin/main`(#39 hosted 分片流水线 `ee599af76`,以及 #38、#35、#31)用 merge 并入 `ci-stability`(`73204a4b4`,不 rebase、不 force-push)。冲突只在 `ci.yml`:流水线结构取 main;只把仍装 apt 包的三处(`ripgrep fd-find`,三个 shard job)改为 `bash .github/scripts/apt-install.sh`;`native.yml` 的 `libxcb1-dev` 也改为脚本。
2. `nightly.yml`、`release.yml` 仍直接调 `sudo apt-get`,未改(见 backlog C 与 B)。
3. PR 描述更新为 v4,包括 OCR 处理表。
4. 本地 `npm run check` 在合并提交上退出码 0。
5. 按主控第 2 条(Merge gate 绿即可合并)squash 合并。

## 验证

- `npm run check`:exit 0(`73204a4b4`)。
- `scripts/apt-install.test.mjs`:5/5(CI 的 `test:scripts` 中通过)。
- `test/tools.test.ts`(executeBash)3 通过;`bash-executor-save-failure.test.ts` 1 通过(本地);`tools-images` 的变异检查已做,但 Deep 上的比例判据仍会失败(见上)。
- CI 合并 head:41 项全部 pass,含 Merge gate。

## 未做(进 backlog)

- `tools-images` 的比例判据在 Deep 上不稳。要先查 worker 为什么仍阻塞主线程约一半时间,再决定修法(可能是产品问题:图像准备中的同步段)。
- codemode 的 worker 上限假设(见上)。
- OCR 在 `73204a4b4` 上的 10 条发现未修,已写入 `backlog-ocr-tests.md` A 节(含 PR #36 小节)。`bash-executor.ts` 的 `closeTempFile` 无超时(L85–86)是产品问题,优先级最高。
- `nightly.yml`、`release.yml` 未改用 `apt-install.sh`(backlog B、C)。
- `provider-session-cache-e2e.test.ts` 读取 `auth.json` 会发真实请求(backlog B)。

Merge SHA: `28ff7cfca96812ab90c58aa52c99cfdb62a3775a`
