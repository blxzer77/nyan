# Retrieval Worker → Retrieval ABI V3 接入设计记录

状态：**设计 + 最小 adapter 已实现（代码存在、focused tests 通过、真实候选 smoke 通过）；未接入 Agent；不可发布；未发布。**

本记录覆盖工作顺序 1–6 步。第 9 步（接入 Agent Context Pipeline）和第 10 步（App 消费真实 Projection）尚未开始，只定义 seam。

## 1. 角色边界

Retrieval Worker 是 Pactile Agent 的 capability provider。它不是独立产品 Agent，不是 Product Kernel、Memory Store 或 Close Evidence 生成器。它不写 Kernel、Memory 或 App。

```text
Context Request
→ RetrievalRequestV3 / RetrievalPlanV3          （Agent，ABI V3 不变）
→ Provider Candidate                            （adapter：runLocalWorkerRetrievalV1）
→ Corroboration                                 （Agent 独立读取；Worker facts 不算）
→ Evidence Classification                       （V3 corroboration kinds）
→ Assurance Check                               （assessRetrievalClaimV3）
→ Context Injection                             （LocalWorkerContextItemV1，仅 retrieval-candidate / retrieval-claim）
```

`runLocalWorkerVerificationChainV1` 按 plan 内置的 verification chain 固定顺序执行：`candidate → corroborate → classify-evidence → check-assurance → accept-or-stop`，并逐阶段记录 passed / stopped / skipped 及原因码。所有 context item 都固定为 `kernelEvidence:false`、`closeEvidenceEligible:false`、`memoryEligible:false`。adapter 结果固定为 `closeEvidenceEligible:false`、`notAcEvidence:true`。

## 2. 候选核验（第 1 步）

| 项 | 结果 |
| --- | --- |
| 候选来源 | `D:\MyHarness\pactile\packages\retrieval-worker`，源仓库中 untracked，只能依靠 hash 清单锚定 |
| 冻结记录 | `D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json`（rootHead `4f3a3d0d…`，pactileHead `0a1dd4c3…`） |
| 逐文件 | 55/55 SHA-256 匹配 |
| 聚合 digest | src `f00e7d83…`（10）/ dist `657f32c2…`（40）/ test `4189fbf9…`（1），全部复现 |
| P5 新 run 内复核 | `candidateMatchesFreeze=true`，pre/post 一致 |
| Node | 本机 v24.3.0；nvm 中没有 22.19，22.19 下的行为**未验证** |

## 3. Worker → ABI V3 字段映射（第 2 步）

### 请求方向（V3 plan → Worker `execute`）

| Worker 字段 | 来源 | 规则 |
| --- | --- | --- |
| `query` | `plan.query` | 原样传入；回包 `query` 必须相同，否则判为 invalid-response |
| `intents` | `plan.steps[].intent` | 只取已按 budget 截断的 steps。exact 直接映射；structural 仅在 `providerRequirement.status=ready` 且没有 scope hint 时发送；semantic/external → `intent-unsupported`。rule planner 总会加入 exact，所以请求中显式带 exact；plan 本身未要求的 exact 命中会被丢弃（`worker-added-exact-dropped`） |
| `paths` | `plan.scopeHints` | 规范化为 POSIX 相对路径。绝对路径、盘符、UNC、`~`、`..`、空段、控制字符、glob 一律拒绝（`scope-hint-rejected`），不静默放宽 |
| `maxCandidates` | `min(budget.maxCandidatesPerStep, 200)` | 超过 200 时夹取并给出 `budget-clamped`（非阻断） |
| `maxBytes` / `maxNodes` / `timeoutMs` | adapter 参数 | V3 中没有对应字段（gap） |
| `signal` | adapter 自有 AbortController | 外部 signal 联动；截止时间为 timeoutMs + 2000ms grace；迟到的响应丢弃 |

### 响应方向（Worker `RetrievalPack` v1 → adapter 结果）

