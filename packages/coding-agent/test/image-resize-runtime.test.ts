import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBunRuntimeMarker } from "./fixtures/runtime-marker.ts";

// Every attempt to start the resize worker is recorded and then fails, so resizeImage() walks through its fallbacks.
const workerSpecifiers = vi.hoisted(() => [] as (string | URL)[]);

vi.mock("node:worker_threads", () => ({
	Worker: class FakeWorker {
		#handlers = new Map<string, (value: unknown) => void>();

		constructor(specifier: string | URL) {
			workerSpecifiers.push(specifier);
		}

		on(event: string, handler: (value: unknown) => void): this {
			this.#handlers.set(event, handler);
			return this;
		}

		once(event: string, handler: (value: unknown) => void): this {
			return this.on(event, handler);
		}

		postMessage(): void {
			queueMicrotask(() => this.#handlers.get("error")?.(new Error("worker unavailable")));
		}

		terminate(): Promise<number> {
			return Promise.resolve(0);
		}
	},
}));

const { resizeImage } = await import("../src/utils/image-resize.ts");

let restoreRuntimeMarker: (() => void) | undefined;

beforeEach(() => {
	workerSpecifiers.length = 0;
});

afterEach(() => {
	restoreRuntimeMarker?.();
	restoreRuntimeMarker = undefined;
});

// A Bun compiled executable resolves worker entrypoints by string path, so under Bun the embedded path is tried first
// and the URL is the fallback. The marker is the branch input, so each branch is checked on either runtime.
describe("resizeImage worker entrypoint", () => {
	it("tries the embedded string path before the URL when the Bun marker is set", async () => {
		restoreRuntimeMarker = setBunRuntimeMarker("1.4.2");

		await resizeImage(new Uint8Array([1, 2, 3]), "image/png");

		expect(workerSpecifiers.map((specifier) => (typeof specifier === "string" ? specifier : "url"))).toEqual([
			"./src/utils/image-resize-worker.ts",
			"url",
		]);
	});

	it("goes straight to the URL when the Bun marker is absent", async () => {
		restoreRuntimeMarker = setBunRuntimeMarker(undefined);

		await resizeImage(new Uint8Array([1, 2, 3]), "image/png");

		expect(workerSpecifiers.map((specifier) => (typeof specifier === "string" ? specifier : "url"))).toEqual(["url"]);
	});
});
