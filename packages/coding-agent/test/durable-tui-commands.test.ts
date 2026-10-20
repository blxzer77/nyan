import { describe, expect, test } from "vitest";
import { routeDurableInput } from "../src/core/durable/commands.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

/**
 * The durable TUI is the default interactive mode, so a built-in command that its router does not recognize is
 * submitted as a prompt: the command's text is sent to the provider and paid for. Each case here asserts the contract
 * that a built-in command is either run by the TUI or answered with a message, and never offered to the model.
 */
describe("durable TUI command routing", () => {
	/** The built-ins this path answers with a recorded reduction instead of running them (Decisions #24 and #34). */
	const reduced = new Set(["tree", "import"]);

	test.each(BUILTIN_SLASH_COMMANDS.map((command) => [command.name]))(
		"/%s is answered by the durable TUI, with and without an argument",
		(name) => {
			// The destination is part of the contract, not something read back from the router: a command that loses its
			// handler and starts answering with a reduction message fails here, and so does one that reaches the model.
			const bare = routeDurableInput(`/${name}`);
			const withArgument = routeDurableInput(`/${name} an argument`);
			if (reduced.has(name)) {
				// The message itself is pinned by the two reduction tests below.
				expect(bare).toMatchObject({ kind: "unsupported", name });
				expect(withArgument).toMatchObject({ kind: "unsupported", name });
				return;
			}
			expect(bare).toEqual({ kind: "command", name, args: "" });
			expect(withArgument).toEqual({ kind: "command", name, args: "an argument" });
		},
	);

	test("the reductions name built-ins that still exist", () => {
		// A renamed or removed built-in must not leave a stale reduction behind, which would hide a command that no
		// longer has any destination on this path.
		expect([...reduced].filter((name) => !BUILTIN_SLASH_COMMANDS.some((command) => command.name === name))).toEqual(
			[],
		);
	});

	test.each([
		["/model", { kind: "command", name: "model", args: "" }],
		["/model claude", { kind: "command", name: "model", args: "claude" }],
		["  /model   claude  ", { kind: "command", name: "model", args: "claude" }],
		["/compact", { kind: "command", name: "compact", args: "" }],
		["/compact keep the decision log", { kind: "command", name: "compact", args: "keep the decision log" }],
		["/tasks", { kind: "command", name: "tasks", args: "" }],
		["/agents", { kind: "command", name: "agents", args: "" }],
		["/new", { kind: "command", name: "new", args: "" }],
		["/resume", { kind: "command", name: "resume", args: "" }],
		["/name", { kind: "command", name: "name", args: "" }],
		["/name release line", { kind: "command", name: "name", args: "release line" }],
		["/session", { kind: "command", name: "session", args: "" }],
		["/fork", { kind: "command", name: "fork", args: "" }],
		["/clone", { kind: "command", name: "clone", args: "" }],
		["/quit", { kind: "command", name: "quit", args: "" }],
		["/export", { kind: "command", name: "export", args: "" }],
		["/export out.html", { kind: "command", name: "export", args: "out.html" }],
		["/copy", { kind: "command", name: "copy", args: "" }],
		["/changelog", { kind: "command", name: "changelog", args: "" }],
		["/share", { kind: "command", name: "share", args: "" }],
		["/bug", { kind: "command", name: "bug", args: "" }],
		["/bug a hint", { kind: "command", name: "bug", args: "a hint" }],
		["/settings", { kind: "command", name: "settings", args: "" }],
		["/thinking", { kind: "command", name: "thinking", args: "" }],
		["/thinking high", { kind: "command", name: "thinking", args: "high" }],
		["/scoped-models", { kind: "command", name: "scoped-models", args: "" }],
		["/trust", { kind: "command", name: "trust", args: "" }],
		["/login", { kind: "command", name: "login", args: "" }],
		["/login anthropic", { kind: "command", name: "login", args: "anthropic" }],
		["/logout", { kind: "command", name: "logout", args: "" }],
		["/reload", { kind: "command", name: "reload", args: "" }],
		["/hotkeys", { kind: "command", name: "hotkeys", args: "" }],
		["!echo bash-ok", { kind: "bash", command: "echo bash-ok", excludeFromContext: false }],
		["!!echo hidden", { kind: "bash", command: "echo hidden", excludeFromContext: true }],
		["  !  ls -la  ", { kind: "bash", command: "ls -la", excludeFromContext: false }],
		["!! ls", { kind: "bash", command: "ls", excludeFromContext: true }],
	])("%s runs as a command", (text, expected) => {
		expect(routeDurableInput(text)).toEqual(expected);
	});

	test("/import points at the legacy read-only route, since a durable session is not a JSONL file", () => {
		expect(routeDurableInput("/import session.jsonl")).toEqual({
			kind: "unsupported",
			name: "import",
			message:
				"durable sessions are not JSONL files, so /import cannot open one. Open it with `nyan --session <file>`, which reads legacy sessions read-only, or with `nyan --resume`.",
		});
	});

	test("/tree names the linear-conversation reduction of Decision #24", () => {
		expect(routeDurableInput("/tree")).toEqual({
			kind: "unsupported",
			name: "tree",
			message: "durable sessions are linear, so /tree has no branch navigation (Decision #24).",
		});
	});

	test.each([
		["extension or prompt-template command", "/deploy production"],
		["command with an unknown name", "/nosuchcommand"],
		["bare slash", "/"],
		["prompt text", "explain the failure"],
		["prompt that mentions a command later", "why did /model change"],
		["command name in a different case", "/SETTINGS"],
		["a bare !", "!"],
		["a bare !!", "!!"],
		["bang in the middle of a prompt", "why does ! fail"],
	])("%s stays on the prompt path", (_label, text) => {
		expect(routeDurableInput(text)).toEqual({ kind: "prompt" });
	});
});
