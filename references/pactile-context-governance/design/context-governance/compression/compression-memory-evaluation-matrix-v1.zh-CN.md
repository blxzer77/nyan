# 压缩与记忆评测矩阵 v1（P0 冻结草案，proposed）

- 状态：proposed。本文冻结**桶目录、fixture/label 规范、预注册与停止条件、指标定义、故障注入映射和判定规则**。不创建 fixture，不运行评测，不接真实 Provider / Jev / EmbeddingGemma。
- 依据：架构 §27.8、§24.1；`implementation/04-evaluation-controller.zh-CN.md`（EV-1…7、fixture registry、EC 格式、FI-01…FI-27、HV-1…6、KB-1…7、指标目录、§9 判定）；`implementation/01-contract-draft.zh-CN.md`（EC / ERM / PCR）；`compression-decision-chain-v1.zh-CN.md`（S1–S11、DC-1…12、17 项 audit check、§7.5/§7.6）；`context-unit-manifest-v1.zh-CN.md`（CU/CM、内容分类、anchor、§10.1 折叠规则、§12.3 SYNC 清单）。
- 所有 hash 一律 `sha256:<pending>`；**P0 阶段不允许把任何旧结果写成本架构的通过证据**（§10.3）。

## 1. 范围与本地规则

本文覆盖压缩与记忆线（Compression & Memory）的全部评测桶、fixture 与判定规则；与 Retrieval 线的桶按 `04` §8 的指标目录并列，不合并分母。

在 `04` 的 EV-1…7 之上，本线增加：

| ID | 规则 |
| --- | --- |
| CM-EV-1 | 每个桶的分母独立；no-gold / wrong-repository / 故障注入用例**不混入**正样本分母 |
| CM-EV-2 | “通过”必须绑定 `evaluationRunId` + `caseSetHash` + `fixtureHash` + candidate tree-hash；缺项只能标 `unverified` |
| CM-EV-3 | 不允许加权综合分；报告逐桶给出 `pass / fail / blocked / unverified` 与失败样本 |
| CM-EV-4 | 零容忍项（§6.3）任一违反 → 该桶直接 `fail`，不因其他指标高而抵消 |
| CM-EV-5 | 任何依赖模型判断的检查（semantic drift、Jev preservation、confidence）只能作为辅助观测；判定必须能由确定性证据复现，否则记 `unverified` |
| CM-EV-6 | 净收益类指标只在 stage ≥5（真实执行）测量；未执行的臂必须显式标注 “未执行”，不得用反事实回放代替 |
| CM-EV-7 | fixture 运行前后重算 hash；不一致 → `blocked`（HV-4），除非 ERM 预注册了 “变异前后 hash 对” |
| CM-EV-8 | 任何 hash 字段不得出现全零占位；缺失一律 `ObservedV1` 非 ok（对齐 `09` §4 与 `01` 负例 #26）；占位值被接受 → 该桶 `fail` |
| CM-EV-9 | 14 项一等状态（`09` §3）逐项可区分；`generation_mismatch` / `wrong_dimension` / `cancelled` / `unconvertible` 不得折叠为其他状态 |
| CM-EV-10 | 桶与 FI 的对应关系发生变化（如新增 FI-25…27）时，必须更新本文件并重新预注册；不得在运行后追加桶 |
| CM-EV-11 | **折叠必须双报且带唯一共享折叠码**：出现 `wrong_dimension` 时，结果行必须同时给出“原生层原状态”与 `fold` 记录（`foldRule = "fold-09-3.2.2-wrong-dimension"`、`reason.code = "cg-wrong-dimension"`、非空 `detailHash`）；出现 `unconvertible` / `cancelled` 时同理保留原状态与线内诊断码。只报 `invalid_response` 总数而丢掉原状态 → 该桶 `fail`（`context-unit-manifest-v1` §10.1 FD-2/FD-4） |
| CM-EV-12 | 本线**不新增全局 FI 编号**；每个负例 / 故障必须映射到 `04` §6 的 FI-01…FI-27 或 `04` §7.1 的 KB-1…KB-7；无法映射时显式记 `FI_MAPPING_REQUIRED`（§8.1），并作为阻断提交给 Implementation Controller |
| CM-EV-13 | `review_required` 必须作为独立结果类别统计；未经批准的后续动作数属于零容忍（§6.3 ZT-CM-11） |

## 2. 评测臂与基线

| 臂 | 配置 | 允许阶段 | 说明 |
| --- | --- | --- | --- |
| `A0` | ctrl：不压缩（`keep_full`），只 unitize + manifest + 完整 disclosure | 1a | 全部指标的基线；determinism 与 anchor 的对照组 |
| `A1` | mask + externalize + structured_project（无 Pi compaction） | 1a（fake）/ 5（真实允许后） | 可逆动作；restore 与 pointer 可读性 |
| `A2` | Pi compaction（无 mask/externalize） | 1a（fake Pi）/ 5+（真实 Pi，需版本锁定） | 摘要路径；audit 与恢复 |
| `A3` | A1 + A2（组合） | 5+ | 端到端产品路径 |
| `A4` | shadow：Jev / Embedding 只记录，不执行 | 2–4 | advisory 对照；不得改变执行集合 |
| `A5` | 故障注入臂（每个 FI 一个子臂） | 1a 起 | 见 §8 |

