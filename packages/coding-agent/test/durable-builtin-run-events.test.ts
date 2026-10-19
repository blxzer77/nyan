import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type { InlineExtension, ProjectTrustContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";
import { settlement } from "./durable-submission.ts";
import { createTestUiContext } from "./suite/harness.ts";

const holdParams = Type.Object({});

/**
 * The two built-in extensions that read a run's start events: `herdr` reports `working` on `agent_start`, and `mcp`
 * reconnects servers that were signed in to from outside the session on `turn_start`. Both are driven through the real
 * durable path here: a fake Herdr binary records the reports it is given, and a loopback HTTP endpoint plays the MCP
 * server that asks for a sign-in.
 */

const headless: Omit<ProjectTrustContext, "cwd"> = {
	mode: "print",
	hasUI: false,
	ui: {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
	},
};

interface McpEndpoint {
	readonly url: string;
	readonly authorizations: (string | undefined)[];
	close(): Promise<void>;
}

/** An MCP endpoint that refuses every request without a bearer token and records what it was sent. */
async function startMcpEndpoint(): Promise<McpEndpoint> {
	const authorizations: (string | undefined)[] = [];
	const server: Server = createServer((request, response) => {
		authorizations.push(request.headers.authorization);
		request.resume();
		response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_token" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		authorizations,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("built-in extensions and the durable run events", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-builtin-run-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-builtin-run-cwd-"));
		await mkdir(agentDir, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
		vi.unstubAllEnvs();
		await Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
	});

	test("herdr reports the run as working when the committed agent_start arrives", async () => {
		const log = join(home, "herdr.log");
		const bin = join(home, "herdr");
		await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
		await chmod(bin, 0o755);
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("HERDR_PANE_ID", "w1:p1");
		vi.stubEnv("HERDR_BIN_PATH", bin);

		// Herdr reports the latest state only, so the run has to outlive the report the session start already sent.
		const held: { release?: () => void } = {};
		const waiting = new Promise<void>((resolve) => {
			held.release = resolve;
		});
		const hold: ToolDefinition<typeof holdParams> = {
			name: "hold",
			label: "hold",
			description: "answers once the test releases it",
			parameters: holdParams,
			execute: async () => {
				await waiting;
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const faux = fauxProvider();
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("hold", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("done")]),
		]);
		const model = faux.getModel();
		const provider: InlineExtension = (pi) => {
			pi.registerProvider(faux.provider);
			pi.registerTool(hold);
		};
		session = await openDurable({
			cwd,
			// Herdr reports only in a TUI session, which is what `ctx.mode` has to say from `session_start` on.
			projectTrustContext: { ...headless, cwd, mode: "tui" },
			extensionFactories: [...builtInExtensions, provider],
			model: { provider: model.provider, modelId: model.id },
		});
		await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain("--state idle"), {
			timeout: 10_000,
		});
		const running = settlement(session.controller.submitAndWait("go", "followUp"));
		await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain("--state working"), {
			timeout: 10_000,
		});
		held.release?.();
		expect((await running).status).toBe("done");
		const reports = (await readFile(log, "utf8")).trim().split("\n");
		expect(reports[0]).toContain("pane report-agent w1:p1");
		expect(reports[0]).toContain("--source nyan");
		// The run's end reports idle again, so the report reached Herdr from the extension, not from the test.
		await vi.waitFor(
			async () => {
				const all = (await readFile(log, "utf8")).trim().split("\n");
				expect(all.filter((line) => line.includes("--state idle")).length).toBeGreaterThan(1);
			},
			{ timeout: 10_000 },
		);
	});

	test("mcp reconnects a server signed in to from outside the session when turn_start arrives", async () => {
		const endpoint = await startMcpEndpoint();
		try {
			await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { remote: { url: endpoint.url } } }));
			const faux = fauxProvider();
			faux.setResponses([() => fauxAssistantMessage([fauxText("done")])]);
			const model = faux.getModel();
			const provider: InlineExtension = (pi) => {
				pi.registerProvider(faux.provider);
			};
			session = await openDurable({
				cwd,
				projectTrustContext: { ...headless, cwd },
				extensionFactories: [...builtInExtensions, provider],
				model: { provider: model.provider, modelId: model.id },
			});
			const notices: string[] = [];
			session.extensionHost.runner.setUIContext(
				createTestUiContext({ notify: (message) => notices.push(message) }),
				"tui",
			);
			// The startup connection is refused, so MCP reports the server as one that needs a sign-in; that state is the
			// snapshot `turn_start` compares the stored credentials with.
			await vi.waitFor(
				() => expect(notices).toContain("MCP servers need attention:\n  remote: needs sign-in\nRun /mcp to fix."),
				{ timeout: 20_000 },
			);

			const store = new McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")));
			await store.forServer("remote", endpoint.url).save({
				serverUrl: endpoint.url,
				tokens: { access_token: "outside-sign-in", token_type: "Bearer" },
				tokensExpireAt: Date.now() + 3_600_000,
			});

			expect((await settlement(session.controller.submitAndWait("go", "followUp"))).status).toBe("done");
			await vi.waitFor(() => expect(endpoint.authorizations.length).toBeGreaterThan(1), { timeout: 20_000 });
			// The reconnect used the credentials the other process stored.
			expect(endpoint.authorizations.at(-1)).toBe("Bearer outside-sign-in");
		} finally {
			await endpoint.close();
		}
	});
});
