/**
 * Process transport for the local Retrieval Worker capability.
 *
 * Strategy (docs/migration/retrieval-worker-integration-design.zh-CN.md):
 * the Node decision is a line-wide move to Node 24 (the package/CI baseline
 * is now declared; minimum-24.0.0 release gates remain). The Worker still
 * runs as a separate capability
 * process because its RPC has no cancel and graph compute is synchronous (P3
 * INCONCLUSIVE), so abort/timeout must be able to terminate it. The runtime is
 * still probed (`node:sqlite` + minimum major 24) and never assumed. This
 * module owns process facts only — probe, spawn, JSONL framing, deadline,
 * termination, exit status and unknown-effect classification. Translation
 * into Retrieval ABI V3 is done exclusively by `local-worker.ts`.
 *
 * Host-local values (Node executable, Worker entry, absolute workspace root,
 * stderr text, Worker error text) never leave this module.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";

import { snapshotPlainOwnDataRecordV3 } from "../boundary.js";
import {
  LOCAL_WORKER_MIN_NODE_MAJOR_V1,
  type LocalWorkerExecuteRequestV1,
  type LocalWorkerFreshnessV1,
  type LocalWorkerHandshakeV1,
  type LocalWorkerTransportV1,
} from "./local-worker.js";

const ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);
const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_TIMEOUT_MS = 300_000;
const CLOSE_GRACE_MS = 2_000;
const WORKER_STATES = new Set([
  "absent",
  "building",
  "ready",
  "syncing",
  "stale",
  "degraded",
  "paused",
  "unknown",
]);
const SAFE_WORKER_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Copy only allowlisted variables; drops every key, token and NODE_OPTIONS. */
export function scrubLocalWorkerEnvV1(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) {
      output[key] = value;
    }
  }
  return output;
}

export interface LocalWorkerRuntimeProbeV1 {
  readonly nodeVersion: string;
  readonly sqliteAvailable: boolean;
}

const PROBE_SCRIPT = [
  "let s=false;",
  "try{const m=require('node:sqlite');",
  "if(typeof m.DatabaseSync==='function'){",
  "const d=new m.DatabaseSync(':memory:');",
  "d.exec('BEGIN IMMEDIATE');d.exec('ROLLBACK');d.close();s=true;}}catch{}",
  "process.stdout.write(JSON.stringify({v:process.version,s}));",
].join("");

/** Probe the Worker runtime (Node version + `node:sqlite` smoke). */
export async function probeLocalWorkerRuntimeV1(
  nodeExecutable: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<LocalWorkerRuntimeProbeV1 | null> {
  return await new Promise((resolve) => {
    execFile(
      nodeExecutable,
      ["-e", PROBE_SCRIPT],
      { env, timeout: timeoutMs, windowsHide: true, shell: false },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = snapshotPlainOwnDataRecordV3(
            JSON.parse(String(stdout)) as unknown,
          );
          if (
            parsed &&
            typeof parsed.v === "string" &&
            typeof parsed.s === "boolean"
          ) {
            resolve({ nodeVersion: parsed.v, sqliteAvailable: parsed.s });
            return;
          }
        } catch {
          /* fall through */
        }
        resolve(null);
      },
    );
  });
}

export interface LocalWorkerProcessOptionsV1 {
  /** Host-local absolute path to the Worker's Node executable. */
  readonly nodeExecutable: string;
  /** Host-local absolute path to the built Worker bin (`dist/bin/...js`). */
  readonly workerEntry: string;
  /** Host-local absolute workspace root; used as cwd and Worker argv only. */
  readonly workspaceRoot: string;
  readonly minimumNodeMajor?: number;
  readonly startupTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  /** Base environment to scrub; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface LocalWorkerExitV1 {
  readonly code: number | null;
  readonly signal: string | null;
  /** True only after `close()`/`terminate()` initiated by the adapter. */
  readonly expected: boolean;
}