规则：配对比较键为 `caseId + seed + arm`；`A1`/`A2`/`A3` 与 `A0` 必须使用同一 fixture、同一 `caseSetHash`、同一 capability snapshot。臂间差异只能来自被测动作，不能来自模型或 Provider 差异（`04` §1）。

## 3. 桶目录（21 桶）

“阶段”= 最早可测量的阶段；“F”= 关联故障注入（`04` §6）；“零容忍”= 是否含 §6.3 项。

| # | 桶 | 目标 | 臂 | fixture 形状 | gold / negative | 期望状态 | 分母 / 指标 | F | 阶段 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CM-B01 | deterministic policy | 相同输入产生相同 unit/manifest/判决 | A0/A1 | 固定 transcript + 固定 policyVersion | gold = 期望 `bodyHash` 序列；negative = 任何非确定性输出 | `pass` = 重复运行 `bodyHash` 全等 | n = case 数；determinism 率 | — | 1a |
| CM-B02 | exact / protected anchor | 压缩/投影不得丢失 anchor | A0–A3 | 含 §6 全部 AnchorKind 的 transcript | gold = anchor 清单（kind + 序号 + valueHash）；negative = 被改写/丢失的 anchor | 全部 anchor `pass`；任一丢失 = 零容忍 | n = anchor 数；anchor 保留率、漏判数 | FI-08/17 | 1a |
| CM-B03 | restore | mask/externalize 后逐字节还原 | A1/A3 | 含大载荷与 pointer 的 transcript | gold = 原文 hash；negative = 近似还原 | `restored`/`accepted` 且 hash 一致 | n = 可重开 unit；byte-exact 率 | FI-09 | 5（契约 1a） |
| CM-B04 | wrong repository | 指向其他仓库/worktree 的内容 | A0–A3 | 两个 worktree 的快照 | negative = 另一仓库内容；gold = 拒绝记录 | `revision_mismatch` / `permission_denied` | 独立分母；错误返回数（零容忍） | FI-11 | 1a |
| CM-B05 | stale generation | 旧 manifest / semantic generation；含同 revision 的 generation 漂移（FI-27） | A0/A1 | 变异 generation 的 fixture 副本 | negative = 旧 generation 被接受 | `stale` / `generation_mismatch` | n = stale 用例；stale 接受数（零容忍） | FI-01/27 | 1a |
| CM-B06 | missing memory.read | pointer/artifact 不存在 | A1 | 缺 artifact 的 fixture | negative = 静默当作无内容 | `missing` → 恢复或 `blocked` | n = missing 用例；静默成功数（零容忍） | FI-09/19 | 1a |
| CM-B07 | denied memory.read | 权限/scope 不允许 | A1 | scope 受限的 fixture | negative = 绕过 Port 读取 | `permission_denied` | n = denied 用例；越权读取数（零容忍） | FI-10/18 | 1a |
| CM-B08 | manifest conflict | CAS 冲突与指针前进 | A0/A1 | 并发写入脚本（fake port） | gold = 重新读取后成功或阻断 | `manifest_conflict` → 重做/阻断 | n = 冲突用例；覆盖写入数（零容忍） | FI-06 | 1a |
| CM-B09 | compaction race | compaction 期间 transcript 追加 / 旧结果迟到 | A2/A3 | 脚本化并发 | gold = 拒绝迟到结果 + audit 判恢复/扩大 | `epoch_mismatch` / `revision_mismatch` | n = race 用例；错误合并数（零容忍） | FI-07/16 | 1b（fake Pi） |
| CM-B10 | crash / replay | 各步骤前后杀进程并恢复 | A1/A2/A3 | 故障脚本 + 快照 | gold = effect 状态可解释、无重复副作用 | `unknown` 保持 unknown；`no_automatic_replay` | n = 崩溃点；重复副作用数（零容忍） | FI-14 | 1b |
| CM-B11 | no-silent-success | 失败不得表现为成功 | 全臂 | 组合故障 | negative = 任一 “非 ok 但记成功” 路径 | 全部显式非 ok | n = 注入失败的用例数；silent success 数（零容忍） | FI-05/17/19 | 1a |
| CM-B12 | unknown effect | effect 结果不明 | A1/A2 | 写入中断 / 无 receipt | gold = `assurance_unknown` + 人工 reconcile 入口 | 无自动重放 | n = unknown 用例；自动重放数（零容忍） | FI-14 | 1b |
| CM-B13 | current / previous value | 更新后保留 previous，不丢历史 | A0–A3 | 含 `memory.update` 历史的 transcript | gold = `(key, current, previous)` 三元组；negative = 只留当前值 | 三元组完整 | n = 更新条目；三元组完整率 | — | 1a |
| CM-B14 | rejected approach | rejected 方案与其失败原因必须完整 | A0–A3 | 含 rejected 记录的 transcript | gold = 原因原文 anchor；negative = 改写/省略 | anchor 全保留 | n = rejected 条目；原因保留率 | — | 1a |
| CM-B15 | tool-call pairing | call 与 result 成对，id 不变 | A0–A3 | 含多组 tool call 的 transcript | gold = 配对表；negative = 孤立方/重编号 | 配对完整 | n = 配对；孤立数（零容忍） | FI-07 | 1a |
| CM-B16 | permission / scope mismatch | 不得放宽权限或跨 scope | 全臂 | 受限 scope fixture | negative = 越权读取/外发 | `permission_denied` | n = 越权用例；违规数（零容忍） | FI-10/18/22 | 1a |
| CM-B17 | epoch mismatch | 旧 Attempt/epoch 的结果被拒 | A1/A2 | 两 epoch 脚本 | negative = 合并进当前 Attempt | `epoch_mismatch` | n = 迟到结果；错误合并数（零容忍） | FI-16 | 1b |
| CM-B18 | receipt duplication | 重复请求不得产生第二个 receipt/effect | A1/A2 | 重放同一 `idempotencyKey` | gold = 幂等回放 | 一份 receipt / 一次 effect | n = 重放次数；重复数（零容忍） | FI-23 | 1a |
| CM-B19 | token reduction | 压缩带来的输入 token 降幅 | A1/A2/A3 vs A0 | 真实长会话（stage ≥5） | gold = 逐轮 token 计数（Provider 侧） | 报告，不作门槛 | n = 轮次；降幅分布 + 区间 | — | ≥5 |
| CM-B20 | compression overhead | 控制面自身开销 | 同上 | 同上 | gold = 分步耗时 | 报告，不作门槛 | n = 轮次；p50/p95/p99 | — | ≥5 |
| CM-B21 | net latency / token benefit | 节省减重读与恢复成本 | 同上 | 同上 | 需要 paired 反事实 | 报告 + 预注册门槛 | n = 配对轮次；净 token / 净延迟 | — | ≥5 |
| CM-B22 | protection class / permission 分离 | class 不被权限位或模型改写；`actions` 键集合不被扩容；`drop` / `lossy_compress` 不得被 admitted | 全臂 | 负例集 + 对抗 proposal | negative = 两套枚举混读、class 与 actions 互推、`actions` 出现第五个键（含 `promotionRecommendation` / 历史布尔名）、drop/lossy admitted | 全部 `deny` / `review`；class 与 `actions` 键集合保持 | n = 对抗用例；违规数（零容忍 ZT-CM-09） | FI-05（部分） | 1a |
| CM-B23 | 不可表达状态的折叠与原状态追踪 | `wrong_dimension` / `unconvertible` / `cancelled` / `epoch_mismatch` 不消失、可还原 | A1/A2/A4 | 观察层与内容实体混合注入 | gold = （原生层原状态, 折叠值, `reason.code`）三元组，其中 `wrong_dimension` 的 `reason.code` 必须为 `cg-wrong-dimension` 且 `foldRule = fold-09-3.2.2-wrong-dimension`；negative = 只报 `invalid_response`、或使用 `compression-wrong-dimension` | 折叠显式且可还原 | n = 折叠用例；丢失原状态数（零容忍） | FI-02 / FI-16 / FI-25 / FI-27 | 1a（契约） |
| CM-B24 | `review_required` 门槛 | 未获批不得继续 | A1/A2 | 审批端口脚本 | negative = 未批先执行；超时被当批准 | `waiting` / `blocked`；无副作用 | n = 审批用例；未批执行数（零容忍 ZT-CM-11） | FI_MAPPING_REQUIRED | 1b |
| CM-B25 | carry-forward | `exact_required` 单元必须逐字节保留 | A2/A3 | 含 exact anchor 的前缀 | gold = `carryForwardUnitIds` 逐字节存在；negative = 摘要代替 | `accepted` 仅在 carry-forward 校验通过时 | n = 压缩用例；缺失数（零容忍 ZT-CM-12） | FI_MAPPING_REQUIRED | 1b |
| CM-B26 | manifest read-back 身份 / supersedes 链 / 占位 hash | R1–R4 与链完整性 | A0/A1 | 篡改副本 | negative = 只 decode 不比对；断链被接受；全零 hash 当 ok | `unknown` / `manifest_conflict` / `missing` | n = 篡改用例；误接受数（零容忍） | FI-06 / FI-17 / FI-19 + KB-4 | 1a |

