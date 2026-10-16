import type { AssistantMessage } from "@ny4n/ai/contracts";
import { copyJson, type Draft } from "@ny4n/chord";
import { AssistantEntry } from "../entries.ts";
import type { ConversationId, Tx, TypedEntry } from "../types.ts";
import type { LiveState } from "./live.ts";
import { recordProviderUsage } from "./usage.ts";

/**
 * Append a committed partial left by an interrupted, aborted, faulted, or orphaned attempt as an aborted assistant
 * entry; the caller replaces or removes `generation`.
 */
export async function convertPartial(tx: Tx, live: Draft<LiveState>, conversationId: ConversationId): Promise<void> {
	const partial = live.generation?.message;
	if (partial === undefined) return;
	const message = copyJson(partial) as unknown as AssistantMessage;
	await appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" });
}

/**
 * Append a provider result and add its usage to `nyan.usage` in the same commit.
 * REMINDER: every built-in writer of assistant entries goes through here, so the usage ledger stays complete.
 */
export async function appendAssistant(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	await recordProviderUsage(tx, conversationId, `${message.provider}/${message.model}`, message.usage);
	return tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
}
