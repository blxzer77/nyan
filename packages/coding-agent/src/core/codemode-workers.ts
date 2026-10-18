/**
 * Worker slots and the VM memory limit of codemode, shared by the legacy codemode extension and the durable path, so one
 * process holds at most two codemode workers at a time whichever path runs them.
 */

/**
 * Heap limit for the QuickJS VM. The worker shares nyan's process, so without a limit a runaway script can grow to
 * wasm32's 4 GiB and take the session down. Overruns throw `InternalError: out of memory` inside the script.
 */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

// Shared across calls and sessions. Allow one replacement while a cancelled worker is still exiting.
export const MAX_CONCURRENT_CODEMODE_WORKERS = 2;

let activeCodemodeWorkers = 0;

/**
 * Workers that are running or still shutting down. A slot is held until the worker's `exit` event, not until
 * `terminate()` is called, so this count can stay above zero after a script has already returned. Tests wait for it to
 * reach zero before the next test starts.
 */
export function codemodeWorkersInFlight(): number {
	return activeCodemodeWorkers;
}

/**
 * Reserves a worker slot before a worker is created. Throws while the limit is reached: a script is refused, not queued.
 * The returned release runs once, when the worker exits.
 */
export function acquireCodemodeWorker(): () => void {
	if (activeCodemodeWorkers >= MAX_CONCURRENT_CODEMODE_WORKERS) {
		throw new Error(
			`Codemode worker limit reached (${MAX_CONCURRENT_CODEMODE_WORKERS} workers are still running or shutting down). Retry after they exit.`,
		);
	}
	activeCodemodeWorkers++;
	return () => {
		activeCodemodeWorkers--;
	};
}
