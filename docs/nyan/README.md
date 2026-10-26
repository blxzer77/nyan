# nyan 二次开发：压缩、记忆、检索、外部搜索

本目录是 nyan（CometixCode 的 fork）在 Claude Code 移植之上做的二次开发设计与实施计划。设计思想来自
nyan-legacy（pactile context-governance、旧 roadmap N3–N8），实现以 CC 现有代码为基座。

**原则：对齐 legacy 的思想，不照搬它的形态。** legacy 的具体形态（RetrievalPack 词汇、13 项检查表、EvidenceRecord /
citationPointer、状态字段、回收站、远端协调器、按美元算的经济账……）是为 Pactile 的 Kernel、多客户端与评测平面设计的。
在本项目里，同一个思想优先用 CC 已有的结构表达：工具结果用 CC 的简洁文本风格；"候选记忆"就是不在 MEMORY.md 索引里的
文件；网页证据就是按 hash 存的快照文件；cache 保活复用 CC 的分叉共享机制、从 API usage 读 TTL。每份文档的
"明确不做"一节记录了哪些形态没有搬过来、为什么。

| 文档 | 内容 | 状态 |
|---|---|---|
| [compaction.md](compaction.md) | 压缩：先清后摘、掩码、cache 不因时间失效、cache 保活 | 定稿 |
| [memory.md](memory.md) | 记忆：后台提取、合并、写入安全、候选（= 不在索引里的记忆文件） | 定稿 |
| [retrieval.md](retrieval.md) | 检索：`CodeSearch` 融合工具、本机索引、Inspect、semantic | 定稿（部署项待定） |
| [external-search.md](external-search.md) | 外部搜索：聚合 WebSearch、SSRF 安全 WebFetch、原文快照与逐字摘录 | 定稿（三个待定项） |

## 一、通用约定

1. **偏离标记**：所有有意偏离 CC 的代码位置加 `// @nyan: <原因>` 注释；上游自己的偏离是 `@cometix offset`，不混用。
2. **配置**：全部挂在 `SettingsJson` 新增的一个正式字段 `nyan` 下（settings 是严格 schema，未知顶层键会报错，
   `utils/settings/validation.rs:454`）：`nyan.compaction` / `nyan.cache` / `nyan.memory` / `nyan.retrieval` / `nyan.web`。
   凭据只按文件路径或环境变量名引用，不写进 settings 正文。
3. **回退开关**：每个模块都能关掉回到 CC 行为（`nyan.compaction.mask=false`、`summaryStyle="cc"`、
   `nyan.memory.extract=false`、`nyan.retrieval.enabled=false`……），用于对照与回退。
4. **cache 是第一约束**：不允许任何因时间流逝而丢 cache 的机制；会改变请求前缀的操作必须换来足够的 token 节省，
   且之后字节稳定。子代理 / 分叉（摘要、提取、合并）优先共享主会话 cache。
5. **失败不伪装**：所有降级、跳过、截断都以具名状态出现在结果里，不变成空结果或静默成功。
6. **存储位置**：全部在 `$CLAUDE_CONFIG_DIR`（本机为 `~/.cometix`）下，永不写进工作树。
   - 记忆：按 canonical git root（沿用 CC memdir）；
   - 检索索引：按 worktree 根（不同 worktree 内容不同）；
   - 网页快照：全局一份、内容寻址。

## 二、开发与验证流程（每个切片）

1. 读相关代码与调用链，确认文档里引用的 `file:line` 仍然成立（上游可能已变）。
2. 实现；偏离处加 `@nyan`。
3. 受影响的已有测试改为断言新行为；新行为各有测试。
4. 跑测试——**必须用 justfile 的隔离方式**（`CLAUDE_CONFIG_DIR` 指向 `target/test-home`，清掉宿主的模型 / 网关
   环境变量），否则测试会读写真实的 `~/.cometix`：
   - 有 `just` 与 `cargo-nextest` 时：`just t <模块名>`，收尾跑 `just test`；
   - 没有时：`cargo test --lib --no-run` 后，按 justfile `t` recipe 的环境变量逐个进程跑受影响模块的测试。
   - 已知基线失败（与本工作无关）：`components::prompt_input` 下 4 个测试（`arrows_matches_official_cursor_before_history`、
     `color_only_banner_matches_official_empty_text_border`、`renders_live_swarm_banner_projection`、
     `vim_delete_operator_removes_logical_line`）。
