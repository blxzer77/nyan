# Agent Note: Durable migration inventory, independent review

Status: proposed

## Problem

Phase N0 of the durable migration must be gated by a review before N1 starts. The inventory note
([`2026-10-15-durable-migration-inventory.md`](2026-10-15-durable-migration-inventory.md)) claims
that every `ExtensionAPI` member has one destination and one decision, and that the migration cost
is dominated by the extension surface rather than by the context work.

This record is the review that tests those claims. It exists so the gate has evidence and so the
findings are not lost when the note is corrected.

## Review method

An independent Nyan process reviewed the artifacts. It did not write them and was instructed to
verify claims against source rather than trusting the note. The prompt was passed on stdin and is not
stored; it asked for a verdict, blocking and non-blocking findings, claim-by-claim verification, gate
script results, disagreements, and what was not checked. It spot-checked at least 12 event mappings,
verified the cited counts, tried to defeat the gate script, and stated whether it agreed with the
cost judgement. It had read-only tools (`read`, `bash`, `grep`, `find`, `ls`) and was told to restore
anything it touched.

```bash
node scripts/nyan-source.mjs \
  --provider openai-codex --model gpt-6-astra --print --no-session \
  -t read,bash,grep,find,ls --no-mcp --no-skills --no-prompt-templates --thinking high
```

## Verdict

**Not fit to gate N1.** The counts and the basic enums are broadly correct, but several hook
mappings cannot preserve Nyan behaviour, key migration surface is missing from the inventory
entirely, and two cited facts are wrong. The gate currently proves "every name is classified", not
"every classification is sound".

The author of the note independently re-verified the blocking findings before accepting them. Each
one below was confirmed from source:

- `packages/durable/docs/spec.md:2705-2717` gives the real hook signatures: `beforeRequest` takes
  `{ messages }` and runs on **every request attempt including recovery**; `afterResponse` takes a
  terminal `AssistantMessage` and returns `void` (all-observers); `onYield` returns only
  `{ continue: UserInput }`.
- `packages/durable/docs/spec.md:2745-2755` shows `beforeCompact` returns `{ decline: true }` or
  `{ summary: string }`, and `docs/spec.md:2687` states it is first-decision-wins.
- `packages/coding-agent/src/core/extensions/runner.ts:1092-1100` shows the Nyan session-before
  dispatch assigns the last non-empty result, so `session_before_compact` is **last-write-wins**,
  not first-decision-wins as the note claims, and its `CompactionResult` carries
  `firstKeptEntryId`, `details`, and `usage`.
- `packages/coding-agent/src/core/extensions/runner.ts:1294-1300` documents the deliberate two-phase
  request transform: `context` handlers see the conversation only and Nyan restores prompt and tool
  state after each; `context_with_system` handlers then see the full transcript.

## Full review

The reviewer's report is reproduced below verbatim.

---

## Verdict

不适合作为 N1 gate。计数和基础枚举大体正确，但存在多个阻塞级语义错误：若干 hook 映射不能保留 Nyan 行为，`ExtensionContext`/UI/工具能力等关键迁移面完全未盘点，且原型行数和验证命令均不准确。当前 gate 只能证明“名称已分类”，不能证明“语义可迁移”。

## Blocking findings

1. **`session_before_compact -> hook:beforeCompact` 语义错误。** Nyan 的 runner 对多个非取消结果采用后写覆盖，只有 `cancel` 提前返回；并非 note 所称的“first decision wins”（`packages/coding-agent/src/core/extensions/runner.ts:139-180`）。Durable `beforeCompact` 在 `spec.md:2687, 2750-2753` 是首个决定获胜，而且只返回 `decline` 或 `summary`，不能表达 Nyan 的 `firstKeptEntryId`、`details`、`usage` 等 `CompactionResult`。应改为 `adapt`，并记录明确的适配/降级方案。

2. **`context` 与 `context_with_system` 合并到同一 `beforeRequest` 会丢失阶段语义。** Nyan 明确先运行只看非 system 消息的 `context`，恢复 system/tool 状态，再运行拥有完整 prompt/tool 声明的 `context_with_system`（`runner.ts:1295-1352`）。Durable `beforeRequest` 是一个对完整 `messages` 的单一 replacement chain（`spec.md:2705-2711`）。note 第 92-93 行标为 `keep`，不成立；至少需要顺序、可见范围和 system/tool 保护的适配设计。

