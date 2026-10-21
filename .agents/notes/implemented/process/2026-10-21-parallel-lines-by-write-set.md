# 并行线按写集推进，而不是按固定条数

**状态：implemented（2026-10-21，owner 决定）**

## 问题

`ROADMAP.md` 从第一版（`f0d0720eb`）就带着一条规则："No more than two roadmap lines may be active simultaneously."
它没有任何理由记录，也没有测量支撑。实际后果是：能开的线被绑在两条，即使依赖图上有更多可开工的分支，于是等待的是
排期而不是工作。

同期的观察相反——冲突从来不在代码里，而在共享文档里。2026-10-21 并行推进的两个 PR（#142、#148）都需要把
`main` 合进分支，其中 #148 真的在 `ROADMAP.md` 上冲突；最近 40 个 main 提交里有 9 次 `Merge branch 'main' into …`
的同步提交。也就是说，按条数限流既没有消除冲突，又限制了吞吐。

## 决定

并发由两件事约束，而不是一个数字：

1. **依赖图**：一条线的前提合并后才开工。
2. **写集**：两条同时开的线不得写同一个文件。需要同一文件时，先开工的那条持有它直到合并。

共享文档只有一个写者：**编排会话**拥有 `ROADMAP.md`、`packages/coding-agent/CHANGELOG.md`、`docs/handoff/`、
`docs/layers.json`、根清单与 `install-lock`、`.github/quality/policy.json`。其他会话不碰它们，把要写的
roadmap 行与 changelog 条目写进 PR 描述，由编排会话合并当天落盘。

每条线允许写什么，记在 `ROADMAP.md` 的 [Write sets](../../../ROADMAP.md#write-sets)：那里是唯一的地方，
不由各会话自行推断。

## 为什么这样分工

- **冲突面是文档，不是代码**：今天的两次同步与一次冲突都在 `ROADMAP.md`；代码侧没有一次。
- **共享文件没有并行收益**：`ROADMAP.md` 与 `CHANGELOG.md` 的编辑是几行文本，串行成本远低于冲突处置成本。
- **写集比条数更接近真实约束**：`packages/durable` 被 N3–N6 共同使用，真正的冲突源是同一目录下的模块文件；
  写集把"哪些目录属于哪条线"说清楚，比"只能开两条线"精确。
- **合并通道仍然串行**：`Merge gate` 是队列的，所以并行的收益在实现与审查，不在合并；这一点不需要额外规则。

## 代价与边界

- 编排会话成为共享文档的单点。它不在时，一条线的 roadmap 行会晚一天落盘——这比冲突后的返工便宜。
- 两条线仍可能碰同一个 `index.ts` 导出行。写集里说明这是"一行 append，合并时解决"的已知重叠，不视为违规。
- 新包的脚手架（`packages/retrieval`、`packages/decision`）由编排会话先建，因为 `docs/layers.json` 与根清单属于它的写集。
