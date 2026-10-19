import type { SettledSubmissionRecord } from "@ny4n/durable";
import type { SubmitOutcome } from "../src/core/durable/runtime.ts";

/**
 * The settlement of a submission the test expects to start. A submission answers `handled` instead when an `input`
 * handler took the text; a test that wants that case reads the outcome itself.
 */
export async function settlement(submission: Promise<SubmitOutcome>): Promise<SettledSubmissionRecord> {
	const outcome = await submission;
	if (outcome.handled) throw new Error("The input was handled by an extension");
	return outcome.settled;
}
