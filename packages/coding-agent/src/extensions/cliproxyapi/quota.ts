/**
 * Plan-quota observations (the "5 hour" and "weekly" limits) of the Codex account behind CLIProxyAPI.
 *
 * CLIProxyAPI does not hand quota to a client by default:
 *   - `codex.rate_limits` stream events are filtered out for Responses clients;
 *   - `x-codex-*` response headers are forwarded only when the proxy runs with `passthrough-headers: true`;
 *   - the management API (`GET /v0/management/auth-files`) returns the same `X-Codex-*` keys under
 *     `quota.signals` for every pooled credential, but needs the management key, which is not the API key.
 *
 * Both sources use the same header names, so one parser serves both. A source that is unavailable is
 * reported with a reason; it is never reported as an empty quota.
 *
 * Two upstream families are understood, both verified against a live proxy's `auth-files` answer:
 *   - Codex:  `x-codex-{primary,secondary}-*`, percent 0-100, window length in minutes, reset as epoch seconds
 *             or seconds from now. A plus plan reports only a weekly window.
 *   - Claude: `anthropic-ratelimit-unified-{5h,7d}-*`, utilization as a 0-1 fraction, reset as epoch seconds.
 */

import { errorMessage } from "./log.ts";

const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 10_080;

export const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000;
/** Quota changes slowly and the proxy answers from memory, so polling it more often only adds load. */
export const QUOTA_MIN_REFRESH_MS = 60_000;

export type QuotaWindowKind = "5h" | "weekly" | "other";

export type QuotaProvider = "codex" | "claude";

export interface QuotaWindow {
	kind: QuotaWindowKind;
	windowMinutes: number;
	usedPercent: number;
	/** Epoch milliseconds at which the window resets, when the upstream said so. */
	resetsAt?: number;
	/** The upstream's own verdict for this window (`allowed`, `allowed_warning`, `rejected`), when it gives one. */
	status?: string;
}

export interface QuotaCredential {
	name?: string;
	authIndex?: string;
	label?: string;
}

export interface QuotaSnapshot {
	provider: QuotaProvider;
	source: "response_headers" | "management_api";
	/** When the upstream last reported these numbers. For `management_api` this is the proxy's observation time, not the poll time. */
	observedAt: number;
	credential?: QuotaCredential;
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
	/** Shortest window first, so the 5 hour window precedes the weekly one. */
	windows: QuotaWindow[];
}

/**
 * Windows are classified by their length, never by the `primary`/`secondary` name: the upstream
 * reports a single weekly window as `primary` when a plan has no 5 hour window.
 */
export function classifyQuotaWindow(windowMinutes: number): QuotaWindowKind {
	if (windowMinutes === FIVE_HOURS_MINUTES) return "5h";
	if (windowMinutes === WEEK_MINUTES) return "weekly";
	return "other";
}

/** A window whose reset time has passed describes a period that is over, so its percentage is stale. */
export function isQuotaWindowExpired(window: QuotaWindow, now: number): boolean {
	return window.resetsAt !== undefined && now >= window.resetsAt;
}

function lowerCaseRecord(source: Readonly<Record<string, string>>): Map<string, string> {
	const map = new Map<string, string>();
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "string") map.set(key.toLowerCase(), value.trim());
	}
	return map;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	const normalized = value?.toLowerCase();
	return normalized === "true" ? true : normalized === "false" ? false : undefined;
}

