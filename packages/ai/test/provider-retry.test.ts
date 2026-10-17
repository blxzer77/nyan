import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>, message?: string): Error {
	return Object.assign(new Error(message ?? `Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("still retries a server error whose response body names a certificate", async () => {
		// The message of an HTTP error is its response body; a 503 that mentions a certificate is still a 503.
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(503, undefined, "upstream says: certificate expired"))
			.mockResolvedValue("ok");

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry a certificate failure whose cause has only the message (Bun's text)", async () => {
		// Bun writes the reason as text and no code exists to read.
		const fetchFailure = new TypeError("self signed certificate");
		const sdkError = Object.assign(new Error("Connection error."), {
			status: undefined,
			headers: undefined,
			cause: fetchFailure,
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(sdkError);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(sdkError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a certificate failure, even though an SDK connection error has no status", async () => {
		// The SDK wraps the fetch failure as `Connection error.`; the certificate code is on its cause.
		const fetchFailure = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
		});
		const sdkError = Object.assign(new Error("Connection error."), {
			status: undefined,
			headers: undefined,
			cause: fetchFailure,
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(sdkError);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(sdkError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(504, { "retry-after-ms": "0" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [504] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
