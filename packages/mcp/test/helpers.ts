import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type HttpHandler = (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void>;

const servers: Server[] = [];

export async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

/** Starts a loopback HTTP server and returns its origin. Call `closeServers` from `afterEach`. */
export async function listen(handler: HttpHandler): Promise<string> {
	let origin = "";
	const server = createServer((request, response) => {
		void handler(request, response, origin).catch((error) => {
			response.statusCode = 500;
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP test server did not bind to TCP");
	origin = `http://127.0.0.1:${address.port}`;
	servers.push(server);
	return origin;
}

export async function closeServers(): Promise<void> {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					// Bun's node:http can have stopped the server already by now and then reports "Server is not running"
					// to the close callback. Node does not. Either way the server is down, which is all this helper needs.
					server.close((error) => {
						const notRunning =
							(error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING" ||
							/not running/i.test(error?.message ?? "");
						if (error && !notRunning) reject(error);
						else resolve();
					});
				}),
		),
	);
}
