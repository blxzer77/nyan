# 检索评测矩阵（proposed）

- 状态：`proposed`；**P0_REVIEW_BLOCKED**（见 `12-blockers-unverified.zh-CN.md` §1）。**不运行任何评测**；本文件只冻结 fixture 类别、绑定字段、指标口径、对照臂与停止条件。
- 依据：架构 §24 / §24.1、§27.8；`../implementation/04-evaluation-controller`（EC / ERM / PCR、FI-01…FI-27、KB-1…KB-7、HV-1…HV-6、§8 指标目录、§9 双层 verdict）；`../implementation/03-stage-plan`（U-1…U-12、零容忍计数器）；`02` / `04` / `05` / `06` / `07` / `08` / `09`。
- 编号所有权：**FI / KB 编号由 `implementation/04` §6 / §7.1 统一拥有**；本文件只做映射与 subcase 标注，**不得新增全局 FI / KB 编号**（见 §5 `FR-5` / `FR-6`）。
- 规则：本文件**不设质量阈值**。阈值只能在阶段 1a 基线测量后、治疗臂运行前，预注册到 `EvaluationRunManifest`。零容忍项是规则，不是阈值。

## 1. fixture 类别（封闭枚举）

| 代码 | 类别 | 目的 | fixture 形态 | gold / labels | 期望状态 | 独立分母 |
| --- | --- | --- | --- | --- | --- | --- |
| FQ-01 | code-query | 基础代码查询定位 | 冻结 repo 快照 + 自然语言查询 | gold 文件 / 符号 / 行（core、optional）+ negative | 正常 pack（`pack_ready` 或 `pack_degraded`） | 是（主集） |
| FQ-02 | zh-to-en-impl | 中文描述 → 英文实现 | 中文查询 + 英文标识符代码 | 同上 | 同上 | 是 |
| FQ-03 | en-to-code | 英文需求 → 代码 | 英文查询 + 代码 | 同上 | 同上 | 是 |
| FQ-04 | comment-to-impl | 注释 → 实现 | 注释文本作为查询 | 实现位置为 gold | 同上 | 是 |
| FQ-05 | behavior-to-code | 行为描述 → 函数 | 行为句 + 目标函数 | 函数为 gold | 同上 | 是 |
| FQ-06 | cross-file | 跨文件关系 | 多文件 fixture | 文件集合为 gold（可选顺序约束） | 同上 | 是 |
| FQ-07 | callers-callees | 调用关系 | 定义 + 调用点 | 调用点集合为 gold | 同上 | 是 |
| FQ-08 | impact | 变更影响面 | 目标符号 | 受影响符号集合为 gold | 同上 | 是 |
| FQ-09 | no-gold | 无答案查询 | natural + counterfactual 两组 | `noGold = true` + 理由；gold 为空 | 全部 authoritative 分支 ok 且零命中 → `pack_empty_observed` + `abstain.decided` | **独立**（不混入 Recall 分母） |
| FQ-10 | wrong-repository | 指向别的仓库 / worktree | 查询或 pointer 指向另一 fixture | negative：不得返回本仓库内容 | `revision_mismatch` / `permission_denied` | **独立** |
| FQ-11 | deleted-renamed | 删除 / 重命名 | 运行前后改变文件的 fixture | gold 指向 base 快照 canonical path | `missing` / `stale` | 是 |
| FQ-12 | branch-switch | 分支切换 | 切换分支后重跑 | gold 按分支区分 | `revision_mismatch`；旧 generation 失效 | 是 |
| FQ-13 | stale-index | 索引过期 | 索引 generation 落后于工作树 | gold 与工作树一致 | `stale` / `revision_mismatch`（FI-08）；**不属** FI-01 / FI-27（见 §5 `FR-7`） | 是 |
| FQ-14 | generation-mismatch | generation 不符 | 候选 / 索引带旧 generation，**source revision 未变** | — | `generation_mismatch` 且不得进入 `items`（FI-27） | 是（零容忍关联） |
| FQ-15 | provider-failure | provider 不可用 | fake provider 连接失败 | — | `provider_unavailable` + fallback | 是（降级率分母） |
| FQ-16 | wrong-dimension | 维度不符 | fake provider 返回错误维度 | — | **两层**：原生层（RC / PCS / OBS / ERM / PCR）`wrong_dimension`；pack 层 `invalid_response` + `reason.code = "cg-wrong-dimension"`（`09` §3.2.2、`01` PK-7、`02` §3.3）；整批丢弃 | 是（零容忍关联） |
| FQ-17 | timeout | 时间真的耗尽 | fake provider 缓慢 / 超 deadline | — | `timeout` + `retrieval-deadline-exceeded`；部分结果丢弃 | 是 |
| FQ-18 | cancelled | 被取消 / 被停止 | 调用方 / operation abort；另分预算与 early stop 子例 | — | `cancelled`（与 `timeout` 可区分）；预算 / early stop **不得**记 `timeout`（`02` §3.4） | 是 |
| FQ-19 | privacy-denial | 外发被拒 | 无授权 / 越权路径 / 含凭据形态 | negative：不得外发 | `permission_denied`；外发违规 = 0 | 是（零容忍关联） |
| FQ-20 | external-sfe | Search → Fetch → Evidence | fake search + fake fetch（脚本化） | gold：可引用页面 + 不可引用页面 | 只有 Fetch→Evidence 后可引用；`search_hit` 不入 `items` | 是 |
| FQ-21 | semantic-false-positive | 相似但无关 | 高相似度、低相关性样本 | negative：不得进入 core gold | 候选可以返回，但不得被声明为事实；Inspect 后仍应排在低位或进 `rejected` | 是（precision / F0.5 分母） |
| FQ-22 | exact-structural-fallback | 确定性兜底 | semantic 关闭或不可用 | 与 `RET-A0` 相同 | exact + structural 结果必须与 `RET-A0` 一致（`bodyHash` 可比） | 是 |
| FQ-23 | abi-ref-unconvertible | ABI ref 表达不了 | 路径含大写 / 非 ASCII / 超长 / 敏感词；pointer 带 range | gold = 保留原 pointer 并进 `rejected` | `unconvertible`（**不折叠**）；原始 pointer 原样（`04` §8、`09` §3.2.2） | 是（独立分母，配合 `FI-20.1`） |

