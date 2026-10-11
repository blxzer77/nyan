import { defineService, type ReplicatedState } from "@blxzer/nyan-chord";
import type { ConversationView } from "@blxzer/nyan-durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("pi.transcript");
