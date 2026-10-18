// Starts the shared stdio MCP fixture from packages/mcp and records this process's pid in the file named by the first
// argument, so a test can check that the server process ends when its session closes.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [pidFile] = process.argv.slice(2);
if (pidFile === undefined) throw new Error("mcp-stdio-probe: expected the pid file path");
writeFileSync(pidFile, String(process.pid));

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp", "test", "fixtures", "stdio-server.mjs");
await import(pathToFileURL(fixture).href);
