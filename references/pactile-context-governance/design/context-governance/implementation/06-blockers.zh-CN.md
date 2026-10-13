# 阻断清单与未验证项（proposed）

- 状态：proposed。截至 2026-10-09 10:4x 的快照。
- 来源：本线 `00-rebase-report`；Retrieval 线 `retrieval/00-rebase-report`（B1–B8）；Compression 线 `compression-memory-rebase-report`（B-CM-1…10）。三处编号在“对应”列互相映射，避免同一问题出现三个名字。
- 规则：每个阻断都有 **owner** 与**解除条件**；没有解除条件的不算阻断，只算风险。

## 1. 阻断项

| ID | 阻断 | 对应 | 影响阶段 | owner | 证据 | 解除条件 |
| --- | --- | --- | --- | --- | --- | --- |
| BL-01 | **已解除（历史快照，保留原描述）**：三条线尚未全部返回 `READY_FOR_P0`；Retrieval 与 Compression 两份报告都没有 `REBASE_STATUS` 行，并把汇总留给 Implementation | Retrieval B2 | P0 | Retrieval、Compression（各自状态）；Implementation（汇总） | 两份报告 + `00` §7 | **已满足**：`08` §2.6 按较新观测裁定三线回执均 `READY_FOR_P0`，不再阻止 P0 文档写作；各线文档仍需独立 Review（见 §1.1 与 `05` §2.1 CF-29） |
| BL-02 | EmbeddingGemma 调研产物缺失 | Retrieval B1 | 2（readiness fixture 期望值） | 用户 / 调研会话 | 不截断检索仅命中架构 / 提示词 / 两份基线报告（`00` §1） | 提供产物路径；或明确接受 “参数 + unverified”，P0 中该字段只冻结为参数、不写期望通过值 |
| BL-03 | 重新基线前的运行时改动处置未决（本线 16 个文件 + Compression 线 4 个文件）。其中含 6 个已知缺陷（DEF-IMPL-1…6）与 Compression 线的 B-CM-2/3/4 | Compression B-CM-1；Retrieval B3（其自身部分） | 1a 的候选身份；任何代码阶段 | 用户 | `00` §0；`05` §4 | 用户决定：冻结 / 隔离 / 回退；决定前这些文件不进入任何证据或 Review |
| BL-04 | `develop` 无提交，`candidateSha` 不可用 | Compression B-CM-9 | 0（manifest 格式）、全部评测 | 用户 | `git log`：`your current branch 'develop' does not have any commits yet` | 选定 `CandidateRefV1` 的 tree-hash 方案（`01` §3.6），或授权建立基线提交 |
| BL-05 | `RunLedgerV1`、唯一 Lease/Epoch、EffectGateway、Policy Gate、WorkspaceHost 均未实现 | Compression B-CM-5 | 1b 起（所有运行时 receipt） | Host 轨道 | 架构 §26.1#8、#9、§26.3 | Host 轨道 P1/P2 的 Task Close；或评审接受 “1a 先行、1b 后置” 的拆分（`03`） |
| BL-06 | 命名冲突：`RetrievalPlanV2`（§27.4）与 ABI `RetrievalPlanV3` | Retrieval B4 | 0 | Implementation（裁定）+ Review | `01` §3.2 | 评审接受拟议裁定（并存，`schemaId` 区分，`abiPlan` 引用） |
| BL-07 | 压缩动作词汇不一致：`lossy_compress`（§27.6）与 `drop`（任务书阶段 4 / §27.8 表） | — | 4、6 | Implementation + Compression | `01` §5 | 评审接受 8 动作并集，且 `drop` 在 v1 范围内不开放 |
| BL-08 | ABI V3 的 ref 语法无法表达行号、大写或非 ASCII 路径 | Retrieval B5 | 1a（RetrievalPack 来源指针） | Retrieval | Retrieval 报告 §6、§7 | 评审接受 `SourcePointerV1`（`01` §4.4），不静默重编码 |
| BL-09 | Worker 的索引 init/sync 会写入 workspace，与只读检索策略冲突 | Retrieval B6 | 1a / 1b structural 分支 | Retrieval + Host | 同上（G6） | 把 init/sync 定义为受 EffectGateway 管理的写 effect，或要求外置 indexDir（Worker 改动需重新冻结并重跑受影响评测） |
| BL-10 | file hash 语义不一致：Worker 对解码文本取 hash，Agent 取原始字节 | Retrieval B7 | 1a（Inspect） | Retrieval | 同上（G10） | P0 固定 Inspect 只信任当前工作树**原始字节** hash（`01` §4.4 已写入） |
| BL-11 | 旧证据绑定 MyHarness 候选 `0a1dd4c3…` 与另一目录布局，不可迁移到 `D:\pactile` 当前树 | — | 全部 | — | 旧 B2/B3/B4/B7 manifest；`00` §4.2#6 | 在新候选与新 manifest 下重跑；旧结果只作背景（`07`） |
| BL-12 | 旧 gold 的标注者、独立性、盲审在已读文件里**没有记载** | — | 0（labels 冻结）、全部放权结论 | 标注者 / Review | `00` §4.7 | 新 labels 必填 `labelProvenance`；`independentOfCandidateAuthor = "unknown"` 的用例不得用于放权结论 |
| BL-13 | compaction 没有进入 durable session tree；重启后 transcript 与 checkpoint 的 snapshot 不一致 | Compression B-CM-2 | 1b、5 | Compression | Compression 报告 §4#2b | 在 P0 契约里定义 compaction 与 session tree 的关系；1b 的 AC-1b.6 验证 |
| BL-14 | Provider error 后内存已回滚，但 durable receipt / checkpoint 没有 supersession 记录 | Compression B-CM-3 | 1b | Compression | 同上 §4#2c | CDR / CAR 增加 supersession 语义；1b 验证 |
| BL-15 | Manifest read-back 没有身份比对；checkpoint 写入全零占位 hash | Compression B-CM-4；DEF-IMPL-1 | 1b | Compression + Implementation | `context-pipeline.ts:695`；Compression 报告 §4#10 | 占位值改为一等 `unknown`/`missing`（运行时修复，需授权）；read-back 比对 hash / revision / current artifact |
| BL-16 | 数据外发授权策略未定义（远程 embedding、Search/Fetch、provider 日志脱敏） | — | 2、3、4 | 用户 | `AGENTS.md` 的凭据规则；Retrieval `08-privacy-egress` 尚未写 | 明确 capability policy：何种内容可发往何种端点；授权引用格式（`egress.authorizationRef`） |
| BL-17 | 同一组运行时文件被两条线交错写入（`service.ts`、`pi-session-manager.ts`、`native-agent.test.ts`），所有权不清 | — | 任何代码阶段 | 用户 / Implementation | 两份基线报告的哈希互相吻合 | 为运行时文件指定唯一写入者或联合评审流程；P0 通过前保持冻结 |
| BL-18 | `check-pactile-brand-surface` 当前失败（退出码 1），三类：inventory snapshot drift（期望 `1520e666…`，实际 `b369cde5…`）；canonical contract digest 不符（期望 `10a8e04e…`，实际 `5ad5ac2c…`）；**62** 个文档缺 source map（32 个既有 + 30 个位于 `context-governance/**`：implementation 11 / retrieval 13 / compression 4 / 根目录 2）。三线新增文档使 “missing” 列表变长（修复轮只读实测） | — | 发布 / 文档门禁（不阻断 P0 文档本身） | 用户 | `05` §3.1（修复轮实测，退出码 1；`00` 的旧数字 42/10/8 已作废，见 CF-32） | 用户决定：登记 source map、豁免路径，或重新基线映射表；**不得为通过检查而改写摘要** |
| BL-19 | 宿主侧秘密扫描策略（拒写还是需确认）未决 | Compression B-CM-8 | 5、7（memory 写入） | 用户 | Compression 报告 §6 | 明确策略并预注册 |
| BL-20 | Pi coding-agent 版本未锁定：已安装 1.0.2，provenance 为 1.0.4 | Compression B-CM-10 | 1b、5（真实 Pi compaction / SessionManager 证据） | 用户 | Compression 报告 §4#4a、§7 | 锁定版本（改动 lockfile 需授权） |
| BL-21 | 本线新增的 `pactile agent run` 用户可见命令从未被端到端执行，未评审、未文档化 | DEF-IMPL-6 | 发布；1b | 用户 / Implementation | `00` §0.1 | 随 BL-03 一并处置 |
| BL-22 | 创建 V2 Task 需用户同意提案；Reviewer 独立性需要定义 | — | 0 之后全部 | 用户 | `workflow.md` | 用户批准 `03` §2 的 Task 提案；定义 Reviewer 与作者的独立规则 |
| BL-23 | 旧 P5 权威 run 的 `fixtureMismatchCount=1` 原因未核实（`slow/d00/f000.ts` 期望与实际 hash 不同） | — | 复用该证据时 | Retrieval | `verification.json` 的 `fixtureMismatches` | 查明是场景内合法变异的观测，还是 fixture 漂移；未查明前不得把该 run 描述为 “fixture 未漂移” |