| Worker 字段 | 去向 |
| --- | --- |
| `packVersion` | 必须为 1，否则拒绝；key 集合严格匹配，出现未知 key 也拒绝 |
| `scope.root` | **丢弃**（宿主绝对路径） |
| `scope.worktreeId` | **丢弃**（sha256(path) 宿主指纹），改用 Agent 的 logical `worktreeId` |
| `scope.generation` / `snapshot` | 写入 `result.generation/snapshot`，并与 `expectedGeneration/expectedSnapshot` 做 fencing，不一致 → `stale` |
| `scope.freshness` | 写入 `result.freshness`；不是 fresh 时阻断 structural（`index-not-fresh`），exact 不受影响 |
| `status` | 映射为 `stopReasons` / `intentStatus` / `coverage`：partial/limit_hit → 非阻断，coverage=partial；timeout → degraded；degraded/parse_failed/unsupported/unavailable → 阻断；stale → stale |
| `candidates[].path` | 规范化后写入 `sourcePath`；越界或不在 scope 内 → 整包 `path-containment-violation` |
| `candidates[].line` | 独立字段 `line` |
| `candidates[].ref`（`source://p#Lnn`） | 丢弃；只有当 `source://p` 满足 V3 语法时才重建 `evidenceRef`，否则为 null 并给出 `ref-not-representable` |
| `candidates[].source` | exact → exact，graph → structural |
| `candidates[].hash` | 写入 `workerObservedSha256`，**只作元数据，永远不算 corroboration** |
| `facts[]` | 丢弃（属于 Worker 自证） |
| `missing[]` | 只消费 `generation-changed`（→ stale）；candidate-missing 由 V3 自行推导 |
| `decision.provider` | 必须是 `rule`，否则整包 `non-local-decision-provider`；其余字段丢弃 |
| `budget`、`createdAt`、`hash` | 丢弃（pack hash 无法独立验证，也不是证据） |

### V3 中 Worker 无法提供的部分

`minimumAssurance`、`requestedPolicy`、`requiredEvidenceKinds`、`verificationChain` 都属于 Agent plan。corroboration 由 Agent 独立读取产生。structural 所需的 `ResolvedProviderV1` 证明 Worker 也无法提供：在 Agent provider resolver 能为本地 Worker 签发 resolution 之前，structural claim 一律 `minimum-assurance-not-met`，测试中已固定这一行为。

## 4. 不可映射字段与需要新增的 contract（第 3 步）

| # | Gap | 当前处理 | 需要的 contract / 改动 |
| --- | --- | --- | --- |
| G1 | V3 `LOGICAL_REF` 只允许小写段，且没有行号；`README.md`、`*.zh-CN.md`、大写路径都无法表示（真实 smoke 中 README.md 命中即为 null ref） | 保留为 candidate，ref 为 null，不能进入 assessment | 版本化 source-line ref schema，或扩展 ref 语法（ABI 变更） |
| G2 | V3 budget 中没有 maxBytes/maxNodes/timeoutMs | adapter 参数 | 在 V3 budget 中补字段，或定义 provider budget 扩展 |
| G3 | Worker maxCandidates 是跨 intent 去重后的**总数**，V3 是**每步**数量 | 取 min(perStep, 200)，coverage 按总数判定 | 统一语义 |
| G4 | RPC 没有 handshake 和协议版本 | handshake = probe(node, sqlite) + `open` + `stats` | Worker 增加 `hello{protocolVersion}`（Worker 改动，需重新冻结） |
| G5 | RPC 没有 cancel，请求串行 | abort/timeout 时终止进程树，并在进程退出后才 reject | Worker 增加 cancel（同上） |
| G6 | RPC 不暴露 `indexDir`，索引写入 `<root>/.pactile/retrieval/<id>`；真实 smoke 观测到 `indexInsideWorkspace=true` | 与 `filesystem:"read"` 冲突，**未解决** | 二选一：暴露 indexDir（Worker 改动），或把 init/sync 声明为写 effect 并配 receipt |
| G7 | `rpc.ts` 会根据 env 自建 HTTP/SystemOne decision provider | env allowlist 清洗，并拒绝非 rule provider | Worker 端移除 env 驱动的网络 provider |
| G8 | P3 REPRO-D30：graph 路径过滤是"第一个 path 的精确文件相等"，目录 scope 返回空的 `complete` | adapter 不发送带 path scope 的 structural，并回退 exact | Worker 修正目录语义（需重新冻结和评测） |
| G9 | D30 中 pendingChanges 让 stats.state 保持 ready，而 freshness 实为 stale | handshake 的 freshness 取自 `open` 的 scope | — |
| G10 | Worker hash = sha256(UTF-8 解码后的文本)，Agent 计算的是原始字节；非 UTF-8 文件必然不匹配 | 失败关闭：判为 `content-changed`，不会误判为通过 | source fact hash 语义需写入 contract |
| G11 | Worker 错误消息中带绝对路径 | 只保留裸错误 token，例如 `ENOENT` | — |

