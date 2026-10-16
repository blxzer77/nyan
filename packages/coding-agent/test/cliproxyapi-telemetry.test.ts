import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	computeTokensPerSecond,
	MAX_RECORDED_REQUESTS,
	RequestLog,
	type RequestMetrics,
	summarizeRequests,
	truncateError,
} from "../src/extensions/cliproxyapi/metrics.ts";
import { PauseController } from "../src/extensions/cliproxyapi/pause.ts";
import {
	classifyQuotaWindow,
	fetchManagementQuota,
	formatQuotaSnapshot,
	isQuotaWindowExpired,
	type ManagementQuotaResult,
	parseBanSeconds,
	parseClaudeQuotaSignals,
	parseCodexQuotaSignals,
	parseManagementAuthFiles,
	parseQuotaSignals,
	QuotaPoller,
} from "../src/extensions/cliproxyapi/quota.ts";
import {
	explainMissingQuota,
	QUOTA_EVENT_CHANNEL,
	REQUEST_EVENT_CHANNEL,
	TelemetryHub,
} from "../src/extensions/cliproxyapi/telemetry.ts";
import { UsageReporter } from "../src/extensions/cliproxyapi/usage.ts";

const NOW = 1_800_000_000_000;

function record(overrides: Partial<RequestMetrics> = {}): RequestMetrics {
	return {
		sequence: 1,
		model: "gpt-5",
		pausedMs: 0,
		input: 10,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 110,
		cost: 0.01,
		fast: false,
		attempts: 1,
		...overrides,
	};
}

describe("quota window classification", () => {
	it("classifies by window length, not by primary/secondary", () => {
		expect(classifyQuotaWindow(300)).toBe("5h");
		expect(classifyQuotaWindow(10_080)).toBe("weekly");
		expect(classifyQuotaWindow(60)).toBe("other");
	});

	it("reports a lone weekly window as weekly even when the upstream calls it primary", () => {
		const snapshot = parseCodexQuotaSignals(
			{
				"x-codex-primary-used-percent": "7",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-after-seconds": "556112",
			},
			NOW,
			"response_headers",
		);
		expect(snapshot?.windows.map((window) => window.kind)).toEqual(["weekly"]);
	});
});

