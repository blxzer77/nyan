import { spawn, spawnSync } from "node:child_process";
import { getShareViewerUrl } from "../config.ts";

/**
 * The session-independent half of `/share`: whether `gh` can create a gist, and the upload itself. The export and the
 * dialogs belong to each TUI, so the durable TUI and the legacy one share this and nothing else.
 */

/** Whether `gh` is installed and logged in; `message` is the text `/share` reports when it is not. */
export type GistReadiness = { readonly ready: true } | { readonly ready: false; readonly message: string };

export function checkGistAuth(): GistReadiness {
	try {
		const result = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		// A missing binary is an error, not a failed login: `spawnSync` resolves the result instead of throwing.
		if (result.error !== undefined) {
			return { ready: false, message: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
		}
		if (result.status === 0) return { ready: true };
		return { ready: false, message: "GitHub CLI is not logged in. Run 'gh auth login' first." };
	} catch {
		return { ready: false, message: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
	}
}

/** The gist `/share` created, with the viewer link when one is configured. */
export interface CreatedGist {
	readonly gistUrl: string;
	/** The share viewer's link for this gist; absent when no viewer is configured. */
	readonly previewUrl?: string;
}

/**
 * Upload `filePath` as a secret gist. Every failure is thrown as the message `/share` shows, and an aborted signal kills
 * the `gh` process and throws `Share cancelled`.
 */
export async function createGist(
	filePath: string,
	options: { readonly signal?: AbortSignal } = {},
): Promise<CreatedGist> {
	const proc = spawn("gh", ["gist", "create", "--public=false", filePath]);
	const onAbort = (): void => {
		proc.kill();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	// Read through a call: an `await` does not reset TypeScript's narrowing of a direct property read.
	const aborted = (): boolean => options.signal?.aborted === true;
	try {
		if (aborted()) throw new Error("Share cancelled");
		const result = await new Promise<{
			readonly stdout: string;
			readonly stderr: string;
			readonly code: number | null;
		}>((resolve) => {
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
			proc.on("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}`, code: null }));
		});
		// A cancelled upload has no URL to report, whatever the killed process left behind.
		if (aborted()) throw new Error("Share cancelled");
		if (result.code !== 0) {
			throw new Error(`Failed to create gist: ${result.stderr.trim() || "Unknown error"}`);
		}
		const gistUrl = result.stdout.trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) throw new Error("Failed to parse gist ID from gh output");
		const previewUrl = getShareViewerUrl(gistId);
		return { gistUrl, ...(previewUrl === undefined ? {} : { previewUrl }) };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}
