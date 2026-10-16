import { getRuntimeLabel } from "../runtime.ts";

export function getNyanUserAgent(version: string): string {
	const runtime = getRuntimeLabel();
	return `nyan/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
