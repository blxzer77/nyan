# 隐私与数据外发边界（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。不配置端点、不读取凭据、不发起任何外发（包括 readiness probe）。
- 依据：架构 §27.5#4（`allowRemoteWebText` / `allowRemoteCode` 是 capability/policy 输入）；`08-p0-admission-decision` §3.4（deny-by-default）；`D:\MyHarness\AGENTS.md` 凭据规则；`01` / `07` 的 `EgressDecisionV1` / `EgressRecordV1` / `CostMetadataV1`。
- 目标：在没有明确授权前，任何字节都不得离开本机；一旦外发，必须留下可复算、可审计、可归因的记录，且日志中不出现敏感内容。

## 1. 默认策略

```text
default = deny
```

| 规则 | 内容 |
| --- | --- |
| EG-1 | 没有 capability policy 与 `egress.authorizationRef` 时，远程 provider 一律判 `unavailable`（策略拒绝），且**不发起任何网络请求**。 |
| EG-2 | 「端点在配置里存在」「provider 名出现在 readiness 里」都不构成外发授权（`01` PCS-2 / PCS-3）。 |
| EG-3 | 授权必须显式、有范围、有期限、有引用：`EgressAuthorizationV1`。 |
| EG-4 | 每次外发必须产生 `EgressRecordV1`；没有记录的外发按违规处理。 |
| EG-5 | 外发违规数是零容忍计数器（`03-stage-plan` §1.2）。 |
| EG-6 | 阻断前必须先判定：违规计数在**请求发出之前**增加，避免「先发后拦」。 |

## 2. 数据分类

| 类 | 例子 | 默认 | 可外发条件 |
| --- | --- | --- | --- |
| D0 凭据 | API key、Bearer token、私钥、`.env` 值、cookie | **永不可外发** | 无 |
| D1 完整 transcript | 对话全文、工具输出全文 | **永不可外发** | 无 |
| D2 源码正文 | 文件内容、diff、patch | 不可外发 | 仅 `allowRemoteCode` + 授权 + 明确范围 |
| D3 路径列表 | 文件路径、目录结构 | 不可外发 | 仅授权 + 最小必要（优先相对路径） |
| D4 未授权路径 | 越出 scope 的任何路径 | **永不可外发** | 无 |
| D5 查询文本 | 用户查询 / 意图描述 | 不可外发 | 授权 + 可脱敏 |
| D6 派生数值 | hash、行号、计数、维度、延迟、错误码 | 允许本地记录 | 外发时只允许无正文的数值/哈希 |
| D7 网页文本 | Fetch 到的远程内容 | 由 `allowRemoteWebText` 决定是否进入 Context | 不代表可再外发 |

| 规则 | 内容 |
| --- | --- |
| DC-1 | D0 / D1 / D4 在任何 provider、任何日志、任何报告中都不允许出现（含评测输出）。 |
| DC-2 | D2 / D3 / D5 的外发必须逐次授权，禁止「授权一次永久生效」。 |
| DC-3 | 发送正文时优先发送 `textRef`（本地指针）；只有本地 provider（`destination: "local"`）才允许直接读指针内容。 |
| DC-4 | 远程 embedding / search 只允许发送**授权范围内的最小片段**，且必须记录发送内容的 hash 与字节数。 |
| DC-5 | 不允许用「已脱敏」作为免授权理由：脱敏后仍按原类别处理。 |

## 3. `EgressDecisionV1` / `EgressAuthorizationV1` / `EgressRecordV1`

```ts
interface EgressDecisionV1 {
  destination: "local" | "remote";
  allowed: boolean;
  authorizationRef: ArtifactRefV1 | null;      // remote 且 allowed 时必须非 null
  dataClasses: ("D0"|"D1"|"D2"|"D3"|"D4"|"D5"|"D6"|"D7")[];
  redactionProfile: string;                    // 版本化 profile id
  expiresAt: string | null;
  capabilityPolicyRef: ArtifactRefV1 | null;
}

interface EgressAuthorizationV1 extends SchemaHeaderV1 {     // schemaId: "pactile.cg.egress-authorization", version 1
  plane: "runtime" | "evaluation";
  authorizationId: string;
  grantedBy: string;                                          // 主体标识（不含凭据）
  scope: { worktreeId: string | null; scopeId: string; pathScopes: SourcePointerPatternV1[] };
  providerIds: string[];
  dataClasses: string[];
  maxBytesPerRequest: number | null;
  maxRequestsPerOperation: number | null;
  grantedAt: string;
  expiresAt: string | null;
  revocable: true;
  provenance: ProvenanceV1;                                   // authority = "host"
}

interface EgressRecordV1 extends SchemaHeaderV1 {           // schemaId: "pactile.cg.egress-record", version 1
  plane: "runtime" | "evaluation";
  egressId: string;
  operationRef: string;
  providerId: string;
  destination: "local" | "remote";
  endpointClass: "localhost" | "private-network" | "remote-host";   // 不含主机名与 IP
  dataClasses: string[];
  itemCount: number;
  bytesSent: number;
  payloadHashes: string[];                                    // 每个发送片段的 hash
  redactionProfile: string;
  authorizationRef: ArtifactRefV1 | null;
  policyDecision: "allowed" | "denied";
  deniedReason: ReasonV1 | null;
  startedAt: string;
  endedAt: string | null;
  provenance: ProvenanceV1;
}

interface CostMetadataV1 {
  unitPrice: number | null;
  units: number | null;
  currency: string | null;
  estimated: boolean;
  notProvided: boolean;
}
```

