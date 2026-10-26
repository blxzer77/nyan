# 记忆（Memory）设计

状态：已定稿，未实现（2026-10-26）。第五节待定项按默认值采纳。

设计来源：nyan-legacy N5（旧 roadmap `88ef45bb0:ROADMAP.md` 第 272、296-300 行，Owner Decisions #1、#11）、
`2026-10-26-deferred-context-governance-design-inventory.md` 的"记忆（N5）"一节、Pactile
`compression-decision-chain-v1` S10 与 `03-stage-plan` 阶段 7。偏离 CC 的代码用 `@nyan` 标注。

**定位**：CC 的记忆方案（memdir + MEMORY.md 索引 + 四种类型 + 注入链路）是成熟的基座，本设计只**补充**它缺的
三块（提取、合并、写入安全）和一个机制（候选需确认），不改存储与注入。从 legacy 取的是设计思想，实现优先复用
CC 现成部件（`run_forked_agent`、`dream_task`、secret scanner、`/memory` 选择器）。

## 一、legacy 的设计理念（对齐目标）

1. **两层，结构上不能互相冒充**：
   - **Context Memory**：压缩时提取的 exact facts；摘要永远不是事实来源，检索命中永远不是事实。
   - **Persistent Memory**：跨会话记录，类型固定 `user` / `feedback` / `project` / `reference`。
2. **提取、合并、读取是三个独立操作**；提取失败不回滚已提交的压缩。
3. **写入前安全扫描，宁可拒绝不做局部脱敏**：命中秘密的整段丢弃。
4. **低风险、来源充分的记录按策略自动晋升**；冲突、低置信度、敏感内容留作候选。
   有损压缩、永久 drop、记忆删除是三种单独的显式用户确认，各自留记录（Decision #11）。
5. **记忆只存结构化事实**：prompt、transcript、凭据、绝对路径在写入前拒绝。
6. **跨会话记忆放在会话存储之下，不另起第三个根**（Decision #1）；scope 用 git 根或 cwd。

## 二、CC 现状

| 能力 | 现状 | 位置 |
|---|---|---|
| Persistent Memory 存储 | **已有**：`<config>/projects/<cwd-key>/memory/`，`MEMORY.md` 索引 + 每条一个带 frontmatter 的 `.md`；类型正好是 `user/feedback/project/reference` | `memdir/paths.rs:96`、`memdir/memdir.rs:27-104` |
| 注入 | **已有**：系统提示只放行为指引；`MEMORY.md` 正文（≤200 行 / 25000 字节）作为 `claudeMd` 用户上下文注入首条消息 | `memdir/memdir.rs:416`、`utils/claudemd.rs:320-332`、`context.rs:98-180` |
| 写入 | 只有"主模型自觉调用 Write" | 系统提示指引 |
| 提取 | **无**：`QuerySource::ExtractMemories` 只是枚举值；`stop_hooks.rs:86` 标为 TODO | `query/stop_hooks.rs:140` |
| 合并（auto-dream） | **无**：`dream_task.rs:10-13` "driver missing"；`autoDreamEnabled` 是死设置 | `tasks/dream_task.rs` |
| 相关记忆注入 | **无生产者**：`Attachment::RelevantMemories` 结构与渲染齐全 | `utils/attachments.rs:159,552`、`utils/messages.rs:3297` |
| 秘密扫描 | 规则齐全（18 条），但只在 `anthropic_internal` 构建编译 | `services/team_memory_sync/secret_scanner.rs:223` |
| 分叉 agent | **已有**：`run_forked_agent`，共享 prompt cache | `utils/forked_agent.rs:518` |
| Context Memory / exact facts | **无** | — |

本机实际使用：`~/.cometix/projects/*/memory/` 下共 6 条记忆，全部是主模型在对话中手写的。

## 三、决定

### M1 存储：沿用 CC 的 memdir（Persistent Memory）

- 不新建存储层。CC 的 memdir 已满足 legacy 的全部存储要求：按项目 scope（cwd/git 根）、类型固定、
  位于 `$CLAUDE_CONFIG_DIR/projects/` 之下（与会话 transcript 同根，符合 Decision #1）。
