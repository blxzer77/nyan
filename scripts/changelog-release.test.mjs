import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hasVersionSection, releaseDate, stampChangelog } from "./changelog-release.mjs";

const changelog = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Fixed",
	"",
	"- A fix.",
	"",
	"## [1.0.0] - 2026-10-12",
	"",
	"- First release.",
	"",
].join("\n");

describe("stampChangelog", () => {
	it("moves the unreleased entries under the new version and keeps an empty Unreleased section", () => {
		const stamped = stampChangelog(changelog, "1.0.1", "2026-10-20");
		assert.equal(
			stamped,
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"## [1.0.1] - 2026-10-20",
				"",
				"### Fixed",
				"",
				"- A fix.",
				"",
				"## [1.0.0] - 2026-10-12",
				"",
				"- First release.",
				"",
			].join("\n"),
		);
		assert.ok(hasVersionSection(stamped, "1.0.1"));
	});

	it("leaves a changelog that already has the version unchanged", () => {
		const once = stampChangelog(changelog, "1.0.1", "2026-10-20");
		assert.equal(stampChangelog(once, "1.0.1", "2026-10-21"), once);
	});

	it("keeps CRLF line endings", () => {
		const stamped = stampChangelog(changelog.replace(/\n/g, "\r\n"), "1.0.1", "2026-10-20");
		assert.ok(stamped.includes("## [Unreleased]\r\n\r\n## [1.0.1] - 2026-10-20\r\n"));
		assert.ok(!/[^\r]\n/.test(stamped));
	});

	it("refuses a release with no unreleased entries", () => {
		const empty = changelog.replace("### Fixed\n\n- A fix.\n\n", "");
		assert.throws(() => stampChangelog(empty, "1.0.1", "2026-10-20"), /no entries under/);
	});

	it("refuses a changelog without an Unreleased section", () => {
		assert.throws(() => stampChangelog("# Changelog\n\n## [1.0.0] - 2026-10-12\n", "1.0.1", "2026-10-20"), /no "## \[Unreleased\]"/);
	});

	it("does not mistake 1.0.10 for 1.0.1", () => {
		assert.ok(!hasVersionSection("## [1.0.10] - 2026-10-20\n", "1.0.1"));
	});
});

describe("releaseDate", () => {
	it("formats the UTC date", () => {
		assert.equal(releaseDate(new Date("2026-10-20T23:30:00Z")), "2026-10-20");
	});
});

describe("--check", () => {
	const script = fileURLToPath(new URL("./changelog-release.mjs", import.meta.url));
	const root = fileURLToPath(new URL("..", import.meta.url));
	it("passes for a released version and fails for one without a section", () => {
		assert.equal(spawnSync(process.execPath, [script, "--check", "1.0.0"], { cwd: root }).status, 0);
		assert.equal(spawnSync(process.execPath, [script, "--check", "99.0.0"], { cwd: root }).status, 1);
	});
});