跨类别检查：

| 代码 | 检查 | 目的 |
| --- | --- | --- |
| CX-01 | determinism | 同输入、同 `policyVersion`、同 seed、≥3 次独立进程 → `packHash` / `bodyHash` 一致（AC-1a.2） |
| CX-02 | isolation | 评测 / 产品平面隔离（EV-ISO-1…8、U-7） |
| CX-03 | no-silent-success | 所有降级 / 截断 / 跳过均可在 pack 中看到（U-9） |

## 2. 每个 fixture 的绑定字段（必填）

```text
evaluationRunId        本次运行 id（"evr-<yyyymmddhhmmss>-<slug>" 提案）
caseSetHash          有序 case bodyHash 列表的 hash
fixtureHash          被引用 fixture 条目 canonical 列表的 hash
candidateSha         CandidateRefV1（tree-hash；不得伪造 Git commit）
dirtyWriteSet        DirtyEntryV1[]（正常应为空）
providerCapabilitySnapshot  SnapshotRefV1（fake provider 也必须记录）
seed                 固定随机性；臂间一致
gold / negative labels      core / optional / negative，含 locator（SourcePointerV1）
label source         标注来源（人工 / 独立工具 / 由谁标注）
annotator            标注者标识（不含身份凭据）
blind-review rule    至少一次不看候选输出的标注或复核；记录 blind 布尔
stopping condition   见 §6
```

| 规则 | 内容 |
| --- | --- |
| BD-1 | gold 必须先于任何搜索运行冻结并记录 sha256（U-1）；修订只产生新 `caseSetHash`。 |
| BD-2 | `labelProvenance.independentOfCandidateAuthor = "unknown"` 的用例不得用于放权结论（`BL-12`）。 |
| BD-3 | no-gold 与 wrong-repository 的分母与正样本分离（`01` §4.11 规则）。 |
| BD-4 | 失败样本保留在分母中并计为未命中；不得因失败剔除（U-3 / 旧 harness 教训）。 |
| BD-5 | `fixtureHash` 前后不一致 → run `blocked`（除非 ERM 预注册了该场景的「变异前后 hash 对」，见 HV-4 与 FI-13）。 |
| BD-6 | 每个 fixture 必须绑定至少一条故障注入 id（§5）或显式声明 `faults: []` 并说明原因。 |

