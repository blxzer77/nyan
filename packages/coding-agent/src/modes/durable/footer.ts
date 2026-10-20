import { keyText } from "../../ui/components/keybinding-hints.ts";
import { theme } from "../../ui/theme/theme.ts";
import { formatCwdForFooter, formatTokens } from "../interactive/components/footer.ts";

/**
 * The two lines of the durable TUI's footer. The values come from the view, the controller, and the model runtime; the
 * formatting lives here so what the footer says is testable without a terminal.
 *
 * What stays out: the git branch, the cache hit rate and its 70% warning tier, and the terminal progress indicator are
 * display-only items that Decision #37 moved to N9. The context percentage keeps its 90% error colour, which this path
 * already had.
 */

export interface DurableFooterUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
}

/** What the footer reads from outside the view: the controller's auto-compaction, the model runtime's auth and catalog. */
export interface DurableFooterLabels {
	readonly autoCompaction: boolean;
	readonly subscription: boolean;
	readonly providerCount: number;
	readonly reasoning: boolean;
	/** The physical model the newest answer came from, while the selected model is a virtual one. */
	readonly routedModel?: { readonly modelId: string; readonly thinkingLevel?: string };
}

export interface DurableFooterInput {
	readonly cwd: string;
	readonly home: string | undefined;
	readonly sessionName: string | undefined;
	readonly usage: DurableFooterUsage;
	readonly provider: string | undefined;
	readonly modelId: string | undefined;
	readonly reasoning: boolean;
	readonly thinkingLevel: string;
	/** The physical model the newest answer came from, while the selected model is a virtual one. */
	readonly routedModel: { readonly modelId: string; readonly thinkingLevel?: string } | undefined;
	readonly subscription: boolean;
	readonly providerCount: number;
	readonly contextWindow: number;
	/** Context use in percent; undefined until an answer measured it. */
	readonly contextPercent: number | undefined;
	readonly autoCompaction: boolean;
	readonly conversationLabel: string;
	readonly extensionStatuses: readonly string[];
}

/** Tokens, cost, context use, and the `~`-relative directory, with the session name. */
export function footerStatsLine(input: DurableFooterInput): string {
	const stats: string[] = [];
	if (input.usage.input) stats.push(`↑${formatTokens(input.usage.input)}`);
	if (input.usage.output) stats.push(`↓${formatTokens(input.usage.output)}`);
	if (input.usage.cacheRead) stats.push(`R${formatTokens(input.usage.cacheRead)}`);
	if (input.usage.cacheWrite) stats.push(`W${formatTokens(input.usage.cacheWrite)}`);
	// A subscription-backed provider bills per month, so its price is an estimate and says so.
	stats.push(`$${input.usage.cost.toFixed(3)}${input.subscription ? " (sub)" : ""}`);
	if (input.contextWindow > 0) {
		const auto = input.autoCompaction ? " (auto)" : "";
		const text = `${input.contextPercent === undefined ? "?" : `${input.contextPercent.toFixed(1)}%`}/${formatTokens(input.contextWindow)}${auto}`;
		stats.push(input.contextPercent !== undefined && input.contextPercent > 90 ? theme.fg("error", text) : text);
	}
	const name = input.sessionName === undefined ? "" : `  ${theme.fg("accent", input.sessionName)}`;
	return theme.fg("dim", `${stats.join(" ")}  ${formatCwdForFooter(input.cwd, input.home)}`) + name;
}

/** Extension statuses, the conversation, the model with its provider and route, and the key hints. */
export function footerHintsLine(input: DurableFooterInput): string {
	const statuses = input.extensionStatuses;
	const prefix = statuses.length > 0 ? `${theme.fg("accent", statuses.join(" · "))} · ` : "";
	let model = input.modelId ?? "no model";
	if (input.reasoning) model += ` • ${input.thinkingLevel === "off" ? "thinking off" : input.thinkingLevel}`;
	if (input.routedModel !== undefined) {
		const level = input.routedModel.thinkingLevel ? ` • ${input.routedModel.thinkingLevel}` : "";
		model += ` → ${input.routedModel.modelId}${level}`;
	}
	// Several configured providers make the model id ambiguous, so the provider goes in front of it.
	if (input.providerCount > 1 && input.provider !== undefined) model = `(${input.provider}) ${model}`;
	const label = theme.fg(input.conversationLabel === "main" ? "dim" : "accent", input.conversationLabel);
	return `${prefix}${label}${theme.fg(
		"dim",
		` · ${model} · thinking:${input.thinkingLevel} (${keyText("app.thinking.cycle")}) · ${keyText("app.model.select")} or /model · /agents · /compact · /tasks · ${keyText("app.message.followUp")} follow-up · / commands · ! bash · !! bash (no context) · ${keyText("app.clear")} clear, twice to exit`,
	)}`;
}
