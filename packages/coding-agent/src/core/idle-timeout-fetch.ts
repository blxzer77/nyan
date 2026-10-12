/**
 * An idle timeout for a native `fetch`, the part of the undici dispatcher that Bun's own fetch lacks.
 *
 * `httpIdleTimeoutMs` means: give up when the response headers have not arrived, or the body has produced no chunk,
 * for that long. Node gets this from undici's `headersTimeout` and `bodyTimeout`. Bun's fetch has neither (measured on
 * Bun 1.4: a response that stalls for five seconds is returned after five seconds whatever the setting), so on Bun the
 * global fetch is wrapped by `createIdleTimeoutFetch`.
 *
 * Ownership and failure guarantees:
 * - The wrapper owns one AbortController per request. A timer abort rejects the pending `fetch()` or the pending body
 *   read with an error whose `code` is the undici one, so callers that classify undici failures (provider retry, MCP
 *   transport) treat both runtimes alike. A caller's own signal still aborts the request, with the caller's reason.
 * - A timer is armed only while the wrapper waits for the network: it is cleared when headers arrive and while a
 *   consumer is not reading, so a slow consumer never counts as an idle connection.
 * - A response without a body is returned as it is. For a response with a body the wrapper returns a new Response with
 *   the same status, headers, `url` and `redirected`; the body is the original stream read through the timer.
 */

export class HttpIdleTimeoutError extends Error {
	readonly code: "UND_ERR_HEADERS_TIMEOUT" | "UND_ERR_BODY_TIMEOUT";

	constructor(phase: "headers" | "body", timeoutMs: number) {
		super(
			`HTTP ${phase} idle timeout: no ${phase === "headers" ? "response headers" : "body data"} for ${timeoutMs}ms`,
		);
		this.name = "TimeoutError";
		this.code = phase === "headers" ? "UND_ERR_HEADERS_TIMEOUT" : "UND_ERR_BODY_TIMEOUT";
	}
}

type FetchFunction = typeof globalThis.fetch;

function requestSignal(
	input: Parameters<FetchFunction>[0],
	init: Parameters<FetchFunction>[1],
): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
}

/** Wrap `baseFetch` so a stalled response fails after `timeoutMs`. A `timeoutMs` of 0 returns `baseFetch` itself. */
export function createIdleTimeoutFetch(baseFetch: FetchFunction, timeoutMs: number): FetchFunction {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return baseFetch;

	return async function idleTimeoutFetch(input, init) {
		const controller = new AbortController();
		const callerSignal = requestSignal(input, init);
		const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;

		let headersTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
			() => controller.abort(new HttpIdleTimeoutError("headers", timeoutMs)),
			timeoutMs,
		);
		let response: Response;
		try {
			response = await baseFetch(input, { ...init, signal });
		} finally {
			clearTimeout(headersTimer);
			headersTimer = undefined;
		}
		if (!response.body) return response;

		const reader = response.body.getReader();
		let bodyTimer: ReturnType<typeof setTimeout> | undefined;
		const body = new ReadableStream<Uint8Array>({
			async pull(stream) {
				bodyTimer = setTimeout(() => controller.abort(new HttpIdleTimeoutError("body", timeoutMs)), timeoutMs);
				try {
					const chunk = await reader.read();
					if (chunk.done) stream.close();
					else stream.enqueue(chunk.value);
				} catch (error) {
					stream.error(error);
				} finally {
					clearTimeout(bodyTimer);
				}
			},
			async cancel(reason) {
				clearTimeout(bodyTimer);
				await reader.cancel(reason).catch(() => undefined);
				controller.abort(reason);
			},
		});

		const wrapped = new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		Object.defineProperty(wrapped, "url", { value: response.url });
		Object.defineProperty(wrapped, "redirected", { value: response.redirected });
		return wrapped;
	};
}
