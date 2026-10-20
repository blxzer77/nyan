import { describe, expect, test } from "vitest";
import { closeOutputStream, type OutputStream } from "../src/core/output-spill.ts";

/**
 * Closing the file that holds a command's full output. Its path is handed to the model and the user, so the close has to
 * finish before the path is returned, and a stream that never closes must not hang the caller nor let the file be
 * removed while its handle is still open.
 */

type Listener = (error?: unknown) => void;

/** A stream that answers the way the close needs, with the timing the test chooses. */
function fakeStream(options: {
	closed?: boolean;
	errorOnEnd?: Error;
	closeAfterDestroyMs?: number;
	neverCloses?: boolean;
}) {
	const listeners = new Map<string, Listener[]>();
	const events: string[] = [];
	const emit = (event: string, error?: unknown): void => {
		events.push(event);
		for (const listener of listeners.get(event) ?? []) listener(error);
	};
	const stream: OutputStream = {
		closed: options.closed ?? false,
		end() {
			events.push("end");
			if (options.errorOnEnd) emit("error", options.errorOnEnd);
			else if (!options.neverCloses) setTimeout(() => emit("close"), 1);
		},
		once(event, listener) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return stream;
		},
		destroy() {
			events.push("destroy");
			if (options.closeAfterDestroyMs !== undefined) {
				setTimeout(() => emit("close"), options.closeAfterDestroyMs);
			}
		},
	};
	return { stream, events };
}

describe("closing an output file", () => {
	test("resolves without an error once the stream has flushed and closed", async () => {
		const { stream, events } = fakeStream({});

		await expect(closeOutputStream(stream)).resolves.toBeUndefined();

		expect(events).toEqual(["end", "close"]);
	});

	test("reports the write error the stream failed with", async () => {
		const { stream } = fakeStream({ errorOnEnd: new Error("ENOSPC: no space left on device") });

		await expect(closeOutputStream(stream)).resolves.toEqual(
			expect.objectContaining({ message: "ENOSPC: no space left on device" }),
		);
	});

	test("destroys a stream that never closes, and waits for its handle to close", async () => {
		const { stream, events } = fakeStream({ neverCloses: true, closeAfterDestroyMs: 40 });

		const error = await closeOutputStream(stream, { closeTimeoutMs: 10, releaseTimeoutMs: 500 });

		expect(error?.message).toBe("Timed out closing full output file after 10ms");
		// The regression this pins: resolving as soon as `destroy()` returns would let the caller remove the file while
		// the handle is still open, which leaves the file behind on Windows.
		expect(events).toEqual(["end", "destroy", "close"]);
	});

	test("still settles when a destroyed stream never reports its handle closing", async () => {
		const { stream, events } = fakeStream({ neverCloses: true });

		const error = await closeOutputStream(stream, { closeTimeoutMs: 10, releaseTimeoutMs: 20 });

		expect(error?.message).toBe("Timed out closing full output file after 10ms");
		expect(events).toEqual(["end", "destroy"]);
	});

	test("does nothing to a stream that is already closed", async () => {
		const { stream, events } = fakeStream({ closed: true });

		await expect(closeOutputStream(stream)).resolves.toBeUndefined();

		expect(events).toEqual([]);
	});
});
