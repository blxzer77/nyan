import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@ny4n/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("ModelRuntime refresh errors", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("keeps a provider's refresh error when the availability refresh that follows also fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "nyan-refresh-errors-"));
		const base = AuthStorage.create(join(dir, "auth.json"));
		let storeFails = false;
		const credentials: CredentialStore = {
			read: (id) => (storeFails ? Promise.reject(new Error("credential store unavailable")) : base.read(id)),
			list: () => base.list(),
			modify: (id, fn) => base.modify(id, fn),
			delete: (id) => base.delete(id),
		};
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(dir, "models.json") });
		modelRuntime.registerProvider("flaky", {
			name: "Flaky",
			refreshModels: async () => {
				// The refresh fails, and the store fails from then on, so the availability refresh after it fails too.
				storeFails = true;
				throw new Error("catalog refresh failed");
			},
		});

		const result = await modelRuntime.refresh({ providers: ["flaky"], allowNetwork: true, force: true });

		expect(result.errors.get("flaky")?.message).toBe("catalog refresh failed");
	});
});
