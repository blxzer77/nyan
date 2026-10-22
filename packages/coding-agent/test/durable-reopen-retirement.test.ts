import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, InlineExtension } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { TuiHarness } from "./durable-tui-harness.ts";

/**
 * What a durable open retires when it closes, and what it must leave behind for the open that replaces it.
 *
 * `/reload` builds a whole new services set, so the runner of the closed open is retired; `/new` and `/resume` reuse the
 * loaded extensions, so retiring one open's runner must not invalidate the runtime those extensions are shared through.
 * The MCP server is a child process, which is the connection a reload has to end rather than leak.
 */

vi.setConfig({ testTimeout: 60_000 });

const wrapper = fileURLToPath(new URL("./fixtures/mcp-stdio-probe.mjs", import.meta.url));

describe("durable open retirement", () => {
	const harness = new TuiHarness();

	beforeEach(async () => {
		await harness.start();
	});

	afterEach(async () => {
		await harness.stop();
	});

	test("/reload retires the runner of the open it replaced, and the next open has its own", async () => {
		const owner = await harness.open();
		const replaced = owner.current;
		// The open that is about to be replaced hands out contexts: it is the live one until the reload.
		expect(replaced.extensionHost.runner.createContext().cwd).toBe(harness.cwd);

		await owner.reload();

		expect(owner.current).not.toBe(replaced);
		// Nothing may act on the session that closed through the runner of the open it belonged to.
		expect(() => replaced.extensionHost.runner.createContext().cwd).toThrow(
			/stale after session replacement or reload/,
		);
		expect(owner.current.extensionHost.runner.createContext().cwd).toBe(harness.cwd);
		// One session shut down and one started: the reload, not a second live session.
		expect(harness.events).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});

	test("/new keeps the loaded extensions: a subscription they made at load still delivers", async () => {
		const delivered: string[] = [];
		const extensions: InlineExtension = (pi: ExtensionAPI) => {
			pi.events.on("probe", (value) => delivered.push(String(value)));
			pi.registerShortcut("f7", {
				description: "Emit on the bus the extensions subscribed to at load",
				handler: async () => {
					pi.events.emit("probe", "after-new");
				},
			});
		};
		const owner = await harness.open(undefined, { extraFactories: [extensions] });

		await owner.reopen({ kind: "new" });

		// The same loaded extension and the same event bus, through the runner of the open shown now: retiring the old
		// runner must not have unsubscribed what the extensions tracked when they loaded.
		const runner = owner.current.extensionHost.runner;
		const shortcuts = [...runner.getShortcuts(KeybindingsManager.create().getEffectiveConfig()).values()];
		expect(shortcuts.map((shortcut) => shortcut.shortcut)).toEqual(["f7"]);
		await shortcuts[0]?.handler(runner.createContext());
		expect(delivered).toEqual(["after-new"]);
	});

	test("/reload ends the connections of the open it replaced: its MCP server exits, and the newest one with the session", async () => {
		const pidFile = join(harness.home, "mcp-probe.pid");
		await writeFile(
			join(harness.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { probe: { command: process.execPath, args: [wrapper, pidFile], exposure: "direct" } },
			}),
		);
		const owner = await harness.open(undefined, { extraFactories: builtInExtensions });
		const replaced = await pidOf(pidFile);
		try {
			await owner.reload();
			const current = await pidOf(pidFile, replaced);

			// The reloaded open connected its own server, and the one the replaced open started is gone.
			expect(current).not.toBe(replaced);
			expect(await exited(replaced)).toBe(true);
			await owner.close();
			expect(await exited(current)).toBe(true);
		} finally {
			await owner.close().catch(() => {});
		}
	});
});

/** The pid the MCP server recorded, once it has recorded one that is not `previous`. */
async function pidOf(file: string, previous?: number): Promise<number> {
	let pid: number | undefined;
	await vi.waitFor(
		async () => {
			const text = (await readFile(file, "utf8").catch(() => "")).trim();
			pid = Number(text);
			// A server writes its pid before it serves anything; an empty file is not one yet.
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			if (previous !== undefined) expect(pid).not.toBe(previous);
		},
		{ timeout: 30_000 },
	);
	if (pid === undefined) throw new Error("the MCP server did not record a pid");
	return pid;
}

/** True once the process is gone; false when it is still running after the wait. */
async function exited(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}
