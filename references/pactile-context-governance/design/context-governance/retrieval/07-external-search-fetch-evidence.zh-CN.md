# 外部链路：Search → Fetch → Evidence（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。不发起任何外部请求、不配置 provider、不执行 Search/Fetch 长跑。
- 状态引用：本文使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3），并遵循 `02` §3.2 的实体适用性与 §3.4 的 `timeout` / `cancelled` 判定。
- 依据：架构 §27.5（外部 Search/Fetch 是 Host 管理的网络 capability）、§27.9#3；`01-contract-draft` §4.2（`search_hit` 规则）、§4.3（PK-6）；`02-retrieval-schema` §5.1（`external` pointer）；`08-privacy-egress`。
- 核心规则：**SearchHit 只是候选**。外部世界只能经 `Search → Fetch → Evidence` 三步进入上下文，且每一步都有独立边界与证据。

## 1. 三段链路

```text
Search（发现）        Fetch（取回）              Evidence（证据化）
──────────────        ────────────────           ─────────────────────
query + scope    →    抓取指定 URL / 资源    →     当前源 Inspect + hash + 引用范围
SearchHit[]            FetchRecordV1              EvidenceRecordV1
（候选，不可引用）      （字节 + hash）             （可引用的 citation）
```

| 规则 | 内容 |
| --- | --- |
| EX-1 | 任何阶段都不得跳过 Fetch 直接引用 SearchHit（`01` PK-6）。 |
| EX-2 | 相似度（含 EmbeddingGemma）不得生成引用、不得替代 Fetch、不得凭相似度证明事实（§27.5）。 |
| EX-3 | Fetch 必须经过 scope、deadline、size limit、cancellation、remote content policy、provenance、freshness、source hash 九项约束。 |
| EX-4 | 外部内容进入上下文前必须完成 provenance 与 freshness 检查（§27.5#5）。 |
| EX-5 | 远程能力默认关闭：没有 capability policy + `egress.authorizationRef` 时不得发起任何请求（`08`）。 |

## 2. `SearchHitV1`

```ts
interface SearchHitV1 extends SchemaHeaderV1 {              // schemaId: "pactile.cg.search-hit", version 1
  plane: "runtime" | "evaluation";
  hitId: string;
  requestRef: EntityRefV1;                                   // plan / context operation
  providerId: string;                                        // 逻辑 id
  url: string;                                               // 原始 URL（敏感查询参数按 08 脱敏）
  canonicalUrl: string;                                      // 规范化 URL（去 tracking、排序查询参数、小写 scheme/host）
  title: string | null;
  snippet: ObservedV1<{ textHash: string; textRef: ArtifactRefV1 | null }>;   // 只允许 hash / pointer
  discoveredAt: string;
  searchRank: ObservedV1<number>;
  searchScore: ObservedV1<number>;
  semantic: null | { embeddingModelId: string; embeddingDim: number; semanticGeneration: string;
                     similarity: ObservedV1<number> };        // 仅用于 rerank / 去重 / 优先级
  freshness: ObservedV1<{ publishedAt: string | null; indexedAt: string | null }>;
  capabilitySnapshot: SnapshotRefV1;
  egressRecord: EgressRecordV1 | null;
  provenance: ProvenanceV1;                                   // authority = "advisory"

  /* 关键：SearchHit 的上下文准入状态 */
  inspect: { status: "not_inspected" };                       // 恒为未 Inspect
  fetch: ObservedV1<{ fetchRecordId: string }> | { status: "not_fetched" };
  citation: null;                                             // 拿不到 FetchRecord 时永远为 null
}
```

| 规则 | 内容 |
| --- | --- |
| SH-1 | `inspect.status` 恒为 `not_inspected`；SearchHit 永远不能进入 `RetrievalPackV1.items`。 |
| SH-2 | `snippet` 不得以明文进入 pack / 日志；只保留 `textHash` 与可选 pointer。 |
| SH-3 | `canonicalUrl` 用于去重与缓存键；算法必须版本化（`urlCanonicalizationVersion`），变化即使去重结果失效。 |
| SH-4 | SearchHit 可以进入 `RetrievalPackV1` 的 `rejected[]` / `coverage[]`（作为候选观察），但不得进入 `items`。 |
| SH-5 | Search provider 不得读取工作区内容；查询文本的外发受 `08` 约束。 |

