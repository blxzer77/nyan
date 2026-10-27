# 检索（Retrieval）设计：`code_search`

状态：已定稿，未实现（2026-10-27）。两机访问与 corp-pc 不可用时的回退已定（3.1、3.2）。

设计来源：nyan-legacy N6（旧 roadmap `88ef45bb0:ROADMAP.md` R1–R20、"Decided architecture" Retrieval 一节）、
Pactile `design/context-governance/retrieval/00–13`（以 01 provider 契约、03 generation、04 Inspect、
05 候选管线、06 降级、10 评测为主）、`.agents/notes/proposed/architecture/2026-10-16-remote-hybrid-code-retrieval.md`、
`deploy/retrieval/README.md`。偏离 CC 的代码用 `@nyan` 标注。

**定位**：与压缩、记忆不同，CC 在这里**没有成熟基座**——只有即时执行的 `rg`（Grep/Glob）和默认关闭的 LSP。
检索是新增能力。legacy 的设计思想（下一节五条）完整保留；它的具体形态（RetrievalPack 词汇、13 项检查表、
远端协调器……）是为 Pactile 的 Kernel / 多客户端 / 评测平面设计的，本项目按自己的结构重新表达（见"九、明确不做"）。检索是本 fork 的重中之重，质量以评测说话（第八节，后续单独安排）。

## 一、设计思想（legacy，不可退让）

1. **确定性分支是下限**：exact、symbol、text 永远可用；semantic 只做参考，不可用时检索照常返回。
2. **候选不是证据**：任何候选——尤其是 semantic——进入结果之前，必须回到当前工作树重新读取，比对原始字节
   hash 与行范围（Inspect）。远端返回的文本永远不直接进模型上下文。
3. **失败不伪装成空结果**：分支超时、不可用、索引构建中、索引过期，各自有名字并让模型看见；"没找到"只在所有
   确定性分支都成功且零命中时才能说。
4. **索引是可重建的派生物，不是事实源**：generation 由参数元组派生，任何影响向量含义的变化都让旧索引失效；
   旧 generation 的候选永不进入结果。
5. **可复算**：同输入、同计划 → 同排序（确定性 tie-break），RRF 的 `k` 与权重显式记录。

## 二、现状（CC）

| 能力 | 现状 | 位置 |
|---|---|---|
| Grep / Glob | 外部 `rg` 即时扫描；Grep 默认 250 条，Glob 100 个 | `tools/grep_tool`、`tools/glob_tool`、`utils/ripgrep.rs` |
| LSP | 9 种操作；**默认关**（`ENABLE_LSP_TOOL`），服务器只能由插件声明 | `tools/lsp_tool/mod.rs:15`、`services/lsp/config.rs` |
| Explore 子代理 | 只读、Grep/Glob/Read/Bash；默认 haiku | `tools/agent_tool/built_in/explore_agent.rs:53-74` |
| 索引 / 语义 / BM25 | 无 | — |
| tree-sitter | 已链接 0.25，仅 bash 语法（用于命令安全分析） | `Cargo.toml:105-106` |

本机会话实测：Bash 1086 次（其中 `rg` 485、读片段 `head`/`sed`/`cat` 1000+），Grep 工具 71 次，Explore 1 次。
检索的真实形态是"模型多轮即时 `rg` + 读文件"，每次从零开始。

## 三、外部服务（复用 legacy 部署，corp-pc + nyan-ops）

| 组件 | 位置 | 接口 | 实测 |
|---|---|---|---|
| Embedding `jinaai/jina-code-embeddings-1.5b` | corp-pc，vLLM pooling，fp16（user unit `retrieval-vllm-embed`） | OpenAI 兼容 `POST /v1/embeddings`，`127.0.0.1:8090` | 1536 维、L2 归一、8192 ctx；40.5 chunks/s（1 并发）、91.8（8 并发）；每小时探测全通过 |
| Rerank `Qwen/Qwen3-Reranker-0.6B` | corp-pc，vLLM（`retrieval-vllm-rerank`） | `POST /score`，`127.0.0.1:8091`，返回 [0,1] | 在线；20 候选 p50 350 ms |
| Qdrant 1.19.2 | nyan-ops | `:6333`，需 API key | corp-pc 经 tailnet 直连约 0.5 s/请求（首次建连约 1.3 s）；nyan-pc 走 DERP 中继 |

