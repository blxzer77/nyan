# SemanticProvider readiness fixtures（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。**P0 不执行**任何 readiness 运行；本文件冻结 fixture 定义、期望状态与判定规则。
- 依据：`08-p0-admission-decision` §2.1（无调研产物时只冻结参数 + `unverified`）、§3.4（外发）；`01-semantic-provider-contract`；`03-semantic-generation-index` §9（未验证项）；`08-privacy-egress`；`../implementation/03-stage-plan` AC-2.1。
- 状态引用：`allowedStatuses` 等使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3），不定义本地状态成员。
- 核心规则：**HTTP 200 不等于 ready**。ready 只能由「全部必需检查通过 + 独立 probe 成功」共同判定；模型参数与 blocking 集未裁定时一律为 `unverified`（`RD-4`、`RD-8`）。

## 1. 判定模型

```ts
interface ReadinessFixtureV1 extends SchemaHeaderV1 {        // schemaId: "pactile.cg.readiness-fixture", version 1
  plane: "evaluation";                                        // readiness 只属于评测平面
  fixtureId: string;                                          // "rf-01" … ；与本文 §3 表一致
  title: string;
  category: "protocol" | "profile" | "preprocess" | "numeric" | "lifecycle" | "policy" | "observability";
  method: "probe" | "scripted-fake" | "inspection" | "measurement";
  inputs: { requestRefs: ArtifactRefV1[]; scriptRefs: ArtifactRefV1[]; expectedRefs: ArtifactRefV1[] };
  expect: { allowedStatuses: FactStatusV1[]; requiredChecks: string[]; forbiddenObservations: string[] };
  blockingProposal: "blocking" | "non-blocking" | "pending";   // 仅为提案；裁定前不得作为 ready 判定依据（RD-8）
  unverifiedIfNoResearch: boolean;                            // true = 缺调研产物时保持 unverified（不得写期望值）
  createdAt: string; provenance: ProvenanceV1; bodyHash: string;
}

interface ReadinessResultV1 extends SchemaHeaderV1 {         // schemaId: "pactile.cg.readiness-result", version 1
  plane: "evaluation";
  fixtureId: string;
  provider: { providerId: string; modelId: string | null; protocol: string };
  observed: {
    endpointReachable: ObservedV1<boolean>;
    declaredModelId: ObservedV1<string>;
    httpStatus: ObservedV1<number>;
    dim: ObservedV1<number>;
    finite: ObservedV1<boolean>;
    latencyMs: ObservedV1<number>;
    bytesSent: ObservedV1<number>;
    errorCode: ObservedV1<string>;
  };
  checks: { id: string; result: ObservedV1<"pass" | "fail">; detailHash: string | null }[];
  readinessVerdict: "ready" | "degraded" | "unavailable" | "unsupported" | "unverified";
  // 命名隔离：readinessVerdict ≠ 评测候选 verdict（pass/fail/blocked/unverified，`04` §9.1）
  //              ≠ harnessVerdict（valid/invalid/blocked，`04` §9.1）
  //              ≠ 共享 FactStatusV1（`01` §3.3）
  evidenceRef: ArtifactRefV1 | null;
  provenance: ProvenanceV1;
}
```

判定规则：

