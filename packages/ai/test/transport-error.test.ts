import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import {
	CERTIFICATE_ERROR_CODE_LIST,
	certificateErrorCode,
	errorMessageWithCertificateCode,
	isConnectionError,
	isConnectionErrorCode,
	transportErrorCode,
	transportErrorCodes,
} from "../src/utils/transport-error.ts";

/** The shapes measured on Node 24 (undici): `fetch failed` with the code on the cause. */
function nodeFetchError(causeCode: string | undefined): TypeError {
	const error = new TypeError("fetch failed");
	if (causeCode !== undefined)
		Object.assign(error, { cause: Object.assign(new Error("socket"), { code: causeCode }) });
	return error;
}

/** The shape measured on Bun 1.4 (native fetch): the code on the error itself, no cause. */
function bunFetchError(code: string, message: string): TypeError {
	return Object.assign(new TypeError(message), { code });
}

describe("transport error codes", () => {
	it("reads the code on the cause of a Node fetch failure", () => {
		expect(transportErrorCode(nodeFetchError("ENOTFOUND"))).toBe("ENOTFOUND");
		expect(transportErrorCodes(nodeFetchError("ERR_TLS_CERT_ALTNAME_INVALID"))).toEqual([
			"ERR_TLS_CERT_ALTNAME_INVALID",
		]);
	});

	it("reads the code a Bun fetch failure carries itself", () => {
		expect(transportErrorCode(bunFetchError("ECONNREFUSED", "ECONNREFUSED: Unable to connect."))).toBe(
			"ECONNREFUSED",
		);
	});

	it("reads codes below an SDK wrapper, outermost first", () => {
		const sdkError = Object.assign(new Error("Connection error."), { cause: nodeFetchError("ECONNRESET") });
		expect(transportErrorCodes(sdkError)).toEqual(["ECONNRESET"]);
	});

	it("keeps every code in the chain, not only the first", () => {
		const inner = Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" });
		const outer = Object.assign(new Error("Connection error."), { code: "ECONNRESET", cause: inner });
		expect(transportErrorCodes(outer)).toEqual(["ECONNRESET", "UND_ERR_SOCKET"]);
		expect(transportErrorCode(outer)).toBe("ECONNRESET");
	});

	it("reads the members of an AggregateError cause", () => {
		const error = new TypeError("fetch failed", {
			cause: new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), new Error("b")]),
		});
		expect(transportErrorCodes(error)).toEqual(["ECONNREFUSED"]);
	});

	it("stops on a cycle and at the depth limit", () => {
		const loop: { cause?: unknown; code?: string } = { code: "ETIMEDOUT" };
		loop.cause = loop;
		expect(transportErrorCodes(loop)).toEqual(["ETIMEDOUT"]);

		let deep: Error = Object.assign(new Error("deepest"), { code: "EPIPE" });
		for (let depth = 0; depth < 20; depth++) deep = new Error("wrapper", { cause: deep });
		expect(transportErrorCodes(deep)).toEqual([]);
	});

	it("returns nothing for a value without a code", () => {
		expect(transportErrorCodes("fetch failed")).toEqual([]);
		expect(transportErrorCodes(null)).toEqual([]);
	});
});

describe("certificate code lists", () => {
	it("agree between transport-error.ts and the copy in retry.ts", () => {
		const retrySource = readFileSync(new URL("../src/utils/retry.ts", import.meta.url), "utf8");
		const block = /const CERTIFICATE_CODES_IN_RETRY = \[([\s\S]*?)\];/.exec(retrySource)?.[1];
		expect(block, "the copy in retry.ts is present").toBeDefined();
		const inRetry = [...(block ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]).sort();
		expect(inRetry).toEqual([...CERTIFICATE_ERROR_CODE_LIST].sort());
	});
});

describe("connection and certificate codes", () => {
	it("classifies a refused or dropped connection as a connection error", () => {
		expect(isConnectionError(bunFetchError("ECONNREFUSED", "refused"))).toBe(true);
		expect(isConnectionError(nodeFetchError("UND_ERR_SOCKET"))).toBe(true);
		expect(isConnectionErrorCode("ENOTFOUND")).toBe(true);
	});

	it("does not classify a certificate failure as a connection error", () => {
		expect(isConnectionError(nodeFetchError("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe(false);
	});

	it("finds the certificate code wherever it sits", () => {
		expect(certificateErrorCode(nodeFetchError("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
		expect(certificateErrorCode(bunFetchError("ECONNRESET", "reset"))).toBeUndefined();
	});

	it("adds the certificate code to a Node message and leaves other messages alone", () => {
		expect(errorMessageWithCertificateCode(nodeFetchError("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe(
			"fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)",
		);
		expect(errorMessageWithCertificateCode(nodeFetchError("ENOTFOUND"))).toBe("fetch failed");
		expect(
			errorMessageWithCertificateCode(
				bunFetchError("ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_ALTNAME_INVALID fetching https://x/"),
			),
		).toBe("ERR_TLS_CERT_ALTNAME_INVALID fetching https://x/");
	});
});

describe("retry classification of transport failures", () => {
	const retryable = (errorMessage: string) =>
		isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }));

	it.each([
		["Node: self-signed leaf with the code", "fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)"],
		["Node: unknown issuer", "fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)"],
		["Node: host name mismatch", "fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)"],
		["Bun: self-signed, code only in the message", "self signed certificate"],
		[
			"Bun: host name mismatch, code in the message",
			'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://localhost:61452/". For more information, pass `verbose: true`',
		],
		["expired certificate", "certificate has expired"],
	])("does not retry a certificate failure: %s", (_label, errorMessage) => {
		expect(retryable(errorMessage)).toBe(false);
	});

	it.each([
		["Node: refused, as undici reports it", "fetch failed"],
		["Node: DNS", "fetch failed (ENOTFOUND)"],
		["Bun: refused", "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"],
		["Bun: reset", "ECONNRESET: The socket connection was closed unexpectedly."],
		["Bun: DNS", "getaddrinfo ENOTFOUND nonexistent.invalid"],
	])("keeps retrying a connection failure: %s", (_label, errorMessage) => {
		expect(retryable(errorMessage)).toBe(true);
	});
});
