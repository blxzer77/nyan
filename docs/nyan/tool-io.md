# 工具输入输出（Tool I/O）设计：Read / Grep / Glob / Bash 的读取与输出契约

状态：已定稿，未实现（2026-10-27）。

设计来源：fastctx v0.2.6（`github.com/yc-duan/fastctx` tag `v0.2.6`，Rust，Apache-2.0）——一个经 MCP 给 Codex 提供结构化仓库
工具的常驻运行时。**只借鉴设计、自己实现，不拷贝代码**（nyan 是 AGPL-3.0；Apache-2.0 代码可单向并入，但需保留 NOTICE
与改动声明，且每项都要按 nyan 结构改造，自写更干净）。偏离 CC 的代码用 `@nyan` 标注。

**定位**：检索（`retrieval.md`）与外部搜索（`external-search.md`）是新增能力；本文改进的是 CC 已有、每个会话都在用的四个
基础工具。目标与 fastctx 相同：**模型少花注意力在工具机制上**——不用猜结果是否完整、不用试探续读参数、不会读到乱码、
不会因为顺序抖动误以为内容变了。

## 一、结论：检索与搜索做内置工具，不做 MCP / Skill

| 形态 | 结论 | 依据 |
|---|---|---|
| **内置工具** | **采用**（`CodeSearch`、`WebSearch`、`WebFetch`） | 立即可用；可进压缩可清名单；共享进程内状态（Read 权限、`ContentReplacementState`、Decision Provider、服务状态机、会话预算） |
| MCP | 不采用为主形态 | nyan 把所有 MCP 工具默认延迟加载（`tool_search_tool/prompt.rs:38-40`，`is_mcp` 一律 deferred），模型每次要先 ToolSearch 取 schema；MCP 工具不在可清名单（`micro_compact.rs:507`），结果无法掩码；跨进程拿不到上述内部状态 |
| Skill | 不承载工具 | Skill 是提示词（`SKILL.md`），不是可执行工具；可选地承载"怎么用好 CodeSearch / WebSearch"的使用指引 |

- **可选出口（不在首批）**：核心逻辑在库里（`services/retrieval`、`services/web`），以后若要给 Codex 等其他客户端用，
  外包一层 MCP server，两个入口共用一份实现。
- fastctx 自身也印证这一点：v1 分支为了真正做到省上下文，走向了接管宿主（hook Claude Code 与 Codex），而不是停在 MCP。

## 二、fastctx v0.2.6 是什么（已读源码，`/tmp/fastctx-026`）

- 约 6.3 万行 Rust、291 个测试；9 个 MCP 工具：`inspect_local_file`、`grep`、`glob`、`replace`、`run`、`run_background`、
  `job_output`、`job_kill`、`job_list`。
- 解决的问题：Codex 原生只有 shell，模型读文件、搜内容要自己拼命令、处理引号 / 编码 / 截断。这些工具 CC 与 nyan **已有**
  （Read / Grep / Glob / Bash），所以 fastctx 对 nyan 的价值在**这些工具的细节打磨**，不在新增能力。
- 主分支 v1 已重写为"World"多机 agent 平台（hub、账号、桌面端），MCP 只剩 `run` / `ask_colleague` / `message_colleague`，
  与本文无关。

## 三、现状问题（2026-10-27 实测）

| # | 问题 | 证据 |
|---|---|---|
| P1 | **Grep 输出顺序不确定**：rg 多线程下，同一命令 20 次运行得到 **20 种不同输出**（按 sha256 比较）；加 `--sort=path` 后 20 次完全一致 | 本仓库 `rg -n --no-heading 'ContentReplacementState' src` 实测 |
| P2 | **Read 读非 UTF-8 文件得到乱码**：`String::from_utf8_lossy`（`utils/read_file_in_range.rs:318,469`）；GBK 的"你好，世界"读成 `��ã�����` | 实测 |
| P3 | **Read 超预算整体报错**，不返回部分内容：`validate_content_tokens`（`file_read_tool/mod.rs:871-889`，25k token） | 读源码 |
| P4 | **Bash 长输出只保留开头**：超过 30 000 字符后 `{开头}\n\n... [N lines truncated] ...`（`bash_tool/utils.rs:151-156`）；编译错误、测试失败摘要通常在**尾部** | 读源码 |
| P5 | **没有完整性声明**：Read / Grep / Glob 的结果不说明"是否已全部展示、下一步从哪继续"；模型要么猜、要么多调一次试探 | 读源码 |
| P6 | **二进制只按扩展名判断**（`file_read_tool/mod.rs:1841`）：无扩展名或扩展名错误的二进制文件会被当文本读 | 读源码 |
| P7 | **Grep 吞掉遍历错误**：rg 的 stderr（无权限目录等）不报告，部分结果看起来像完整结果 | 读源码（`ripgrep.rs:840-854`） |
| P8 | **超长行不截断**：一行压缩过的 JS / JSON 可以单独吃掉整个预算 | 读源码 |

