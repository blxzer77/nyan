import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// A test that builds a session or settings object without an explicit agent directory falls back to
// ~/.nyan/agent. Point that default at a directory made for this run, so a test run never writes into
// the developer's real Nyan configuration (test/global-setup.ts removes it afterwards).
export const isolatedAgentDir = join(tmpdir(), `nyan-vitest-agent-${process.pid}`);

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { NYAN_OFFLINE: "1", NYAN_CODING_AGENT_DIR: isolatedAgentDir },
			globalSetup: ["./test/global-setup.ts"],
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@ny4n\/ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@ny4n\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			],
		},
	}),
);