- **"候选"用 memdir 已有的结构表达，不加状态字段**：CC 只注入 `MEMORY.md` 索引（`utils/claudemd.rs:320-331`），
  单条记忆文件不会自动进上下文。所以"已生效" = 文件存在且在索引里；"候选" = 文件存在但不在索引里。确认候选就是把
  它加进索引——用户在 `/memory` 里操作，或手动编辑 `MEMORY.md`，两种方式等价。
- 提取 agent 写的记忆在 frontmatter 里多一行 `source: extract`（`@nyan`），用于 `/memory` 里区分来源；其余字段沿用
  CC 的 `name / description / type`。frontmatter 解析为 `BTreeMap<String, Value>`（`utils/frontmatter_parser.rs:20`），
  多一个键不影响 CC 读取。

### M2 提取：会话末后台提取 agent（填 CC 的 extractMemories 空缺）

- 时机：`handle_stop_hooks`（`query/stop_hooks.rs:140`）中，仅主线程（`QuerySource::Prompt`）、
  非 bare 模式、auto memory 开启时触发；节流为**每 N 轮或会话 token 增长 ≥ T 时一次**
  （默认 N = 8 轮、T = 30k），避免每轮都花钱。
- 执行：`run_forked_agent`，`QuerySource::ExtractMemories`，`skip_transcript = true`，不写进主 transcript。
  - 与主模型相同时：共享主会话 cache-safe 参数，带完整历史作为前缀（全部命中 cache，成本主要是输出 token），
    末尾指令里标出"上次提取的位置"，要求只看其后的新内容。
  - 与主模型不同时：无法共享 cache，只带"上次提取以来的新片段 + MEMORY.md 索引"，控制全价输入的量。
- 工具：只允许 Read / Glob / Grep 读 memdir、Write / Edit **只限 memdir 目录内**（`can_use_tool` 回调强制，
  目录外一律拒绝）；`max_turns` 默认 6。
- 提示词：给出"自上次提取以来的新对话片段 + 当前 MEMORY.md 索引"，要求只提取符合四种类型、
  "从代码或 git 推不出来"的信息（沿用 CC `WHAT_NOT_TO_SAVE_SECTION`），优先更新已有记忆而不是新建重复项。
- 提取模型：`settings.nyan.memory.extractModel`，未设置时用主模型（共享 cache，最便宜）。不回退到
  压缩的摘要模型，避免用户没单独配置时平白丢掉 cache 共享。
- 失败只记日志，不打断主会话、不影响压缩。

### M3 写入安全：秘密扫描 + 结构拒绝（所有写入路径）

所有写入 memdir 的路径（主模型 Write/Edit、提取 agent、合并 agent）都经过同一道检查，任一命中即**拒绝整次写入**
（不做局部脱敏）：

1. **秘密扫描**：把 CC 的 18 条 secret 规则从 `anthropic_internal` 中解开（`@nyan`），对 memdir 写入生效。
2. **legacy 文本启发式**：`authorization:` / `bearer <token>`、`-----BEGIN … PRIVATE KEY-----`、
   `api_key|access_token|password|secret` 赋值。
3. 不做 legacy 的 frontmatter 键白名单与绝对路径拒绝：CC 的记忆是用户也会手写的自由 Markdown，白名单会误拒；
   `reference` 类型本来就记外部位置。legacy 这两条防的是"把 transcript / 凭据塞进记忆"，前者由提取提示词约束，
   后者由上面的秘密扫描兜底。

接入点：Write / Edit 工具对 memdir 路径的权限检查之后、落盘之前（CC 已有 `is_auto_mem_path` 判定，
`memdir/paths.rs:124`）。

### M4 晋升：自动 + 候选（Decision #11）

