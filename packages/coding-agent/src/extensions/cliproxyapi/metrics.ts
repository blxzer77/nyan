/**
 * Per-request metrics for requests served through CLIProxyAPI.
 *
 * A record covers one provider request, from the moment nyan hands it to the provider until the assistant
 * message ends. Paused time (`/pause`) is excluded from every duration, so a request that waited for
 * `/continue` does not look slow. A duration that could not be observed is absent, never zero.
 */

/** Longest `error` text kept on a record; provider errors can embed whole response bodies. */
const MAX_ERROR_LENGTH = 300;
export const MAX_RECORDED_REQUESTS = 200;

export interface RequestMetrics {
	/** Increases by one per record within this process. */
	sequence: number;
	model: string;
	/** Epoch milliseconds at which the request was handed to the provider. Absent when the start was not observed. */
	startedAt?: number;
	/** HTTP status of the provider response, when one arrived. */
	httpStatus?: number;
	/** Request start to response headers. */
	headersMs?: number;
	/** Request start to the first stream event: time to first token. */
	ttftMs?: number;
	/** First stream event to the end of the message: the window throughput is measured over. */
	generationMs?: number;
	/** Request start to the end of the message. */
	totalMs?: number;
	/** Time spent paused while this request was in flight. */
	pausedMs: number;
	/** Output tokens over `generationMs`; absent when the window is too short to be meaningful. */
	tokensPerSecond?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Estimated from catalog rates; not a bill. */
	cost: number;
	fast: boolean;
	/** Provider calls made for this message; above one means a retry happened inside the provider layer. */
	attempts: number;
	stopReason?: string;
	error?: string;
	traceId?: string;
	/** Seconds the gateway asked the client to wait, from `retry-after`. */
	retryAfterSeconds?: number;
}

/** A window shorter than this says nothing about throughput. */
export const MIN_THROUGHPUT_WINDOW_MS = 250;

export function computeTokensPerSecond(outputTokens: number, generationMs: number | undefined): number | undefined {
	if (generationMs === undefined || outputTokens <= 0 || generationMs < MIN_THROUGHPUT_WINDOW_MS) return undefined;
	return outputTokens / (generationMs / 1000);
}

export function truncateError(message: string | undefined): string | undefined {
	if (!message) return undefined;
	return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export interface MetricsSummary {
	requests: number;
	failed: number;
	/** Requests that needed more than one provider call. */
	retried: number;
	avgTtftMs?: number;
	medianTtftMs?: number;
	maxTtftMs?: number;
	avgTotalMs?: number;
	/** Total output over total generation time, so a long request weighs more than a short one. */
	tokensPerSecond?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function mean(values: number[]): number | undefined {
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeRequests(records: readonly RequestMetrics[]): MetricsSummary {
	const ttft = records.flatMap((record) => (record.ttftMs === undefined ? [] : [record.ttftMs]));
	const totals = records.flatMap((record) => (record.totalMs === undefined ? [] : [record.totalMs]));
	let throughputOutput = 0;
	let throughputMs = 0;
	for (const record of records) {
		// Only requests with a usable window contribute to both sides, or the ratio would be skewed.
		if (record.tokensPerSecond === undefined || record.generationMs === undefined) continue;
		throughputOutput += record.output;
		throughputMs += record.generationMs;
	}
	const summary: MetricsSummary = {
		requests: records.length,
		failed: records.filter((record) => record.stopReason === "error" || (record.httpStatus ?? 0) >= 400).length,
		retried: records.filter((record) => record.attempts > 1).length,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const record of records) {
		summary.input += record.input;
		summary.output += record.output;
		summary.cacheRead += record.cacheRead;
		summary.cacheWrite += record.cacheWrite;
		summary.cost += record.cost;
	}
	const avgTtftMs = mean(ttft);
	const medianTtftMs = median(ttft);
	const avgTotalMs = mean(totals);
	const tokensPerSecond = computeTokensPerSecond(throughputOutput, throughputMs);
	if (avgTtftMs !== undefined) summary.avgTtftMs = avgTtftMs;
	if (medianTtftMs !== undefined) summary.medianTtftMs = medianTtftMs;
	if (ttft.length > 0) summary.maxTtftMs = Math.max(...ttft);
	if (avgTotalMs !== undefined) summary.avgTotalMs = avgTotalMs;
	if (tokensPerSecond !== undefined) summary.tokensPerSecond = tokensPerSecond;
	return summary;
}

/** Bounded in-memory log: the newest `MAX_RECORDED_REQUESTS` records. Totals beyond that are kept by the caller. */
export class RequestLog {
	private records: RequestMetrics[] = [];
	private nextSequence = 1;

	nextId(): number {
		return this.nextSequence++;
	}

	push(record: RequestMetrics): void {
		this.records.push(record);
		if (this.records.length > MAX_RECORDED_REQUESTS) {
			this.records.splice(0, this.records.length - MAX_RECORDED_REQUESTS);
		}
	}

	list(): readonly RequestMetrics[] {
		return this.records;
	}

	last(): RequestMetrics | undefined {
		return this.records.at(-1);
	}

	clear(): void {
		this.records = [];
	}
}
