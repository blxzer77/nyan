/**
 * Local Retrieval Worker -> Retrieval ABI V3 adapter seam.
 *
 * The Retrieval Worker (frozen candidate `d25d33`) is a Pactile Agent
 * capability provider. It is never Product Kernel truth and never supplies AC
 * or Close Evidence. This module is the only place where Worker output is
 * translated into Retrieval ABI V3 terms, and it enforces:
 *
 * - the Worker request is derived only from the budget-truncated V3 plan
 *   steps (`exact` and `structural`; `semantic`/`external` are unsupported);
 * - scope hints must be workspace-relative contained paths; an unusable hint
 *   rejects the request instead of silently widening the scope;
 * - abort and timeout are owned by the adapter, so a transport that ignores
 *   its signal still cannot hang the Agent and late answers are discarded;
 * - the absolute workspace root and the Worker's path-derived worktree hash are
 *   dropped; Agent-facing output carries the logical `worktreeId` only;
 * - generation/snapshot fencing marks mismatched output `stale`;
 * - Worker output is `candidate` only. Worker-observed file hashes are carried
 *   as metadata and never count as corroboration; corroboration must come from
 *   an independent Agent source read, Git evidence or a repeatable test.
 *
 * Provider identity, host identity and host routing never appear in the
 * result. Transport error text is never propagated (it may contain host paths).
 */

import { Buffer } from "node:buffer";

import {
  type AssuranceLevelV1,
  type PactileIntentV1,
  type ResolvedProviderV1,
} from "../../providers/contract.js";
import { fingerprintPactileContractV1 } from "../../shared/validation.js";
import { snapshotPlainOwnDataRecordV3 } from "../boundary.js";
import {
  assessRetrievalClaimV3,
  isRetrievalLogicalRefV3,
} from "../evidence.js";
import {
  RETRIEVAL_ABI_VERSION,
  RETRIEVAL_REASON_CODES_V3,
  type RetrievalClaimAssessmentV3,
  type RetrievalEvidenceFactV3,
  type RetrievalPlanV3,
  type RetrievalProviderAvailabilityV3,
  type RetrievalProviderStatusV3,
  type RetrievalReasonCodeV3,
  type RetrievalVerificationStageV3,
} from "../types.js";

export const LOCAL_WORKER_ADAPTER_VERSION_V1 = 1 as const;
/** Wire `packVersion` produced by the frozen Worker candidate. */
export const LOCAL_WORKER_PACK_VERSION_V1 = 1 as const;
/** Frozen candidate `engines.node` is `>=24.0.0`; evaluated on v24.3.0 only. */
export const LOCAL_WORKER_MIN_NODE_MAJOR_V1 = 24;

/** Worker-side clamps (frozen candidate `decision.ts`). */
const WORKER_MAX_CANDIDATES = 200;
const DEFAULT_MAX_BYTES = 128 * 1024;
const MIN_MAX_BYTES = 256;
const MAX_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_NODES = 150;
const MAX_MAX_NODES = 2000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 20;
const MAX_TIMEOUT_MS = 300_000;
/** Adapter deadline = Worker timeout + grace for process/IPC overhead. */
export const LOCAL_WORKER_TIMEOUT_GRACE_MS_V1 = 2_000;

const MAX_PATH_BYTES = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LOGICAL_WORKTREE_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const GLOB_CHARS = /[*?[\]{}]/u;
const WORKER_SEARCH_STATUSES = new Set([
  "complete",
  "partial",
  "timeout",
  "limit_hit",
  "stale",
  "degraded",
  "unsupported",
  "parse_failed",
  "unavailable",
]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);

export type LocalWorkerIntentV1 = "exact" | "structural";
export type LocalWorkerFreshnessV1 = "fresh" | "stale" | "unknown";

export interface LocalWorkerExecuteRequestV1 {
  readonly query: string;
  readonly intents: readonly LocalWorkerIntentV1[];
  readonly paths?: readonly string[];
  readonly maxCandidates: number;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly timeoutMs: number;
}

/**
 * Transport to one Worker instance. Implementations must honour `signal`
 * (e.g. by terminating the Worker process); the adapter does not rely on it.
 * The resolved value is untrusted wire data.
 */
