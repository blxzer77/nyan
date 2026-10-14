import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodemodeResult, CodemodeSandbox } from "../src/index.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("worker lifetime", () => {
	// Reject admission before creating a worker, not by terminating an excess worker.
	it("does not start a worker when admission is denied", async () => {
		const onWorkerStarted = vi.fn();
		const acquireWorker = vi.fn(() => {
			throw new Error("worker capacity exhausted");
		});
		const sandbox = new CodemodeSandbox({ acquireWorker, onWorkerStarted });
		try {
			expect(await sandbox.execute("while (true) {}")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "worker capacity exhausted" },
			});
			expect(acquireWorker).toHaveBeenCalledTimes(1);
			expect(onWorkerStarted).not.toHaveBeenCalled();
		} finally {
			await sandbox.close();
		}
	});

	// A failed Worker constructor must return its reserved capacity.
	it("releases admission when worker construction fails", async () => {
		const releaseWorker = vi.fn();
		const acquireWorker = vi.fn(() => releaseWorker);
		const sandbox = new CodemodeSandbox({
			acquireWorker,
			workerUrl: new URL("https://invalid.example/worker.js"),
		});
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: expect.stringContaining("Failed to start worker:") },
			});
			expect(acquireWorker).toHaveBeenCalledTimes(1);
			expect(releaseWorker).toHaveBeenCalledTimes(1);
		} finally {
			await sandbox.close();
		}
	});

	// Loading failures must not reserve worker capacity.
	it("does not acquire admission when wasm loading fails", async () => {
		const acquireWorker = vi.fn(() => vi.fn());
		const sandbox = new CodemodeSandbox({
			acquireWorker,
			wasm: Promise.reject(new Error("wasm unavailable")),
		});
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "Failed to load QuickJS: wasm unavailable" },
			});
			expect(acquireWorker).not.toHaveBeenCalled();
		} finally {
			await sandbox.close();
		}
	});

	// Bun can leave terminate() pending while a non-interruptible built-in runs.
	it.each(["abort", "timeout", "close"] as const)("settles %s without waiting for worker exit", async (how) => {
		vi.useFakeTimers();
		const terminate = Worker.prototype.terminate;
		let worker: Worker | undefined;
		let releaseTermination: (code: number) => void = () => {};
		const termination = new Promise<number>((resolve) => {
			releaseTermination = resolve;
		});
		const terminateSpy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
			worker = this;
			// Like the real Node/Bun implementation, termination refs the worker while waiting for exit.
			this.ref();
			return termination;
		});
		const refSpy = vi.spyOn(Worker.prototype, "ref");
		const unrefSpy = vi.spyOn(Worker.prototype, "unref");
		let ready: () => void = () => {};
		const called = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let toolSignal: AbortSignal | undefined;
		let exited: Promise<void> | undefined;
		let didExit = false;
		const sandbox = new CodemodeSandbox({
			timeoutMs: 100,
			onWorkerStarted: (promise) => {
				exited = promise;
				void promise.then(() => {
					didExit = true;
				});
			},
			tools: [
				{
					name: "hang",
					execute: (_args, { signal }) => {
						toolSignal = signal;
						ready();
						return new Promise(() => {});
					},
				},
			],
		});
		const controller = new AbortController();
		let result: CodemodeResult | undefined;
		let didClose = false;
		const pending = sandbox.execute('text("partial"); await tools.hang()', { signal: controller.signal });
		void pending.then((value) => {
			result = value;
		});
		try {
			await called;
			if (how === "abort") controller.abort(new Error("cancelled"));
			if (how === "timeout") await vi.advanceTimersByTimeAsync(100);
			if (how === "close") {
				void sandbox.close().then(() => {
					didClose = true;
				});
			}
			await vi.advanceTimersByTimeAsync(0);
			expect(result).toMatchObject({
				ok: false,
				error: { kind: how === "timeout" ? "timeout" : "aborted" },
				output: [{ type: "text", text: "partial" }],
				calls: [{ name: "hang", status: "cancelled" }],
			});
			expect(toolSignal?.aborted).toBe(true);
			expect(terminateSpy).toHaveBeenCalledTimes(1);
			expect(unrefSpy).toHaveBeenCalledTimes(1);
			expect(refSpy).toHaveBeenCalledTimes(1);
			expect(unrefSpy.mock.invocationCallOrder[0]).toBeGreaterThan(refSpy.mock.invocationCallOrder[0]);
			expect(exited).toBeDefined();
			expect(didExit).toBe(false);
			if (how === "close") expect(didClose).toBe(true);
			// Neither close() nor late worker messages may replace the decided outcome or wait for exit.
			await sandbox.close();
			worker?.emit("message", { type: "done", ok: true, value: "42", writes: "[]" });
			expect(await pending).toBe(result);
			expect(terminateSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			terminateSpy.mockRestore();
			if (worker) releaseTermination(await terminate.call(worker));
			await sandbox.close();
		}
		await exited;
		expect(didExit).toBe(true);
	});

	// Exit accounting applies to successful executions and host-controlled runs too.
	it("reports the actual exit of execute() and start() workers", async () => {
		const exits: Promise<void>[] = [];
		const releaseWorker = vi.fn();
		const acquireWorker = vi.fn(() => releaseWorker);
		const sandbox = new CodemodeSandbox({ acquireWorker, onWorkerStarted: (exited) => void exits.push(exited) });
		try {
			expect(await sandbox.execute("return 1")).toMatchObject({ ok: true, value: 1 });
			const run = sandbox.start("return 2", { startedAt: 0, seed: 0, onCall: () => {} });
			expect(await run.result).toMatchObject({ ok: true, value: 2 });
			expect(run.finished).toBe(true);
			expect(exits).toHaveLength(2);
			await Promise.all(exits);
			expect(acquireWorker).toHaveBeenCalledTimes(2);
			expect(releaseWorker).toHaveBeenCalledTimes(2);
		} finally {
			await sandbox.close();
		}
	});

	// A failing lifetime hook must not leak the worker it was handed.
	it("requests termination when onWorkerStarted throws", async () => {
		let exited: Promise<void> | undefined;
		const releaseWorker = vi.fn();
		const sandbox = new CodemodeSandbox({
			acquireWorker: () => releaseWorker,
			onWorkerStarted: (promise) => {
				exited = promise;
				throw new Error("lifetime hook failed");
			},
		});
		try {
			expect(await sandbox.execute("while (true) {}")).toMatchObject({
				ok: false,
				error: { kind: "sandbox", message: "lifetime hook failed" },
			});
			expect(exited).toBeDefined();
			await exited;
			expect(releaseWorker).toHaveBeenCalledTimes(1);
		} finally {
			await sandbox.close();
		}
	});
});

