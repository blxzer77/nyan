#!/usr/bin/env node

/**
 * Run the nyan CLI from this checkout's TypeScript sources, without a build, from any working directory:
 *
 *   node <repo>/scripts/nyan-source.mjs [nyan arguments]
 *
 * On Node, the source resolver maps `@ny4n/*` imports to the workspace sources (Node only strips the types). Bun
 * reads the same aliases from tsconfig.json, so it skips the Node-only resolver. A stale or missing `dist/` is never
 * used. The working directory stays the caller's, which is the project nyan works on.
 */

const { runningUnderBun } = await import("../packages/coding-agent/src/runtime.ts");
if (!runningUnderBun()) await import("../packages/coding-agent/src/experimental/source-resolver.ts");
await import("../packages/coding-agent/src/experimental/cli.ts");
