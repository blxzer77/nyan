/**
 * Telemetry hub of the CLIProxyAPI extension: the one place a UI, a status line or an RPC client reads
 * request metrics and plan quota from.
 *
 * Consumers either call `snapshot()` or subscribe on the extension event bus (`nyan.events`):
 *   - `cliproxyapi:request`  payload `RequestMetrics`, once per finished request
 *   - `cliproxyapi:quota`    payload `QuotaView`, whenever a quota observation changes
 *
 * State is in memory. The proxy owns the quota numbers and the next poll or response refills them after a
 * restart, so nothing is written to disk (a persisted figure could outlive the window it describes, and the
 * credential names in it can contain e-mail addresses).
 */

import type { EventBus } from "../../core/event-bus.ts";
import { type MetricsSummary, RequestLog, type RequestMetrics, summarizeRequests } from "./metrics.ts";
import { type ManagementQuotaResult, parseQuotaSignals, type QuotaSnapshot } from "./quota.ts";

export const REQUEST_EVENT_CHANNEL = "cliproxyapi:request";
export const QUOTA_EVENT_CHANNEL = "cliproxyapi:quota";

/** Why the management source has no data, or `ok`. `not_polled` means no poll has finished yet. */
export type ManagementQuotaStatus = ManagementQuotaResult["status"] | "not_polled";

export interface QuotaView {
	/** The newest observation taken from a response that went through the proxy. */
	fromResponse?: QuotaSnapshot;
	management: {
		status: ManagementQuotaStatus;
		/** When the last successful poll finished. */
		fetchedAt?: number;
		/** One snapshot per pooled Codex credential. */
		credentials: QuotaSnapshot[];
		/** HTTP status or error text of the last failed poll. */
		detail?: string;
	};
	/** True when no management key is configured, so only response headers can ever fill the quota. */
	managementKeyConfigured: boolean;
}

export interface TelemetrySnapshot {
	requests: {
		/** The newest records, oldest first. */
		recent: readonly RequestMetrics[];
		/** Over `recent` only. */
		summary: MetricsSummary;
		/** Count since process start, including records already dropped from `recent`. */
		total: number;
	};
	quota: QuotaView;
}

export interface TelemetryHubOptions {
	events?: EventBus;
	managementKeyConfigured: boolean;
	now?: () => number;
}

function describeFailure(result: Exclude<ManagementQuotaResult, { status: "ok" }>): string | undefined {
	switch (result.status) {
		case "unauthorized":
		case "unavailable":
			return `HTTP ${result.httpStatus}`;
		case "banned":
			return result.retryAfterSeconds === undefined
				? "banned"
				: `banned, retry in ${Math.ceil(result.retryAfterSeconds / 60)} min`;
		case "network_error":
		case "invalid_response":
		case "forbidden":
			return result.message;
		case "no_management_key":
			return undefined;
	}
}

export class TelemetryHub {
	readonly requestLog = new RequestLog();
	private readonly events: EventBus | undefined;
	private readonly now: () => number;
	private total = 0;
	private fromResponse: QuotaSnapshot | undefined;
	private management: QuotaView["management"] = { status: "not_polled", credentials: [] };
	private managementKeyConfigured: boolean;

	constructor(options: TelemetryHubOptions) {
		this.events = options.events;
		this.managementKeyConfigured = options.managementKeyConfigured;
		this.now = options.now ?? Date.now;
	}

	setManagementKeyConfigured(configured: boolean): void {
		this.managementKeyConfigured = configured;
	}

	nextRequestId(): number {
		return this.requestLog.nextId();
	}

	recordRequest(record: RequestMetrics): void {
		this.total++;
		this.requestLog.push(record);
		this.events?.emit(REQUEST_EVENT_CHANNEL, record);
	}

	/** Called with the headers of a response that came through the proxy. Headers without quota keys change nothing. */
	observeResponseHeaders(headers: Readonly<Record<string, string>>): void {
		const snapshot = parseQuotaSignals(headers, this.now(), "response_headers");
		if (!snapshot) return;
		this.fromResponse = snapshot;
		this.events?.emit(QUOTA_EVENT_CHANNEL, this.quotaView());
	}

	applyManagementResult(result: ManagementQuotaResult): void {
		if (result.status === "ok") {
			this.management = { status: "ok", fetchedAt: result.fetchedAt, credentials: result.credentials };
		} else {
			// A failed poll keeps the last good credentials: they are dated by their own `observedAt`, so a reader
			// can still judge their age, and discarding them would turn a network blip into "no quota".
			const detail = describeFailure(result);
			this.management = {
				...this.management,
				status: result.status,
				...(detail !== undefined ? { detail } : {}),
			};
		}
		this.events?.emit(QUOTA_EVENT_CHANNEL, this.quotaView());
	}

	quotaView(): QuotaView {
		return {
			...(this.fromResponse ? { fromResponse: this.fromResponse } : {}),
			management: this.management,
			managementKeyConfigured: this.managementKeyConfigured,
		};
	}

	snapshot(): TelemetrySnapshot {
		const recent = this.requestLog.list();
		return {
			requests: { recent, summary: summarizeRequests(recent), total: this.total },
			quota: this.quotaView(),
		};
	}

	/** Forget request records; quota stays, because it describes the account, not this session. */
	resetRequests(): void {
		this.requestLog.clear();
		this.total = 0;
	}
}

/** Plain-language reason the quota is missing, or undefined when some source supplied data. */
export function explainMissingQuota(view: QuotaView): string | undefined {
	if (view.fromResponse || view.management.credentials.length > 0) return undefined;
	switch (view.management.status) {
		case "unauthorized":
			return `The proxy rejected the management key (${view.management.detail ?? "unauthorized"}). Check CLIPROXYAPI_MANAGEMENT_KEY and the proxy's remote-management.secret-key.`;
		case "banned":
			return `The proxy banned this address from its management API after repeated failed attempts (${view.management.detail ?? "banned"}). Everyone behind the same address is banned together, and a ban lasts 30 minutes.`;
		case "forbidden":
			return `The proxy refused the management API (${view.management.detail ?? "HTTP 403"}). Remote management may be switched off on the proxy.`;
		case "unavailable":
			return `The proxy's management API answered ${view.management.detail ?? "an error"}. It is off unless remote-management.secret-key is set on the proxy.`;
		case "network_error":
		case "invalid_response":
			return `The management API could not be read: ${view.management.detail ?? "unknown error"}.`;
		case "ok":
			return "The proxy has no Codex or Claude credential that has reported a quota yet. It records one after the credential serves a request.";
		default:
			return view.managementKeyConfigured
				? "The management API has not been polled yet."
				: "No quota source is configured. Set CLIPROXYAPI_MANAGEMENT_KEY (needs remote-management.secret-key on the proxy), or run the proxy with passthrough-headers: true so responses carry x-codex-* headers.";
	}
}