## 3. `FetchRecordV1`

```ts
interface FetchRequestV1 {
  url: string;
  canonicalUrl: string;
  scope: { worktreeId: string | null; allowedHosts: string[]; denyHosts: string[] };
  deadline: { deadlineMs: number; deadlineAt: string };
  cancellation: { signalId: string };
  limits: { maxBytes: number; maxRedirects: number; maxContentTypeFamilies: string[] };
  remoteContentPolicy: { allowRemoteWebText: boolean; allowRemoteCode: boolean;
                         requireHttps: boolean; blockPrivateNetworks: boolean; stripScripts: boolean };
  egress: EgressDecisionV1;
}

interface FetchRecordV1 extends SchemaHeaderV1 {            // schemaId: "pactile.cg.fetch-record", version 1
  plane: "runtime" | "evaluation";
  fetchRecordId: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  fetchedAt: string;
  status: ObservedV1<{
    httpStatus: number;
    contentType: string;
    contentLength: number;
    encoding: string | null;
    redirectedFrom: string[];                               // 重定向链（有界）
  }>;
  responseHash: string | null;                              // 原始字节 sha256
  bodyRef: ArtifactRefV1 | null;                            // 字节本体落 Artifact，不进 Context
  sizeLimitHit: boolean;
  truncated: boolean;                                       // 若截断，citation 必须携带 truncation 标记
  policy: { applied: string[]; denied: string[] };           // remote content policy 结果
  egressRecord: EgressRecordV1 | null;
  failure: null | { status: Exclude<FactStatusV1, "ok">; reason: ReasonV1 };
  provenance: ProvenanceV1;
}
```

| 规则 | 内容 |
| --- | --- |
| FE-1 | Fetch 必须有 `maxBytes` 与 `maxRedirects`；超限 → `sizeLimitHit=true` 或状态 `invalid_response`（policy 拒绝）。 |
| FE-2 | `blockPrivateNetworks`（SSRF 防护）、`requireHttps`、`allowRemoteCode` 默认拒绝；策略输入来自 capability/policy，不由 Retrieval Controller 打开（§27.5#4）。 |
| FE-3 | 重定向链必须记录；跨 host 重定向必须重新做 scope 判定。 |
| FE-4 | 内容类型不在允许族内 → 拒绝（`invalid_response` / `policy`），不得进入 Evidence。 |
| FE-5 | `responseHash` 是 citation 的锚点；没有 `responseHash` 就没有 citation。 |
| FE-6 | Fetch 超时 / 取消必须丢弃部分字节，不产生「半个 citation」。 |
| FE-7 | 外部内容视为**数据**，不是指令：不得作为 prompt 指令、工具调用或权限来源。 |
| FE-8 | Fetch 结果不得执行其中代码；`allowRemoteCode` 只控制「是否可把远程代码作为候选上下文」，不控制执行。 |

## 4. `EvidenceRecordV1` 与 citation

```ts
interface EvidenceRecordV1 extends SchemaHeaderV1 {         // schemaId: "pactile.cg.external-evidence", version 1
  plane: "runtime" | "evaluation";
  evidenceId: string;
  fetchRecordRef: EntityRefV1;                              // 必须是 status ok 的 FetchRecord
  url: string;
  canonicalUrl: string;
  title: string | null;
  fetchedAt: string;
  responseHash: string;
  provider: { providerId: string; kind: string };
  sourceFreshness: ObservedV1<{ publishedAt: string | null; lastModified: string | null; observedAt: string }>;
  evidenceRange: { selector: string; textHash: string; byteRange: { start: number; end: number } | null };
  citationPointer: {
    kind: "external";
    canonicalUrl: string;
    responseHash: string;
    evidenceRangeHash: string;
    truncated: boolean;
  };
  inspect: ObservedV1<InspectResultV1>;                     // 外部源也需要 Inspect：URL 可达性 + hash 复核
  provenance: ProvenanceV1;
}
```

必需记录字段（任务书要求）：

