import { defineService, type ReplicatedState } from "@ny4n/chord";
import type { ConversationView } from "@ny4n/durable";

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
	readonly state: ReplicatedState<ConversationView>;
}

export const Transcript = defineService<Transcript>("nyan.transcript");
