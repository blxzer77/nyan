/**
 * Reading the error code of a failed network request, the same way under Node and Bun.
 *
 * Node's fetch (undici) throws `TypeError("fetch failed")` and keeps the code on `error.cause` (or on the members of an
 * `AggregateError` cause). Bun's native fetch throws a `TypeError` that carries the code itself, in `error.code` and in
 * its message ("ECONNREFUSED: Unable to connect..."), with no cause. Provider SDKs add another layer, such as
 * `APIConnectionError("Connection error.")` with the fetch error as its cause. The code is therefore looked up on the
 * error and then down its cause chain.
 *
 * The certificate code list is owned by `retry.ts`, where the message classifier that needs it also lives. This module
 * imports that list and nothing else. `retry.ts` must not import this module: durable's entry graph has a fixed budget
 * (`scripts/check-entry-graphs.mjs`), and that import would add a file to it.
 */
import { CERTIFICATE_ERROR_CODE_LIST, isCertificateErrorMessage } from "./retry.ts";

const MAX_CAUSE_DEPTH = 6;

/**
 * Visit the error, its cause, and the members of an `AggregateError`, outermost first. Each object is visited once, and
 * the walk stops at `MAX_CAUSE_DEPTH`, so a cyclic or very deep chain ends.
 */
function walkErrorChain(error: unknown, visit: (value: Record<string, unknown>) => void): void {
	const seen = new Set<unknown>();
	const walk = (value: unknown, depth: number): void => {
		if (typeof value !== "object" || value === null || seen.has(value) || depth > MAX_CAUSE_DEPTH) return;
		seen.add(value);
		const record = value as Record<string, unknown>;
		visit(record);
		const { errors, cause } = record;
		if (Array.isArray(errors)) for (const member of errors) walk(member, depth + 1);
		walk(cause, depth + 1);
	};
	walk(error, 0);
}

/** Every string `code` on the error and on the errors below it, outermost first. */
export function transportErrorCodes(error: unknown): string[] {
	const codes: string[] = [];
	walkErrorChain(error, ({ code }) => {
		if (typeof code === "string" && code.length > 0) codes.push(code);
	});
	return codes;
}

/**
 * Every error on the chain that has a non-empty message, outermost first, in the same walk as `transportErrorCodes()`.
 * Used where a message is needed rather than a code (a diagnostic line that names the cause).
 */
export function transportErrorMessages(error: unknown): string[] {
	const messages: string[] = [];
	walkErrorChain(error, ({ message }) => {
		if (typeof message === "string" && message.length > 0) messages.push(message);
	});
	return messages;
}

/** The outermost code of a failed request, or `undefined` when the error carries none. */
export function transportErrorCode(error: unknown): string | undefined {
	return transportErrorCodes(error)[0];
}

const CERTIFICATE_ERROR_CODES: ReadonlySet<string> = new Set(CERTIFICATE_ERROR_CODE_LIST);

function isCertificateErrorCode(code: string): boolean {
	return CERTIFICATE_ERROR_CODES.has(code);
}

/** True when the error chain names a certificate or host-name verification failure. */
export function isCertificateError(error: unknown): boolean {
	return certificateErrorCode(error) !== undefined || transportErrorMessages(error).some(isCertificateErrorMessage);
}

/** The first certificate code on the error or below it, if any. */
export function certificateErrorCode(error: unknown): string | undefined {
	return transportErrorCodes(error).find(isCertificateErrorCode);
}

/**
 * Failures to reach the server, or to get a usable response from it. A caller may retry these; they say nothing about
 * the request itself. The undici codes are listed one by one: `UND_ERR_*` also covers a cancelled request
 * (`UND_ERR_ABORTED`), a non-2xx response (`UND_ERR_RESPONSE_STATUS_CODE`), and a bad argument (`UND_ERR_INVALID_ARG`),
 * and none of those means the server could not be reached.
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"EPIPE",
	// undici: the socket failed, the connection closed before the response, or a timeout fired before the headers or
	// the body. `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT` are also what nyan's idle-timeout wrapper reports.
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

export function isConnectionErrorCode(code: string): boolean {
	return CONNECTION_ERROR_CODES.has(code);
}

/** True when the error, or an error below it, is a failure to reach the server. */
export function isConnectionError(error: unknown): boolean {
	return transportErrorCodes(error).some(isConnectionErrorCode);
}

/**
 * `error.message`, with the certificate code appended when the message does not already say it. When no code is on the
 * chain, the text of a cause that names a certificate is appended instead.
 *
 * Node reports every request failure as "fetch failed" and keeps the reason on the cause, so a message that is stored
 * and classified later (the assistant message's `errorMessage`) would lose it. Only certificate codes are added: they
 * decide that a retry is pointless. Every other message stays exactly as the runtime produced it.
 */
export function errorMessageWithCertificateCode(error: Error): string {
	const code = certificateErrorCode(error);
	if (code !== undefined) {
		if (error.message.includes(code)) return error.message;
		// An empty message would otherwise read " (CODE)" with nothing before the code.
		return error.message.length > 0 ? `${error.message} (${code})` : code;
	}
	// No code on the chain: a failure that only says "self signed certificate" in a cause, under an SDK wrapper such as
	// "Connection error.", would be stored without it and retried by the classifier, which sees only the stored string.
	const text = transportErrorMessages(error).find(isCertificateErrorMessage);
	if (text === undefined || text === error.message) return error.message;
	return error.message.length > 0 ? `${error.message} (${text})` : text;
}