3. **`before_provider_request -> beforeRequest` 映射了错误对象。** Nyan 事件替换的是 provider request body（`types.ts:909-914`，runner 实现 `runner.ts:1358` 附近），而 Durable hook 接收的是模型消息，不是已组装的 provider payload（`spec.md:2707-2711`）。这不是同一 composition point，应是 provider-adapter/product API 或新增 durable hook。

4. **`after_provider_response -> afterResponse` 不是等价映射。** Nyan 在 response headers/status 已收到、stream 尚未消费时触发，并暴露 `status` 和 `headers`（`types.ts:916-920, 924-930`）。Durable `afterResponse` 只接收终结的 `AssistantMessage`，在完整 response 之后、分类之前触发（`spec.md:2712-2713, 3981-3982`）。note 第 100 行标为 `keep`，错误。

5. **`before_agent_start -> beforeRequest` 只覆盖了部分能力。** Durable 的 `beforeRequest` 确实能看到并替换 system message；但 Nyan 事件还可注入启动 custom message、修改 prompt construction，并且只在 run 开始触发（`types.ts:932-956, 1462-1468`）。Durable hook 在每个 request attempt，包括 recovery 时运行（`spec.md:2707, 3977-3980`）。应标为 `adapt`，不能标 `keep`。

6. **`agent_before_settle` 和 `turn_end -> onYield` 结论不正确。** Nyan boundary 可追加 custom/custom-message/context-edit/compaction entries，并返回 `continue`（`types.ts:1008-1037, 1065-1071`；`agent-session.ts:1001-1029`）。Durable `onYield` 只在最终 answer 上运行，只能返回 `{ continue: UserInput }`（`spec.md:2714-2715, 3986-3993`）。它不是“同样形状”；没有对应的 durable 追加任意 entry 能力。note 第 105、110、248-251 行的“已解决”判断应撤回。

7. **`message_end -> afterResponse` 仍不是可接受的 destination。** note 第 113 行虽承认 replacement/all-observer 冲突，但没有解决方案或 open question。Nyan `message_end` 可替换任意 finalized message，包括 user、assistant、toolResult、custom（`types.ts:1088-1091`；`runner.ts:1149-1178`）；Durable `afterResponse` 只观察 provider 的 assistant message。`adapt` 标记不能替代目标能力和恢复语义设计。

8. **盘点遗漏了实际扩展面。** `types.ts` 中未进入 JSON 的部分包括：
   - `ExtensionUIContext`：dialog、status、widget、footer/header、editor、autocomplete、theme 等（`types.ts:147-299`）。
   - `ExtensionContext`、`ExtensionToolContext`、`ExtensionCommandContext`、`ReplacedSessionContext` 的状态、abort、session/tree/reload、nested-tool 能力（`types.ts:326-448`）。
   - `ToolDefinition` 的 `reachesTools`、`executionMode`、`exposure`、`namespace`、`prepareLoadout`、`renderShell`、renderers、structured output 等（`types.ts:579-667`）。Durable 对应的是 `callers`、`replay`、`executionMode`、`structuredOutputSchema`，不是同一接口（`spec.md:2881-2917`）。
   - 资源加载、prompt templates、themes、images、`/login`；原型 README 明确列为 “Not here”（`experimental/durable/README.md:66`）。
   - MCP connection/auth/resource-tool 生命周期；现有 `session_start` 被 MCP 扩展实际用于加载配置和连接（`extensions/mcp/index.ts:1114-1214`）。
   - AgentSession 额外的 queue、retry、bash、compaction、entry、tree、export 等事件和方法（`agent-session.ts:196-240, 1373-1417, 2432-2953, 3690-4352`）。
   - session tree/fork 的完整产品行为；原型 README 明确说 fork/tree 不在其中（`README.md:66`）。
   
   因此“完整 inventory”不成立。

9. **`session_start -> document-state` 错误地抹掉了生命周期处理。** `types.ts:754-761` 定义的是 startup/reload/new/resume/fork 生命周期事件，不是单纯 UI 状态；MCP 和 Herdr 都实际注册并执行它（`extensions/mcp/index.ts:1114`, `extensions/herdr/index.ts:218`）。`Conversation.viewState()` 不能替代任意 extension handler。

10. **原型行数事实错误。** note 第 325 行称 1350 行；实际命令输出为：
    ```
    9 files
    1416 total
    ```
    `wc -l packages/coding-agent/src/experimental/durable/*`。

11. **ROADMAP 的 N0 gate 与实际四类 destination 不一致。** `ROADMAP.md:249` 称只有三类 destination，`ROADMAP.md:257` 也只要求 hook/document-state/controlled-channel；但 JSON 和 note 使用第四类 `product-api`，并有 12 个条目。应统一 roadmap、note 和 JSON。