describe("parseCodexQuotaSignals", () => {
	const both = {
		"X-Codex-Primary-Used-Percent": "42.5",
		"X-Codex-Primary-Window-Minutes": "300",
		"X-Codex-Primary-Reset-After-Seconds": "3600",
		"X-Codex-Secondary-Used-Percent": "7",
		"X-Codex-Secondary-Window-Minutes": "10080",
		"X-Codex-Secondary-Reset-At": "1800100000",
		"X-Codex-Plan-Type": "plus",
		"X-Codex-Allowed": "true",
		"X-Codex-Limit-Reached": "false",
		"X-Codex-Credits-Has-Credits": "false",
		"X-Codex-Credits-Unlimited": "false",
		"X-Codex-Credits-Balance": "0",
	};

	it("reads 5h and weekly windows with canonical (management API) header casing", () => {
		const snapshot = parseCodexQuotaSignals(both, NOW, "management_api", { name: "a.json" });
		expect(snapshot).toMatchObject({
			source: "management_api",
			observedAt: NOW,
			planType: "plus",
			allowed: true,
			limitReached: false,
			credential: { name: "a.json" },
			credits: { hasCredits: false, unlimited: false, balance: "0" },
		});
		expect(snapshot?.windows).toEqual([
			{ kind: "5h", windowMinutes: 300, usedPercent: 42.5, resetsAt: NOW + 3_600_000 },
			{ kind: "weekly", windowMinutes: 10_080, usedPercent: 7, resetsAt: 1_800_100_000_000 },
		]);
	});

	it("reads lower-case response header names", () => {
		const lower = Object.fromEntries(Object.entries(both).map(([key, value]) => [key.toLowerCase(), value]));
		expect(parseCodexQuotaSignals(lower, NOW, "response_headers")?.windows).toHaveLength(2);
	});

	it("orders the shortest window first whichever slot it arrives in", () => {
		const swapped = {
			"x-codex-primary-used-percent": "7",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-after-seconds": "1",
			"x-codex-secondary-used-percent": "42",
			"x-codex-secondary-window-minutes": "300",
			"x-codex-secondary-reset-after-seconds": "1",
		};
		expect(parseCodexQuotaSignals(swapped, NOW, "response_headers")?.windows.map((w) => w.kind)).toEqual([
			"5h",
			"weekly",
		]);
	});

	it("drops a window that is out of range or incomplete instead of guessing", () => {
		const snapshot = parseCodexQuotaSignals(
			{
				"x-codex-primary-used-percent": "150",
				"x-codex-primary-window-minutes": "300",
				"x-codex-secondary-used-percent": "10",
				// window-minutes is missing
				"x-codex-allowed": "true",
			},
			NOW,
			"response_headers",
		);
		expect(snapshot?.windows).toEqual([]);
		expect(snapshot?.allowed).toBe(true);
	});

	it("returns undefined when there is no quota data at all", () => {
		expect(parseCodexQuotaSignals({ "content-type": "application/json" }, NOW, "response_headers")).toBeUndefined();
		expect(parseCodexQuotaSignals({}, NOW, "response_headers")).toBeUndefined();
	});

	it("flags a window whose reset time has passed as expired", () => {
		const snapshot = parseCodexQuotaSignals(both, NOW, "response_headers");
		const five = snapshot!.windows[0]!;
		expect(isQuotaWindowExpired(five, NOW)).toBe(false);
		expect(isQuotaWindowExpired(five, NOW + 3_600_000)).toBe(true);
	});

	it("renders windows and marks a stale one", () => {
		const snapshot = parseCodexQuotaSignals(both, NOW, "management_api", { name: "a.json" })!;
		const fresh = formatQuotaSnapshot(snapshot, NOW).join("\n");
		expect(fresh).toContain("credential a.json");
		expect(fresh).toContain("5h");
		expect(fresh).toContain("42.5% used");
		expect(fresh).toContain("resets in 1h 0m");
		expect(formatQuotaSnapshot(snapshot, NOW + 7_200_000).join("\n")).toContain("figure is stale");
	});
});

// Captured from a live CLIProxyAPI `GET /v0/management/auth-files` (account identifiers removed).
const LIVE_CODEX_PLUS_SIGNALS = {
	"X-Codex-Active-Limit": "premium",
	"X-Codex-Credits-Balance": "57752.2329720000",
	"X-Codex-Credits-Has-Credits": "True",
	"X-Codex-Credits-Unlimited": "False",
	"X-Codex-Plan-Type": "plus",
	"X-Codex-Primary-Over-Secondary-Limit-Percent": "0",
	"X-Codex-Primary-Reset-After-Seconds": "519137",
	"X-Codex-Primary-Reset-At": "1792649894",
	"X-Codex-Primary-Used-Percent": "28",
	"X-Codex-Primary-Window-Minutes": "10080",
	"X-Codex-Secondary-Reset-After-Seconds": "0",
	"X-Codex-Secondary-Used-Percent": "0",
	"X-Codex-Secondary-Window-Minutes": "0",
};

const LIVE_CLAUDE_SIGNALS = {
	"Anthropic-Ratelimit-Unified-5h-Reset": "1792141800",
	"Anthropic-Ratelimit-Unified-5h-Status": "allowed",
	"Anthropic-Ratelimit-Unified-5h-Utilization": "0.56",
	"Anthropic-Ratelimit-Unified-7d-Reset": "1792728000",
	"Anthropic-Ratelimit-Unified-7d-Status": "allowed",
	"Anthropic-Ratelimit-Unified-7d-Utilization": "0.07",
	"Anthropic-Ratelimit-Unified-Fallback": "available",
	"Anthropic-Ratelimit-Unified-Overage-Status": "rejected",
	"Anthropic-Ratelimit-Unified-Representative-Claim": "five_hour",
	"Anthropic-Ratelimit-Unified-Reset": "1792141800",
	"Anthropic-Ratelimit-Unified-Status": "allowed",
};