5. 改动文件过 rustfmt（只看自己的 hunk，上游本身有未格式化代码）。
6. 每个切片一个 commit，message 说明"为什么"。

## 三、实施顺序

依赖关系与可并行性（同一行内的切片写集不重叠，可并行）：

| 批次 | 切片 | 说明 |
|---|---|---|
| 0 | 公共：`SettingsJson.nyan` 字段与各模块配置结构体；`@nyan` 约定 | 所有模块的前置 |
| 1 | 压缩 A（掩码 + 移除 time-based + `METADATA_MARKERS`）、压缩 C（Read 去重）、压缩 D（摘要指令与校验）、记忆 A（写入安全）、记忆 B（候选机制）、外部搜索 A（安全抓取器）、外部搜索 D（provider 适配器）、检索 A（库接口、结果模型、Inspect、渲染）、检索 C（本机索引） | 写集互不重叠 |
| 2 | 压缩 B（估算 + 接线）、压缩 F（cache 保活）、外部搜索 B（快照 + 原文返回）、外部搜索 E（聚合 WebSearch）、外部搜索 G（配置与 `is_enabled`）、检索 B（exact + `CodeSearch` 工具）、检索 D（symbol）、检索 E（text） | 依赖批次 1 |
| 3 | 压缩 E（保留尾部 + 回执）、记忆 C（提取 agent）、记忆 D（合并 agent）、外部搜索 C（逐字摘录）、检索 F（semantic，需部署就绪） | |
| 4 | 记忆 E（`/memory` UI）、检索 G（rerank 开关）、检索 I（接入压缩名单 / 记忆 M6） | |
| 后续 | 检索 H（评测） | 后续单独安排 |

建议明天从**批次 0 + 压缩 A/C/D** 开始：压缩改动最小、收益最大、能最快验证"cache 不断"的核心约束。

## 四、跨模块注意事项（审阅四份设计时发现的问题，已写入各文档）

1. **大 transcript resume 丢掩码**（压缩）：transcript > 5 MB 时 resume 只保留 `METADATA_MARKERS` 中的
   boundary 前条目，其中没有 `content-replacement`；配合"保留尾部原文"会让已掩码结果在 resume 后复活。
   修法：加进列表（压缩切片 A）。
2. **摘要请求形态**（压缩 C6）：沿用 CC 的共享 cache 分叉，只换指令内容；legacy 的序列化纯文本会丢整段 cache。
3. **单独配置模型的代价**（压缩 C10、记忆 M2、外部搜索 4.4）：换模型就不能共享主会话 cache；未配置时一律用主模型。
4. **路径作用域**：记忆按 git root、索引按 worktree、快照全局（见第一节第 6 条）。
5. **压缩可清名单**：新增的 `CodeSearch` 要加进 `is_compactable_tool_name`（`services/compact/micro_compact.rs:507`）；
   WebFetch / WebSearch 已在名单里。WebFetch 改为返回原文后单条结果更大，正是掩码的主要清理对象。
6. **代理与 SSRF**（外部搜索 4.2）：本机所有出站经本地代理 `127.0.0.1:7897`，代理模式下客户端看不到真实连接 IP；
   设计为"本地先解析校验 + 拒绝私网 IP 字面量 + 经代理请求"，残余风险已写明。
7. **WebSearch 的 provider 判定**：CC 的 `get_api_provider()` 不看 base URL，网关被当成 first-party；新实现不再依赖
   Anthropic 服务端工具，`is_enabled` 改为"至少配置了一个 provider"。

## 五、待定项（实现时遇到再定，不阻塞开工）

| 模块 | 待定 | 影响的切片 |
|---|---|---|
| 检索 | corp-pc embedding / rerank 的访问方式（绑定 tailnet + token，或 SSH 转发） | 检索 F、G |
| — | Explore 子代理的工具与默认模型（用户后续统一调整，不在四个模块内） | — |
| 外部搜索 | `fetchVia` 默认 `proxy` 与残余 SSRF 风险 | 外部搜索 A |
| 外部搜索 | WebFetch 默认返回原文 20000 字符的上下文占用 | 外部搜索 B |
| 外部搜索 | 是否补 DeepSeek / Brave 的 key | 外部搜索 D |
| 检索 | 评测（后续单独安排） | 检索 H |
| 压缩 | gpt 经网关 cache 基本失效（C13，与压缩无关，需查 CLIProxyAPI） | 独立问题 |