export interface LocalWorkerTransportV1 {
  execute(
    request: LocalWorkerExecuteRequestV1,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface LocalWorkerScopeV1 {
  /** Agent-owned logical worktree id; never derived from a host path. */
  readonly worktreeId: string;
  /** Generation the Agent last observed; `null` accepts the current one. */
  readonly expectedGeneration: number | null;
  /** Snapshot the Agent last observed; `null` accepts the current one. */
  readonly expectedSnapshot: string | null;
}

export interface RunLocalWorkerRetrievalInputV1 {
  readonly plan: RetrievalPlanV3;
  readonly scope: LocalWorkerScopeV1;
  readonly transport: LocalWorkerTransportV1;
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export const LOCAL_WORKER_STOP_CODES_V1 = [
  "invalid-plan",
  "invalid-scope",
  "scope-hint-rejected",
  "no-local-intent",
  "intent-unsupported",
  "structural-path-scope-unsupported",
  "provider-not-ready",
  "aborted",
  "timeout",
  "transport-failed",
  "invalid-response",
  "path-containment-violation",
  "non-local-decision-provider",
  "generation-mismatch",
  "snapshot-mismatch",
  "generation-changed-during-execute",
  "index-not-fresh",
  "worker-status-degraded",
  "worker-status-unavailable",
  "worker-status-unsupported",
  "worker-timeout",
  "worker-budget-limited",
  "budget-clamped",
  "worker-added-exact-dropped",
  "ref-not-representable",
] as const;

export type LocalWorkerStopCodeV1 = (typeof LOCAL_WORKER_STOP_CODES_V1)[number];

export interface LocalWorkerStopReasonV1 {
  readonly code: LocalWorkerStopCodeV1;
  readonly intent: PactileIntentV1 | null;
  readonly blocking: boolean;
}

export type LocalWorkerOutcomeV1 =
  | "candidates"
  | "empty"
  | "stale"
  | "aborted"
  | "timeout"
  | "rejected"
  | "failed";

export interface LocalWorkerCandidateV1 {
  readonly role: "candidate";
  readonly intent: LocalWorkerIntentV1;
  /** Workspace-relative POSIX path. */
  readonly sourcePath: string;
  /** 1-based line; kept separate because the V3 ref grammar has no line. */
  readonly line: number | null;
  /** V3 logical ref, or `null` when the path is not representable in V3. */
  readonly evidenceRef: string | null;
  /** Hash the Worker observed; metadata only, never corroboration. */
  readonly workerObservedSha256: string | null;
  readonly generation: number;
  readonly snapshot: string;
  readonly freshness: LocalWorkerFreshnessV1;
}

export type LocalWorkerCoverageV1 = "complete" | "partial" | "unknown";

export type LocalWorkerIntentStateV1 =
  | Exclude<RetrievalProviderStatusV3, "resolution-required">
  | "not-requested";

export interface LocalWorkerIntentStatusV1 {
  readonly intent: PactileIntentV1;
  readonly status: LocalWorkerIntentStateV1;
}

export interface LocalWorkerRetrievalResultV1 {
  readonly adapterVersion: typeof LOCAL_WORKER_ADAPTER_VERSION_V1;
  readonly abiVersion: typeof RETRIEVAL_ABI_VERSION;
  readonly planFingerprint: string;
  readonly worktreeId: string;
  readonly outcome: LocalWorkerOutcomeV1;
  readonly intentStatus: readonly LocalWorkerIntentStatusV1[];
  readonly generation: number | null;
  readonly snapshot: string | null;
  readonly freshness: LocalWorkerFreshnessV1;
  /**
   * `complete` only when the Worker reported `complete` and returned fewer
   * candidates than the cap. Absence/exhaustive claims require `complete`.
   */
  readonly coverage: LocalWorkerCoverageV1;
  readonly candidates: readonly LocalWorkerCandidateV1[];
  readonly stopReasons: readonly LocalWorkerStopReasonV1[];
  readonly fallback: {
    readonly intent: "exact";
    /** True when the plan has no exact step, so the Agent must re-plan. */
    readonly requiresReplan: boolean;
  } | null;
  readonly closeEvidenceEligible: false;
  readonly notAcEvidence: true;
}

/* ------------------------------------------------------------- helpers */

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize a workspace-relative path. Returns `null` for absolute, drive,
 * UNC, home, parent-traversal, empty-segment or control-character input.
 */
export function normalizeLocalWorkerRelativePathV1(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES)
    return null;
  if (/\p{Cc}/u.test(value)) return null;
  const slashed = value.replaceAll("\\", "/");
  if (
    slashed.startsWith("/") ||
    slashed.startsWith("~") ||
    /^[A-Za-z]:/u.test(slashed)
  ) {
    return null;
  }
  const segments = slashed.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function withinScope(relative: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return true;
  return scopes.some(
    (scope) => relative === scope || relative.startsWith(`${scope}/`),
  );
}

function planIsIntact(plan: RetrievalPlanV3): boolean {
  const record = snapshotPlainOwnDataRecordV3(plan);
  if (!record || typeof record.fingerprint !== "string") return false;
  if (record.schemaVersion !== RETRIEVAL_ABI_VERSION) return false;
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "fingerprint") unsigned[key] = value;
  }
  return fingerprintPactileContractV1(unsigned) === record.fingerprint;
}

/* ------------------------------------------------------ wire validation */

interface WorkerCandidateWire {
  readonly path: string;
  readonly line: number | null;
  readonly source: "exact" | "graph";
  readonly hash: string | null;
}

interface WorkerPackWire {
  readonly query: string;
  readonly generation: number;
  readonly snapshot: string;
  readonly freshness: LocalWorkerFreshnessV1;
  readonly status: string;
  readonly candidates: readonly WorkerCandidateWire[];
  readonly missing: readonly string[];
  readonly decisionProvider: string;
}

const PACK_KEYS = [
  "budget",
  "candidates",
  "createdAt",
  "decision",
  "facts",
  "hash",
  "missing",
  "packVersion",
  "query",
  "scope",
  "status",
];
const SCOPE_KEYS = ["freshness", "generation", "root", "snapshot", "worktreeId"];
const CANDIDATE_KEYS = ["hash", "inspected", "line", "path", "ref", "source"];

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

/**
 * Strictly parse the frozen Worker `RetrievalPack` v1 and correlate it with
 * the request query; `null` when invalid or uncorrelated.
 */
function parseWorkerPack(
  raw: unknown,
  expectedQuery: string,
): WorkerPackWire | null {
  const pack = snapshotPlainOwnDataRecordV3(raw);
  if (!pack || !exactKeys(pack, PACK_KEYS)) return null;
  if (pack.packVersion !== LOCAL_WORKER_PACK_VERSION_V1) return null;
  if (pack.query !== expectedQuery) return null;
  if (typeof pack.status !== "string" || !WORKER_SEARCH_STATUSES.has(pack.status))
    return null;
  const scope = snapshotPlainOwnDataRecordV3(pack.scope);
  if (!scope || !exactKeys(scope, SCOPE_KEYS)) return null;
  if (
    typeof scope.root !== "string" ||
    typeof scope.worktreeId !== "string" ||
    !Number.isSafeInteger(scope.generation) ||
    (scope.generation as number) < 0 ||
    typeof scope.snapshot !== "string" ||
    typeof scope.freshness !== "string" ||
    !FRESHNESS_VALUES.has(scope.freshness)
  ) {
    return null;
  }
  if (!Array.isArray(pack.candidates) || !Array.isArray(pack.missing))
    return null;
  if (!pack.missing.every((item) => typeof item === "string")) return null;
  const decision = snapshotPlainOwnDataRecordV3(pack.decision);
  if (!decision || typeof decision.provider !== "string") return null;
  const candidates: WorkerCandidateWire[] = [];
  for (const item of pack.candidates) {
    const candidate = snapshotPlainOwnDataRecordV3(item);
    if (!candidate || !exactKeys(candidate, CANDIDATE_KEYS)) return null;
    const line = candidate.line;
    const hash = candidate.hash;
    if (
      typeof candidate.path !== "string" ||
      (candidate.source !== "exact" && candidate.source !== "graph") ||
      typeof candidate.inspected !== "boolean" ||
      typeof candidate.ref !== "string" ||
      !(line === null || (Number.isSafeInteger(line) && (line as number) >= 1)) ||
      !(hash === null || (typeof hash === "string" && SHA256_HEX.test(hash)))
    ) {
      return null;
    }
    candidates.push({
      path: candidate.path,
      line: line as number | null,
      source: candidate.source,
      hash: hash as string | null,
    });
  }
  return {
    query: expectedQuery,
    generation: scope.generation as number,
    snapshot: scope.snapshot,
    freshness: scope.freshness as LocalWorkerFreshnessV1,
    status: pack.status,
    candidates,
    missing: pack.missing as string[],
    decisionProvider: decision.provider,
  };
}

/* -------------------------------------------------------- result build */

class ResultBuilder {
  readonly stops: LocalWorkerStopReasonV1[] = [];
  readonly status = new Map<PactileIntentV1, LocalWorkerIntentStateV1>();
  fallbackRequired = false;

