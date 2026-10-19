import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@ny4n/ai";
import { estimateMessageTokens } from "@ny4n/ai/utils/estimate";
import type { Context } from "@ny4n/chord";
import {
	CompactionEntry,
	type Conversation,
	type ConversationId,
	type ConversationOwnership,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	type InboxState,
	UserEntry,
	type UserInput,
} from "@ny4n/durable";
import { APP_NAME } from "../../config.ts";
import { exportFromFile } from "../export-html/index.ts";
import type { SessionTreeNode } from "../session-manager.ts";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionEntry, type SessionHeader } from "../session-manager.ts";

/** The texts that were waiting for a boundary, as legacy `clear_queue` returns them. */
export interface ClearedQueue {
	readonly steering: string[];
	readonly followUp: string[];
}

/** Session-wide entries in append order, with the id of the newest entry in the session. */
export interface SessionEntries {
	readonly entries: SessionEntry[];
	readonly leafId: string | null;
}

/** A user message a client can fork from, as legacy `get_fork_messages` lists them. */
export interface ForkMessage {
	readonly entryId: string;
	readonly text: string;
}

/** The active entry chain of a session, as a linear tree with the newest entry's id. */
export interface SessionTree {
	readonly tree: SessionTreeNode[];
	readonly leafId: string | null;
}

/** A conversation the fork created; the caller moves the controller to it. */
export interface ForkedConversation {
	readonly conversationId: ConversationId;
	/** The text of the message the fork starts at, empty when it carries none. */
	readonly text: string;
}

/**
 * The product operations that RPC exposes over a durable session. Durable keeps a flat entry list with head markers, so
 * these answer in the legacy session shapes: `get_entries` walks the session in append order, the way a JSONL session
 * file does, and an entry id is its durable id as a decimal string.
 */
export interface DurableSessionOps {
	/** Withdraw every queued input of the current conversation and return the texts that were waiting. */
	clearQueue(): Promise<ClearedQueue>;
	/** Entries in append order, or only those after `since` (a decimal durable entry id). */
	entries(since: string | undefined): Promise<SessionEntries>;
	/** The display name written with `setSessionName`, if any. */
	getSessionName(): Promise<string | undefined>;
	/** Store the display name beside the session database; an empty name clears it. */
	setSessionName(name: string): Promise<string | undefined>;
	/** Write the session's HTML export and return its path. */
	exportHtml(outputPath: string | undefined): Promise<string>;
	/** Fork the current conversation at a user message; the caller moves the controller to the new conversation. */
	fork(at: string): Promise<ForkedConversation>;
	/** Fork the current conversation at its newest entry. */
	clone(): Promise<ForkedConversation>;
	/** The user messages a client can fork from, in append order. */
	forkMessages(): Promise<readonly ForkMessage[]>;
	/** The active entry chain of the current conversation as a linear tree. */
	tree(): Promise<SessionTree>;
}

/** What the operations need from an open durable session. */
export interface DurableSessionOpsHost {
	readonly harness: Harness;
	/** The conversation the controller talks to; a fork or a conversation switch replaces it. */
	readonly conversation: () => Conversation;
	/** The open session: its directory holds the database and the display-name metadata. */
	readonly session: () => { readonly id: string; readonly directory: string; readonly cwd: string };
	readonly context: Context;
}

/** The display name of a session, stored beside its database rather than inside the conversation. */
const METADATA_FILE = "session.json";

/** A forked conversation belongs to the host, like the root conversation: no task owns it. */
const OWNERLESS: ConversationOwnership = { kind: "ownerless" };

const PAGE_SIZE = 256;

/** A session directory is named `<epoch milliseconds>-<uuid>`; its creation time dates entries that carry none. */
function createdAt(directory: string): string {
	const match = /^(\d{13})-/u.exec(basename(directory));
	return new Date(match === null ? Date.now() : Number(match[1])).toISOString();
}

/** A durable entry id as it appears in a legacy session entry. */
function entryId(id: number): string {
	return String(id);
}

/** The entry id of a `since` cursor, or undefined when the client sent something that is not a durable id. */
function parseEntryId(value: string): EntryId | undefined {
	if (!/^\d+$/u.test(value)) return undefined;
	const id = Number(value);
	// Entry ids are dense numbers; the brand is erased at run time.
	return Number.isSafeInteger(id) ? (id as EntryId) : undefined;
}

