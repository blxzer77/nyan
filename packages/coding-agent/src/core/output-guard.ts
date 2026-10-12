interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
	/** The console methods replaced on Bun; see takeOverStdout(). */
	originalConsole?: Pick<Console, StdoutConsoleMethod>;
}

type StdoutConsoleMethod = "log" | "info" | "debug" | "dir" | "table";
const STDOUT_CONSOLE_METHODS: StdoutConsoleMethod[] = ["log", "info", "debug", "dir", "table"];

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	// Node's console writes through process.stdout.write, so the replacement above already redirects it. Bun's console
	// writes to file descriptor 1 itself and would still reach stdout, which in json and rpc mode carries the protocol.
	let originalConsole: Pick<Console, StdoutConsoleMethod> | undefined;
	if (typeof process.versions.bun === "string") {
		originalConsole = {} as Pick<Console, StdoutConsoleMethod>;
		for (const method of STDOUT_CONSOLE_METHODS) {
			(originalConsole as Record<string, unknown>)[method] = console[method];
			(console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => console.error(...args);
		}
	}

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
		originalConsole,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	if (stdoutTakeoverState.originalConsole) {
		for (const method of STDOUT_CONSOLE_METHODS) {
			(console as unknown as Record<string, unknown>)[method] = stdoutTakeoverState.originalConsole[method];
		}
	}
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