## 1.1 P0 裁定后的阻断状态（依据 `08`，2026-10-09）

| BL | `08` 裁定 | 残余义务 | 是否仍阻断 P0 文档 |
| --- | --- | --- | --- |
| BL-01 | §2.6：三份回执均已 `READY_FOR_P0`，不再阻止 P0 文档写作 | 各线文档仍需独立 Review | 否 |
| BL-02 | §2.1：参数 + `unverified` 冻结 | 阶段 2 前补调研来源或 readiness evidence | 否 |
| BL-03 | §2.2：冻结并隔离为阶段 1 未评审候选 | 阶段 1 前建候选快照 + 唯一写入者；DEF-IMPL-1…6 / B-CM-2/3/4 的修复需单独授权 | 否 |
| BL-04 | §2.3：`CandidateRefV1` tree-hash | 阶段 1 每次重跑生成新 manifest 与 tree hash | 否 |
| BL-05 | 未裁定（仍开放） | Host 轨道 P1/P2 Task Close | 否（阻断 1b 起） |
| BL-06 | §2.4：V2/V3 并存冻结 | Review 确认表述无歧义 | 否 |
| BL-07 | §2.5：8 动作并集，`drop` 不开放执行 | Review 确认 | 否 |
| BL-08 | §3.1：`SourcePointerV1` + `unconvertible` | 阶段 1a 负例 #22 | 否 |
| BL-09 | §3.2：阶段 1 默认不写 index；两种方案只记录不选择 | 索引写入属阶段 1/2 新写集，需重新冻结 | 否（阻断实际索引） |
| BL-10 | §3.3：原始字节 source hash；`textHash` 另列 | 阶段 1a 负例 #25 | 否 |
| BL-11 | 未裁定 | 旧证据在新 manifest 下重跑 | 否 |
| BL-12 | 未裁定 | 新 labels 必填 `labelProvenance` | 部分（labels 冻结必须完成） |
| BL-13 / BL-14 / BL-15 | 未裁定 | 契约层已给出 CDR/CAR supersession 与占位 hash 禁止规则（`09` §3/§4）；修复仍需授权 | 否（修复阻断 1b） |
| BL-16 | §3.4：deny-by-default | 阶段 2 前冻结 capability policy 具体清单与审计字段 | 否 |
| BL-17 | §2.2：禁止继续交错修改 | 阶段 1 前指定唯一写入者与 Review 入口 | 否 |
| BL-18 | 未裁定 | 用户决定 source map / 摘要 / snapshot drift 的处置 | 否 |
| BL-19 | §3.4：记录为未决策略，不得当作“已保护” | 阶段 5 / 7 前冻结 | 否 |
| BL-20 | §3.5：只标 `unverified`，P0 不锁定版本 | 阶段 1b / 5 前确定版本与候选快照 | 否 |
| BL-21 | 未裁定（随 BL-03 处置） | 候选仍需 E2E 与评审 | 否 |
| BL-22 | 未裁定 | 用户批准 Task 提案 + Reviewer 独立性定义 | 部分（Review 需要） |
| BL-23 | §2.6：保持未解释 | 查清原因前不得写成“fixture 未漂移” | 否 |

