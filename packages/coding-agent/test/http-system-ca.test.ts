import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetSystemCaWarningForTests,
	SYSTEM_CA_IGNORED_MESSAGE,
	systemCaIgnoredByBun,
	warnIfSystemCaIgnoredByBun,
} from "../src/core/http/system-ca.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

// `NODE_OPTIONS=--use-system-ca` is how a Node setup trusts the operating system certificate store. Bun does not read
// NODE_OPTIONS (measured on Bun 1.4.3, Windows x64: with a CA only in the user store, NODE_OPTIONS fails; --use-system-ca,
// BUN_OPTIONS=--use-system-ca and NODE_USE_SYSTEM_CA=1 succeed), so such a setup has to be told once.

describe("systemCaIgnoredByBun", () => {
	it.each([
		["NODE_OPTIONS alone", { NODE_OPTIONS: "--use-system-ca" }, []],
		["NODE_OPTIONS among other options", { NODE_OPTIONS: "--max-old-space-size=512  --use-system-ca" }, []],
		["NODE_USE_SYSTEM_CA=0", { NODE_OPTIONS: "--use-system-ca", NODE_USE_SYSTEM_CA: "0" }, []],
	])("is true for %s", (_label, env, execArgv) => {
		expect(systemCaIgnoredByBun(env, execArgv)).toBe(true);
	});

	it.each([
		["no request for the system store", {}, []],
		["another NODE_OPTIONS flag", { NODE_OPTIONS: "--max-old-space-size=512" }, []],
		["a flag that only contains the name", { NODE_OPTIONS: "--use-system-ca-extra" }, []],
		["NODE_USE_SYSTEM_CA=1", { NODE_OPTIONS: "--use-system-ca", NODE_USE_SYSTEM_CA: "1" }, []],
		["NODE_USE_SYSTEM_CA=true", { NODE_OPTIONS: "--use-system-ca", NODE_USE_SYSTEM_CA: " TRUE " }, []],
		["BUN_OPTIONS", { NODE_OPTIONS: "--use-system-ca", BUN_OPTIONS: "--use-system-ca" }, []],
		["the flag on the bun command line", { NODE_OPTIONS: "--use-system-ca" }, ["--use-system-ca"]],
	])("is false for %s", (_label, env, execArgv) => {
		expect(systemCaIgnoredByBun(env, execArgv)).toBe(false);
	});
});

describe("warnIfSystemCaIgnoredByBun", () => {
	beforeEach(() => resetSystemCaWarningForTests());

	it("warns once, however often it is called", () => {
		const warn = vi.fn();

		warnIfSystemCaIgnoredByBun({ NODE_OPTIONS: "--use-system-ca" }, [], warn);
		warnIfSystemCaIgnoredByBun({ NODE_OPTIONS: "--use-system-ca" }, [], warn);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(SYSTEM_CA_IGNORED_MESSAGE);
	});

	it("names the variables that work", () => {
		expect(SYSTEM_CA_IGNORED_MESSAGE).toContain("NODE_USE_SYSTEM_CA=1");
		expect(SYSTEM_CA_IGNORED_MESSAGE).toContain("BUN_OPTIONS=--use-system-ca");
		expect(SYSTEM_CA_IGNORED_MESSAGE).toContain("NODE_EXTRA_CA_CERTS");
	});

	it("stays quiet when the system store is enabled the way Bun reads it", () => {
		const warn = vi.fn();

		warnIfSystemCaIgnoredByBun({ NODE_OPTIONS: "--use-system-ca", NODE_USE_SYSTEM_CA: "1" }, [], warn);

		expect(warn).not.toHaveBeenCalled();
	});
});

describe.runIf(typeof process.versions.bun === "string")("configureHttpDispatcher on Bun", () => {
	beforeEach(() => resetSystemCaWarningForTests());

	it("warns once when NODE_OPTIONS asks for the system store, and not on Node", () => {
		const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			process.env.NODE_OPTIONS = "--use-system-ca";
			delete process.env.NODE_USE_SYSTEM_CA;

			configureHttpDispatcher(0);
			configureHttpDispatcher(0);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("NODE_OPTIONS=--use-system-ca");
		} finally {
			warn.mockRestore();
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe.skipIf(typeof process.versions.bun === "string")("configureHttpDispatcher on Node", () => {
	it("does not warn: Node reads NODE_OPTIONS itself", () => {
		const saved = process.env.NODE_OPTIONS;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		resetSystemCaWarningForTests();
		try {
			process.env.NODE_OPTIONS = "--use-system-ca";

			configureHttpDispatcher(0);

			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			if (saved === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = saved;
		}
	});
});
