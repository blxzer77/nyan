import { describe, expect, test } from "vitest";
import { NOTICE_TTL_MS, NOTICE_VISIBLE, NoticeArea } from "../src/modes/durable/notices.ts";

/**
 * The durable TUI's notice area. What it shows is a user-visible contract: a line appears when something happens, it
 * disappears on its own instead of staying for the rest of the session, and a redraw of the same notices does not
 * restart the countdown. Time is passed in by the caller, so each case states the moment it means.
 */

const t0 = 1_000_000;
const shown = (area: NoticeArea, now: number): string[] =>
	area.visible(now).map((notice) => `${notice.level}: ${notice.message}`);

describe("notice lifetime", () => {
	test("a line is shown until its own level's time runs out", () => {
		const area = new NoticeArea();
		area.push("info", "Copied last agent message", t0);
		expect(shown(area, t0)).toEqual(["info: Copied last agent message"]);
		expect(shown(area, t0 + NOTICE_TTL_MS.info - 1)).toEqual(["info: Copied last agent message"]);
		expect(shown(area, t0 + NOTICE_TTL_MS.info)).toEqual([]);
	});

	test("an error outlives an info line pushed with it", () => {
		const area = new NoticeArea();
		area.push("info", "Gist: https://gist.example/1", t0);
		area.push("error", "Extension /ext/a.ts failed on session_start: Theme not initialized", t0);
		expect(shown(area, t0 + NOTICE_TTL_MS.info)).toEqual([
			"error: Extension /ext/a.ts failed on session_start: Theme not initialized",
		]);
		expect(shown(area, t0 + NOTICE_TTL_MS.error)).toEqual([]);
	});

	test("the area reports when its next line expires, and nothing once it is empty", () => {
		const area = new NoticeArea();
		expect(area.nextExpiry(t0)).toBeUndefined();
		area.push("warning", "A bash command is already running.", t0);
		area.push("error", "Compaction failed", t0 + 1_000);
		expect(area.nextExpiry(t0)).toBe(t0 + NOTICE_TTL_MS.warning);
		expect(area.nextExpiry(t0 + NOTICE_TTL_MS.warning)).toBe(t0 + 1_000 + NOTICE_TTL_MS.error);
		expect(area.nextExpiry(t0 + 1_000 + NOTICE_TTL_MS.error)).toBeUndefined();
	});

	test("only the newest lines are shown, the older ones waiting behind them", () => {
		const area = new NoticeArea();
		for (let index = 1; index <= NOTICE_VISIBLE + 2; index++) area.push("info", `line ${index}`, t0);
		expect(shown(area, t0)).toEqual(["info: line 3", "info: line 4", "info: line 5"]);
	});
});

describe("runtime notices", () => {
	const recorded = (id: number, message: string) => ({ id, level: "warning" as const, message });

	test("adopting the same list again does not restart a countdown", () => {
		const area = new NoticeArea();
		area.adopt([recorded(1, "Saved model is unavailable: a/b")], t0);
		area.adopt([recorded(1, "Saved model is unavailable: a/b")], t0 + NOTICE_TTL_MS.warning - 1);
		expect(shown(area, t0 + NOTICE_TTL_MS.warning)).toEqual([]);
	});

	test("a list that grew adopts only the notices it had not seen", () => {
		const area = new NoticeArea();
		area.adopt([recorded(1, "first")], t0);
		area.adopt([recorded(1, "first"), recorded(2, "second")], t0 + 1_000);
		expect(shown(area, t0 + NOTICE_TTL_MS.warning - 1)).toEqual(["warning: first", "warning: second"]);
		expect(shown(area, t0 + NOTICE_TTL_MS.warning)).toEqual(["warning: second"]);
		expect(shown(area, t0 + 1_000 + NOTICE_TTL_MS.warning - 1)).toEqual(["warning: second"]);
		expect(shown(area, t0 + 1_000 + NOTICE_TTL_MS.warning)).toEqual([]);
	});

	test("a TUI's own line and the runtime's are one list, in the order they arrived", () => {
		const area = new NoticeArea();
		area.adopt([recorded(7, "No model configured; select one with /model.")], t0);
		area.push("error", "A cache refresh's usage was not recorded", t0 + 500);
		expect(shown(area, t0 + 500)).toEqual([
			"warning: No model configured; select one with /model.",
			"error: A cache refresh's usage was not recorded",
		]);
	});
});

describe("reset", () => {
	test("another session starts with an empty area, and adopts its notices from the start", () => {
		const area = new NoticeArea();
		area.adopt([{ id: 9, level: "info", message: "old session" }], t0);
		area.reset();
		expect(shown(area, t0)).toEqual([]);
		expect(area.nextExpiry(t0)).toBeUndefined();
		// The new session's runtime starts its own counter, so a lower id is still adopted once.
		area.adopt([{ id: 1, level: "warning", message: "new session" }], t0);
		expect(shown(area, t0)).toEqual(["warning: new session"]);
	});
});