  constructor(private readonly plan: RetrievalPlanV3) {
    for (const intent of plan.intents) this.status.set(intent, "not-requested");
  }

  stop(
    code: LocalWorkerStopCodeV1,
    intent: PactileIntentV1 | null,
    blocking: boolean,
  ): void {
    if (
      !this.stops.some(
        (item) =>
          item.code === code &&
          item.intent === intent &&
          item.blocking === blocking,
      )
    ) {
      this.stops.push({ code, intent, blocking });
    }
  }

  build(
    worktreeId: string,
    outcome: LocalWorkerOutcomeV1,
    observed: {
      generation: number | null;
      snapshot: string | null;
      freshness: LocalWorkerFreshnessV1;
    },
    candidates: readonly LocalWorkerCandidateV1[],
    coverage: LocalWorkerCoverageV1 = "unknown",
  ): LocalWorkerRetrievalResultV1 {
    const order = new Map(LOCAL_WORKER_STOP_CODES_V1.map((c, i) => [c, i]));
    const hasExactStep = this.plan.steps.some((step) => step.intent === "exact");
    return {
      adapterVersion: LOCAL_WORKER_ADAPTER_VERSION_V1,
      abiVersion: RETRIEVAL_ABI_VERSION,
      planFingerprint: this.plan.fingerprint,
      worktreeId,
      outcome,
      intentStatus: [...this.status.entries()].map(([intent, status]) => ({
        intent,
        status,
      })),
      generation: observed.generation,
      snapshot: observed.snapshot,
      freshness: observed.freshness,
      coverage,
      candidates,
      stopReasons: [...this.stops].sort(
        (left, right) =>
          (order.get(left.code) ?? 999) - (order.get(right.code) ?? 999) ||
          utf8Compare(left.intent ?? "", right.intent ?? ""),
      ),
      fallback: this.fallbackRequired
        ? { intent: "exact", requiresReplan: !hasExactStep }
        : null,
      closeEvidenceEligible: false,
      notAcEvidence: true,
    };
  }
}

const NOT_OBSERVED = {
  generation: null,
  snapshot: null,
  freshness: "unknown",
} as const;

class AdapterDeadline extends Error {
  constructor(readonly kind: "aborted" | "timeout") {
    super(kind);
  }
}

/**
 * Run one plan against a local Worker transport and return V3 candidates.
 * Never throws for Worker/transport faults; faults become stop reasons.
 */
export async function runLocalWorkerRetrievalV1(
  input: RunLocalWorkerRetrievalInputV1,
): Promise<LocalWorkerRetrievalResultV1> {
  const { plan, scope, transport } = input;
  const builder = new ResultBuilder(plan);
  const worktreeId = scope.worktreeId;

  if (!planIsIntact(plan)) {
    builder.stop("invalid-plan", null, true);
    return builder.build(worktreeId, "rejected", NOT_OBSERVED, []);
  }
  if (
    typeof worktreeId !== "string" ||
    !LOGICAL_WORKTREE_ID.test(worktreeId) ||
    !(
      scope.expectedGeneration === null ||
      (Number.isSafeInteger(scope.expectedGeneration) &&
        scope.expectedGeneration >= 0)
    ) ||
    !(scope.expectedSnapshot === null || typeof scope.expectedSnapshot === "string")
  ) {
    builder.stop("invalid-scope", null, true);
    return builder.build(
      typeof worktreeId === "string" && LOGICAL_WORKTREE_ID.test(worktreeId)
        ? worktreeId
        : "invalid",
      "rejected",
      NOT_OBSERVED,
      [],
    );
  }

  // 1. Intents come from the budget-truncated steps, not from plan.intents.
  const intents: LocalWorkerIntentV1[] = [];
  for (const step of plan.steps) {
    if (step.intent === "exact") {
      intents.push("exact");
    } else if (step.intent === "structural") {
      const status = step.providerRequirement?.status ?? "resolution-required";
      if (status === "ready") {
        intents.push("structural");
      } else {
        builder.stop("provider-not-ready", "structural", true);
        builder.status.set(
          "structural",
          status === "resolution-required" ? "unavailable" : status,
        );
        builder.fallbackRequired = true;
      }
    } else {
      builder.stop("intent-unsupported", step.intent, true);
      builder.status.set(step.intent, "unsupported");
      builder.fallbackRequired = true;
    }
  }
  if (intents.length === 0) {
    builder.stop("no-local-intent", null, true);
    return builder.build(worktreeId, "rejected", NOT_OBSERVED, []);
  }

  // 2. Scope hints must be contained relative paths; never widen silently.
  const paths: string[] = [];
  for (const hint of plan.scopeHints) {
    const normalized = normalizeLocalWorkerRelativePathV1(hint);
    if (normalized === null || GLOB_CHARS.test(normalized)) {
      builder.stop("scope-hint-rejected", null, true);
    } else if (!paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  if (builder.stops.some((item) => item.code === "scope-hint-rejected")) {
    return builder.build(worktreeId, "rejected", NOT_OBSERVED, []);
  }
  // P3 contract finding (REPRO-D30): the frozen Worker filters structural
  // results by exact equality with the FIRST path only, so a directory or
  // multi-path scope silently returns an empty `complete` result. Never send
  // a path-scoped structural step; fall back to exact instead.
  if (paths.length > 0 && intents.includes("structural")) {
    intents.splice(intents.indexOf("structural"), 1);
    builder.stop("structural-path-scope-unsupported", "structural", true);
    builder.status.set("structural", "unsupported");
    builder.fallbackRequired = true;
    if (intents.length === 0) {
      builder.stop("no-local-intent", null, true);
      return builder.build(worktreeId, "rejected", NOT_OBSERVED, []);
    }
  }

  // 3. Budget.
  const maxCandidates = Math.min(
    plan.budget.maxCandidatesPerStep,
    WORKER_MAX_CANDIDATES,
  );
  if (maxCandidates < plan.budget.maxCandidatesPerStep) {
    builder.stop("budget-clamped", null, false);
  }
  const timeoutMs = clampInt(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  // The frozen rule planner always adds `exact`; request it explicitly so the
  // wire request states what the Worker will actually run.
  const workerIntents: LocalWorkerIntentV1[] = intents.includes("exact")
    ? [...intents]
    : ["exact", ...intents];
  const request: LocalWorkerExecuteRequestV1 = {
    query: plan.query,
    intents: workerIntents,
    ...(paths.length > 0 ? { paths } : {}),
    maxCandidates,
    maxBytes: clampInt(input.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES),
    maxNodes: clampInt(input.maxNodes, DEFAULT_MAX_NODES, 1, MAX_MAX_NODES),
    timeoutMs,
  };
  for (const intent of intents) builder.status.set(intent, "ready");

  // 4. Execute with adapter-owned abort + deadline.
  const controller = new AbortController();
  let raw: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      const fail = (kind: "aborted" | "timeout"): void => {
        if (!controller.signal.aborted) controller.abort(kind);
        reject(new AdapterDeadline(kind));
      };
      if (input.signal?.aborted) {
        fail("aborted");
        return;
      }
      onAbort = () => fail("aborted");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => fail("timeout"),
        timeoutMs + LOCAL_WORKER_TIMEOUT_GRACE_MS_V1,
      );
    });
    deadline.catch(() => undefined);
    raw = await Promise.race([
      Promise.resolve().then(() => transport.execute(request, controller.signal)),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof AdapterDeadline) {
      builder.stop(error.kind, null, true);
      for (const intent of intents) builder.status.set(intent, "unavailable");
      return builder.build(worktreeId, error.kind, NOT_OBSERVED, []);
    }
    builder.stop("transport-failed", null, true);
    for (const intent of intents) builder.status.set(intent, "unavailable");
    builder.fallbackRequired = intents.includes("structural");
    return builder.build(worktreeId, "failed", NOT_OBSERVED, []);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
  if (controller.signal.aborted) {
    // A deadline fired in the same tick the transport settled.
    const kind = controller.signal.reason === "timeout" ? "timeout" : "aborted";
    builder.stop(kind, null, true);
    return builder.build(worktreeId, kind, NOT_OBSERVED, []);
  }

  // 5. Validate the untrusted pack.
  const pack = parseWorkerPack(raw, plan.query);
  if (pack === null) {
    builder.stop("invalid-response", null, true);
    for (const intent of intents) builder.status.set(intent, "degraded");
    builder.fallbackRequired = intents.includes("structural");
    return builder.build(worktreeId, "failed", NOT_OBSERVED, []);
  }
  if (pack.candidates.length > maxCandidates) {
    builder.stop("invalid-response", null, true);
    return builder.build(worktreeId, "failed", NOT_OBSERVED, []);
  }
  if (pack.decisionProvider !== "rule") {
    // Only the local rule planner is allowed; any other planner may have
    // egressed the query and is not covered by the P7 gate.
    builder.stop("non-local-decision-provider", null, true);
    return builder.build(worktreeId, "rejected", NOT_OBSERVED, []);
  }
  const observed = {
    generation: pack.generation,
    snapshot: pack.snapshot,
    freshness: pack.freshness,
  };

  // 6. Containment: every candidate path relative and inside requested scope.
  const candidates: LocalWorkerCandidateV1[] = [];
  for (const wire of pack.candidates) {
    const sourcePath = normalizeLocalWorkerRelativePathV1(wire.path);
    if (sourcePath === null || !withinScope(sourcePath, paths)) {
      builder.stop("path-containment-violation", null, true);
      for (const intent of intents) builder.status.set(intent, "degraded");
      return builder.build(worktreeId, "failed", observed, []);
    }
    const intent: LocalWorkerIntentV1 =
      wire.source === "graph" ? "structural" : "exact";
    if (!workerIntents.includes(intent)) {
      builder.stop("invalid-response", intent, true);
      return builder.build(worktreeId, "failed", observed, []);
    }
    if (!intents.includes(intent)) {
      // Planner-added exact hits are not part of this plan; never surface them.
      builder.stop("worker-added-exact-dropped", "exact", false);
      continue;
    }
    const ref = `source://${sourcePath}`;
    const evidenceRef = isRetrievalLogicalRefV3(ref) ? ref : null;
    if (evidenceRef === null) builder.stop("ref-not-representable", intent, false);
    candidates.push({
      role: "candidate",
      intent,
      sourcePath,
      line: wire.line,
      evidenceRef,
      workerObservedSha256: wire.hash,
      generation: pack.generation,
      snapshot: pack.snapshot,
      freshness: pack.freshness,
    });
  }
  candidates.sort(
    (left, right) =>
      utf8Compare(left.intent, right.intent) ||
      utf8Compare(left.sourcePath, right.sourcePath) ||
      (left.line ?? 0) - (right.line ?? 0),
  );

  // 7. Generation / snapshot fencing.
  let stale = false;
  if (
    scope.expectedGeneration !== null &&
    pack.generation !== scope.expectedGeneration
  ) {
    builder.stop("generation-mismatch", null, true);
    stale = true;
  }
  if (
    scope.expectedSnapshot !== null &&
    pack.snapshot !== scope.expectedSnapshot
  ) {
    builder.stop("snapshot-mismatch", null, true);
    stale = true;
  }
  if (pack.status === "stale" || pack.missing.includes("generation-changed")) {
    builder.stop("generation-changed-during-execute", null, true);
    stale = true;
  }

  // 8. Worker status / index freshness.
  if (intents.includes("structural") && pack.freshness !== "fresh") {
    builder.stop("index-not-fresh", "structural", true);
    builder.status.set("structural", "degraded");
    builder.fallbackRequired = true;
  }
  switch (pack.status) {
    case "partial":
    case "limit_hit":
      builder.stop("worker-budget-limited", null, false);
      break;
    case "timeout":
      builder.stop("worker-timeout", null, false);
      for (const intent of intents) builder.status.set(intent, "degraded");
      break;
    case "degraded":
    case "parse_failed":
      builder.stop("worker-status-degraded", null, true);
      for (const intent of intents) builder.status.set(intent, "degraded");
      builder.fallbackRequired = intents.includes("structural");
      break;
    case "unsupported":
      builder.stop("worker-status-unsupported", null, true);
      for (const intent of intents) builder.status.set(intent, "unsupported");
      builder.fallbackRequired = intents.includes("structural");
      break;
    case "unavailable":
      builder.stop("worker-status-unavailable", null, true);
      for (const intent of intents) builder.status.set(intent, "unavailable");
      builder.fallbackRequired = intents.includes("structural");
      break;
    default:
      break;
  }

  if (stale) {
    for (const intent of intents) builder.status.set(intent, "degraded");
    return builder.build(
      worktreeId,
      "stale",
      { ...observed, freshness: "stale" },
      candidates.map((candidate) => ({ ...candidate, freshness: "stale" })),
    );
  }
  const coverage: LocalWorkerCoverageV1 =
    pack.status === "complete" && pack.candidates.length < maxCandidates
      ? "complete"
      : "partial";
  return builder.build(
    worktreeId,
    candidates.length > 0 ? "candidates" : "empty",
    observed,
    candidates,
    coverage,
  );
}

/* ----------------------------------------- corroboration and assessment */

/** An Agent-side read of the current source, independent of the Worker. */
export interface LocalWorkerAgentSourceReadV1 {
  readonly sourcePath: string;
  readonly sha256: string;
}

export type LocalWorkerCorroborationIssueV1 =
  | "path-mismatch"
  | "ref-not-representable"
  | "worker-hash-missing"
  | "invalid-agent-read"
  | "content-changed";

export interface LocalWorkerCorroborationV1 {
  readonly fact: RetrievalEvidenceFactV3 | null;
  readonly issue: LocalWorkerCorroborationIssueV1 | null;
}

/**
 * Produce a `source-reference` fact only when the Agent's independent read
 * of the same path matches the content the Worker observed. A mismatch means
 * the candidate is stale relative to the current source.
 */
export function corroborateLocalWorkerCandidateV1(
  candidate: LocalWorkerCandidateV1,
  read: LocalWorkerAgentSourceReadV1,
): LocalWorkerCorroborationV1 {
  if (
    typeof read.sha256 !== "string" ||
    !SHA256_HEX.test(read.sha256) ||
    normalizeLocalWorkerRelativePathV1(read.sourcePath) === null
  ) {
    return { fact: null, issue: "invalid-agent-read" };
  }
  if (normalizeLocalWorkerRelativePathV1(read.sourcePath) !== candidate.sourcePath)
    return { fact: null, issue: "path-mismatch" };
  if (candidate.evidenceRef === null)
    return { fact: null, issue: "ref-not-representable" };
  if (candidate.workerObservedSha256 === null)
    return { fact: null, issue: "worker-hash-missing" };
  if (candidate.workerObservedSha256 !== read.sha256)
    return { fact: null, issue: "content-changed" };
  return {
    fact: { kind: "source-reference", ref: candidate.evidenceRef },
    issue: null,
  };
}

/**
 * Candidate refs for one intent that may enter V3 assessment. Empty unless
 * the run produced live candidates and no blocking stop applies to `intent`.
 */
export function localWorkerCandidateRefsV1(
  result: LocalWorkerRetrievalResultV1,
  intent: LocalWorkerIntentV1,
): readonly string[] {
  if (result.outcome !== "candidates") return [];
  if (
    result.stopReasons.some(
      (stop) => stop.blocking && (stop.intent === null || stop.intent === intent),
    )
  ) {
    return [];
  }
  return [
    ...new Set(
      result.candidates
        .filter((candidate) => candidate.intent === intent)
        .flatMap((candidate) =>
          candidate.evidenceRef === null ? [] : [candidate.evidenceRef],
        ),
    ),
  ].sort(utf8Compare);
}

/**
 * Thin wrapper over `assessRetrievalClaimV3`. The Worker contributes
 * candidate refs only; corroboration and (for structural) the resolved
 * provider proof must be supplied by the Agent.
 */
function sortedLocalWorkerReasonCodes(
  values: readonly RetrievalReasonCodeV3[],
): readonly RetrievalReasonCodeV3[] {
  const rank = new Map(
    RETRIEVAL_REASON_CODES_V3.map((code, index) => [code, index]),
  );
  return [...new Set(values)].sort(
    (left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999),
  );
}

export function assessLocalWorkerClaimV1(input: {
  readonly plan: RetrievalPlanV3;
  readonly result: LocalWorkerRetrievalResultV1;
  readonly intent: LocalWorkerIntentV1;
  readonly corroboration: readonly RetrievalEvidenceFactV3[];
  readonly resolution?: ResolvedProviderV1;
}): RetrievalClaimAssessmentV3 {
  const assessment = assessRetrievalClaimV3({
    plan: input.plan,
    intent: input.intent,
    candidateRefs: [...localWorkerCandidateRefsV1(input.result, input.intent)],
    corroboration: input.corroboration.map((fact) => ({
      kind: fact.kind,
      ref: fact.ref,
    })),
    ...(input.resolution === undefined
      ? {}
      : { resolution: input.resolution as unknown }),
  });
  const runtimeStatus = input.result.intentStatus.find(
    (item) => item.intent === input.intent,
  )?.status;
  const runtimeDegraded =
    runtimeStatus === "degraded" ||
    input.result.stopReasons.some(
      (stop) =>
        (stop.code === "worker-timeout" ||
          stop.code === "worker-status-degraded" ||
          stop.code === "index-not-fresh") &&
        (stop.intent === null || stop.intent === input.intent),
    );
  if (!runtimeDegraded) return assessment;
  return {
    ...assessment,
    accepted: false,
    achievedAssurance: null,
    reasonCodes: sortedLocalWorkerReasonCodes([
      ...assessment.reasonCodes,
      "provider-degraded",
    ]),
  };
}

/* --------------------------------------------- verification chain */

export type LocalWorkerStageStatusV1 = "passed" | "stopped" | "skipped";

export interface LocalWorkerStageTraceV1 {
  readonly stage: RetrievalVerificationStageV3["stage"];
  readonly status: LocalWorkerStageStatusV1;
  readonly reasonCodes: readonly (LocalWorkerStopCodeV1 | RetrievalReasonCodeV3 | LocalWorkerCorroborationIssueV1)[];
}

/**
 * What the Agent Context Pipeline may inject. `retrieval-candidate` is an
 * unverified hint; `retrieval-claim` carries the V3-assessed assurance. No
 * item is ever Kernel Evidence, Close Evidence or a Memory record.
 */
export interface LocalWorkerContextItemV1 {
  readonly kind: "retrieval-candidate" | "retrieval-claim";
  readonly intent: LocalWorkerIntentV1;
  readonly sourcePath: string;
  readonly line: number | null;
  readonly evidenceRef: string | null;
  readonly assurance: AssuranceLevelV1 | null;
  readonly coverage: LocalWorkerCoverageV1;
  /** Set when a structural request was answered by the exact fallback. */
  readonly downgradedFrom: "structural" | null;
  readonly generation: number;
  readonly snapshot: string;
  readonly kernelEvidence: false;
  readonly closeEvidenceEligible: false;
  readonly memoryEligible: false;
}

export interface LocalWorkerVerificationTraceV1 {
  readonly requestedIntent: LocalWorkerIntentV1;
  readonly effectiveIntent: LocalWorkerIntentV1;
  readonly stages: readonly LocalWorkerStageTraceV1[];
  readonly assessment: RetrievalClaimAssessmentV3;
  readonly staleCandidates: readonly string[];
  readonly contextItems: readonly LocalWorkerContextItemV1[];
}

function stageTrace(
  stage: RetrievalVerificationStageV3["stage"],
  status: LocalWorkerStageStatusV1,
  reasonCodes: LocalWorkerStageTraceV1["reasonCodes"] = [],
): LocalWorkerStageTraceV1 {
  return { stage, status, reasonCodes: [...new Set(reasonCodes)] };
}

/**
 * Run the fixed V3 verification chain
 * `candidate -> corroborate -> classify-evidence -> check-assurance ->
 * accept-or-stop` over one adapter result. Corroboration only comes from
 * `agentReads` (independent Agent source reads); Worker facts never count.
 */
export function runLocalWorkerVerificationChainV1(input: {
  readonly plan: RetrievalPlanV3;
  readonly result: LocalWorkerRetrievalResultV1;
  readonly requestedIntent: LocalWorkerIntentV1;
  readonly agentReads: readonly LocalWorkerAgentSourceReadV1[];
  readonly resolution?: ResolvedProviderV1;
}): LocalWorkerVerificationTraceV1 {
  const { plan, result, requestedIntent } = input;
  let effectiveIntent = requestedIntent;
  if (
    requestedIntent === "structural" &&
    localWorkerCandidateRefsV1(result, "structural").length === 0 &&
    result.fallback !== null &&
    !result.fallback.requiresReplan
  ) {
    effectiveIntent = "exact";
  }
  const downgradedFrom =
    effectiveIntent === requestedIntent ? null : ("structural" as const);
  const blockingCodes = result.stopReasons
    .filter(
      (stop) =>
        stop.blocking &&
        (stop.intent === null || stop.intent === effectiveIntent),
    )
    .map((stop) => stop.code);
  const refs = new Set(localWorkerCandidateRefsV1(result, effectiveIntent));
  const live = result.candidates.filter(
    (candidate) =>
      candidate.intent === effectiveIntent &&
      candidate.evidenceRef !== null &&
      refs.has(candidate.evidenceRef),
  );

  const facts: RetrievalEvidenceFactV3[] = [];
  const issues: LocalWorkerCorroborationIssueV1[] = [];
  const corroborated = new Set<string>();
  const staleCandidates = new Set<string>();
  for (const candidate of live) {
    const read = input.agentReads.find(
      (item) =>
        normalizeLocalWorkerRelativePathV1(item.sourcePath) ===
        candidate.sourcePath,
    );
    if (read === undefined) continue;
    const outcome = corroborateLocalWorkerCandidateV1(candidate, read);
    if (outcome.fact) {
      if (!corroborated.has(outcome.fact.ref)) facts.push(outcome.fact);
      corroborated.add(outcome.fact.ref);
    } else if (outcome.issue) {
      issues.push(outcome.issue);
      if (outcome.issue === "content-changed")
        staleCandidates.add(candidate.sourcePath);
    }
  }

  const assessment = assessLocalWorkerClaimV1({
    plan,
    result,
    intent: effectiveIntent,
    corroboration: facts,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
  });
  const stages: LocalWorkerStageTraceV1[] = [
    live.length > 0
      ? stageTrace("candidate", "passed")
      : stageTrace("candidate", "stopped", [...blockingCodes, "candidate-missing"]),
    facts.length > 0
      ? stageTrace("corroborate", "passed", issues)
      : stageTrace("corroborate", live.length > 0 ? "stopped" : "skipped", [
          ...issues,
          "corroboration-required",
        ]),
    stageTrace("classify-evidence", facts.length > 0 ? "passed" : "skipped"),
    stageTrace(
      "check-assurance",
      assessment.accepted ? "passed" : "stopped",
      assessment.reasonCodes,
    ),
    stageTrace(
      "accept-or-stop",
      assessment.accepted ? "passed" : "stopped",
      assessment.reasonCodes,
    ),
  ];

  const contextItems: LocalWorkerContextItemV1[] = live
    .filter((candidate) => !staleCandidates.has(candidate.sourcePath))
    .map((candidate) => {
      const claimed =
        assessment.accepted &&
        candidate.evidenceRef !== null &&
        corroborated.has(candidate.evidenceRef);
      return {
        kind: claimed ? "retrieval-claim" : "retrieval-candidate",
        intent: candidate.intent,
        sourcePath: candidate.sourcePath,
        line: candidate.line,
        evidenceRef: candidate.evidenceRef,
        assurance: claimed ? assessment.achievedAssurance : null,
        coverage: result.coverage,
        downgradedFrom,
        generation: candidate.generation,
        snapshot: candidate.snapshot,
        kernelEvidence: false,
        closeEvidenceEligible: false,
        memoryEligible: false,
      };
    });

  return {
    requestedIntent,
    effectiveIntent,
    stages,
    assessment,
    staleCandidates: [...staleCandidates].sort(utf8Compare),
    contextItems,
  };
}

/* ---------------------------------------------- readiness and recovery */

/** Facts gathered by a transport handshake; contains no host path. */
export interface LocalWorkerHandshakeV1 {
  readonly nodeVersion: string;
  readonly sqliteAvailable: boolean;
  readonly workerState: string;
  readonly generation: number;
  readonly snapshot: string;
  readonly freshness: LocalWorkerFreshnessV1;
}

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\.\d+\.\d+/u.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Neutral V3 availability for the structural intent. The Agent passes this
 * into `createRetrievalPlanV3` as `providerAvailability`; no identity leaks.
 */
export function localWorkerStructuralAvailabilityV1(
  handshake: LocalWorkerHandshakeV1 | null,
  minimumNodeMajor: number = LOCAL_WORKER_MIN_NODE_MAJOR_V1,
): RetrievalProviderAvailabilityV3 {
  if (handshake === null) {
    return { intent: "structural", status: "unavailable", readiness: "unavailable" };
  }
  const major = nodeMajor(handshake.nodeVersion);
  if (major === null || major < minimumNodeMajor || !handshake.sqliteAvailable) {
    return { intent: "structural", status: "unsupported", readiness: "unavailable" };
  }
  switch (handshake.workerState) {
    case "ready":
      return handshake.generation > 0 && handshake.freshness === "fresh"
        ? { intent: "structural", status: "ready", readiness: "ready" }
        : { intent: "structural", status: "degraded", readiness: "degraded" };
    case "stale":
    case "syncing":
    case "degraded":
      return handshake.generation > 0
        ? { intent: "structural", status: "degraded", readiness: "degraded" }
        : { intent: "structural", status: "unavailable", readiness: "unavailable" };
    default:
      return { intent: "structural", status: "unavailable", readiness: "unavailable" };
  }
}

export type LocalWorkerIndexEffectV1 =
  | "committed"
  | "not-committed"
  | "indeterminate";

/**
 * Reconcile an index write (`init`/`sync`) whose outcome is unknown because
 * the Worker was terminated, by comparing the generation/snapshot observed
 * before the write with the one observed after a restart. Never replays.
 */
export function reconcileLocalWorkerIndexEffectV1(
  before: { readonly generation: number; readonly snapshot: string },
  after: LocalWorkerHandshakeV1 | null,
): LocalWorkerIndexEffectV1 {
  if (after === null || !Number.isSafeInteger(after.generation))
    return "indeterminate";
  if (after.generation > before.generation) return "committed";
  if (after.generation === before.generation && after.snapshot === before.snapshot)
    return "not-committed";
  return "indeterminate";
}
