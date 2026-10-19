type FetchFunction = typeof globalThis.fetch;

/** Whether the current global fetch is the original one or the one this backend installed. */
export function isOurGlobalFetch(
	current: FetchFunction,
	original: FetchFunction,
	installed: FetchFunction | undefined,
): boolean {
	return installed === undefined ? current === original : current === installed;
}
