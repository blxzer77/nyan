/** What an over-budget context does next (section 8.8). */
export type Admission = "continue" | "mask" | "compact";

/** One measurement of the context a request would send, against the model's budget for it. */
export type AdmissionMeasure = {
	/** Estimated request tokens, from `estimateContext()`. */
	readonly estimated: number;
	/** Tokens the request may use: the model's window less the reserve. */
	readonly budget: number;
	/** Whether a tool result exists that masking may clear: old enough, not protected, and not empty. */
	readonly hasMaskable: boolean;
};

/**
 * The N4 admission decision (section 8.8): within budget, continue without starting a task. Over budget, mask what can
 * be masked and measure again; only a context with nothing left to mask compacts, so in practice a summary is the
 * exception rather than the first move. There is no fourth outcome: masking clears entries that stay in storage, and a
 * context that is still too large after masking is summarized.
 *
 * Both counts are token estimates the caller owns; a negative or non-finite one is a defect that would silently read as
 * "over budget", so it throws instead.
 */
export function decideAdmission(measure: AdmissionMeasure): Admission {
	const { estimated, budget } = measure;
	if (!Number.isFinite(estimated) || estimated < 0) {
		throw new RangeError(`Estimated tokens must be finite and non-negative, got ${estimated}`);
	}
	if (!Number.isFinite(budget) || budget < 0) {
		throw new RangeError(`Token budget must be finite and non-negative, got ${budget}`);
	}
	if (estimated <= budget) return "continue";
	return measure.hasMaskable ? "mask" : "compact";
}
