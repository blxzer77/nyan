import { describe, expect, test } from "vitest";
import { type ChangelogEntry, normalizeChangelogLinks, releaseTag } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("releaseTag", () => {
	test("uses the nyan-v prefix, never Pi's plain v tags", () => {
		expect(releaseTag("1.0.0")).toBe("nyan-v1.0.0");
		expect(releaseTag("v1.0.0")).toBe("nyan-v1.0.0");
		expect(releaseTag("nyan-v1.0.0")).toBe("nyan-v1.0.0");
		expect(releaseTag(entry)).toBe("nyan-v0.79.0");
	});
});

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/blxzer77/nyan/blob/nyan-v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/blxzer77/nyan/blob/nyan-v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/blxzer77/nyan/tree/nyan-v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/blxzer77/nyan/blob/nyan-v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("pins floating repository links to the tag and leaves other links unchanged", () => {
		const markdown = [
			"[#5167](https://github.com/blxzer77/nyan/pull/5167)",
			"[Agent README](https://github.com/blxzer77/nyan/blob/main/packages/agent/README.md)",
			"[Upstream](https://github.com/example-org/other-project/blob/main/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/blxzer77/nyan/pull/5167)",
				"[Agent README](https://github.com/blxzer77/nyan/blob/nyan-v0.79.0/packages/agent/README.md)",
				"[Upstream](https://github.com/example-org/other-project/blob/main/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