P1 与压缩设计直接冲突：压缩 C3 要求"同一内容字节一致重放"，prompt cache 要求前缀稳定；顺序抖动还会让模型把"同样的
搜索、不同的顺序"误读为内容变化。

## 四、设计

### T1 完整性尾行（Read / Grep / Glob / CodeSearch / WebFetch 统一）

每个可能被截断的工具结果，最后一行是以下之一（借鉴 fastctx `read_tool/text_file.rs:309-351`、`grep_tool.rs:2296-2396`）：

```
(Complete: reached end of file; lines 1-212 of 212 shown.)
(Partial: lines 120-159 of 512 shown. Continue with offset=160.)
(Complete: all 37 files shown.)
(Partial: files 1-250 shown; more exist. Continue with offset=250.)
(Complete: no matches found.)
(Partial: 2 of 5 files processed. Continue with files=[{"path":"src/a.rs","offset":301},{"path":"src/b.rs"}].)
```

- **续读参数可直接照抄**：`Continue with …` 后面是下一次调用要传的确切参数，不需要模型推算。
- 跳过与不可达附加在同一行：`(Complete: all 37 files shown; 2 files skipped (encoding), 1 path unreachable.)`，明细在尾行之前
  逐条列出（最多 20 条，计数始终准确）。
- 工具描述里写明："Only continue with the exact parameters a Partial note provides."
- **与 CC 的偏离**：CC 的 Grep 分页提示是 `[Showing results with pagination = limit: N, offset: M]`；nyan 改为尾行格式
  （`@nyan`）。受影响的 CC 对齐测试改为断言新格式（`tool_execution.rs`、`grep_tool/mod.rs` 中引用该提示的测试）。

### T2 确定性顺序（Grep / Glob / CodeSearch exact）

- **Grep content / count 模式加 `--sort=path`**（`@nyan`）：实测 11 ms → 30 ms，换来 20 / 20 次一致。files_with_matches 模式
  保持 CC 的"按 mtime 降序"（已在 rg 之后排序，`grep_tool/mod.rs:659-666`，已确定）。
- Glob 已用 `--sort=modified`（`utils/glob.rs:288`），确定，不改。
- CodeSearch exact 分支改为进程内实现时（T7），遍历收集 → 稳定排序（路径字节序）→ 再搜。

### T3 Read：按预算截断返回，不整体报错

- 超过 token 上限时**返回能放下的最长行前缀 + Partial 尾行**，替代 `MaxFileReadTokenExceededError`（`@nyan`）。
  估算沿用 CC 的 `rough_token_count_estimation_for_file_type`（不引入 o200k 精确计数——对 Claude 模型不准，见第六节）；
  逐行累加，超过预算即停，保留尾行的空间。
- 默认上限不变（25k token、2000 行）；显式 `limit` 时以二者较小者为准。
- 去重（压缩 C5）不受影响：截断返回的那次 Read 记入 `ReadFileState` 的是实际返回的行范围。

### T4 Read：批量形态

- 新增参数 `files: [{path, offset?, limit?, encoding?}]`（1–16 个文本文件），与 `file_path` 二选一（借鉴 `read_tool/batch.rs`）。
- 共享一个 token 预算，**按顺序填满**；某个成员放不下时截断它并停止，未完成的成员写进尾行的 `files=[...]`。
- 单个成员失败（不存在、目录、二进制、编码无法判定、权限拒绝）只在它自己的段内报告，不影响其余。
- 每个成员**单独**走权限检查、去重（压缩 C5）与 `ReadFileState` 记录——与逐个调用 Read 的语义完全一致。
- 段头：`=== src/a.rs (lines 1-120 of 120) ===`。
- 图片、PDF、notebook 不进批量（与 fastctx 相同，保持单文件调用）。
- 上限 16（fastctx 为 32）：CC 的单消息工具结果总量上限 200k 字符，16 个文件 × 默认预算已足够；且批量结果作为一条
  工具结果参与压缩掩码，过大会让一次掩码清掉太多内容。