结论：P0 **文档写作**已不再被 BL-01…BL-04、BL-06…BL-10、BL-16、BL-20 阻断；仍实质影响 P0 **离场**的是各线独立 Review、labels 冻结（BL-12）与 Reviewer 独立性（BL-22）。

> **修复轮补充**：跨线字段 / 编号 / 文档状态的冲突不在本表新增编号（避免与 `08` 冻结的 BL-01…BL-23 碰撞），统一登记在 `05` §2.1（CF-01…CF-37）。本表只保留“阻断 / 未验证”语义；`05` §2.1 只保留“冲突与裁定”语义。两侧结论都需要独立 Review 确认；本线不得自我批准。

> **修复轮状态声明**：本轮只做共享文档整合与裁定登记，**未**修改 `packages/**`、Worker、Host、RunLedger、EffectGateway、Policy Gate、Memory Port、Provider、lockfile、`docs/migration/**`；**未**创建 Task / Run；**未**启动阶段 1。闸门保持 `P0_REVIEW_BLOCKED` / `P0_EXIT_NOT_ALLOWED` / `STAGE_1_NOT_AUTHORIZED`；下一闸门是“独立 Reviewer 重新执行 `implementation/10` §4”。

## 2. 已解除或已核实的项

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Retrieval 线 B8（lint 在 `agent/effects/contract.ts`、`agent/native-agent/service.ts`、`agent/session/contracts.ts` 失败） | **在 2026-10-09 10:3x 不再成立**：`typecheck` exit 0；`lint` exit 0。这只说明静态检查通过，不说明设计正确 | 本线命令输出 |
| 旧评测进程是否仍在运行 | 无匹配进程 | `00` §5 |
| 三份必读文件的哈希与 Retrieval 线报告一致 | 一致 | `00` §1 |