## 5. 旧 run 分类（第 4 步）

| 桶 | run | 分类 |
| --- | --- | --- |
| P1 | 20261004/20261005 contract runs | 背景证据（未绑定 d25d33）；**需重跑** |
| P2 | `exact-02-20261007-181929-d25d33` | candidate 证据，PASS |
| P3 | `graph-03-20261007-171741` | candidate 证据：116 pass / 2 contract-finding / 1 **INCONCLUSIVE**（ABORT-large-fixture-in-flight），原样保留 |
| P4 | `lifecycle-04-20261007-190100` | candidate 证据，PASS，orphans=0 |
| P5 | `concurrency-05-20261008-004408` | **新的权威 candidate 证据**，见第 7 节 |
| P5 | `concurrency-05-20261007-180737` | 背景证据：verdict=PASS 与 verdictNote 自相矛盾 |
| P5 | `concurrency-05-20261007-193019` | **VOID**（summarize.mjs 语法错误） |
| P5 | `concurrency-05-20261008-003926` | **VOID**（准备阶段 patch 错误，被 freeze 前的 syntax gate 拦下） |
| P5 | `concurrency-05-20261008-004022` | **SUPERSEDED**（单独调用一次 freeze 后，11-verify 走了 strict 分支，exit 70），不得引用 |
| P6 | `p6-budget-fault-06-20261007-183546-final` | candidate 证据，PASS |
| P7 | `decision-07-20261007-054042` | 背景证据：早于冻结约 11 小时。实测 70 PASS / 1 unverified / 2 arms，与"140 pass / 2 unverified"的说法不一致，未调和 |
| P7 | fix-d25d33 `probe-p7-surface.mjs` | 只能证明影响面 |
| P8/P9/P10 | — | 未开始 |

## 6. Adapter seam 与进程契约（第 5 步）

### 写集

- `packages/cli/src/pactile/retrieval/adapters/local-worker.ts`：纯 adapter，包括 V3 映射、fencing、containment、coverage、verification chain、context item、structural availability 和 unknown-effect 对账。
- `packages/cli/src/pactile/retrieval/adapters/local-worker-process.ts`：进程 transport。
- `packages/cli/src/pactile/retrieval/evidence.ts`：新增 `isRetrievalLogicalRefV3`，作为 ref 语法的唯一来源。
- Node 24 baseline：`packages/cli/package.json`、`apps/pactile-app/package.json`、`.github/workflows/ci.yml`、`.github/workflows/publish.yml`、release preflight/conformance、Node 示例与对应测试/文档。
- 不从 `retrieval/index.ts` 导出，避免让人误以为已经接入 Agent。

### 进程契约