| 规则 | 内容 |
| --- | --- |
| RD-1 | `readinessVerdict = ready` 需要：全部已裁定为 blocking 的 fixture 判 pass（或按 §6 的 profile 允许 `degraded`），且 `probeRef` 非 null 的独立 probe 成功。 |
| RD-2 | 任一已裁定为 blocking 的 fixture 失败 → `unavailable` 或 `unsupported`，语义分支不执行，走 `06` 的 fallback。 |
| RD-3 | `httpStatus = 200` 只作为 **一个** 观测，不构成 pass；样例：能连通但维度错误、前缀缺失、返回 NaN 都必须判失败。 |
| RD-4 | 缺调研产物（`BL-02`）时，涉及模型事实的 fixture（§3 中 `unverifiedIfNoResearch = true`）只能得到 `unverified`；**不得**填入「期望通过值」。 |
| RD-5 | readiness 只产生评测事实；`ready` 不改变产品 Run、不写 runtime receipt（`01` ISO-7 / ISO-8）。 |
| RD-6 | readiness 运行必须遵守 `08` 的外发策略：无授权时只能用 `local` / `scripted-fake`；`remote` 目标在无授权时判 `denied` 并记录（不是「跳过不算」）。 |
| RD-7 | 所有 fixture 必须至少一条**阳性**（正常路径通过）与一条**阴性对照**（无故障时不触发降级），避免「任何情况都判失败/都判通过」。 |
| RD-8 | **blocking 集未冻结**：§3 的 `blocking 提案` 列只表达提案，不代表已决事实；在 `R-BL-10`（Owner = Implementation，依 `04` §4.1 / `09` §5）冻结前，不得据此签发 `ready`，也不得反推 provider 可用性。 |
| RD-9 | 本文件不得填写具体模型参数的真值（模型 id 字符串、task prefix 文本、batch 数值、成本数值）；这些字段只以「参数 + `unverified`」形式存在（`08` §2.1、`03` §9）。 |

## 2. profile 参数（冻结为参数，不冻结为事实）

| profile | dim | 状态 | 说明 |
| --- | --- | --- | --- |
| EmbeddingGemma 2 默认 | 768 | 默认 profile + 离线基线 | **不是** Domain truth；不得写进任何 Domain Contract |
| 降维 profile | 512 / 256 / 128 | `unverified` | 是否为同一模型的不同输出维度、独立模型，或需后处理投影 —— 无调研产物前不得假定（`03` UV-G1） |

| 规则 | 内容 |
| --- | --- |
| PF-1 | `embeddingDim` 是数据字段；计划、请求、结果、候选、snapshot 五处必须一致。 |
| PF-2 | 每个 profile 必须独立跑 §3 的维度、有限性、batch 与 generation 失效检查。 |
| PF-3 | 切换 profile 使 generation 失效（`dimension` 触发），旧向量不得复用（`03` GEN-5）。 |
| PF-4 | 多 profile 并存时，索引与查询必须使用同一 profile；混用 → `wrong_dimension`（原生层）。 |

## 3. fixture 目录