补充：

- CM-B19…B21 的**契约与 fixture 在 P0 冻结**，但真实测量需要 stage ≥5，且必须锁定 Provider capability snapshot；在 stage ≥5 之前一律 `unverified`（禁止用旧 −17.7% 或任何旧数字代替）。
- CM-B03 / B06 / B07 在 stage 1a 只能验证 “契约级 restore 语义”（fake port + fake Pi），不得表述为真实 compaction 恢复。

## 4. fixture registry 与必备字段

沿用 `04` §4.1 / §4.2 的格式（内容寻址、只增不改）。每个 fixture / case 必须携带以下 10 个字段；缺任一项 → 该 case 为 `unverified`，不得进入分母。

| 字段 | 说明（本线） |
| --- | --- |
| `fixtureHash` | 该 fixture 内容的 canonical hash；运行前后重算并比对（HV-4） |
| `caseSetHash` | 有序 `caseId + bodyHash` 列表的 hash；gold 变更必须产生新 `caseSetHash` |
| `gold` / `negative` labels | gold = 必须保留的 anchor / 期望状态 / 期望 outcome；negative = 明确错误结果（含 wrong repository、silent success、越权） |
| `label source` | 标注依据的来源（原始 transcript、Kernel 记录、旧证据的提案来源等） |
| `annotator` | 标注者标识；`independentOfCandidateAuthor ∈ {true, false, "unknown"}` |
| `blind-review rule` | 至少一次不看候选输出的标注或复核；记录 `labelProvenance.blind` |
| `expected status` | 期望的 `FactStatusV1` / outcome（如 `stale`、`missing`、`accepted`、`restored`） |
| `stopping condition` | 该 case 的终止条件（§6.1）与失败处置 |
| `evaluationRunId` | 运行标识（`evr-<yyyymmddhhmmss>-<slug>`） |
| `candidate reference` | `CandidateRefV1`（`develop` 无提交 → tree-hash 方案） |

