import { describe, expect, it } from "vitest";
import { getNyanUserAgent } from "../src/utils/nyan-user-agent.ts";

describe("getNyanUserAgent", () => {
	it("formats the nyan user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getNyanUserAgent("1.2.3");

		expect(userAgent).toBe(`nyan/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^nyan\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