| 项 | 定义 |
| --- | --- |
| install / readiness 检查 | spawn 前执行 `node -e` 探针：确认 `process.version` 的 major ≥24，并对 `node:sqlite` 做 `BEGIN IMMEDIATE/ROLLBACK` smoke。不满足则返回 `unsupported`，不 spawn |
| handshake | `open` → scope(generation, snapshot, freshness)，再 `stats` → state。对外只暴露 `{nodeVersion, sqliteAvailable, workerState, generation, snapshot, freshness}`，不含路径 |
| capability readiness | `localWorkerStructuralAvailabilityV1`：没有 handshake → unavailable；Node/sqlite 不满足 → unsupported；ready+fresh+gen>0 → ready；stale/syncing/degraded 且 gen>0 → degraded；其它 → unavailable。exact 不依赖索引 |
| worktree / cwd | cwd = workspace root = argv[2]。root 只出现在本地 spawn 参数中；对外只使用 logical `worktreeId` |
| env | allowlist：PATH、PATHEXT、SYSTEMROOT、WINDIR、COMSPEC、TEMP、TMP、TMPDIR、HOME、USERPROFILE、LANG、LC_*。所有 `PACTILE_*`、凭据和 `NODE_OPTIONS` 都被剔除 |
| framing | JSONL `{id, method, params}` → `{id, result \| error}`。同一时间只允许一个在途请求（`TRANSPORT_BUSY`）；非 JSON、id 不匹配或 stdout 超过 16 MiB → `PROTOCOL_ERROR`，并终止进程 |
| generation / snapshot | 每个 execute 结果都与 Agent 期望值比对；执行期间 generation 变化（`missing:["generation-changed"]`）→ stale |
| checkpoint | 写入前先读取 `{generation, snapshot}` 作为 checkpoint；读取不受调用方 signal 影响 |
| abort / timeout | 没有 cancel RPC，因此终止进程树（Windows 用 `taskkill /T /F`，POSIX 用 SIGKILL），**等进程退出后**才 reject `ABORTED`/`TIMEOUT` |
| exit code | `exit = {code, signal, expected}`。expected 只在 close/terminate 由 adapter 发起时为 true；意外退出时在途请求以 `WORKER_EXITED` 拒绝 |
| stale response | kill 后进入 closing，迟到的 stdout 被忽略；adapter 层截止后的迟到结果也会丢弃 |
| unknown effect | init/sync 在写入前被 abort → `not-started`；写入中被终止 → `unknown-effect`。重启后用 `reconcileLocalWorkerIndexEffectV1` 比对 generation/snapshot，得到 committed / not-committed / indeterminate。**不自动重放** |
| restart / resume | 重启 = 新进程 + 新 handshake + 对账。execute 是只读操作，可在新 generation 下重新发起；sync 是收敛操作，由 Agent 在对账后显式决定是否再次执行 |
| 错误信息 | 只保留裸错误 token（如 `ENOENT`）；stderr 只计字节数，不对外暴露内容 |

## 7. 验证证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 单元（fake transport） | `test/pactile/retrieval/local-worker-adapter.test.ts` | 54/54 |
| 进程（fake worker 子进程，真实 spawn/kill） | `test/pactile/retrieval/local-worker-process.test.ts` | 12/12 |
| retrieval 全部 focused | `vitest run test/pactile/retrieval` | 151 passed / 2 skipped（smoke 需 opt-in）；基线 85 |
| typecheck / lint / build | `pnpm --filter @blxzer/pactile typecheck`、`lint`、`build` | 均 exit 0；Node v24.3.0 |
| release focused | `release-guard.test.ts` + `release-promotion-scripts.test.ts` | 19/19 通过；Node 24 engine/CI matrix 断言通过 |
| docs focused | `test/docs/minimal-agent-app.test.ts` | 21/22；1 个既有仓库说明不一致：测试要求根 AGENTS.md 含 `Historical maintenance exception`，当前文件没有；未修改 AGENTS.md |
| full package test | `pnpm --filter @blxzer/pactile test` | **失败，原样保留**：13 个 test files、24 tests fail、2792 pass、11 skipped；失败集中在 JEV/provider 外发断言和 P38 lifecycle timeout/EPERM，非 retrieval 写集；因此不能声称 full test 通过 |
| 真实候选 smoke | `D:\pactile-evidence\retrieval-worker-smoke\smoke-20261008-020605`（当前代码、冻结 dist，Node v24.3.0，临时 fixture） | 2/2：init committed；exact 命中能通过 Agent 读取完成 corroboration，assessment accepted；mutate+sync 后旧 generation 被 fence 为 stale；`../` scope 被拒；structural ready 时有候选；3000 文件 init 在 150ms 时被终止 → unknown-effect，进程已退出（expected=true），重启后对账为 not-committed；结果中不含 root |
| smoke 第 1 次 | `smoke-20261008-005125` + `FINDING.md` | 1 fail：transport 在进程退出前就 reject，导致重启可能与旧进程重叠。已修复，原记录保留 |
| P5 权威 run | `D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408` | PASS：29/29 行、309/309 断言、15 个步骤全部 exit 0；最终 verify 34 项检查 0 失败；候选 hash 与冻结一致；runId 时间戳匹配；D25–D28 回归探针均未复现；orphans=0 |

