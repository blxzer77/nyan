import { describe, expect, it, vi } from "vitest";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
} from "../src/context/index.ts";

describe("Context", () => {
	it("provides distinct empty root contexts", () => {
		const key = createContextKey<string>("value");

		expect(TODO_CONTEXT).not.toBe(BACKGROUND_CONTEXT);
		expect(TODO_CONTEXT.abortSignal).toBeUndefined();
		expect(TODO_CONTEXT.value(key)).toBeUndefined();
		expect(String(BACKGROUND_CONTEXT)).toBe("[Context BACKGROUND_CONTEXT]");
		expect(String(TODO_CONTEXT)).toBe("[Context TODO_CONTEXT]");
	});

	it("layers typed values without modifying parents", () => {
		const firstKey = createContextKey<string>("first");
		const secondKey = createContextKey<number>("second");
		const first = withContextValue(firstKey, "one", BACKGROUND_CONTEXT);
		const second = withContextValue(secondKey, 2, first);
		const replaced = withContextValue(firstKey, "updated", second);

		expect(BACKGROUND_CONTEXT.value(firstKey)).toBeUndefined();
		expect(first.value(firstKey)).toBe("one");
		expect(first.value(secondKey)).toBeUndefined();
		expect(second.value(firstKey)).toBe("one");
		expect(second.value(secondKey)).toBe(2);
		expect(replaced.value(firstKey)).toBe("updated");
		expect(second.value(firstKey)).toBe("one");
		expect(String(replaced)).toBe("[Context BACKGROUND_CONTEXT].WithValue(first).WithValue(second).WithValue(first)");
	});

	it("inherits parent cancellation and isolates child cancellation", () => {
		const parentController = new AbortController();
		const parent = withAbortSignal(parentController.signal, BACKGROUND_CONTEXT);
		const child = withCancel(parent);
		const sibling = withCancel(parent);
		const childListener = vi.fn();
		child.context.abortSignal?.addEventListener("abort", childListener);

		child.cancel("child");
		expect(child.context.abortSignal?.aborted).toBe(true);
		expect(child.context.abortSignal?.reason).toBe("child");
		expect(sibling.context.abortSignal?.aborted).toBe(false);
		expect(parent.abortSignal?.aborted).toBe(false);
		expect(childListener).toHaveBeenCalledOnce();

		parentController.abort("parent");
		expect(sibling.context.abortSignal?.aborted).toBe(true);
		expect(sibling.context.abortSignal?.reason).toBe("parent");
	});

	it("masks caller cancellation for mandatory cleanup", () => {
		const controller = new AbortController();
		const key = createContextKey<string>("value");
		const context = withContextValue(key, "preserved", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		const cleanup = withoutAbortSignal(context);

		controller.abort();
		expect(context.abortSignal?.aborted).toBe(true);
		expect(cleanup.abortSignal).toBeUndefined();
		expect(cleanup.value(key)).toBe("preserved");
	});

	it("stops waiting when the invocation is cancelled", async () => {
		const controller = new AbortController();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		let resolveWork!: (value: string) => void;
		const work = new Promise<string>((resolve) => {
			resolveWork = resolve;
		});
		const waiting = awaitWithContext(work, context);
		const cancellation = new Error("cancelled");

		controller.abort(cancellation);
		await expect(waiting).rejects.toBe(cancellation);
		resolveWork("completed later");
		await expect(work).resolves.toBe("completed later");
		await expect(awaitWithContext(Promise.resolve("completed"), BACKGROUND_CONTEXT)).resolves.toBe("completed");
	});

	/** Unhandled rejections raised while `run` and a further 30 ms go by. */
	async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			await run();
			await new Promise((resolve) => setTimeout(resolve, 30));
			return unhandled;
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}

	const failsLater = (message: string) =>
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 5));

	// The regression guard: an already cancelled context returns before the work gets any observer, so `awaitWithContext`
	// must mark the work handled itself.
	it("leaves no unhandled rejection when the work fails after the context was already cancelled", async () => {
		const early = new AbortController();
		early.abort();
		expect(
			await unhandledDuring(async () => {
				const waiting = awaitWithContext(
					failsLater("after early abort"),
					withAbortSignal(early.signal, BACKGROUND_CONTEXT),
				);
				await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			}),
		).toEqual([]);
	});

	it("accepts a thenable that is not a Promise when the context was already cancelled", async () => {
		const early = new AbortController();
		early.abort();
		const thenable = {
			// biome-ignore lint/suspicious/noThenProperty: the test needs a thenable that is not a Promise
			then(_resolve: (value: string) => void, reject: (error: unknown) => void) {
				setTimeout(() => reject(new Error("thenable failed")), 5);
			},
		};
		expect(
			await unhandledDuring(async () => {
				const waiting = awaitWithContext(
					thenable as unknown as Promise<string>,
					withAbortSignal(early.signal, BACKGROUND_CONTEXT),
				);
				await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			}),
		).toEqual([]);
	});

	// Not a guard for that fix: the waiter's own `then` already observes the work, so this passes without it. It pins
	// that cancelling mid-wait stays quiet.
	it("leaves no unhandled rejection when the work fails after a cancel during the wait", async () => {
		const late = new AbortController();
		expect(
			await unhandledDuring(async () => {
				const waiting = awaitWithContext(
					failsLater("after late abort"),
					withAbortSignal(late.signal, BACKGROUND_CONTEXT),
				);
				late.abort();
				await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			}),
		).toEqual([]);
	});
});
