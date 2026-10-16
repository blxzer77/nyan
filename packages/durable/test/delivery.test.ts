import { BACKGROUND_CONTEXT, withAbortSignal } from "@ny4n/chord/context";
import { describe, expect, it } from "vitest";
import { Delivery } from "../src/harness/util.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function delivery<T>(
	deliver: (value: T) => Promise<void>,
	options: { merge?: (waiting: T, next: T) => T; signal?: AbortSignal } = {},
) {
	const errors: unknown[] = [];
	const queue = new Delivery<T>({
		deliver,
		context: options.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(options.signal, BACKGROUND_CONTEXT),
		onError: (error) => errors.push(error),
		...(options.merge === undefined ? {} : { merge: options.merge }),
	});
	return { queue, errors };
}

describe("Delivery", () => {
	it("delivers every value once, in order, with at most one delivery in flight", async () => {
		let inFlight = 0;
		let peak = 0;
		const seen: number[] = [];
		const { queue } = delivery<number>(async (value) => {
			peak = Math.max(peak, ++inFlight);
			await tick();
			seen.push(value);
			inFlight--;
		});
		for (let value = 0; value < 6; value++) {
			queue.push(value);
			if (value % 2 === 1) await Promise.resolve();
		}
		await queue.drain();
		expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
		expect(peak).toBe(1);
	});

	it("keeps accepting values after a delivery threw before its first await", async () => {
		const seen: number[] = [];
		const { queue, errors } = delivery<number>((value) => {
			if (value === 1) throw new Error("synchronous failure");
			seen.push(value);
			return Promise.resolve();
		});
		queue.push(1);
		await queue.drain();
		queue.push(2);
		await queue.drain();
		expect(seen).toEqual([2]);
		expect(errors.map(String)).toEqual(["Error: synchronous failure"]);
	});

	it("starts one pump even when a delivery pushes before its first await", async () => {
		const seen: number[] = [];
		let inFlight = 0;
		let peak = 0;
		let pushed = false;
		const { queue } = delivery<number>(async (value) => {
			peak = Math.max(peak, ++inFlight);
			if (value === 1 && !pushed) {
				pushed = true;
				queue.push(2);
			}
			await tick();
			seen.push(value);
			inFlight--;
		});
		queue.push(1);
		await queue.drain();
		expect(seen).toEqual([1, 2]);
		expect(peak).toBe(1);
	});

	it("reports a failed delivery and still delivers what was queued behind it, before drain returns", async () => {
		const seen: number[] = [];
		const { queue, errors } = delivery<number>(async (value) => {
			await tick();
			if (value === 1) throw new Error("delivery failed");
			seen.push(value);
		});
		queue.push(1);
		queue.push(2);
		queue.push(3);
		await queue.drain();
		expect(seen).toEqual([2, 3]);
		expect(errors.map(String)).toEqual(["Error: delivery failed"]);
	});

	it("keeps delivering when the error reporter itself throws, and drain still resolves", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const seen: number[] = [];
			const queue = new Delivery<number>({
				deliver: async (value) => {
					await tick();
					if (value === 1) throw new Error("delivery failed");
					seen.push(value);
				},
				context: BACKGROUND_CONTEXT,
				onError: () => {
					throw new Error("reporter failed");
				},
			});
			queue.push(1);
			queue.push(2);
			await queue.drain();
			queue.push(3);
			await queue.drain();
			expect(seen).toEqual([2, 3]);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("merges into the last waiting value, so at most one is pending behind the one in flight", async () => {
		const seen: string[] = [];
		const gate = Promise.withResolvers<void>();
		const { queue } = delivery<string>(
			async (value) => {
				if (seen.length === 0) await gate.promise;
				seen.push(value);
			},
			{ merge: (waiting, next) => waiting + next },
		);
		queue.push("a");
		await tick();
		queue.push("b");
		queue.push("c");
		queue.push("d");
		gate.resolve();
		await queue.drain();
		expect(seen).toEqual(["a", "bcd"]);
	});

	it("rejects drain with the abort reason when a delivery never returns, and discards the rest", async () => {
		const controller = new AbortController();
		const seen: number[] = [];
		const { queue, errors } = delivery<number>(
			(value) => {
				seen.push(value);
				return new Promise<never>(() => {});
			},
			{ signal: controller.signal },
		);
		queue.push(1);
		queue.push(2);
		const drained = queue.drain();
		controller.abort(new Error("aborted run"));
		await expect(drained).rejects.toThrow("aborted run");
		await tick();
		queue.push(3);
		await tick();
		expect(seen).toEqual([1]);
		expect(errors).toEqual([]);
	});

	it("does not leave an unhandled rejection when a delivery fails after the abort", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const controller = new AbortController();
			const { queue } = delivery<number>(
				() => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late failure")), 5)),
				{ signal: controller.signal },
			);
			queue.push(1);
			controller.abort();
			await expect(queue.drain()).rejects.toMatchObject({ name: "AbortError" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
