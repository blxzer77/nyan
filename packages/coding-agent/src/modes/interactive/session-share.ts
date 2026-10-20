import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@ny4n/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { checkGistAuth, createGist } from "../../core/session-share.ts";
import { theme } from "../../ui/theme/theme.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

/** Trailing `nyan.share` entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "nyan.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for the session viewer. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

/** Share the current session as a private gist. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nyan-share-"));
	const jsonlFile = path.join(tempDir, "session.jsonl");
	const htmlFile = path.join(tempDir, "session.html");

	try {
		try {
			exportSessionForShare(jsonlFile, context.session);
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		try {
			const auth = checkGistAuth();
			if (!auth.ready) {
				context.showError(auth.message);
				return;
			}
		} catch {
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		try {
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		await shareViaGist(htmlFile, context);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	loader.onAbort = () => {
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const gist = await createGist(tmpFile, { signal: loader.signal });
		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		context.showStatus(
			gist.previewUrl === undefined
				? `Gist: ${hyperlink(gist.gistUrl, gist.gistUrl)}`
				: `Share URL: ${hyperlink(gist.previewUrl, gist.previewUrl)}\nGist: ${hyperlink(gist.gistUrl, gist.gistUrl)}`,
		);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(error instanceof Error ? error.message : "Unknown error");
		}
	}
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}
