import { afterEach, describe, expect, it } from "vitest";
import { getNyanUserAgent } from "../src/utils/nyan-user-agent.ts";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

let restoreRuntimeMarker: (() => void) | undefined;

afterEach(() => {
	restoreRuntimeMarker?.();
	restoreRuntimeMarker = undefined;
});

describe("getNyanUserAgent", () => {
	it("formats the nyan user agent", () => {
		const userAgent = getNyanUserAgent("1.2.3");

		expect(userAgent.startsWith("nyan/1.2.3 (")).toBe(true);
		expect(userAgent).toMatch(/^nyan\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});

	it("reports Bun when the Bun marker is set", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("1.4.2");

		expect(getNyanUserAgent("1.2.3")).toBe(`nyan/1.2.3 (${process.platform}; bun/1.4.2; ${process.arch})`);
	});

	it("reports Node when the Bun marker is absent", () => {
		restoreRuntimeMarker = setBunRuntimeMarker(undefined);

		expect(getNyanUserAgent("1.2.3")).toBe(
			`nyan/1.2.3 (${process.platform}; node/${process.version}; ${process.arch})`,
		);
	});

	it("reports Node when the Bun marker is an empty string", () => {
		restoreRuntimeMarker = setBunRuntimeMarker("");

		expect(getNyanUserAgent("1.2.3")).toBe(
			`nyan/1.2.3 (${process.platform}; node/${process.version}; ${process.arch})`,
		);
	});
});