describe("live-captured quota shapes", () => {
	it("reads a Codex plus account: only a weekly window, the unused secondary slot is dropped", () => {
		const snapshot = parseCodexQuotaSignals(LIVE_CODEX_PLUS_SIGNALS, NOW, "management_api");
		expect(snapshot).toMatchObject({
			provider: "codex",
			planType: "plus",
			credits: { hasCredits: true, unlimited: false, balance: "57752.2329720000" },
		});
		expect(snapshot?.windows).toEqual([
			{ kind: "weekly", windowMinutes: 10_080, usedPercent: 28, resetsAt: 1_792_649_894_000 },
		]);
	});

	it("reads a Claude account: 5h and 7d utilization as fractions, reset as epoch seconds", () => {
		const snapshot = parseClaudeQuotaSignals(LIVE_CLAUDE_SIGNALS, NOW, "management_api");
		expect(snapshot).toMatchObject({ provider: "claude", allowed: true, limitReached: false });
		expect(snapshot?.windows).toEqual([
			{ kind: "5h", windowMinutes: 300, usedPercent: 56, resetsAt: 1_792_141_800_000, status: "allowed" },
			{ kind: "weekly", windowMinutes: 10_080, usedPercent: 7, resetsAt: 1_792_728_000_000, status: "allowed" },
		]);
	});

	it("marks a Claude account as limit reached when the upstream rejects a window", () => {
		const snapshot = parseClaudeQuotaSignals(
			{
				...LIVE_CLAUDE_SIGNALS,
				"Anthropic-Ratelimit-Unified-5h-Utilization": "1",
				"Anthropic-Ratelimit-Unified-5h-Status": "rejected",
			},
			NOW,
			"management_api",
		);
		expect(snapshot).toMatchObject({ allowed: false, limitReached: true });
		expect(snapshot?.windows[0]).toMatchObject({ usedPercent: 100, status: "rejected" });
		expect(formatQuotaSnapshot(snapshot!, NOW).join("\n")).toContain("[rejected]");
	});

	it("rejects out-of-range Claude utilization instead of reading it as a percentage", () => {
		// 56 would be a percent, not a fraction; reading it as 5600% would be wrong in the other direction.
		expect(
			parseClaudeQuotaSignals({ "anthropic-ratelimit-unified-5h-utilization": "56" }, NOW, "response_headers"),
		).toBeUndefined();
	});

	it("tells the families apart from the same key set, and ignores the overage-only or fallback-only keys", () => {
		expect(parseQuotaSignals(LIVE_CODEX_PLUS_SIGNALS, NOW, "management_api")?.provider).toBe("codex");
		expect(parseQuotaSignals(LIVE_CLAUDE_SIGNALS, NOW, "management_api")?.provider).toBe("claude");
		expect(
			parseQuotaSignals({ "anthropic-ratelimit-unified-fallback": "available" }, NOW, "response_headers"),
		).toBeUndefined();
	});
});

describe("parseManagementAuthFiles", () => {
	const signals = {
		"X-Codex-Primary-Used-Percent": "10",
		"X-Codex-Primary-Window-Minutes": "300",
		"X-Codex-Primary-Reset-After-Seconds": "600",
	};
	const observed = "2026-10-16T08:00:00Z";

	it("returns one snapshot per enabled Codex credential and skips everything else", () => {
		const parsed = parseManagementAuthFiles({
			files: [
				{ name: "one.json", provider: "codex", auth_index: "0", quota: { observed_at: observed, signals } },
				{ name: "two.json", type: "codex", label: "work", quota: { observed_at: observed, signals } },
				{ name: "off.json", provider: "codex", disabled: true, quota: { observed_at: observed, signals } },
				{ name: "antigravity.json", provider: "antigravity", quota: { observed_at: observed, signals } },
				// a Claude entry whose signals are Codex-shaped carries no Claude window, so nothing is invented
				{ name: "claude-wrongshape.json", provider: "claude", quota: { observed_at: observed, signals } },
				{ name: "undated.json", provider: "codex", quota: { signals } },
				{ name: "empty.json", provider: "codex", quota: { observed_at: observed, signals: {} } },
			],
		});
		expect(parsed?.map((snapshot) => snapshot.credential?.name)).toEqual(["one.json", "two.json"]);
		expect(parsed?.[0]?.observedAt).toBe(Date.parse(observed));
		expect(parsed?.[0]?.credential?.authIndex).toBe("0");
		expect(parsed?.[1]?.credential?.label).toBe("work");
	});

	it("rejects a payload without a files array", () => {
		expect(parseManagementAuthFiles({})).toBeUndefined();
		expect(parseManagementAuthFiles(null)).toBeUndefined();
		expect(parseManagementAuthFiles({ files: "nope" })).toBeUndefined();
	});
});

