import type { BashResult } from "../../core/bash-executor.ts";
import type { ExtensionHost } from "../../core/durable/extension-host.ts";
import type { BashOperations } from "../../core/tools/bash.ts";

/** The card a user bash run writes into: output streams while it runs, then the result arrives. */
export interface BashView {
	append(chunk: string): void;
	finish(result: BashResult): void;
}

export interface UserBashRun {
	readonly command: string;
	readonly excludeFromContext: boolean;
	readonly cwd: string;
	readonly extensionHost?: ExtensionHost;
	execute(
		command: string,
		excludeFromContext: boolean,
		onChunk: (chunk: string) => void,
		operations?: BashOperations,
	): Promise<BashResult>;
	record(command: string, result: BashResult, excludeFromContext: boolean): Promise<void>;
	readonly view: BashView;
}

/** What became of a user bash command. */
export type UserBashOutcome =
	/** The command ran and its result was recorded. */
	| { readonly status: "ran" }
	/** A `user_bash` handler threw: nothing ran, and the extension runner reported the failure. */
	| { readonly status: "extension-failed" };

/**
 * Run a user's `!` command, as legacy `handleBashCommand` does.
 *
 * The `user_bash` handlers run first so an extension can replace the execution: `operations` runs the command through
 * them (a sandbox, say), and `result` is a finished run that is recorded without executing anything. A handler that
 * throws stops the command; this process's shell is never used as a fallback, because a handler that answered must not
 * be bypassed.
 */
export async function runUserBash(run: UserBashRun): Promise<UserBashOutcome> {
	let handled: Awaited<ReturnType<ExtensionHost["runner"]["emitUserBash"]>> | undefined;
	try {
		handled = await run.extensionHost?.runner.emitUserBash({
			type: "user_bash",
			command: run.command,
			excludeFromContext: run.excludeFromContext,
			cwd: run.cwd,
		});
	} catch {
		return { status: "extension-failed" };
	}
	const answer = handled?.result;
	if (answer !== undefined) {
		if (answer.output.length > 0) run.view.append(answer.output);
		await run.record(run.command, answer, run.excludeFromContext);
		run.view.finish(answer);
		return { status: "ran" };
	}
	const result = await run.execute(
		run.command,
		run.excludeFromContext,
		(chunk) => run.view.append(chunk),
		handled?.operations,
	);
	run.view.finish(result);
	return { status: "ran" };
}
