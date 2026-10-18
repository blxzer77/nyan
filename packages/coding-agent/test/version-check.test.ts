import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewNyanVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestNyanRelease,
	getLatestNyanVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.NYAN_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
	process.env.NYAN_LATEST_VERSION_URL = "https://releases.example.test/api/latest-version";
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.NYAN_LATEST_VERSION_URL;
	if (originalSkipVersionCheck === undefined) {
		delete process.env.NYAN_SKIP_VERSION_CHECK;
	} else {
		process.env.NYAN_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNyanVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewNyanVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("asks the npm registry for this package's latest version by default", async () => {
		delete process.env.NYAN_LATEST_VERSION_URL;
		const fetchMock = vi.fn(async () => Response.json({ name: "@ny4n/coding-agent", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/@ny4n%2Fcoding-agent/latest",
			expect.anything(),
		);
	});

	it("uses the configured release feed with a nyan user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://releases.example.test/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^nyan\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNyanVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("names the first underlying message when no error on the chain has a code", () => {
		// The members of the cause only carry text, so the detail has to come from their messages.
		const error = new Error("fetch failed", {
			cause: new AggregateError([new Error("connect failed to 127.0.0.1:443"), new Error("connect failed to ::1")]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (cause: connect failed to 127.0.0.1:443)");
	});

	it("adds the code of an error that carries it itself (Bun)", () => {
		expect(formatVersionCheckError(Object.assign(new TypeError("Unable to connect"), { code: "ECONNREFUSED" }))).toBe(
			"Unable to connect (ECONNREFUSED)",
		);
	});

	it("does not repeat a code that the message already names", () => {
		const error = Object.assign(new TypeError("ECONNREFUSED: Unable to connect"), { code: "ECONNREFUSED" });
		expect(formatVersionCheckError(error)).toBe("ECONNREFUSED: Unable to connect");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/nyan",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/nyan",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.NYAN_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNyanVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.NYAN_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNyanVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