function parseWindow(fields: Map<string, string>, prefix: string, observedAt: number): QuotaWindow | undefined {
	const usedPercent = parseNumber(fields.get(`${prefix}-used-percent`));
	const windowMinutes = parseNumber(fields.get(`${prefix}-window-minutes`));
	if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined;
	if (windowMinutes === undefined || windowMinutes <= 0) return undefined;

	const resetAt = parseNumber(fields.get(`${prefix}-reset-at`));
	const resetAfter = parseNumber(fields.get(`${prefix}-reset-after-seconds`));
	let resetsAt: number | undefined;
	if (resetAt !== undefined && resetAt > 0) resetsAt = resetAt * 1000;
	else if (resetAfter !== undefined && resetAfter >= 0) resetsAt = observedAt + resetAfter * 1000;

	return {
		kind: classifyQuotaWindow(windowMinutes),
		windowMinutes,
		usedPercent,
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

/**
 * Parse the base (non-"additional", non-"code review") Codex quota keys from response headers or from the
 * management API's `signals`. Returns undefined when the source carries no usable quota.
 */
export function parseCodexQuotaSignals(
	signals: Readonly<Record<string, string>>,
	observedAt: number,
	source: QuotaSnapshot["source"],
	credential?: QuotaCredential,
): QuotaSnapshot | undefined {
	const fields = lowerCaseRecord(signals);
	const windows = ["x-codex-primary", "x-codex-secondary"]
		.map((prefix) => parseWindow(fields, prefix, observedAt))
		.filter((window): window is QuotaWindow => window !== undefined)
		.sort((a, b) => a.windowMinutes - b.windowMinutes);
	const allowed = parseBoolean(fields.get("x-codex-allowed"));
	const limitReached = parseBoolean(fields.get("x-codex-limit-reached"));
	if (windows.length === 0 && allowed === undefined && limitReached === undefined) return undefined;

	const planType = fields.get("x-codex-plan-type");
	const hasCredits = parseBoolean(fields.get("x-codex-credits-has-credits"));
	const unlimited = parseBoolean(fields.get("x-codex-credits-unlimited"));
	const balance = fields.get("x-codex-credits-balance");
	const hasCreditInfo = hasCredits !== undefined || unlimited !== undefined || balance !== undefined;

	return {
		provider: "codex",
		source,
		observedAt,
		...(credential ? { credential } : {}),
		...(planType ? { planType } : {}),
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(hasCreditInfo
			? {
					credits: {
						...(hasCredits !== undefined ? { hasCredits } : {}),
						...(unlimited !== undefined ? { unlimited } : {}),
						...(balance ? { balance } : {}),
					},
				}
			: {}),
		windows,
	};
}

const CLAUDE_WINDOWS = [
	{ prefix: "anthropic-ratelimit-unified-5h", windowMinutes: FIVE_HOURS_MINUTES },
	{ prefix: "anthropic-ratelimit-unified-7d", windowMinutes: WEEK_MINUTES },
] as const;

/** Parse the Claude `anthropic-ratelimit-unified-*` keys. Returns undefined when no window is present. */
export function parseClaudeQuotaSignals(
	signals: Readonly<Record<string, string>>,
	observedAt: number,
	source: QuotaSnapshot["source"],
	credential?: QuotaCredential,
): QuotaSnapshot | undefined {
	const fields = lowerCaseRecord(signals);
	const windows: QuotaWindow[] = [];
	for (const { prefix, windowMinutes } of CLAUDE_WINDOWS) {
		const utilization = parseNumber(fields.get(`${prefix}-utilization`));
		if (utilization === undefined || utilization < 0 || utilization > 1) continue;
		const reset = parseNumber(fields.get(`${prefix}-reset`));
		const status = fields.get(`${prefix}-status`);
		windows.push({
			kind: classifyQuotaWindow(windowMinutes),
			windowMinutes,
			// Two decimals: 0.56 * 100 is 56.00000000000001 in floating point.
			usedPercent: Math.round(utilization * 10_000) / 100,
			...(reset !== undefined && reset > 0 ? { resetsAt: reset * 1000 } : {}),
			...(status ? { status } : {}),
		});
	}
	if (windows.length === 0) return undefined;

	// The overall status is what the upstream enforces; a rejected window means requests are being refused.
	const overall = fields.get("anthropic-ratelimit-unified-status");

	const limitReached = overall === "rejected" || windows.some((window) => window.status === "rejected");
	return {
		provider: "claude",
		source,
		observedAt,
		...(credential ? { credential } : {}),
		allowed: !limitReached,
		limitReached,
		windows,
	};
}

/** Try each known upstream family on the same key/value set. */
export function parseQuotaSignals(
	signals: Readonly<Record<string, string>>,
	observedAt: number,
	source: QuotaSnapshot["source"],
	credential?: QuotaCredential,
): QuotaSnapshot | undefined {
	return (
		parseCodexQuotaSignals(signals, observedAt, source, credential) ??
		parseClaudeQuotaSignals(signals, observedAt, source, credential)
	);
}

export type ManagementQuotaResult =
	| { status: "ok"; fetchedAt: number; credentials: QuotaSnapshot[] }
	| { status: "no_management_key" }
	/** The proxy rejected the key (HTTP 401). Each such attempt counts toward the proxy's ban. */
	| { status: "unauthorized"; httpStatus: 401 }
	/** The proxy banned this client address after repeated failed attempts, for everyone behind that address. */
	| { status: "banned"; retryAfterSeconds?: number }
	/** HTTP 403 for another reason, such as remote management being switched off. */
	| { status: "forbidden"; message: string }
	| { status: "unavailable"; httpStatus: number }
	| { status: "network_error"; message: string }
	| { status: "invalid_response"; message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Quota of every enabled Codex or Claude credential in an `auth-files` response. Other providers report no quota signals and are skipped. */
export function parseManagementAuthFiles(payload: unknown): QuotaSnapshot[] | undefined {
	const files = asRecord(payload)?.files;
	if (!Array.isArray(files)) return undefined;

	const snapshots: QuotaSnapshot[] = [];
	for (const raw of files) {
		const entry = asRecord(raw);
		if (!entry || entry.disabled === true) continue;
		const provider = (stringOrUndefined(entry.provider) ?? stringOrUndefined(entry.type) ?? "").toLowerCase();
		if (provider !== "codex" && provider !== "claude") continue;

		const quota = asRecord(entry.quota);
		const rawSignals = asRecord(quota?.signals);
		const observedAt = Date.parse(stringOrUndefined(quota?.observed_at) ?? "");
		// Without the proxy's own observation time the numbers cannot be dated, so they are not shown as current.
		if (!rawSignals || Number.isNaN(observedAt)) continue;

		const signals: Record<string, string> = {};
		for (const [key, value] of Object.entries(rawSignals)) {
			if (typeof value === "string") signals[key] = value;
		}
		const name = stringOrUndefined(entry.name);
		const authIndex = stringOrUndefined(entry.auth_index);
		const label = stringOrUndefined(entry.label);
		const parse = provider === "claude" ? parseClaudeQuotaSignals : parseCodexQuotaSignals;
		const snapshot = parse(signals, observedAt, "management_api", {
			...(name ? { name } : {}),
			...(authIndex ? { authIndex } : {}),
			...(label ? { label } : {}),
		});
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

/**
 * The proxy answers a banned client with `IP banned due to too many failed attempts. Try again in 28m22s`.
 * The remaining time is a Go duration string.
 */
export function parseBanSeconds(body: string): number | undefined {
	const match = /try again in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(body);
	if (!match?.[1]) return undefined;
	const part = (unit: string) => Number(new RegExp(`(\\d+(?:\\.\\d+)?)${unit}`).exec(match[1] ?? "")?.[1] ?? 0);
	const seconds = part("h") * 3600 + part("m") * 60 + part("s");
	return seconds > 0 ? Math.ceil(seconds) : undefined;
}

function readErrorField(body: string): string | undefined {
	try {
		const parsed = asRecord(JSON.parse(body));
		return stringOrUndefined(parsed?.error);
	} catch {
		return undefined;
	}
}

export interface FetchManagementQuotaOptions {
	/** Proxy root without a trailing path, as `resolveEndpoints().rootOrigin`. */
	rootOrigin: string;
	managementKey: string | undefined;
	signal?: AbortSignal;
	timeoutMs?: number;
	now?: () => number;
}

export async function fetchManagementQuota(options: FetchManagementQuotaOptions): Promise<ManagementQuotaResult> {
	if (!options.managementKey) return { status: "no_management_key" };

	const timeout = AbortSignal.timeout(options.timeoutMs ?? MANAGEMENT_REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(`${options.rootOrigin}/v0/management/auth-files`, {
			headers: { Authorization: `Bearer ${options.managementKey}`, Accept: "application/json" },
			signal,
		});
	} catch (error) {
		return { status: "network_error", message: errorMessage(error) };
	}

	if (response.status === 401) return { status: "unauthorized", httpStatus: 401 };
	if (response.status === 403) {
		const body = await response.text().catch(() => "");
		const retryAfterSeconds = parseBanSeconds(body);
		if (retryAfterSeconds !== undefined || /banned/i.test(body)) {
			return { status: "banned", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
		}
		return { status: "forbidden", message: readErrorField(body) ?? "HTTP 403" };
	}
	if (!response.ok) return { status: "unavailable", httpStatus: response.status };

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		return { status: "invalid_response", message: `body is not JSON: ${errorMessage(error)}` };
	}
	const credentials = parseManagementAuthFiles(payload);
	if (!credentials) return { status: "invalid_response", message: "response has no files array" };
	return { status: "ok", fetchedAt: (options.now ?? Date.now)(), credentials };
}

/** Used when the proxy bans the client without saying for how long: the proxy's own ban length. */
export const DEFAULT_BAN_SECONDS = 30 * 60;

export interface QuotaPollerOptions {
	minIntervalMs?: number;
	fetch: (signal?: AbortSignal) => Promise<ManagementQuotaResult>;
	onResult: (result: ManagementQuotaResult) => void;
	/**
	 * Identifies the key and proxy in use without revealing the key. Once the proxy rejects a fingerprint, the poller
	 * does not send it again: the proxy counts every wrong attempt, five of them ban the address for 30 minutes, and
	 * behind a port forward that address is shared by every client of the proxy.
	 */
	fingerprint?: () => string | undefined;
	now?: () => number;
}

/**
 * Throttled, de-duplicated management polling: concurrent callers share one request.
 *
 * Two conditions suppress a poll even when `force` is set, because sending would only hurt: the proxy has
 * banned this client (a banned request is refused without extending the ban, but cannot succeed), or it has
 * rejected the key currently in use (resending would add to the failed-attempt count).
 */
export class QuotaPoller {
	private readonly minIntervalMs: number;
	private readonly fetchQuota: QuotaPollerOptions["fetch"];
	private readonly onResult: QuotaPollerOptions["onResult"];
	private readonly fingerprint: () => string | undefined;
	private readonly now: () => number;
	private inFlight: Promise<ManagementQuotaResult | undefined> | undefined;
	private lastStartedAt: number | undefined;
	private bannedUntil: number | undefined;
	private rejectedFingerprint: string | undefined;

	constructor(options: QuotaPollerOptions) {
		this.minIntervalMs = options.minIntervalMs ?? QUOTA_MIN_REFRESH_MS;
		this.fetchQuota = options.fetch;
		this.onResult = options.onResult;
		this.fingerprint = options.fingerprint ?? (() => undefined);
		this.now = options.now ?? Date.now;
	}

	/** Epoch milliseconds until which polling is suspended by a ban, if it is. */
	banEndsAt(): number | undefined {
		return this.bannedUntil !== undefined && this.now() < this.bannedUntil ? this.bannedUntil : undefined;
	}

	/** True while the key in use is the one the proxy rejected. */
	keyRejected(): boolean {
		const current = this.fingerprint();
		return current !== undefined && current === this.rejectedFingerprint;
	}

	/** Resolves to undefined when the poll was skipped. `force` bypasses only the interval throttle. */
	refresh(force = false, signal?: AbortSignal): Promise<ManagementQuotaResult | undefined> {
		if (this.inFlight) return this.inFlight;
		const now = this.now();
		if (this.banEndsAt() !== undefined || this.keyRejected()) return Promise.resolve(undefined);
		if (!force && this.lastStartedAt !== undefined && now - this.lastStartedAt < this.minIntervalMs) {
			return Promise.resolve(undefined);
		}
		this.lastStartedAt = now;
		const sentFingerprint = this.fingerprint();
		const task = this.fetchQuota(signal)
			.then((result) => {
				if (result.status === "banned") {
					this.bannedUntil = this.now() + (result.retryAfterSeconds ?? DEFAULT_BAN_SECONDS) * 1000;
				} else if (result.status === "unauthorized") {
					this.rejectedFingerprint = sentFingerprint;
				} else if (result.status === "ok") {
					this.bannedUntil = undefined;
					this.rejectedFingerprint = undefined;
				}
				this.onResult(result);
				return result;
			})
			.finally(() => {
				this.inFlight = undefined;
			});
		this.inFlight = task;
		return task;
	}
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

const WINDOW_LABELS: Record<QuotaWindowKind, string> = { "5h": "5h", weekly: "weekly", other: "other" };

/** Plain-text rendering of one snapshot, for `/cpa-quota` and diagnostics. */
export function formatQuotaSnapshot(snapshot: QuotaSnapshot, now: number): string[] {
	const who = snapshot.credential?.name ?? snapshot.credential?.label ?? snapshot.credential?.authIndex;
	const header = [
		snapshot.source === "management_api"
			? `${snapshot.provider} credential ${who ?? "?"}`
			: `${snapshot.provider} last response`,
	];
	if (snapshot.planType) header.push(`plan ${snapshot.planType}`);
	if (snapshot.limitReached) header.push("LIMIT REACHED");
	header.push(`observed ${formatDuration(now - snapshot.observedAt)} ago`);
	const lines = [header.join("  ")];

	for (const window of snapshot.windows) {
		const label =
			window.kind === "other"
				? `${formatDuration(window.windowMinutes * 60_000)} window`
				: WINDOW_LABELS[window.kind];
		let tail = "";
		if (window.resetsAt !== undefined) {
			tail = isQuotaWindowExpired(window, now)
				? "  window has reset since this was observed; figure is stale"
				: `  resets in ${formatDuration(window.resetsAt - now)}`;
		}
		const verdict = window.status && window.status !== "allowed" ? `  [${window.status}]` : "";
		lines.push(`  ${label.padEnd(8)} ${window.usedPercent}% used${verdict}${tail}`);
	}
	if (snapshot.windows.length === 0) lines.push("  no window data");
	return lines;
}