部署说明与探测脚本在 `~/Projects/work/internal/retrieval/`（corp-pc；`probe.sh`、`retrieval-probes.timer` 每小时一次）。
`retrieval-llama-embed.container` 是保留的 llama.cpp 回退单元，镜像未拉取，处于 failed 状态，不影响 vLLM 服务。

### 3.1 两台机器的访问方式（已定，2026-10-27）

nyan 在 **nyan-pc** 与 **corp-pc** 上都要能用 semantic 与 rerank；GPU 服务只在 corp-pc，且 corp-pc 可能关机。

| 机器 | embedding / rerank 地址 | 路径 | 实测 |
|---|---|---|---|
| corp-pc | `http://127.0.0.1:8090` / `:8091` | 同机回环 | 查询 embedding 约 20 ms |
| nyan-pc | `https://corp-pc.tail6334e5.ts.net:8090` / `:8091` | tailnet；当前两机之间只有 DERP(hkg) 中继，无直连 | tailscale ping 约 0.7 s |

**corp-pc 侧用 `tailscale serve` 发布，不改 Quadlet、不改防火墙**：

```
tailscale serve --bg --https=8090 http://127.0.0.1:8090
tailscale serve --bg --https=8091 http://127.0.0.1:8091
```

- corp-pc 的 tailscale `OperatorUser` 是 `blxze`，serve 不需要 sudo；`--bg` 配置持久化在 tailscaled 里，重启后仍生效。
- 服务本身仍只绑 `127.0.0.1`，不暴露到 LAN（firewalld 默认区对 Wi-Fi 网卡生效，tailscale0 不在任何区）。
- TLS 证书由 tailscale 签发（MagicDNS 名），访问范围是 tailnet。tailnet 内的设备都是用户自己的，所以**不加 token**。
  若以后 tailnet 加入他人的设备，再开 vLLM `--api-key`，`apiKeyFile` 字段为此保留。
- 原 R-D1（改 `PublishPort` 绑 tailnet 地址 + token）、R-D2（SSH 转发）不采用：前者要改两个单元并处理 tailnet 地址在
  tailscaled 起来之前不存在的启动顺序问题；后者 nyan-pc 到 corp-pc 的 SSH 实测超时，且不适合常驻。

**客户端**：

- 检索的三个客户端（embedding、rerank、Qdrant）**一律不走代理**（`reqwest::Client::builder().no_proxy()`），不依赖
  `NO_PROXY` 是否设对。代理会照常替客户端连回环与 tailnet（实测经代理访问 `127.0.0.1:8090` 返回 200），绕一圈只是
  多一跳、多一个故障点。
- 远端 embedding 用 `encoding_format: "base64"`（vLLM 0.32 支持）：单条 1536 维响应从约 33 KB 降到约 8.5 KB，
  中继链路上差别明显；本机回环也用同一格式，不分两套。
- 每台机器的 settings 各自配置 URL（`~/.cometix/settings.json` 不同步），nyan 不做"自动发现 corp-pc"。

### 3.2 corp-pc 不可用时的回退（已定，2026-10-27）

semantic 与 rerank 是**可选增强**：不可用时，CodeSearch 退回 exact / symbol / text，结果照常返回并注明，不报错、
不卡住。关键是**快速判定不可用**——关机的 corp-pc 不会拒绝连接，只会让连接挂起，不能每次查询都白等一个 deadline。

**服务状态机**（每个外部服务各一份，进程内共享）：

```
Ready ──请求失败 / 超时──▶ Down(until = now + backoff)
  ▲                           │
  └──── 探测成功 ◀── 到期后由下一次查询触发一次后台探测
```

- **连接超时与请求超时分开**：连接 1.5 s（覆盖 DERP 中继下的建连，实测 nyan-ops 首次建连 1.3 s）；查询侧 embedding
  请求 2.5 s；rerank 2 s。超时即判 `Down`。
