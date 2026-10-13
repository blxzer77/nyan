/**
 * Focused tests for the Retrieval Worker process transport.
 *
 * A TEST-DOUBLE Worker script (written to a temp dir) speaks the frozen
 * candidate's JSONL framing (`{id, method, params}` -> `{id, result|error}`).
 * Real child processes are spawned so that probe, env scrubbing, framing,
 * termination of the process tree, exit status and unknown-effect
 * classification are exercised for real. This is not evidence about the real
 * Worker's retrieval behaviour.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { reconcileLocalWorkerIndexEffectV1 } from "../../../src/pactile/retrieval/adapters/local-worker.js";
import {
  LocalWorkerProcessError,
  LocalWorkerProcessV1,
  scrubLocalWorkerEnvV1,
  type LocalWorkerStartResultV1,
} from "../../../src/pactile/retrieval/adapters/local-worker-process.js";

const FAKE_WORKER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const root = process.argv[2];
const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); } catch { return fallback; }
};
const mode = read("mode.json", "normal");
fs.writeFileSync(path.join(root, "spawned.marker"), String(process.pid));
if (mode === "exit-at-start") process.exit(3);
const state = () => read("state.json", { generation: 0, snapshot: "" });
const commit = (s) => {
  const next = { generation: s.generation + 1, snapshot: "snap-" + (s.generation + 1) };
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(next));
  return next;
};
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle({ id, method }) {
  const s = state();
  switch (method) {
    case "open":
      return out({ id, result: { root, worktreeId: "hash", generation: s.generation, snapshot: s.snapshot, freshness: s.generation > 0 ? "fresh" : "unknown" } });
    case "stats":
      return out({ id, result: { state: s.generation > 0 ? "ready" : "absent", root, generation: s.generation } });
    case "execute":
      if (mode === "hang-execute") return;
      if (mode === "exit-on-execute") process.exit(7);
      if (mode === "garbage") { process.stdout.write("not json\n"); return; }
      if (mode === "error") return out({ id, error: "ENOENT: no such file " + root });
      if (mode === "grandchild") {
        const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.writeFileSync(path.join(root, "grandchild.pid"), String(child.pid));
        return;
      }
      return out({ id, result: { envKeys: Object.keys(process.env) } });
    case "init":
      if (mode === "hang-init") return;
      if (mode === "commit-then-hang") { commit(s); return; }
      { const next = commit(s); return out({ id, result: { root, worktreeId: "hash", ...next, freshness: "fresh" } }); }
    case "close":
      return out({ id, result: { closed: true } });
    default:
      return out({ id, error: "UNKNOWN_METHOD:" + method });
  }
}
`;

const tempRoots: string[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-rw-transport-"));
tempRoots.push(scratch);
const workerEntry = path.join(scratch, "fake-worker.cjs");
fs.writeFileSync(workerEntry, FAKE_WORKER);

function workspace(mode: string, state?: { generation: number; snapshot: string }): string {
  const root = fs.mkdtempSync(path.join(scratch, "ws-"));
  fs.writeFileSync(path.join(root, "mode.json"), JSON.stringify(mode));
  if (state) fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  return root;
}

async function start(
  root: string,
  extra: { env?: Record<string, string | undefined>; minimumNodeMajor?: number } = {},
): Promise<LocalWorkerStartResultV1> {
  return await LocalWorkerProcessV1.start({
    nodeExecutable: process.execPath,
    workerEntry,
    workspaceRoot: root,
    minimumNodeMajor: extra.minimumNodeMajor ?? 0,
    startupTimeoutMs: 15_000,
    controlTimeoutMs: 5_000,
    writeTimeoutMs: 5_000,
    env: extra.env ?? process.env,
  });
}

function started(result: LocalWorkerStartResultV1): LocalWorkerProcessV1 {
  if (result.status !== "started") throw new Error(`not started: ${result.status}`);
  return result.transport;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const executeRequest = {
  query: "q",
  intents: ["exact" as const],
  maxCandidates: 5,
  maxBytes: 1024,
  maxNodes: 10,
  timeoutMs: 100,
};

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Retrieval Worker process transport", () => {
  it("scrubs credentials, decision-provider keys and NODE_OPTIONS from the Worker env", async () => {
    expect(
      scrubLocalWorkerEnvV1({
        Path: "p",
        SystemRoot: "s",
        PACTILE_DECISION_API_KEY: "test-placeholder",
        PACTILE_DECISION_BASE_URL: "https://example.invalid",
        NODE_OPTIONS: "--require evil",
        GITHUB_TOKEN: "test-placeholder",
      }),
    ).toEqual({ Path: "p", SystemRoot: "s" });

    const transport = started(
      await start(workspace("normal"), {
        env: {
          ...process.env,
          PACTILE_DECISION_API_KEY: "test-placeholder",
          NODE_OPTIONS: "",
        },
      }),
    );
    const raw = (await transport.execute(executeRequest, new AbortController().signal)) as {
      envKeys: string[];
    };
    const upper = raw.envKeys.map((key) => key.toUpperCase());
    expect(upper).not.toContain("PACTILE_DECISION_API_KEY");
    expect(upper).not.toContain("NODE_OPTIONS");
    expect((await transport.close()).expected).toBe(true);
  });

  it("returns a path-free handshake and closes gracefully", async () => {
    const root = workspace("normal", { generation: 2, snapshot: "snap-2" });
    const result = await start(root);
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.handshake).toEqual({
      nodeVersion: process.version,
      sqliteAvailable: true,
      workerState: "ready",
      generation: 2,
      snapshot: "snap-2",
      freshness: "fresh",
    });
    expect(JSON.stringify(result.handshake)).not.toContain(root);
    const exit = await result.transport.close();
    expect(exit).toMatchObject({ code: 0, expected: true });
  });

  it("does not spawn the Worker when the runtime is below the capability minimum", async () => {
    const root = workspace("normal");
    const result = await start(root, { minimumNodeMajor: 999 });
    expect(result.status).toBe("unsupported");
    expect(fs.existsSync(path.join(root, "spawned.marker"))).toBe(false);
  });

  it("reports a Worker that exits during startup as a failed handshake with its exit code", async () => {
    const result = await start(workspace("exit-at-start"));
    expect(result).toMatchObject({
      status: "failed",
      code: "handshake-failed",
      exit: { code: 3, expected: false },
    });
  });

  it("terminates the Worker on abort and the transport is closed afterwards", async () => {
    const transport = started(await start(workspace("hang-execute")));
    const controller = new AbortController();
    const pending = transport.execute(executeRequest, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    // The rejection is delivered only after the Worker has exited.
    expect(transport.exit).toMatchObject({ expected: true });
    const pid = transport.pid ?? -1;
    expect(alive(pid)).toBe(false);
    await expect(
      transport.execute(executeRequest, new AbortController().signal),
    ).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
  });

  it("terminates the Worker process tree (grandchildren such as rg) on timeout", async () => {
    const root = workspace("grandchild");
    const transport = started(await start(root));
    const pending = transport.execute(
      { ...executeRequest, timeoutMs: 0 },
      new AbortController().signal,
    );
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    const marker = path.join(root, "grandchild.pid");
    expect(await waitFor(() => fs.existsSync(marker))).toBe(true);
    const grandchild = Number(fs.readFileSync(marker, "utf8"));
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it("surfaces an unexpected Worker exit with its exit code", async () => {
    const transport = started(await start(workspace("exit-on-execute")));
    await expect(
      transport.execute(executeRequest, new AbortController().signal),
    ).rejects.toMatchObject({ code: "WORKER_EXITED" });
    expect(transport.exit).toMatchObject({ code: 7, expected: false });
  });

  it("treats non-JSON stdout as a protocol violation and terminates the Worker", async () => {
    const transport = started(await start(workspace("garbage")));
    await expect(
      transport.execute(executeRequest, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    const pid = transport.pid ?? -1;
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  it("keeps only a bare error token from Worker errors", async () => {
    const root = workspace("error");
    const transport = started(await start(root));
    const error = await transport
      .execute(executeRequest, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalWorkerProcessError);
    expect((error as LocalWorkerProcessError).workerCode).toBe("ENOENT");
    expect((error as Error).message).not.toContain(root);
    await transport.close();
  });

  it("classifies a write terminated mid-flight as unknown effect and reconciles after restart", async () => {
    const notCommittedRoot = workspace("hang-init");
    const first = started(await start(notCommittedRoot));
    const write = await first.writeIndex("init", AbortSignal.timeout(300));
    expect(write).toEqual({
      outcome: "unknown-effect",
      before: { generation: 0, snapshot: "" },
      after: null,
    });
    expect(first.exit).toMatchObject({ expected: true });
    const restarted = await start(notCommittedRoot);
    expect(restarted.status).toBe("started");
    if (restarted.status !== "started") return;
    expect(reconcileLocalWorkerIndexEffectV1(write.before, restarted.handshake)).toBe(
      "not-committed",
    );
    await restarted.transport.close();

    const committedRoot = workspace("commit-then-hang");
    const second = started(await start(committedRoot));
    const unknown = await second.writeIndex("init", AbortSignal.timeout(300));
    expect(unknown.outcome).toBe("unknown-effect");
    const afterRestart = await start(committedRoot);
    if (afterRestart.status !== "started") throw new Error("restart failed");
    expect(reconcileLocalWorkerIndexEffectV1(unknown.before, afterRestart.handshake)).toBe(
      "committed",
    );
    await afterRestart.transport.close();
  });

  it("reports not-started (no effect) when aborted before the write is sent", async () => {
    const root = workspace("normal");
    const transport = started(await start(root));
    const controller = new AbortController();
    controller.abort();
    const write = await transport.writeIndex("init", controller.signal);
    expect(write.outcome).toBe("not-started");
    expect(fs.existsSync(path.join(root, "state.json"))).toBe(false);
    await transport.close();
  });

  it("commits a normal index write and reports the new generation", async () => {
    const transport = started(await start(workspace("normal")));
    const write = await transport.writeIndex("init");
    expect(write.outcome).toBe("committed");
    expect(write.before.generation).toBe(0);
    expect(write.after).toMatchObject({ generation: 1, snapshot: "snap-1", freshness: "fresh" });
    await transport.close();
  });
});