- 提取 agent 写记忆文件后，**自己决定是否加进索引**：低风险的直接加（生效）；以下情况只写文件、不加索引（候选），
  并在本次提取的结果里列出：
  1. 与已有记忆冲突（应当更新旧条目而它拿不准）；
  2. 类型为 `user`（关于用户本人的判断，敏感度高）；
  3. 它自己没把握。
- 第 2 条由工具约束兜底：提取 agent 修改 `MEMORY.md` 时，若新增的索引行指向 `type: user` 的文件，写入被拒
  （`can_use_tool` 回调检查）。
- 主模型在对话中按用户明确要求写的记忆照 CC 原样直接生效（用户已表态）。

### M5 合并（consolidation，填 CC 的 auto-dream 空缺）

- 沿用 CC 上游 auto-dream 的形态，只补缺失的驱动：`tasks/dream_task.rs` 已有任务状态机、`files_touched`、
  consolidation-lock 的 `prior_mtime`。用 memdir 下一个锁文件的 mtime 记录上次合并时间；距今 ≥ 24 小时且 memdir 中
  比它新的记忆文件 ≥ 5 个时，在会话空闲时触发。`autoDreamEnabled` 从死设置变成真开关（`@nyan`）。
  手动触发：`/memory consolidate`。
- 内容：去重、合并相近条目、更新过时的 `project` 记忆、重建 `MEMORY.md` 索引。
- **删除需要确认**（Decision #11）：合并 agent 不能删除文件（`can_use_tool` 拒绝对 memdir 的删除）。被合并掉或过时的
  条目，它从索引里移除、文件留着，并在结果里列为"建议删除"；不在索引里的文件本来就不会被注入，用户在 `/memory`
  里确认后由 nyan 删除。不需要回收站目录。
- 工具约束同 M2（只限 memdir）。

### M6 相关记忆注入（RelevantMemories）

- MEMORY.md 正文已全量注入（≤200 行），记忆少时这已足够。只有当记忆条数超过索引上限、或单条正文较长时，
  才需要"按当前问题挑选相关记忆的全文"注入。
- 本模块**只定义接缝，不实现选择算法**：选择依赖检索模块（N6）。检索落地后，在每次用户输入时按问题检索
  memdir，命中项以 `Attachment::RelevantMemories` 注入（CC 渲染已就绪）。
- 在检索落地前不注入任何东西（不用关键词匹配凑合）。

### M7 Context Memory（exact facts）

- legacy 的设计：压缩时把"必须原样保留的事实"（精确的路径、命令、错误信息、用户约束）提取成不可变的事实文档，
  摘要只能引用，模型可通过 `memory_read` 回读。
- 本 fork 的处理：**不做独立存储与 `memory_read` 工具**。理由：
  1. 压缩已经保留了尾部原文（compaction C7 `keepRecentTokens`），且 transcript 里的原文永不删除；
  2. legacy 摘要格式里已有 `Constraints & Preferences` 与 `Critical Context` 两节，要求"保留精确路径、
     函数名、错误信息"；
  3. artifact → receipt → manifest CAS 的整套机制服务于多写者、跨进程的 Pactile 场景，单机 CLI 不需要。
- 保留的部分：压缩时，摘要的 `Constraints & Preferences` 一节若出现用户明确表达的长期偏好，交给提取 agent
  （M2）作为 `feedback` 候选——即"Context Memory 的跨会话部分由 Persistent Memory 承接"。
- 这是与 legacy 的明确偏离，见"四、明确不做"。

### M8 `/memory` 命令

在 CC 现有的选择器（`components/memory/memory_file_selector.rs`）上增加：

- 列出 memdir 中**不在索引里的记忆文件**（候选，以及合并后建议删除的旧条目），支持"加入索引"或"删除"；
- 子命令 `/memory consolidate` 手动触发合并；
- 显示上次提取、上次合并的时间与结果。

### M9 开关

挂在 `settings.nyan.memory` 下：

