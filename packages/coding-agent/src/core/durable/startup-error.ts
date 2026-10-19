import type { AgentSessionRuntimeDiagnostic } from "../agent-session-services.ts";

/**
 * Startup conditions a durable command reports as diagnostics and exits on, the way the legacy path reports its startup
 * diagnostics: one message per problem, no stack trace. It is its own module because both the durable runtime and the
 * harness setup raise it, and the harness setup is imported by the runtime.
 */
export class DurableStartupError extends Error {
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];

	constructor(diagnostics: readonly AgentSessionRuntimeDiagnostic[]) {
		super(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		this.name = "DurableStartupError";
		this.diagnostics = diagnostics;
	}
}
