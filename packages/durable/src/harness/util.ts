import type { Context } from "@ny4n/chord";
import { awaitWithContext } from "@ny4n/chord/context";
import { SessionFailed } from "../errors.ts";
import type { Cursor, Page } from "../types.ts";

/** Pending waits by key. Each settles once: through `resolve`, `rejectAll`, or cancellation of its context. */
export class Waiters<K, T> {
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const waiter = Promise.withResolvers<T>();
		const set = this.#sets.get(key) ?? new Set();
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			const onAbort = (): void => {
				set.delete(waiter);
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}

	keys(): K[] {
		return [...this.#sets.keys()];
	}

	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		this.#sets.delete(key);
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	rejectAll(error: unknown): void {
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** Every item of a paginated scan, in page order. */
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** What a closed Harness rejects with: `SessionFailed` with the cause when it closed because the Session failed. */
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}

/**
 * Sequential delivery of values to hook observers, off the producer's path (spec §7.2, "Streaming hooks").
 *
 * One delivery is in flight at a time and values are delivered in the order pushed, so an observer never sees value
 * `k+1` before every observer finished `k`. The producer never waits: `push()` returns at once. Without `merge` the
 * queue holds every undelivered value, which for a stream is as large as the response. With `merge`, a value pushed
 * while another is already waiting is folded into the waiting one, so at most one delivery is in flight and one is
 * pending.
 *
 * Every wait races the invocation's `context`: an observer that never returns delays delivery only until the invocation
 * is aborted, after which the rest is discarded. `deliver` reports an ordinary observer failure itself, as
 * `HookRunner.each()` does; whatever else it throws goes to `onError` unless the invocation is aborted.
 */
export class Delivery<T> {
	readonly #deliver: (value: T) => Promise<void>;
	readonly #context: Context;
	readonly #onError: (error: unknown) => void;
	readonly #merge: ((waiting: T, next: T) => T) | undefined;
	readonly #queue: T[] = [];
	#running: Promise<void> | undefined;
	#stopped = false;

	constructor(options: {
		readonly deliver: (value: T) => Promise<void>;
		readonly context: Context;
		readonly onError: (error: unknown) => void;
		readonly merge?: (waiting: T, next: T) => T;
	}) {
		this.#deliver = options.deliver;
		this.#context = options.context;
		this.#onError = options.onError;
		this.#merge = options.merge;
	}

	push(value: T): void {
		if (this.#stopped) return;
		const last = this.#queue.length - 1;
		if (this.#merge !== undefined && last >= 0) this.#queue[last] = this.#merge(this.#queue[last] as T, value);
		else this.#queue.push(value);
		this.#running ??= this.#run();
	}

	async #run(): Promise<void> {
		// Until here `push()` has not stored this promise. Without the wait, a delivery that threw or pushed before its
		// first await would run `finally` first and leave a finished promise in `#running`, or start a second pump.
		await Promise.resolve();
		try {
			while (!this.#stopped && this.#queue.length > 0) {
				try {
					await awaitWithContext(this.#deliver(this.#queue.shift() as T), this.#context);
				} catch (error) {
					if (this.#context.abortSignal?.aborted === true) this.stop();
					else this.#onError(error);
				}
			}
		} finally {
			// No await between the loop's last check and here, so a `push()` never lands in the gap.
			this.#running = undefined;
		}
	}

	/** Resolve once everything pushed so far was delivered; reject with the abort reason if the invocation aborts first. */
	drain(): Promise<void> {
		return awaitWithContext(this.#running ?? Promise.resolve(), this.#context);
	}

	/** Discard what is still queued and accept nothing more; a delivery in flight is not interrupted. */
	stop(): void {
		this.#stopped = true;
		this.#queue.length = 0;
	}
}