## 3. 解除顺序与阶段准入

```text
P0 文档写入：  已准入（08）；三线回执均已 READY_FOR_P0
P0 离场：      各线文档通过独立 Review + labels 冻结（BL-12）+ Reviewer 独立性（BL-22）
1a 准入：      P0 离场 + BL-17（唯一写入者/所有权）
1b 准入：      1a 完成 + BL-05（RunLedger/EffectGateway/Policy Gate/WorkspaceHost）+ BL-09（index 方案）+ BL-20（Pi 版本）
2 准入：       1a 完成 + BL-02（调研来源）+ BL-16（egress capability policy）
5 之前：       BL-19（秘密扫描策略）+ BL-13/BL-14/BL-15（durable 一致性修复）
文档门禁：     BL-18（不阻断 P0 文档本身）
发布声明：     BL-21 + 全量测试（旧 `pnpm test` 未 PASS）+ Node 24.0.0 最低版本验证
```

## 4. 未验证项（不得写成 pass）

| 编号 | 未验证内容 | 现有信息 |
| --- | --- | --- |
| UV-01 | EmbeddingGemma 的模型 id、默认维度、task prefix、查询 / 文档前缀差异、batch、取消、隐私、成本 | 无调研产物 |
| UV-02 | 真实 Provider 下的检索与压缩质量 | 旧 B2 真实 Provider 质量分母 0 |
| UV-03 | 真实 Pi compaction / SessionManager v3 的 tree、branch、fork 互操作 | Compression 线：当前测试可能空通过，版本为 1.0.2 |
| UV-04 | 重启后 transcript 与 checkpoint 的一致性 | 已知不一致 |
| UV-05 | 多 Run 并发、duplicate request、半写入恢复、unknown effect reconcile（native 路径） | 无证据 |
| UV-06 | 净 token / 延迟收益（受控实验） | 旧 −17.7% 来自 fail-open 的 v1 版本 |
| UV-07 | Node 24.0.0 最低版本的干净安装、全量测试、pack | 仅 Node 24.3.0 |
| UV-08 | 加入 `agent` 子命令后的全量测试 | 未重跑；此前 `pnpm test` 本来也未 PASS |
| UV-09 | 旧 P1 contract、P3 graph abort 窗口、P7 decision 的权威结论；P8/P9/P10 | Retrieval 线 §5 |
| UV-10 | 旧 P2/P4/P6 的分母与结果（本线只核实了目录与文件存在） | 以各自 `summary.json` 为准，未重算 |
| UV-11 | 旧 B3 workItem / project 与完整 30 行矩阵；B4 100 轮稳定性；B7 DeepSeek / GLM | 旧 goal-audit 的 `remainingGaps` |
| UV-12 | 宿主侧秘密扫描有效性 | 策略未决 |
| UV-13 | 新增 `docs/architecture/context-governance/**` 对除 brand-surface 外其他文档检查的影响 | 本线只核对了 `documentation-parity` / `docs-smoke` 的路径来源，没有运行它们 |
| UV-14 | `evaluationRunId` / `contextOperationId` 命名空间与 `PACTILE_LOGICAL_ID_PATTERN` 的兼容性 | 待对照 `shared/validation.ts` |
| UV-15 | 是否存在 EmbeddingGemma 调研产物位于未检索的位置（如 `D:\MyHarness\.tmp` 深层目录） | 时限内未完成全盘检索 |
