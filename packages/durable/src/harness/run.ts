import type { Draft } from "@ny4n/chord";
import type { ConversationId, SubmissionId, TaskId, TaskReference, Tx } from "../types.ts";
import type { GenerationCheckpoint, GenerationInput, GenerationResult } from "./generation.ts";
import type { LiveState } from "./live.ts";

/**
 * Identity and first checkpoint of the built-in generation task. Run control lives here, below the generation, so
 * admission and live-state code can start a run without importing the generation that owns the run's behavior; the
 * generation takes its `name`, `version` and `initial` from this reference.
 */
export const generationTaskReference: TaskReference<GenerationInput, GenerationCheckpoint, GenerationResult> = {
	definition: {
		name: "nyan.generation",
		version: 1,
		initial: () => ({ phase: "prepare", attempt: 1 }),
	},
};

/** Start a run for `inputs`, placed input submissions: a new generation takes `nyan.live.run`. */
export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	inputs: SubmissionId[],
): Promise<void> {
	live.run = { taskId: await createGeneration(tx, conversationId), inputs };
}

/** A generation owned by its conversation. */
export function createGeneration(tx: Tx, conversationId: ConversationId): Promise<TaskId<GenerationResult>> {
	return tx.createTask(generationTaskReference, {}, { ownership: { kind: "conversation" }, conversationId });
}

/** Hand run control from `from` to `to`; the run's inputs move with it. */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
