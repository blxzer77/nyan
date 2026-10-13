export const WORKER_STATES = [
  "absent",
  "building",
  "ready",
  "syncing",
  "stale",
  "degraded",
  "paused",
  "unknown",
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

export type SearchStatus =
  | "complete"
  | "partial"
  | "timeout"
  | "limit_hit"
  | "stale"
  | "degraded"
  | "unsupported"
  | "parse_failed"
  | "unavailable";

export type Freshness = "fresh" | "stale" | "unknown";

export interface WorkspaceScope {
  readonly root: string;
  readonly worktreeId: string;
  readonly generation: number;
  readonly snapshot: string;
  readonly freshness: Freshness;
}

export interface SearchRequest {
  readonly query: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly paths?: readonly string[];
  readonly maxResults?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly source: "exact" | "fallback";
}

export interface SearchResult {
  readonly status: SearchStatus;
  readonly hits: readonly SearchHit[];
  readonly scannedFiles: number;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly generation: number;
  readonly freshness: Freshness;
  readonly reason?: string;
}

export interface ReadRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ReadResult {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly bytes: number;
  readonly hash: string;
  readonly snapshot: string;
}

export interface InspectResult {
  readonly path: string;
  readonly exists: boolean;
  readonly hash: string | null;
  readonly bytes: number;
  readonly lineCount: number;
  readonly snapshot: string;
  readonly generation: number;
  readonly freshness: Freshness;
}

export type GraphQueryKind =
  | "query"
  | "callers"
  | "callees"
  | "dependency"
  | "impact"
  | "explore";

export interface GraphQueryRequest {
  readonly kind: GraphQueryKind;
  readonly query: string;
  readonly path?: string;
  readonly depth?: number;
  readonly maxNodes?: number;
  readonly signal?: AbortSignal;
}

export interface SymbolHit {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface GraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: "call" | "import" | "dependency";
}

export interface GraphResult {
  readonly status: SearchStatus;
  readonly symbols: readonly SymbolHit[];
  readonly edges: readonly GraphEdge[];
  readonly generation: number;
  readonly freshness: Freshness;
  readonly elapsedMs: number;
  readonly reason?: string;
}

export interface RetrievalPlanInput {
  readonly query: string;
  readonly intents?: readonly RetrievalIntent[];
  readonly paths?: readonly string[];
  readonly maxCandidates?: number;
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type RetrievalIntent = "exact" | "structural";

export interface DecisionProviderInput {
  readonly query: string;
  readonly requestedIntents?: readonly RetrievalIntent[];
  readonly maxCandidates?: number;
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DecisionReceipt {
  readonly provider: "rule" | "heuristic" | "semantic" | "composite";
  readonly intents: readonly RetrievalIntent[];
  readonly parallel: boolean;
  readonly earlyStop: boolean;
  readonly maxCandidates: number;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly timeoutMs: number;
  readonly rationale: readonly string[];
  readonly createdAt: string;
}

export type DecisionProviderResult = DecisionReceipt | Promise<DecisionReceipt>;

export interface DecisionProvider {
  decide(input: DecisionProviderInput): DecisionProviderResult;
}

export interface RetrievalCandidate {
  readonly ref: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: "exact" | "graph";
  readonly inspected: boolean;
  readonly hash: string | null;
}

/** A bounded source fact captured while validating a candidate against disk. */
export interface RetrievalFact {
  readonly ref: string;
  readonly path: string;
  readonly exists: boolean;
  readonly hash: string | null;
  readonly bytes: number;
  readonly lineCount: number;
}

export interface RetrievalPack {
  readonly packVersion: 1;
  readonly query: string;
  readonly scope: WorkspaceScope;
  readonly status: SearchStatus;
  readonly candidates: readonly RetrievalCandidate[];
  readonly facts: readonly RetrievalFact[];
  readonly missing: readonly string[];
  readonly budget: {
    readonly maxCandidates: number;
    readonly maxBytes: number;
    readonly maxNodes: number;
  };
  readonly decision: DecisionReceipt;
  readonly createdAt: string;
  readonly hash: string;
}

export interface WorkerStats {
  readonly state: WorkerState;
  readonly root: string;
  readonly worktreeId: string;
  readonly generation: number;
  readonly indexedFiles: number;
  readonly indexedSymbols: number;
  readonly indexedEdges: number;
  readonly indexBytes: number;
  readonly queueDepth: number;
  readonly activeReads: number;
  readonly watcher: "running" | "stopped";
  readonly lastError: string | null;
  readonly processRssBytes: number;
}

export interface WorkerOptions {
  readonly root: string;
  readonly indexDir?: string;
  readonly worktreeId?: string;
  readonly readPoolSize?: number;
  readonly maxFileBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly decisionProvider?: DecisionProvider;
}

export interface InitOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface SyncResult {
  readonly state: WorkerState;
  readonly generation: number;
  readonly changedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly renamedPaths?: readonly { from: string; to: string }[];
  readonly parsedFiles: number;
  readonly elapsedMs: number;
  readonly freshness: Freshness;
}
