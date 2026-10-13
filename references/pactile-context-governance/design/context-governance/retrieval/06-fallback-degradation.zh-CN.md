# Fallback 与降级披露（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。不实现 fallback 逻辑，不调用 provider。
- 状态引用：本文使用共享类型 `FactStatusV1`（`01` §3.3 / `09` §3）；层级折叠与 `timeout` / `cancelled` 判定见 `02` §3.3 / §3.4。
- 依据：架构 §27.5、§27.7、§27.8；`01-contract-draft` §4.3（PK-1…PK-6）、§3.3（状态）；`03-stage-plan` U-9（无 silent success）、§1.2（零容忍）；`01` / `02` / `04` / `05` / `03` 本文各节。
- 目标：任何 provider 故障都必须落在确定的出口上，并让 pack 的消费方能看见「为什么少、少了什么、是否需要重建、结果是否仍可信」。

## 1. 基本原则

| 原则 | 内容 |
| --- | --- |
| FB-1 | semantic 不可用时，**exact + structural（+ lexical / relation）必须始终可用**；它们是检索的确定性下限。 |
| FB-2 | fallback 不是成功：降级必须改变 `outcome` 与 `coverage`，并在 `fallback` 段披露。 |
| FB-3 | 任何失败都不得变成「空结果」或「0 分候选」；必须是可区分的状态。 |
| FB-4 | 「未启用」≠「降级」：分支未进入 plan 时不产生 fallback 记录，也不计入降级率分母。 |
| FB-5 | 降级路径不改变确定性分支的算法：exact / structural 的结果不受 semantic 状态影响（保证 `RET-A0` 基线可比）。 |
| FB-6 | 降级不触发任何产品状态变化、不写 receipt、不改变 Kernel 事实。 |

## 2. 触发类型与出口

| 触发 | 状态（共享 `FactStatusV1`） | reason.code | semantic 分支 | 是否 fallback | 是否需重建 | pack 影响 |
| --- | --- | --- | --- | --- | --- | --- |
| provider 未配置（计划未启用） | — | — | 不存在 | 否 | 否 | 无（coverage 无该分支；`02` §3.5 已移除 `retrieval-not-configured`） |
| `provider_unavailable` | `provider_unavailable` | `retrieval-provider-unavailable` | 丢弃全部候选 | 是 | 否（先探测恢复） | `pack_degraded`，`fallback.from=["semantic"]` |
| `unsupported`（协议 / 前缀不支持） | `provider_unavailable` | `retrieval-provider-protocol-mismatch` | 丢弃 | 是 | 视情况 | `pack_degraded` |
| `timeout`（分支 / operation / Inspect deadline 到期） | `timeout` | `retrieval-deadline-exceeded` | 丢弃部分结果 | 是 | 否 | `pack_degraded` |
| `cancelled`（调用方 / operation 取消） | `cancelled` | `retrieval-cancelled-by-caller` / `retrieval-cancelled-by-operation` | 丢弃 | 是（若 operation 继续） | 否 | `pack_degraded` 或 `pack_blocked`（operation 已取消） |
| `epoch_fenced`（旧 Attempt / 旧 epoch） | `cancelled` | `retrieval-epoch-fenced` | 丢弃 | — | 否 | 不得进入当前 operation 输出（`02` §3.4 TC-6） |
| `invalid_response` | `invalid_response` | `retrieval-binary-or-undecodable` 等 | 整批丢弃 | 是 | 否 | `pack_degraded` |
| `wrong_dimension` | 原生层（`PCS` / `RC` / `RP` / `OBS` / `ERM` / `PCR`）`wrong_dimension`；pack 层折叠为 `invalid_response` | `cg-wrong-dimension`（共享折叠码） | 整批丢弃 | 是 | **是**（generation 必须重建） | `pack_degraded` + 重建标记；**不得**当作低分 / 普通 degraded / “provider 没结果”（`02` §3.3 WD-6） |
| `generation_mismatch` | `generation_mismatch`（RK 可表达） | `retrieval-generation-mismatch` | 丢弃候选 | 是 | **是或否**（见 `03` §2 表） | `pack_degraded` + stale 标记 |
| `index_unavailable` | `provider_unavailable` | `retrieval-index-unavailable` | 丢弃 | 是 | 否（需显式重建请求） | `pack_degraded`；不得隐式重建（`03` IX-5/IX-6） |
| `egress_denied` | `permission_denied` | `retrieval-egress-denied` | 不发起请求 | 是 | 否 | `pack_degraded`；外发违规数在请求前计数 |
| `stale`（source revision / 分支切换） | `stale` | `retrieval-source-stale` | 丢弃受影响候选 | 是 | 视情况（`source_snapshot` 触发需重建） | `pack_degraded` |
| 预算截断（未完成 / 未启动 / early stop） | `cancelled` | `retrieval-budget-exhausted` / `retrieval-early-stopped` | 截断 | 是 | 否 | `pack_degraded`；**不得**记 `timeout`（`02` §3.4 TC-3） |
| 全部 authoritative 分支失败 | — | — | — | 是 | — | `pack_blocked` |