export type LocalWorkerProcessErrorCodeV1 =
  | "TRANSPORT_BUSY"
  | "TRANSPORT_CLOSED"
  | "WORKER_EXITED"
  | "WORKER_ERROR"
  | "PROTOCOL_ERROR"
  | "ABORTED"
  | "TIMEOUT";

export class LocalWorkerProcessError extends Error {
  readonly code: LocalWorkerProcessErrorCodeV1;
  /** Worker error token when it is a bare upper-case code; never free text. */
  readonly workerCode: string | null;

  constructor(
    code: LocalWorkerProcessErrorCodeV1,
    workerCode: string | null = null,
  ) {
    super(`PACTILE_RETRIEVAL_WORKER_${code}`);
    this.name = "LocalWorkerProcessError";
    this.code = code;
    this.workerCode = workerCode;
  }
}

export type LocalWorkerStartResultV1 =
  | {
      readonly status: "started";
      readonly transport: LocalWorkerProcessV1;
      readonly handshake: LocalWorkerHandshakeV1;
    }
  | {
      readonly status: "unsupported";
      readonly probe: LocalWorkerRuntimeProbeV1;
    }
  | {
      readonly status: "failed";
      readonly code: "probe-failed" | "spawn-failed" | "handshake-failed";
      readonly exit: LocalWorkerExitV1 | null;
    };

export interface LocalWorkerIndexWriteResultV1 {
  /**
   * `not-started` => aborted before the write was sent (no effect);
   * `unknown-effect` => terminated mid-write; reconcile after restart.
   */
  readonly outcome: "committed" | "not-started" | "unknown-effect" | "failed";
  readonly before: { readonly generation: number; readonly snapshot: string };
  readonly after: LocalWorkerHandshakeV1 | null;
}

interface PendingCall {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: LocalWorkerProcessError) => void;
}

function parseScope(raw: unknown): {
  generation: number;
  snapshot: string;
  freshness: LocalWorkerFreshnessV1;
} | null {
  const scope = snapshotPlainOwnDataRecordV3(raw);
  if (
    !scope ||
    !Number.isSafeInteger(scope.generation) ||
    (scope.generation as number) < 0 ||
    typeof scope.snapshot !== "string" ||
    !(
      scope.freshness === "fresh" ||
      scope.freshness === "stale" ||
      scope.freshness === "unknown"
    )
  ) {
    return null;
  }
  return {
    generation: scope.generation as number,
    snapshot: scope.snapshot,
    freshness: scope.freshness,
  };
}

function parseState(raw: unknown): string | null {
  const stats = snapshotPlainOwnDataRecordV3(raw);
  return stats &&
    typeof stats.state === "string" &&
    WORKER_STATES.has(stats.state)
    ? stats.state
    : null;
}

export class LocalWorkerProcessV1 implements LocalWorkerTransportV1 {
  private readonly child: ChildProcess;
  private readonly probe: LocalWorkerRuntimeProbeV1;
  private readonly controlTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private buffer = "";
  private nextId = 1;
  private pending: PendingCall | null = null;
  private exitInfo: LocalWorkerExitV1 | null = null;
  private expectedExit = false;
  /** Set synchronously once termination starts; the OS exit event may lag. */
  private closing = false;
  private stderrBytes = 0;
  private readonly exited: Promise<LocalWorkerExitV1>;

