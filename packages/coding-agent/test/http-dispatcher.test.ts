import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNativeFetchForTests } from "../src/core/http/native.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
const DISPATCHER_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

const isBun = typeof process.versions.bun === "string";

// The undici dispatcher is what Node uses. Bun keeps its native fetch (see the "native fetch on Bun" tests below),
// which no undici dispatcher applies to.
describe.skipIf(isBun)("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});
});

describe.runIf(isBun)("native fetch on Bun", () => {
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		// Back to the fetch that was global when the file loaded, with the dispatcher's memory of what it installed (and its
		// one wrapper) forgotten, so every test configures from scratch and none depends on the one before it.
		resetNativeFetchForTests();
		globalThis.fetch = originalFetch;
	});

	async function listen(server: http.Server | net.Server): Promise<number> {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return (server.address() as net.AddressInfo).port;
	}

	it("wraps the native fetch with the idle timeout and unwraps it when the timeout is disabled", async () => {
		configureHttpDispatcher(1_000);
		const wrapped = globalThis.fetch;
		expect(wrapped).not.toBe(originalFetch);

		// One wrapper for the life of the process: the timeout it applies is the one set last (see the captured-client tests).
		configureHttpDispatcher(2_000);
		expect(globalThis.fetch).toBe(wrapped);

		configureHttpDispatcher(0);
		expect(globalThis.fetch).toBe(originalFetch);
	});

	it("applies the idle timeout to requests", async () => {
		const stalled = http.createServer(() => {});
		const port = await listen(stalled);
		try {
			configureHttpDispatcher(200);
			await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "UND_ERR_HEADERS_TIMEOUT" });
		} finally {
			stalled.closeAllConnections();
			await new Promise<void>((resolve) => stalled.close(() => resolve()));
		}
	});

	// A client built before the setting changed (an SDK client keeps the fetch it was constructed with) must follow it.
	it("applies a changed timeout to a client that captured fetch before the change", async () => {
		const stalled = http.createServer(() => {});
		const port = await listen(stalled);
		try {
			configureHttpDispatcher(60_000);
			const captured = globalThis.fetch;
			expect(captured).not.toBe(originalFetch);
			configureHttpDispatcher(200);
			await expect(captured(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "UND_ERR_HEADERS_TIMEOUT" });
		} finally {
			stalled.closeAllConnections();
			await new Promise<void>((resolve) => stalled.close(() => resolve()));
		}
	}, 5_000);

	it("stops applying the timeout to a captured client when the timeout is disabled", async () => {
		const slow = http.createServer((_request, response) => {
			setTimeout(() => response.end("late"), 500);
		});
		const port = await listen(slow);
		try {
			configureHttpDispatcher(200);
			const captured = globalThis.fetch;
			expect(captured).not.toBe(originalFetch);
			configureHttpDispatcher(0);
			expect(globalThis.fetch).toBe(originalFetch);
			const response = await captured(`http://127.0.0.1:${port}/`);
			expect(await response.text()).toBe("late");
		} finally {
			slow.closeAllConnections();
			await new Promise<void>((resolve) => slow.close(() => resolve()));
		}
	}, 5_000);

	it("updates the timeout a held wrapper applies even when someone else's fetch is the global one", async () => {
		const stalled = http.createServer(() => {});
		const port = await listen(stalled);
		try {
			configureHttpDispatcher(60_000);
			const held = globalThis.fetch;
			const custom = (async () => new Response("custom")) as typeof fetch;
			globalThis.fetch = custom;

			configureHttpDispatcher(200);

			expect(globalThis.fetch).toBe(custom);
			await expect(held(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "UND_ERR_HEADERS_TIMEOUT" });
		} finally {
			stalled.closeAllConnections();
			await new Promise<void>((resolve) => stalled.close(() => resolve()));
		}
	}, 5_000);

	it("leaves a fetch that someone else installed alone", () => {
		const custom = (async () => new Response("custom")) as typeof fetch;
		globalThis.fetch = custom;

		configureHttpDispatcher(1_000);

		expect(globalThis.fetch).toBe(custom);
	});
});
