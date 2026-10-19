import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isCertificateError } from "@ny4n/ai/utils/transport-error";
import * as undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { createTestCertificates } from "./fixtures/tls-certificates.ts";

// Behavior of the global fetch after `configureHttpDispatcher()` that both backends have to share: undici on Node, the
// wrapped native fetch on Bun. The tests use local servers and the runtime that runs them, so a difference between the
// two shows up as a failure on one runtime. Known differences (the redirect limit, the proxy form) are not asserted.

const isBun = typeof process.versions.bun === "string";
const execFileAsync = promisify(execFile);
const PROXY_ENV = /^(HTTP|HTTPS|ALL|NO)_PROXY$/i;

const originalFetch = globalThis.fetch;
const originalDispatcher = undici.getGlobalDispatcher();
const savedProxyEnv = new Map<string, string | undefined>();

beforeAll(() => {
	for (const key of Object.keys(process.env)) {
		if (!PROXY_ENV.test(key)) continue;
		savedProxyEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	configureHttpDispatcher(30_000);
});

afterAll(async () => {
	for (const [key, value] of savedProxyEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (isBun) {
		configureHttpDispatcher(0);
	} else {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
	}
	globalThis.fetch = originalFetch;
});

const servers: Array<http.Server | https.Server> = [];

async function listen(server: http.Server | https.Server): Promise<number> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

describe("abort and timeout signals", () => {
	it("rejects a pending request with an AbortError (code 20) when the caller aborts", async () => {
		const port = await listen(http.createServer(() => {}));
		const controller = new AbortController();
		const pending = fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);

		expect(await rejection(pending)).toMatchObject({ name: "AbortError", code: 20 });
	});

	it("rejects with the caller's own reason when the abort comes in the middle of the body", async () => {
		const port = await listen(
			http.createServer((_request, response) => {
				response.writeHead(200);
				response.write("first");
			}),
		);
		const controller = new AbortController();
		const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

		const reason = new Error("stop reading");
		const next = reader.read();
		controller.abort(reason);

		expect(await rejection(next)).toBe(reason);
	});

	it("rejects with a TimeoutError (code 23) when AbortSignal.timeout fires", async () => {
		const port = await listen(http.createServer(() => {}));

		const error = await rejection(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) }));

		expect(error).toMatchObject({ name: "TimeoutError", code: 23 });
	});
});

describe("redirects", () => {
	it("follows a chain and reports the final url and redirected", async () => {
		const port = await listen(
			http.createServer((request, response) => {
				const hop = Number(request.url?.slice(1) ?? "0");
				if (hop < 3) {
					response.writeHead(302, { location: `/${hop + 1}` });
					response.end();
					return;
				}
				response.end("arrived");
			}),
		);

		const response = await fetch(`http://127.0.0.1:${port}/0`);

		expect(await response.text()).toBe("arrived");
		expect(response.redirected).toBe(true);
		expect(response.url).toBe(`http://127.0.0.1:${port}/3`);
	});

	it("ends a redirect loop with a TypeError instead of following it for ever", async () => {
		// The limit differs (undici 20, Bun about 127), so only the outcome is asserted.
		const port = await listen(
			http.createServer((_request, response) => {
				response.writeHead(302, { location: "/loop" });
				response.end();
			}),
		);

		expect(await rejection(fetch(`http://127.0.0.1:${port}/loop`))).toBeInstanceOf(TypeError);
	});

	it("does not send an Authorization header to another origin", async () => {
		const seen: Array<string | undefined> = [];
		const target = await listen(
			http.createServer((request, response) => {
				seen.push(request.headers.authorization);
				response.end("target");
			}),
		);
		const origin = await listen(
			http.createServer((_request, response) => {
				response.writeHead(302, { location: `http://127.0.0.1:${target}/` });
				response.end();
			}),
		);

		const response = await fetch(`http://127.0.0.1:${origin}/`, { headers: { authorization: "Bearer secret" } });

		expect(await response.text()).toBe("target");
		expect(seen).toEqual([undefined]);
	});
});

describe("a private certificate authority", () => {
	// NODE_EXTRA_CA_CERTS is read when a process starts, so the request is made by a child process under the same runtime.
	const certificates = createTestCertificates();
	const directory = mkdtempSync(join(tmpdir(), "nyan-http-parity-"));
	const caFile = join(directory, "ca.pem");
	writeFileSync(caFile, certificates.caPem);
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	async function fetchInChild(url: string, extraEnv: Record<string, string>): Promise<Record<string, unknown>> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (
				PROXY_ENV.test(key) ||
				/^(NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|NODE_USE_ENV_PROXY|BUN_OPTIONS)$/.test(key)
			) {
				continue;
			}
			env[key] = value;
		}
		const fixture = join(import.meta.dirname, "fixtures", "fetch-with-dispatcher.ts");
		const { stdout } = await execFileAsync(process.execPath, [fixture, url], {
			env: { ...env, ...extraEnv },
			timeout: 30_000,
		});
		const line = stdout.trim().split("\n").at(-1) ?? "";
		return JSON.parse(line) as Record<string, unknown>;
	}

	async function tlsServerUrl(): Promise<string> {
		const port = await listen(
			https.createServer(
				{ key: certificates.serverKeyPem, cert: certificates.serverCertPem },
				(_request, response) => {
					response.end("hello over tls");
				},
			),
		);
		return `https://localhost:${port}/`;
	}

	it("is trusted through NODE_EXTRA_CA_CERTS", async () => {
		const result = await fetchInChild(await tlsServerUrl(), { NODE_EXTRA_CA_CERTS: caFile });

		expect(result).toEqual({ ok: true, status: 200, body: "hello over tls" });
	}, 40_000);

	it("is refused with a certificate error when it is not trusted", async () => {
		const result = await fetchInChild(await tlsServerUrl(), {});

		expect(result.ok).toBe(false);
		// The code the retry classifier reads names a certificate failure on both runtimes.
		expect(isCertificateError(Object.assign(new Error(), { code: String(result.code) }))).toBe(true);
	}, 40_000);
});
