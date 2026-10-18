import { createIdleTimeoutFetch } from "./idle-timeout.ts";
import { warnIfSystemCaIgnoredByBun } from "./system-ca.ts";

type FetchFunction = typeof globalThis.fetch;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: FetchFunction | undefined;

/**
 * The idle timeout the wrapper applies, read on every request. A client built before the setting changed (an SDK client
 * keeps the fetch it was constructed with, and the interactive settings menu changes the setting while the process runs)
 * therefore follows the new value. A request already in flight keeps the timeout it started with.
 */
const idleTimeout = { ms: 0 };
let wrapper: FetchFunction | undefined;

/**
 * The Bun backend. Bun's own fetch stays the global fetch: it reads HTTP_PROXY, HTTPS_PROXY and NO_PROXY itself on every
 * request (checked on Bun 1.4, including variables set after startup), and undici's dispatcher does not apply to it. What
 * it lacks is the idle timeout, so the global fetch is wrapped by `createIdleTimeoutFetch`. Differences from the Node
 * path: a plain-HTTP origin behind a proxy is requested in forward-proxy form (`GET http://origin/...`) and not through a
 * CONNECT tunnel, and there is no dispatcher, HTTP/2 switch, or connection-attempt timeout to configure. The operating
 * system certificate store is enabled by Bun's own switches and not by `NODE_OPTIONS` (see `system-ca.ts`).
 *
 * One wrapper serves the life of the process. A timeout of 0 puts the original fetch back as the global one, and a
 * wrapper that a client still holds passes its requests through unchanged. A fetch that someone else installed after
 * startup is left alone, as on the Node path, although the timeout a held wrapper applies is still updated.
 */
export function configureNativeFetch(timeoutMs: number): void {
	warnIfSystemCaIgnoredByBun();
	idleTimeout.ms = timeoutMs;
	const current = globalThis.fetch;
	if (installedGlobalFetch === undefined ? current !== originalGlobalFetch : current !== installedGlobalFetch) return;
	wrapper ??= createIdleTimeoutFetch(originalGlobalFetch, () => idleTimeout.ms);
	const next = timeoutMs > 0 ? wrapper : originalGlobalFetch;
	globalThis.fetch = next;
	installedGlobalFetch = next;
}

/** Exported for tests: forget the wrapper and the fetch that was installed, so the next call configures from scratch. */
export function resetNativeFetchForTests(): void {
	wrapper = undefined;
	installedGlobalFetch = undefined;
	idleTimeout.ms = 0;
}