| ID | 类别 | 检查 | 方法 | 期望 | blocking 提案（未冻结） | 无调研产物时 |
| --- | --- | --- | --- | --- | --- | --- |
| RF-01 | protocol | endpoint 可达性与协议族 | probe | `endpointReachable = ok`；协议与 profile 声明一致 | 拟 blocking | 参数化 |
| RF-02 | protocol | model id 与声明一致 | probe | `declaredModelId` 与 snapshot 一致 | 拟 blocking | `unverified` |
| RF-03 | protocol | 请求 / 响应 shape（字段、编码、错误体） | scripted-fake | schema decode 成功；未知字段拒绝 | 拟 blocking | 参数化 |
| RF-04 | preprocess | task prefix（query） | scripted-fake | 前缀以声明字符串出现在实际请求中 | 拟 blocking | `unverified`（前缀字符串未知） |
| RF-05 | preprocess | query preprocessing | scripted-fake | 与 `queryPreprocessVersion` 一致的变换可复算 | 拟 blocking | `unverified` |
| RF-06 | preprocess | document preprocessing | scripted-fake | 与 `documentPreprocessVersion` 一致 | 拟 blocking | `unverified` |
| RF-07 | preprocess | title preprocessing | scripted-fake | 与 `titlePreprocessVersion` 一致；空标题有定义行为 | 拟 blocking | `unverified` |
| RF-08 | profile | embedding dimension 正确 | probe | 返回 `dim` 与 profile 一致 | 拟 blocking | 参数化 |
| RF-09 | profile | 512 / 256 / 128 profile | probe | 每个 profile 独立通过 RF-08 / RF-12 / RF-14 | 拟 blocking（若计划启用该 profile） | `unverified` |
| RF-10 | profile | precision（float32 / float16 / int8）声明与一致 | probe | 声明等于实际；精度变化使 generation 失效 | 拟 blocking | `unverified` |
| RF-11 | lifecycle | batch 上限与批内顺序对齐 | scripted-fake | 超批被拒绝或有界切分；返回顺序与输入可对齐 | 拟 blocking | 参数化 |
| RF-12 | numeric | 空输入 | scripted-fake | `vectors = []` 且 `dim` 明确，状态 `ok` | 拟 blocking | 参数化 |
| RF-13 | numeric | 有限浮点 | scripted-fake | 全部向量 `Number.isFinite` | 拟 blocking | 参数化 |
| RF-14 | numeric | NaN / Infinity | scripted-fake | 整批 `invalid_response`；不得部分接受 | 拟 blocking | 参数化 |
| RF-15 | lifecycle | timeout | scripted-fake | `timeout`；部分结果丢弃；有界返回 | 拟 blocking | 参数化 |
| RF-16 | lifecycle | cancellation | scripted-fake | `cancelled`（区别于 timeout）；无残留后台计算 | 拟 blocking | 参数化 |
| RF-17 | lifecycle | retry 语义 | scripted-fake | 只读重试、有上界与退避；不产生重复副作用；`maxRequestsPerOperation` 生效 | 拟 blocking | 重试参数 `unverified` |
| RF-18 | protocol | malformed response | scripted-fake | `invalid_response`；无「修补后接受」 | 拟 blocking | 参数化 |
| RF-19 | protocol | error response（4xx/5xx / 配额 / 限流） | scripted-fake | 映射到 `provider_unavailable` 或 `invalid_response`，并区分限流 | 拟 blocking | 参数化 |
| RF-20 | observability | provider 日志不泄漏（D0/D1/D2/D3/D5） | inspection | 日志形态扫描命中数 = 0；只出现允许清单字段 | 拟 blocking | 参数化 |
| RF-21 | policy | privacy policy（可发送数据类别） | inspection | 与 `08` §2 的分类一致；D0/D1/D4 命中 = 0 | 拟 blocking | 参数化 |
| RF-22 | policy | data egress（授权引用、记录、撤销） | inspection + scripted-fake | 无授权 → `denied` 且零请求；有授权 → `EgressRecordV1` 完整 | 拟 blocking | 参数化 |
| RF-23 | policy | capability policy（分支启用 / 远程开关） | inspection | `remoteAllowed=false` 时零请求；provider 不能自行打开 | 拟 blocking | 参数化 |
| RF-24 | observability | latency（p50 / p95） | measurement | 记录分位数与样本量；不设阈值（基线后预注册） | 拟非 blocking | 参数化 |
| RF-25 | observability | cost metadata | measurement | `CostMetadataV1` 或 `notProvided = true`；无账户信息 | 拟非 blocking | 参数化 |
| RF-26 | lifecycle | generation 失效联动 | scripted-fake | 改动模型 / 维度 / 前缀 / 预处理 / chunker 任一 → `generation_mismatch` + 重建信号 | 拟 blocking | 参数化 |

## 4. 「HTTP 200 ≠ ready」的正例说明

> 下表是**规则**（判定应落到哪个状态），不是已定事实；其中涉及模型属性的项在 `BL-02` 解决前均为 `unverified`（`RD-4` / `RD-9`）。