## 3. fallback 披露字段

`RetrievalPackV1`（`01` §4.3 + `02` §4.3）必须包含：

```json
{
  "fallback": { "used": true, "from": ["semantic"], "reasons": [{ "code": "retrieval-provider-unavailable", "detailHash": "sha256:<pending>" }] },
  "coverage": [
    { "branch": "semantic", "mode": "shadow", "status": "provider_unavailable", "reason": { "code": "retrieval-provider-unavailable", "detailHash": null },
      "requested": 0, "returned": 0, "deadlineMs": 0, "elapsedMs": 0, "shardsSearched": null, "shardsTotal": null }
  ]
}
```

除 `fallback` 外，消费方还必须能看到：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| provider state | `coverage[].status` + `capabilitySnapshot` | 本次运行观察到的可用性 |
| generation | `coverage[].status = generation_mismatch` 时 + pack `generation` | 期望与实际 generation |
| candidate count | `coverage[].requested/returned` | 该分支请求与返回数量 |
| 是否降级 | `outcome ∈ {pack_degraded, pack_blocked}` | 显式枚举，不用隐含判断 |
| 是否需重建 | `coverage[].reason.code ∈ {retrieval-generation-mismatch, cg-wrong-dimension, retrieval-index-unavailable}` | 需重建时由已登记码表达，不另立字段 |
| 是否进入 unverified | `coverage[].status` 与评测层 `unverified` 判定 | 评测平面单独表达（见 §5） |
| 预算消耗 | `budget.used*` | 截断与耗时 |
| 剩余不确定性 | `coverage[].status = unknown` + `reason.code = retrieval-coverage-incomplete` | 不得用空数组或 0 分表示 |

## 4. 「是否需重建」的表达

> 命名空间：本文用 `RS-*`（重建判定规则）；重建编排规则用 `03` §6 的 `RB-*`；readiness 绑定规则用 `09` §5 的 `RDB-*`。
> **不新增类型**：早期草稿的 `RebuildSignalV1` 已删除；重建语义由 `02` §3.5 的已登记码直接表达（无专用字段）。

| 规则 | 内容 |
| --- | --- |
| RS-1 | 需重建 
由 `coverage[].reason.code` 表达：`retrieval-generation-mismatch`（generation 漂移）/ `cg-wrong-dimension`（维度不符）/ `retrieval-index-unavailable`（索引缺失或 schema 不可读）。 |
| RS-2 | 重建需求只写本地审计与 pack；**不**自动触发重建（`03` IX-6）。 |
| RS-3 | `provider_unavailable` / `timeout` / `invalid_response` 默认**不**要求重建（先探测恢复）。 |
| RS-4 | 原因码必须唯一且来自 `02` §3.5 的封闭枚举；不得只给布尔值或自由文本。 |

