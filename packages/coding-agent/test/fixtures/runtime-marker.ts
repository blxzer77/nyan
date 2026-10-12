/**
 * Set or hide the marker that code uses to tell Bun from Node (`process.versions.bun`), and return a function that puts
 * the original back. Install detection and similar code reads the marker when it runs, so a test can exercise the Node
 * branch under Bun and the Bun branch under Node. Hold the change only as long as the test needs it.
 */
export function setBunRuntimeMarker(version: string | undefined): () => void {
	const original = Object.getOwnPropertyDescriptor(process.versions, "bun");
	Object.defineProperty(process.versions, "bun", {
		value: version,
		configurable: true,
		writable: true,
		enumerable: true,
	});
	return () => {
		if (original) Object.defineProperty(process.versions, "bun", original);
		else delete (process.versions as Record<string, unknown>).bun;
	};
}
