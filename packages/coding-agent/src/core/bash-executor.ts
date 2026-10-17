/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import type { WriteStream } from "node:fs";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { createOutputFileStream } from "../utils/output-files.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileError: Error | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		({ path: tempFilePath, stream: tempFileStream } = createOutputFileStream("nyan-bash", ".log"));
		// A write error is reported when the file is closed; an unhandled 'error' event would end the process instead.
		tempFileStream.on("error", (error) => {
			tempFileError ??= error;
		});
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	/**
	 * Close the full-output file and wait until everything is on disk. The result names this path for the model and the
	 * user to read, so it must not be returned while the stream still holds unwritten output.
	 */
	const closeTempFile = async (): Promise<Error | undefined> => {
		const stream = tempFileStream;
		if (stream !== undefined) {
			await new Promise<void>((resolve) => {
				if (stream.closed) return resolve();
				// A failed write destroys the stream; settle on either event, so the captured error is reported rather than awaited.
				stream.once("error", () => resolve());
				stream.once("close", () => resolve());
				stream.end();
			});
		}
		return tempFileError === undefined
			? undefined
			: new Error(`Could not write the full output to ${tempFilePath}: ${tempFileError.message}`, {
					cause: tempFileError,
				});
	};

	const decoder = new TextDecoder();
	// Unfinished escape sequence at the end of the previous chunk, completed by the next chunk.
	let pendingAnsi = "";

	const appendText = (rawText: string) => {
		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		if (!text) {
			return;
		}

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};

	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};

	let exitCode: number | null = null;
	try {
		({ exitCode } = await operations.exec(command, cwd, { onData, signal: options?.signal }));
	} catch (err) {
		// An aborted command still returns the output it produced so far
		if (!options?.signal?.aborted) {
			// The command's error is the one to report; a file that cannot be closed adds nothing to it.
			await closeTempFile();
			throw err;
		}
	}

	flushOutput();
	const fullOutput = outputChunks.join("");
	const truncationResult = truncateTail(fullOutput);
	if (truncationResult.truncated) {
		ensureTempFile();
	}
	const saveError = await closeTempFile();
	const cancelled = options?.signal?.aborted ?? false;
	const shown = truncationResult.truncated ? truncationResult.content : fullOutput;

	// The command ran and its output is shown; a full-output file that could not be written is said so, and has no path.
	return {
		output: saveError === undefined ? shown : `${shown}\n\n[Full output was not saved: ${saveError.message}]`,
		exitCode: cancelled ? undefined : (exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: saveError === undefined ? tempFilePath : undefined,
	};
}