describe("fetchManagementQuota", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
						server.closeAllConnections();
					}),
			),
		);
	});

	async function serve(handler: RequestListener): Promise<string> {
		const server = createServer(handler);
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	it("sends the management key as a bearer token to the auth-files route and parses the answer", async () => {
		let seen: { url?: string; headers?: IncomingHttpHeaders } = {};
		const rootOrigin = await serve((request, response) => {
			seen = { url: request.url, headers: request.headers };
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					files: [
						{
							name: "one.json",
							provider: "codex",
							quota: {
								observed_at: "2026-10-16T08:00:00Z",
								signals: { "X-Codex-Primary-Used-Percent": "5", "X-Codex-Primary-Window-Minutes": "300" },
							},
						},
					],
				}),
			);
		});
		const result = await fetchManagementQuota({ rootOrigin, managementKey: "mgmt-secret", now: () => NOW });
		expect(seen.url).toBe("/v0/management/auth-files");
		expect(seen.headers?.authorization).toBe("Bearer mgmt-secret");
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.fetchedAt).toBe(NOW);
			expect(result.credentials[0]?.windows[0]?.kind).toBe("5h");
		}
	});

	it("does not contact the proxy without a management key", async () => {
		let contacted = false;
		const rootOrigin = await serve((_request, response) => {
			contacted = true;
			response.end("{}");
		});
		expect(await fetchManagementQuota({ rootOrigin, managementKey: undefined })).toEqual({
			status: "no_management_key",
		});
		expect(contacted).toBe(false);
	});

	it.each([
		[401, "unauthorized"],
		[404, "unavailable"],
		[500, "unavailable"],
	])("maps HTTP %i to %s", async (status, expected) => {
		const rootOrigin = await serve((_request, response) => {
			response.writeHead(status);
			response.end();
		});
		const result = await fetchManagementQuota({ rootOrigin, managementKey: "k" });
		expect(result.status).toBe(expected);
	});

	it("tells a ban from other 403s, and reads how long the ban lasts", async () => {
		const banned = await serve((_request, response) => {
			response.writeHead(403, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "IP banned due to too many failed attempts. Try again in 28m22s" }));
		});
		expect(await fetchManagementQuota({ rootOrigin: banned, managementKey: "k" })).toEqual({
			status: "banned",
			retryAfterSeconds: 28 * 60 + 22,
		});

		const disabled = await serve((_request, response) => {
			response.writeHead(403, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "remote management disabled" }));
		});
		expect(await fetchManagementQuota({ rootOrigin: disabled, managementKey: "k" })).toEqual({
			status: "forbidden",
			message: "remote management disabled",
		});
	});

	it("reports a body that is not JSON, or has no files, as an invalid response", async () => {
		const html = await serve((_request, response) => {
			response.writeHead(200);
			response.end("<html>not json</html>");
		});
		expect((await fetchManagementQuota({ rootOrigin: html, managementKey: "k" })).status).toBe("invalid_response");
		const noFiles = await serve((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end("{}");
		});
		expect((await fetchManagementQuota({ rootOrigin: noFiles, managementKey: "k" })).status).toBe("invalid_response");
	});

	it("reports an unreachable proxy as a network error", async () => {
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const result = await fetchManagementQuota({ rootOrigin: `http://127.0.0.1:${port}`, managementKey: "k" });
		expect(result.status).toBe("network_error");
	});
});