P5 harness 改动（记录在 `harness-provenance.json` 和 harness-failures 的 P5-H12/H13）：补回 summarize.mjs 缺失的逗号；freeze 前对所有 driver 执行 `node --check`；评测根目录迁到 `D:\pactile-evidence`，不再写 `D:\MyHarness`；只读的 git 查询设置 `GIT_OPTIONAL_LOCKS=0`。场景、断言和候选判定都没有改动。

## 8. Node 策略

**用户决定：方案 1，Pactile 全线提升到 Node 24。** 状态：**代码基线已落地；Node 24.3.0 focused 验证通过；最低 24.0.0 与完整 release/build/pack 门禁尚未完成**。

- `packages/cli/package.json`、`apps/pactile-app/package.json`、`.github/workflows/ci.yml`/`publish.yml`、README/示例和 release guards 已声明 `>=24.0.0` 或 Node 24 lane。仍需在 Node 24.0.0 最低版本完成干净安装、full test、build、pack、tarball 和真实 Provider read-back；不能把本机 v24.3.0 focused 通过写成可发布。
- Node 22.19 未作为 Pactile 产品基线验收；不得宣称 22.19 下具备 Worker/SQLite 能力。
- 即便全线 Node 24，Worker 仍作为**独立 capability process** 运行。原因有三：RPC 没有 cancel、graph compute 同步执行（P3 INCONCLUSIVE），只有终止进程才能保证 abort/timeout 有界；另外还能隔离崩溃，并统一清洗 env。握手中的 Node/sqlite 探针保留，作为安装检查。

## 9. P7 决定

当前接入只允许 `rule` decision provider：adapter 拒绝其他 provider，transport 剔除 `PACTILE_DECISION_*`。因此 **P7（LLM decision provider）不在本接入的关键路径上**，结论为"不适用于 rule-only 配置"，并非"通过"。以后若要启用 LLM decision，必须在 d25d33 候选上用新 runId 重跑 P7。现有 P7 只算背景证据和影响面证据。

## 10. 未决与闸门

- P1：没有权威 run，需要绑定 d25d33 重跑。
- P3：INCONCLUSIVE 原样保留。进程级 kill 已在 fake worker 测试和真实 init 终止 smoke 中验证，但库内 graph abort 窗口没有重测；contract finding 由 adapter 阻断规避，Worker 本身未修复。
- P8/P9：闸门（P1 明确、P3 处理）未满足，尚未推进。
- P10：最后只读汇总。
- G6 索引写入 workspace 与 `filesystem:"read"` 冲突，未解决。
- Provider 稳定性（P7 真实 provider 的网络/限流）与 Retrieval 逻辑错误分开记录；本记录中没有 provider 稳定性事件。
- 第 9 步的接入目标是 `packages/cli/src/pactile/agent/context-pipeline.ts`（另一条工作线正在开发），本轮未修改。
- 环境事件：00:06–00:18 和约 00:31 期间，`D:\pactile` 的 ignored 产物（node_modules、dist、.tmp）被外部清除两次，来源不明，不是本工作线所为。之后用 `pnpm install --frozen-lockfile --offline` 恢复，lockfile hash 未变；评测证据因此放在仓库之外。