## 3. 指标口径

| 指标 | 定义 | 分母 | 备注 |
| --- | --- | --- | --- |
| Recall@1 / @5 / @20 | 命中 gold（core 或 core+optional，按预注册口径）在 top-k `items` 内的比例 | 正样本用例数 | 按类别与仓库分别报告 |
| MRR | 第一个命中 gold 的排名倒数均值 | 正样本用例数 | 无命中记 0（保留在分母） |
| precision | top-k 中命中 gold 的比例 | top-k 候选数 | 需同时报告 `k` |
| F0.5 | 以 precision 为重的调和平均 | 同上 | 逐用例计算后取均值，或按总量计算——必须预注册选择 |
| file coverage | 命中 gold 文件集合的覆盖率 | gold 文件数 | — |
| symbol coverage | 命中 gold 符号集合的覆盖率 | gold 符号数 | 无 symbol 语言的用例单列 |
| line / region coverage | 命中 gold 行范围的覆盖率 | gold 行范围数 | `lineMapping` 生效时按映射计算 |
| p50 / p95 延迟 | 端到端与每分支分别报告 | 用例数 × 分支数 | 不计公网模型延迟入 Host SLO（§24.1） |
| candidate bytes / tokens | 每 pack 的候选字节 / token 估算分布 | pack 数 | tokenizer 来源记入 snapshot |
| Inspect 后有效率 | `items` 中 `inspect.status = ok` 比例；`rejected` 按状态分布 | `items` + `rejected` 总数 | 关键安全指标；`rejected` 按**折叠后**实体层状态分布，并单列折叠前原始状态（§3.5） |
| 正确 abstain | `pack_empty_observed` 且全部 authoritative 分支 ok 且 gold 为空 | no-gold 用例数 | **独立分母** |
| 错误 abstain | gold 非空但 abstain | 正样本用例数 | 必须单列 |
| 错误返回 | no-gold 却返回 `items` | no-gold 用例数 | 与「错误 abstain」成对报告 |
| generation fence 违规数 | 旧 generation 候选进入 `items` 的次数 | — | **零容忍** |
| fallback 触发率 | `fallback.used = true` 的 pack 比例 + 原因分布 | 启用 semantic 分支的用例数 | 「未启用」不计入分母 |
| provider error 分类 | 按 **原始 provider 状态** 分类计数（timeout / invalid_response / provider_unavailable / wrong_dimension / cancelled…） | 启用 provider 的用例数 | 分类不得合并；`timeout` 与 `cancelled` 必须分列（§3.5） |
| fold 计数 | 发生 `09` §3.2.2 授权折叠（`wrong_dimension` → `invalid_response`）的次数，按 `coverage` / `rejected` 与 `cg-wrong-dimension` 分组 | `rejected` + `coverage` 条目数 | 零容忍关联：漏报折叠 = harness 缺陷 |
| 外发违规数 | 未授权外发次数 | — | **零容忍** |
| Fetch reduction | 相比「Fetch 全部 SearchHit」，实际 Fetch 数的减少比例 | SearchHit 总数 | 只对 FQ-20 |
| citation coverage | 有完整 `citationPointer`（URL + responseHash + rangeHash）的引用比例 | 引用总数 | 缺一即不计入 |

| 规则 | 内容 |
| --- | --- |
| MT-1 | 每个指标必须带分母与口径说明；分母为 0 时写 `unverified`，不写 `pass`。 |
| `MT-2` | `unconvertible` 比率、`unknown` 比率、`coverage[].status = unknown` 数量与 `gaps[]` 条目数必须单独报告（揭示 ABI 与覆盖缺口） |
| MT-3 | 不使用加权综合分（旧 40/30/25/5 方案不沿用）。 |
| MT-4 | 主指标必须预注册；次要指标不得用于改写结论。 |
| MT-5 | 真实 provider 与 fake provider 的测量不得混合报告。 |
| MT-6 | 禁止使用加权综合分；旧 40/30/25/5 方案不沿用（与 `MT-3` 一致）。 |