/** The text of user input, without images: a client restores what it queued as text. */
function inputText(content: UserInput): string {
	return typeof content === "string"
		? content
		: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function textOf(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/**
 * Whether a durable entry has a legacy session entry shape: a message, or a compaction summary. A positional prompt
 * (`nyan.system`) and a bookkeeping write have none.
 */
function isLegacyEntry(record: EntryRecord): boolean {
	if (CompactionEntry.is(record)) return true;
	const message = record.model?.[0];
	return message !== undefined && message.role !== "system";
}

/**
 * The tokens the context held before a compaction. Durable records the summary, not the provider's count, so this is
 * the same estimate the durable compaction threshold uses, taken from the context as of the entry before the summary.
 */
async function tokensBefore(
	conversation: Conversation,
	context: Context,
	previous: EntryRecord | undefined,
): Promise<number> {
	if (previous === undefined) return 0;
	try {
		const view = await conversation.context(context, { at: previous.id });
		return view.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
	} catch {
		// A context that cannot be rebuilt at that entry still exports; only the divider's size is unknown.
		return 0;
	}
}

/**
 * Durable entries in the legacy entry shape, in append order and chained by `parentId`. Legacy has no entry for a
 * positional prompt or a bookkeeping write, so those are skipped and the chain continues from the last one emitted.
 */
async function toSessionEntries(
	conversation: Conversation,
	context: Context,
	records: readonly EntryRecord[],
	fallbackTimestamp: string,
): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		const message = record.model?.[0];
		const id = entryId(record.id);
		const timestamp = new Date(message?.timestamp ?? Date.parse(fallbackTimestamp)).toISOString();
		if (CompactionEntry.is(record)) {
			entries.push({
				type: "compaction",
				id,
				parentId,
				timestamp,
				summary: message === undefined ? "" : textOf(message),
				// `nyan.compaction` always carries `head`; without one the summary begins its own range.
				firstKeptEntryId: record.head === undefined ? id : entryId(record.head),
				tokensBefore: await tokensBefore(conversation, context, records[index - 1]),
			});
			parentId = id;
			continue;
		}
		// `nyan.system` carries the positional prompt and tool loadout as a system message, and a plain `nyan.reset`
		// carries no message; neither has a legacy entry shape.
		if (!isLegacyEntry(record) || message === undefined) continue;
		entries.push({ type: "message", id, parentId, timestamp, message });
		parentId = id;
	}
	return entries;
}

async function allEntries(
	conversation: Conversation,
	context: Context,
	minEntryId: EntryId | undefined,
): Promise<EntryRecord[]> {
	const records: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries(
			{ order: "ascending", ...(minEntryId === undefined ? {} : { minEntryId }) },
			PAGE_SIZE,
			cursor,
			context,
		);
		records.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return records;
}

/** The one entry with `id`, when it is visible from the conversation's history. */
async function visibleEntry(
	conversation: Conversation,
	context: Context,
	id: EntryId,
): Promise<EntryRecord | undefined> {
	const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context);
	return page.items[0];
}

/** The id of the newest entry a client sees, which is the leaf position of the session as `get_entries` reports it. */
async function leafId(conversation: Conversation, context: Context): Promise<string | null> {
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "descending" }, PAGE_SIZE, cursor, context);
		const newest = page.items.find(isLegacyEntry);
		if (newest !== undefined) return entryId(newest.id);
		cursor = page.next;
	} while (cursor !== undefined);
	return null;
}

/** Read the display name, tolerating a missing or unreadable metadata file. */
async function readName(directory: string): Promise<string | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(directory, METADATA_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return undefined;
		const name = (parsed as { name?: unknown }).name;
		return typeof name === "string" ? name.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The session header of the export file. A durable session has one conversation tree per session directory, so the
 * export names the session directory and its creation time.
 */
function headerOf(session: { readonly id: string; readonly directory: string; readonly cwd: string }): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: session.id,
		timestamp: createdAt(session.directory),
		cwd: session.cwd,
	};
}

/**
 * Product operations over one open durable session. The RPC adapter creates them once per open; every call reads the
 * conversation the host reports, so a conversation switch is visible without rebuilding them.
 */