## Non-blocking findings

1. **18/23 的分类定义不清。** 总事件数 41 正确，但 `before_provider_headers` 通过原地修改 headers（`types.ts:916-920`），按 note 第 22 行“handler can modify or block”的 admission 定义，它不应算 observe-only。应明确按“有返回值”还是“可改变请求”分类。

2. **Verification 中引用的命令不正确。** note 第 322 行称 `rg -n 'on\(event:'` 找到 41 个事件；实际输出为 `32`。只有 `rg -n '^\s*on\('` 才得到 41。

3. **gate 不验证 evidence。** 将 `tool_call` 的 evidence 改成 `types.ts:1` 后，脚本仍返回成功。它只验证 `entry.line`，不验证 evidence 文件存在或行内容。

4. **gate 可漏掉同一行或带注释的新增事件。** 临时加入：
   ```ts
   ...input declaration; on /* hidden */ (event: "scanner_hidden", ...)
   ```
   `npm run check:extension-surface` 仍成功，且恢复后文件未改变。原因是 `deriveEvents()` 只匹配行首 `on(`（`scripts/check-extension-surface.mjs:69-99`）。

5. **gate 不验证语义。** `checkDestination()` 只对 JSON 自己的 `enums.destination` 和 `durableHooks` 校验（`scripts/check-extension-surface.mjs:144-152`），不会读取 durable spec，也不会检查 Nyan handler 能力、composition rule、时间点或 payload 类型。

6. **prototype 文件扫描不完整。** 只扫描目录第一层且只接受 `.ts`/`.md`（`scripts/check-extension-surface.mjs:108-114`）；嵌套文件、`.tsx`、资源文件可无记录通过。

7. **`--write` 正常路径通过，但缺少 marker 健壮性校验。** 我运行了 `npm run check:extension-surface -- --write`，输出为 `Note tables already match...`，文件 hash 未变化。代码使用 `indexOf`，不验证 end marker 位于 begin marker 之后，也不拒绝重复 marker，畸形 note 可能被错误替换。

8. **session policy 的部分“证据”其实是设计决策。** `sessions.ts` 证明的是 `experimental/durable-sessions`，不是产品路径 `sessions-durable`；后者是 note 第 198 行的迁移决策。10 秒 stale 是 `proper-lockfile` 默认值，不是 `sessions.ts` 明确设置的值。表格应区分“prototype behavior”和“product policy”。

## Claim-by-claim verification

