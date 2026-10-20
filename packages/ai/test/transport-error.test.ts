import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isCertificateErrorMessage, isRetryableAssistantError } from "../src/utils/retry.ts";
import {
	certificateErrorCode,
	errorMessageWithCertificateCode,
	isConnectionError,
	isConnectionErrorCode,
	transportErrorCode,
	transportErrorCodes,
	transportErrorMessages,
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

describe("certificate messages", () => {
	it.each([
		// Each phrase is the only one that matches its message, so removing either one fails a case.
		[
			"Node's host name text, the first phrase alone",
			"fetch failed: Hostname/IP does not match certificate's altnames",
		],
		[
			"Node's host name text, the second phrase alone",
			"fetch failed: Host: localhost. is not in the cert's altnames: DNS:other.test",
		],
		["Bun's self-signed text", "self signed certificate"],
		// OpenSSL's readable texts, for codes that have another name: the message alone names the failure.
		["unknown issuer, as text", "unable to get local issuer certificate"],
		["unknown issuer, without 'local'", "unable to get issuer certificate"],
		["host name mismatch, as text", "hostname mismatch"],
		["revoked certificate", "certificate revoked"],
		["certificate not trusted", "certificate not trusted"],
		["invalid CA certificate", "invalid CA certificate"],
		["a code in the text", "fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)"],
		["expired", "certificate has expired"],
	])("names a certificate failure: %s", (_label, message) => {
		expect(isCertificateErrorMessage(message)).toBe(true);
	});

	it.each(["connect ECONNREFUSED 127.0.0.1:443", "certificate pinning is enabled for this account", "fetch failed"])(
		"does not name a certificate failure in: %s",
		(message) => {
			expect(isCertificateErrorMessage(message)).toBe(false);
		},
	);
});

describe("connection and certificate codes", () => {
	it("does not treat an undici code that is not a lost connection as one", () => {
		// A cancelled request, a non-2xx response, and a bad argument all carry UND_ERR_* codes.
		for (const code of ["UND_ERR_ABORTED", "UND_ERR_RESPONSE_STATUS_CODE", "UND_ERR_INVALID_ARG"]) {
			expect(isConnectionErrorCode(code), code).toBe(false);
		}
	});

	it("treats the undici socket and timeout codes as connection errors", () => {
		for (const code of [
			"UND_ERR_SOCKET",
			"UND_ERR_CLOSED",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_HEADERS_TIMEOUT",
			"UND_ERR_BODY_TIMEOUT",
		]) {
			expect(isConnectionErrorCode(code), code).toBe(true);
		}
	});

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
		// An empty message is not written as " (CODE)".
		expect(
			errorMessageWithCertificateCode(Object.assign(new TypeError(""), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })),
		).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
		expect(
			errorMessageWithCertificateCode(
				bunFetchError("ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_ALTNAME_INVALID fetching https://x/"),
			),
		).toBe("ERR_TLS_CERT_ALTNAME_INVALID fetching https://x/");
	});

	it("adds the text of a cause that names a certificate when no code is on the chain", () => {
		// An SDK wrapper over a runtime error that only says what failed: without this the stored message is "Connection error.".
		const error = new Error("Connection error.", {
			cause: new TypeError("fetch failed", { cause: new Error("self signed certificate") }),
		});
		expect(errorMessageWithCertificateCode(error)).toBe("Connection error. (self signed certificate)");
		// A message that already says it, a chain without a certificate, and an empty message.
		expect(errorMessageWithCertificateCode(new Error("self signed certificate"))).toBe("self signed certificate");
		expect(errorMessageWithCertificateCode(new Error("Connection error.", { cause: new Error("timed out") }))).toBe(
			"Connection error.",
		);
		expect(errorMessageWithCertificateCode(new Error("", { cause: new Error("self signed certificate") }))).toBe(
			"self signed certificate",
		);
	});
});

describe("messages on the chain", () => {
	it("lists each error's message, outermost first, members of an AggregateError included", () => {
		const error = new TypeError("fetch failed", {
			cause: new AggregateError([
				new Error("connect ECONNREFUSED 127.0.0.1:443"),
				new Error("connect ECONNREFUSED ::1"),
			]),
		});
		expect(transportErrorMessages(error)).toEqual([
			"fetch failed",
			"connect ECONNREFUSED 127.0.0.1:443",
			"connect ECONNREFUSED ::1",
		]);
	});
});

