import { describe, expect, it } from "vitest";
import { connectionErrorMessage } from "../src/extensions/llama/index.ts";

describe("llama connection error message", () => {
	it("says the server could not be reached for a refused connection, on either runtime", () => {
		// Node: "fetch failed" with the code on the cause. Bun: the code on the error.
		const node = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
		});
		const bun = Object.assign(new TypeError("ECONNREFUSED: Unable to connect."), { code: "ECONNREFUSED" });
		expect(connectionErrorMessage(node)).toBe("Could not connect to the server.");
		expect(connectionErrorMessage(bun)).toBe("Could not connect to the server.");
	});

	it("shows a certificate failure with its code instead of folding it into the connection message", () => {
		// Node reports a certificate failure as "fetch failed" too; the code is on the cause.
		const node = new TypeError("fetch failed", {
			cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
		});
		expect(connectionErrorMessage(node)).toBe("fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)");
	});

	it("shows the certificate when a connection code is also on the chain", () => {
		// Undici can report several addresses at once: one refused, one with a bad certificate.
		const error = new TypeError("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" }),
				Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
			]),
		});
		expect(connectionErrorMessage(error)).toBe("fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)");
	});

	it("shows a certificate named only in the text, not as a connection failure", () => {
		// The code was lost on the way: the message is all that says what failed.
		const error = new TypeError("fetch failed: Hostname/IP does not match certificate's altnames: Host: localhost.");
		expect(connectionErrorMessage(error)).toBe(error.message);
	});

	it("shows the code of a certificate failure that is not an Error object", () => {
		// A thrown plain object is not an Error: its code is shown, not String(value).
		expect(connectionErrorMessage({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "self-signed certificate" })).toBe(
			"DEPTH_ZERO_SELF_SIGNED_CERT",
		);
	});

	it("keeps the text of an error that has no code", () => {
		expect(connectionErrorMessage(new Error("model not found"))).toBe("model not found");
		expect(connectionErrorMessage("plain")).toBe("plain");
	});
});
