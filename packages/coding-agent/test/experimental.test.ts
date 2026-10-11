import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalNyanExperimental = process.env.NYAN_EXPERIMENTAL;

	afterEach(() => {
		if (originalNyanExperimental === undefined) {
			delete process.env.NYAN_EXPERIMENTAL;
		} else {
			process.env.NYAN_EXPERIMENTAL = originalNyanExperimental;
		}
	});

	it("returns false when NYAN_EXPERIMENTAL is unset", () => {
		delete process.env.NYAN_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NYAN_EXPERIMENTAL is empty", () => {
		process.env.NYAN_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when NYAN_EXPERIMENTAL is set to 1", () => {
		process.env.NYAN_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when NYAN_EXPERIMENTAL is set to 0", () => {
		process.env.NYAN_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NYAN_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.NYAN_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