- **Down 期间不发请求**：直接跳过该分支，渲染 `[semantic unavailable (corp-pc unreachable)]`，不计入 deadline。
- **退避**：30 s 起，翻倍到最多 5 min；探测成功立刻回到 `Ready`。探测是后台任务，不阻塞当前查询。
- **探测内容**：`GET /v1/models` 并核对模型 id（readiness 的完整检查见 4.8，探测只做这一项，够判断"在不在"）。
- **启动时不探测**：第一次 CodeSearch 才建立状态，nyan 启动不因 corp-pc 关机而变慢。
- embedding 与 Qdrant 任一 Down，semantic 整体跳过；rerank Down 只跳过重排（排序退回 RRF 融合顺序，不提示）。

**索引同步在 corp-pc 不可用时**：

- 增量同步要先算 embedding，corp-pc 不可用时**不写 Qdrant**，变更的 chunk 记入本机待同步队列（索引目录下的
  `pending.jsonl`，只存 chunkId 与文件 hash，不存正文）。
- corp-pc 恢复（状态机回到 `Ready`）后后台补同步；补同步完成前，这些文件的 semantic 候选会因 hash 不一致在
  Inspect 时被拒（4.6），不会返回过期结果。
- nyan-pc 与 corp-pc 各自维护本机索引与各自的 Qdrant collection（collection 名含 `worktreeId`，见 4.8），两机互不干扰。

**写进渲染与验收**：

- `[semantic unavailable (corp-pc unreachable)]`、`[semantic index syncing: N files pending]` 两种说明行（4.2 风格）。
- 验收：corp-pc 关机时，nyan-pc 上 CodeSearch 首次查询最多多等一次连接超时（1.5 s），之后的查询不再等待；
  corp-pc 开机后 5 min 内自动恢复 semantic。

## 四、`code_search` 工具

### 4.1 对模型的接口

一个内置工具 `CodeSearch`（`@nyan`），与 Grep/Glob/Read 并列，不替换它们。

```jsonc
{
  "query": "string",              // 必填：自然语言描述、标识符、或字面量
  "path": "string",               // 可选：限定子目录（worktree 相对）
  "glob": "string",               // 可选：文件过滤
  "max_results": 10               // 默认 10，上限 30
}
```

不给模型 `mode` 参数：分支选择是检索服务的职责（4.3 的确定性规则），模型只描述要找什么。要精确字面量时模型
本来就会用 Grep；要符号定义时查询写标识符即可被识别。参数面保持和 Grep/Glob 一样小。

### 4.2 输出

legacy 的 RetrievalPack（`outcome` 枚举、`reason.code`、`fallback.from`……）服务于 Kernel、ABI 与评测平面。
本项目里读结果的是模型，所以**保留它的语义（失败具名、覆盖可见、"没找到"只在全部成功时才说），用 CC 工具结果
的风格表达**——简洁纯文本，和 Grep 的 "No matches found" / "[Showing results with pagination = …]" 同一路数：

```
src/services/compact/auto_compact.rs:198-290  fn auto_compact_if_needed  (exact, symbol, text)
<片段：Inspect 时读到的当前内容，最多 40 行>

src/query.rs:1093-1102  (text, semantic)
<片段>

[searched: exact, symbol, text — semantic unavailable (embedding service unreachable)]
[2 results dropped: file changed since indexing]
```

- 只有出问题时才出现方括号说明行；全部正常时只有结果。
- 零结果：全部分支都成功时写 `No matches found`；有分支失败时写 `No matches found in: exact, symbol (semantic unavailable — results may be incomplete)`。
  这就是 legacy "abstain 只在全部确定性分支成功时成立"的落地方式。
- 分支名对模型用直白的词（`exact` / `symbol` / `text` / `semantic`），不暴露内部的 structural/lexical 术语。
- 结构化结果（每条候选的分支 rank、hash、被拒原因、各分支耗时）**不进 transcript**：检索服务以库接口返回
  `SearchOutcome` 结构体，工具只负责渲染成上面的文本；评测 harness 直接调库接口拿结构体（第八节），不经工具、
  不解析文本。

### 4.3 分支

