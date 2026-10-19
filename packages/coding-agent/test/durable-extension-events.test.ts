import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@ny4n/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { legacyBoundaryEntriesToDurable } from "../src/core/durable/extension-adapter.ts";
import { type OpenDurableResult, openDurable } from "../src/core/durable/runtime.ts";
import type {
	ExtensionAPI,
	InlineExtension,
	ProjectTrustContext,
	SessionBoundaryDraft,
	ToolDefinition,
	TurnEndEvent,
} from "../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { settlement } from "./durable-submission.ts";

/**
 * Host events and context on the durable path: `agent_settled` after every run that ends (the quota poll and usage
 * summary wait for it), the `context` handler rewriting the request, and the two state answers extensions read.
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

describe("durable host events and context", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;
	let session: OpenDurableResult | undefined;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "nyan-events-home-"));
		agentDir = join(home, ".nyan", "agent");
		cwd = await mkdtemp(join(tmpdir(), "nyan-events-cwd-"));
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

	async function open(factories: InlineExtension[], responses: FauxResponseStep[]): Promise<OpenDurableResult> {
		const faux = fauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const provider: InlineExtension = (pi: ExtensionAPI) => {
			pi.registerProvider(faux.provider);
		};
		session = await openDurable({
			cwd,
			extensionFactories: [provider, ...factories],
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		});
		return session;
	}

	test("agent_settled fires once after a run that answered", async () => {
		const settled: boolean[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("agent_settled", (event) => {
						settled.push(event.aborted);
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("done")])],
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		expect(settled).toEqual([false]);
	});

	test("agent_settled fires for a run that ended unanswered, which the quota poll depends on", async () => {
		const settled: boolean[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("agent_settled", (event) => {
						settled.push(event.aborted);
					});
				},
			],
			[
				() => {
					throw new Error("PROVIDER-FAILURE");
				},
			],
		);
		const outcome = await settlement(current.controller.submitAndWait("go", "followUp"));
		expect(outcome.status).toBe("unanswered");
		expect(settled).toEqual([false]);
	});

	test("a context handler rewrites the request, and an unchanged result leaves it untouched", async () => {
		const seen: string[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("context", (event) => {
						// Replace the last user message's text so the provider sees the marker.
						const messages = event.messages.map((message) =>
							message.role === "user" ? { ...message, content: "REWRITTEN-BY-CONTEXT" } : message,
						);
						return { messages };
					});
				},
			],
			[
				(context) => {
					seen.push(JSON.stringify(context.messages));
					return fauxAssistantMessage([fauxText("done")]);
				},
			],
		);
		expect((await settlement(current.controller.submitAndWait("go", "followUp"))).status).toBe("done");
		expect(seen[0]).toContain("REWRITTEN-BY-CONTEXT");
		expect(seen[0]).not.toContain('"content":"go"');
	});

	test("accepted boundary proposals commit custom entries and a hidden reminder, then continue once", async () => {
		const turns: number[] = [];
		const current = await open(
			[
				(pi) => {
					pi.on("turn_end", (event) => {
						turns.push(event.turnIndex);
						if (turns.length !== 1) return;
						return {
							entries: [
								{ type: "custom", customType: "probe.boundary", data: { accepted: true } },
								{
									type: "custom_message",
									customType: "probe.reminder",
									content: "remember",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("first")]), () => fauxAssistantMessage([fauxText("second")])],
		);
		const outcome = await settlement(current.controller.submitAndWait("go", "followUp"));
		expect(outcome.status).toBe("done");
		expect(turns).toEqual([0, 1]);
		expect(current.view.current().conversation.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "probe.boundary", data: { accepted: true } }),
				expect.objectContaining({
					kind: "custom_message",
					data: { customType: "probe.reminder", display: false },
				}),
			]),
		);
	});

	test.each(["omit", "replace"] as const)(
		"accepts a context edit with action %s for a custom message and changes the next request",
		async (action) => {
			const requests: string[] = [];
			const current = await open(
				[
					(pi) => {
						pi.on("turn_end", (event) => {
							if (event.turnIndex === 0) {
								return {
									entries: [
										{
											type: "custom_message",
											customType: "probe.context",
											content: "ORIGINAL-CONTEXT-MARKER",
											display: false,
										},
									],
									continue: true,
								};
							}
							if (event.turnIndex !== 1) return;
							const custom = event.context.contextEntries.find(
								(entry) =>
									entry.sourceEntry.type === "message" &&
									entry.sourceEntry.message.role === "user" &&
									JSON.stringify(entry.sourceEntry.message.content).includes("ORIGINAL-CONTEXT-MARKER"),
							);
							if (custom === undefined) throw new Error("custom context entry was not projected");
							const replacement = action === "omit" ? null : { content: "REPLACED-CONTEXT-MARKER" };
							// `continue` needs a user message in the same draft list, or durable drops it with a report.
							return {
								entries: [
									{ type: "context_edit", targetId: String(custom.sourceEntry.id), replacement },
									{
										type: "custom_message",
										customType: "probe.next",
										content: "NEXT-REQUEST",
										display: false,
									},
								],
								continue: true,
							};
						});
					},
				],
				[
					(context) => {
						requests.push(JSON.stringify(context.messages));
						return fauxAssistantMessage([fauxText("first")]);
					},
					(context) => {
						requests.push(JSON.stringify(context.messages));
						return fauxAssistantMessage([fauxText("second")]);
					},
					(context) => {
						requests.push(JSON.stringify(context.messages));
						return fauxAssistantMessage([fauxText("third")]);
					},
				],
			);
			await expect(settlement(current.controller.submitAndWait("go", "followUp"))).resolves.toMatchObject({
				status: "done",
			});
			expect(requests).toHaveLength(3);
			// The second request still carries the original; the edit is committed with the boundary after it.
			expect(requests[1]).toContain("ORIGINAL-CONTEXT-MARKER");
			expect(requests[2]).toContain("NEXT-REQUEST");
			expect(requests[2]).not.toContain("ORIGINAL-CONTEXT-MARKER");
			if (action === "replace") expect(requests[2]).toContain("REPLACED-CONTEXT-MARKER");
			else expect(requests[2]).not.toContain("REPLACED-CONTEXT-MARKER");
			expect(current.view.current().notices).toEqual([]);
		},
	);

	test("tool-round boundary events contain the real tool result and entry ids", async () => {
		const rounds: TurnEndEvent[] = [];
		const current = await open(
			[
				(pi) => {
					const tool: ToolDefinition = {
						name: "probe_tool",
						label: "probe_tool",
						description: "A probe tool",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: "TOOL-RESULT-MARKER" }],
							details: undefined,
						}),
					};
					pi.registerTool(tool);
					pi.on("turn_end", (event) => {
						rounds.push(event);
					});
				},
			],
			[
				() =>
					fauxAssistantMessage([fauxToolCall("probe_tool", {}, { id: "probe-call" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("done")]),
			],
		);
		await expect(settlement(current.controller.submitAndWait("go", "followUp"))).resolves.toMatchObject({
			status: "done",
		});
		const entries = current.view.current().conversation.entries;
		const assistant = entries.find((entry) => entry.kind === "nyan.assistant");
		const toolResult = entries.find((entry) => entry.kind === "nyan.tool-result");
		expect(rounds.map((round) => round.turnIndex)).toEqual([0, 1]);
		const [round, answer] = rounds;
		// The tool round carries the committed result message and the durable ids of the assistant and result entries.
		expect(round?.toolResults).toHaveLength(1);
		expect(round?.toolResults[0]).toMatchObject({
			toolCallId: "probe-call",
			toolName: "probe_tool",
			content: [{ type: "text", text: "TOOL-RESULT-MARKER" }],
		});
		expect(round?.toolResultEntryIds).toEqual([String(toolResult?.id)]);
		expect(round?.messageEntryId).toBe(String(assistant?.id));
		// The final answer is committed together with its boundary, so it has no result ids and no entry id yet.
		expect(answer?.toolResults).toEqual([]);
		expect(answer?.toolResultEntryIds).toEqual([]);
	});

	async function runBoundaryRejection(
		entries: (event: TurnEndEvent) => SessionBoundaryDraft[],
		responses: FauxResponseStep[] = [() => fauxAssistantMessage([fauxText("done")])],
	): Promise<string[]> {
		const current = await open(
			[
				(pi) => {
					pi.registerTool({
						name: "probe_tool",
						label: "probe_tool",
						description: "A probe tool",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: "TOOL-RESULT-MARKER" }],
							details: undefined,
						}),
					});
					pi.on("turn_end", (event) => ({ entries: entries(event) }));
				},
			],
			responses,
		);
		await expect(settlement(current.controller.submitAndWait("go", "followUp"))).resolves.toMatchObject({
			status: "done",
		});
		return current.view.current().notices.map((notice) => notice.message);
	}

	const refused = (reason: string) => `Extension durable:boundary failed on turn_end: turn_end: ${reason}`;

	test("reports the reserved boundary kind independently", async () => {
		const notices = await runBoundaryRejection(() => [{ type: "custom", customType: "nyan.invalid" }]);
		expect(notices).toEqual([
			refused("custom boundary kind must be non-empty and not start with nyan.: nyan.invalid"),
		]);
	});

	test("reports non-strict boundary data independently", async () => {
		const notices = await runBoundaryRejection(() => [
			{ type: "custom", customType: "probe.invalid", data: { value: Number.NaN } },
		]);
		expect(notices).toEqual([refused("custom boundary probe.invalid has non-JSON data")]);
	});

	test("reports a context edit targeting an entry outside the active context", async () => {
		const notices = await runBoundaryRejection(() => [
			{ type: "context_edit", targetId: "999999", replacement: null },
		]);
		expect(notices).toEqual([refused("context_edit target 999999 is not a user or custom-message entry")]);
	});

	test("reports an assistant context edit without accepting it", async () => {
		let assistantId = "";
		const notices = await runBoundaryRejection(
			(event) => {
				// Only the tool round names the assistant entry; the final answer has none yet.
				if (event.messageEntryId === "") return [];
				assistantId = event.messageEntryId;
				return [{ type: "context_edit", targetId: assistantId, replacement: null }];
			},
			[
				() =>
					fauxAssistantMessage([fauxToolCall("probe_tool", {}, { id: "assistant-edit-call" })], {
						stopReason: "toolUse",
					}),
				() => fauxAssistantMessage([fauxText("done")]),
			],
		);
		expect(assistantId).toBeTruthy();
		expect(notices).toEqual([refused(`context_edit target ${assistantId} is not a user or custom-message entry`)]);
	});

	test("reports a tool-result context edit without accepting it", async () => {
		let toolResultId = "";
		const notices = await runBoundaryRejection(
			(event) => {
				const [first] = event.toolResultEntryIds;
				if (first === undefined) return [];
				toolResultId = first;
				return [{ type: "context_edit", targetId: toolResultId, replacement: null }];
			},
			[
				() =>
					fauxAssistantMessage([fauxToolCall("probe_tool", {}, { id: "result-edit-call" })], {
						stopReason: "toolUse",
					}),
				() => fauxAssistantMessage([fauxText("done")]),
			],
		);
		expect(toolResultId).toBeTruthy();
		expect(notices).toEqual([refused(`context_edit target ${toolResultId} is not a user or custom-message entry`)]);
	});

	test("refuses a compaction boundary draft through the real boundary handler", async () => {
		const notices = await runBoundaryRejection(() => [
			{ type: "compaction", summary: "not allowed", firstKeptEntryId: null },
		]);
		expect(notices).toEqual([refused("compaction boundary drafts are refused; durable compaction owns the commit")]);
	});

	test("session_before_compact adopts a valid summary and details at the durable cut", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		let preparation: string | undefined;
		const current = await open(
			[
				(pi) => {
					pi.on("session_before_compact", (event) => {
						preparation = event.preparation.firstKeptEntryId;
						return {
							compaction: {
								summary: "EXTENSION-SUMMARY-MARKER",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: 0,
								details: { source: "extension" },
							},
						};
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])],
		);
		await current.controller.submitAndWait("first", "followUp");
		await current.controller.submitAndWait("second", "followUp");
		await current.controller.compact(undefined);
		await vi.waitFor(() => expect(preparation).toBeDefined(), { timeout: 10_000 });
		await vi.waitFor(
			() =>
				expect(
					current.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.compaction"),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const compaction = current.view.current().conversation.entries.find((entry) => entry.kind === "nyan.compaction");
		expect(compaction).toMatchObject({
			head: Number(preparation),
			model: [{ content: [{ type: "text", text: expect.stringContaining("EXTENSION-SUMMARY-MARKER") }] }],
			data: { details: { source: "extension" } },
		});
	});

	test("session_before_compact keeps durable cut and diagnoses a mismatched firstKeptEntryId", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		let durableCut = "";
		const current = await open(
			[
				(pi) => {
					pi.on("session_before_compact", (event) => {
						durableCut = event.preparation.firstKeptEntryId;
						return { compaction: { summary: "MISMATCH-SUMMARY", firstKeptEntryId: "999999", tokensBefore: 0 } };
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])],
		);
		await current.controller.submitAndWait("first", "followUp");
		await current.controller.submitAndWait("second", "followUp");
		await current.controller.compact(undefined);
		await vi.waitFor(
			() =>
				expect(
					current.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.compaction"),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const compaction = current.view.current().conversation.entries.find((entry) => entry.kind === "nyan.compaction");
		expect(durableCut).not.toBe("999999");
		expect(compaction?.head).toBe(Number(durableCut));
		expect(current.view.current().notices.map((notice) => notice.message)).toEqual([
			`Extension durable:compaction failed on session_before_compact: session_before_compact proposed firstKeptEntryId 999999; durable cut ${durableCut} remains`,
			"Compacted.",
		]);
		expect(compaction?.model?.[0]).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("MISMATCH-SUMMARY") }],
		});
	});

	test("session_before_compact diagnoses non-JSON details and usage", async () => {
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		const current = await open(
			[
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "INVALID-METADATA-SUMMARY",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 0,
							// Deliberately not strict JSON and not a Usage: the adapter must refuse both.
							details: new Date(0),
							usage: { input: Number.NaN } as never,
						},
					}));
				},
			],
			[() => fauxAssistantMessage([fauxText("one")]), () => fauxAssistantMessage([fauxText("two")])],
		);
		await current.controller.submitAndWait("first", "followUp");
		await current.controller.submitAndWait("second", "followUp");
		await current.controller.compact(undefined);
		await vi.waitFor(
			() =>
				expect(
					current.view.current().conversation.entries.filter((entry) => entry.kind === "nyan.compaction"),
				).toHaveLength(1),
			{ timeout: 10_000 },
		);
		const notices = current.view.current().notices.map((notice) => notice.message);
		const failed = (reason: string) =>
			`Extension durable:compaction failed on session_before_compact: session_before_compact ${reason}`;
		expect(notices).toEqual([
			failed("returned non-JSON details; details were refused"),
			failed("returned usage that cannot be attributed to a durable model"),
			"Compacted.",
		]);
		// The summary itself stands, without the refused metadata.
		const compaction = current.view.current().conversation.entries.find((entry) => entry.kind === "nyan.compaction");
		expect(compaction?.model?.[0]).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("INVALID-METADATA-SUMMARY") }],
		});
		expect(compaction?.data).not.toHaveProperty("details");
	});

	// A boundary handler runs before the commit that would keep its entries, so a crash in between reruns it. The entries
	// are written by the commit, not by the handler: the interrupted first call leaves nothing, the rerun's result is kept.
	test("a boundary handler interrupted before its commit runs again and its entries are written once", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			() => fauxAssistantMessage([fauxText("answer-1")]),
			() => fauxAssistantMessage([fauxText("answer-2")]),
		]);
		const model = faux.getModel();
		let calls = 0;
		let reach!: () => void;
		const reached = new Promise<void>((resolve) => {
			reach = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const factories: InlineExtension[] = [
			(pi) => {
				pi.registerProvider(faux.provider);
			},
			(pi) => {
				pi.on("turn_end", async () => {
					calls += 1;
					const call = calls;
					if (call === 1) {
						reach();
						// The proposal is computed, but the Harness is closed before this handler returns it, so the boundary
						// commit never happens: the same state a process death before the commit leaves.
						await released;
					}
					return { entries: [{ type: "custom", customType: "probe.once", data: { call } }] };
				});
			},
		];
		const options = {
			cwd,
			extensionFactories: factories,
			model: { provider: model.provider, modelId: model.id },
			projectTrustContext: { ...headless, cwd },
		};
		const first = await openDurable(options);
		const interrupted = first.controller.submitAndWait("go", "followUp").catch((error: unknown) => error);
		await reached;
		// The parked handler ignores `ctx.signal`, so the close waits for it (durable's close guarantee), which is why the
		// test releases it here. A handler that responds to `ctx.signal` is released by the close itself; see
		// `durable-handler-signal.test.ts`.
		const closing = first.close("quit");
		release();
		await closing;
		await expect(interrupted).resolves.toMatchObject({ message: "Harness is closed" });
		const kindsOf = (open: OpenDurableResult) => open.view.current().conversation.entries.map((entry) => entry.kind);
		expect(kindsOf(first)).not.toContain("probe.once");

		session = await openDurable({ ...options, continueSession: true, services: first.services });
		const reopened = session;
		await vi.waitFor(() => expect(kindsOf(reopened).filter((kind) => kind === "probe.once")).toHaveLength(1), {
			timeout: 10_000,
		});
		// Let the run settle, then check nothing is written a second time.
		await vi.waitFor(() => expect(kindsOf(reopened).filter((kind) => kind === "nyan.assistant")).toHaveLength(1), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls).toBe(2);
		expect(kindsOf(reopened).filter((kind) => kind === "probe.once")).toHaveLength(1);
		expect(kindsOf(reopened).filter((kind) => kind === "nyan.assistant")).toHaveLength(1);
		expect(reopened.view.current().conversation.entries.find((entry) => entry.kind === "probe.once")?.data).toEqual({
			call: 2,
		});
	});

	test("replaying a boundary proposal produces the same durable draft", () => {
		const input: SessionBoundaryDraft[] = [
			{ type: "custom_message", customType: "probe.replay", content: "stable", display: false },
			{ type: "context_edit", targetId: "1", replacement: { content: "replacement" } },
		];
		const manager = { getEntry: () => ({ type: "message", message: { role: "user", content: "old" } }) } as never;
		const first = legacyBoundaryEntriesToDurable(input, manager, () => {}, 1234);
		const second = legacyBoundaryEntriesToDurable(input, manager, () => {}, 1234);
		expect(second).toEqual(first);
		expect(first).toEqual([
			{
				kind: "custom_message",
				model: [{ role: "user", content: "stable", timestamp: 1234 }],
				data: { customType: "probe.replay", display: false },
			},
			{
				kind: "context_edit",
				edits: [
					{ target: 1, action: "replace", messages: [{ role: "user", content: "replacement", timestamp: 1234 }] },
				],
			},
		]);
	});

	test("refuses invalid kinds and assistant context edits with diagnostics", async () => {
		let mode: "kind" | "edit" = "kind";
		const current = await open(
			[
				(pi) => {
					pi.on("turn_end", (event) => {
						if (mode === "kind") {
							mode = "edit";
							return { entries: [{ type: "custom", customType: "nyan.invalid" }] };
						}
						return { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }] };
					});
				},
			],
			[() => fauxAssistantMessage([fauxText("first")]), () => fauxAssistantMessage([fauxText("second")])],
		);
		await expect(settlement(current.controller.submitAndWait("go", "followUp"))).resolves.toMatchObject({
			status: "done",
		});
		expect(current.view.current().conversation.entries.some((entry) => entry.kind === "nyan.invalid")).toBe(false);
		expect(current.view.current().notices.some((notice) => notice.message.includes("boundary"))).toBe(true);
	});

	test("the services report whether project-local resources are trusted, which ctx.isProjectTrusted answers", async () => {
		// A project-local extension needs trust, so an undecided directory is not trusted (legacy rules).
		await mkdir(join(cwd, ".nyan", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".nyan", "extensions", "probe.ts"), "export default () => {};\n");
		const first = await open([], [() => fauxAssistantMessage([fauxText("done")])]);
		expect(first.services.projectTrusted).toBe(false);
		await first.close();

		new ProjectTrustStore(agentDir).set(cwd, true);
		const second = await open([], [() => fauxAssistantMessage([fauxText("done")])]);
		expect(second.services.projectTrusted).toBe(true);
	});
});
