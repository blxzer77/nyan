# Batch 2：Native Context / Compaction / Memory Host 接入记录

## 状态

本记录是 Batch 2 的设计与写集记录，不是发布声明。

- canonical repository：`D:\\pactile`
- integration branch：`develop`
- source workspace：未修改 `D:\\MyHarness`
- 当前状态：阶段 0–2 已由当前工作树复核通过；阶段 3 仍是受限真实 Host / Native loop 验证；真实 Pi Session / Provider 仍未验证
- 可发布：否
- 已发布：否
- Retention：当前只执行文档/字段/字节/receipt-list 上限与 canonical `.pactile/` 边界；不自动删除用户记忆或 artifact，也没有完成 purge/reconcile API。用户控制保留期的隐私政策仍是上层产品边界，不能把 immutable artifact 永久存在误报为已完成 retention 管理。

## 产品边界

Compaction、Memory、Retrieval 是 Pactile Agent Runtime Context Pipeline 的三个兄弟能力。它们不创建第二个 Agent，也不由 `pactile app` 或旧 `task/session-memory` 定义事实。

本批次只推进 Context / Compaction / Memory Durability：

```text
Session / Transcript
→ validated cut-point
→ structured summary
→ durable artifact
→ manifest CAS
→ compact receipt
→ new context snapshot
→ session checkpoint
→ Pi-derived native Agent loop
```

未完成完整链时，当前 Agent Context 不得替换；未知 effect 不得自动 replay。

## 最小写集

1. `packages/cli/src/core/pactile/context-memory/compaction.ts`
   - `findValidCutPoints`
   - transcript/cut-point fingerprint
   - Context Snapshot reference contract
2. `packages/cli/src/core/pactile/context-memory/durability.ts`
   - Context Compaction Receipt contract
   - Audit receipt union 扩展
3. `packages/cli/src/pactile/runtime/sqlite-runtime-store.ts`
   - SQLite memory receipt、manifest CAS、audit、lease adapter
   - append-only schema migration
4. `packages/cli/src/pactile/agent/context-pipeline.ts`
   - Context Request / Memory / Compaction orchestration
   - 完整链成功后返回新的 Context Snapshot
5. `packages/cli/src/pactile/agent/pi/{types,agent-loop,agent}.ts`
   - 原生 `context_update` loop event
6. `packages/cli/src/pactile/agent/index.ts`
   - `PactileNativeAgent` 接入 Context Pipeline
7. `packages/cli/src/pactile/runtime/pi-session-manager.ts`
   - 文件化 Pactile checkpoint custom-entry adapter；不解析 transcript
8. 受影响 focused tests 与真实 Node 24 SQLite/FileArtifactStore E2E

## 不在本批次

- Provider Catalog 和真实外部 Provider 验收
- Retrieval capability provider
- `pactile agent run` CLI
- personal-memory 新 vocabulary；本批次先保持 `run/workItem/project` contract
- commit、push、merge、tag、publish、deploy

## 阶段验收矩阵（2026-10-08）

| 阶段 | 结论 | 准确证据 | 未覆盖边界 |
|---|---|---|---|
| 0. 审计/写集 | PASS | 未发现可直接导入的 billion-context / magic-context worktree；Legacy、formal contract、candidate、actual integration 已分栏 | 外部项目只作为研究机制，未导入代码 |
| 1. Context contract | PASS | cut-point、tool-call/result pairing、protected region、payload-only mask candidate、ContextDelta/Snapshot、Decision contract；6 个 focused tests 通过 | 未声称 tokenizer/provider 适配已完成 |
| 2. SQLite/Artifact Host | PASS（Node 24） | SQLite schema v2；真实 FileArtifactStore + SQLite receipt/manifest/audit；restart、duplicate replay、stale CAS、并发 CAS、lease epoch/fencing（含写事务内 stale proof）、artifact missing recovery；3 个 Host tests + 13 个 SQLite tests 通过 | 未覆盖 Node 22 `node:sqlite`；未将 RuntimeStore 冒充 Product Kernel |
| 3. Pipeline/native loop | INCONCLUSIVE（受限通过） | `PactileContextPipeline` 已挂入 `PactileNativeAgent`；真实 SQLite/FileArtifactStore、lease、文件 JSONL checkpoint adapter；成功与 checkpoint failure 两个 E2E tests 通过 | summary/provider 是测试实现；文件 adapter 只验证 Pactile checkpoint custom entry，不等同于上游 Pi SessionManager/transcript reload；未证明真实 Provider |
| 4. 真实 Pi Session/Provider E2E | UNVERIFIED | 无 | 需要真实 Pi SessionManager、真实 Provider、重启恢复后的 native loop 证据 |
| 5. Historian/Recall/Dreamer | NOT STARTED | 本批次未接入 | 必须等待阶段 4 gate |

## 准确写集与边界