| 分支 | legacy 对应 | 实现 | 可信度 |
|---|---|---|---|
| `exact` | exact | 复用 CC 的 `rip_grep`（`utils/ripgrep.rs`）：查询中的标识符及其 snake/camel 变体；与 Grep 同一套 ignore 与权限规则 | 确定性，下限 |
| `symbol` | structural + relation | tree-sitter 符号表（4.5）：按名查定义、文件大纲；引用 / 调用者由同一张表的"标识符出现位置"派生 | 确定性 |
| `text` | lexical | 进程内 BM25（tantivy），按 chunk；分词同时切标识符（`autoCompactIfNeeded` → `auto compact if needed`） | 确定性 |
| `semantic` | semantic | jina embedding（corp-pc）+ Qdrant（nyan-ops），按 chunk | 参考，不可用时不影响其余 |

选分支的规则（确定性，legacy `RuleDecisionProvider` 的思路）：

- 默认四个分支都跑（并行，开销由 deadline 约束）；
- 查询是单个标识符或路径时，`symbol` 的结果在融合中加权到 2.0（找定义是这类查询的首要意图）；
- 查询含调用 / 依赖信号（`caller`、`who calls`、`调用`、`依赖`、`影响`…）时，`symbol` 额外返回引用位置；
- semantic 未配置时不跑、不提。

不引入 DecisionProvider / 模型参与规划：legacy 也只把它放在 shadow，规则足够且可复算。

### 4.4 执行管线

```
query → 选分支（4.3 的规则）
      → 各分支并行（tokio 任务；共享工具调用的 abort 信号；各自 deadline）
      → 路径规范化（worktree 相对、`/` 分隔、保留大小写；越界即丢弃）
      → 合并同一文件的重叠范围（保留全部来源分支，用于结果后的 "(exact, symbol)" 标注）
      → RRF 融合（只用名次，k 与权重是常量；同分按 路径字节序 → 起始行 → 分支顺序 决胜，保证可复算）
      → [可选] rerank
      → Inspect（4.6）
      → 渲染（4.2）
```

默认参数（常量，可在 `nyan.retrieval` 覆盖）：每分支最多 50 个候选；融合后保留 50；返回 `max_results`（默认 10，
上限 30）；每文件最多 3 条；每条片段 40 行；总 deadline 8 s，semantic 3 s；RRF `k = 60`，各分支等权。

- 用户按 Esc：沿用 CC 工具的 abort 语义（整个工具调用取消），不另造状态。
- 某分支超时：该分支结果丢弃，其余照常，渲染为 `[semantic timed out]`；超时与取消在内部枚举里是两个值，
  评测能区分（legacy DL-2 的意图），对模型只需要知道"这个分支没结果"。

### 4.5 本机索引（symbol / text / semantic 的数据来源）

- **位置**：`$CLAUDE_CONFIG_DIR/projects/<sanitize_path(worktree 根)>/retrieval/`（`session_storage::get_project_dir`，
  `utils/session_storage.rs:773`；符合 legacy Decision #1 与 03 IX-1：**永不写进工作树**）。
- **按 worktree 区分，不按 git 仓库共用**：memdir 用 canonical git root（`memdir/paths.rs:89-91`），同仓库的所有
  worktree 共用一份记忆；索引不能照抄——不同 worktree 的内容不同，必须各自一份（legacy GEN-6，`worktreeId` 进 generation）。
  worktree 根 = `git rev-parse --show-toplevel`，非 git 目录用 cwd。
- **内容**：每文件 `{path, fileHashRaw(sha256), size, mtime, language}`；tree-sitter 符号表（名称、类型、
  定义行范围、父作用域）；chunk 表（按符号边界切分，带 breadcrumb：`path › impl Foo › fn bar`）；tantivy 索引目录。
- **chunker**：tree-sitter 符号边界优先（函数 / 方法 / impl / class），超过 ~60 行或 ~400 token 再按行窗口切分；
  不跨文件（03 CH-2）。语言：Rust、TypeScript/JavaScript、Python、Go、Java、C/C++、Bash、Markdown（标题切分）
  ——首批以本仓库与 nyan-legacy 用到的为准，其余语言退化为行窗口 chunk + 无符号表（这些文件只参与 text / semantic，
  结果标注 `(no symbol check)`）。
- **文件清单**：复用 CC 已有的文件索引（`hooks/file_suggestions.rs`：`git ls-files --exclude-standard` + ripgrep
  ignore 规则，后台刷新），不另写遍历；非 git 目录退回 `ignore` crate 遍历。
