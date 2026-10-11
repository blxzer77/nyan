import { type Context, defineFacet, type Facet } from "@ny4n/chord";
import type { Conversation } from "@ny4n/durable";
import { Transcript } from "./transcript.ts";

/** Serve the conversation's durable view state. The facet owns and disposes the attached state. */
export async function createTranscriptServiceFacet(conversation: Conversation, context: Context): Promise<Facet> {
	const state = await conversation.viewState(context);
	return defineFacet({
		id: "@ny4n/transcript",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Transcript, { state });
		},
	});
}
