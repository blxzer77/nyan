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

	it("keeps the text of an error that has no code", () => {
		expect(connectionErrorMessage(new Error("model not found"))).toBe("model not found");
		expect(connectionErrorMessage("plain")).toBe("plain");
	});
});