| Claim | Verified? | Evidence |
|---|---|---|
| 41 events | yes | 独立扫描 `types.ts:1597-1664` 得到 41 个 `on` declarations；gate 也输出 41。 |
| 18 admission / 23 observe | partial | JSON 标签计数为 18/23，但 `before_provider_headers` 会原地修改 headers（`types.ts:916-920`），分类定义不一致。 |
| 31 API members | yes | 32 个非 event method declarations，31 个 unique names；`registerProvider` 两个 overload（`types.ts:1858-1859`）。 |
| 73 declarations | yes | 41 event declarations + 32 non-event declarations。 |
| 9 prototype files | yes | `find` 和 `readdirSync` 均得到 9 个 `.ts/.md` 文件。 |
| 1350 prototype lines | no | `wc -l .../experimental/durable/*` 输出 1416。 |
| `project_trust -> product-api` | partial | handler 可决定 trust（`types.ts:704-722`）；durable 无对应 hook，但具体 product trust policy 尚未盘点。 |
| `resources_discover -> product-api` | partial | handler 返回 skill/prompt/theme paths（`types.ts:724-736`）；durable sections 不是同一资源发现协议。 |
| `session_start -> document-state` | no | 生命周期事件（`types.ts:754-761`），MCP 实际用它启动连接（`extensions/mcp/index.ts:1114`）。 |
| `session_before_compact -> beforeCompact` | no | Durable 是 first-decision-wins（`spec.md:2687`）；Nyan runner 的普通 compaction 结果后写覆盖（`runner.ts:139-180`），且结果结构不同。 |
| `context -> beforeRequest` | partial | Durable hook 能替换完整 messages（`spec.md:2707-2711`），但 Nyan context 只暴露非-system并恢复 prompt/tool（`runner.ts:1295-1329`）。 |
| `context_with_system -> beforeRequest` | partial | 两者可共用底层 request hook，但会丢失 Nyan 的两阶段顺序和 system-message 约束（`runner.ts:1330-1352`）。 |
| `before_provider_request -> beforeRequest` | no | Nyan 操作 provider payload；Durable 操作 model messages。 |
| `after_provider_response -> afterResponse` | no | Nyan 暴露 status/headers、stream 前触发；Durable 只收 terminal AssistantMessage。 |
| `before_agent_start -> beforeRequest` | partial | Durable request 包含 system message，但不能直接表达 Nyan 的启动消息和“每 run 一次”语义。 |
| `agent_before_settle -> onYield` | no | Nyan 可追加多类 entries；Durable `onYield` 只有 `{continue}`。 |
| `turn_end -> onYield` | no | Nyan 是每 turn boundary；Durable `onYield` 只在 final answer settlement 前。 |
| `message_end -> afterResponse` | no | Nyan 可替换所有 message role；Durable afterResponse 是 assistant-only observer。 |
| `tool_call -> beforeTool` | yes, with adaptation | 参数替换/阻断形状基本匹配；Durable 还会在 intent 后固定参数且 recovery 不重跑 hook（`spec.md:3212-3215`）。 |
| `tool_result -> afterTool` | partial | 都是结果 replacement，但 Nyan 的 `details/structuredContent/usage/isError` 组合需要明确映射到 Durable `ToolExecutionResult`。 |
| session root | partial | 原型为 `getAgentDir()/experimental/durable-sessions`（`sessions.ts:19-24`）；产品 root 去掉 `experimental` 是设计决策，不是原型证据。 |
| per-directory key | yes | `realpath(resolve(cwdInput))` 后 `sha256(...).slice(0,24)`（`sessions.ts:17-24`）。 |
| session directory format | yes | `13-digit Date.now + randomUUID`（`sessions.ts:31-34`）。 |
| database | yes | `runtime.ts` 将 `location.database` 传给 `openNodeSqliteStorage`。 |
| lock | yes | `proper-lockfile.lock(directory, { realpath:false, retries:{retries:12,minTimeout:1000,maxTimeout:1000} })`（`sessions.ts:39-44`）。 |
| stale lock 10s | partial | 是 `proper-lockfile` 默认值；`sessions.ts` 未显式设置 `stale`。 |
| `--continue` | yes | 过滤 `^\d{13}-[0-9a-f-]{36}$` 后 `.sort().at(-1)`（`sessions.ts:28-36`）。 |

## Gate script results

- `npm run check:extension-surface`：通过，输出 41/18/23、31 API、9 文件及 destination histogram。
- `npm run check:extension-surface -- --write`：通过，报告 tables 已匹配；note hash 未变化。
- 新增同一行、带注释的未分类 `on(...)`：**未捕获**，脚本仍通过；随后确认已恢复。
- 将 `tool_call` 的 evidence 改为 `types.ts:1`：**未捕获**，脚本仍通过；随后确认已恢复。
- 脚本代码显示 JSON duplicate entry 会被捕获（`scripts/check-extension-surface.mjs:156-180`）；`entry.line` 与 source declaration 的不匹配也会被捕获。
- 未捕获：evidence 的真实性、hook 语义、payload/time ordering、JSON 自己扩展 `durableHooks`/enum 后的伪造 hook、嵌套 prototype 文件，以及畸形/重复 generated markers。

## Disagreements

- 我不同意把 `agent_before_settle`/`turn_end` 视为已解决的 `onYield` 映射；Durable 缺少 Nyan 所需的 entry writes 和 turn-boundary hook。
- 我不同意把 `context`/`context_with_system` 标为 `keep`；它们是有意分离的两个阶段，不能仅按“都能替换 messages”合并。
- 我不同意把 `before_provider_request` 和 `after_provider_response` 标为 `keep`；两者位于 provider adapter 的不同生命周期点。
- 我不同意 note 的中心判断“成本主要由 extension surface 而非 context work 主导”。扩展迁移确实是显著成本，但当前 inventory 还遗漏了 UI/context/tool/resource/MCP/session-tree 面，并且 Durable compaction 本身仍需要 artifact、basis validation、masking、receipt 和 recovery 工作。现有证据不足以支持该成本排序。

## What I did not check

- 未运行完整 `npm run check`、构建、测试或真实 provider 流程。
- 未验证原型 README 所称的 crash/restart recovery。
- 未逐一执行每个 extension handler 的运行时行为测试。
- 未验证 SQLite WAL 和 stale-lock 在高负载下是否满足产品要求；note 自身也将其列为 N1 open question。