- **变更检测**：有 git 时用 `git status --porcelain` + 上次索引时的 HEAD 与当前 HEAD 的 `git diff --name-only`
  得到变更文件集合，只对这些文件比 mtime/size、再算 sha256；无 git 时对清单做 mtime/size 预筛。68 万行的本仓库
  每次检索前全量 stat 太重，git 已经知道哪些文件变了。
- **何时更新**：会话启动时后台一次；之后在每次 `CodeSearch` 前做一次上述轻量变更检测（通常只有几个文件），
  以及 Inspect 发现 hash 不一致时把该文件入队。只重建变更文件的符号、chunk 与倒排条目；删除文件移除其条目。
  不做文件监听。
- **跳过**：二进制、> 1 MB、`.env`/私钥类路径、权限 deny 规则命中的路径 → 记入 `skippedFiles`（分类计数，不静默）。
- **首次建索引**：后台任务；未就绪时 symbol / text 跳过，exact 照常返回（legacy bootstrap 规则，见 4.10）。
- **依赖核实（2026-10-26，crates.io）**：语法 crate（`tree-sitter-rust` 0.24.2、`-typescript` 0.23.2、`-python` 0.25.0、
  `-go` 0.25.0、`-java` 0.23.5、`-cpp` 0.23.4、`-md` 0.5.4）只依赖 `tree-sitter-language ^0.1`（本仓库已有 0.1.7），
  与已链接的 tree-sitter 0.25 ABI 兼容；`tantivy` 0.27.0，MIT，`rust-version` 1.88，与本 crate 的 `rust-version = 1.88` 一致。
  许可均与 AGPL-3.0 兼容。

### 4.6 Inspect：候选进入结果前重读当前文件

legacy 的核心要求只有一句：**结果里的每一行内容都必须是此刻工作树里的真实内容**。在本项目里它就是结果渲染前的
一个函数 `inspect(candidate) -> Result<Verified, Dropped>`，不需要 13 项检查表：

1. 用 CC 现有的 Read 权限判定（与 Read 工具同一套 deny 规则与路径规范化）确认可读、在 worktree 内；
2. 读文件，算原始字节 sha256，与候选记录的 hash 比较；
3. 行范围仍在文件内；候选带符号名时，用同一份 tree-sitter 解析确认该符号仍在该范围；
4. 通过 → 片段取自刚读到的字节（不取索引里的任何文本，索引本来也不存正文）；
   不通过 → 丢弃，计入"N results dropped: <原因>"，并把该文件放进增量重建队列。

- 不自动重定位行号：hash 不一致的候选直接丢弃，由更新后的索引在下一次检索中给出新位置（legacy RA-1 的意图）。
- exact 分支的结果本来就是刚扫描的当前内容，直接视为已 Inspect；Inspect 主要拦截 symbol / text / semantic
  这些来自索引的候选。
- 语言不支持符号解析时，候选只按文件 hash 与行范围验证，结果标注 `(no symbol check)`，不假装验证过。

### 4.7 generation（legacy 03 §1，按本机落地裁剪）

```
semanticGeneration = "semgen-" + sha256(canonical_json({
  embeddingModelId, embeddingDim, normalize, precision,
  taskPrefix{query, document}, queryPreprocessVersion, documentPreprocessVersion,
  chunkerVersion, indexSchemaVersion, worktreeId
}))[..32]
```

- 任一字段变化 → 新 generation，后台重建新 collection；旧 collection 停止服务（GEN-1），其候选一律丢弃。
- 不含 `sourceSnapshotHash`：源码变化由文件级 hash 增量同步处理（不整体换代），Inspect 的 file_hash_raw 兜底。
  这是对 03 GEN-1 的有意裁剪：legacy 自己在 remote-hybrid 笔记 §5 也改为"按文件 hash 增量同步"。
- 维度不符（服务返回非 1536、或配置的 Matryoshka 维度与 collection 不一致）→ `wrong_dimension`，整批丢弃，
  需重建（EMB-2）。
- text 索引（tantivy）同理，以 analyzer + schema + chunkerVersion 派生版本号，变化即重建。

### 4.8 semantic 分支细节