### 3.5 状态层级与 verdict（唯一表达方式）

**不再新立 `rawStatus` / `entityStatus` / `fold` 三字段**：`04` §9.2 的 `results.jsonl` 只有一个 `observed.status`，它就是唯一的状态字段。层级区分按下表：

| 层 | 唯一字段 | 取值 | 规则 |
| --- | --- | --- | --- |
| 原生层 | `observed.status`（`04` §9.2） | provider / Inspect 返回的共享状态（`01` §3.3） | 不得写折叠后的值；`wrong_dimension` 在这一层必须原样保留（`01` PK-8：逐项分布在 `ERM` / `PCR`） |
| pack 层 | `RK.coverage[].status` / `rejected[].status` + `reason`（`01` §4.3） | 受 `09` §3.1 约束；`wrong_dimension` 折叠为 `invalid_response` + `reason.code = cg-wrong-dimension` + 非空 `reason.detailHash` | 不新增包装字段；`02` §3.3 WD-3 是唯一折叠规则 |
| verdict | `candidateVerdict` / `harnessVerdict`（`04` §9.1） | `pass/fail/blocked/unverified` · `valid/invalid/blocked` | 两者独立；`harnessVerdict ≠ valid` ⇒ `candidateVerdict = unverified` |

```text
示例（FQ-16 / FI-02）——只有三个字段，无第四层：
  results.jsonl 行：observed.status = "wrong_dimension"        // 原生层，禁止改写
  pack 内 coverage 条目：status = "invalid_response"            // pack 层折叠
                         reason = { code: "cg-wrong-dimension", detailHash: "<非空>" }
```

| 规则 | 内容 |
| --- | --- |
| TL-1 | 禁止只写原生层或只写 pack 层：结果行缺 `observed.status`，或 pack 折叠缺少 `reason.code` / `detailHash`，均为 harness 缺陷（`harnessVerdict = invalid`）。 |
| TL-2 | `candidateVerdict` **不得**由状态名称推导：`wrong_dimension` / `timeout` 不等于自动 `fail` 或 `unverified`——判据必须预写在 EC / ERM 里。 |
| TL-3 | `timeout` 与 `cancelled` 必须在原生层分列统计（`02` §3.4 TC-1）；两者均**不折叠**。 |
| TL-4 | 已移除的 reason.code（`02` §3.5）出现即 `harnessVerdict = invalid`。 |
| TL-5 | `wrong_dimension` 被记为低分候选、普通 `degraded` 或「provider 无结果」时，本用例计 `fail`，并计入零容忍判定（`02` WD-6）。 |
| TL-6 | 本节的字段集以 `04` §9.2 + `01` §4.3 为权威，检索线**不再提出**新字段；早期版本的 `rawStatus` / `entityStatus` / `fold` / `StatusFoldV1` 提案已删除（`02` §8 SY-3）。 |

## 4. 对照臂（命名空间 `RET-*`，定义已闭合）

臂定义与编号的**唯一权威** = `implementation/04-evaluation-controller` §10（CF-25）。

| 臂 | 组成 | 用途 |
| --- | --- | --- |
| **`RET-A0`** | exact + structural（阶段 1a 实际范围 = 这两条；`03-stage-plan` 阶段 1a「目标」行） | 确定性基线；与 `RET-A1` / `RET-A2` 共用同一 fixture、预算、请求顺序 |
| **`RET-A1`** | `RET-A0` + semantic（阶段 2 起为 `shadow`） | 语义增益消融 |
| **`RET-A2`** | Jev plan shadow + exact + structural（**semantic 关闭**） | Jev 规划增益消融 |
| **`RET-A3`**（可选） | `RET-A1` + Jev | 联合效果；非默认（即旧提案 `A2 = A1 + Jev` 的归属） |

