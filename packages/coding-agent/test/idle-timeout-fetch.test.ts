import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleTimeoutFetch, HttpIdleTimeoutError } from "../src/core/http/idle-timeout.ts";

// These tests use real local servers and the runtime's own fetch, so they run on Node and on Bun.

const TIMEOUT_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let server: http.Server;
let handler: http.RequestListener;
let baseUrl: string;

beforeEach(async () => {
	handler = (_request, response) => response.end("default");
	server = http.createServer((request, response) => handler(request, response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function failure(promise: Promise<unknown>): Promise<Error & { code?: string }> {
	try {
		await promise;
	} catch (error) {
		return error as Error & { code?: string };
	}
	throw new Error("expected the promise to reject");
}

describe("createIdleTimeoutFetch", () => {
	it("returns the fetch it was given when the timeout is disabled", () => {
		expect(createIdleTimeoutFetch(globalThis.fetch, 0)).toBe(globalThis.fetch);
	});

	it("reads a timeout given as a function when each request starts", async () => {
		let timeoutMs = 0;
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, () => timeoutMs);

		// Disabled: the request reaches the base fetch exactly as it came, with no signal added.
		const base = vi.fn<typeof fetch>(async () => new Response("plain"));
		const init = { method: "POST" };
		const passThrough = createIdleTimeoutFetch(base, () => timeoutMs);
		const direct = await passThrough("http://example.invalid/", init);
		expect(base.mock.calls[0]?.[1]).toBe(init);
		expect(await direct.text()).toBe("plain");

		// Enabled later: the same wrapper now applies it.
		handler = () => {};
		timeoutMs = TIMEOUT_MS;
		expect((await failure(fetchWithTimeout(baseUrl))).code).toBe("UND_ERR_HEADERS_TIMEOUT");

		// Disabled again: a prompt response is served as before.
		timeoutMs = 0;
		handler = (_request, response) => response.end("prompt");
		expect(await (await fetchWithTimeout(baseUrl)).text()).toBe("prompt");
	});

	it("passes a prompt response through with its status, headers, url and body", async () => {
		handler = (_request, response) => {
			response.writeHead(201, { "content-type": "text/plain", "x-probe": "yes" });
			response.end("hello");
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);

		const response = await fetchWithTimeout(`${baseUrl}/path`);

		expect(response.status).toBe(201);
		expect(response.headers.get("x-probe")).toBe("yes");
		expect(response.url).toBe(`${baseUrl}/path`);
		expect(await response.text()).toBe("hello");
	});

	it("passes a response without a body through unchanged", async () => {
		handler = (_request, response) => {
			response.writeHead(204);
			response.end();
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);

		const response = await fetchWithTimeout(baseUrl);

		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
	});

	it("rejects with the headers timeout when the headers do not arrive", async () => {
		handler = () => {};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);
		const started = Date.now();

		const error = await failure(fetchWithTimeout(baseUrl));

		expect(error).toBeInstanceOf(HttpIdleTimeoutError);
		expect(error.code).toBe("UND_ERR_HEADERS_TIMEOUT");
		expect(error.name).toBe("TimeoutError");
		expect(error.message).toMatch(/timeout/i);
		expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 8);
	});

	it("rejects the body read with the body timeout when the body stalls", async () => {
		handler = (_request, response) => {
			response.writeHead(200);
			response.write("first");
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);
		const response = await fetchWithTimeout(baseUrl);
		const reader = response.body!.getReader();

		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("first");
		const error = await failure(reader.read());

		expect(error).toBeInstanceOf(HttpIdleTimeoutError);
		expect(error.code).toBe("UND_ERR_BODY_TIMEOUT");
	});

	it("does not time out a body whose chunks keep arriving within the timeout", async () => {
		handler = async (_request, response) => {
			response.writeHead(200);
			for (const part of ["a", "b", "c", "d", "e"]) {
				response.write(part);
				await sleep(TIMEOUT_MS / 2);
			}
			response.end();
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);

		const response = await fetchWithTimeout(baseUrl);

		// Longer in total than the timeout, but never idle for the whole timeout.
		expect(await response.text()).toBe("abcde");
	});

	it("does not count a slow consumer as an idle connection", async () => {
		handler = async (_request, response) => {
			response.writeHead(200);
			response.write("a");
			await sleep(50);
			response.end("b");
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, TIMEOUT_MS);

		const response = await fetchWithTimeout(baseUrl);
		await sleep(TIMEOUT_MS * 3);

		expect(await response.text()).toBe("ab");
	});

	it("aborts with the caller's reason when the caller's signal aborts first", async () => {
		handler = () => {};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, 10_000);
		const controller = new AbortController();
		const pending = fetchWithTimeout(baseUrl, { signal: controller.signal });
		const reason = new Error("caller gave up");

		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it("stops reading the server when the consumer cancels the body", async () => {
		let closed = false;
		handler = (request, response) => {
			response.writeHead(200);
			response.write("first");
			request.on("close", () => {
				closed = true;
			});
		};
		const fetchWithTimeout = createIdleTimeoutFetch(globalThis.fetch, 10_000);
		const response = await fetchWithTimeout(baseUrl);
		const reader = response.body!.getReader();
		await reader.read();

		await reader.cancel();
		for (let attempt = 0; attempt < 50 && !closed; attempt++) await sleep(20);

		expect(closed).toBe(true);
	});
});
