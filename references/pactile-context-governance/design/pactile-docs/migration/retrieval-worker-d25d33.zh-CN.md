# Retrieval Worker D25-D33 迁移记录

## 冻结候选

Retrieval Worker 的唯一冻结候选来自 `D:\MyHarness\pactile\packages\retrieval-worker`，冻结记录和证据保存在：

```text
D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\freeze.json
D:\MyHarness\.tmp\retrieval-worker-audit\freeze-d25d33-20261007\candidate-hashes.txt
D:\MyHarness\.tmp\retrieval-worker-evaluation\fix-d25d33-20261007-145621\fix-record.json
```

候选以 `pactileHead=0a1dd4c3`、Node `v24.3.0` 冻结；源码、构建产物和测试 digest 以 `freeze.json` 为准。`dist/` 是构建产物，迁移时重建，不手工复制为源码。

## 最小导入集

```text
packages/retrieval-worker/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── README.md
├── src/
│   ├── bin/retrieval-worker.ts
│   ├── decision.ts
│   ├── exact.ts
│   ├── graph.ts
│   ├── index.ts
│   ├── rpc.ts
│   ├── store.ts
│   ├── types.ts
│   ├── util.ts
│   └── worker.ts
└── test/worker.test.ts
```

## Pactile 接入边界

目标仓库已有 Retrieval ABI V3（`packages/cli/src/pactile/retrieval`）。Worker 的 `RetrievalPack` 与 ABI V3 的 `RetrievalPlanV3`、`RetrievalClaimAssessmentV3` 不是同一结构，不能直接替换。应新增 `packages/cli/src/pactile/retrieval/adapters/local-worker.ts`，将 `scopeHints`、`maxCandidatesPerStep`、generation、snapshot、freshness 映射到 Worker，并把 Worker candidate 经过 source facts、inspect/source-git-tests corroboration 后再形成 V3 claim assessment。

Worker candidate 只能作为候选，不能直接进入 Evidence。绝对 workspace root 只留本地审计记录；Agent、Provider、Renderer 和外部 receipt 使用 logical `worktreeId` 与相对路径。`source://relative/path#L42` 不能未经转换当作当前 Evidence ref，行号应作为独立字段或进入版本化 source-line ref schema。

## 当前评测边界

P2 Exact、P4 Lifecycle、P6 Budget/Fault 已有绑定 d25d33 的通过证据。P5 Concurrency 的旧 run `concurrency-05-20261007-180737` 中 verdict 与 verdictNote 自相矛盾，`-193019` 为 VOID；2026-10-08 用新 runId 重跑出权威报告链 `D:\pactile-evidence\retrieval-worker-evaluation\concurrency-05-20261008-004408`（29/29、309/309，最终 verify 0 失败，候选 hash 与冻结一致）。P3 仍有目录语义 contract finding 和 abort 窗口 INCONCLUSIVE。P1 没有权威 run；P7 只有冻结前的背景证据和影响面证据；P8 Workflow semantics、P9 no-gold semantic、P10 Agent correlation 尚未形成权威完整 run。这些都是 candidate 评测，不是 Agent 接入验收，也不能写成"全量评测通过"。不能把 injected provider 或 surface probe 当作生产验收。接入设计与字段映射见 `retrieval-worker-integration-design.zh-CN.md`。

## Node 策略

Worker 使用 Node 24 `node:sqlite`。用户已选择**方案 1：Pactile 全线提升 Node 24**，本批已将 engines、CI、README、示例和 release guards 切换到 `>=24.0.0`/Node 24 lane；Node 24.0.0 最低版本的干净安装、完整 build/pack/release gate 仍未完成。不能因此宣称 Retrieval capability 已可发布。Worker 仍作为独立 capability process 运行，以保证 abort/timeout 有界，并隔离崩溃。