describe("QuotaPoller", () => {
	it("throttles, bypasses the throttle on force, and shares one in-flight request", async () => {
		let now = 0;
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const results: ManagementQuotaResult[] = [];
		const poller = new QuotaPoller({
			minIntervalMs: 60_000,
			now: () => now,
			fetch: async () => {
				calls++;
				await gate;
				return { status: "ok", fetchedAt: now, credentials: [] };
			},
			onResult: (result) => results.push(result),
		});

		const first = poller.refresh();
		const concurrent = poller.refresh(true);
		expect(calls).toBe(1);
		release?.();
		await Promise.all([first, concurrent]);
		expect(results).toHaveLength(1);

		now = 30_000;
		expect(await poller.refresh()).toBeUndefined();
		expect(calls).toBe(1);

		await poller.refresh(true);
		expect(calls).toBe(2);

		now = 200_000;
		await poller.refresh();
		expect(calls).toBe(3);
	});
});

describe("parseBanSeconds", () => {
	it("reads Go durations", () => {
		expect(parseBanSeconds("IP banned. Try again in 28m22s")).toBe(1702);
		expect(parseBanSeconds("Try again in 1h2m3s")).toBe(3723);
		expect(parseBanSeconds("Try again in 30m0s")).toBe(1800);
		expect(parseBanSeconds("Try again in 45s")).toBe(45);
		expect(parseBanSeconds("Try again in 1.5s")).toBe(2);
	});

	it("returns undefined when no duration is given", () => {
		expect(parseBanSeconds("remote management disabled")).toBeUndefined();
		expect(parseBanSeconds("")).toBeUndefined();
	});
});