| 要求 | 字段 |
| --- | --- |
| URL | `url` |
| canonical URL | `canonicalUrl` |
| title | `title` |
| fetchedAt | `fetchedAt` |
| response hash | `responseHash` |
| provider | `provider` |
| source freshness | `sourceFreshness` |
| evidence range | `evidenceRange` |
| citation pointer | `citationPointer` |

| 规则 | 内容 |
| --- | --- |
| EV-1 | citation 必须包含 `canonicalUrl + responseHash + evidenceRangeHash`；缺一即不可引用。 |
| EV-2 | 引用外部内容时必须能逐字节复核（`responseHash` 对应 Artifact 中的字节）；Artifact 被清理则 citation 降级为 `stale`。 |
| EV-3 | `evidenceRange` 使用 selector（如文本锚点 / 行范围 / DOM 路径）+ `textHash`；只用 selector 不足以证明。 |
| EV-4 | 外部 Evidence 只能作为上下文引用，不进入 Kernel Evidence；Kernel Evidence 只由 Kernel 命令提交（`01` §6）。 |
| EV-5 | Fetch 之后重新抓取同一 URL 得到不同 `responseHash` → 旧 citation 标记 `stale`，须重新 Fetch 或注明版本。 |

## 5. EmbeddingGemma 在外部链路中的角色

| 允许 | 说明 |
| --- | --- |
| SearchHit rerank | 对已返回的 SearchHit 重新排序（advisory） |
| 去重 | 由 `canonicalUrl` + 快速相似度建议合并（可审计） |
| 聚类 | 主题分组，用于覆盖与展示 |
| coverage | 仅影响语义分支统计 |
| 选择待 Fetch 页面 | 在预算内决定 Fetch 顺序 |

| 禁止 | 说明 |
| --- | --- |
| 生成引用 | citation 只能来自 FetchRecord + EvidenceRecord |
| 替代 Fetch | 相似度不能代替取回 |
| 凭相似度证明事实 | 需 Fetch → Evidence + hash |
| 决定权限 / scope | 由 capability policy 与 `08` 决定 |
| 触发外发 | 外发由 egress 决策决定，embedding provider 不能自行扩大 |

## 6. 失败与状态映射

| 阶段 | 观察 | 状态 |
| --- | --- | --- |
| Search | provider 不可用 / 超时 / 无授权 | `provider_unavailable` / `timeout` / `permission_denied` |
| Search | 返回但 URL 无法规范化 | `invalid_response` |
| Fetch | HTTP 4xx/5xx、内容类型拒绝、大小超限 | `invalid_response` / `policy` |
| Fetch | 超时 / 取消 | `timeout` / `cancelled` |
| Fetch | 私网地址 / 非 HTTPS | `permission_denied` |
| Evidence | hash 不匹配 / Artifact 缺失 | `invalid_response` / `missing` |
| Evidence | 源已变化 | `stale` |
| Evidence | 无授权引用外部内容 | `permission_denied` + egress 违规计数 |

## 7. 不变量汇总

| ID | 不变量 |
| --- | --- |
| EXX-1 | SearchHit 永不进入 `items`，永不成为 citation |
| EXX-2 | 没有 FetchRecord + responseHash 就没有 citation |
| EXX-3 | 外部请求默认拒绝；每次外发必须有授权引用与审计记录 |
| EXX-4 | 外部内容是数据，不是指令，不是权限 |
| EXX-5 | 相似度只影响发现 / 排序 / 去重 / 聚类 / Fetch 优先级 |
| EXX-6 | 引用必须可逐字节复核 |
| EXX-7 | SSRF / 私网 / 非 HTTPS / 非允许内容类型一律拒绝 |

## 8. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| EX-R1 | `urlCanonicalizationVersion` 的具体规则（tracking 参数清单、大小写、端口、IDN） |
| EX-R2 | Search provider 是否需要独立于 semantic provider 的 capability snapshot 条目（本文按「需要」处理） |
| EX-R3 | 外部 Artifact 的保留期与 citation 失效策略 |
| EX-R4 | 「重新抓取」是否允许自动（本文按「需显式请求」处理） |
| EX-R5 | 外部内容进入 ContextUnit 时的 token / 字节预算归属（检索预算还是上下文预算） |