// Resolve each runtime by name. `bun --bun` runs this suite inside Bun, so `process.execPath` is the
// Bun binary there: naming the Node runtime from it ran Bun twice and asserted Node-only exit
// behaviour against Bun, which is exactly the comparison this block exists to make.
function resolveRuntime(name: string, command: string) {
	return { name, command, available: spawnSync(command, ["--version"], { timeout: 5000 }).status === 0 };
}

const runtimes = [resolveRuntime("Node", "node"), resolveRuntime("Bun", "bun")];

describe.each(runtimes)("$name process lifetime", ({ name, command, available }) => {
	// Verify prompt cancellation on both runtimes, and prompt process exit on Node.
	// Bun's pending terminate() keeps the host process alive after the result, independently of
	// codemode (`runtime/host.ts` requests terminate() without awaiting it for that reason), so the
	// Bun run is stopped once the result line arrives instead of waiting for the process to exit.
	it.skipIf(!available).each(["abort", "timeout", "close"] as const)(
		name === "Node" ? "exits promptly after %s with a real worker" : "settles %s promptly with a real worker",
		async (how) => {
			const fixture = fileURLToPath(new URL("./fixtures/worker-process-exit.ts", import.meta.url));
			const expectedKind = how === "timeout" ? "timeout" : "aborted";

			if (name === "Bun") {
				const child = spawn(command, [fixture, how], { stdio: ["ignore", "pipe", "ignore"] });
				child.stdout.setEncoding("utf8");
				const firstLine = new Promise<string>((resolve, reject) => {
					let buffered = "";
					const timer = setTimeout(() => reject(new Error(`no result from ${command} ${how}`)), 20000);
					child.stdout.on("data", (chunk: string) => {
						buffered += chunk;
						const newline = buffered.indexOf("\n");
						if (newline === -1) return;
						clearTimeout(timer);
						resolve(buffered.slice(0, newline));
					});
					child.on("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
				});
				try {
					const result = JSON.parse(await firstLine) as { type: string; kind: string; elapsedMs: number };
					expect(result).toMatchObject({ type: "result", kind: expectedKind });
					expect(result.elapsedMs).toBeLessThan(1000);
				} finally {
					child.kill();
				}
				return;
			}

			const { stdout } = await promisify(execFile)(command, [fixture, how], { timeout: 20000 });
			const lines = stdout.trim().split(/\r?\n/);
			expect(lines).toHaveLength(2);
			const result = JSON.parse(lines[0]) as { type: string; kind: string; elapsedMs: number };
			const exit = JSON.parse(lines[1]) as { type: string; elapsedMs: number };
			expect(result).toMatchObject({ type: "result", kind: expectedKind });
			expect(exit.type).toBe("exit");
			expect(result.elapsedMs).toBeLessThan(1000);
			expect(exit.elapsedMs - result.elapsedMs).toBeLessThan(1000);
		},
		25000,
	);
});
