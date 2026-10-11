import { type Context, defineFacet, type Facet } from "@nyan/chord";
import type { Conversation } from "@nyan/durable";
import { Transcript } from "./transcript.ts";

/** Serve the conversation's durable view state. The facet owns and disposes the attached state. */
export async function createTranscriptServiceFacet(conversation: Conversation, context: Context): Promise<Facet> {
	const state = await conversation.viewState(context);
	return defineFacet({
		id: "@nyan/transcript",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Transcript, { state });
		},
	});
}
