import { type FauxResponseStep, fauxAssistantMessage, fauxText, type Model, type SimpleStreamOptions } from "@ny4n/ai";
import { GenerationTask, type Harness, LiveDoc, MemoryStorage } from "@ny4n/durable";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addHooks } from "./harness-support.ts";
import { context } from "./session-support.ts";

type Seen = { options: SimpleStreamOptions | undefined; model: Model<string> | undefined };

/** A faux step that plays the adapter: it calls the callbacks the request options carry, as a provider adapter does. */
function adapter(
	play: (options: SimpleStreamOptions, model: Model<string>) => Promise<void>,
	seen: Seen[] = [],
): FauxResponseStep {
	return async (_request, options, _state, model) => {
		seen.push({ options, model });
		await play(options!, model);
		return fauxAssistantMessage([fauxText("answer")]);
	};
}

async function runOnce(setup: ChatSetup, steps: FauxResponseStep[]): Promise<{ status: string; harness: Harness }> {
	setup.faux.setResponses(steps);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	return { status: settled.status, harness };
}

describe("provider hooks", () => {
	it("leaves every provider callback unset when no hook is registered", async () => {
		const setup = chatSetup();
		const seen: Seen[] = [];
		const { status, harness } = await runOnce(setup, [adapter(async () => {}, seen)]);
		expect(status).toBe("done");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.options!.onPayload).toBeUndefined();
		expect(seen[0]!.options!.onProviderStreamEvent).toBeUndefined();
		// The faux adapter calls `onResponse` when it is set; none was set.
		expect(seen[0]!.options!.onResponse).toBeUndefined();
		await harness.close(context);
	});

	it("chains beforeProviderRequest replacements and keeps the body when nobody replaces it", async () => {
		const setup = chatSetup();
		const bodies: unknown[] = [];
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ payload, model }) => ({ payload: { ...(payload as object), first: model.id } }),
		});
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: ({ payload }) => ({ payload: { ...(payload as object), second: true } }),
		});
		// A hook that returns nothing leaves the previous replacement in place.
		addHooks(setup.registry, GenerationTask, { beforeProviderRequest: () => undefined });
		const { harness } = await runOnce(setup, [
			adapter(async (options, model) => {
				bodies.push(await options.onPayload!({ original: 1 }, model));
			}),
		]);
		expect(bodies).toEqual([{ original: 1, first: "faux-1", second: true }]);
		await harness.close(context);
	});

	it("keeps the adapter's body when the only hook returns undefined", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, { beforeProviderRequest: () => undefined });
		const bodies: unknown[] = [];
		const { harness } = await runOnce(setup, [
			adapter(async (options, model) => {
				bodies.push(await options.onPayload!({ original: 1 }, model));
			}),
		]);
		// `undefined` is the provider callback's "keep", not an empty body.
		expect(bodies).toEqual([undefined]);
		await harness.close(context);
	});

	it("reports a throwing payload hook and goes on with the next one", async () => {
		const setup = chatSetup();
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: () => {
				throw new Error("payload hook failed");
			},
		});
		addHooks(setup.registry, GenerationTask, { beforeProviderRequest: () => ({ payload: { replaced: true } }) });
		const bodies: unknown[] = [];
		const { status, harness } = await runOnce(setup, [
			adapter(async (options, model) => {
				bodies.push(await options.onPayload!({ original: 1 }, model));
			}),
		]);
		expect(status).toBe("done");
		expect(bodies).toEqual([{ replaced: true }]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("payload hook failed");
		await harness.close(context);
	});

	it("hands the merged request headers to beforeProviderHeaders and sends its replacement", async () => {
		const setup = chatSetup();
		const received: unknown[] = [];
		addHooks(setup.registry, GenerationTask, {
			beforeProviderHeaders: ({ headers, model }) => {
				received.push({ headers: { ...headers }, model: model.id });
				return { headers: { ...headers, "x-added": "1", "x-removed": null } };
			},
		});
		setup.settings.stream = { headers: { "x-removed": "gone", "x-kept": "kept" } };
		const sent: unknown[] = [];
		const { harness } = await runOnce(setup, [
			adapter(async (options) => {
				sent.push(options.headers);
			}),
		]);
		expect(received).toEqual([{ headers: { "x-removed": "gone", "x-kept": "kept" }, model: "faux-1" }]);
		expect(sent).toEqual([{ "x-removed": null, "x-kept": "kept", "x-added": "1" }]);
		await harness.close(context);
	});

	it("shows status, headers, and model to afterProviderResponse observers", async () => {
		const setup = chatSetup();
		const observed: unknown[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterProviderResponse: ({ status, headers, model }) =>
				void observed.push({ status, headers, model: model.id }),
		});
		addHooks(setup.registry, GenerationTask, {
			afterProviderResponse: () => {
				throw new Error("observer failed");
			},
		});
		const { status, harness } = await runOnce(setup, [adapter(async () => {})]);
		expect(status).toBe("done");
		// The faux adapter reports a 200 with no headers before it answers.
		expect(observed).toEqual([{ status: 200, headers: {}, model: "faux-1" }]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("observer failed");
		await harness.close(context);
	});

	it("delivers provider frames to every observer in order and reports a throw", async () => {
		const setup = chatSetup();
		const order: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			onProviderStreamEvent: async ({ data }) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`a:${String(data)}`);
			},
		});
		addHooks(setup.registry, GenerationTask, {
			onProviderStreamEvent: ({ data }) => {
				order.push(`b:${String(data)}`);
				if (data === 1) throw new Error("frame observer failed");
			},
		});
		const { status, harness } = await runOnce(setup, [
			adapter(async (options, model) => {
				for (const frame of [1, 2]) await options.onProviderStreamEvent!(frame, model);
			}),
		]);
		expect(status).toBe("done");
		// Frame 2 starts only after both observers finished frame 1.
		expect(order).toEqual(["a:1", "b:1", "a:2", "b:2"]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("frame observer failed");
		await harness.close(context);
	});

	it("rebuilds every callback for each request of a run", async () => {
		const setup = chatSetup();
		let payloads = 0;
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: () => {
				payloads++;
				return undefined;
			},
		});
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "again" } : undefined) });
		const step = adapter(async (options, model) => {
			await options.onPayload!({}, model);
		});
		const { status, harness } = await runOnce(setup, [step, step]);
		expect(status).toBe("done");
		expect(payloads).toBe(2);
		await harness.close(context);
	});

	it("stops waiting for a hook that never returns when the run is aborted", async () => {
		const setup = chatSetup();
		let reachHook!: () => void;
		const hookReached = new Promise<void>((resolve) => {
			reachHook = resolve;
		});
		addHooks(setup.registry, GenerationTask, {
			beforeProviderRequest: () => {
				reachHook();
				return new Promise<never>(() => {});
			},
		});
		setup.faux.setResponses([
			adapter(async (options, model) => {
				await options.onPayload!({}, model);
			}),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await hookReached;
		const live = await harness.snapshot(LiveDoc, root.id, context);
		await harness.abortTask(live!.run!.taskId, context);
		const settled = await submission.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
		await harness.close(context);
	});
});
