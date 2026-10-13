import { createHash } from "node:crypto";
import { promises as fs, statSync, watch as watchFiles } from "node:fs";
import path from "node:path";
import { exactSearch } from "./exact.js";
import { normalizeDecisionReceipt, RuleDecisionProvider } from "./decision.js";
import { buildCallEdgesFromSource, buildGraph, parseFile, type ParsedFile } from "./graph.js";
import { RelationStore, type FileRow } from "./store.js";
import type {
  Freshness,
  GraphQueryRequest,
  GraphResult,
  InitOptions,
  InspectResult,
  ReadRequest,
  ReadResult,
  RetrievalCandidate,
  RetrievalPack,
  RetrievalPlanInput,
  SearchRequest,
  SearchResult,
  SyncResult,
  WorkerOptions,
  DecisionProvider,
  WorkerState,
  WorkerStats,
  WorkspaceScope,
} from "./types.js";
import {
  abortIfNeeded,
  boundedInt,
  isAbortError,
  isIgnored,
  resolveSafeRealpath,
  sha256Text,
  snapshotHash,
  walkFiles,
} from "./util.js";

function worktreeHash(root: string): string {
  return createHash("sha256").update(path.resolve(root), "utf8").digest("hex").slice(0, 16);
}

function asFreshness(state: WorkerState): "fresh" | "stale" | "unknown" {
  if (state === "ready") return "fresh";
  if (state === "stale" || state === "syncing") return "stale";
  return "unknown";
}

