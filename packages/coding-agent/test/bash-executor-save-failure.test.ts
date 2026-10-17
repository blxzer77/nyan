import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type * as OutputFilesModule from "../src/utils/output-files.ts";

// Every full-output file is a stream whose first write fails, as a full disk does.
vi.mock("../src/utils/output-files.ts", async (importOriginal) => ({
	...(await importOriginal<typeof OutputFilesModule>()),
	createOutputFileStream: (prefix: string, extension: string) => ({
		path: `${prefix}-unwritable${extension}`,
		stream: new Writable({
			write(_chunk, _encoding, callback) {
				callback(new Error("disk is full"));
			},
		}),
	}),
}));

describe("bash executor when the full-output file cannot be written", () => {
	it("keeps the command's result, says the file was not saved, and returns no path", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				const line = Buffer.from(`${"x".repeat(99)}\n`);
				for (let i = 0; i < 20_000; i++) onData(line);
				return { exitCode: 0 };
			},
		};

		const result = await executeBashWithOperations("ignored", process.cwd(), operations);

		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeUndefined();
		expect(result.output).toContain(
			"[Full output was not saved: Could not write the full output to nyan-bash-unwritable.log: disk is full]",
		);
	});
});
