import { sep } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { type DurableFooterInput, footerHintsLine, footerStatsLine } from "../src/modes/durable/footer.ts";
import { initTheme } from "../src/ui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * The durable TUI's footer lines. What the footer says is a user-visible contract: the directory as `~`, the session
 * name, a subscription estimate, the auto-compaction marker, the provider prefix, the routed model, and the final hint
 * line. The interactive footer's own tests do not cover this path.
 */

beforeAll(() => {
	initTheme(undefined, false);
});

const base: DurableFooterInput = {
	cwd: "/home/user/project",
	home: "/home/user",
	sessionName: undefined,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	provider: "anthropic",
	modelId: "claude-sonnet",
	reasoning: false,
	thinkingLevel: "off",
	routedModel: undefined,
	subscription: false,
	providerCount: 1,
	contextWindow: 0,
	contextPercent: undefined,
	autoCompaction: true,
	conversationLabel: "main",
	extensionStatuses: [],
};

const stats = (input: Partial<DurableFooterInput>): string => stripAnsi(footerStatsLine({ ...base, ...input }));
const hints = (input: Partial<DurableFooterInput>): string => stripAnsi(footerHintsLine({ ...base, ...input }));

describe("durable footer stats line", () => {
	test("shows the directory relative to home, with the session name", () => {
		expect(stats({})).toBe(`$0.000  ~${sep}project`);
		expect(stats({ cwd: "/home/user" })).toBe("$0.000  ~");
		expect(stats({ cwd: "/srv/other" })).toBe("$0.000  /srv/other");
		expect(stats({ sessionName: "release line" })).toBe(`$0.000  ~${sep}project  release line`);
	});

	test("shows tokens, cost, and a subscription estimate", () => {
		expect(
			stats({ usage: { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0, cost: 1.234 }, subscription: true }),
		).toBe(`↑1.2k ↓567 $1.234 (sub)  ~${sep}project`);
	});

	test("marks auto-compaction and shows the context percentage in the window", () => {
		expect(stats({ contextWindow: 200_000, contextPercent: 12.34, autoCompaction: true })).toBe(
			`$0.000 12.3%/200k (auto)  ~${sep}project`,
		);
		// With auto-compaction off the marker is absent, and an unmeasured context shows as unknown.
		expect(stats({ contextWindow: 128_000, contextPercent: undefined, autoCompaction: false })).toBe(
			`$0.000 ?/128k  ~${sep}project`,
		);
	});
});

describe("durable footer hint line", () => {
	test("names the conversation, the model, and the thinking level", () => {
		expect(hints({})).toContain("main · claude-sonnet · thinking:off");
		expect(hints({ conversationLabel: "fork 7" })).toContain("fork 7 · claude-sonnet");
	});

	test("a reasoning model shows its level, and off says so", () => {
		expect(hints({ reasoning: true, thinkingLevel: "high" })).toContain("claude-sonnet • high");
		expect(hints({ reasoning: true, thinkingLevel: "off" })).toContain("claude-sonnet • thinking off");
		// A model without reasoning does not claim a level.
		expect(hints({ reasoning: false, thinkingLevel: "high" })).toContain("main · claude-sonnet · thinking:high");
	});

	test("a virtual model shows where the newest answer went", () => {
		expect(hints({ routedModel: { modelId: "gpt-5.6-luna", thinkingLevel: "medium" } })).toContain(
			"claude-sonnet → gpt-5.6-luna • medium",
		);
		expect(hints({ routedModel: { modelId: "gpt-5.6-luna" } })).toContain("claude-sonnet → gpt-5.6-luna ·");
	});

	test("the provider is named in front of the model only when several are configured", () => {
		expect(hints({ providerCount: 1 })).toContain("main · claude-sonnet");
		expect(hints({ providerCount: 2 })).toContain("main · (anthropic) claude-sonnet");
	});

	test("lists extension statuses and the hints the command list ends on", () => {
		const line = hints({ extensionStatuses: ["paused", "proxy: 3"] });
		expect(line).toContain("paused · proxy: 3 · main");
		expect(line).toContain("/ commands");
		expect(line).toContain("! bash");
		expect(line).toContain("!! bash (no context)");
		expect(line).toContain("follow-up");
		expect(line).toContain("clear, twice to exit");
	});
});