| 规则 | 内容 |
| --- | --- |
| AR-1 | `RET-A2` 的唯一定义 = **Jev plan shadow + exact + structural（semantic 关闭）**（来源：`04` §10 CF-25）。旧提案 “A2 = A1 + Jev” **已降级为 `RET-A3`**，在本线文档中不得再以 `A2` 名称出现。 |
| AR-1b | 跨线引用必须带 `RET-` / `CMP-` 前缀（`04` §10）；不带限定词的 “A0–A5” 不得出现在检索线文档与 ERM / EC 里。 |
| AR-1c | 压缩线臂命名为 `CMP-A0…CMP-A5`（`04` §10），与本节无重叠；两线臂编号不得混用。 |
| AR-2 | 臂间差异必须只来自被测能力：fixture、预算、请求顺序、seed、provider snapshot 记录必须一致。 |
| AR-3 | `shadow` 臂的候选不得进入 authoritative `items`；`RET-A1` 的 pack `items` 在 shadow 阶段应与 `RET-A0` 一致（差异只在 coverage / 评测记录）。若不一致，必须归因。 |
| AR-4 | 配对键 `caseId + seed`；排除项逐个列理由；排除比例过高 → `unverified`。 |
| AR-5 | `RET-A0` 臂失败 → run `invalid`（基线不可比）。 |
| AR-6 | 四类组成各自可复现：exact+structural（`RET-A0`）、+semantic（`RET-A1`）、Jev shadow+exact+structural（`RET-A2`）、`RET-A1`+Jev（`RET-A3`）。 |

## 5. 故障注入映射（不新增全局 FI 编号）

沿用 `04-evaluation-controller` §6 的 FI 目录；本文件只做映射与 **subcase** 标注。

| fixture | 主要 FI / subcase | 注 |
| --- | --- | --- |
| FQ-11 deleted-renamed | FI-20 | — |
| FQ-12 branch-switch | FI-21 | — |
| FQ-13 stale-index | FI-08（`stale` / `revision_mismatch`；索引落后于工作树） | **不得**映射到 FI-01：FI-01 = `generation_mismatch`（静态旧 generation），`stale` 仅属 FI-08（`04` §6 FI-01/FI-08 行、CF-22） |
| FQ-14 generation-mismatch | FI-01（静态：引用已过期但仍存在的 generation）/ FI-27（运行中漂移） | 两者预期均为 `generation_mismatch`（CF-22）；**与 FQ-13 分母分离** |
| FQ-15 provider-failure | FI-03 / FI-04 | — |
| FQ-16 wrong-dimension | **FI-02**（原生层 = `wrong_dimension`；pack 层 = `invalid_response` + `cg-wrong-dimension`）；另加阴性对照（维度正确 → 无折叠） | `04` FI-02 行已同步为两层预期（CF-21 已闭合）；本线同步见 `02` §3.3 |
| FQ-17 timeout | FI-03（**仅 deadline**） | — |
| FQ-18 cancelled | FI-25（abort，与 deadline 可区分）；预算耗尽与 early stop 作为同一 FI 的附加场景（预期仍为 `cancelled`，reason 不同）；另用 FI-03 作 deadline 对照 | 预算 / early stop **不得**记 `timeout`（`02` §3.4） |
| FQ-19 privacy-denial | FI-22 + FI-18 | — |
| FQ-20 external-sfe | FI-04 / FI-05（外部 provider 失败） | — |
| FQ-22 exact-structural-fallback | FI-04 | — |
| FQ-23 abi-ref-unconvertible | **FI-20.1**（`04` §6 已登记为 `FI-20` 的子用例；**不是**新全局编号） | 子用例内部场景：大写路径 / 非 ASCII / 带 range / 超长 >256 / 敏感词段 / 需 worktreeId；另加阴性对照（纯小写 ASCII 且无 range → 必须 `ok`）。`R-BL-14` 已闭合（宿主 = `FI-20.1`） |
| CX-01 determinism | 无（重复运行） | — |
| CX-02 isolation | FI-15 | — |
| CX-03 no-silent-success | FI-24（融合输入缺分支）+ 所有降级用例 | — |
| 全部类别 | FI-26（fixture hash：区分「场景内合法变异」与「fixture 漂移」，回应 BL-23） | — |
| 阳性对照 | KB-1…KB-7（`04` §7.1） | 「静默改写 pointer 以凑语法」类阳性对照的 KB 编号由 `04` §7.1 分配（本线提案，未编号） |