describe("QuotaPoller protects the proxy's failed-attempt budget", () => {
	function harness(responses: ManagementQuotaResult[], fingerprintOf: () => string | undefined = () => "key-a") {
		let now = 0;
		let calls = 0;
		const poller = new QuotaPoller({
			minIntervalMs: 0,
			now: () => now,
			fingerprint: fingerprintOf,
			fetch: async () => responses[Math.min(calls++, responses.length - 1)]!,
			onResult: () => {},
		});
		return {
			poller,
			calls: () => calls,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}
	const ok: ManagementQuotaResult = { status: "ok", fetchedAt: 0, credentials: [] };

	it("does not resend a key the proxy rejected, even when forced", async () => {
		const h = harness([{ status: "unauthorized", httpStatus: 401 }]);
		await h.poller.refresh();
		expect(h.poller.keyRejected()).toBe(true);
		expect(await h.poller.refresh()).toBeUndefined();
		expect(await h.poller.refresh(true)).toBeUndefined();
		expect(h.calls()).toBe(1);
	});

	it("polls again as soon as the key changes", async () => {
		let fingerprint = "key-a";
		const h = harness([{ status: "unauthorized", httpStatus: 401 }, ok], () => fingerprint);
		await h.poller.refresh();
		fingerprint = "key-b";
		expect((await h.poller.refresh())?.status).toBe("ok");
		expect(h.calls()).toBe(2);
		// a success clears the memory of the rejection
		fingerprint = "key-a";
		expect((await h.poller.refresh())?.status).toBe("ok");
	});

	it("stays quiet for the length of a ban and then resumes", async () => {
		const h = harness([{ status: "banned", retryAfterSeconds: 600 }, ok]);
		await h.poller.refresh();
		expect(h.poller.banEndsAt()).toBe(600_000);
		h.advance(599_000);
		expect(await h.poller.refresh(true)).toBeUndefined();
		h.advance(2_000);
		expect(h.poller.banEndsAt()).toBeUndefined();
		expect((await h.poller.refresh())?.status).toBe("ok");
		expect(h.calls()).toBe(2);
	});

	it("assumes the proxy's own 30 minute ban when it gives no duration", async () => {
		const h = harness([{ status: "banned" }]);
		await h.poller.refresh();
		expect(h.poller.banEndsAt()).toBe(30 * 60_000);
	});

	it("keeps polling after transient failures", async () => {
		const h = harness([{ status: "network_error", message: "boom" }, { status: "unavailable", httpStatus: 502 }, ok]);
		await h.poller.refresh();
		await h.poller.refresh();
		expect((await h.poller.refresh())?.status).toBe("ok");
	});
});

describe("request metrics", () => {
	it("computes throughput only over a meaningful generation window", () => {
		expect(computeTokensPerSecond(200, 1000)).toBe(200);
		expect(computeTokensPerSecond(200, 100)).toBeUndefined();
		expect(computeTokensPerSecond(0, 1000)).toBeUndefined();
		expect(computeTokensPerSecond(200, undefined)).toBeUndefined();
	});

	it("summarizes ttft, weighted throughput, failures and retries", () => {
		const summary = summarizeRequests([
			record({ ttftMs: 100, totalMs: 1100, generationMs: 1000, tokensPerSecond: 100, output: 100 }),
			record({ ttftMs: 300, totalMs: 4300, generationMs: 4000, tokensPerSecond: 50, output: 200 }),
			record({ ttftMs: 200, totalMs: 500, stopReason: "error", httpStatus: 429, attempts: 2, output: 0 }),
			record({ output: 50 }),
		]);
		expect(summary.requests).toBe(4);
		expect(summary.failed).toBe(1);
		expect(summary.retried).toBe(1);
		expect(summary.avgTtftMs).toBe(200);
		expect(summary.medianTtftMs).toBe(200);
		expect(summary.maxTtftMs).toBe(300);
		// (100 + 200) tokens over (1000 + 4000) ms, not the mean of 100 and 50 tok/s
		expect(summary.tokensPerSecond).toBe(60);
		expect(summary.output).toBe(350);
	});

	it("leaves unobserved figures absent rather than zero", () => {
		const summary = summarizeRequests([record()]);
		expect(summary.avgTtftMs).toBeUndefined();
		expect(summary.tokensPerSecond).toBeUndefined();
		expect(summarizeRequests([]).requests).toBe(0);
	});

	it("keeps only the newest records", () => {
		const log = new RequestLog();
		for (let index = 0; index < MAX_RECORDED_REQUESTS + 5; index++) log.push(record({ sequence: log.nextId() }));
		expect(log.list()).toHaveLength(MAX_RECORDED_REQUESTS);
		expect(log.list()[0]?.sequence).toBe(6);
	});

	it("truncates long provider errors", () => {
		expect(truncateError("x".repeat(1000))?.length).toBe(301);
		expect(truncateError(undefined)).toBeUndefined();
	});
});

describe("UsageReporter request records", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const PROVIDER = "cliproxyapi";

	let handlers: Map<string, Handler[]>;
	let records: RequestMetrics[];
	let headerCalls: Array<Record<string, string>>;
	let pause: PauseController;
	let reporter: UsageReporter;

	const fire = (name: string, event: unknown, ctx: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	const ctxFor = (provider: string) => ({ model: { provider, id: "gpt-5" }, hasUI: false, mode: "print" });
	const message = (overrides: Record<string, unknown> = {}) => ({
		role: "assistant",
		provider: PROVIDER,
		model: "gpt-5",
		stopReason: "stop",
		usage: { input: 10, output: 100, cacheRead: 5, cacheWrite: 0, totalTokens: 115, cost: { total: 0.02 } },
		...overrides,
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		handlers = new Map();
		records = [];
		headerCalls = [];
		pause = new PauseController(false);
		reporter = new UsageReporter({
			providerId: PROVIDER,
			pauseMode: pause,
			isFastEffective: () => true,
			onRequest: (entry) => records.push(entry),
			onResponseHeaders: (headers) => headerCalls.push(headers),
		});
		reporter.register({
			on: (name: string, handler: Handler) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				return () => {};
			},
		} as unknown as ExtensionAPI);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("measures ttft, generation window and throughput of one request", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		vi.setSystemTime(1100);
		fire("after_provider_response", { status: 200, headers: { "x-cpa-trace-id": "trace-1", "retry-after": "3" } });
		vi.setSystemTime(1500);
		fire("provider_stream_event", { provider: PROVIDER });
		vi.setSystemTime(2500);
		fire("message_end", { message: message() });

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			sequence: 1,
			model: "gpt-5",
			startedAt: 1000,
			httpStatus: 200,
			headersMs: 100,
			ttftMs: 500,
			generationMs: 1000,
			totalMs: 1500,
			pausedMs: 0,
			tokensPerSecond: 100,
			input: 10,
			output: 100,
			cacheRead: 5,
			cost: 0.02,
			fast: true,
			attempts: 1,
			stopReason: "stop",
			traceId: "trace-1",
			retryAfterSeconds: 3,
		});
		expect(headerCalls).toHaveLength(1);
	});

	it("excludes time spent paused from ttft and total", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		// /pause held the request for two seconds before it was sent
		pause.setEnabled(true, 1000);
		pause.setEnabled(false, 3000);
		vi.setSystemTime(3500);
		fire("provider_stream_event", { provider: PROVIDER });
		vi.setSystemTime(4500);
		fire("message_end", { message: message() });

		expect(records[0]).toMatchObject({ pausedMs: 2000, ttftMs: 500, generationMs: 1000, totalMs: 1500 });
	});

	it("counts a second provider call before the message ends as a retry and restarts the clock", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		vi.setSystemTime(1200);
		fire("after_provider_response", { status: 503, headers: {} });
		vi.setSystemTime(2000);
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		vi.setSystemTime(2300);
		fire("provider_stream_event", { provider: PROVIDER });
		vi.setSystemTime(3300);
		fire("message_end", { message: message() });

		expect(records[0]).toMatchObject({ attempts: 2, ttftMs: 300, startedAt: 2000 });
		expect(records[0]?.httpStatus).toBeUndefined();
	});

	it("records a failed request with its status and a bounded error", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		vi.setSystemTime(1100);
		fire("after_provider_response", { status: 429, headers: {} });
		vi.setSystemTime(1150);
		fire("message_end", {
			message: message({ stopReason: "error", errorMessage: "e".repeat(2000), usage: { output: 0 } }),
		});

		expect(records[0]).toMatchObject({ httpStatus: 429, stopReason: "error", output: 0 });
		expect(records[0]?.error?.length).toBe(301);
		expect(records[0]?.ttftMs).toBeUndefined();
		expect(records[0]?.tokensPerSecond).toBeUndefined();
	});

	it("does not attribute another provider's response headers to the proxy", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		fire("message_end", { message: message() });
		// the next request goes to native openai-codex, whose own x-codex-* headers are not the proxy's
		fire("before_provider_request", {}, ctxFor("openai-codex"));
		fire("after_provider_response", { status: 200, headers: { "x-codex-primary-used-percent": "99" } });
		expect(headerCalls).toEqual([]);
		fire("message_end", { message: message({ provider: "openai-codex" }) });
		expect(records).toHaveLength(1);
	});

	it("drops a pending request that never ended when another provider is used", () => {
		fire("before_provider_request", {}, ctxFor(PROVIDER));
		fire("before_provider_request", {}, ctxFor("anthropic"));
		fire("message_end", { message: message() });
		expect(records[0]?.startedAt).toBeUndefined();
		expect(records[0]?.attempts).toBe(1);
	});

	it("still records tokens when the start was never observed", () => {
		fire("message_end", { message: message() });
		expect(records[0]).toMatchObject({ output: 100, pausedMs: 0 });
		expect(records[0]?.totalMs).toBeUndefined();
	});

	it("ignores user messages and other providers' messages", () => {
		fire("message_end", { message: { role: "user" } });
		fire("message_end", { message: message({ provider: "anthropic" }) });
		expect(records).toEqual([]);
	});

	it("survives a consumer that throws", () => {
		const throwing = new UsageReporter({
			providerId: PROVIDER,
			pauseMode: pause,
			onRequest: () => {
				throw new Error("consumer broke");
			},
		});
		const local = new Map<string, Handler[]>();
		throwing.register({
			on: (name: string, handler: Handler) => {
				local.set(name, [...(local.get(name) ?? []), handler]);
				return () => {};
			},
		} as unknown as ExtensionAPI);
		expect(() => local.get("message_end")?.[0]?.({ message: message() }, {})).not.toThrow();
	});
});

