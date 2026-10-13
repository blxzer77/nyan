import { access, mkdtemp, mkdir, readFile, rename as renameFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { statSync, watch } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpDecisionProvider, parseFile, RetrievalWorker, SystemOneDecisionProvider, type DecisionProvider, type DecisionReceipt } from "../src/index.js";

/** The CommonJS view of node:fs/promises — the object `syncBuiltinESMExports()` re-syncs from. */
const fspMutable = createRequire(import.meta.url)("node:fs/promises") as unknown as { readFile: typeof readFile };

interface ReadFileDelay { match: (file: string) => boolean; delayMs: number; used: boolean; onEnter?: () => void; onExit?: () => void; }

/**
 * Delay ONE matching `fs.promises.readFile` so a test can act while the read is provably in flight
 * (the same instrumentation technique the acceptance harnesses use). Returns a restore function.
 */
function armReadFileDelay(hook: ReadFileDelay): () => void {
  const realReadFile = fspMutable.readFile;
  fspMutable.readFile = (async (...args: Parameters<typeof readFile>) => {
    const target = String(args[0]).replaceAll("\\", "/");
    if (!hook.used && hook.match(target)) {
      hook.used = true;
      hook.onEnter?.();
      await new Promise((resolve) => setTimeout(resolve, hook.delayMs));
      hook.onExit?.();
    }
    return realReadFile(...args);
  }) as unknown as typeof readFile;
  syncBuiltinESMExports();
  return () => { fspMutable.readFile = realReadFile; syncBuiltinESMExports(); };
}

/**
 * The whole edge/symbol set of a workspace, collected the way the audit does it: the public
 * `graph()` API queried by every alphanumeric name so no traversal limit can hide a relation.
 */
async function graphInventory(worker: RetrievalWorker): Promise<{ symbols: { id: string; name: string; kind: string; path: string; startLine: number; endLine: number }[]; edges: { sourceId: string; targetId: string; kind: string }[] }> {
  const symbols = new Map<string, { id: string; name: string; kind: string; path: string; startLine: number; endLine: number }>();
  const edges = new Map<string, { sourceId: string; targetId: string; kind: string }>();
  for (const character of "abcdefghijklmnopqrstuvwxyz0123456789_") {
    const result = await worker.graph({ kind: "explore", query: character, maxNodes: 2000, depth: 8 });
    for (const symbol of result.symbols) symbols.set(symbol.id, symbol);
    for (const edge of result.edges) edges.set(`${edge.sourceId}|${edge.targetId}|${edge.kind}`, edge);
  }
  return { symbols: [...symbols.values()], edges: [...edges.values()] };
}

/**
 * Engine injection for the exact-search seam.
 *
 * `mode: "real"` passes straight through to the host `rg`; `mode: "enoent"` makes `spawn("rg")`
 * fail with ENOENT so the candidate's own traversal (fallback) runs. This is a per-process
 * injection: the host PATH is never touched and no other test can observe it.
 */
const rgEngine = vi.hoisted(() => ({ mode: "real" as "real" | "enoent", spawnCalls: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      if (String(command) !== "rg" || rgEngine.mode === "real") return actual.spawn(command as never, args as never, options as never);
      rgEngine.spawnCalls += 1;
      const child = new EventEmitter() as unknown as { pid: number; exitCode: null; signalCode: null; stdout: EventEmitter & { destroy: () => void }; stderr: EventEmitter & { destroy: () => void }; unref: () => void; kill: () => boolean };
      child.pid = 900_001;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = Object.assign(new EventEmitter(), { destroy: () => undefined });
      child.stderr = Object.assign(new EventEmitter(), { destroy: () => undefined });
      child.unref = () => undefined;
      child.kill = () => true;
      setTimeout(() => {
        const error = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        (child as unknown as EventEmitter).emit("error", error);
      }, 1);
      return child as never;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "helper.ts"), "export function helper(): string { return 'ok'; }\n");
  await writeFile(path.join(root, "src", "main.ts"), "import { helper } from './helper';\nexport function main(): string { return helper(); }\n");
  await writeFile(path.join(root, "README.md"), "retrieval fixture\n");
  return root;
}