export function createDurableSessionOps(host: DurableSessionOpsHost): DurableSessionOps {
	const nameFile = (): string => join(host.session().directory, METADATA_FILE);
	return {
		async clearQueue() {
			const conversation = host.conversation();
			const inbox = (await host.harness.snapshot(InboxDoc, conversation.id, host.context)) as InboxState | undefined;
			const steering: string[] = [];
			const followUp: string[] = [];
			for (const item of inbox?.items ?? []) {
				// A queued write is no user text, and legacy's queue holds inputs only.
				if (item.mode === "write") continue;
				// Only an input this call withdrew is reported: one a boundary placed meanwhile is already in the session.
				const withdrawn = await host.harness.abortSubmission(item.id, host.context, conversation.id);
				if (withdrawn !== "aborted") continue;
				(item.mode === "steer" ? steering : followUp).push(inputText(item.content));
			}
			return { steering, followUp };
		},
		async entries(since) {
			const conversation = host.conversation();
			const session = host.session();
			const sinceId = since === undefined ? undefined : parseEntryId(since);
			if (since !== undefined && sinceId === undefined) throw new Error(`Entry not found: ${since}`);
			if (sinceId !== undefined) {
				const known = await conversation.entries(
					{ minEntryId: sinceId, maxEntryId: sinceId },
					1,
					undefined,
					host.context,
				);
				if (known.items.length === 0) throw new Error(`Entry not found: ${since}`);
			}
			const records = await allEntries(
				conversation,
				host.context,
				sinceId === undefined ? undefined : ((sinceId + 1) as EntryId),
			);
			const entries = await toSessionEntries(conversation, host.context, records, createdAt(session.directory));
			// The leaf is the newest entry of the session, not of the page a `since` cursor returned.
			return { entries, leafId: await leafId(conversation, host.context) };
		},
		getSessionName: () => readName(host.session().directory),
		async setSessionName(name) {
			// The same name rule as legacy: line breaks become spaces, and an empty name clears the title.
			const cleaned = name.replace(/[\r\n]+/gu, " ").trim();
			await writeFile(nameFile(), `${JSON.stringify(cleaned.length === 0 ? {} : { name: cleaned })}\n`, "utf8");
			return cleaned.length === 0 ? undefined : cleaned;
		},
		async exportHtml(outputPath) {
			const conversation = host.conversation();
			const session = host.session();
			const records = await allEntries(conversation, host.context, undefined);
			const entries: FileEntry[] = [
				headerOf(session),
				...(await toSessionEntries(conversation, host.context, records, createdAt(session.directory))),
			];
			// The exporter reads a session file, and a durable session has none: write the mapped session to a temporary
			// JSONL file named after the session, so an unset `outputPath` produces the legacy file name as well.
			const directory = await mkdtemp(join(tmpdir(), `${APP_NAME}-export-`));
			try {
				const file = join(directory, `${session.id}.jsonl`);
				await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
				return await exportFromFile(file, outputPath === undefined ? {} : { outputPath });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		async fork(at) {
			const conversation = host.conversation();
			const id = parseEntryId(at);
			const entry = id === undefined ? undefined : await visibleEntry(conversation, host.context, id);
			const message = entry?.model?.[0];
			if (id === undefined || entry === undefined) throw new Error(`Entry not found: ${at}`);
			// Legacy forks from a user message only, which is what `get_fork_messages` offers.
			if (!UserEntry.is(entry) || message === undefined) {
				throw new Error(`Cannot fork from an entry that is not a user message: ${at}`);
			}
			const forked = await conversation.fork(id, { ownership: OWNERLESS }, host.context);
			return { conversationId: forked.id, text: textOf(message) };
		},
		async clone() {
			const conversation = host.conversation();
			const newest = (await conversation.entries({}, 1, undefined, host.context)).items[0];
			if (newest === undefined) throw new Error("Cannot clone session: no current entry selected");
			const forked = await conversation.fork(newest.id, { ownership: OWNERLESS }, host.context);
			return { conversationId: forked.id, text: "" };
		},
		async forkMessages() {
			const conversation = host.conversation();
			const messages: ForkMessage[] = [];
			for (const record of await allEntries(conversation, host.context, undefined)) {
				const message = record.model?.[0];
				if (!UserEntry.is(record) || message === undefined) continue;
				const text = textOf(message);
				if (text.length > 0) messages.push({ entryId: entryId(record.id), text });
			}
			return messages;
		},
		async tree() {
			const conversation = host.conversation();
			// The active range only: durable has no parent tree, so the tree is this chain (Decision #24).
			const active = await conversation.context(host.context);
			const entries = await toSessionEntries(
				conversation,
				host.context,
				active.entries,
				createdAt(host.session().directory),
			);
			const tree: SessionTreeNode[] = [];
			let nodes = tree;
			for (const entry of entries) {
				const node: SessionTreeNode = { entry, children: [] };
				nodes.push(node);
				nodes = node.children;
			}
			return { tree, leafId: entries.length === 0 ? null : entries[entries.length - 1]!.id };
		},
	};
}
