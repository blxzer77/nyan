import type {
  DecisionProvider,
  DecisionProviderInput,
  DecisionReceipt,
  RetrievalIntent,
} from "./types.js";
import { abortIfNeeded, boundedInt } from "./util.js";

const STRUCTURAL_SIGNALS = [
  "caller",
  "callee",
  "callers",
  "callees",
  "call graph",
  "dependency",
  "dependencies",
  "impact",
  "blast radius",
  "affected",
  "调用者",
  "调用链",
  "依赖",
  "影响面",
  "受影响",
] as const;

function includesSignal(query: string): boolean {
  const normalized = query.toLocaleLowerCase();
  return STRUCTURAL_SIGNALS.some((signal) => normalized.includes(signal));
}

/**
 * Deterministic DecisionProvider used by the independent worker.
 *
 * It owns retrieval planning and policy clamps, but never reads source files,
 * executes a provider, or upgrades a candidate to Evidence. A later model
 * provider can implement the same interface without changing the Worker.
 */
export class RuleDecisionProvider implements DecisionProvider {
  decide(input: DecisionProviderInput): DecisionReceipt {
    const query = input.query.trim();
    const requested = input.requestedIntents?.length ? [...input.requestedIntents] : undefined;
    const structural = includesSignal(query);
    const intents: RetrievalIntent[] = requested
      ? [...new Set(requested)]
      : structural ? ["exact", "structural"] : ["exact"];
    if (!intents.includes("exact")) intents.unshift("exact");
    const maxCandidates = boundedInt(input.maxCandidates, structural ? 30 : 20, 1, 200);
    const maxBytes = boundedInt(input.maxBytes, structural ? 192 * 1024 : 128 * 1024, 256, 2 * 1024 * 1024);
    const maxNodes = boundedInt(input.maxNodes, structural ? 150 : 50, 1, 2000);
    const timeoutMs = boundedInt(input.timeoutMs, structural ? 15_000 : 10_000, 20, 300_000);
    const rationale = structural
      ? ["structural signal detected", "run exact and relation branches in parallel", "stop a tail branch after coverage is satisfied"]
      : ["exact path is sufficient for a literal or path-oriented query", "keep relation branch opt-in"];
    return {
      provider: "rule",
      intents,
      parallel: intents.length > 1,
      earlyStop: true,
      maxCandidates,
      maxBytes,
      maxNodes,
      timeoutMs,
      rationale,
      createdAt: new Date().toISOString(),
    };
  }
}

/** Normalize an injected provider's receipt before it becomes an execution budget. */
export function normalizeDecisionReceipt(receipt: DecisionReceipt, input: DecisionProviderInput): DecisionReceipt {
  const requested = receipt.intents.filter((intent): intent is RetrievalIntent => intent === "exact" || intent === "structural");
  const intents = [...new Set(requested)];
  if (!intents.includes("exact")) intents.unshift("exact");
  const fallback = new RuleDecisionProvider().decide(input);
  const boundedToRequest = (value: number, requested: number | undefined, defaultValue: number, min: number, max: number): number => {
    const requestBound = boundedInt(requested, defaultValue, min, max);
    return boundedInt(value, requestBound, min, requestBound);
  };
  return {
    ...receipt,
    intents,
    parallel: intents.length > 1 && receipt.parallel,
    earlyStop: receipt.earlyStop === true,
    maxCandidates: boundedToRequest(receipt.maxCandidates, input.maxCandidates, fallback.maxCandidates, 1, 200),
    maxBytes: boundedToRequest(receipt.maxBytes, input.maxBytes, fallback.maxBytes, 256, 2 * 1024 * 1024),
    maxNodes: boundedToRequest(receipt.maxNodes, input.maxNodes, fallback.maxNodes, 1, 2000),
    timeoutMs: boundedToRequest(receipt.timeoutMs, input.timeoutMs, fallback.timeoutMs, 20, 300_000),
    rationale: receipt.rationale.filter((item): item is string => typeof item === "string").slice(0, 32),
  };
}

