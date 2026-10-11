/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   nyan -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@nyan/coding-agent";
import { createBashTool } from "@nyan/coding-agent";

export default function (nyan: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, NYAN_SPAWN_HOOK: "1" },
		}),
	});

	nyan.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
