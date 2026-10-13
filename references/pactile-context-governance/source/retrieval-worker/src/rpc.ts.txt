import { createInterface } from "node:readline";
import { HttpDecisionProvider, SystemOneDecisionProvider } from "./decision.js";
import { RetrievalWorker } from "./worker.js";
import type { GraphQueryKind } from "./types.js";

const GRAPH_KINDS = new Set<GraphQueryKind>(["query", "callers", "callees", "dependency", "impact", "explore"]);

interface RpcRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function requestId(value: unknown): string | number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error ? { name: item.name, message: item.message } : item);
}

function graphParams(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params.query !== "string") throw new Error("INVALID_GRAPH_QUERY");
  if (typeof params.kind !== "string" || !GRAPH_KINDS.has(params.kind as GraphQueryKind)) throw new Error(`INVALID_GRAPH_KIND:${String(params.kind)}`);
  return params;
}

export async function serveStdio(root: string): Promise<void> {
  const apiKey = process.env.PACTILE_DECISION_API_KEY;
  const baseUrl = process.env.PACTILE_DECISION_BASE_URL;
  const protocol = process.env.PACTILE_DECISION_PROTOCOL?.toLocaleLowerCase()
    ?? (baseUrl?.toLocaleLowerCase().includes("systemone") ? "system-one" : "openai-compatible");
  const decisionProvider = apiKey
    ? protocol === "system-one"
      ? new SystemOneDecisionProvider({ apiKey, endpoint: baseUrl ?? "https://api.typesafe.ai/v1/systemone", model: process.env.PACTILE_DECISION_MODEL })
      : new HttpDecisionProvider({ apiKey, model: process.env.PACTILE_DECISION_MODEL ?? "gpt-4.1-mini", baseUrl })
    : undefined;
  const worker = new RetrievalWorker({ root, decisionProvider });
  await worker.open();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { process.stdout.write(`${json({ id: null, error: "INVALID_JSON" })}\n`); continue; }
    const id = requestId(parsed);
    try {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_REQUEST");
      const request = parsed as RpcRequest;
      const params = request.params !== null && typeof request.params === "object" && !Array.isArray(request.params)
        ? request.params
        : {};
      let result: unknown;
      switch (request.method) {
        case "open": result = await worker.open(); break;
        case "init": result = await worker.init({ force: params.force === true }); break;
        case "sync": result = await worker.sync(); break;
        case "list": result = await worker.list(); break;
        case "search": result = await worker.search(params as never); break;
        case "read": result = await worker.read(params as never); break;
        case "inspect": result = await worker.inspect(String(params.path ?? "")); break;
        case "graph": result = await worker.graph(graphParams(params) as never); break;
        case "execute": result = await worker.execute(params as never); break;
        case "stats": result = worker.stats(); break;
        case "watch.start": worker.startWatcher(); result = { watcher: "running" }; break;
        case "watch.stop": worker.stopWatcher(); result = { watcher: "stopped" }; break;
        case "close": await worker.close(); result = { closed: true }; break;
        default: throw new Error(`UNKNOWN_METHOD:${request.method}`);
      }
      process.stdout.write(`${json({ id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${json({ id, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  await worker.close();
}