- **embedding**：`POST /v1/embeddings`；文档侧不加前缀，查询侧加 jina `nl2code` 查询前缀
  （`Find the most relevant code snippet given the following query:\n`，与部署 smoke 测试一致）；前缀字符串进 generation。
- **readiness**（legacy 09，"HTTP 200 ≠ ready"）：首次使用与每 10 分钟探测一次——`/v1/models` 的 id、单条向量维度
  1536、有限值、L2 范数≈1、批量对齐。任一不符 → 该 provider `unsupported` 或 `provider_unavailable`，本次不服务。
- **响应校验**（EMB-1）：条数不符、维度不符、出现 NaN/Inf → 整批 `invalid_response`，不部分接受、不当低分。
- **Qdrant**：每个 `(worktreeId, semanticGeneration)` 一个 collection；payload `{path, startLine, endLine, chunkId,
  fileHashRaw, symbol?}`，只存 hash 与范围、**不存正文**（03 CH-3，同时满足隐私：正文不留在 nyan-ops）。
- **同步**：本机索引增量扫描产生变更 chunk → 批量（32）embedding → upsert / delete；失败的批次不提交，状态
  `index_partial`，该批文件的 semantic 候选在 Inspect 时会因 generation 或 hash 不一致被拒。
- **egress**：源码 chunk 正文只发往用户自己的 embedding 服务（corp-pc 上为本机回环；nyan-pc 上经 tailnet 的 WireGuard
  加密链路到 corp-pc，不经第三方）；发往 nyan-ops 的是向量 + 路径/行号/hash。按 legacy
  Decision #8"配置即授权"：在 `settings.nyan.retrieval.semantic` 里配置了服务即视为授权；未配置不发任何请求。
  `.env`、私钥、凭据类路径在索引阶段就跳过（4.5），永不外发。
- **单写者**：多个 nyan 进程同时打开同一项目时，用索引目录下的文件锁保证只有一个进程做同步；其它进程只读查询。
  不做 legacy 的远端协调器 / epoch / CAS（见第九节）。

### 4.9 rerank（可开关，交给评测决定）

- legacy 记录"reranker 评测负收益、默认关闭"，但仓库与 corp-pc 上都**找不到这份评测的数据**；按 legacy 评测原则
  （不得引用无法复现的旧数字），这只能作为待验证假设。
- **请求必须套 Qwen3-Reranker 的官方指令模板**（2026-10-27 实测，同一组 相关 / 无关 / 半相关 文档）：
  裸文本 `text_1=query, text_2=docs` 得分 0.878 / 0.145 / 0.836（区分度差，半相关几乎与相关同分）；套模板后
  0.999 / 0.000 / 0.010。部署的 `probe.sh` 与 `bench-rerank.py` 都用裸文本——legacy 的"负收益"很可能就是没套模板。
  模板（`/score` 的 `text_1` / `text_2`）：

  ```
  text_1 = "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n<Instruct>: {instruct}\n<Query>: {query}\n"
  text_2 = "<Document>: {doc}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
  ```

  `instruct`：代码检索用 `Given a code search query, retrieve relevant code snippets that answer the query`；网页候选
  （外部搜索 3.4）用 `Given a web search query, retrieve relevant passages that answer the query`。模板字符串进
  generation（换模板即换 rerank 行为，评测可区分）。20 个候选套模板后 133 ms（本机）。
- 设计：`settings.nyan.retrieval.rerank = false`（默认关），开启时对融合后 top-N（默认 20）调一次 `/score`，
  只用于重排；分数必须在 [0,1] 且有限，否则整批作废、回退到融合顺序。
- 是否默认开启，由评测决定（第八节）。
- **rerank 客户端是共享组件**：模板、`/score` 调用、分数校验与服务状态机（3.2）放在 `services/rerank.rs`，代码检索与
  外部搜索精排（外部搜索 3.3）共用；服务地址只在 `nyan.retrieval.rerank.url` 配一处。**开关各自独立**：
  `nyan.retrieval.rerank.enabled`（代码检索，默认关，等评测）与 `nyan.web.search.rerank.enabled`（网页精排，默认开）。

### 4.10 降级（legacy 06 的语义，按本项目表达）

内部用一个枚举表达每个分支的结果：`Ok | Unavailable(reason) | Building | TimedOut | Cancelled | Stale`，
渲染时转成 4.2 的方括号说明行。规则：