| 现象 | readiness 判定 | 对应共享状态（`01` §3.3） |
| --- | --- | --- |
| 200 + 正确维度 + 有限向量 + 前缀正确 + 无泄漏 | 可以进入 `ready` 判定（仍需全部已裁定 blocking 的 fixture 通过） | `ok` |
| 200 + 维度错误 | `unavailable` | 原生层 `wrong_dimension`；pack 层 `invalid_response` + `cg-wrong-dimension`（`09` §3.2.2）；评测需在原生层统计（`02` WD-5） |
| 200 + 前缀缺失 | `unsupported`（前缀属于模型契约，**待调研产物确认**） | `provider_unavailable` + `retrieval-provider-protocol-mismatch` |
| 200 + 含 NaN | `unavailable` | `invalid_response` |
| 200 + 返回伪造的 embedding id / 无 model id | `unverified`（无法确认模型身份） | —（无状态，属未知，不得当作 `ok`） |
| 401 / 403 | `unavailable`（凭据或授权问题；不重试） | `provider_unavailable` |
| 429 | `degraded`（有限流时可用），并在 snapshot 记录限流参数（**待确认**） | `ok`（带 coverage 缺口）或 `provider_unavailable`，需裁定 |
| 可达但日志写出查询正文 | `unsupported`（隐私不满足），无论其它检查是否通过 | `provider_unavailable`（策略拒绝前的阻断） |
| 端点不可达 / 连接失败 | `unavailable` | `provider_unavailable` |
| 端点响应超过 deadline | `unavailable` | `timeout` + `retrieval-deadline-exceeded`（**不得**记 `cancelled`） |
| 运行被调用方中止 | `unavailable` | `cancelled` + `retrieval-cancelled-by-caller`（**不得**记 `timeout`） |

规则：readiness 结果的状态与判定词的对应关系在 `R-BL-10` 裁定前只作为提案；`readinessVerdict` 与评测候选 verdict / harness verdict **不得**混用（`09` §1 的命名隔离）。

## 5. 评测绑定

> 命名空间：本文用 `RDB-*`（readiness binding）；重建编排用 `03` §6 的 `RB-*`；重建信号用 `06` §4 的 `RS-*`。

每次 readiness 运行必须绑定（`04-evaluation-controller` §4.1 / §5）：

```text
evaluationRunId, caseSetHash, fixtureHash, candidateSha(tree-hash), dirtyWriteSet,
providerCapabilitySnapshot, seed, gold/negative labels（readiness 无 gold 时写 noGold=true + 理由）,
label source / annotator / blind-review rule, stopping condition
```

| 规则 | 内容 |
| --- | --- |
| RDB-1 | readiness 结果是 `unverified` 时，`stopRules` 必须触发 `mark_unverified`，不得继续评估 semantic 质量。 |
| RDB-2 | readiness 与质量评测分开：readiness 通过不构成质量通过（`01` §27.6：readiness ≠ quality）。 |
| RDB-3 | 运行前后必须重算候选与 fixture hash（`04-evaluation-controller` HV-4）。 |

## 6. 日志与报告禁止项（复核 `08` §4）

禁止写入：API key、Bearer token、原始敏感文本、secret 值、不必要的源码正文、未授权路径列表、完整 transcript、endpoint 明文。

允许写入：`providerId`、`protocol`、`modelId`、`semanticGeneration`、`dim`、`precision`、批大小、计数、延迟、错误码、hash、逻辑 id。

## 7. 不变量汇总

| ID | 不变量 |
| --- | --- |
| RF-I1 | 200 不等于 ready |
| RF-I2 | 缺调研产物时只允许 `unverified`，不得填期望值 |
| RF-I3 | ready 需要独立 probe + 全部 blocking fixture 通过 |
| RF-I4 | 无授权时零外发（含 readiness 自身） |
| RF-I5 | readiness 结果不改变产品状态 |
| RF-I6 | 每个 fixture 有阴性对照，避免「恒失败」也通过 |
| RF-I7 | 日志形态扫描命中数必须为 0 |

## 8. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| RF-R1 | RF-09 的 profile 集合是否需要扩展到 `unverified` 之外（例如同时声明「不支持」） |
| RF-R2 | RF-17 的重试上界与退避的具体来源（本地策略 vs provider 声明） |
| RF-R3 | RF-24 / RF-25 是否必须 blocking（本文按非 blocking 处理，基线测量后决定） |
| RF-R4 | readiness fixture 是否需要覆盖「同一 endpoint 多模型」与「模型热切换」 |
| RF-R5 | 评测平面 readiness 与 runtime capability probe 是否共用同一 fixture 定义（本文按「共用定义、不同平面」处理） |