describe("TelemetryHub", () => {
	function bus(): { events: EventBus; emitted: Array<[string, unknown]> } {
		const emitted: Array<[string, unknown]> = [];
		return { emitted, events: { emit: (channel, data) => emitted.push([channel, data]), on: () => () => {} } };
	}

	it("emits one event per request and keeps a bounded snapshot", () => {
		const { events, emitted } = bus();
		const hub = new TelemetryHub({ events, managementKeyConfigured: false, now: () => NOW });
		hub.recordRequest(record({ sequence: hub.nextRequestId() }));
		expect(emitted).toEqual([[REQUEST_EVENT_CHANNEL, expect.objectContaining({ sequence: 1 })]]);
		expect(hub.snapshot().requests).toMatchObject({ total: 1, summary: { requests: 1 } });
		hub.resetRequests();
		expect(hub.snapshot().requests).toMatchObject({ total: 0, recent: [] });
	});

	it("emits a quota event only when response headers carry quota", () => {
		const { events, emitted } = bus();
		const hub = new TelemetryHub({ events, managementKeyConfigured: false, now: () => NOW });
		hub.observeResponseHeaders({ "content-type": "text/event-stream" });
		expect(emitted).toEqual([]);
		hub.observeResponseHeaders({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "60",
		});
		expect(emitted[0]?.[0]).toBe(QUOTA_EVENT_CHANNEL);
		expect(hub.quotaView().fromResponse?.windows[0]).toMatchObject({ kind: "5h", usedPercent: 12 });
	});

	it("keeps the last good credentials when a later poll fails, and says why", () => {
		const hub = new TelemetryHub({ managementKeyConfigured: true, now: () => NOW });
		const good = parseCodexQuotaSignals(
			{ "x-codex-primary-used-percent": "5", "x-codex-primary-window-minutes": "300" },
			NOW,
			"management_api",
		)!;
		hub.applyManagementResult({ status: "ok", fetchedAt: NOW, credentials: [good] });
		hub.applyManagementResult({ status: "unauthorized", httpStatus: 401 });
		const view = hub.quotaView();
		expect(view.management).toMatchObject({ status: "unauthorized", detail: "HTTP 401", fetchedAt: NOW });
		expect(view.management.credentials).toHaveLength(1);
	});
});