| 情况 | 行为 | 模型看到的 |
|---|---|---|
| semantic 未配置 | 不跑、不提 | 什么都不提（未启用 ≠ 降级） |
| embedding / Qdrant 不可用 | 跳过 semantic，其余照常；进入 Down 退避，期间不再发请求（3.2） | `[semantic unavailable (…)]` |
| corp-pc 恢复前有未同步的变更 | 已同步部分照常；未同步文件的 semantic 候选在 Inspect 被拒 | `[semantic index syncing: N files pending]` |
| 本机索引还在首次构建 | symbol / text 跳过，exact 照常 | `[symbol, text index building — exact only]` |
| 模型参数变了（generation 不符 / 维度不符） | semantic 候选全部丢弃，后台重建 | `[semantic index rebuilding]` |
| rerank 失败 | 用融合顺序 | 不提（排序质量问题，不影响结果真实性） |
| 所有分支都失败 | 工具返回错误（`is_error`），不返回空结果 | `Search failed: …` |
| 全部成功且零命中 | — | `No matches found` |

## 五、与其它模块的关系

- **记忆 M6**：检索服务是一个库（`services/retrieval`），`CodeSearch` 工具只是它的一个调用方。记忆模块直接调用
  库接口检索 memdir（memdir 单独建一个小索引：只有 text + semantic，按 git root），命中项用 CC 现成的
  `Attachment::RelevantMemories` 注入——走 CC 的 attachment 管线，不经工具调用。只在记忆条数超过 MEMORY.md
  索引能容纳的规模时启用（记忆少时 MEMORY.md 已全量注入）。
- **Explore 子代理**：由用户后续统一调整（工具列表、默认模型），本模块不改。
- **压缩**：`CodeSearch` 加入 `is_compactable_tool_name`（可被掩码清理）。
- **外部搜索**：不在本工具内；N8 的 `web_search` / `web_fetch` 单独设计（Search → Fetch → Evidence）。

## 六、配置

`settings.nyan.retrieval`：

```jsonc
{
  "enabled": true,
  "index": { "maxFileBytes": 1048576, "languages": "auto" },
  "semantic": {
    // corp-pc: "http://127.0.0.1:8090"；nyan-pc: "https://corp-pc.tail6334e5.ts.net:8090"（3.1）
    "embedding": { "url": "http://127.0.0.1:8090", "model": "jina-code-embeddings-1.5b",
                   "dim": 1536, "apiKeyFile": null },
    "qdrant":    { "url": "http://100.80.19.12:6333", "apiKeyFile": "~/.cometix/keys/qdrant" }
  },
  // corp-pc: "http://127.0.0.1:8091"；nyan-pc: "https://corp-pc.tail6334e5.ts.net:8091"
  "rerank": { "enabled": false, "url": "http://127.0.0.1:8091", "model": "qwen3-reranker-0.6b", "topN": 20 },
  "budget": { "deadlineMs": 8000, "semanticDeadlineMs": 3000, "rrfK": 60,
              "connectTimeoutMs": 1500, "embedTimeoutMs": 2500, "rerankTimeoutMs": 2000,
              "downBackoffMs": [30000, 300000] }
}
```

凭据只按文件引用（legacy Decision #4），不写进 settings 正文；未配置 `semantic` = 该分支不启用、不发请求。
`apiKeyFile` 为 `null` 时不发 `Authorization` 头（回环与 tailnet serve 都不鉴权，见 3.1）。Qdrant 的 key 首次配置时从
`~/Projects/work/internal/retrieval/keys/qdrant-api-key` 复制到 `~/.cometix/keys/qdrant`（0600）。

## 七、实现切片

