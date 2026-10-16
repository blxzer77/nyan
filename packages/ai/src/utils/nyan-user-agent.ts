import type * as NodeOs from "node:os";
import { isNodeLikeRuntime } from "./runtime.ts";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (!isNodeLikeRuntime()) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();

export function getNyanUserAgent(): string {
	return nodeOs ? `nyan (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "nyan (browser)";
}