function nowIso(): string { return new Date().toISOString(); }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RetrievalWorker {
  readonly root: string;
  readonly worktreeId: string;
  readonly indexDir: string;
  private readonly maxFileBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly decisionProvider: DecisionProvider;
  private readonly store: RelationStore;
  private state: WorkerState = "absent";
  private generation = 0;
  private snapshot = "";
  private lastError: string | null = null;
  private watcher: ReturnType<typeof watchFiles> | null = null;
  private watcherTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<SyncResult> | null = null;
  private syncPending = false;
  /** D32 — real queue length: sync() calls waiting to run behind the active pass. */
  private syncQueued = 0;
  /** D31 — real in-flight read count: read()/inspect() bodies currently executing. */
  private activeReads = 0;
  /**
   * D30 — a pass that observed workspace changes it could not commit (cancel or write failure)
   * leaves a committed index that is still USABLE (state stays `ready`) but known to lag the
   * workspace, so the reported freshness must not claim `fresh`.
   */
  private pendingChanges = false;
  private opened = false;
  private closed = false;
  private storeReady = false;

  constructor(options: WorkerOptions) {
    this.root = path.resolve(options.root);
    this.worktreeId = options.worktreeId ?? worktreeHash(this.root);
    this.indexDir = path.resolve(options.indexDir ?? path.join(this.root, ".pactile", "retrieval", this.worktreeId));
    this.maxFileBytes = boundedInt(options.maxFileBytes, 2 * 1024 * 1024, 4096, 16 * 1024 * 1024);
    this.defaultTimeoutMs = boundedInt(options.defaultTimeoutMs, 10_000, 20, 300_000);
    this.decisionProvider = options.decisionProvider ?? new RuleDecisionProvider();
    this.store = new RelationStore(path.join(this.indexDir, "relations.sqlite"), options.readPoolSize ?? 3);
  }

  async open(): Promise<WorkspaceScope> {
    this.closed = false;
    if (!this.opened) {
      await fs.access(this.root);
      this.opened = true;
    }
    if (!this.storeReady && await this.store.exists()) {
      try {
        await this.openStore();
      } catch (error) {
        this.storeReady = false;
        this.state = "degraded";
        this.lastError = `index unavailable: ${errorMessage(error)}`;
      }
    }
    return this.scope();
  }

  async close(): Promise<void> {
    this.stopWatcher();
    this.syncPending = false;
    this.store.close();
    this.storeReady = false;
    this.opened = false;
    this.closed = true;
    this.state = "absent";
  }

  private scope(): WorkspaceScope {
    return { root: this.root, worktreeId: this.worktreeId, generation: this.generation, snapshot: this.snapshot, freshness: this.currentFreshness() };
  }

  /**
   * Freshness of the reported DATA, which is not a pure function of the state machine: an index that
   * is `ready` but provably behind the workspace (a cancelled/failed pass dropped a change it had
   * already observed) is `stale`, never `fresh`. Every public surface that reports freshness routes
   * through here so `scope()`, `search()`, `graph()` and `inspect()` can never disagree.
   */
  private currentFreshness(): Freshness {
    if (this.pendingChanges && this.state === "ready") return "stale";
    return asFreshness(this.state);
  }

  private requireOpen(): void {
    if (!this.opened) throw new Error("WORKER_NOT_OPEN");
  }

  private isIndexPath(absolute: string): boolean {
    const relative = path.relative(this.indexDir, absolute);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async ensureOpen(): Promise<void> {
    if (this.closed) throw new Error("WORKER_NOT_OPEN");
    await this.open();
  }

  private async openStore(): Promise<void> {
    if (this.storeReady) return;
    await this.store.open();
    this.storeReady = true;
    const snapshot = this.store.snapshot();
    this.generation = snapshot.generation;
    this.snapshot = snapshot.snapshot;
    this.lastError = snapshot.lastError;
    this.state = (snapshot.state as WorkerState) ?? (this.generation > 0 ? "ready" : "absent");
    if (this.generation > 0 && this.state === "absent") this.state = "stale";
    if (this.state === "building" || this.state === "syncing") {
      this.state = this.generation > 0 ? "stale" : "absent";
      this.lastError = this.lastError ?? "recovered incomplete index";
      await this.store.write((db) => this.store.setMeta(db, { state: this.state, freshness: this.currentFreshness(), lastError: this.lastError }));
    }
  }

  private async fileRow(relative: string): Promise<{ row: FileRow; text: string } | null> {
    try {
      const resolved = await resolveSafeRealpath(this.root, relative);
      const absolute = resolved.absolute;
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > this.maxFileBytes) return null;
      const text = await fs.readFile(absolute, "utf8");
      return { row: { path: resolved.relative, hash: sha256Text(text), mtimeMs: stat.mtimeMs, bytes: stat.size, language: path.extname(resolved.relative).slice(1).toLowerCase() || "unknown" }, text };
    } catch {
      return null;
    }
  }

  private async readAllFiles(signal?: AbortSignal): Promise<{ rows: FileRow[]; parsed: ParsedFile[]; texts: Map<string, string> }> {
    const rows: FileRow[] = [];
    const parsed: ParsedFile[] = [];
    const texts = new Map<string, string>();
    for (const relative of await walkFiles(this.root, signal)) {
      abortIfNeeded(signal);
      const loaded = await this.fileRow(relative);
      if (!loaded) continue;
      rows.push(loaded.row);
      texts.set(loaded.row.path, loaded.text);
      parsed.push(parseFile(loaded.row.path, loaded.text));
    }
    return { rows, parsed, texts };
  }

  private graphData(parsed: readonly ParsedFile[], texts: ReadonlyMap<string, string>): ReturnType<typeof buildGraph> {
    const base = buildGraph({ files: parsed });
    const knownFiles = new Set(parsed.map((file) => file.path));
    const callEdges = parsed.flatMap((file) => buildCallEdgesFromSource(file, texts.get(file.path) ?? "", base.symbols, knownFiles));
    return { ...base, edges: [...base.edges, ...callEdges] };
  }

  async init(options: InitOptions = {}): Promise<WorkspaceScope> {
    await this.ensureOpen();
    abortIfNeeded(options.signal);
    if (!this.storeReady) {
      try { await this.openStore(); } catch (error) {
        this.state = "degraded";
        this.lastError = `index unavailable: ${errorMessage(error)}`;
        throw new Error("INDEX_UNAVAILABLE");
      }
    }
    if (!options.force && this.generation > 0 && this.state === "ready") return this.scope();
    this.state = "building";
    this.lastError = null;
    await this.store.write((db) => this.store.setMeta(db, { state: "building", freshness: "stale", lastError: null }));
    const started = performance.now();
    try {
      const all = await this.readAllFiles(options.signal);
      const graph = this.graphData(all.parsed, all.texts);
      const nextGeneration = this.generation + 1;
      const nextSnapshot = snapshotHash([this.worktreeId, String(nextGeneration), ...all.rows.map((row) => `${row.path}:${row.hash}`)]);
      const nextState: WorkerState = graph.diagnostics.length > 0 ? "degraded" : "ready";
      const nextError = graph.diagnostics.length > 0 ? [...new Set(graph.diagnostics)].join(",") : null;
      await this.store.transaction((db) => {
        abortIfNeeded(options.signal);
        this.store.replaceAll(db, all.rows, graph.symbols, graph.imports, graph.edges, { state: nextState, freshness: asFreshness(nextState), generation: nextGeneration, snapshot: nextSnapshot, lastError: nextError });
        abortIfNeeded(options.signal);
      });
      this.generation = nextGeneration;
      this.snapshot = nextSnapshot;
      this.state = nextState;
      this.lastError = nextError;
      this.pendingChanges = false;
      void started;
      return this.scope();
    } catch (error) {
      // A cancelled/failed init also leaves an uncommitted change behind when one existed.
      if (this.generation > 0) this.pendingChanges = true;
      this.state = isAbortError(error) ? (this.generation > 0 ? "stale" : "absent") : "degraded";
      this.lastError = isAbortError(error) ? "cancelled" : errorMessage(error);
      await this.store.write((db) => this.store.setMeta(db, { state: this.state, freshness: this.currentFreshness(), lastError: this.lastError }));
      throw error;
    }
  }

  async sync(signal?: AbortSignal): Promise<SyncResult> {
    await this.ensureOpen();
    abortIfNeeded(signal);
    if (!this.storeReady) {
      try { await this.openStore(); } catch (error) {
        this.state = "degraded";
        this.lastError = `index unavailable: ${errorMessage(error)}`;
        throw new Error("INDEX_UNAVAILABLE");
      }
    }
    if (this.syncing) {
      // D32 — count the caller as really queued. `syncPending` stays the "somebody is waiting"
      // flag used to decide whether a follow-up pass must be scheduled; `syncQueued` is the number
      // reported to stats().
      this.syncPending = true;
      this.syncQueued += 1;
      try {
        return await this.syncing;
      } finally {
        this.syncQueued -= 1;
      }
    }
    const run = this.performSync(signal);
    this.syncing = run;
    try { return await run; } finally {
      this.syncing = null;
      if (this.syncPending && !this.closed) {
        this.syncPending = false;
        void this.sync().catch((error) => {
          this.state = "degraded";
          this.lastError = errorMessage(error);
        });
      }
    }
  }

  /**
   * D31 — run one read-stage body with the active-read counter balanced, whatever happens.
   * `read()` and `inspect()` are the two methods that open a source file on behalf of a caller, so
   * they are the reads `stats().activeReads` reports (the README claim). graph()/execute() are
   * index queries and sync()/init() are bulk indexing passes, none of which is a "read" in that
   * sense; the README wording is scoped accordingly.
   */
  private async trackRead<T>(body: () => Promise<T>): Promise<T> {
    this.activeReads += 1;
    try {
      return await body();
    } finally {
      this.activeReads -= 1;
    }
  }

  private async performSync(signal?: AbortSignal): Promise<SyncResult> {
    const started = performance.now();
    const previous = new Map(this.store.listFiles().map((row) => [row.path, row]));
    const all = await this.readAllFiles(signal);
    const current = new Map(all.rows.map((row) => [row.path, row]));
    const changedPaths = all.rows.filter((row) => previous.get(row.path)?.hash !== row.hash).map((row) => row.path);
    const removedPaths = [...previous.keys()].filter((file) => !current.has(file));
    const renamedPaths: { from: string; to: string }[] = [];
    const removedByHash = new Map<string, string>();
    for (const removed of removedPaths) {
      const row = previous.get(removed);
      if (row) removedByHash.set(row.hash, removed);
    }
    for (const changed of changedPaths) {
      const row = current.get(changed);
      const from = row ? removedByHash.get(row.hash) : undefined;
      if (from) renamedPaths.push({ from, to: changed });
    }
    if (changedPaths.length === 0 && removedPaths.length === 0) {
      // The walk just proved the workspace matches the committed index, so nothing is pending.
      this.pendingChanges = false;
      this.state = this.generation > 0 ? (this.state === "degraded" ? "degraded" : "ready") : "absent";
      await this.store.write((db) => this.store.setMeta(db, { state: this.state, freshness: this.currentFreshness(), lastError: this.lastError }));
      return { state: this.state, generation: this.generation, changedPaths: [], removedPaths: [], renamedPaths: [], parsedFiles: 0, elapsedMs: performance.now() - started, freshness: this.currentFreshness() };
    }
    // D30 — remember what the worker was reporting BEFORE it claimed to be syncing, so a failed
    // pass can fall back to the truth instead of inventing a new state.
    const stateBeforePass = this.state;
    this.state = "syncing";
    try {
      const graph = this.graphData(all.parsed, all.texts);
      const nextGeneration = this.generation + 1;
      const nextSnapshot = snapshotHash([this.worktreeId, String(nextGeneration), ...all.rows.map((row) => `${row.path}:${row.hash}`)]);
      const nextState: WorkerState = graph.diagnostics.length > 0 ? "degraded" : "ready";
      const nextError = graph.diagnostics.length > 0 ? [...new Set(graph.diagnostics)].join(",") : null;
      const parsedByPath = new Map(all.parsed.map((file) => [file.path, file]));
      await this.store.transaction((db) => {
        abortIfNeeded(signal);
        for (const pathName of [...changedPaths, ...removedPaths]) {
          const parsed = parsedByPath.get(pathName);
          const row = current.get(pathName) ?? null;
          this.store.replacePath(db, pathName, row, parsed?.symbols ?? [], parsed?.imports.map((specifier) => ({ path: pathName, specifier })) ?? []);
        }
        this.store.replaceEdges(db, graph.edges);
        abortIfNeeded(signal);
        this.store.setMeta(db, { state: nextState, freshness: asFreshness(nextState), generation: nextGeneration, snapshot: nextSnapshot, lastError: nextError });
      });
      this.generation = nextGeneration;
      this.snapshot = nextSnapshot;
      this.state = nextState;
      this.lastError = nextError;
      this.pendingChanges = false;
      return { state: this.state, generation: this.generation, changedPaths, removedPaths, renamedPaths, parsedFiles: changedPaths.length, elapsedMs: performance.now() - started, freshness: this.currentFreshness() };
    } catch (error) {
      // D30 — `state = "syncing"` above must never survive a failure. Compare init(), which already
      // restores the state in its catch. A cancel (or a write failure) publishes nothing, so the
      // committed generation is untouched and the honest report is the pre-pass state: the previous
      // `ready`/`stale`/`degraded` when one existed, otherwise `absent`. The change this pass had
      // already observed stays uncommitted, so the data freshness reads `stale` (not `fresh`) and
      // `lastError` records the reason (`cancelled` for an abort, mirroring init()). The store's
      // committed meta is deliberately NOT rewritten: it still describes the un-cancelled
      // generation, which the data plane never changed, so `lastError` there remains empty exactly
      // as the P4 `sync-abort-db-lastError-not-polluted` check requires.
      this.pendingChanges = true;
      this.state = isAbortError(error)
        ? (stateBeforePass !== "syncing" && this.generation > 0 ? stateBeforePass : this.generation > 0 ? "stale" : "absent")
        : "degraded";
      this.lastError = isAbortError(error) ? "cancelled" : errorMessage(error);
      throw error;
    }
  }

  async list(): Promise<readonly string[]> {
    await this.ensureOpen();
    return (await walkFiles(this.root)).slice();
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    await this.ensureOpen();
    const paths = [...new Set(await Promise.all((request.paths ?? []).map(async (item) => (await resolveSafeRealpath(this.root, item)).relative)))];
    return exactSearch({ root: this.root, scope: () => this.scope(), freshness: () => this.currentFreshness(), defaultTimeoutMs: this.defaultTimeoutMs, maxFileBytes: this.maxFileBytes }, { ...request, paths });
  }

  async read(request: ReadRequest): Promise<ReadResult> {
    await this.ensureOpen();
    abortIfNeeded(request.signal);
    return await this.trackRead(async () => {
      const resolved = await resolveSafeRealpath(this.root, request.path);
      const relative = resolved.relative;
      const absolute = resolved.absolute;
      if (isIgnored(relative) || this.isIndexPath(absolute)) throw new Error("PATH_NOT_READABLE");
      // D33 — the abort used to be checked only before the path was resolved, so a signal that fired
      // while `fs.readFile` was in flight was silently dropped. Re-check before the read and again
      // after it, so an in-flight cancel rejects with AbortError like graph()/sync()/execute() do.
      abortIfNeeded(request.signal);
      const text = await fs.readFile(absolute, "utf8");
      abortIfNeeded(request.signal);
      const maxBytes = boundedInt(request.maxBytes, 256 * 1024, 1, this.maxFileBytes);
      const lines = text.split(/\r?\n/u);
      const startLine = boundedInt(request.startLine, 1, 1, Math.max(1, lines.length));
      const endLine = boundedInt(request.endLine, Math.min(lines.length, startLine + 200), startLine, lines.length);
      let content = lines.slice(startLine - 1, endLine).join("\n");
      if (Buffer.byteLength(content, "utf8") > maxBytes) {
        content = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
      }
      return { path: relative, content, startLine, endLine, bytes: Buffer.byteLength(content, "utf8"), hash: sha256Text(text), snapshot: this.snapshot };
    });
  }

  async inspect(relativePath: string): Promise<InspectResult> {
    await this.ensureOpen();
    const resolved = await resolveSafeRealpath(this.root, relativePath);
    const relative = resolved.relative;
    const absolute = resolved.absolute;
    if (isIgnored(relative) || this.isIndexPath(absolute)) throw new Error("PATH_NOT_READABLE");
    try {
      const text = await this.trackRead(async () => await fs.readFile(absolute, "utf8"));
      return { path: relative, exists: true, hash: sha256Text(text), bytes: Buffer.byteLength(text, "utf8"), lineCount: text.split(/\r?\n/u).length, snapshot: this.snapshot, generation: this.generation, freshness: this.currentFreshness() };
    } catch {
      return { path: relative, exists: false, hash: null, bytes: 0, lineCount: 0, snapshot: this.snapshot, generation: this.generation, freshness: this.currentFreshness() };
    }
  }

  async graph(request: GraphQueryRequest): Promise<GraphResult> {
    await this.ensureOpen();
    abortIfNeeded(request.signal);
    // Validate an explicitly named path exactly like read()/inspect(): the workspace boundary is
    // enforced through the real path, and DEFAULT_IGNORES / the worker index stay unreadable.
    // This runs BEFORE every index-state early return, so an illegal path is rejected the same way
    // whether or not the index is ready, and a workspace-relative path that no longer exists still
    // resolves (resolveSafeRealpath tolerates a missing tail) so deleted/stale queries keep working.
    // Only a missing/empty operand means "no path filter" (unchanged behaviour); every other value is
    // canonicalized through the same seam read()/inspect()/search() use before being matched against
    // symbol.path, so a symlink that stays inside the workspace resolves to its real target exactly
    // like search({ paths }) already does.
    let pathFilter: string | null = null;
    if (request.path) {
      const resolved = await resolveSafeRealpath(this.root, request.path);
      if (isIgnored(resolved.relative) || this.isIndexPath(resolved.absolute)) throw new Error("PATH_NOT_READABLE");
      pathFilter = resolved.relative;
    }
    return await this.runGraphQuery(request, pathFilter);
  }

  /**
   * Query engine behind graph(). `pathFilter` is either null (no path scope) or a canonical
   * workspace-relative path already validated by the caller. Split out so execute() can drive the
   * structural branch without re-validating a path it has already resolved.
   */
  private async runGraphQuery(request: GraphQueryRequest, pathFilter: string | null): Promise<GraphResult> {
    const started = performance.now();
    const maxNodes = boundedInt(request.maxNodes, 100, 1, 2000);
    if (this.generation === 0 && this.state === "absent") {
      return { status: "unavailable", symbols: [], edges: [], generation: 0, freshness: this.currentFreshness(), elapsedMs: performance.now() - started, reason: "INDEX_NOT_INITIALIZED" };
    }
    if (!this.storeReady) return { status: "unavailable", symbols: [], edges: [], generation: this.generation, freshness: this.currentFreshness(), elapsedMs: performance.now() - started, reason: "INDEX_UNAVAILABLE" };
    if (!request.query.trim()) {
      const status = this.state === "degraded" ? "degraded" : "complete";
      return { status, symbols: [], edges: [], generation: this.generation, freshness: this.currentFreshness(), elapsedMs: performance.now() - started, reason: status === "degraded" ? this.lastError ?? "parser degraded" : "empty query" };
    }
    const symbols = this.store.listSymbols();
    const edges = this.store.listEdges();
    const query = request.query.toLocaleLowerCase();
    const truncationReasons = new Set<string>();
    const matching = symbols.filter((symbol) => symbol.name.toLocaleLowerCase().includes(query) && (pathFilter === null || symbol.path === pathFilter));
    if (matching.length > maxNodes) truncationReasons.add("maxNodes");
    const matches = matching.slice(0, maxNodes);
    const selected = new Set(matches.map((symbol) => symbol.id));
    const depth = boundedInt(request.depth, 2, 0, 8);
    if (request.kind !== "query") {
      let frontier = new Set(selected);
      for (let level = 0; level < depth; level += 1) {
        const next = new Set<string>();
        for (const edge of edges) {
          abortIfNeeded(request.signal);
          const reverse = request.kind === "callers" || request.kind === "impact";
          const bidirectional = request.kind === "explore";
          const followsDependency = request.kind === "dependency" && (edge.kind === "import" || edge.kind === "dependency");
          if (frontier.has(edge.sourceId) && (request.kind === "callees" || followsDependency || bidirectional)) next.add(edge.targetId);
          if (frontier.has(edge.targetId) && (reverse || bidirectional)) next.add(edge.sourceId);
        }
        const added = [...next].some((id) => !selected.has(id));
        for (const id of next) selected.add(id);
        if (selected.size > maxNodes) truncationReasons.add("maxNodes");
        frontier = next;
        if (added && selected.size >= maxNodes) {
          truncationReasons.add("maxNodes");
          break;
        }
      }
      if (depth > 0 && frontier.size > 0) {
        const hasMore = edges.some((edge) => {
          const forward = request.kind === "callees" || request.kind === "dependency" || request.kind === "explore";
          const reverse = request.kind === "callers" || request.kind === "impact" || request.kind === "explore";
          return (forward && frontier.has(edge.sourceId) && !selected.has(edge.targetId))
            || (reverse && frontier.has(edge.targetId) && !selected.has(edge.sourceId));
        });
        if (hasMore) truncationReasons.add("depth");
      }
    }
    const selectedSymbols = symbols.filter((symbol) => selected.has(symbol.id)).slice(0, maxNodes);
    const selectedEdges = edges.filter((edge) => selected.has(edge.sourceId) && selected.has(edge.targetId)).slice(0, maxNodes * 4);
    if (edges.filter((edge) => selected.has(edge.sourceId) && selected.has(edge.targetId)).length > selectedEdges.length) truncationReasons.add("edgeCap");
    abortIfNeeded(request.signal);
    const status = this.state === "degraded" ? "degraded" : truncationReasons.size > 0 ? "partial" : "complete";
    const reason = this.state === "degraded" ? this.lastError ?? "parser degraded" : truncationReasons.size > 0 ? `graph result truncated by ${[...truncationReasons].sort().join(",")}` : undefined;
    return { status, symbols: selectedSymbols, edges: selectedEdges, generation: this.generation, freshness: this.currentFreshness(), elapsedMs: performance.now() - started, reason };
  }

  async execute(plan: RetrievalPlanInput): Promise<RetrievalPack> {
    abortIfNeeded(plan.signal);
    await this.ensureOpen();
    abortIfNeeded(plan.signal);
    const resolvedPlanPaths = plan.paths
      ? await Promise.all(plan.paths.map((item) => resolveSafeRealpath(this.root, item)))
      : undefined;
    const safePaths = resolvedPlanPaths?.map((resolved) => resolved.relative);
    // The structural branch reuses the already-validated first operand instead of calling graph(),
    // whose public seam must re-validate every operand (D23) and would therefore reject a plan whose
    // operand is a DEFAULT_IGNORES / index path that search() legitimately accepts. The pack this
    // produces is byte-for-byte the same as before the D23 fix.
    const firstPlanPath = resolvedPlanPaths?.[0];
    const graphPathFilter = firstPlanPath !== undefined && firstPlanPath.relative !== "" ? firstPlanPath.relative : null;
    const startScope = this.scope();
    const startGeneration = this.generation;
    const decisionInput = { query: plan.query, requestedIntents: plan.intents, maxCandidates: plan.maxCandidates, maxBytes: plan.maxBytes, maxNodes: plan.maxNodes, timeoutMs: plan.timeoutMs, signal: plan.signal };
    const decision = normalizeDecisionReceipt(await this.decisionProvider.decide(decisionInput), decisionInput);
    abortIfNeeded(plan.signal);
    const maxCandidates = decision.maxCandidates;
    const maxBytes = decision.maxBytes;
    const maxNodes = decision.maxNodes;
    const intents = decision.intents;
    const candidates: RetrievalCandidate[] = [];
    const facts = new Map<string, RetrievalPack["facts"][number]>();
    let status: SearchResult["status"] = "complete";
    const missing: string[] = [];
    const exactController = new AbortController();
    const graphController = new AbortController();
    if (plan.signal) plan.signal.addEventListener("abort", () => { exactController.abort(); graphController.abort(); }, { once: true });
    const exactPromise = intents.includes("exact")
      ? this.search({ query: plan.query, paths: safePaths, maxResults: maxCandidates, maxBytes, timeoutMs: decision.timeoutMs, signal: exactController.signal })
      : Promise.resolve(null);
    const graphPromise = intents.includes("structural")
      ? this.runGraphQuery({ kind: "explore", query: plan.query, path: firstPlanPath?.relative, maxNodes, depth: 2, signal: graphController.signal }, graphPathFilter).catch((error: unknown) => {
        if (!isAbortError(error)) throw error;
        return { status: "timeout", symbols: [], edges: [], generation: this.generation, freshness: this.currentFreshness(), elapsedMs: 0, reason: "cancelled by early-stop" } satisfies GraphResult;
      })
      : Promise.resolve(null);
    if (decision.earlyStop && exactPromise) {
      void exactPromise.then((result) => {
        if (result && result.hits.length >= maxCandidates) graphController.abort();
      }, () => undefined);
    }
    const [exactResult, graphResult] = await Promise.all([exactPromise, graphPromise]);
    if (exactResult) {
      status = exactResult.status;
      for (const hit of exactResult.hits) {
        const inspected = await this.inspect(hit.path);
        facts.set(hit.path, { ref: `source://${hit.path}`, path: hit.path, exists: inspected.exists, hash: inspected.hash, bytes: inspected.bytes, lineCount: inspected.lineCount });
        candidates.push({ ref: `source://${hit.path}#L${hit.line}`, path: hit.path, line: hit.line, source: "exact", inspected: inspected.exists, hash: inspected.hash });
      }
    }
    if (graphResult) {
      if (graphResult.status !== "complete" && graphResult.reason !== "cancelled by early-stop") status = graphResult.status;
      for (const symbol of graphResult.symbols.slice(0, maxCandidates)) {
        const inspected = await this.inspect(symbol.path);
        facts.set(symbol.path, { ref: `source://${symbol.path}`, path: symbol.path, exists: inspected.exists, hash: inspected.hash, bytes: inspected.bytes, lineCount: inspected.lineCount });
        candidates.push({ ref: `source://${symbol.path}#L${symbol.startLine}`, path: symbol.path, line: symbol.startLine, source: "graph", inspected: inspected.exists, hash: inspected.hash });
      }
      if (graphResult.symbols.length === 0) missing.push("structural-symbol");
    }
    if (this.generation !== startGeneration) {
      status = "stale";
      missing.push("generation-changed");
    }
    abortIfNeeded(plan.signal);
    const deduped = [...new Map(candidates.map((candidate) => [candidate.ref, candidate])).values()]
      .sort((left, right) => left.ref.localeCompare(right.ref))
      .slice(0, maxCandidates);
    if (deduped.length === 0) missing.push("candidate");
    const packWithoutHash = { packVersion: 1 as const, query: plan.query, scope: startScope, status, candidates: deduped, facts: [...facts.values()].sort((left, right) => left.path.localeCompare(right.path)), missing: [...new Set(missing)].sort(), budget: { maxCandidates, maxBytes, maxNodes }, decision, createdAt: nowIso() };
    const hashPayload = { ...packWithoutHash, createdAt: undefined, decision: { ...decision, createdAt: undefined } };
    return { ...packWithoutHash, hash: sha256Text(JSON.stringify(hashPayload)) };
  }

  startWatcher(debounceMs = 300): void {
    this.requireOpen();
    if (this.watcher) return;
    try {
      const watcher = watchFiles(this.root, { recursive: true }, () => {
        if (this.watcherTimer) clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          void this.sync().catch((error) => {
            this.state = "degraded";
            this.lastError = errorMessage(error);
            // D24: a watcher-triggered sync that failed because the watched root is gone is the
            // debounce-side proof that the watcher itself is no longer usable.
            this.reconcileWatcherLiveness();
          });
        }, debounceMs);
      });
      // D24: a successful creation is NOT proof that the watcher keeps working. On the platforms
      // that DO report a later failure, these listeners are the only signal — and without an
      // 'error' listener an emitted 'error' would become an uncaught exception. The 'close'
      // listener is filtered by identity: stopWatcher() forgets `this.watcher` BEFORE closing the
      // handle, so an expected close (the listener still holding that handle) is ignored while a
      // watcher that dies on its own degrades the reported state.
      watcher.on("error", (error: unknown) => { this.markWatcherUnavailable(errorMessage(error)); });
      watcher.on("close", () => {
        if (this.watcher !== watcher) return;
        this.markWatcherUnavailable("watcher handle closed unexpectedly");
      });
      this.watcher = watcher;
    } catch (error) {
      this.state = "degraded";
      this.lastError = `watcher: ${errorMessage(error)}`;
    }
  }

  /**
   * Record that the running watcher can no longer be trusted and tear it down. `state`/`lastError`
   * are set explicitly (keeping the `watcher: ` prefix convention of the creation-failure branch)
   * and the handle is closed, so a broken OS-level watcher stops consuming CPU over a dead tree.
   */
  private markWatcherUnavailable(reason: string): void {
    this.state = "degraded";
    this.lastError = `watcher: ${reason}`;
    this.stopWatcher();
  }

  /**
   * D24 — the observation-time half of the watcher health contract.
   *
   * Node 24.3.0 on Windows reports a deleted watched root NEITHER through 'error' NOR through
   * 'close': the handle stays "listening" and emits an unbounded phantom 'change' storm, which also
   * re-arms the debounce forever — so the debounce-side proof above never runs either. The remaining
   * honest option is to materialize the truth where the health is observed: stats() is the API that
   * reports `watcher`, and asking for it is the moment to check that the reported thing still exists.
   *
   * Cost: one synchronous stat of the watched root per stats() call, and ONLY while a watcher is
   * running — no timer, no background task, and nothing at all once the watcher is stopped or was
   * never started. Only ENOENT/ENOTDIR count as proof; any other error is treated as transient.
   */
  private reconcileWatcherLiveness(): void {
    if (!this.watcher) return;
    try {
      if (statSync(this.root).isDirectory()) return;
      this.markWatcherUnavailable(`watched root is no longer a directory: ${this.root}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return;
      this.markWatcherUnavailable(`watched root is unreachable (${code}): ${this.root}`);
    }
  }

  stopWatcher(): void {
    if (this.watcherTimer) clearTimeout(this.watcherTimer);
    this.watcherTimer = null;
    const watcher = this.watcher;
    // Forget the handle BEFORE closing it so the 'close' listener can tell an expected close apart
    // from a watcher that died on its own.
    this.watcher = null;
    if (!watcher) return;
    try { watcher.close(); } catch { /* already closed */ }
  }

  stats(): WorkerStats {
    this.requireOpen();
    this.reconcileWatcherLiveness();
    return { state: this.state, root: this.root, worktreeId: this.worktreeId, generation: this.generation, indexedFiles: this.storeReady ? this.store.count("files") : 0, indexedSymbols: this.storeReady ? this.store.count("symbols") : 0, indexedEdges: this.storeReady ? this.store.count("edges") : 0, indexBytes: this.storeReady ? this.store.indexBytes() : 0, queueDepth: this.syncing ? 1 + this.syncQueued : 0, activeReads: this.activeReads, watcher: this.watcher ? "running" : "stopped", lastError: this.lastError, processRssBytes: process.memoryUsage().rss };
  }
}

export type { WorkspaceScope };