| 切片 | 内容 | 主要写集 | 依赖 |
|---|---|---|---|
| A | 库接口与结果模型：`SearchRequest` / `SearchOutcome`、分支结果枚举、确定性 RRF、路径规范化、Inspect、文本渲染 | 新 `services/retrieval/{mod,outcome,fusion,inspect,render}.rs` | — |
| B | exact 分支（复用 `rip_grep`）+ `CodeSearch` 工具壳 + `auto` 规则 | 新 `services/retrieval/exact.rs`、`tools/code_search_tool/`、`tools/mod.rs` | A |
| C | 本机索引：遍历、文件 hash、增量、跳过分类、文件锁；tree-sitter 语法与符号表；chunker | 新 `services/retrieval/index/`、`Cargo.toml`（语法 crates） | — |
| D | symbol 分支（定义、大纲、引用） | `services/retrieval/symbol.rs` | A、C |
| E | text 分支（tantivy） | `services/retrieval/text.rs`、`Cargo.toml` | A、C |
| F | semantic：embedding / Qdrant 客户端（`no_proxy`、base64、分开的连接 / 请求超时）、服务状态机与退避、readiness、generation、同步与待同步队列、校验 | `services/retrieval/semantic/` | A、C |
| G0 | rerank 共享客户端：Qwen3 指令模板、`/score`、分数校验、服务状态机（3.2） | 新 `services/rerank.rs` | — |
| G | 代码检索接入 rerank（开关，默认关） | `services/retrieval/` 融合后调用 G0 | F、G0 |
| H | 评测（后续单独安排，见第八节） | — | — |
| I | 接入：压缩可清名单、记忆 M6、后台子代理工具白名单（`is_async_agent_allowed_tool`，`agent_tool_utils.rs:224-243`，否则后台运行的子代理拿不到 `CodeSearch`）；Explore 子代理的提示词与模型由用户后续统一调整 | 对应文件 | B、F |

部署：corp-pc 上执行 3.1 的两条 `tailscale serve` 命令即可（独立于代码，可先做）；服务本身不改。

## 八、评测（后续单独安排）

评测是检索质量的唯一判据（legacy Decision #43），具体方案后续单独设计。本设计为它预留的接缝：

- 检索服务的库接口返回完整的 `SearchOutcome`（每条候选的来源分支、名次、hash、丢弃原因，各分支状态与耗时），
  评测 harness 直接调用，不经工具、不解析文本；
- 分支可单独开关（`exact` / `symbol` / `text` / `semantic` / rerank），以便做 legacy 的对照臂（仅 rg、确定性分支、
  加 semantic、再加 rerank）；
- 排序可复算（确定性 tie-break），同输入多次运行结果一致；
- rerank 是否默认开、融合权重、分支选择规则，都等评测结果再定，设计里只给可调的默认值。

## 九、明确不做（相对 legacy）

| 项 | 理由 |
|---|---|
| 远端索引协调器（active-manifest CAS、coordinator epoch/fencing、job lease、Postgres 元数据） | 单用户、单机索引；一个文件锁足以保证单写者。legacy 的协调器为多客户端共享远端索引设计，且从未实现 |
| Tantivy 远端服务 | text 用进程内 tantivy，本机索引即可 |
| legacy Inspect 13 项检查表（含 worktree / branch / source_revision / operation_epoch / snapshot） | 本项目用"重读文件 + 比 hash + 比范围 + 比符号"一个函数表达同一要求（4.6）；单 worktree、无 operation epoch |
| ABI V3 ref / `unconvertible` | Pactile Kernel 的引用语法，nyan 无此边界 |
| DecisionProvider / Jev 规划 | legacy 只放 shadow；本 fork 用确定性规则 |
| RetrievalPack 词汇、reason.code 封闭枚举、ContextUnit / durable 适配 | 结果以 CC 工具结果的文本风格给模型（4.2），结构化数据留在库接口里；进上下文后由压缩模块负责清理 |
| 评测平面与产品平面的 receipt / Langfuse 接入 | 评测结果写本地文件；Langfuse 可后续接入 |

## 十、待定与已定

- 已定：首批语言为 Rust、TS/JS、Python、Go、Java、C/C++、Bash、Markdown，后续按需添加；评测后续单独安排。
- 已定（2026-10-27）：nyan-pc 与 corp-pc 都用 semantic / rerank——corp-pc 走回环，nyan-pc 经 `tailscale serve` 发布的
  tailnet HTTPS；客户端不走代理、不鉴权；corp-pc 不可用时快速判定并退回 exact / symbol / text（3.1、3.2）。
- 不在本模块：Explore 子代理的提示词与默认模型由用户后续统一调整；切片 I 把 `CodeSearch` 加进压缩可清名单、记忆 M6
  与后台子代理工具白名单。
