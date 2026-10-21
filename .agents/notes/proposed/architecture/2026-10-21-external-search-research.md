# 外部搜索调研（Queue 11b）：GitHub 搜索服务与外部知识

**状态：proposed（调研结论 + N8 的设计输入，不是实现）**
**前置：Decision #7（六问已答）、#4（provider 配置形状）、#5/#43（评估）**

## 1. 先看 GitHub 的搜索服务（实测，不是记忆）

三个 REST 端点：`/search/code`、`/search/repositories`、`/search/issues`；GraphQL 也提供 `search`。

**限流（本机 `gh api rate_limit` 实测）**

| 桶 | 限额 |
| --- | --- |
| `search`（repositories、issues 等） | **30 次/分钟**（认证） |
| `code_search` | **10 次/分钟**，且**必须认证** |
| 未认证 | 10 次/分钟 |

与文档一致：`/rest/search/search` 的 "Rate limit" 一节写明 "up to 30 requests per minute for all search endpoints except for
Search code … limits you to 10 requests per minute"。

**结果上限（实测）**

```
GET /search/repositories?q=stars:>10000&per_page=1&page=1001
→ HTTP 422 {"message":"Only the first 1000 search results are available"}
   同一查询的 total_count 是 5669
```

也就是说：**`total_count` 可以远超 1000，但翻页到 1000 条以后直接报错。** 任何"按相关性取前 N"的策略都必须自己设 N，
不能指望翻完。

**code search 的额外限制（文档 `/search-github/searching-on-github/searching-code` 与 `/rest/search/search`）**

- 只搜**默认分支**；
- 只搜**小于 384 KB** 的文件；
- 必须至少有一个关键词（`language:go` 这种纯限定词不算）；
- fork 只有 star 数多于父仓库时才可搜；
- 排序只有 best-match（`sort=indexed` 已标注 "closing down"）。

**一个真实的坑（本仓库自测）**

```
GET /search/code?q=DurableTui repo:blxzer77/nyan in:file   → total_count 0
GET /search/repositories?q=nyan                            → 不含 blxzer77/nyan
```

仓库存在、文件存在，code search 却返回 0：**"搜不到"不等于"不存在"**。这条直接支撑 acceptance 里那句
"检索候选必须与当前本地源逐一核对"，也是 N8 里"外部搜索结果只能当候选"的最好例子。

**结论**：GitHub 搜索可以作为一个**外部搜索 provider**（代码用法、依赖示例、issue 讨论），但它不是权威源：没有语义检索、
结果上限 1000、只看默认分支、需要 token。它必须走 `SearchHit → Fetch → Evidence` 的同一套流程，不能直接进上下文。

## 2. 外部知识的结论

### 2.1 URL 规范化：只做语法级

RFC 3986 §6 的规范化（大小写、默认端口、点段、空路径、百分号编码）是**安全**的，因为两个规范化后相同的 URI 指向同一资源。
跟踪参数（`utm_*`、`fbclid`、`gclid`）与路径大小写**不是**语法级等价：剥离它们只能作为"去重候选"的动作，
不能作为"这是同一个资源"的身份。落地成两条：

- **身份**（Evidence 的主键）：语法级规范化后的 URL + 最终 URL（重定向之后）。
- **去重提示**：剥离跟踪参数后的形式，仅用于提示"可能重复"，命中后仍然各自保留 Evidence 记录。

### 2.2 留存与重取：内容寻址而不是覆盖

- Evidence 记录保存：最终 URL、响应字节的哈希、抓取时间、状态码、`Content-Type`、去标签后的文本快照。
- **同 URL 不同哈希 = 新版本**：新记录写入，旧记录标 `superseded`（不是删除），引用旧版的人仍然能重放它当时的内容。
- 默认 30 天（Decision #7），随会话删除；删除的是快照字节，哈希与引用关系保留（引用不会变成悬空）。

### 2.3 SSRF：OWASP 的控制项要全上

依据 OWASP *Server-Side Request Forgery Prevention Cheat Sheet*，一个安全的抓取器至少要：

1. **默认拒绝 + allowlist**：协议（只 HTTPS）、主机、端口三者都显式允许；
2. **先解析再校验 IP**，不要校验 URL 字符串——否则 `http://evil.example` 解析到 `127.0.0.1` 就绕过了；
3. **拒绝**回环、私网（RFC 1918）、链路本地 `169.254.0.0/16`（含云元数据 `169.254.169.254`）、CGNAT `100.64.0.0/10`、
   IPv6 ULA `fc00::/7` 与 `::1`；
4. **重定向逐跳复检**，或干脆禁止重定向并让调用方显式跟随；
5. **固定解析结果**再连接（防 DNS rebinding：解析一次、校验、用同一个 IP 建连）；
6. 超时、响应字节上限、并发上限；错误一律具名（`denied`、`unresolved`、`too_large`、`timeout`），不返回部分内容。

### 2.4 预算：三个独立上限，命中即具名状态

搜索次数、抓取字节、总时长各一个上限，任一命中就返回具名状态（`budget_exhausted` + 哪一个预算），
**不返回空结果集**——这与 acceptance #13/#14 一致：失败状态不能被伪装成"没有找到"。

### 2.5 证据链

`SearchHit → Fetch → Evidence → Citation`，引用只能指向 Evidence。Citation 的最小字段：
`evidenceId`、`quote`（必须来自快照原文）、`finalUrl`、`hash`、`fetchedAt`。
模型给出的引用必须能在快照里逐字命中，否则该引用作废（这条挡住了"编造引用"这一类失败）。

## 3. 对 N8 的落地建议

1. **Provider 接口配置化**（Decision #4 的"配置即授权"）：`retrieval.search.providers[]`，每项 `{ kind, baseUrl, apiKeyRef }`。
   配置了就可用，没配置就是具名不可用，不发请求。
2. **两条默认路径**：
   - 自托管 SearXNG（零密钥、内网、质量一般）作为**默认可用路径**；
   - 商业 API（Brave / Exa / Tavily 一类，返回结构化结果且平台侧已抓取）作为**质量路径**，需要 key。
3. **GitHub 搜索是独立 provider**：`kind: "github"`，需要 token，受 10 次/分钟限制；结果上限 1000 由调用方设 N（建议 50）。
4. **抓取器只有一份**：搜索 provider 只负责返回 hit，抓取、SSRF 校验、证据生成全部走同一个 `Fetch` 实现——
   商业 API 自带的摘要也不能绕过证据校验。
5. **评估**：把"外部搜索"的评估跑成 Langfuse dataset（Decision #43/#5），指标是"引用可逐字命中率"与"具名失败占比"，
   而不是"回答看起来对"。

## 4. 仍未定（需要 owner 一句话）

- **外部搜索供应商**：默认自托管 SearXNG + 允许配置商业 API，还是直接选一家商业 API？后者更省事、质量更好，
  但把"外部搜索"变成需要付费与密钥的能力。
- 建议：按上面第 3 节的两条路径实现，先把自托管跑通（零成本、可离线评估），商业 API 作为配置项。

## 5. 未验证

- SearXNG 自托管实例的质量与可用性（没在本机跑过）；
- 各商业 API 的当前定价与配额（未逐家核对）；
- GitHub code search 在**已索引**仓库上的召回质量（本仓库未被索引，无法在本仓库上测）。