| 设置 | 默认 | 作用 |
|---|---|---|
| `extract` | `true` | 后台提取 |
| `extractEveryTurns` | `8` | 提取节流：轮数 |
| `extractEveryTokens` | `30000` | 提取节流：token 增长 |
| `extractModel` | 未设置 | 提取模型；未设置用主模型（见 M2） |
| `consolidate` | `"auto"` | `"auto"` / `"manual"` / `"off"` |
| `secretScan` | `true` | 写入前扫描 |

CC 原有的 `autoMemoryEnabled = false` 时，提取与合并一并关闭。

## 四、明确不做

| 项 | 理由 |
|---|---|
| Context Memory 独立存储、`memory_read` 工具、artifact→receipt→manifest CAS | 见 M7：压缩保留尾部原文 + transcript 永存 + 摘要格式已覆盖；CAS 链服务多写者场景 |
| `scope-v1:` scopeKey、workspace/worktree 逻辑 id | CC 的 cwd-key 已是项目 scope |
| Kernel command / approval chain / revoke receipt、状态字段、回收站 | 无 Kernel；"是否在 MEMORY.md 索引里"本身就是生效状态，确认 = 加入索引，删除需用户在 `/memory` 执行 |
| 绝对路径拒绝 | 见 M3 第 4 点 |
| 关键词匹配凑合的相关记忆选择 | 等检索模块，见 M6 |
| team memory | CC 默认关闭（`feature_flags.rs:512`），与本 fork 目标无关，保持原样 |

## 五、已确认的取舍（2026-10-26）

1. M7：不做 Context Memory 独立层，由"保留尾部原文 + transcript + 摘要格式 + 提取 agent"承接。
2. M2 节流默认 8 轮 / 30k token。
3. M4 `user` 类型默认为候选，需确认后生效。
4. M5 自动合并阈值 24 小时 + 5 条新增。

## 六、cache 约束（与压缩模块一致）

- 提取 agent 与合并 agent 都用 `run_forked_agent` 共享主会话 cache（同模型时历史部分全部命中，只付输出）。
- 配置了 `extractModel` 且与主模型不同时，无法共享 cache，按 M2 只带新片段，控制全价输入量。
- 提取与合并的请求不得改变主会话后续请求的前缀（不写主 transcript、不改主会话消息），保证主会话 cache 不受影响。

## 七、实现切片

| 切片 | 内容 | 主要写集 | 依赖 |
|---|---|---|---|
| A | 写入安全：解开 secret 规则、启发式；接入 Write/Edit 的 memdir 路径 | `services/team_memory_sync/secret_scanner.rs`、新 `memdir/write_guard.rs`、`tools/file_write_tool`、`tools/file_edit_tool` | — |
| B | 候选机制：列出不在索引里的记忆文件；提取 agent 修改索引时的 `type: user` 检查 | `memdir/memdir.rs` | — |
| C | 提取 agent：节流、forked agent、工具约束、提示词、`settings.nyan.memory` | 新 `services/extract_memories/`、`query/stop_hooks.rs`、`utils/settings/types.rs` | A、B |
| D | 合并 agent：dream 驱动、锁文件节流、禁止删除、建议删除清单 | 新 `services/auto_dream/`、`tasks/dream_task.rs` | A、B |
| E | `/memory` UI：不在索引里的文件（加入 / 删除）、手动合并、状态 | `components/memory/memory_file_selector.rs`、`commands/memory.rs` | B、D |

A、B 可并行；C、D 在 A、B 之后可并行；E 最后。M6 不在本模块实现。

## 八、验收

1. 含 API key / 私钥 / bearer token 的记忆写入被整次拒绝，主模型与提取 agent 都一样。
2. 提取 agent 无法写 memdir 以外的任何路径。
3. 提取只在节流条件满足时触发；失败不影响主会话与压缩。
4. 提取不写主 transcript；其 usage 计入会话费用。
5. 候选记忆不出现在 MEMORY.md 索引、不注入；在 `/memory` 里加入索引后才生效。
6. 合并 agent 无法删除任何文件；建议删除的文件经用户确认后才删除。
7. `autoMemoryEnabled = false` 时提取与合并都不运行。
8. 现有记忆（无 `source` 字段）照常加载、照常生效。
