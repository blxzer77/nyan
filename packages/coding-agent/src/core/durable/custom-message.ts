import type { Message } from "@ny4n/ai";

/**
 * What the durable TUI shows for a boundary `custom_message` entry, read from the `data` the extension adapter wrote
 * (`customType`, `display`, optional `details`) and the user message it carries.
 *
 * `display: false` is a message the extension asked not to show. Legacy renders nothing for it, so this returns
 * `undefined` and the TUI shows nothing either. A visible one renders as plain text: the durable TUI has no
 * `ExtensionRunner`, so it cannot ask the extension for its message renderer (see the hooks note).
 */
export function customMessageView(entry: {
	readonly data?: unknown;
	readonly model?: readonly Message[];
}): { readonly customType: string; readonly text: string } | undefined {
	const data =
		typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
			? (entry.data as Record<string, unknown>)
			: {};
	if (data.display === false) return undefined;
	const customType = typeof data.customType === "string" ? data.customType : "custom_message";
	const message = entry.model?.[0];
	if (message === undefined) return { customType, text: "" };
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	return { customType, text };
}