  private constructor(
    child: ChildProcess,
    probe: LocalWorkerRuntimeProbeV1,
    options: LocalWorkerProcessOptionsV1,
  ) {
    this.child = child;
    this.probe = probe;
    this.controlTimeoutMs =
      options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal, expected: this.expectedExit };
        this.failPending(new LocalWorkerProcessError("WORKER_EXITED"));
        resolve(this.exitInfo);
      });
    });
    child.once("error", () => {
      this.failPending(new LocalWorkerProcessError("WORKER_EXITED"));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrBytes +=
        typeof chunk === "string" ? chunk.length : chunk.byteLength;
    });
  }

  /** Probe, spawn and handshake. Never spawns on an unsupported runtime. */
  static async start(
    options: LocalWorkerProcessOptionsV1,
  ): Promise<LocalWorkerStartResultV1> {
    const env = scrubLocalWorkerEnvV1(options.env ?? process.env);
    const startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const probe = await probeLocalWorkerRuntimeV1(
      options.nodeExecutable,
      env,
      startupTimeoutMs,
    );
    if (probe === null) {
      return { status: "failed", code: "probe-failed", exit: null };
    }
    const major = /^v?(\d+)\./u.exec(probe.nodeVersion);
    if (
      major === null ||
      Number(major[1]) <
        (options.minimumNodeMajor ?? LOCAL_WORKER_MIN_NODE_MAJOR_V1) ||
      !probe.sqliteAvailable
    ) {
      return { status: "unsupported", probe };
    }
    let child: ChildProcess;
    try {
      child = spawn(
        options.nodeExecutable,
        [options.workerEntry, options.workspaceRoot],
        {
          cwd: options.workspaceRoot,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        },
      );
    } catch {
      return { status: "failed", code: "spawn-failed", exit: null };
    }
    const transport = new LocalWorkerProcessV1(child, probe, options);
    try {
      const handshake = await transport.handshake(
        AbortSignal.timeout(startupTimeoutMs),
      );
      return { status: "started", transport, handshake };
    } catch {
      const exit = await transport.terminate();
      return { status: "failed", code: "handshake-failed", exit };
    }
  }

  get exit(): LocalWorkerExitV1 | null {
    return this.exitInfo;
  }

  /** Byte count only; stderr text may contain host paths and is not exposed. */
  get stderrByteCount(): number {
    return this.stderrBytes;
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  async handshake(signal?: AbortSignal): Promise<LocalWorkerHandshakeV1> {
    const scope = parseScope(
      await this.call("open", {}, signal, this.controlTimeoutMs),
    );
    const state = parseState(
      await this.call("stats", {}, signal, this.controlTimeoutMs),
    );
    if (scope === null || state === null) {
      throw new LocalWorkerProcessError("PROTOCOL_ERROR");
    }
    return {
      nodeVersion: this.probe.nodeVersion,
      sqliteAvailable: this.probe.sqliteAvailable,
      workerState: state,
      ...scope,
    };
  }

  /** `execute` reads the workspace and the existing index only. */
  async execute(
    request: LocalWorkerExecuteRequestV1,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.call(
      "execute",
      { ...request },
      signal,
      request.timeoutMs + this.controlTimeoutMs,
    );
  }

  /** Index write. Termination mid-write yields `unknown-effect`; never replays. */
  async writeIndex(
    method: "init" | "sync",
    signal?: AbortSignal,
  ): Promise<LocalWorkerIndexWriteResultV1> {
    // The pre-write checkpoint is read without the caller's signal so an
    // early abort can never be confused with a write of unknown effect.
    const before = await this.handshake();
    const ref = { generation: before.generation, snapshot: before.snapshot };
    if (signal?.aborted) {
      return { outcome: "not-started", before: ref, after: null };
    }
    try {
      await this.call(
        method,
        method === "init" ? { force: false } : {},
        signal,
        this.writeTimeoutMs,
      );
    } catch (error) {
      if (
        error instanceof LocalWorkerProcessError &&
        (error.code === "ABORTED" ||
          error.code === "TIMEOUT" ||
          error.code === "WORKER_EXITED")
      ) {
        return { outcome: "unknown-effect", before: ref, after: null };
      }
      return { outcome: "failed", before: ref, after: null };
    }
    return {
      outcome: "committed",
      before: ref,
      after: await this.handshake(signal),
    };
  }

  /** Graceful close; escalates to tree termination after a grace period. */
  async close(): Promise<LocalWorkerExitV1> {
    if (this.exitInfo) return this.exitInfo;
    this.expectedExit = true;
    try {
      await this.call(
        "close",
        {},
        AbortSignal.timeout(CLOSE_GRACE_MS * 2),
        CLOSE_GRACE_MS * 2,
      );
    } catch {
      /* escalate below */
    }
    this.closing = true;
    this.child.stdin?.end();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<null>((resolve) => {
      graceTimer = setTimeout(() => resolve(null), CLOSE_GRACE_MS);
    });
    const exited = await Promise.race([this.exited, grace]);
    clearTimeout(graceTimer);
    return exited ?? (await this.terminate());
  }

  /** Terminate the Worker and its descendants (e.g. `rg`). */
  async terminate(): Promise<LocalWorkerExitV1> {
    if (this.exitInfo) return this.exitInfo;
    this.closing = true;
    this.expectedExit = true;
    const pid = this.child.pid;
    if (process.platform === "win32" && pid !== undefined) {
      await new Promise<void>((resolve) => {
        execFile(
          "taskkill",
          ["/pid", String(pid), "/T", "/F"],
          { windowsHide: true },
          () => resolve(),
        );
      });
      if (!this.exitInfo) this.child.kill();
    } else {
      this.child.kill("SIGKILL");
    }
    return await this.exited;
  }

  private failPending(error: LocalWorkerProcessError): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  /**
   * Terminate first, then reject: a caller that observes the failure can
   * restart on the same worktree without overlapping the dying Worker.
   */
  private failPendingAfterExit(error: LocalWorkerProcessError): void {
    const pending = this.pending;
    this.pending = null;
    void this.terminate().then(
      () => pending?.reject(error),
      () => pending?.reject(error),
    );
  }

  private onStdout(chunk: string): void {
    if (this.closing && this.pending === null) return;
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER_BYTES) {
      this.buffer = "";
      this.failPendingAfterExit(new LocalWorkerProcessError("PROTOCOL_ERROR"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    const pending = this.pending;
    let message: Readonly<Record<string, unknown>> | null = null;
    try {
      message = snapshotPlainOwnDataRecordV3(JSON.parse(line) as unknown);
    } catch {
      message = null;
    }
    if (!pending || message?.id !== pending.id) {
      // Unsolicited or uncorrelated output breaks the framing contract.
      this.failPendingAfterExit(new LocalWorkerProcessError("PROTOCOL_ERROR"));
      return;
    }
    this.pending = null;
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const token =
        typeof message.error === "string" ? message.error.split(":")[0] : "";
      pending.reject(
        new LocalWorkerProcessError(
          "WORKER_ERROR",
          SAFE_WORKER_ERROR.test(token) ? token : null,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.exitInfo || this.closing) {
      throw new LocalWorkerProcessError("TRANSPORT_CLOSED");
    }
    if (this.pending) throw new LocalWorkerProcessError("TRANSPORT_BUSY");
    if (signal?.aborted) throw new LocalWorkerProcessError("ABORTED");
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      // The JSONL RPC has no cancel method, so abort/timeout terminate the
      // Worker; any in-flight index write becomes an unknown effect. The
      // rejection is delivered only after the Worker has exited.
      const kill = (code: "ABORTED" | "TIMEOUT"): void => {
        if (settled) return;
        finish();
        if (this.pending?.id === id) this.pending = null;
        const error = new LocalWorkerProcessError(code);
        void this.terminate().then(
          () => reject(error),
          () => reject(error),
        );
      };
      const onAbort = (): void => kill("ABORTED");
      const timer = setTimeout(() => kill("TIMEOUT"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        resolve: (value) => {
          if (settled) return;
          finish();
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          finish();
          reject(error);
        },
      };
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed) {
        this.failPending(new LocalWorkerProcessError("TRANSPORT_CLOSED"));
        return;
      }
      stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}