## 5. 评测平面的 `unverified` 判定

| 情形 | 评测结果 |
| --- | --- |
| provider 臂不可用（`provider_unavailable` / `unsupported` / 无授权） | 该臂 `unverified`，**不是 0 分**（`01` PCR 规则、`04-evaluation-controller` §9.1） |
| 覆盖率不足导致 `insufficient_coverage` | 该用例 `unverified`（不得计入「正确 abstain」） |
| generation fence 违规 | 零容忍计数 +1（不因 arm 不可用而豁免） |
| 外发违规 | 零容忍计数 +1 |
| `RET-A0` 基线臂失败 | run `invalid`（基线不可比，结果不得用于放权） |

## 6. 降级路径的确定性

| 规则 | 内容 |
| --- | --- |
| DF-1 | fallback 后的 pack 必须在相同输入下可复算（同 `packHash`），provider 状态同类时结果同类。 |
| DF-2 | provider 恢复后，同一 generation 的候选可以重新参与；但必须重新 Inspect。 |
| DF-3 | 不得为了「结果看起来更完整」而把 shadow 分支候选提升为 authoritative；提升必须是新 plan（新 `planId`）。 |
| DF-4 | 降级不得改变 `abstain` 的判定方向：有失败分支时只能更保守（`insufficient_coverage`），不能更激进。 |
| DF-5 | `pack_degraded` 的 pack 仍然可以进入下游 ContextUnit 构建，但必须携带降级标记；下游不得据此声明「无匹配」。 |

## 7. 与 ProviderCapabilitySnapshot 的关系

| 规则 | 内容 |
| --- | --- |
| PS-1 | snapshot 的 `availability` 观测与运行结果必须一致（若 snapshot 说 `ready` 而运行时 `provider_unavailable`，必须记录差异——这是能力漂移证据）。 |
| PS-2 | snapshot 捕获时间与运行时间的差距必须记录；超过 profile 指定 TTL 时该 snapshot 判 `stale`。 |
| PS-3 | 同一 operation 内不得重新捕获 snapshot（保持可复算）；需要重新捕获时必须新 operation。 |

## 8. 不变量汇总

| ID | 不变量 |
| --- | --- |
| FB-I1 | exact + structural 在 semantic 故障时仍然可用且结果不变 |
| FB-I2 | 降级必须改变 `outcome` 并出现在 `fallback` / `coverage` |
| FB-I3 | 失败不转 0 分、不转空结果、不转「无匹配」 |
| FB-I4 | 「未启用」不计入降级 |
| FB-I5 | 重建信号显式、不自动执行 |
| FB-I6 | provider 不可用臂在评测中为 `unverified` |
| FB-I7 | 降级只使 abstain 更保守 |
| FB-I8 | `wrong_dimension` 在原生层（PCS / RC / RP / OBS / ERM / PCR）原样保留；pack 层必须按 `09` §3.2.2 折叠为 `invalid_response` + `cg-wrong-dimension`（`02` §3.3） |
| FB-I9 | 预算截断 / early stop 归 `cancelled`，deadline 到期归 `timeout`；不得互换（`02` §3.4） |
| FB-I10 | 原生层状态与 pack 层折叠必须在同一结果集中可区分：`04` §9.2 的 `observed.status` 写原生层；pack 内用 `reason.code = cg-wrong-dimension`（`02` WD-5） |

## 9. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 |
| --- | --- |
| FB-R1 | 「provider 恢复探测」的频率与它是否算一次独立 context operation |
| FB-R2 | snapshot TTL 的来源（配置文件 / plan / provider profile） |
| FB-R3 | `pack_degraded` 是否允许下游 Agent 继续（本文按「允许，但必须披露」处理） |
| FB-R4 | 存在 `wrong_dimension` 但本地无重建能力时的处置 | Retrieval | **已定**：不新增「待重建」状态；保持原生层 `wrong_dimension` + pack 层 `cg-wrong-dimension`，重建标记由 `RS-1` 表达 |