### T5 编码检测（Read / Grep / CodeSearch 索引共用）

新模块 `utils/text_decode.rs`（借鉴 `encoding/snapshot_pipeline.rs:115-253`、`encoding.rs`）：

1. 显式 `encoding` 参数 → 严格解码，失败报错（不 lossy）。
2. BOM（UTF-8 / UTF-16LE/BE / UTF-32LE/BE）优先。
3. 前 8 KiB 含 NUL → 二进制。
4. 严格 UTF-8 校验通过 → UTF-8。
5. 文件头魔数（zip / gzip / ELF / PE / Mach-O / sqlite / wasm / tar）→ 二进制。
6. `chardetng` 提名候选；非 ASCII 字节 ≥ 32 且候选通过严格解码与 round-trip → 采纳，结果首行注明
   `(Note: decoded from gbk; output is UTF-8.)`。
7. 证据不足 → 依次试 gbk、big5、shift_jis、euc-kr、windows-1252：恰有一个通过则采纳并注明；多个通过 → 报错并列出候选：
   `Cannot determine the encoding of P with confidence: decodes cleanly as gbk, big5. Retry with encoding="gbk".`；
   全部失败 → `undecodable`。**从不输出乱码猜测**。

- Read schema 新增 `encoding`（可选，WHATWG 标签）。
- Grep：rg 本身对非 UTF-8 文件按字节匹配；nyan 不改 rg 的匹配，只在 content 模式输出时对匹配行用同一模块解码；无法判定
  的文件记入尾行的 `skipped (encoding)`。
- CodeSearch 索引（检索 4.5）：无法判定编码的文件不进 text / semantic，记入索引跳过报告。
- 依赖：`encoding_rs`（已在依赖树，0.8.41）+ 新增 `chardetng`（Apache-2.0 / MIT）。

### T6 二进制与超长行

- Read 的二进制判定改为"扩展名 **或** 内容判定（T5 的第 3、5 步）"（`@nyan`）；判为二进制时报错并建议 `view="hex"`。
- 新增 `view: "hex"`（借鉴 `read_tool/hex_file.rs`）：每行 16 字节 `%08x  hex  |ascii|`，按行分页，尾行同 T1。
- 超长行：Read 单行超过 2000 字符时截断为 `…前 2000 字符… [line truncated: N chars total]`；Grep content 模式单行超过
  500 字符时只显示匹配附近的窗口（借鉴 `grep_tool.rs:2204-2274`）。

### T7 Bash：头尾保留

- 超过上限时保留**开头约 1/10 + 尾部其余**，中间 `... [N lines omitted] ...`（借鉴 `shell/output.rs:263-350`）（`@nyan`）。
  全文持久化（`bash_tool/mod.rs:876` `persist_output_file`）不变，提示末尾写明全文路径与"用 Read 加 offset 分页读"。
- 工具描述补三句（借鉴 `shell_server.rs:20` 的原意）：
  - "A non-zero exit code is a normal result, not an error." 
  - "There is no stdin; pass non-interactive flags (e.g. -y)."
  - "For very long output, redirect to a file and page it with Read."
- 输出含 U+FFFD 时附注"output contained invalid UTF-8"（不改输出本身）。

### T8 Grep / exact：报告遍历失败

- 解析 rg 的 stderr：权限拒绝、IO 错误的路径计入尾行的 `N paths unreachable`，明细列出（最多 20 条）。
- **搜索根本身不可读 → 报错**，不返回"no matches"（借鉴 `traversal.rs:421-432`）。
- CodeSearch exact 分支（检索 4.3）：首版沿用 rg 进程（与 Grep 同一套参数与 deny 规则），加 `--sort=path`；**不**在首版改为
  进程内 `grep-searcher`——实测 rg 进程启动约 6 ms、本仓库搜索约 11 ms，进程内实现省下的时间可以忽略；进程内的收益
  （结构化 span、确定顺序、编码报告）首版都能用 `--json` 输出与 T2 / T5 达到。若检索评测显示 exact 分支成为瓶颈再改。

### T9 防描述漂移