| 规则 | 内容 |
| --- | --- |
| FR-1 | 每个故障至少一条正向用例 + 一条阴性对照（`04` §6 末段）。 |
| FR-2 | 注入生效性必须被断言（旧 harness 的教训：窗口先于重置、端点拼错、空真断言）；无法证明生效的样本记 `INCONCLUSIVE`，绝不记 pass。 |
| FR-3 | `INCONCLUSIVE` 计入零容忍判定：任一 `INCONCLUSIVE` → 该 run 不得为 `pass`（沿用旧评测边界）。 |
| FR-4 | KB 阳性对照必须被判 `fail`；若判 `pass` → `harnessVerdict = blocked`，全部结果 `unverified`（HV-1）。 |
| FR-5 | **FI / KB 编号由 `04-evaluation-controller` §6 / §7.1 统一拥有**；本文件不得新增全局 FI / KB 编号，只做映射。 |
| FR-6 | 需要表达 FI 内部变体时，使用实现线已登记的**子用例**形式（如 `FI-20.1`）；不得自造 `<FI>/<标签>` 写法。 |
| FR-7 | FI-01（`generation_mismatch`，静态旧 generation）与 FI-08（`stale` / `revision_mismatch`）与 FI-27（`generation_mismatch`，运行中漂移）已由 `04` §6 差异化（CF-22）；映射不得互换。 |
| FR-8 | FI-02 的预期状态必须同时写出原生层与 pack 层，不得只写 `invalid_response`（`TL-1`）。 |

## 6. 停止条件（明确归属 harnessVerdict 与 candidateVerdict）

verdict 口径以 `04-evaluation-controller` §9.1 为权威；两者**独立**，不得混写，也不得由一个退出码同时表达。

| 条件 | harnessVerdict | candidateVerdict | 动作 |
| --- | --- | --- | --- |
| candidate pre/post hash 不一致 | `invalid` | `unverified` | `stop` |
| fixture hash 变化（未预注册） | `blocked` | `unverified` | `stop` |
| 零容忍计数器非零 | 取决于 harness 自身是否有效；有效则 `valid` | `fail` | `stop` |
| `RET-A0` 基线臂失败 | `invalid` | `unverified` | `stop` |
| 分母低于预注册最小值 | `valid` | `unverified` | `mark_unverified` |
| readiness 未通过（阶段 2） | `valid` | `unverified` | 不评估 semantic 质量 |
| 外发违规 | `valid` | `fail` | `stop` |
| harness 阳性对照未被判失败 | `blocked` | `unverified` | `stop` |
| 结果行缺原生层状态，或 pack 折叠缺 `reason.code` / `detailHash`（`TL-1`） | `invalid` | `unverified` | 不得出候选结论 |
| 使用已移除的 reason.code（`TL-4`） | `invalid` | `unverified` | 不得出候选结论 |
| 任一 `INCONCLUSIVE` | `valid`（若 harness 无缺陷） | 不得为 `pass`（`FR-3`） | 停止该阶段 |

规则：`harnessVerdict ≠ valid` 时 `candidateVerdict` 一律为 `unverified`（`04` §9.1）；本文件不得单独使用「verdict」而不标明是哪一层。

## 7. 盲审与标注规则

| 规则 | 内容 |
| --- | --- |
| LB-1 | gold 由人工标注或独立工具（如真实 `rg`）产生；**不得**从候选输出反推（旧 harness 教训 4）。 |
| LB-2 | 至少一次盲审（不看候选输出）；记录 `blind: true/false` 与盲审者。 |
| LB-3 | 标注者与候选作者的关系必须记录；`unknown` 不得用于放权结论。 |
| LB-4 | 行范围映射（fixture 修改后）记录为 `lineMapping`；重命名 / 生成文件的 gold 以 base 快照 canonical path 为准。 |
| LB-5 | no-gold 区分 natural（真实无答案）与 counterfactual（构造无答案）；wrong-repository 独立成类。 |
| LB-6 | 标签修订追加式：`revisionHistory` 只增不改。 |

## 8. 阶段门槛与本文的关系

