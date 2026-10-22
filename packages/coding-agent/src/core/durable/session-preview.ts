import { join } from "node:path";
import { openRuntimeSqliteDatabase } from "@ny4n/durable/storage/sqlite/node";

/** What a session's own transcript says about it, so a picker can show more than a directory name. */
export interface DurableSessionPreview {
	/** The text of its first user message, on one line. */
	readonly firstMessage: string;
	/** The entries a list counts as messages: user, assistant, and tool results, as the legacy list counts them. */
	readonly messageCount: number;
	/** The time of its newest message, when it has one. */
	readonly lastActivity?: Date;
}

/**
 * The entry kinds that carry a message a person reads. The others are durable's own bookkeeping: a positional prompt
 * (`nyan.system`), a compaction summary's head marker, and reset or inbox writes.
 */
const MESSAGE_KINDS = "'nyan.user', 'nyan.assistant', 'nyan.tool-result'";

/** The text of a stored model message, whether its content is a string or blocks. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (typeof block !== "object" || block === null) return [];
			const text = (block as { type?: unknown; text?: unknown }).text;
			return (block as { type?: unknown }).type === "text" && typeof text === "string" ? [text] : [];
		})
		.join(" ");
}

/** One line of a preview: no line breaks or control characters, collapsed whitespace. */
function oneLine(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

/** How much of a session's own text a picker shows before it truncates. */
const LABEL_CHARS = 100;

/**
 * The label a session picker shows for a session: its display name, else the first thing that was asked in it, else a
 * note that it holds no messages. `--name` and `/name` are the only writers of a name, so a session that never got one
 * is recognized by its own text rather than by its directory id.
 */
export function sessionLabelOf(session: { readonly name?: string; readonly preview?: DurableSessionPreview }): string {
	if (session.name !== undefined) return session.name;
	const first = session.preview === undefined ? "" : oneLine(session.preview.firstMessage);
	if (first.length === 0) return "(no messages)";
	return first.length <= LABEL_CHARS ? first : `${first.slice(0, LABEL_CHARS - 1)}…`;
}

/** What a picker says about a session beside its label: how much it holds and when it was last used. */
export function sessionDetailOf(session: { readonly created: Date; readonly preview?: DurableSessionPreview }): string {
	const messages = session.preview?.messageCount;
	const last = session.preview?.lastActivity;
	return [
		`created ${session.created.toLocaleString()}`,
		...(messages === undefined ? [] : [`${messages} ${messages === 1 ? "message" : "messages"}`]),
		...(last === undefined ? [] : [`last ${last.toLocaleString()}`]),
	].join(" · ");
}

/**
 * Read a session's first user message, its message count, and when it was last active, from its own database.
 *
 * The database is opened read-only, so this never writes, creates, or migrates the session it describes: the picker
 * reads sessions the running process does not own, including one another process has open. Every failure answers
 * `undefined`, because a list that cannot read one session still lists the others; the caller then shows what the
 * directory alone says, which is the name and the creation time.
 *
 * This queries durable's own `entries` table, which is that package's storage format. A change to it degrades this
 * preview to `undefined` rather than reporting a wrong session, and the durable suite owns the schema itself.
 */
export async function readSessionPreview(directory: string): Promise<DurableSessionPreview | undefined> {
	let database: Awaited<ReturnType<typeof openRuntimeSqliteDatabase>> | undefined;
	try {
		database = await openRuntimeSqliteDatabase(join(directory, "session.sqlite"), { readOnly: true });
		const first = await database.get<{ record: string }>(
			`SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'nyan.user' ORDER BY id ASC LIMIT 1`,
		);
		const counted = await database.get<{ count: number }>(
			`SELECT count(*) AS count FROM entries WHERE json_extract(record, '$.kind') IN (${MESSAGE_KINDS})`,
		);
		const newest = await database.get<{ at: number | null }>(
			`SELECT max(json_extract(record, '$.model[0].timestamp')) AS at FROM entries`,
		);
		const message = first === undefined ? undefined : (JSON.parse(first.record) as { model?: unknown }).model;
		const content = Array.isArray(message) ? (message[0] as { content?: unknown } | undefined)?.content : undefined;
		const at = typeof newest?.at === "number" ? new Date(newest.at) : undefined;
		return {
			firstMessage: oneLine(messageText(content)),
			messageCount: counted?.count ?? 0,
			...(at === undefined || Number.isNaN(at.getTime()) ? {} : { lastActivity: at }),
		};
	} catch {
		// An unreadable database, a session a crashed process left mid-write, and a schema this reader does not know all
		// leave the session listed without a preview.
		return undefined;
	} finally {
		await database?.close().catch(() => {});
	}
}
