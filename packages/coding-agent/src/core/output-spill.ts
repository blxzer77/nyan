/**
 * Closing the file that holds a command's full output.
 *
 * Its path is given to the model and to the user, so nothing is returned while the stream still holds unwritten output,
 * and a file that could not be written is removed instead of left in the temp directory. Both cases have to survive a
 * stream that never closes: the close is bounded, and after the bound the stream is destroyed — but its handle still
 * has to close before the file can be removed, which is what Windows enforces.
 */

/** How long an output file may take to flush before it is destroyed and reported as failed. */
export const OUTPUT_CLOSE_TIMEOUT_MS = 10_000;

/** How long a destroyed stream may take to release its handle before the file is removed anyway. */
export const OUTPUT_RELEASE_TIMEOUT_MS = 2_000;

/** The part of a write stream that closing needs, so a test can pass a sink that never closes. */
export interface OutputStream {
	readonly closed: boolean;
	end(): void;
	once(event: "error" | "close", listener: (error?: unknown) => void): unknown;
	destroy(): void;
}

export interface OutputCloseTimeouts {
	readonly closeTimeoutMs?: number;
	readonly releaseTimeoutMs?: number;
}

/**
 * Wait for an output stream to flush and close. Resolves once the stream has closed, or once a timed-out stream has
 * been destroyed and has released its handle; the resolved error is the one to report, and `undefined` means the file
 * holds everything that was written.
 */
export async function closeOutputStream(
	stream: OutputStream,
	timeouts: OutputCloseTimeouts = {},
): Promise<Error | undefined> {
	if (stream.closed) return undefined;
	const closeTimeoutMs = timeouts.closeTimeoutMs ?? OUTPUT_CLOSE_TIMEOUT_MS;
	const releaseTimeoutMs = timeouts.releaseTimeoutMs ?? OUTPUT_RELEASE_TIMEOUT_MS;
	return new Promise<Error | undefined>((resolve) => {
		let settled = false;
		let timedOut: Error | undefined;
		let writeError: Error | undefined;
		let release: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(bound);
			if (release !== undefined) clearTimeout(release);
			resolve(timedOut ?? writeError);
		};
		const bound = setTimeout(() => {
			timedOut = new Error(`Timed out closing full output file after ${closeTimeoutMs}ms`);
			// destroy() releases the handle asynchronously, so wait for 'close' before this can resolve; the interval is
			// bounded as well, because a handle that never reports being closed must not hang the caller either.
			release = setTimeout(finish, releaseTimeoutMs);
			stream.once("close", () => {
				if (release !== undefined) clearTimeout(release);
				finish();
			});
			stream.destroy();
		}, closeTimeoutMs);
		stream.once("error", (error?: unknown) => {
			writeError = error instanceof Error ? error : new Error(String(error));
			finish();
		});
		stream.once("close", finish);
		stream.end();
	});
}
