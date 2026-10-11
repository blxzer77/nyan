export function getNyanUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `nyan/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
