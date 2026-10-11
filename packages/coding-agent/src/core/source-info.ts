import type { SourceInfo } from "../utils/source-info.ts";
import type { PathMetadata } from "./package-manager.ts";

// The data types and synthetic-path helpers live in utils so presentation code can describe where a resource came
// from without depending on the package manager. Resolving a source from package metadata stays in core.
export * from "../utils/source-info.ts";

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}