- 新增/修改只在 `D:\pactile`；`D:\MyHarness` 未写入。
- 当前 durable 顺序由 `ContextMemoryDurability` 执行：ArtifactStore artifact → durable Memory Receipt → Manifest CAS；Context receipt 在 checkpoint 成功后写入 audit，避免 checkpoint failure 伪造 committed receipt。
- Context 替换只由 `PactileContextPipeline.#record()` 在完整链成功后返回 `context_update`；checkpoint failure、audit failure、unknown memory failure 均不返回新 Context。
- SQLite 只保存 receipt/manifest/audit/lease/runtime metadata；summary/facts 的正文由 FileArtifactStore 保存；Pi transcript/checkpoint 仍由 Pi session seam 负责。
- FileArtifactStore 现在要求显式或可验证推导的 repository root，并拒绝 `.pactile/` 之外的 storageRoot；默认 canonical payload 位置为 `.pactile/runtime/memory-artifacts`。Runtime Host 同时组合该 ArtifactStore 与同一 SQLite RuntimeStore，Native Host memory 默认要求 lease 与 `scope-v1:` canonical scope key，避免 application-data、自由 scope key 形成第二个真源。FilePiSessionManager 也只接受 `.pactile/` 内的 checkpoint 文件。
- Receipt put 与 Manifest CAS 在各自 `BEGIN IMMEDIATE` 写事务内重新验证 lease/owner/epoch/expiry；外部 preflight 失效不会变成写入成功。
- legacy `session_memory.py`、App、Retrieval candidate、第二套 Agent loop 未作为本批次事实源。

## 已运行命令与结果

- `pnpm --filter @blxzer/pactile typecheck`：PASS。
- `pnpm --filter @blxzer/pactile lint`：PASS。
- `pnpm --filter @blxzer/pactile build`：PASS。
- 受影响 focused run：12 files / 129 tests PASS（含 50 durability、13 SQLite、24 FileArtifactStore、2 file-session、2 native pipeline）。
- `format:check`：基线仓库已有 557 个文件不符合 Prettier；本批次不执行全仓格式化，不能作为本批次 PASS。
- 随后一次 focused rerun 被工作树外部迁移打断：`src/core/pactile/artifact-store.ts` 在测试启动前消失，而 `core/pactile/index.ts`/memory durability 仍引用旧路径；该状态不是本批次写集，未擅自恢复或覆盖该候选迁移。此前 12 files / 129 tests 的 PASS 证据保留；当前候选文件已重新出现并完成受影响 focused 重验，但不把外部候选迁移的来源/归属宣称为本批次实现。
- 全仓 `pnpm --filter @blxzer/pactile test`：未形成 PASS；600 秒超时，已观察到与本批次无关的 `pi-independent-review` 2 个失败、`task-kernel-wave-dispatch` 5 个失败，进程未完成，不能作为本批次成功证据。

## 当前工作树复核（2026-10-08 06:53，主控记录）

在 P5 scope helper 写集收敛后，重新执行了受影响的 memory/runtime seam：

- `scope.test.ts` + `core/pactile/context-memory/durability.test.ts`：53/53 PASS。
- CLI 全量 `typecheck`：exit 0；CLI 全量 `lint`：exit 0。
- 本节只证明 canonical scope 校验与已有 durability seam 在当前工作树可运行；不升级为真实 Pi Session/Provider 接入或业务验收。

本轮额外复核（2026-10-08）：canonical FileArtifactStore/Session path fence、Runtime Host 的 ArtifactStore + Memory 组合、Native Host canonical scope refusal 与 audit receipt verification 已加入 focused evidence；7 files / 91 tests PASS（含 24 FileArtifactStore、3 SQLite Context Host、3 Runtime Host、3 File Session、2 Native Pipeline、6 compaction、50 durability）。最终串行复核中，全量 `typecheck`、`lint` 与 `build` 均通过；changed-file focused lint 与 standalone TypeScript compile 也通过。此前并行 build 曾遇到 Windows `dist` 清理的 `ENOTEMPTY`，串行重跑后通过。

## 后续 gate

### Canonical scope identity helper

`packages/cli/src/pactile/agent/memory/scope.ts` 提供 `scope-v1:` 版本化
scope key 的纯合同层实现。它用 canonical JSON 固定
`workspaceId/projectId/scope` 以及适用的 `runId/workItemId`，并拒绝缺失、越界
或不属于该 scope 的标识符。`decodeMemoryScopeKeyV1` 在进入 Host adapter 前检查
前缀、JSON canonicalization 和 descriptor 约束；它不读取文件系统，也不改变现有
允许自由 `scopeKey` 的 v1 请求，因此旧调用保持兼容。新 Host 应优先使用
`memoryScopeKeyV1` 生成作用域 key，避免手工拼接造成跨 workspace/project 的碰撞。

该 helper 只解决 scope identity 的确定性与校验，不表示 Pi Session/Provider 已接通，
也不改变 Artifact、Manifest、Receipt 的 v1 schema。当前 `openPactileRuntimeHost` 的 Native Host memory 组合已将该 helper 设为 admission boundary；底层 host-neutral durability port 仍保留旧自由 `scopeKey` 以支持历史调用，因此两者不可混称。

1. 将 `FilePiSessionManager` 与锁定版本的真实 Pi `SessionManager`/Session tree 接通；验证 session restart、duplicate request、checkpoint replay。
2. 接入真实 Provider stream；验证 provider error/abort 与 Context replacement 的 fail-closed 行为。
3. 完成 unknown-effect reconcile、半写入恢复和真实 Host 并发压力后，才能将阶段 3/4 标为 PASS；在此之前保持“可运行候选/受限验证”，不可宣称可发布。