- 测试：工具描述与提示词中出现的工具名、参数名必须真实存在于注册的工具 schema 中（借鉴 `server_manifest.rs:439-466`）。
  新增尾行格式与参数（`files`、`encoding`、`view`）后，提示词里的引用由这条测试守住。

## 五、配置

`settings.nyan.toolIo`（每项可关，关闭即回到 CC 行为）：

```jsonc
{
  "completionNotes": true,      // T1
  "stableGrepOrder": true,      // T2
  "readPartialOnOverflow": true,// T3
  "readBatchMax": 16,           // T4，0 = 关闭批量
  "encodingDetection": true,    // T5
  "contentBinaryCheck": true,   // T6
  "maxLineChars": { "read": 2000, "grep": 500 },
  "bashHeadTail": true,         // T7
  "reportUnreachable": true     // T8
}
```

## 六、明确不采纳（相对 fastctx）

| 项 | 理由 |
|---|---|
| o200k 精确 token 计数（`bpe-openai`） | 是 OpenAI 的分词器，对 Claude 模型不准；且每次输出都要完整分词。沿用 CC 的估算 |
| 输出档位与按 provider 自动降档、同轮并行调用的预算池（`context_guard.rs`） | 专为绕开 Codex 的压缩缓冲（13 600 token）设计；CC 已有单消息总量上限与压缩掩码 |
| "只分页、不持久化" | nyan 的持久化 + 预览更省事（模型可直接 Read 全文） |
| `replace` 批量替换 | 已有 Edit + 读后写校验；批量正则替换风险高 |
| 后台 job 管理（`run_background` / `job_output` 等） | CC 已有 `run_in_background` 与 BashOutput |
| 常驻控制中心、多进程共享运行时、TUI、自更新、接管 Codex 配置 | nyan 本身是常驻进程；其余与 nyan 无关 |
| 进程内 `grep-searcher`（首版） | 见 T8 |
| 图片原图返回 | nyan 现有的缩放与 token 压缩更好（`file_read_tool/mod.rs:898-979`） |

## 七、实现切片

| 切片 | 内容 | 主要写集 | 依赖 |
|---|---|---|---|
| A | T5 编码检测模块 + T6 内容二进制判定 | 新 `utils/text_decode.rs`、`Cargo.toml`（`chardetng`） | — |
| B | T1 尾行 + T3 截断返回 + T6 超长行 + hex 视图 + `encoding` 参数（Read） | `tools/file_read_tool/{mod,prompt}.rs`、`utils/read_file_in_range.rs` | A |
| C | T4 批量 Read | `tools/file_read_tool/mod.rs` | B、压缩 C（去重） |
| D | T1 尾行 + T2 `--sort=path` + T8 遍历失败报告 + T5 匹配行解码 + 超长行窗口（Grep / Glob） | `tools/grep_tool/mod.rs`、`tools/glob_tool/`、`utils/ripgrep.rs`、`utils/glob.rs` | A |
| E | T7 Bash 头尾保留与提示词 | `tools/bash_tool/{utils,prompt}.rs` | — |
| F | T9 描述漂移测试 | `tools/mod.rs` 的测试 | B、C、D、E |

A、E 可进批次 1；B、D 进批次 2；C 在压缩 C 之后；F 收尾。CodeSearch / WebFetch 的尾行由各自模块按 T1 格式实现。

## 八、验收

1. 同一 Grep（content / count）连续运行 20 次输出字节一致。
2. GBK / Big5 / Shift-JIS 文件经 Read 得到正确文本并注明来源编码；歧义时报错列出候选，不输出乱码。
3. 超过 token 上限的文件经 Read 返回前缀 + `(Partial … Continue with offset=N.)`，按提示续读拼接后无重复无缺口。
4. 批量 Read 的结果与逐个 Read 的结果逐段一致；任一成员失败不影响其余；续读 `files=[...]` 可直接照抄。
5. Bash 输出超长时尾部 90% 可见；`cargo build` 的报错（位于末尾）不被截掉。
6. 无扩展名的二进制文件被识别为二进制，`view="hex"` 可分页查看。
7. 有无权限目录时，Grep 结果尾行报告不可达路径数；搜索根不可读时报错。
8. 所有新行为都可通过 `settings.nyan.toolIo` 逐项关闭，关闭后与 CC 输出逐字节一致。
9. 提示词中引用的工具名与参数名全部存在（T9 测试）。