describe("explainMissingQuota", () => {
	const empty = { status: "not_polled" as const, credentials: [] };

	it("tells the user how to get quota when nothing is configured", () => {
		const text = explainMissingQuota({ management: empty, managementKeyConfigured: false });
		expect(text).toContain("CLIPROXYAPI_MANAGEMENT_KEY");
		expect(text).toContain("passthrough-headers");
	});

	it("explains a ban and a refused management API", () => {
		expect(
			explainMissingQuota({
				management: { status: "banned", credentials: [], detail: "banned, retry in 29 min" },
				managementKeyConfigured: true,
			}),
		).toContain("banned this address");
		expect(
			explainMissingQuota({
				management: { status: "forbidden", credentials: [], detail: "remote management disabled" },
				managementKeyConfigured: true,
			}),
		).toContain("remote management disabled");
	});

	it("distinguishes a rejected key, a disabled management API and an unpolled state", () => {
		expect(
			explainMissingQuota({
				management: { status: "unauthorized", credentials: [], detail: "HTTP 401" },
				managementKeyConfigured: true,
			}),
		).toContain("rejected the management key");
		expect(
			explainMissingQuota({
				management: { status: "unavailable", credentials: [], detail: "HTTP 404" },
				managementKeyConfigured: true,
			}),
		).toContain("remote-management.secret-key");
		expect(explainMissingQuota({ management: empty, managementKeyConfigured: true })).toContain("not been polled");
	});

	it("says nothing when some source supplied data", () => {
		const snapshot = parseCodexQuotaSignals(
			{ "x-codex-primary-used-percent": "5", "x-codex-primary-window-minutes": "300" },
			NOW,
			"response_headers",
		)!;
		expect(explainMissingQuota({ fromResponse: snapshot, management: empty, managementKeyConfigured: false })).toBe(
			undefined,
		);
	});
});