| 规则 | 内容 |
| --- | --- |
| EC-1 | `EgressRecordV1` 不含主机名、IP、查询文本、URL 全文、正文；只有 `endpointClass` 与 hash。 |
| EC-2 | `authorizationRef` 为 `null` 且 `destination = "remote"` → `policyDecision` 必须为 `denied`。 |
| EC-3 | `payloadHashes` 必须与本地 Artifact 中的发送片段一致，可复核「到底发了什么」。 |
| EC-4 | `CostMetadataV1` 不包含账户 id、账单标识或凭据；缺数据时用 `notProvided = true`，不得填 0 冒充已知。 |

## 4. 日志与报告禁止项

不得写入 provider 日志、runner 日志、结果文件、pack、receipt 或任何报告：

```text
API key / Bearer token / cookie / session token / 私钥
原始敏感文本（D0/D1）
secret 值本身（只允许出现「发现 secret 形态，计数 N」）
不必要的源码正文（可用 hash / pointer 代替时禁止贴正文）
未授权路径列表（含绝对路径、盘符、home 目录、用户名）
完整 transcript
endpoint 明文（主机名 / IP / 端口）
```

| 规则 | 内容 |
| --- | --- |
| LG-1 | 日志字段必须走**允许清单**（allowlist），不是禁止清单。允许：`providerId`、`protocol`、`modelId`、`semanticGeneration`、`dim`、计数、延迟、错误码、hash、逻辑 id。 |
| LG-2 | 异常对象不得直接序列化整个请求 / 响应对象（典型泄漏路径）；只允许序列化白名单字段。 |
| LG-3 | 日志与结果在写入前必须过一次**形态扫描**（凭据形态、绝对路径形态、长 base64 形态），发现命中时只记录文件名与计数（沿用旧评测 harness 的做法）。 |
| LG-4 | 形态扫描只证明「未发现已知形态」，不证明「安全」；不得写成「已保护」（`06-blockers` BL-19 仍未决）。 |
| LG-5 | secret 扫描策略本身尚未决策（拒写 / 需确认 / 允许）；P0 只记录该事实，不假定任何策略生效。 |
| LG-6 | 评测结果根必须做一次凭据形态扫描并把「文件名 + 计数」写入报告。 |

## 5. 阶段准入

| 阶段 | 外发状态 |
| --- | --- |
| P0（当前） | 禁止任何外发；readiness fixture 只定义，不执行 |
| 1a / 1b | 无外发；只使用 fake provider 与本地 fixture |
| 2（semantic shadow） | 需要 `BL-16` 的外发策略 + 显式授权；本地 provider 优先 |
| 3（Jev shadow） | 同上；Jev 凭据按既有凭据规则处理，禁止回显 |
| 4+ | 同上；lossy / promotion 另有授权 |

| 规则 | 内容 |
| --- | --- |
| ST-1 | 阶段 2 之前必须冻结：拒写 / 需确认 / 允许三档策略、审计字段、授权引用格式、撤销路径。 |
| ST-2 | 外发授权与「允许 remote 分支」是两个不同的开关：plan 的 `egress.remoteAllowed` 为 `true` 而授权缺失时仍必须拒绝。 |
| ST-3 | 撤销授权后，已抓取的远程 Artifact 继续作为证据保留（带原始 hash 与抓取时间），但新的外发必须重新授权。 |

## 6. 本地优先原则

| 规则 | 内容 |
| --- | --- |
| LP-1 | 优先使用本地 provider（`destination: "local"`）：exact / lexical / structural / relation 全部本地，不需要外发。 |
| LP-2 | semantic provider 若是本地进程（例如本机模型服务），仍必须标注 `destination`，并把「进程启动 / 端口绑定」纳入 capability snapshot。 |
| LP-3 | 本地 provider 也不是事实源：其输出仍是 advisory，仍需 Inspect（`04`）。 |
| LP-4 | 本地 provider 不得读取授权范围外的路径（与 Inspect 相同的 scope 判定）。 |

## 7. 不变量汇总

| ID | 不变量 |
| --- | --- |
| PEG-1 | 默认拒绝；无授权不发请求 |
| PEG-2 | D0 / D1 / D4 永不外发、永不入日志 |
| PEG-3 | 每次外发有 `EgressRecordV1`，可逐片段复核 |
| PEG-4 | 外发违规计数在请求前增加，零容忍 |
| PEG-5 | 日志走允许清单；异常对象不得整体序列化 |
| PEG-6 | 形态扫描结果不得表述为「已保护」 |
| PEG-7 | 授权可撤销、有范围、有期限 |

## 8. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| PE-R1 | `EgressAuthorizationV1` 的授予主体与格式（对应 `BL-16`） |
| PE-R2 | secret 扫描策略（对应 `BL-19`）：拒写 / 需确认 / 允许，以及是否需要预注册正则集 |
| PE-R3 | `endpointClass` 的判定方式（localhost / 私网 / 公网）与 SSRF 防护规则的复用（`07` FE-2） |
| PE-R4 | 本地 provider 是否需要同样强度的 `EgressRecordV1`（本文按「需要，但 destination=local」处理） |
| PE-R5 | 远程 Artifact 的保留期与删除策略（与 citation 失效相关，`07` EX-R3） |
| PE-R6 | 评测平面是否允许外发（本文按「阶段 2 起允许，且必须与 runtime 相同授权口径」处理） |