afterEach(async () => {
  rgEngine.mode = "real";
  rgEngine.spawnCalls = 0;
  for (const root of roots.splice(0)) {
    // A worker that is still open keeps the SQLite index locked; retry briefly instead of letting a
    // cleanup artifact surface as a test failure (the assertions themselves already ran).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});

/** Run one request through a chosen engine arm, returning the observed path/region sets. */
async function searchWithEngine(root: string, mode: "real" | "enoent", request: Parameters<RetrievalWorker["search"]>[0]): Promise<{ status: string; reason: string | null; paths: string[]; hits: number }> {
  const before = rgEngine.spawnCalls;
  rgEngine.mode = mode;
  const worker = new RetrievalWorker({ root });
  await worker.open();
  try {
    const result = await worker.search({ maxResults: 500, ...request });
    return { status: result.status, reason: result.reason ?? null, paths: [...new Set(result.hits.map((hit) => hit.path))].sort(), hits: result.hits.length };
  } finally {
    await worker.close();
    // A fallback arm must provably have attempted to spawn rg; otherwise the reading is vacuous.
    if (mode === "enoent") expect(rgEngine.spawnCalls).toBeGreaterThan(before);
    rgEngine.mode = "real";
  }
}

describe("RetrievalWorker", () => {
  it("keeps exact search available before graph init", async () => {
    const worker = new RetrievalWorker({ root: await fixture() });
    await worker.open();
    const result = await worker.search({ query: "retrieval" });
    expect(result.hits.map((hit) => hit.path)).toContain("README.md");
    expect(result.freshness).toBe("unknown");
    await expect(worker.graph({ kind: "query", query: "main" })).resolves.toMatchObject({ status: "unavailable", reason: "INDEX_NOT_INITIALIZED" });
    await worker.close();
  });

  it("does not create the relation store until init or sync", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    const relationPath = path.join(worker.indexDir, "relations.sqlite");
    await worker.open();
    await expect(access(relationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await worker.init();
    await expect(access(relationPath)).resolves.toBeUndefined();
    await worker.close();
  });

  it("falls back when ripgrep reports a dangling symlink", async () => {
    const root = await fixture();
    const dangling = path.join(root, "src", "dangling.ts");
    try {
      await symlink(path.join(root, "src", "missing.ts"), dangling, "file");
    } catch {
      return;
    }
    try {
      const worker = new RetrievalWorker({ root });
      await worker.open();
      const result = await worker.search({ query: "retrieval" });
      expect(result.hits.some((hit) => hit.path === "README.md")).toBe(true);
      expect(result.status).toBe("complete");
      await worker.close();
    } finally {
      await unlink(dangling).catch(() => undefined);
    }
  });

  it("preserves regex hits across fallback lines after an rg filesystem error", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "matches.ts"), "alpha\nbeta\nalpha\n");
    const dangling = path.join(root, "src", "dangling.ts");
    try {
      await symlink(path.join(root, "src", "missing.ts"), dangling, "file");
    } catch {
      return;
    }
    try {
      const worker = new RetrievalWorker({ root });
      await worker.open();
      const result = await worker.search({ query: "alpha|beta", regex: true });
      expect(result.hits.filter((hit) => hit.path === "src/matches.ts").map((hit) => hit.line)).toEqual([1, 2, 3]);
      await worker.close();
    } finally {
      await unlink(dangling).catch(() => undefined);
    }
  });

  it("deduplicates overlapping paths and preserves regex columns on rg fallback merge", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "README.md"), "alpha\nbeta\n");
    const dangling = path.join(root, "src", "dangling.ts");
    try {
      await symlink(path.join(root, "src", "missing.ts"), dangling, "file");
    } catch {
      return;
    }
    try {
      const worker = new RetrievalWorker({ root });
      await worker.open();
      const result = await worker.search({ query: "alpha|beta", regex: true, paths: ["README.md", "./README.md"], maxResults: 2 });
      expect(result.hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`)).toEqual(["README.md:1:alpha", "README.md:2:beta"]);
      expect(result.hits.map((hit) => hit.column)).toEqual([1, 1]);
      await worker.close();
    } finally {
      await unlink(dangling).catch(() => undefined);
    }
  });

  it("deduplicates nested search paths, treats dot as workspace root, and honors ignore files in fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-exact-boundaries-"));
    roots.push(root);
      await mkdir(path.join(root, "config"), { recursive: true });
      await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
      await mkdir(path.join(root, ".ci"), { recursive: true });
      await writeFile(path.join(root, "config", "app.json"), "visible-token\n");
      await writeFile(path.join(root, "config", "app.yaml"), "visible-token\n");
      await writeFile(path.join(root, ".hidden.ts"), "visible-token\n");
      await writeFile(path.join(root, ".github", "workflows", "config.yml"), "visible-token\n");
      await writeFile(path.join(root, ".ci", "visible.yml"), "ci-token\n");
      await writeFile(path.join(root, ".ci", ".hidden.yml"), "ci-token\n");
    await writeFile(path.join(root, "ignored-ignore.txt"), "ignored-token\n");
    await writeFile(path.join(root, "ignored-rg.txt"), "ignored-token\n");
    await writeFile(path.join(root, ".ignore"), "ignored-ignore.txt\n");
    await writeFile(path.join(root, ".rgignore"), "ignored-rg.txt\n");
    const dangling = path.join(root, "dangling.ts");
    try {
      await symlink(path.join(root, "missing.ts"), dangling, "file");
    } catch {
      return;
    }
    try {
      const worker = new RetrievalWorker({ root });
      await worker.open();
      const nested = await worker.search({ query: "visible-token", paths: ["config/app.json", "config/"], maxResults: 2 });
      expect(nested.hits.map((hit) => hit.path)).toEqual(["config/app.json", "config/app.yaml"]);
      const workspace = await worker.search({ query: "visible-token", paths: ["."], maxResults: 2 });
      expect(workspace.hits.map((hit) => hit.path)).toEqual(["config/app.json", "config/app.yaml"]);
      const explicitHidden = await worker.search({ query: "visible-token", paths: [".hidden.ts"], maxResults: 1 });
      expect(explicitHidden.hits.map((hit) => hit.path)).toEqual([".hidden.ts"]);
       const explicitNestedHidden = await worker.search({ query: "visible-token", paths: [".github/workflows/config.yml"], maxResults: 1 });
       expect(explicitNestedHidden.hits.map((hit) => hit.path)).toEqual([".github/workflows/config.yml"]);
        const explicitHiddenDirectory = await worker.search({ query: "ci-token", paths: [".ci"], maxResults: 10 });
        expect(explicitHiddenDirectory.hits.map((hit) => hit.path)).toEqual([".ci/visible.yml"]);
        const ignored = await worker.search({ query: "ignored-token", paths: ["."], maxResults: 10 });
      expect(ignored.hits).toEqual([]);
      await worker.close();
    } finally {
      await unlink(dangling).catch(() => undefined);
    }
  });

  it("enforces maxFileBytes on the ripgrep path", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "large.ts"), `needle\n${"x".repeat(10_000)}\n`);
    const worker = new RetrievalWorker({ root, maxFileBytes: 1_024 });
    await worker.open();
    const result = await worker.search({ query: "needle" });
    expect(result.hits.some((hit) => hit.path === "src/large.ts")).toBe(false);
    await worker.close();
  });

  it("builds a generation and exposes structural symbols", async () => {
    const worker = new RetrievalWorker({ root: await fixture() });
    await worker.init();
    const stats = worker.stats();
    expect(stats.state).toBe("ready");
    expect(stats.generation).toBe(1);
    expect(stats.indexedFiles).toBe(2);
    expect(stats.indexedSymbols).toBeGreaterThanOrEqual(4);
    const graph = await worker.graph({ kind: "query", query: "main" });
    expect(graph.symbols.some((symbol) => symbol.name === "main")).toBe(true);
    const pack = await worker.execute({ query: "main", intents: ["exact", "structural"] });
    expect(pack.candidates.length).toBeGreaterThan(0);
    expect(pack.scope.generation).toBe(1);
    await worker.close();
  });

  it("keeps incremental graph edges scoped and durable", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await writeFile(path.join(root, "src", "new.ts"), "import { main } from './main';\nexport function next() { return main(); }\n");
    await worker.sync();
    const graph = await worker.graph({ kind: "explore", query: "main", depth: 8, maxNodes: 100 });
    const ids = new Set(graph.symbols.map((symbol) => symbol.id));
    expect(graph.edges.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId))).toBe(true);
    await worker.close();
  });

  it("produces a stable pack hash for repeated equivalent executions", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const hashes = await Promise.all(Array.from({ length: 3 }, () => worker.execute({ query: "main", intents: ["exact", "structural"] }).then((pack) => pack.hash)));
    expect(new Set(hashes).size).toBe(1);
    await worker.close();
  });

  it("honors an already-aborted execute signal", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    const controller = new AbortController();
    controller.abort();
    await expect(worker.execute({ query: "main", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await worker.close();
  });

  it("increments generation and removes deleted paths during sync", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await writeFile(path.join(root, "src", "main.ts"), "export function changed(): string { return 'new'; }\n");
    await rm(path.join(root, "src", "helper.ts"));
    const synced = await worker.sync();
    expect(synced.generation).toBe(2);
    expect(synced.changedPaths).toContain("src/main.ts");
    expect(synced.removedPaths).toContain("src/helper.ts");
    expect(worker.stats().indexedFiles).toBe(1);
    const graph = await worker.graph({ kind: "query", query: "helper" });
    expect(graph.symbols.some((symbol) => symbol.name === "helper")).toBe(false);
    await worker.close();
  });

  it("cancels an initial build without publishing a ready generation", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    const controller = new AbortController();
    controller.abort();
    await expect(worker.init({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.stats().generation).toBe(0);
    expect(["absent", "stale"]).toContain(worker.stats().state);
    await worker.close();
  });

  it("keeps the committed generation when an incremental sync is cancelled", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await writeFile(path.join(root, "src", "main.ts"), "export function changed(): string { return 'new'; }\n");
    const controller = new AbortController();
    controller.abort();
    await expect(worker.sync(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.stats().generation).toBe(1);
    expect(["stale", "ready"]).toContain(worker.stats().state);
    await worker.close();
  });

  it("returns inspected source hashes and enforces a safe read seam", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    const read = await worker.read({ path: "src/main.ts", startLine: 1, endLine: 1 });
    expect(read.content).toContain("import");
    expect(read.hash).toHaveLength(64);
    await expect(worker.read({ path: "../outside.ts" })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await worker.close();
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("fixture");
  });

  it("canonicalizes source paths and excludes the relation store from read seams", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await expect(worker.read({ path: "src/../src/main.ts", startLine: 1, endLine: 1 })).resolves.toMatchObject({ path: "src/main.ts" });
    const relationPath = path.relative(root, path.join(worker.indexDir, "relations.sqlite"));
    await expect(worker.read({ path: relationPath })).rejects.toThrow("PATH_NOT_READABLE");
    await expect(worker.inspect(relationPath)).rejects.toThrow("PATH_NOT_READABLE");
    await worker.close();
  });

  it("keeps the RPC-capable seams available when the index is corrupt", async () => {
    const root = await fixture();
    const indexDir = path.join(root, ".pactile", "retrieval", "corrupt");
    await mkdir(indexDir, { recursive: true });
    await writeFile(path.join(indexDir, "relations.sqlite"), "not sqlite");
    const worker = new RetrievalWorker({ root, worktreeId: "corrupt" });
    await worker.open();
    await expect(worker.search({ query: "retrieval" })).resolves.toMatchObject({ status: "complete" });
    await expect(worker.graph({ kind: "query", query: "retrieval" })).resolves.toMatchObject({ status: "unavailable", reason: "INDEX_UNAVAILABLE" });
    expect(worker.stats().state).toBe("degraded");
    await worker.close();
  });

  it("rejects ordinary operations after close until explicitly reopened", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.close();
    await expect(worker.list()).rejects.toThrow("WORKER_NOT_OPEN");
    await expect(worker.search({ query: "fixture" })).rejects.toThrow("WORKER_NOT_OPEN");
    await expect(worker.read({ path: "README.md" })).rejects.toThrow("WORKER_NOT_OPEN");
    await expect(worker.inspect("README.md")).rejects.toThrow("WORKER_NOT_OPEN");
    await expect(worker.graph({ kind: "query", query: "main" })).rejects.toThrow("WORKER_NOT_OPEN");
    await expect(worker.execute({ query: "fixture", intents: ["exact"] })).rejects.toThrow("WORKER_NOT_OPEN");
    expect(() => worker.stats()).toThrow("WORKER_NOT_OPEN");
    await worker.open();
    await expect(worker.list()).resolves.toContain("src/main.ts");
    await worker.close();
  });

  it("rejects symlink paths that resolve outside the workspace", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const OUTSIDE_MARKER = 'secret';\n");
    try {
      await symlink(outside, path.join(root, "src", "escapedir"), "junction");
    } catch {
      return;
    }
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await expect(worker.read({ path: "src/escapedir/secret.ts" })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await expect(worker.inspect("src/escapedir/secret.ts")).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await expect(worker.search({ query: "OUTSIDE_MARKER", paths: ["src/escapedir"] })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await expect(worker.execute({ query: "OUTSIDE_MARKER", paths: ["src/escapedir"], intents: ["exact"] })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await worker.close();
  });

  it("rejects search paths outside the workspace and emits source facts", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await expect(worker.search({ query: "fixture", paths: ["../outside"] })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    const pack = await worker.execute({ query: "main", intents: ["exact"] });
    expect(pack.facts.length).toBeGreaterThan(0);
    expect(pack.facts[0]?.hash).toHaveLength(64);
    await worker.close();
  });

  it("accepts an asynchronous DecisionProvider without changing the worker seam", async () => {
    const root = await fixture();
    const receipt: DecisionReceipt = {
      provider: "heuristic",
      intents: ["exact"],
      parallel: false,
      earlyStop: false,
      maxCandidates: 3,
      maxBytes: 32 * 1024,
      maxNodes: 10,
      timeoutMs: 5_000,
      rationale: ["test provider"],
      createdAt: new Date().toISOString(),
    };
    const provider: DecisionProvider = { decide: async () => receipt };
    const worker = new RetrievalWorker({ root, decisionProvider: provider });
    const pack = await worker.execute({ query: "retrieval" });
    expect(pack.decision.maxCandidates).toBe(3);
    expect(pack.budget.maxBytes).toBe(32 * 1024);
    await worker.close();
  });

  it("clamps an injected provider to caller-requested budget bounds", async () => {
    const root = await fixture();
    const provider: DecisionProvider = {
      decide: () => ({
        provider: "heuristic",
        intents: ["exact"],
        parallel: false,
        earlyStop: false,
        maxCandidates: 13,
        maxBytes: 4_097,
        maxNodes: 34,
        timeoutMs: 2_501,
        rationale: ["over caller bounds"],
        createdAt: new Date().toISOString(),
      }),
    };
    const worker = new RetrievalWorker({ root, decisionProvider: provider });
    const pack = await worker.execute({ query: "fixture", intents: ["exact"], maxCandidates: 12, maxBytes: 4_096, maxNodes: 33, timeoutMs: 2_500 });
    expect(pack.decision.maxCandidates).toBe(12);
    expect(pack.decision.maxBytes).toBe(4_096);
    expect(pack.decision.maxNodes).toBe(33);
    expect(pack.decision.timeoutMs).toBe(2_500);
    await worker.close();
  });

  it("clamps an injected provider receipt before execution", async () => {
    const root = await fixture();
    const provider: DecisionProvider = {
      decide: () => ({
        provider: "heuristic",
        intents: ["structural"],
        parallel: true,
        earlyStop: true,
        maxCandidates: 0,
        maxBytes: 1,
        maxNodes: 0,
        timeoutMs: 1,
        rationale: ["untrusted"],
        createdAt: new Date().toISOString(),
      }),
    };
    const worker = new RetrievalWorker({ root, decisionProvider: provider });
    const pack = await worker.execute({ query: "main" });
    expect(pack.decision.intents).toEqual(["exact", "structural"]);
    expect(pack.budget.maxCandidates).toBe(1);
    expect(pack.budget.maxBytes).toBe(256);
    expect(pack.budget.maxNodes).toBe(1);
    expect(pack.decision.timeoutMs).toBe(20);
    await worker.close();
  });

  it("terminates the whole rg process tree when a deadline expires", async () => {
    // Regression: `child.kill()` only signals the DIRECT child. On hosts where `rg` on PATH is a
    // launcher (the scoop shim is a 136 KB wrapper around the 4.2 MB real binary; `.cmd`/`.bat`
    // shims behave the same), the wrapper exits immediately and the real ripgrep keeps scanning as
    // an orphaned grandchild. This drives a REAL rg into an expired deadline and asserts that no
    // process the search created is still alive afterwards.
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-treekill-"));
    roots.push(root);
    for (let index = 0; index < 400; index += 1) {
      await writeFile(path.join(root, `f${String(index).padStart(4, "0")}.md`), `# file ${index}\n\nTREEKILLMARK item ${index}\n`);
    }

    const processTable = (): Map<number, number> => {
      const output = spawnSync("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='rg.exe'\" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
        { encoding: "utf8", windowsHide: true });
      const table = new Map<number, number>();
      if (!output.stdout) return table;
      const parsed = JSON.parse(output.stdout);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) table.set(Number(row.ProcessId), Number(row.ParentProcessId));
      return table;
    };
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

    const before = new Set(processTable().keys());
    const worker = new RetrievalWorker({ root });
    const result = await worker.search({ query: "TREEKILLMARK", maxResults: 5, timeoutMs: 1 });
    await worker.close();
    expect(result.status).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 600));

    const created = [...processTable().entries()].filter(([pid]) => !before.has(pid));
    const survivors = created.filter(([pid]) => alive(pid));
    // Clean up anything this test left behind, by exact PID only.
    for (const [pid] of survivors) spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    expect(survivors.map(([pid, parentPid]) => `${pid}<-${parentPid}`)).toEqual([]);
  }, 30_000);

  it("resolves native call and dependency relations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-graph-"));
    roots.push(root);
    await writeFile(path.join(root, "base.ts"), "export class Base {}\n");
    await writeFile(path.join(root, "child.ts"), "import { Base } from './base';\nexport class Child extends Base { method() { return helper(); } }\nfunction helper() { return 'ok'; }\n");
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const callees = await worker.graph({ kind: "callees", query: "method" });
    expect(callees.edges.some((edge) => edge.kind === "call")).toBe(true);
    const dependencies = await worker.graph({ kind: "dependency", query: "child" });
    expect(dependencies.edges.some((edge) => edge.kind === "dependency" || edge.kind === "import")).toBe(true);
    await worker.close();
  });

  it("resolves graph relations through imports without global-name ghosts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-scope-"));
    roots.push(root);
    await mkdir(path.join(root, "core"), { recursive: true });
    await mkdir(path.join(root, "aaa"), { recursive: true });
    await writeFile(path.join(root, "core", "base.ts"), "export class Named {}\nexport class RemoteBase {}\n");
    await writeFile(path.join(root, "aaa", "named.ts"), "export class Named {}\n");
    await writeFile(path.join(root, "child.ts"), "import { Named } from './core/base';\nexport class Child extends Named { method() { return helper(); } }\nfunction helper() { return 'ok'; }\n");
    await writeFile(path.join(root, "ghost.ts"), "export class Ghost extends RemoteBase {}\nfunction helper() { return 'ghost'; }\n");
    await writeFile(path.join(root, "noise.ts"), "const text = \"import { Named } from './aaa/named'\";\nexport interface Run { run(): void; }\nmodule.exports = text;\n");
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const graph = await worker.graph({ kind: "explore", query: "Named", depth: 8, maxNodes: 100 });
    const edges = graph.edges;
    expect(edges.some((edge) => edge.targetId === "core/base.ts::class:Named:1")).toBe(true);
    expect(edges.some((edge) => edge.targetId === "aaa/named.ts::class:Named:1")).toBe(false);
    expect(edges.some((edge) => edge.targetId === "core/base.ts::class:RemoteBase:2" && edge.sourceId.startsWith("ghost.ts::"))).toBe(false);
    expect(edges.some((edge) => edge.targetId.includes("ghost.ts::function:helper"))).toBe(false);
    expect(graph.symbols.some((symbol) => symbol.path === "noise.ts" && symbol.name === "exports")).toBe(false);
    expect(edges.some((edge) => edge.sourceId === "noise.ts::interface:Run:2" && edge.kind === "call")).toBe(false);
    await worker.close();
  });

  it("extracts annotated methods, arrow bodies, scoped parameters, and require bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-graph-scope-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "helpers.ts"), "export function formatName(value: string): string { return value; }\n");
    await writeFile(path.join(root, "src", "annotated.ts"), `class LocalBase {
  base(): string { return "base"; }
}
class LocalChild extends LocalBase {
  child(): string { return this.base(); }
}
function invoke(render: () => string): string { return render(); }
function helper(): string { return "helper"; }
const arrow = (): string => { return helper(); };
const singleArrow = value => helper();
`);
    await writeFile(path.join(root, "src", "legacy.js"), `const { formatName } = require("./helpers");
function legacyMain() { return formatName("legacy"); }
`);
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const child = await worker.graph({ kind: "callees", query: "child", depth: 1 });
    expect(child.edges.some((edge) => edge.targetId.includes("::method:base:"))).toBe(true);
    const invoke = await worker.graph({ kind: "callees", query: "invoke", depth: 1 });
    expect(invoke.edges.some((edge) => edge.targetId.includes("::method:render:"))).toBe(false);
    const arrow = await worker.graph({ kind: "callees", query: "arrow", depth: 1 });
    expect(arrow.edges.some((edge) => edge.targetId.includes("::function:helper:"))).toBe(true);
    const singleArrow = await worker.graph({ kind: "callees", query: "singleArrow", depth: 1 });
    expect(singleArrow.edges.some((edge) => edge.targetId.includes("::function:helper:"))).toBe(true);
    const legacy = await worker.graph({ kind: "callees", query: "legacyMain", depth: 1 });
    expect(legacy.edges.some((edge) => edge.targetId.includes("helpers.ts::function:formatName:"))).toBe(true);
    const empty = await worker.graph({ kind: "query", query: "" });
    expect(empty.symbols).toEqual([]);
    expect(empty.reason).toBe("empty query");
    await worker.close();
  });

  it("records rename pairs while preserving a fresh generation", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await renameFile(path.join(root, "src", "main.ts"), path.join(root, "src", "renamed.ts"));
    const synced = await worker.sync();
    expect(synced.renamedPaths).toEqual([{ from: "src/main.ts", to: "src/renamed.ts" }]);
    expect(worker.stats().state).toBe("ready");
    await worker.close();
  });

  it("publishes parser diagnostics as degraded in the committed generation", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "broken.ts"), "export function broken() {\u0000\n");
    const worker = new RetrievalWorker({ root });
    const scope = await worker.init();
    expect(scope.freshness).toBe("unknown");
    expect(worker.stats().state).toBe("degraded");
    await worker.close();
    const reopened = new RetrievalWorker({ root });
    const restored = await reopened.open();
    expect(restored.freshness).toBe("unknown");
    expect(reopened.stats().state).toBe("degraded");
    await reopened.close();
  });

  it("supports an OpenAI-compatible semantic DecisionProvider through an injected fetch", async () => {
    const provider = new HttpDecisionProvider({
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "https://provider.invalid/v1",
      fetchImpl: async (_input, _init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: ["structural"], parallel: true, earlyStop: true, maxCandidates: 7, maxBytes: 4096, maxNodes: 12, timeoutMs: 5000, rationale: ["semantic test"] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const receipt = await provider.decide({ query: "find callers" });
    expect(receipt.provider).toBe("semantic");
    expect(receipt.intents).toEqual(["exact", "structural"]);
    expect(receipt.maxCandidates).toBe(7);
  });

  it("supports the native Jev/System One DecisionProvider protocol", async () => {
    const provider = new SystemOneDecisionProvider({
      apiKey: "test-key",
      endpoint: "http://provider.invalid/v1/systemone",
      fetchImpl: async (input, _init) => {
        if (String(input).endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok", model: "typesafe/jev" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          model: "typesafe/jev",
          answers: {
            retrieval_intent: { type: "choice", choice: "structural", probabilities: { exact: 0.1, structural: 0.9 }, confidence: 0.9 },
            parallel: { type: "noul", noul: 0.8 },
            early_stop: { type: "noul", noul: 0.7 },
          },
        }), { status: 200 });
      },
    });
    const receipt = await provider.decide({ query: "find callers" });
    expect(receipt.provider).toBe("semantic");
    expect(receipt.intents).toEqual(["exact", "structural"]);
    expect(receipt.parallel).toBe(true);
    expect(receipt.earlyStop).toBe(true);
    expect(receipt.rationale[0]).toContain("typesafe/jev");
  });

  it("normalizes invalid System One JSON as a typed provider error", async () => {
    const provider = new SystemOneDecisionProvider({
      apiKey: "test-key",
      endpoint: "http://provider.invalid/v1/systemone",
      fetchImpl: async (input) => new Response(String(input).endsWith("/health") ? JSON.stringify({ model: "typesafe/jev" }) : "<html>gateway error</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    await expect(provider.decide({ query: "find callers" })).rejects.toThrow("DECISION_PROVIDER_INVALID_JSON");
  });

  it("does not create symbols from comments or string literals", () => {
    const parsed = parseFile("src/native.ts", "const text = 'function fake()'; // class fake {}\nexport function real() {}\n");
    expect(parsed.symbols.some((symbol) => symbol.name === "fake")).toBe(false);
    expect(parsed.symbols.some((symbol) => symbol.name === "real")).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------- */
/* D22 — an explicitly named operand overrides the ignore files ABOVE it, exactly like rg.     */
/* ---------------------------------------------------------------------------------------- */

const D22_TOKEN = "D22REGTOK";
const D22_DEFAULT_IGNORES = [".git", ".pactile/retrieval", "node_modules", "dist", "build", "coverage", ".venv", "__pycache__", "*.min.js", "*.map"];

/** Mirrors the candidate's own `isIgnored` post-filter for the ripgrep arm (util.ts). */
function d22PostFilter(relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return D22_DEFAULT_IGNORES.some((pattern) => (pattern.includes("*")
    ? normalized.endsWith(pattern.replace("*", ""))
    : normalized === pattern || normalized.startsWith(`${pattern}/`) || parts.includes(pattern)));
}

/** The candidate's ripgrep argv shape, restated independently so the oracle cannot drift with it. */
function d22OracleArgs(query: string, paths: readonly string[] | undefined): string[] {
  return [
    "--no-heading", "--line-number", "--color", "never",
    "--max-count", "500", "--sort", "path", "--with-filename", "--ignore-case", "--fixed-strings",
    "--glob", "!.git/**", "--glob", "!.pactile/retrieval/**", "--glob", "!node_modules/**",
    "--glob", "!dist/**", "--glob", "!build/**", "--glob", "!coverage/**", "--glob", "!.venv/**",
    "--glob", "!__pycache__/**", "--glob", "!*.min.js", "--glob", "!*.map",
    "--", query, ...(paths?.length ? paths : ["."]),
  ];
}

function realRipgrepAvailable(): boolean {
  const probe = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0;
}

/** Real-ripgrep oracle: same argv, same ignore post-filter, no dangling links in this fixture. */
function d22Oracle(root: string, paths: readonly string[] | undefined): string[] {
  const result = spawnSync("rg", d22OracleArgs(D22_TOKEN, paths), { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  expect([0, 1]).toContain(result.status);
  const paths_ = new Set<string>();
  for (const line of (result.stdout ?? "").split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const relative = line.slice(0, separator).replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!d22PostFilter(relative)) paths_.add(relative);
  }
  return [...paths_].sort();
}

/** Fixture with no dangling links, so real ripgrep exits 0/1 and every arm is a pure comparison. */
async function d22Fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d22-"));
  roots.push(root);
  const write = async (relative: string, content: string): Promise<void> => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  };
  await write(".gitignore", ["# d22 fixture", "ignored-dir/", "plainrule.md", "*.log", "!keep.log", "pat.txt", "nested-ign/", "/root-only.md", "ignored-file.md", ""].join("\n"));
  // ripgrep only applies .gitignore/.ignore-family rules inside a git repository
  // (`--no-require-git` is not part of the candidate's argv), and the frozen evaluation fixtures all
  // ship a `.git` directory for the same reason. Without it this oracle would silently measure the
  // no-ignore behaviour of rg and the test would pass vacuously.
  await write(".git/HEAD", "ref: refs/heads/main\n");
  await write(".ignore", ["dotignore-dir/", "dotignored.md", ""].join("\n"));
  await write(".rgignore", ["rgignore-dir/", "rgonly.md", ""].join("\n"));
  for (const relative of [
    "normal.md", "ignored-file.md", "root-only.md", "skip.log", "keep.log", "dotignored.md", "rgonly.md",
    "plainrule.md", "pat.txt", "sub/pat.txt", "sub/other.txt", "nested-ign/deep.md",
    "node_modules/pkg.md", "dist/bundle.js", ".pactile/retrieval/canary.txt",
    "ignored-dir/a.md", "ignored-dir/logs/x.log", "ignored-dir/plainrule.md", "ignored-dir/pat.txt",
    "ignored-dir/nested/d.md", "dotignore-dir/x.md", "rgignore-dir/w.md",
  ]) await write(relative, `d22 ${D22_TOKEN} ${relative}\n`);
  // A nested ignore file BELOW an ignored directory: the operand exempts only the entry it names.
  await write("ignored-dir/nested/.gitignore", "c.md\n");
  await write("ignored-dir/nested/c.md", `d22 ${D22_TOKEN} ignored-dir/nested/c.md\n`);
  return root;
}

const D22_CASES: readonly { readonly id: string; readonly paths: readonly string[] | undefined; readonly expected: readonly string[]; readonly note: string }[] = [
  { id: "whole-tree-no-operand", paths: undefined, expected: ["keep.log", "normal.md", "sub/other.txt"], note: "traversal without operands still honours every ignore rule" },
  { id: "whole-tree-dot-operand", paths: ["."], expected: ["keep.log", "normal.md", "sub/other.txt"], note: ". is the workspace root, not an ignore override" },
  { id: "gitignored-explicit-dir", paths: ["ignored-dir"], expected: ["ignored-dir/a.md", "ignored-dir/nested/d.md"], note: "explicit dir operand overrides the ancestor-only rule" },
  { id: "gitignored-explicit-dir-trailing-slash", paths: ["ignored-dir/"], expected: ["ignored-dir/a.md", "ignored-dir/nested/d.md"], note: "trailing slash keeps the operand semantics" },
  { id: "gitignored-explicit-file", paths: ["ignored-dir/a.md"], expected: ["ignored-dir/a.md"], note: "explicit file operand below an ignored directory" },
  { id: "gitignored-explicit-file-at-root", paths: ["ignored-file.md"], expected: ["ignored-file.md"], note: "explicit file operand named by its own rule" },
  { id: "dotignore-explicit-dir", paths: ["dotignore-dir"], expected: ["dotignore-dir/x.md"], note: ".ignore rules are overridden the same way" },
  { id: "rgignore-explicit-dir", paths: ["rgignore-dir"], expected: ["rgignore-dir/w.md"], note: ".rgignore rules are overridden the same way" },
  { id: "dotignore-explicit-file", paths: ["dotignored.md"], expected: ["dotignored.md"], note: ".ignore file rule overridden" },
  { id: "rgignore-explicit-file", paths: ["rgonly.md"], expected: ["rgonly.md"], note: ".rgignore file rule overridden" },
  { id: "suffix-rule-explicit-file", paths: ["pat.txt"], expected: ["pat.txt"], note: "a root suffix rule does not survive an explicit operand" },
  { id: "negated-file-operand", paths: ["keep.log"], expected: ["keep.log"], note: "negation still works for operands" },
  { id: "glob-rule-explicit-log", paths: ["skip.log"], expected: ["skip.log"], note: "*.log is overridden for the named operand" },
  { id: "nested-rule-under-operand-dir", paths: ["ignored-dir/nested"], expected: ["ignored-dir/nested/d.md"], note: "a .gitignore INSIDE the operand still applies to its children" },
  { id: "nested-rule-explicit-file", paths: ["ignored-dir/nested/c.md"], expected: ["ignored-dir/nested/c.md"], note: "the operand itself is exempt even from a nested rule" },
  { id: "sibling-rule-below-operand-dir", paths: ["ignored-dir"], expected: ["ignored-dir/a.md", "ignored-dir/nested/d.md"], note: "sibling *.log / pat.txt rules still prune below the operand" },
  { id: "sibling-rule-below-operand-file", paths: ["ignored-dir/plainrule.md"], expected: ["ignored-dir/plainrule.md"], note: "the named file is exempt; its siblings are not searched" },
  { id: "sibling-rule-below-dir-operand", paths: ["sub"], expected: ["sub/other.txt"], note: "pat.txt stays ignored below the operand, other.txt is found" },
  { id: "second-ignored-dir-operand", paths: ["nested-ign"], expected: ["nested-ign/deep.md"], note: "a directory named by a directory rule" },
  { id: "default-ignore-node-modules", paths: ["node_modules"], expected: [], note: "DEFAULT_IGNORES wins over an explicit operand in BOTH engines" },
  { id: "default-ignore-node-modules-file", paths: ["node_modules/pkg.md"], expected: [], note: "DEFAULT_IGNORES file operand" },
  { id: "default-ignore-dist", paths: ["dist"], expected: [], note: "DEFAULT_IGNORES dist" },
  { id: "default-ignore-index-dir", paths: [".pactile/retrieval"], expected: [], note: "the worker index directory stays excluded" },
  { id: "default-ignore-index-file", paths: [".pactile/retrieval/canary.txt"], expected: [], note: "the worker index file stays excluded" },
];

describe("RetrievalWorker D22 — explicit operands override the ignore files above them", () => {
  it("matches real ripgrep on every explicit-operand scenario in both engines", async () => {
    const root = await d22Fixture();
    const oracleAvailable = realRipgrepAvailable();
    for (const testCase of D22_CASES) {
      const expected = [...testCase.expected];
      if (oracleAvailable) {
        // Oracle first: express the contract as real rg's answer, not as the candidate's answer.
        expect({ id: testCase.id, oracle: d22Oracle(root, testCase.paths) }).toEqual({ id: testCase.id, oracle: expected });
      }
      const rg = await searchWithEngine(root, "real", { query: D22_TOKEN, paths: testCase.paths });
      const fallback = await searchWithEngine(root, "enoent", { query: D22_TOKEN, paths: testCase.paths });
      expect({ id: testCase.id, note: testCase.note, engine: "rg", paths: rg.paths }).toEqual({ id: testCase.id, note: testCase.note, engine: "rg", paths: expected });
      expect({ id: testCase.id, note: testCase.note, engine: "fallback", paths: fallback.paths }).toEqual({ id: testCase.id, note: testCase.note, engine: "fallback", paths: expected });
      expect({ id: testCase.id, status: fallback.status }).toEqual({ id: testCase.id, status: rg.status });
    }
  }, 120_000);

  it("keeps DEFAULT_IGNORES, the index and the workspace boundary hard in both engines", async () => {
    const root = await d22Fixture();
    for (const paths of [["node_modules"], ["dist"], [".pactile/retrieval"], ["node_modules/pkg.md"], [".pactile/retrieval/canary.txt"]]) {
      for (const mode of ["real", "enoent"] as const) {
        const observed = await searchWithEngine(root, mode, { query: D22_TOKEN, paths });
        expect({ paths, mode, hits: observed.hits }).toEqual({ paths, mode, hits: 0 });
      }
    }
  }, 60_000);

  it("does not let an explicit operand widen into other ignored directories", async () => {
    const root = await d22Fixture();
    // Naming one ignored directory must not expose a second one that was not named.
    const onlyGitignored = await searchWithEngine(root, "enoent", { query: D22_TOKEN, paths: ["ignored-dir"] });
    expect(onlyGitignored.paths).toEqual(["ignored-dir/a.md", "ignored-dir/nested/d.md"]);
    expect(onlyGitignored.paths.some((entry) => entry.startsWith("dotignore-dir/") || entry.startsWith("rgignore-dir/"))).toBe(false);
    const mixed = await searchWithEngine(root, "enoent", { query: D22_TOKEN, paths: ["ignored-dir", "normal.md"] });
    expect(mixed.paths).toEqual(["ignored-dir/a.md", "ignored-dir/nested/d.md", "normal.md"]);
  }, 60_000);

  it("keeps read() and inspect() consistent with search() for explicitly named ignored paths", async () => {
    const root = await d22Fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    // Explicitly named ignored paths stay READABLE (they were never governed by user ignore files).
    for (const relative of ["ignored-file.md", "ignored-dir/a.md", "dotignored.md", "dotignore-dir/x.md", "rgonly.md", "rgignore-dir/w.md", "nested-ign/deep.md", "ignored-dir/nested/c.md"]) {
      await expect(worker.read({ path: relative, maxBytes: 4096 })).resolves.toMatchObject({ path: relative });
      await expect(worker.inspect(relative)).resolves.toMatchObject({ path: relative, exists: true });
    }
    // DEFAULT_IGNORES and the worker index stay unreadable through exactly the same seam.
    for (const relative of ["node_modules/pkg.md", "dist/bundle.js", ".pactile/retrieval/canary.txt", ".pactile/retrieval"]) {
      await expect(worker.read({ path: relative })).rejects.toThrow("PATH_NOT_READABLE");
      await expect(worker.inspect(relative)).rejects.toThrow("PATH_NOT_READABLE");
    }
    // And the paths read() accepts are exactly the paths search() can return for a matching operand.
    const explicit = await searchWithEngine(root, "enoent", { query: D22_TOKEN, paths: ["ignored-dir", "dotignore-dir", "rgignore-dir", "nested-ign"] });
    expect(explicit.paths).toEqual(["dotignore-dir/x.md", "ignored-dir/a.md", "ignored-dir/nested/d.md", "nested-ign/deep.md", "rgignore-dir/w.md"]);
    for (const relative of explicit.paths) await expect(worker.inspect(relative)).resolves.toMatchObject({ exists: true });
    await worker.close();
  }, 60_000);
});

/* ---------------------------------------------------------------------------------------- */
/* D23 — graph() validates its `path` operand exactly like read()/inspect().                  */
/* ---------------------------------------------------------------------------------------- */

async function d23Fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d23-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d23-outside-"));
  roots.push(root, outside);
  await writeFile(path.join(outside, "secret.ts"), "export function outsideSecret(): string { return 'x'; }\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "other"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".pactile", "retrieval"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), "export function alphaFn(): string { return 'a'; }\n");
  await writeFile(path.join(root, "src", "beta.ts"), "export function betaFn(): string { return 'b'; }\n");
  await writeFile(path.join(root, "other", "gamma.ts"), "export function gammaFn(): string { return 'g'; }\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "exports.modFn = function modFn() {};\n");
  await writeFile(path.join(root, ".pactile", "retrieval", "canary.txt"), "index canary\n");
  try { await symlink(outside, path.join(root, "escape-dir"), "junction"); } catch { /* link unsupported */ }
  try { await symlink(path.join(outside, "secret.ts"), path.join(root, "escape-file.ts"), "file"); } catch { /* link unsupported */ }
  try { await symlink(path.join(root, "src"), path.join(root, "inside-link"), "junction"); } catch { /* link unsupported */ }
  return { root, outside };
}

describe("RetrievalWorker D23 — graph() validates its path operand", () => {
  it("rejects out-of-workspace and restricted paths with read()'s own error codes", async () => {
    const { root, outside } = await d23Fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.init();
    const outsideWorkspace: readonly string[] = ["../outside-secret.txt", "../../", outside, `${outside.replaceAll("\\", "/")}/secret.ts`, "escape-dir", "escape-dir/secret.ts", "escape-file.ts", "\\\\?\\D:\\", ".."];
    for (const operand of outsideWorkspace) {
      await expect(worker.graph({ kind: "query", query: "Fn", path: operand })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
      await expect(worker.read({ path: operand })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    }
    const restricted: readonly string[] = ["node_modules", "node_modules/pkg/index.js", ".pactile/retrieval", ".pactile/retrieval/canary.txt", "dist"];
    for (const operand of restricted) {
      await expect(worker.graph({ kind: "query", query: "Fn", path: operand })).rejects.toThrow("PATH_NOT_READABLE");
      await expect(worker.read({ path: operand })).rejects.toThrow("PATH_NOT_READABLE");
      await expect(worker.inspect(operand)).rejects.toThrow("PATH_NOT_READABLE");
    }
    await worker.close();
  }, 60_000);

  it("rejects an illegal path the same way even when the index is absent or the query is empty", async () => {
    const { root } = await d23Fixture();
    const fresh = new RetrievalWorker({ root });
    await fresh.open();
    for (const operand of ["../outside-secret.txt", "node_modules", ".pactile/retrieval"]) {
      const expected = operand === "node_modules" || operand === ".pactile/retrieval" ? "PATH_NOT_READABLE" : "PATH_OUTSIDE_WORKSPACE";
      await expect(fresh.graph({ kind: "query", query: "Fn", path: operand })).rejects.toThrow(expected);
      await expect(fresh.graph({ kind: "query", query: "", path: operand })).rejects.toThrow(expected);
      await expect(fresh.graph({ kind: "explore", query: "Fn", path: operand })).rejects.toThrow(expected);
    }
    // A legal path still answers normally before the index exists.
    await expect(fresh.graph({ kind: "query", query: "Fn", path: "src" })).resolves.toMatchObject({ status: "unavailable", reason: "INDEX_NOT_INITIALIZED" });
    await fresh.close();
  }, 60_000);

  it("keeps legal in-workspace operands working and never throws for missing paths", async () => {
    const { root } = await d23Fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.init();
    // Named file operand: scoped to that file.
    await expect(worker.graph({ kind: "query", query: "Fn", path: "src/alpha.ts" })).resolves.toMatchObject({ status: "complete" });
    const scoped = await worker.graph({ kind: "query", query: "Fn", path: "src/alpha.ts" });
    expect([...new Set(scoped.symbols.map((symbol) => symbol.path))]).toEqual(["src/alpha.ts"]);
    // Normalized spelling of the same operand gives the same answer (search() already canonicalized).
    const normalized = await worker.graph({ kind: "query", query: "Fn", path: "src/../src/alpha.ts" });
    expect([...new Set(normalized.symbols.map((symbol) => symbol.path))]).toEqual(["src/alpha.ts"]);
    // A symlink that stays inside the workspace resolves to its real target, like read()/search().
    const throughLink = await worker.graph({ kind: "query", query: "Fn", path: "inside-link/alpha.ts" });
    expect([...new Set(throughLink.symbols.map((symbol) => symbol.path))]).toEqual(["src/alpha.ts"]);
    // Directories and the workspace root keep their historical "no path scope" answer (never a throw).
    for (const operand of ["src", "src/", "other", "inside-link", ".", "./", ""]) {
      const result = await worker.graph({ kind: "query", query: "Fn", path: operand });
      expect({ operand, status: result.status }).toEqual({ operand, status: "complete" });
    }
    // Deleted / never-existing workspace paths resolve (missing tail tolerated) and report no symbols.
    for (const operand of ["src/does-not-exist.ts", "no-such-dir", "no-such-dir/deeper/file.ts"]) {
      const result = await worker.graph({ kind: "query", query: "Fn", path: operand });
      expect({ operand, status: result.status, symbols: result.symbols.length }).toEqual({ operand, status: "complete", symbols: 0 });
    }
    // A hidden path is not a DEFAULT_IGNORES path: it stays queryable, exactly as before.
    await expect(worker.graph({ kind: "query", query: "Fn", path: ".pactile" })).resolves.toMatchObject({ status: "complete" });
    await worker.close();
  }, 60_000);

  it("does not fail execute() through graph()'s re-validation", async () => {
    const { root } = await d23Fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.init();
    for (const paths of [undefined, ["src"], ["src/alpha.ts"], ["node_modules"], [".pactile/retrieval"], ["node_modules", "src"], ["other"]]) {
      const pack = await worker.execute({ query: "alphaFn", intents: ["exact", "structural"], maxCandidates: 20, paths });
      expect({ paths, threw: false }).toEqual({ paths, threw: false });
      expect(pack.packVersion).toBe(1);
      if (paths?.[0] === "src" || paths?.[0] === "src/alpha.ts") {
        expect(pack.candidates.some((candidate) => candidate.path.startsWith("src/"))).toBe(true);
      }
    }
    // Out-of-workspace operands must still be rejected by execute().
    await expect(worker.execute({ query: "alphaFn", intents: ["exact"], paths: ["../outside"] })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await worker.close();
  }, 60_000);
});

/* ---------------------------------------------------------------------------------------- */
/* D24 — a running watcher over a root that no longer exists must not report a healthy       */
/* "running" state with lastError:null. These are real behaviour tests: they start a real     */
/* watcher, really delete the root, and really stub node:fs.watch.                            */
/* ---------------------------------------------------------------------------------------- */

/** The CommonJS view of node:fs — the same object `syncBuiltinESMExports()` re-syncs named ESM bindings from. */
const fsMutable = createRequire(import.meta.url)("node:fs") as unknown as { watch: typeof watch };

/** Replace node:fs.watch with a throwing stub; returns a restore function. */
function stubWatchToThrow(): () => void {
  const realWatch = fsMutable.watch;
  fsMutable.watch = function injectedWatch(): never {
    const error = new Error("fs.watch is not available on this platform (test stub)") as NodeJS.ErrnoException;
    error.code = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
    throw error;
  } as unknown as typeof watch;
  syncBuiltinESMExports();
  return () => { fsMutable.watch = realWatch; syncBuiltinESMExports(); };
}

/** Poll until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("RetrievalWorker D24 — watcher status stays explainable", () => {
  it("reports a degraded watcher with a watcher:-prefixed error when root removal makes it useless", async () => {
    const root = await fixture();
    const indexDir = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d24-index-"));
    roots.push(indexDir);
    const worker = new RetrievalWorker({ root, indexDir });
    await worker.open();
    await worker.init();
    worker.startWatcher(50);
    const healthy = worker.stats();
    expect(healthy.watcher).toBe("running");
    expect(healthy.state).toBe("ready");

    // Really delete the watched root and verify it is gone.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => statSync(root)).toThrow();

    const after = worker.stats();
    // The exact remedy is the candidate's choice; the contract is that a "running" watcher with no
    // error can never coexist with a root that provably does not exist.
    const unexplained = after.watcher === "running" && after.lastError === null && after.state === "ready";
    expect(unexplained).toBe(false);
    expect(after.watcher).toBe("stopped");
    expect(after.state).toBe("degraded");
    expect(after.lastError).toMatch(/^watcher:/u);
    // The degradation must be durable, not a one-off reading.
    const again = worker.stats();
    expect(again.watcher).toBe("stopped");
    expect(again.lastError).toMatch(/^watcher:/u);
    await worker.close();
  }, 60_000);

  it("degrades without throwing when node:fs.watch cannot be created at all", async () => {
    const root = await fixture();
    const restore = stubWatchToThrow();
    try {
      const worker = new RetrievalWorker({ root });
      await worker.open();
      expect(() => worker.startWatcher(50)).not.toThrow();
      const stats = worker.stats();
      expect(stats.state).toBe("degraded");
      expect(stats.lastError).toMatch(/^watcher:/u);
      expect(stats.watcher).toBe("stopped");
      // The rest of the worker stays usable after a failed watcher creation.
      await expect(worker.search({ query: "retrieval" })).resolves.toMatchObject({ status: "complete" });
      await expect(worker.read({ path: "README.md" })).resolves.toMatchObject({ path: "README.md" });
      await worker.close();
    } finally {
      restore();
    }
  }, 60_000);

  it("still syncs on a real change while the root exists", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.init();
    expect(worker.stats().generation).toBe(1);
    worker.startWatcher(50);
    await writeFile(path.join(root, "src", "added.ts"), "export function added(): string { return 'added'; }\n");
    const synced = await waitFor(() => worker.stats().generation > 1);
    expect(synced).toBe(true);
    expect(worker.stats().watcher).toBe("running");
    expect(worker.stats().lastError).toBeNull();
    const graph = await worker.graph({ kind: "query", query: "added" });
    expect(graph.symbols.some((symbol) => symbol.name === "added")).toBe(true);
    await worker.close();
  }, 60_000);

  it("reports stopped after stopWatcher and leaves no watcher-derived degradation", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    await worker.init();
    worker.startWatcher(50);
    expect(worker.stats().watcher).toBe("running");
    expect(worker.stats().state).toBe("ready");
    worker.stopWatcher();
    const stopped = worker.stats();
    expect(stopped.watcher).toBe("stopped");
    // An intentional stop is not a watcher failure: no `watcher:` error, no forced degradation.
    expect(stopped.lastError).toBeNull();
    expect(stopped.state).toBe("ready");
    await worker.close();
    // close() semantics are unchanged: the worker is absent again and the watcher stays stopped.
    await worker.open();
    expect(worker.stats().watcher).toBe("stopped");
    await worker.close();
  }, 60_000);
});

/* ---------------------------------------------------------------------------------------- */
/* D25–D33 — regression suite for the second defect round.                                    */
/* Each test reproduces the exact observable the audit reported, so a regression cannot pass. */
/* ---------------------------------------------------------------------------------------- */

describe("RetrievalWorker D25 — a call in an arrow-callback body is not a method declaration", () => {
  it("keeps the imported callee as the only call target of the enclosing function", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d25-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "util.ts"), "export function helperOne(value: number): number {\n  return value + 1;\n}\n");
    await writeFile(path.join(root, "src", "callback.ts"), [
      "import { helperOne } from \"./util\";",
      "",
      "export function withCallback(values: number[]): number {",
      "  return values.map((value) => helperOne(value)).reduce((left, right) => left + right, 0);",
      "}",
      "",
    ].join("\n"));
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const graph = await worker.graph({ kind: "explore", query: "helperOne", maxNodes: 500, depth: 8 });
    // The phantom symbol that used to be minted from the callback body must not exist at all.
    expect(graph.symbols.some((symbol) => symbol.path === "src/callback.ts" && symbol.name === "helperOne")).toBe(false);
    expect(graph.edges.some((edge) => edge.sourceId.startsWith("src/callback.ts") && edge.targetId.startsWith("src/callback.ts"))).toBe(false);
    // ... and the real imported edge must be present instead of being shadowed by it.
    expect(graph.edges.some((edge) => edge.sourceId === "src/callback.ts::function:withCallback:3" && edge.targetId === "src/util.ts::function:helperOne:1" && edge.kind === "call")).toBe(true);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D26 — an anonymous function expression is not named after its parameter", () => {
  it("declares only the variable name and never resolves calls to a parameter-derived symbol", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d26-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "kinds.ts"), [
      "export const pay = function (a: number): number { return a * 2; };",
      "export const mapper = function (helperOne: number): number { return helperOne + 1; };",
      "export function callMapper(): number { return mapper(3); }",
      "export function callPhantom(): number { return helperOne(4); }",
      "",
    ].join("\n"));
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const graph = await worker.graph({ kind: "explore", query: "mapper", maxNodes: 500, depth: 8 });
    const parsed = parseFile("src/kinds.ts", "export const pay = function (a: number) { return a; };\nexport const mapper = function (helperOne: number) { return helperOne; };\n");
    // No symbol may be named after a parameter of an anonymous function expression.
    expect(parsed.symbols.map((symbol) => symbol.name).sort()).toEqual(["mapper", "pay"]);
    expect(graph.symbols.some((symbol) => ["a", "helperOne"].includes(symbol.name))).toBe(false);
    // The variable-owned name is the declaration, and calls resolve to it.
    expect(graph.symbols.some((symbol) => symbol.id === "src/kinds.ts::function:mapper:2")).toBe(true);
    expect(graph.edges.some((edge) => edge.sourceId === "src/kinds.ts::function:callMapper:3" && edge.targetId === "src/kinds.ts::function:mapper:2")).toBe(true);
    // `helperOne` is not declared here, so the call must resolve to nothing.
    expect(graph.edges.some((edge) => edge.sourceId === "src/kinds.ts::function:callPhantom:4")).toBe(false);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D27 — a call through an import alias resolves", () => {
  it("links the aliased call to the imported declaration rather than the same-file name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d27-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "util.ts"), "export function helperOne(value: number): number {\n  return value + 1;\n}\n");
    await writeFile(path.join(root, "src", "shadow.ts"), [
      "import { helperOne as importedOne } from \"./util\";",
      "",
      "export function helperOne(value: number): number {",
      "  return importedOne(value) + 1;",
      "}",
      "",
    ].join("\n"));
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const { edges } = await graphInventory(worker);
    expect(edges.some((edge) => edge.sourceId === "src/shadow.ts::module" && edge.targetId === "src/util.ts::module" && edge.kind === "import")).toBe(true);
    expect(edges.some((edge) => edge.sourceId === "src/shadow.ts::function:helperOne:3" && edge.targetId === "src/util.ts::function:helperOne:1" && edge.kind === "call")).toBe(true);
    // The local declaration must never be the target of the aliased call (a self-edge).
    expect(edges.some((edge) => edge.sourceId === "src/shadow.ts::function:helperOne:3" && edge.targetId.startsWith("src/shadow.ts"))).toBe(false);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D28 — Python import specifiers are normalized", () => {
  it("resolves sibling-relative and absolute dotted Python imports to the indexed module", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d28-"));
    roots.push(root);
    await mkdir(path.join(root, "py"), { recursive: true });
    await writeFile(path.join(root, "py", "helper.py"), "def do_work(value):\n    return value * 2\n");
    await writeFile(path.join(root, "py", "relative.py"), "from .helper import do_work\n\n\ndef a_call(value):\n    return do_work(value)\n");
    await writeFile(path.join(root, "py", "dotted.py"), "from py.helper import do_work\n\n\ndef b_call(value):\n    return do_work(value)\n");
    await writeFile(path.join(root, "py", "stdlib.py"), "import os\n\n\ndef c_call(value):\n    return os.sep\n");
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const { edges: all } = await graphInventory(worker);
    // `from .helper import x` -> specifier `./helper`.
    expect(all.some((edge) => edge.sourceId === "py/relative.py::module" && edge.targetId === "py/helper.py::module" && edge.kind === "import")).toBe(true);
    // `from py.helper import x` -> specifier `py/helper`.
    expect(all.some((edge) => edge.sourceId === "py/dotted.py::module" && edge.targetId === "py/helper.py::module" && edge.kind === "import")).toBe(true);
    expect(all.some((edge) => edge.sourceId === "py/relative.py::function:a_call:4" && edge.targetId === "py/helper.py::function:do_work:1" && edge.kind === "call")).toBe(true);
    expect(all.some((edge) => edge.sourceId === "py/dotted.py::function:b_call:4" && edge.targetId === "py/helper.py::function:do_work:1" && edge.kind === "call")).toBe(true);
    // A stdlib import stays unresolvable: normalization must not invent workspace targets.
    expect(all.some((edge) => edge.sourceId.startsWith("py/stdlib.py") && edge.kind === "import")).toBe(false);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D29 — Python function endLine covers the indented block", () => {
  it("scans calls inside multi-line Python bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pactile-retrieval-worker-d29-"));
    roots.push(root);
    await mkdir(path.join(root, "py"), { recursive: true });
    await writeFile(path.join(root, "py", "helper.py"), [
      "def do_work(value):",
      "    return value * 2",
      "",
      "",
      "def compute_total(items):",
      "    total = 0",
      "    for item in items:",
      "        total += do_work(item)",
      "    return total",
      "",
    ].join("\n"));
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const { symbols, edges } = await graphInventory(worker);
    const compute = symbols.find((symbol) => symbol.id === "py/helper.py::function:compute_total:5");
    const doWork = symbols.find((symbol) => symbol.id === "py/helper.py::function:do_work:1");
    // A one-line body keeps its own line; a multi-line body spans the whole indented block.
    expect(doWork).toMatchObject({ startLine: 1, endLine: 2 });
    expect(compute).toMatchObject({ startLine: 5, endLine: 9 });
    expect(edges.some((edge) => edge.sourceId === "py/helper.py::function:compute_total:5" && edge.targetId === "py/helper.py::function:do_work:1" && edge.kind === "call")).toBe(true);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D30 — a cancelled sync never leaves state at \"syncing\"", () => {
  it("returns to the pre-pass state with an explained lastError while the data plane is untouched", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    expect(worker.stats().state).toBe("ready");
    await writeFile(path.join(root, "src", "main.ts"), "export function changed(): string { return 'new'; }\n");

    // Arm the abort so the signal fires while the LAST walked file is being read: by then every
    // pre-transaction abort check has already passed, so the pass can only observe the cancel
    // inside its write transaction — the exact window the audit located.
    const controller = new AbortController();
    let abortFired = false;
    await writeFile(path.join(root, "zz-last.ts"), "export const zzLast = true;\n");
    const restore = armReadFileDelay({
      match: (file) => file.endsWith("/zz-last.ts"),
      delayMs: 150,
      used: false,
      onExit: () => { abortFired = true; controller.abort(); },
    });

    const outcome = await worker.sync(controller.signal)
      .then(() => ({ resolved: true as const }), (error: unknown) => ({ resolved: false as const, name: (error as Error).name }));
    restore();

    expect(abortFired).toBe(true);
    expect(outcome).toEqual({ resolved: false, name: "AbortError" });
    const after = worker.stats();
    // The reported state must be terminal and self-explanatory...
    expect(after.state).not.toBe("syncing");
    expect(after.lastError).toBe("cancelled");
    // ... nothing published a new generation, and nothing clears the state on its own.
    expect(after.generation).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(worker.stats().state).not.toBe("syncing");
    expect(worker.stats().queueDepth).toBe(0);
    // The data plane is untouched and a later sync still applies the dropped change.
    const recovered = await worker.sync();
    expect(recovered.generation).toBe(2);
    expect(worker.stats().state).toBe("ready");
    expect(worker.stats().lastError).toBeNull();
    await worker.close();
  }, 60_000);
});

describe("RetrievalWorker D31 — stats().activeReads reports real in-flight reads", () => {
  it("counts overlapping read() calls while they are provably in flight", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "slow.ts"), "export const slow = true;\n");
    const worker = new RetrievalWorker({ root });
    await worker.init();
    let entered = 0;
    let exited = 0;
    const restore = armReadFileDelay({
      match: (file) => file.endsWith("/src/slow.ts"),
      delayMs: 400,
      used: false,
      onEnter: () => { entered += 1; },
      onExit: () => { exited += 1; },
    });
    const samples: number[] = [];
    const sampler = setInterval(() => samples.push(worker.stats().activeReads), 10);
    const first = worker.read({ path: "src/slow.ts" });
    const second = worker.read({ path: "src/main.ts" });
    await Promise.all([first, second]);
    clearInterval(sampler);
    restore();
    expect(entered).toBe(1);
    expect(exited).toBe(1);
    // The overlap is proven by the harness hook; the candidate must report at least one live read.
    expect(Math.max(...samples)).toBeGreaterThanOrEqual(1);
    // The counter is balanced again once everything settled.
    expect(worker.stats().activeReads).toBe(0);
    await worker.close();
  }, 30_000);

  it("also counts inspect() and never leaks the counter on failure", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    let entered = 0;
    const restore = armReadFileDelay({
      match: (file) => file.endsWith("/src/main.ts"),
      delayMs: 300,
      used: false,
      onEnter: () => { entered += 1; },
    });
    const pending = worker.inspect("src/main.ts");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = worker.stats().activeReads;
    await pending;
    restore();
    expect(entered).toBe(1);
    expect(during).toBeGreaterThanOrEqual(1);
    expect(worker.stats().activeReads).toBe(0);
    // A rejected read must not leave the counter stuck above zero.
    await expect(worker.read({ path: "../escape.ts" })).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    expect(worker.stats().activeReads).toBe(0);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D32 — stats().queueDepth is a real queue length", () => {
  it("reports one entry per waiting sync instead of saturating at two", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "slow.ts"), "export const slow = true;\n");
    const worker = new RetrievalWorker({ root });
    await worker.init();
    await writeFile(path.join(root, "src", "main.ts"), "export function changed(): string { return 'new'; }\n");
    // Hold the active pass open so the later callers provably queue behind it.
    const restore = armReadFileDelay({ match: (file) => file.endsWith("/src/slow.ts"), delayMs: 500, used: false });
    const samples: number[] = [];
    const sampler = setInterval(() => samples.push(worker.stats().queueDepth), 5);
    const first = worker.sync();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const queued = [worker.sync(), worker.sync(), worker.sync()];
    await new Promise((resolve) => setTimeout(resolve, 120));
    const duringBurst = worker.stats().queueDepth;
    await Promise.all([first, ...queued]);
    clearInterval(sampler);
    restore();
    // Three callers were queued behind one active pass: the depth must exceed the old 0/1/2 flag.
    expect(duringBurst).toBeGreaterThanOrEqual(3);
    expect(Math.max(...samples)).toBeGreaterThanOrEqual(3);
    // ... and it drops back to zero once the queue drains. The last burst caller schedules one
    // follow-up pass, so wait for the worker to settle rather than sampling mid-pass.
    await waitFor(() => worker.stats().queueDepth === 0);
    expect(worker.stats().queueDepth).toBe(0);
    await worker.close();
  }, 60_000);

  it("reports zero when idle and never counts a completed pass", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.open();
    expect(worker.stats().queueDepth).toBe(0);
    await worker.init();
    expect(worker.stats().queueDepth).toBe(0);
    await worker.sync();
    expect(worker.stats().queueDepth).toBe(0);
    await worker.close();
  }, 30_000);
});

describe("RetrievalWorker D33 — read() honours an abort that fires while it is running", () => {
  it("rejects with AbortError when the signal fires mid-read", async () => {
    const root = await fixture();
    const worker = new RetrievalWorker({ root });
    await worker.init();
    const controller = new AbortController();
    let entered = 0;
    let exited = 0;
    const restore = armReadFileDelay({
      match: (file) => file.endsWith("/src/main.ts"),
      delayMs: 400,
      used: false,
      onEnter: () => { entered += 1; },
      onExit: () => { exited += 1; },
    });
    const outcome = worker.read({ path: "src/main.ts", signal: controller.signal })
      .then((value) => ({ resolved: true as const, bytes: value.bytes }), (error: unknown) => ({ resolved: false as const, name: (error as Error).name }));
    // Wait until the fs read is provably inside the hook, then abort.
    const deadline = Date.now() + 10_000;
    while (entered === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const inFlight = exited === 0;
    controller.abort();
    const result = await outcome;
    restore();
    expect(inFlight).toBe(true);
    expect(result).toEqual({ resolved: false, name: "AbortError" });
    // The counter and the worker both stay usable after the rejection.
    expect(worker.stats().activeReads).toBe(0);
    await expect(worker.read({ path: "src/main.ts" })).resolves.toMatchObject({ path: "src/main.ts" });
    await worker.close();
  }, 30_000);
});
