/**
 * The durable TUI's notice area, without a terminal. A notice is a transient line the TUI shows below the transcript
 * and above the editor: an extension handler's failure, an answer to a command this path cannot run, a warning the
 * runtime recorded. Nothing removes one, so before this the area filled up and stayed filled for the whole session.
 *
 * Time is a parameter rather than a clock read, so what the area shows at a given moment is testable; the TUI passes
 * `Date.now()` and schedules one redraw at `nextExpiry`.
 */

export type NoticeLevel = "info" | "warning" | "error";

/** A notice the runtime recorded; `id` is the runtime's own counter, and it only ever grows. */
export interface RecordedNotice {
	readonly id: number;
	readonly level: NoticeLevel;
	readonly message: string;
}

/** A line to draw. */
export interface ShownNotice {
	readonly level: NoticeLevel;
	readonly message: string;
}

/**
 * How long a line stays. An error is worth reading after an info line, which the user already acted on, so it lasts
 * longer; both are short enough that a run of failures never becomes a permanent block of text.
 */
export const NOTICE_TTL_MS: Readonly<Record<NoticeLevel, number>> = {
	info: 10_000,
	warning: 15_000,
	error: 30_000,
};

/** How many lines are shown at once: the newest, and the older ones wait behind them. */
export const NOTICE_VISIBLE = 3;

interface Entry extends ShownNotice {
	readonly expiresAt: number;
}

export class NoticeArea {
	readonly #ttl: Readonly<Record<NoticeLevel, number>>;
	readonly #visibleCount: number;
	#entries: Entry[] = [];
	/** The newest runtime notice adopted, so a list that only grew does not restart the ones already shown. */
	#adoptedId: number | undefined;

	constructor(options: { readonly ttl?: Partial<Record<NoticeLevel, number>>; readonly visible?: number } = {}) {
		this.#ttl = { ...NOTICE_TTL_MS, ...options.ttl };
		this.#visibleCount = options.visible ?? NOTICE_VISIBLE;
	}

	/** A line this TUI shows itself: an extension failure, or what a command answered. */
	push(level: NoticeLevel, message: string, now: number): void {
		this.#add({ level, message }, now);
	}

	/**
	 * Adopt the runtime's notices. The list is the last few it recorded and every update carries all of them again, so
	 * only an id newer than the last adopted one is added: a redraw does not restart a line that is already counting
	 * down.
	 */
	adopt(notices: readonly RecordedNotice[], now: number): void {
		for (const notice of notices) {
			if (this.#adoptedId !== undefined && notice.id <= this.#adoptedId) continue;
			this.#adoptedId = notice.id;
			this.#add({ level: notice.level, message: notice.message }, now);
		}
	}

	/** The lines to draw now, oldest first. */
	visible(now: number): readonly ShownNotice[] {
		this.#prune(now);
		return this.#entries.slice(-this.#visibleCount).map(({ level, message }) => ({ level, message }));
	}

	/** When the next line expires, so the caller can schedule one redraw; undefined when nothing can expire. */
	nextExpiry(now: number): number | undefined {
		this.#prune(now);
		if (this.#entries.length === 0) return undefined;
		return Math.min(...this.#entries.map((entry) => entry.expiresAt));
	}

	/** Forget everything: another session's notices are not this one's. */
	reset(): void {
		this.#entries = [];
		this.#adoptedId = undefined;
	}

	#add(notice: ShownNotice, now: number): void {
		this.#entries.push({ ...notice, expiresAt: now + this.#ttl[notice.level] });
	}

	#prune(now: number): void {
		this.#entries = this.#entries.filter((entry) => entry.expiresAt > now);
	}
}
