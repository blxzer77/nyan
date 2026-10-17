/**
 * Reading the error code of a failed network request, the same way under Node and Bun.
 *
 * Node's fetch (undici) throws `TypeError("fetch failed")` and keeps the code on `error.cause` (or on the members of an
 * `AggregateError` cause). Bun's native fetch throws a `TypeError` that carries the code itself, in `error.code` and in
 * its message ("ECONNREFUSED: Unable to connect..."), with no cause. Provider SDKs add another layer, such as
 * `APIConnectionError("Connection error.")` with the fetch error as its cause. The code is therefore looked up on the
 * error and then down its cause chain.
 *
 * This module imports nothing, so it can sit in the browser-safe `utils` layer.
 */

const MAX_CAUSE_DEPTH = 6;

/** Every string `code` on the error and on the errors below it, outermost first. */
export function transportErrorCodes(error: unknown): string[] {
	const codes: string[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number): void => {
		if (typeof value !== "object" || value === null || seen.has(value) || depth > MAX_CAUSE_DEPTH) return;
		seen.add(value);
		const { code, cause, errors } = value as { code?: unknown; cause?: unknown; errors?: unknown };
		if (typeof code === "string" && code.length > 0) codes.push(code);
		if (Array.isArray(errors)) for (const member of errors) visit(member, depth + 1);
		visit(cause, depth + 1);
	};
	visit(error, 0);
	return codes;
}

/** The outermost code of a failed request, or `undefined` when the error carries none. */
export function transportErrorCode(error: unknown): string | undefined {
	return transportErrorCodes(error)[0];
}

/**
 * Certificate and host-name verification failures. These are the OpenSSL verification names Node and Bun both report,
 * plus Node's host-name check. Retrying cannot fix any of them: the server or the local trust store has to change.
 */
export const CERTIFICATE_ERROR_CODE_LIST: readonly string[] = [
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_CRL",
	"UNABLE_TO_DECRYPT_CERT_SIGNATURE",
	"UNABLE_TO_DECRYPT_CRL_SIGNATURE",
	"UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
	"CERT_SIGNATURE_FAILURE",
	"CRL_SIGNATURE_FAILURE",
	"CERT_NOT_YET_VALID",
	"CERT_HAS_EXPIRED",
	"CRL_NOT_YET_VALID",
	"CRL_HAS_EXPIRED",
	"ERROR_IN_CERT_NOT_BEFORE_FIELD",
	"ERROR_IN_CERT_NOT_AFTER_FIELD",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_CHAIN_TOO_LONG",
	"CERT_REVOKED",
	"INVALID_CA",
	"PATH_LENGTH_EXCEEDED",
	"INVALID_PURPOSE",
	"CERT_UNTRUSTED",
	"CERT_REJECTED",
	"HOSTNAME_MISMATCH",
	"ERR_TLS_CERT_ALTNAME_INVALID",
];
const CERTIFICATE_ERROR_CODES: ReadonlySet<string> = new Set(CERTIFICATE_ERROR_CODE_LIST);

export function isCertificateErrorCode(code: string): boolean {
	return CERTIFICATE_ERROR_CODES.has(code);
}

/** The first certificate code on the error or below it, if any. */
export function certificateErrorCode(error: unknown): string | undefined {
	return transportErrorCodes(error).find(isCertificateErrorCode);
}

/**
 * Failures to reach the server at all. A caller may retry these; they say nothing about the request itself.
 * `UND_ERR_*` are undici's socket and timeout codes.
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
]);

export function isConnectionErrorCode(code: string): boolean {
	return CONNECTION_ERROR_CODES.has(code) || code.startsWith("UND_ERR");
}

/** True when the error, or an error below it, is a failure to reach the server. */
export function isConnectionError(error: unknown): boolean {
	return transportErrorCodes(error).some(isConnectionErrorCode);
}

/**
 * `error.message`, with the certificate code appended when the message does not already say it.
 *
 * Node reports every request failure as "fetch failed" and keeps the reason on the cause, so a message that is stored
 * and classified later (the assistant message's `errorMessage`) would lose it. Only certificate codes are added: they
 * decide that a retry is pointless. Every other message stays exactly as the runtime produced it.
 */
export function errorMessageWithCertificateCode(error: Error): string {
	const code = certificateErrorCode(error);
	return code === undefined || error.message.includes(code) ? error.message : `${error.message} (${code})`;
}