| 阶段 | 使用本文的哪部分 | 额外前置 |
| --- | --- | --- |
| P0 | 冻结 §1 类别、§2 绑定、§3 口径、§6 停止条件（本文） | AC-0.4 / AC-0.5 / AC-0.6 |
| 1a | `RET-A0`、CX-01 / CX-03、FQ-01…FQ-12 | `03-stage-plan` AC-1a.*；`RET-A0` 分支集 = exact + structural（1a「目标」行） |
| 1b | 追加 runtime 平面 crash/replay、epoch fence | `BL-05`（Host 轨道 P1/P2） |
| 2 | `RET-A1`、FQ-13…FQ-19、FQ-21、FQ-22、readiness（`09`） | `BL-02` 或「参数 + unverified」；外发授权 |
| 3 | `RET-A2`（定义已闭合：Jev plan shadow + exact + structural） | 阶段 2 结论 + Jev 测试入口 |
| 5+ | 压缩 / 记忆用例（属 Compression 线） | 不在本文范围 |

注：阶段 1a 的分支集合 = **exact + structural**（唯一权威：`03-stage-plan` 阶段 1a「目标」行）；`lexical` / `relation` 已在 `01` §4.1 / §4.2 的 branch 枚举中登记，但**不属于** 1a 分母；启用它们需修改 1a 范围（`R-BL-07`，Owner = Implementation，触发 = 阶段 1a ERM 冻结前）。

## 9. 不变量汇总

| ID | 不变量 |
| --- | --- |
| EM-1 | 无 pre-run manifest 的运行一律 `unverified` |
| EM-2 | 分母显式；失败样本保留；排除项逐条列理由 |
| EM-3 | gold 先冻结、来源与盲审必填 |
| EM-4 | 指标无阈值（阈值只能预注册） |
| EM-5 | provider 不可用 = `unverified`，不是 0 分 |
| EM-6 | 零容忍项与 `INCONCLUSIVE` 直接决定 `fail` |
| EM-7 | 评测结论不影响产品 Run / Kernel |
| EM-8 | 状态只有两个表达位：`observed.status`（原生层，`04` §9.2）与 pack 层字段（`01` §4.3）；不新增第三套字段（§3.5） |
| EM-9 | `timeout` 与 `cancelled` 分列统计且均不折叠；预算 / early stop 归 `cancelled`（`02` §3.4） |
| EM-10 | FI / KB 编号不由本文件拥有（§5 `FR-5` / `FR-6`） |
| EM-11 | 臂名一律带 `RET-` 前缀；`RET-A2` = Jev plan shadow + exact + structural（§4 `AR-1`） |
| EM-12 | `unconvertible` 的固定样例 = `FI-20.1`；不得引用 `FI-28`（未获批准的提案，`09` §5 #22） |

## 10. 本线开放问题（每条有唯一 owner）

| 编号 | 内容 | Owner | 解除条件 |
| --- | --- | --- | --- |
| EM-R2 | F0.5 的计算口径（逐用例均值 vs 总量） | Retrieval | 阶段 1a ERM 冻结前预注册 |
| EM-R3 | Recall 的 gold 口径（仅 core vs core+optional） | Retrieval | 同上 |
| EM-R4 | 阶段 1a 的 fixture 最小规模与统计功效 | Retrieval | 同上 |
| EM-R5 | `unconvertible` / `unknown` 比率是否成为阶段 1a 阻断项 | Retrieval | 基线测量后预注册（当前按「报告但非阻断」） |
| EM-R6 | FQ-02（中文→英文实现）的 gold 是否需双语标注者 | Retrieval + 标注者 | 标注开始前 |
| EM-R7 | ~~`unconvertible` 宿主 FI~~ | — | **已闭合**：`FI-20.1`（`04` §6） |
| EM-R8 | N-01…N-27 的全局编号 | Implementation | 按 `01` §7 line 740 分配 #29+ |
| EM-R9 | ~~三层字段是否被 `04` §9.2 采纳~~ | — | **已闭合（不新增字段）**：原生层 = `observed.status`，pack 层 = `01` §4.3 字段（`02` §8 SY-3） |
| EM-R1 | ~~A2 定义冲突~~ | — | **已闭合**：`RET-A2` = Jev plan shadow + exact + structural（`04` §10 CF-25）；旧提案降为 `RET-A3` |