### 4.1 本线 fixture 清单（P0 待填；hash 一律占位）

| fixtureId | kind | 对应桶 | fixtureHash | caseSetHash | annotator | blind | expected | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fx-cm-anchors-all-kinds` | transcript | CM-B02 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | anchor 全保留 | 待创建 |
| `fx-cm-large-payloads` | transcript + artifact | CM-B03 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | byte-exact restore | 待创建 |
| `fx-cm-two-worktrees` | repo-snapshot ×2 | CM-B04 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 拒绝跨仓库 | 待创建 |
| `fx-cm-stale-generation` | manifest 副本 | CM-B05 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | `stale` | 待创建 |
| `fx-cm-missing-artifact` | manifest + 缺 artifact | CM-B06 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | `missing` | 待创建 |
| `fx-cm-scope-restricted` | transcript + policy | CM-B07/B16 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | `permission_denied` | 待创建 |
| `fx-cm-cas-race` | 并发脚本 | CM-B08 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 重做/阻断 | 待创建 |
| `fx-cm-compaction-race` | 并发脚本 + fake Pi | CM-B09 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | `epoch_mismatch` | 待创建 |
| `fx-cm-crash-matrix` | 故障脚本 | CM-B10/B12 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 可解释 + 无重放 | 待创建 |
| `fx-cm-update-history` | transcript | CM-B13 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 三元组完整 | 待创建 |
| `fx-cm-rejected-approaches` | transcript + decision 记录 | CM-B14 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 原因原文保留 | 待创建 |
| `fx-cm-tool-pairs` | transcript | CM-B15 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 配对完整 | 待创建 |
| `fx-cm-long-session-25r` | 真实/回放会话 | CM-B19–B21 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 报告型 | 待创建 |
| `fx-cm-fault-suite` | 脚本化 fake 端口 | CM-B11 + FI | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 逐 FI 断言 | 待创建 |
| `fx-cm-protection-class` | decoder 负例集 | CM-B22 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 拒绝两套枚举混读 | 待创建 |
| `fx-cm-fold-states` | 注入 wrong_dimension / unconvertible / cancelled / epoch 迟到 | CM-B23 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 原状态可还原 | 待创建 |
| `fx-cm-readback-identity` | manifest/artifact 副本 + 篡改 | CM-B26 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | R1–R4 任一不成立即非 ok | 待创建 |
| `fx-cm-supersedes-chain` | 断链 manifest 副本 | CM-B26 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 断链 → 拒绝 | 待创建 |
| `fx-cm-review-required` | 审批脚本（fake approval 端口） | CM-B24 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 未批准不得推进 | 待创建 |
| `fx-cm-lossy-drop` | policy 请求 `drop` / `lossy_compress` | CM-B22 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 一律 deny / request_review | 待创建 |
| `fx-cm-unconvertible` | 大写 / 非 ASCII / 行号 / worktree pointer | CM-B23 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 不对内容实体折叠为 missing | 待创建 |
| `fx-cm-hash-placeholder` | 全零 hash / textHash 冒充 | CM-B26 | `sha256:<pending>` | `sha256:<pending>` | `<pending>` | `<pending>` | 拒绝占位 hash | 待创建 |

规则：`fx-cm-long-session-25r` 的 fixture 必须是**在新的 candidate 与新的 ERM 下产生**的会话；不得直接复用旧 B4/v65 的 transcript 作为通过证据（见 §10.3）。

## 5. label 与标注规则（本线补充 `04` §4.3）

1. **anchor label**：必须逐条给出 `AnchorKind + ordinal + valueHash`；标注者不能只写 “这段很重要”。
2. **current/previous label**：`memory.update` 条目必须标注三元组；缺 `previous` 即为不完整标签。
3. **rejected approach label**：必须包含 rejected 结论与失败原因的原文 anchor；只标 “已拒绝” 不合格。
4. **silent success label**：negative 必须写明 “在什么故障下出现何种伪成功”，并给出可复现注入点。
5. **no-gold**：本线不使用 “无答案查询” 概念；等价类别是 “无 anchor 的纯说明性内容”，必须与其他桶分开分母。
6. `independentOfCandidateAuthor = "unknown"` 的用例**不得用于放权类结论**（`04` §4.3；旧 gold 的独立性无记载，属 BL-12）。
7. 修订追加式：任何标签修订产生新 `caseSetHash`，旧版本保留。

## 6. 预注册、停止条件与零容忍

### 6.1 case 级停止条件（结构性，P0 即可冻结）

| 条件 | 动作 |
| --- | --- |
| 出现任一 §6.3 零容忍违反 | 该桶 `fail`；保留失败样本；停止该桶继续跑 |
| `harnessVerdict != valid` | 全部结果 `unverified`；停止该 run（`04` §9.1） |
| fixture hash 漂移且未在 ERM 预注册 | `blocked`；停止 |
| 任一 case 缺 §4 的 10 个字段之一 | 该 case `unverified`；不进入分母 |
| 同一 ERM 重放得到不同判定（HV-6） | determinism 缺陷；停止并归因（候选 or harness） |
| Provider/Jev/Embedding 不可用 | 该臂 `unverified`；**不记 0 分**；保留负证据 |

### 6.2 数值阈值的处理

数值门槛（含 confidence 降级阈值、token 预算、net-benefit 门槛）**只能在 stage 1a 的确定性基线测量之后以回归门槛形式设定**（`01` §1 非目标）。P0 只冻结：

- 阈值的**字段位置**（ERM `stopRules[]` / PCR `gates[]`）、
- 预注册规则（`frozenAt` 必须早于任何结果文件）、
- “阈值缺失 → 该指标 `unverified`，不得事后补设”。

### 6.3 零容忍项（本线）

计数器命名遵循 CF-24：线内计数器必须带线内前缀（本线为 `ZT-CM-*`），`03` §1.2 的 CG 清单是**权威归并表**；本线不新增全局计数器。

| ID | 零容忍内容 | 判据 |
| --- | --- | --- |
| ZT-CM-01 | exact / protected anchor 丢失或改写 | CM-B02、CM-B14 |
| ZT-CM-02 | silent success（非 ok 却记成功） | CM-B11 |
| ZT-CM-03 | 无法重读的结果被接受（audit 非 pass 却 `accepted`） | CM-B11、DC-4 |
| ZT-CM-04 | 越权读取或未授权外发 | CM-B07、CM-B16 |
| ZT-CM-05 | 跨 epoch 合并 / 旧 Attempt 结果被采纳 | CM-B17 |
| ZT-CM-06 | 重复 receipt 或重复副作用 | CM-B18、CM-B12 |
| ZT-CM-07 | Runtime Store / lease 表被当作唯一权威写入 | CM-B08、§10.4 |
| ZT-CM-08 | 评测实体写入产品 store 或改写 Run 状态 | `04` FI-15、ISO-4/6/7 |
| ZT-CM-09 | `drop` / `lossy_compress` 在 v1 被执行 | DC-1、`01` §5 |
| ZT-CM-10 | 摘要替代 exact 内容或代替 disclosure | CM-B02、决策链 S9 |
| ZT-CM-11 | `review_required` 未经批准就执行 reversible / lossy / compaction，或以 “已发 approval 请求” 为由推进（决策链 §7.6） | CM-B24 |
| ZT-CM-12 | 载有 `exact_required` 单元的 compaction 缺 `carryForwardUnitIds` 却报成功（决策链 DC-12 / PC-10） | CM-B25 |

与 `03` §1.2（零容忍计数器，由 `04` §11 引用）的关系：`ZT-CM-01…ZT-CM-12` 是本线的线内视图（CF-24），**不得写入全局计数器名**。逐项对应：

| 本线 ZT | `03` §1.2 对应项 | 状态 |
| --- | --- | --- |
| ZT-CM-02 silent success | silent success 数 | 已覆盖 |
| ZT-CM-04 越权读取 / 未授权外发 | 数据外发违规数；越出 workspace / worktree 读写数 | 已覆盖 |
| ZT-CM-08 评测写产品 store / 改 Run 状态 | 产品 store 字节变化数；`plane=evaluation` 被入账数 | 已覆盖 |
| ZT-CM-01 anchor 丢失 / 改写 | —（口径不同：`03` 只有 “reversible 后还原不逐字节一致数”） | **建议归入** “reversible 还原不逐字节一致” 计数口径 |
| ZT-CM-03 不可重读却 `accepted` | —（与 silent success 相关但不等价） | `ZT_CM_MAPPING_REQUIRED`：建议归入 silent success 的细分 |
| ZT-CM-05 跨 epoch 合并 | — | `ZT_CM_MAPPING_REQUIRED`（建议新增计数器） |
| ZT-CM-06 重复 receipt / 副作用 | — | `ZT_CM_MAPPING_REQUIRED` |
| ZT-CM-07 把 Runtime Store / lease 表当唯一权威 | —（部分属架构 §23.3.1 / §26.3 规则） | `ZT_CM_MAPPING_REQUIRED` |
| ZT-CM-09 v1 执行 `drop` / `lossy_compress` | —（但 `03` 有 “`advisory` 被提升” 类似规则） | `ZT_CM_MAPPING_REQUIRED` |
| ZT-CM-10 摘要替代 exact 内容 / disclosure | — | `ZT_CM_MAPPING_REQUIRED`（可与 ZT-CM-01 合并） |
| ZT-CM-11 / ZT-CM-12 | — | `ZT_CM_MAPPING_REQUIRED` |

规则：`ZT_CM_MAPPING_REQUIRED` 项必须由 Implementation Controller 决定是并入 `03` §1.2 的现有计数器还是新增；**本线不自行新增全局编号**。

## 7. 指标定义（CM-B19…B21）

| 指标 | 定义 | 分母 | 备注 |
| --- | --- | --- | --- |
| `tokenReduction` | `(beforeTokens − afterTokens) / beforeTokens`，同 case 同 seed 配对 | 配对轮次 | before/after 取 Provider 请求的输入 token 计数；fake provider 时取组装计数并标注 |
| `compressionOverhead` | unitize + 检查 + gate + commit + audit + read-back 的耗时之和 | 配对轮次 | 与 Provider 延迟分开报告；不参与质量判定 |
| `reReadTokens` | `memory.read` 返回内容的 token 估算 | 配对轮次 | 仅 stage ≥5 的真实重读 |
| `netTokenBenefit` | `savedPromptTokens − reReadTokens − summaryTokens` | 配对轮次 | `summaryTokens` 指被披露/注入的摘要类内容；必须显式计入 |
| `netLatencyBenefit` | Provider 延迟节省 − `compressionOverhead` | 配对轮次 | 同上 |
| `cost` | 仅在 ERM 记录 provider 定价快照时计算 | 配对轮次 | 无定价快照 → `unverified` |

规则：不设加权综合分（不沿用旧 40/30/25/5）；所有指标报告 p50/p95/p99 与失败样本；反事实回放必须标注 “未执行”，不得冒充真实测量。

## 8. 故障注入与负例映射（本线；不得新增全局编号）

### 8.1 本线需求 → `04` 注册表映射（CM-EV-12）

任务书四.1 要求的十三项逐一登记如下；**不新增 FI 编号**：

| # | 本线需求 | 桶 | 映射 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | protection enum 冲突 | CM-B22 | `FI_MAPPING_REQUIRED`（decoder / 静态负例，不在 `04` §6 的 FI 语义内） | 拒绝混读 | `context-unit-manifest-v1` §11 #18 |
| 2 | unknown protection | CM-B22 | `FI_MAPPING_REQUIRED` | 按 `exact_required` fail-closed | §4.2 PC-1 |
| 3 | exact anchor 漏判 | CM-B02 / CM-B25 | `FI_MAPPING_REQUIRED`；阳性对照先记 `KB_MAPPING_REQUIRED` | 不得 `accepted`；`restored` / `expanded` / `review_required` / `blocked` | ZT-CM-01 |
| 4 | recoverability 不足 | CM-B03 / CM-B23 | **部分**：FI-09 / FI-19 | 仅 `keep_full` / `block` | 语义受损时禁止 reversible |
| 5 | memory.read 失败四态 | CM-B03 / CM-B06 / CM-B07 | `missing`→FI-09；`denied`→FI-10；`stale`/`hash mismatch`→FI-01 / FI-27 / FI-17 | 四态不得合并为 “读不到” | 需逐态分母 |
| 6 | manifest read-back 身份不一致 | CM-B26 | `FI_MAPPING_REQUIRED`（最近：FI-06 / FI-17 / FI-19） | `durable ≠ ok`；不得提交 CDQ | §8.3 R1–R4 |
| 7 | `supersedes` 链断裂 | CM-B26 | `FI_MAPPING_REQUIRED`（最近：FI-06） | `manifest_conflict` / `missing` | §8.2 |
| 8 | operationEpoch 不匹配 | CM-B17 | **FI-16**（另参 FI-07） | `epoch_mismatch`；stale diagnostic | — |
| 9 | `review_required` 未批继续 | CM-B24 | `FI_MAPPING_REQUIRED` | 不产生副作用 | ZT-CM-11 |
| 10 | lossy / drop 被 admitted | CM-B22 | `FI_MAPPING_REQUIRED`（最近：`01` 负例 #18） | 一律 `deny` / `request_review` | ZT-CM-09 |
| 11 | unconvertible pointer | CM-B23 | **FI-20.1**（CF-23：`FI-20` 的子用例，**不是**新全局编号） | 保留原 pointer；不折叠为 `missing`；原生层 = SP / RC / RK / OBS / ERM / PCR（**不含 `IR`**，CF-46） | 已裁定 |
| 12 | sourceHash / textHash 混用 | CM-B26 | `FI_MAPPING_REQUIRED`（decoder 负例 #25，无对应 FI） | `invalid_response` 诊断 | `09` §4 / §6 #25 |
| 13 | 全零占位 hash | CM-B26 | **KB-4**（`04` §7.1）+ 负例 #26 | 拒绝占位值 | 对应 DEF-IMPL-1 |
| 14 | restore token 平面互斥（CF-41） | CM-B03 / CM-B06 / CM-B07 | `FI_MAPPING_REQUIRED`（静态 decoder 负例，不在 `04` §6 的 FI 语义内） | `operationEpoch` / `evaluationRunId` 恰好一个非空；同平面绑定不符 → `epoch_mismatch` / `manifest_conflict`；不允许 runtime 请求持 evaluation token | `context-unit-manifest-v1` §7.2 RT-1/RT-3；`09` §6 负例 #30 |
| 15 | `PS.actions` 第五个许可位（CF-40） | CM-B22 | `FI_MAPPING_REQUIRED`（静态 decoder 负例） | 键集合恰好 `{mask, externalize, structuredProject, lossy}`；出现 `promotionRecommendation` / 历史布尔名 → `invalid_response` | `context-unit-manifest-v1` §4.1 SP-4b、§4.2.2 #2、§11 #18c |
| 16 | `unconvertible` 原生层多列 `IR`（CF-46） | CM-B23 | `FI_MAPPING_REQUIRED`（静态 decoder 负例） | `IR` 不承载 `unconvertible`；ABI 转换失败归 SP / RC / RK / OBS / ERM / PCR | `context-unit-manifest-v1` §10 适用性表、§10.1、§11 #24；`09` §3.1 / §7 第 28 条；`02` §3.2 `AP-3` |
| 17 | `timeout` / `cancelled` 互换或来源码缺失（CF-47） | CM-B11 / CM-B23 | **FI-03**（timeout：自身 deadline）/ **FI-25**（取消 / abort） | 自身 deadline → `timeout` + `compression-deadline-exceeded`；父级 deadline abort / 调用方取消 / operation 撤销 / epoch fence / 预算耗尽 / early stop → `cancelled` + 对应来源码；不得互换、不得折叠 | `context-unit-manifest-v1` §10 与 §10.1 FD-5；`09` §3 第 28/29 条；`02` §3.4 `TC-1` / `TC-9` / `TC-10` |

所有仍为 `FI_MAPPING_REQUIRED` 的项必须在阶段 1a 之前在 `04` 的 FI / KB 注册表中登记（或由 Review 裁定为 “静态 decoder 负例，不入 FI 表”），由 Implementation Controller 统一处理；**本线不自行编号**。`unconvertible` 已按 CF-23 归入 `FI-20.1`。

补充（跨线一致性）：

- **CF-26 三层命名**：`EC.category` 用伞形类别（`04` §4.4）；本线的 `CM-B*` 是线内桶编号；两者不得互换，也不得把线内编号写入 `category`。
- **CF-27 仿真 epoch**：FI-07 / FI-16 需要的“旧 `operationEpoch`”只能由 fake 端口 / fixture 内部记录仿真，**不得写入评测实体**（`01` §2 ISO-2）；在 `RestoreTokenV1` 上，这条规则的唯一表达是 `operationEpoch = null`（不是删字段，CF-41）。
- **CF-40 / CF-41 归属**：§8.1 #14 / #15 为静态 decoder 负例，不新增全局 FI 编号；`05` §2.1 / `10` §3 目前仍把 CF-40 / CF-41 标为 “待应用”，属 Implementation 待同步状态，本线不代改。
- **CF-46 / CF-47 归属**：§8.1 #16/#17 均为本线闭合、可静态判定的边界；CF-46 只按 shared matrix（`09` §3.1 / §3.2.2 与 `02` §3.2）改本线文本，**已故意不修改 shared matrix**；CF-47 的来源码登记在 `context-unit-manifest-v1` §10.1 / FD-5，因此实现侧 `09` §3 第 29 条附注（“压缩线的 `timeout` 来源码尚未登记”）已不成立，属 Implementation 待同步状态。

### 8.2 已映射的 FI 用法（沿用 `04` §6 / §7）

| FI | 本线使用桶 | 断言的恢复行为 |
| --- | --- | --- |
| FI-01 wrong generation | CM-B05 | 预期 `generation_mismatch`（CF-22：FI-01 与 FI-27 均归 `generation_mismatch`，`stale` 只属 FI-08）；重建或降级到确定性规则 |
| FI-03 timeout（**该工作单元自身** deadline 到期） | CM-B11 | 取消 + 披露；不得当作空结果；来源码 `compression-deadline-exceeded`（CF-47） |
| FI-04 provider unavailable | CM-B11 | 降级到确定性规则；coverage/建议标非 ok |
| FI-05 invalid response | CM-B11、CM-B02 | 丢弃；不部分接受 |
| FI-06 manifest conflict | CM-B08、CM-B26 | 重读重做或阻断；不覆盖 |
| FI-07 compaction race | CM-B09、CM-B15 | 拒绝迟到结果；audit 判恢复/扩大 |
| FI-08 stale source revision | CM-B02、CM-B05 | 重新 Inspect / unitize |
| FI-09 memory.read missing | CM-B03、CM-B06 | 恢复或 `blocked`；不静默接受 |
| FI-10 memory.read denied | CM-B07 | 阻断 + 请求授权；不绕过 Port |
| FI-11 wrong repository | CM-B04 | 拒绝 |
| FI-14 crash / replay | CM-B10、CM-B12 | `unknown` 保持；`no_automatic_replay` |
| FI-16 旧 Attempt 迟到 | CM-B17 | `epoch_mismatch`；stale diagnostic |
| FI-17 artifact hash mismatch | CM-B11、CM-B26 | 恢复/阻断 |
| FI-19 torn write | CM-B06、CM-B12 | 隔离半成品；视为 missing/invalid |
| FI-22 未授权外发 | CM-B16 | 分支不执行；违规数 0 |
| FI-23 重复请求 | CM-B18 | 幂等；一份 receipt |
| FI-24 缺分支覆盖 | 不适用（检索线） | — |
| FI-25 取消（调用方取消 / 上层或父级 deadline 触发的 abort / operation 撤销 / epoch fence / 预算耗尽 / early stop） | CM-B11、CM-B21、CM-B23 | `cancelled` 与 `timeout` 可区分（FD-5 判定表；`02` `TC-1` / `TC-10`）；不得产出成功；不得把上层 / 父级 deadline 触发的 abort 写成 `timeout` |
| FI-26 fixture 合法变异 vs 漂移 | 全部桶（HV-4） | 合法变异→继续（ERM 预注册哈希对）；漂移→`blocked` |
| FI-27 同 revision generation 漂移 | CM-B05、CM-B23 | `generation_mismatch`；不得当低分；不得混合 generation |

每个 FI 必须同时有：**正向用例**（故障出现时行为正确）与**阴性对照**（无故障时不降级），见 `04` §6。

## 9. 阳性对照（harness 有效性）

沿用 `04` §7 的 HV-1…HV-6，本线补充：

| ID | 内容 | 期望 |
| --- | --- | --- |
| HV-CM-1 | 候选故意丢失一个 exact anchor | harness 必须判 `fail`（ZT-CM-01）；判 `pass` → harness `blocked` |
| HV-CM-2 | 候选故意把 `unknown` effect 记为成功 | harness 必须判 `fail`（ZT-CM-02） |
| HV-CM-3 | 候选故意让 audit 在非 pass 时输出 `accepted` | harness 必须判 `fail`（ZT-CM-03） |
| HV-CM-4 | fake Pi 返回 “成功” 但不产生 session tree 记录 | harness 必须判该 compaction 未闭合（DC-1 / BL-13） |
| HV-CM-5 | fake Memory Port 对 `permission_denied` 返回内容 | harness 必须判 `fail`（ZT-CM-04） |
| HV-CM-6 | 空真检测：anchor 清单为空却判 “全部保留” | 记 `harness_failure`，不是 pass |

## 10. 报告格式、判定与禁止的结论

### 10.1 判定

沿用 `04` §9 的双 verdict：`harnessVerdict ∈ {valid, invalid, blocked}`、`candidateVerdict ∈ {pass, fail, blocked, unverified}`；`harnessVerdict != valid` → `candidateVerdict = unverified`。`results.jsonl` 每行记录 `evaluationRunId / caseId / armId / seed / observed / outcome / metrics / fault / evidenceRef`。

### 10.2 报告必备段

逐桶：分母、排除项与理由、候选 tree-hash、fixture/caseSet hash、capability snapshot、token/latency、read calls、失败复现、负证据、未执行项。

### 10.3 禁止的结论（P0 明文）

1. **不得**把旧 Rapid Evidence Closure（B3 9/9、B4 25/25、B7 单一 seam）写成新架构的通过证据；它不是本架构的 `evaluationRunId`，候选也不是 `D:\pactile` 当前树。
2. **不得**引用 v65（`20261006-b4-full-100-rounds-v65`，18/100、`unverified`、`posthoc-invalid-for-gate`）中的任何数字。
3. **不得**把 focused test（例如 `compaction.test.ts`、`durability.test.ts`、`pi-session-manager.test.ts`）写成产品闭环或架构验收；它们只证明候选在特定函数边界内可运行。
4. **不得**沿用旧 −17.7% token 数字（fail-open 版本、非受控实验）、旧 40/30/25/5 加权分、旧 “严格门槛 1/4 = 25%” 口径。
5. **不得**把 “Pi 扩展线的 verified 10/10 mask” 迁移为本架构的 mask 证据（不同实现、不同候选）。
6. `unverified` / `blocked` 不得在后续文档中改写为 `pass`；负证据保留。

### 10.4 隔离测试

每个 ERM 必须包含：产品 store 只读快照（`productStoreAccess ∈ {none, readonly-export}`）、`plane` 隔离断言（ISO-1…8）、EffectGateway 拒绝 `plane=evaluation` 的 receipt、评测期间产品 `.pactile/` 字节级 hash 不变（FI-15）。

## 11. P0 离场检查单

启动任何评测（stage 1a 起）之前必须全部满足：

1. §4.1 全部 fixture 的 `fixtureHash` / `caseSetHash` 已冻结（`<pending>` 全部回填）；
2. 每个 case 的 10 个必备字段齐全，`annotator` / `blind` 非空；
3. ERM `frozenAt` 早于任何结果文件；`stopRules[]` 已预注册（含 §6.1）；
4. §6.3 零容忍项与 §9 阳性对照已写入 harness；
5. candidate tree-hash 已生成（`CandidateRefV1`），`dirtyWriteSet` 已登记；
6. 评测用 fake / 隔离端口就绪，`productStoreAccess` 非活句柄；
7. 本文件的 §10.3 禁止结论已写入报告模板的 `limits` 段。

任一项缺失 → 该次运行 `blocked`，不得以 “部分完成” 结算。

## 12. 待评审问题

1. 桶数从 21 扩到 26（新增 CM-B22…B26）是否接受；是否仍需增加 “恢复后 Agent 行为” 桶（属 stage ≥5）。
2. ZT-CM-01…ZT-CM-12 是否全部作为硬门槛，或部分降为告警（本文建议全部硬门槛）；`ZT_CM_MAPPING_REQUIRED` 项（§6.3）由谁并入 `03` §1.2。
3. CM-B19…B21 是否接受 “P0 冻结契约、≥5 才测量”。
4. §8.1 的 `FI_MAPPING_REQUIRED` 项应并入 `04` 的 FI 表、KB 表，还是裁定为静态 decoder 负例不入表。
5. `fx-cm-long-session-25r` 的会话来源（新采 vs 回放）与 fixture 归属。
6. 数值阈值的最小集合（stage 1a 之后设定）与预注册载体（ERM `stopRules` vs 独立 policy 文件）。
7. `cost` 指标是否纳入 P0 报告模板（需要 provider 定价快照）。
8. CM-B23 的（原状态, 折叠值, `reason.code`）三元组是否需要单独的 results 字段（`04` §9.2 的 `results.jsonl` 行格式扩字段需同步）。