export interface HttpDecisionProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SystemOneDecisionProviderOptions {
  readonly apiKey: string;
  /** Exact System One endpoint, for example https://api.typesafe.ai/v1/systemone. */
  readonly endpoint: string;
  /** Optional model override. When omitted, /health is probed before jev-latest fallback. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" && item !== null && "text" in item ? String(item.text) : "").join("\n");
  return "";
}

function parseProviderJson(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("DECISION_PROVIDER_INVALID_JSON");
  }
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    throw new Error("DECISION_PROVIDER_INVALID_JSON");
  }
}

/**
 * OpenAI-compatible semantic planner. It sends the query and policy bounds only;
 * source files and retrieval facts never leave the Worker through this adapter.
 */
export class HttpDecisionProvider implements DecisionProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpDecisionProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(input: DecisionProviderInput): Promise<DecisionReceipt> {
    if (!this.options.apiKey.trim()) throw new Error("DECISION_PROVIDER_API_KEY_MISSING");
    const timeoutMs = boundedInt(this.options.timeoutMs, input.timeoutMs ?? 15_000, 100, 300_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const endpoint = `${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "")}/chat/completions`;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Plan local repository retrieval. Return JSON only with intents, parallel, earlyStop, maxCandidates, maxBytes, maxNodes, timeoutMs, rationale." },
            { role: "user", content: JSON.stringify({ query: input.query, requestedIntents: input.requestedIntents ?? [], bounds: { maxCandidates: input.maxCandidates, maxBytes: input.maxBytes, maxNodes: input.maxNodes, timeoutMs: input.timeoutMs } }) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DECISION_PROVIDER_HTTP_${response.status}`);
      let body: { choices?: readonly { message?: { content?: unknown } }[] };
      try {
        body = await response.json() as { choices?: readonly { message?: { content?: unknown } }[] };
      } catch {
        throw new Error("DECISION_PROVIDER_INVALID_JSON");
      }
      const content = responseText(body.choices?.[0]?.message?.content);
      const parsed = parseProviderJson(content);
      const fallback = new RuleDecisionProvider().decide(input);
      return normalizeDecisionReceipt({
        provider: "semantic",
        intents: Array.isArray(parsed.intents) ? parsed.intents.filter((value): value is RetrievalIntent => value === "exact" || value === "structural") : fallback.intents,
        parallel: parsed.parallel === true,
        earlyStop: parsed.earlyStop === true,
        maxCandidates: typeof parsed.maxCandidates === "number" ? parsed.maxCandidates : fallback.maxCandidates,
        maxBytes: typeof parsed.maxBytes === "number" ? parsed.maxBytes : fallback.maxBytes,
        maxNodes: typeof parsed.maxNodes === "number" ? parsed.maxNodes : fallback.maxNodes,
        timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : fallback.timeoutMs,
        rationale: Array.isArray(parsed.rationale) ? parsed.rationale.filter((value): value is string => typeof value === "string") : ["semantic provider"],
        createdAt: new Date().toISOString(),
      }, input);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(input.signal?.aborted ? "DECISION_PROVIDER_CANCELLED" : "DECISION_PROVIDER_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function probability(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requestedIntentSet(input: DecisionProviderInput): Set<RetrievalIntent> | null {
  if (!input.requestedIntents?.length) return null;
  return new Set(input.requestedIntents.filter((intent): intent is RetrievalIntent => intent === "exact" || intent === "structural"));
}

/**
 * Native TypeSafe/Jev System One adapter.
 *
 * System One is a typed decision API, not a chat endpoint: it receives one
 * state plus typed questions and returns answers keyed by question id. The
 * adapter sends only retrieval metadata and never source text or source facts.
 */
export class SystemOneDecisionProvider implements DecisionProvider {
  private readonly fetchImpl: typeof fetch;
  private detectedModel: Promise<string> | null = null;

  constructor(private readonly options: SystemOneDecisionProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async detectModel(signal?: AbortSignal): Promise<string> {
    if (this.options.model?.trim()) return this.options.model.trim();
    if (this.detectedModel) return this.detectedModel;
    this.detectedModel = (async () => {
      const endpoint = new URL(this.options.endpoint);
      const healthUrl = `${endpoint.origin}/health`;
      const controller = new AbortController();
      const timeoutMs = boundedInt(this.options.timeoutMs, 15_000, 100, 300_000);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.fetchImpl(healthUrl, {
          method: "GET",
          headers: { authorization: `Bearer ${this.options.apiKey}` },
          signal: controller.signal,
        });
        if (response.ok) {
          const body = await responseRecord(response);
          if (typeof body.model === "string" && body.model.trim()) return body.model.trim();
        }
      } catch {
        // Some hosted System One services do not expose /health. Use the
        // documented mutable alias and let the decision request validate it.
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      return "jev-latest";
    })();
    return this.detectedModel;
  }

  async decide(input: DecisionProviderInput): Promise<DecisionReceipt> {
    if (!this.options.apiKey.trim()) throw new Error("DECISION_PROVIDER_API_KEY_MISSING");
    abortIfNeeded(input.signal);
    const model = await this.detectModel(input.signal);
    const timeoutMs = boundedInt(this.options.timeoutMs, input.timeoutMs ?? 15_000, 100, 300_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const endpoint = this.options.endpoint.replace(/\/+$/u, "");
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          state: {
            query: input.query,
            requestedIntents: input.requestedIntents ?? [],
            bounds: {
              maxCandidates: input.maxCandidates,
              maxBytes: input.maxBytes,
              maxNodes: input.maxNodes,
              timeoutMs: input.timeoutMs,
            },
          },
          questions: {
            retrieval_intent: {
              type: "choice",
              instructions: "Choose the smallest retrieval intent set that covers the repository query.",
              criteria: {
                exact: "Literal text, symbol name, or path lookup is sufficient.",
                structural: "Callers, callees, dependencies, or impact relations are required.",
                both: "Use both literal retrieval and structural relations.",
              },
            },
            parallel: {
              type: "noul",
              instructions: "Should the exact and structural retrieval branches run concurrently when both are selected?",
            },
            early_stop: {
              type: "noul",
              instructions: "May a branch stop after the bounded candidate coverage is satisfied?",
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DECISION_PROVIDER_HTTP_${response.status}`);
      const body = await responseRecord(response);
      const answers = record(body.answers);
      const intentAnswer = record(answers.retrieval_intent);
      const selected = typeof intentAnswer.choice === "string" ? intentAnswer.choice : "exact";
      const allowed = requestedIntentSet(input);
      const semanticIntents: RetrievalIntent[] = selected === "structural"
        ? ["exact", "structural"]
        : selected === "both" ? ["exact", "structural"] : ["exact"];
      const intents = allowed
        ? semanticIntents.filter((intent) => allowed.has(intent))
        : semanticIntents;
      if (!intents.length) intents.push(...(allowed && allowed.size ? [...allowed] : ["exact" as RetrievalIntent]));
      if (!intents.includes("exact")) intents.unshift("exact");
      const parallelAnswer = record(answers.parallel);
      const earlyStopAnswer = record(answers.early_stop);
      const budgets = new RuleDecisionProvider().decide({ ...input, requestedIntents: intents });
      const parallel = intents.length > 1 && probability(parallelAnswer.noul) >= 0.5;
      const earlyStop = probability(earlyStopAnswer.noul) >= 0.5;
      return normalizeDecisionReceipt({
        provider: "semantic",
        intents,
        parallel,
        earlyStop,
        maxCandidates: budgets.maxCandidates,
        maxBytes: budgets.maxBytes,
        maxNodes: budgets.maxNodes,
        timeoutMs: budgets.timeoutMs,
        rationale: [
          `system-one model=${model}`,
          `intent=${selected}`,
          `parallel probability=${probability(parallelAnswer.noul).toFixed(3)}`,
          `early-stop probability=${probability(earlyStopAnswer.noul).toFixed(3)}`,
        ],
        createdAt: new Date().toISOString(),
      }, input);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(input.signal?.aborted ? "DECISION_PROVIDER_CANCELLED" : "DECISION_PROVIDER_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class CompositeDecisionProvider implements DecisionProvider {
  constructor(private readonly providers: readonly DecisionProvider[]) {}

  async decide(input: DecisionProviderInput): Promise<DecisionReceipt> {
    if (this.providers.length === 0) return new RuleDecisionProvider().decide(input);
    const decisions = await Promise.all(this.providers.map((provider) => provider.decide(input)));
    const first = decisions[0];
    return {
      ...first,
      provider: "composite",
      intents: [...new Set(decisions.flatMap((decision) => decision.intents))],
      maxCandidates: Math.min(...decisions.map((decision) => decision.maxCandidates)),
      maxBytes: Math.min(...decisions.map((decision) => decision.maxBytes)),
      maxNodes: Math.min(...decisions.map((decision) => decision.maxNodes)),
      timeoutMs: Math.min(...decisions.map((decision) => decision.timeoutMs)),
      parallel: decisions.some((decision) => decision.parallel),
      earlyStop: decisions.every((decision) => decision.earlyStop),
      rationale: decisions.flatMap((decision) => decision.rationale),
    };
  }
}