describe("retry classification of transport failures", () => {
	const retryable = (errorMessage: string) =>
		isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }));

	it("does not retry a stored message that carries the certificate text of its cause", () => {
		const error = new Error("Connection error.", {
			cause: new TypeError("fetch failed", { cause: new Error("self signed certificate") }),
		});
		expect(retryable(errorMessageWithCertificateCode(error))).toBe(false);
		// Without the appended text the same failure reads as a plain connection error.
		expect(retryable(error.message)).toBe(true);
	});

	it.each([
		["Node: self-signed leaf with the code", "fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)"],
		["Node: unknown issuer", "fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)"],
		["Node: host name mismatch", "fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)"],
		[
			"Node: host name mismatch, stored as text without the code",
			"fetch failed: Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:other.test",
		],
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

	it("keeps retrying a server error whose stored body names a certificate", () => {
		// The stored text of an HTTP error is "<status>: <body>"; the status makes it a server error.
		expect(retryable("503: upstream says certificate expired")).toBe(true);
		expect(retryable("Provider error (429): certificate verify failed")).toBe(true);
		expect(retryable("Request failed with status code 500: certificate expired")).toBe(true);
		expect(retryable("HTTP 503: certificate expired")).toBe(true);
		// The Anthropic SDK's raw message has a space, not a colon, after the status.
		expect(retryable('503 {"error":{"message":"certificate has expired"}}')).toBe(true);
		expect(retryable("500 certificate verify failed")).toBe(true);
	});

	it("does not read a port, an IPv6 group, or a millisecond value as a status", () => {
		// Bun writes the request URL into the message: a certificate failure for a host with port 500 is not retried as a 500.
		expect(retryable('ERR_TLS_CERT_ALTNAME_INVALID fetching "https://api.example.com:500/"')).toBe(false);
		expect(retryable("unable to verify the first certificate at ::500 (self signed certificate)")).toBe(false);
		expect(retryable("self signed certificate, seen at 2026-10-17T12:00:00.500Z")).toBe(false);
		expect(retryable("500 ms elapsed: self signed certificate")).toBe(false);
		expect(retryable("500  ms elapsed: self signed certificate")).toBe(false);
		expect(retryable("500 msec elapsed: self signed certificate")).toBe(false);
		expect(retryable("500 milliseconds elapsed: self signed certificate")).toBe(false);
	});

	it("does not retry certificate failures when their URL contains status-like text", () => {
		for (const errorMessage of [
			'self signed certificate fetching "https://code500.example.com/"',
			'self signed certificate fetching "https://http500.example.com/"',
			'self signed certificate fetching "https://example.com/?status=500"',
			'self signed certificate fetching "https://example.com/?code=500"',
			// A path segment is URL text too: a server naming its own resource `status=500` says nothing about this request.
			'self signed certificate fetching "https://example.com/status=500"',
			'self signed certificate fetching "https://example.com/code=503"',
			'self signed certificate fetching "https://example.com/api/status=500/v1"',
		]) {
			expect(retryable(errorMessage), errorMessage).toBe(false);
		}
	});

	it("reads a keyword status wherever a field can start", () => {
		// The same keyword forms still count when they are not inside a URL: log lines, JSON keys, propagated errors.
		for (const errorMessage of [
			"status=500: self signed certificate",
			'{"status":500,"reason":"certificate expired"}',
			"(code=503) certificate expired",
			"Request failed: code=503 (certificate expired)",
		]) {
			expect(retryable(errorMessage), errorMessage).toBe(true);
		}
	});

	it("does not read a status out of a certificate reason", () => {
		// A reason can end in a number; that number is not a status this request got.
		for (const errorMessage of [
			"self signed certificate: 500",
			"certificate verify failed: 503",
			"Error: self signed certificate in certificate chain: 500",
		]) {
			expect(retryable(errorMessage), errorMessage).toBe(false);
		}
	});

	it("recognizes a Bedrock prefix before a retryable status", () => {
		expect(retryable("ThrottlingException: 503: certificate expired")).toBe(true);
	});
});
