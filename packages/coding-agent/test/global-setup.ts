import { rmSync } from "node:fs";
import { isolatedAgentDir } from "../vitest.config.ts";

/** Remove the per-run agent directory that vitest.config.ts points NYAN_CODING_AGENT_DIR at. */
export default function setup(): () => void {
	return () => {
		rmSync(isolatedAgentDir, { recursive: true, force: true });
	};
}
