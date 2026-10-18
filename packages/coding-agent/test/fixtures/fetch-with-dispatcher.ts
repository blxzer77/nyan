// Child process for http-parity.test.ts: configure the HTTP client as nyan does, fetch one URL, print one JSON line.
// It runs under the runtime that runs the test, with the environment the test gives it.
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";

configureHttpDispatcher(30_000);

const url = process.argv[2];
if (!url) throw new Error("usage: fetch-with-dispatcher.ts <url>");

let line: string;
try {
	const response = await fetch(url);
	line = JSON.stringify({ ok: true, status: response.status, body: await response.text() });
} catch (error) {
	const failure = error as { code?: unknown; message?: unknown; cause?: { code?: unknown } };
	line = JSON.stringify({
		ok: false,
		code: failure.code ?? failure.cause?.code ?? null,
		message: String(failure.message),
	});
}
// Exit as soon as the line is written: undici keeps its sockets open for a few seconds.
process.stdout.write(`${line}\n`, () => process.exit(0));
