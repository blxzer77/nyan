import type { ArtifactKey, ArtifactScope } from "./types.ts";

/**
 * Why a read returned no artifact. Callers dispatch on this, never on the message:
 *
 * - `missing`: no artifact of this key in this scope, or its content or record is gone.
 * - `scope`: an artifact of this key exists, but belongs to another scope.
 * - `length`: the stored bytes are a different length than the record recorded, so they were truncated.
 * - `corrupt`: the stored bytes are the recorded length but do not hash to the key, or the record itself is unreadable.
 */
export type ArtifactFailure = "missing" | "scope" | "length" | "corrupt";

/** What was expected and what was found, for a caller that reports or logs the refusal. */
export type ArtifactFailureDetail = {
	readonly expectedLength?: number;
	readonly actualLength?: number;
	readonly expectedKey?: string;
	readonly actualKey?: string;
};

/** A read refused to return an artifact. It carries no content: `detail` counts and digests only. */
export class ArtifactError extends Error {
	readonly kind = "artifact";
	readonly reason: ArtifactFailure;
	readonly scope: ArtifactScope;
	readonly key: ArtifactKey;
	readonly detail: ArtifactFailureDetail;

	constructor(
		reason: ArtifactFailure,
		input: {
			readonly scope: ArtifactScope;
			readonly key: ArtifactKey;
			readonly detail?: ArtifactFailureDetail;
		},
	) {
		super(messageFor(reason, input));
		this.name = "ArtifactError";
		this.reason = reason;
		this.scope = input.scope;
		this.key = input.key;
		this.detail = input.detail ?? {};
	}
}

function messageFor(
	reason: ArtifactFailure,
	input: { readonly scope: ArtifactScope; readonly key: ArtifactKey; readonly detail?: ArtifactFailureDetail },
): string {
	const detail = input.detail ?? {};
	switch (reason) {
		case "missing":
			return `Artifact ${input.key} is not stored in scope ${input.scope}`;
		case "scope":
			return `Artifact ${input.key} is not stored in scope ${input.scope}; another scope holds it`;
		case "length":
			return `Artifact ${input.key} in scope ${input.scope} is ${detail.actualLength} bytes, recorded ${detail.expectedLength}`;
		case "corrupt":
			return `Artifact ${input.key} in scope ${input.scope} does not verify: found ${detail.actualKey ?? "an unreadable record"}`;
		default:
			// The reason union is closed; an unknown one means a caller bypassed the type, and a made-up message would hide it.
			throw new Error(`Unhandled artifact failure: ${String(reason)}`);
	}
}
