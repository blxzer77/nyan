import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("ModelRuntime refresh errors", () => {
	let dir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("keeps a provider's refresh error when the availability refresh that follows also fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "nyan-refresh-errors-"));
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath: join(dir, "models.json"),
		});
		modelRuntime.registerProvider("flaky", {
			name: "Flaky",
			refreshModels: async () => {
				throw new Error("catalog refresh failed");
			},
		});
		// The availability refresh that runs after the provider's refresh fails too.
		vi.spyOn(
			modelRuntime as unknown as { refreshProviderAvailability: () => Promise<void> },
			"refreshProviderAvailability",
		).mockRejectedValue(new Error("availability failed"));

		const result = await modelRuntime.refresh({
			providers: ["flaky"],
			allowNetwork: true,
			force: true,
			verifyCredential: true,
		});

		expect(result.errors.get("flaky")?.message).toBe("catalog refresh failed");
	});
});
