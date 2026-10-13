import { describe, expect, it } from "vitest";

import {
  ARTIFACT_STORE_SCHEMA_VERSION,
  artifactStoreFailureV1,
  compareArtifactStoreBindingsV1,
  formatArtifactStorageRefV1,
  hashArtifactContentV1,
  isArtifactScopeKeyV1,
  parseArtifactStorageRefV1,
  verifyArtifactStoreContentV1,
  verifyArtifactStoreExpectationsV1,
  type ArtifactStoreBindingV1,
  type ArtifactStoreCommitInputV1,
  type ArtifactStoreCommitResultV1,
  type ArtifactStoreFailureV1,
  type ArtifactStorePort,
  type ArtifactStorePrepareInputV1,
  type ArtifactStorePrepareResultV1,
  type ArtifactStoreReadInputV1,
  type ArtifactStoreReadResultV1,
} from "../../../../src/core/pactile/artifact-store.js";
import {
  MEMORY_COMMIT_ORDER_V1,
  MEMORY_DURABILITY_SCHEMA_VERSION,
  MEMORY_REPLAY_POLICY_V1,
  createContextMemoryDurabilityV1,
  decodeMemoryCurrentManifestV1,
  decodeMemoryDurableReceiptV1,
  decodeMemoryFactDocumentV1,
  encodeMemoryFactDocumentV1,
  memoryDurabilityFailureV1,
  memoryManifestEntryFromReceiptV1,
  memoryPartitionV1,
  sanitizeMemoryMessageV1,
  type ContextMemoryDurabilityPort,
  type MemoryAuditReceiptV1,
  type MemoryDurableReceiptV1,
  type MemoryFactDocumentV1,
  type MemoryLeasePort,
  type MemoryPreflightV1,
  type MemoryReceiptSummaryV1,
} from "../../../../src/core/pactile/context-memory/durability.js";
import {
  MEMORY_DURABLE_RECEIPT_KIND_V1,
  MEMORY_CURRENT_MANIFEST_KIND_V1,
} from "../../../../src/core/pactile/context-memory/durability.js";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic in-memory port fakes.
//
// These are *fakes*, not a durable host adapter and not a SQLite integration.
// They exist only to prove the commit order, the verification chain and the
// fail-closed behaviour deterministically. Each one can be told to fail or to
// corrupt its own state at a chosen step.
// ─────────────────────────────────────────────────────────────────────────────

interface FaultPlan {
  /** `nth` 1-based call of `method` fails once (counted before succeeding). */
  failAt: { method: string; nth: number; code?: string } | null;
  /** Records the exact call order across every port. */
  readonly trace: string[];
}

function newFaults(): FaultPlan {
  return { failAt: null, trace: [] };
}

class MemoryArtifactStoreFake implements ArtifactStorePort {
  readonly #objects = new Map<string, { binding: ArtifactStoreBindingV1; content: Uint8Array }>();
  readonly #staged = new Map<string, { binding: ArtifactStoreBindingV1; content: Uint8Array }>();
  readonly #calls = new Map<string, number>();

  constructor(private readonly faults: FaultPlan) {}

  #inject(method: string): boolean {
    this.faults.trace.push(`artifact.${method}`);
    const count = (this.#calls.get(method) ?? 0) + 1;
    this.#calls.set(method, count);
    return (
      this.faults.failAt?.method === `artifact.${method}` &&
      this.faults.failAt.nth === count
    );
  }

  /** Test-only: replace stored bytes without touching the committed binding. */
  tamper(storageRef: string, replacement: Uint8Array): void {
    for (const [key, value] of this.#objects) {
      if (value.binding.storageRef === storageRef) {
        this.#objects.set(key, { binding: value.binding, content: replacement });
        return;
      }
    }
    throw new Error("tamper target not found");
  }

  /** Test-only: drop a committed object entirely. */
  dropObject(storageRef: string): void {
    for (const [key, value] of this.#objects) {
      if (value.binding.storageRef === storageRef) {
        this.#objects.delete(key);
        return;
      }
    }
    throw new Error("drop target not found");
  }

  async prepare(
    input: ArtifactStorePrepareInputV1,
  ): Promise<ArtifactStorePrepareResultV1> {
    if (this.#inject("prepare")) {
      return artifactStoreFailureV1(
        this.faults.failAt?.code ?? "artifact_io_failed",
        "injected prepare failure",
        input.artifactId,
      );
    }
    const contentHash = hashArtifactContentV1(input.content);
    const binding: ArtifactStoreBindingV1 = Object.freeze({
      artifactId: input.artifactId,
      scope: input.scope,
      scopeKey: input.scopeKey,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash,
      byteLength: input.content.byteLength,
      storageRef: formatArtifactStorageRefV1(
        input.artifactId,
        input.version,
        contentHash,
      ),
    });
    const key = `${input.artifactId}/${input.version}`;
    const alreadyCommitted = this.#objects.get(key);
    if (alreadyCommitted !== undefined) {
      const conflict = compareArtifactStoreBindingsV1(alreadyCommitted.binding, binding);
      if (conflict !== null) return conflict;
      return { ok: true, replay: true, identity: alreadyCommitted.binding, preparedAt: FIXED_NOW };
    }
    this.#staged.set(key, { binding, content: input.content });
    return { ok: true, replay: false, identity: binding, preparedAt: FIXED_NOW };
  }

  async commitImmutable(
    input: ArtifactStoreCommitInputV1,
  ): Promise<ArtifactStoreCommitResultV1> {
    if (this.#inject("commitImmutable")) {
      return artifactStoreFailureV1(
        this.faults.failAt?.code ?? "artifact_io_failed",
        "injected commit failure",
        input.artifactId,
      );
    }
    const key = `${input.artifactId}/${input.version}`;
    const staged = this.#staged.get(key);
    if (staged === undefined) {
      return artifactStoreFailureV1(
        "artifact_not_prepared",
        `artifact ${key} was not prepared`,
        input.artifactId,
      );
    }
    const binding: ArtifactStoreBindingV1 = Object.freeze({
      artifactId: input.artifactId,
      scope: input.scope,
      scopeKey: input.scopeKey,
      version: input.version,
      basisRevision: input.basisRevision,
      contentHash: input.contentHash,
      byteLength: input.byteLength,
      storageRef: formatArtifactStorageRefV1(
        input.artifactId,
        input.version,
        input.contentHash,
      ),
    });
    const conflict = compareArtifactStoreBindingsV1(staged.binding, binding);
    if (conflict !== null) return conflict;
    this.#objects.set(key, { binding, content: staged.content });
    this.#staged.delete(key);
    return { ok: true, replay: false, identity: binding, committedAt: FIXED_NOW };
  }

  async read(input: ArtifactStoreReadInputV1): Promise<ArtifactStoreReadResultV1> {
    if (this.#inject("read")) {
      return artifactStoreFailureV1(
        this.faults.failAt?.code ?? "artifact_io_failed",
        "injected read failure",
        input.artifactId,
      );
    }
    const parsed = parseArtifactStorageRefV1(input.storageRef);
    if (!parsed.ok) return parsed;
    if (
      parsed.reference.artifactId !== input.artifactId ||
      parsed.reference.version !== input.version
    ) {
      return artifactStoreFailureV1(
        "artifact_ref_invalid",
        "storageRef does not identify the requested artifact version",
        input.artifactId,
      );
    }
    const stored = this.#objects.get(`${input.artifactId}/${input.version}`);
    if (stored === undefined) {
      return artifactStoreFailureV1(
        "artifact_not_found",
        `no committed artifact ${input.artifactId}/${input.version}`,
        input.artifactId,
      );
    }
    if (stored.binding.contentHash !== parsed.reference.contentHash) {
      return artifactStoreFailureV1(
        "artifact_stale",
        "storageRef does not match the committed content hash",
        input.artifactId,
      );
    }
    const expectationFailure = verifyArtifactStoreExpectationsV1(stored.binding, {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
      ...(input.basisRevision === undefined ? {} : { basisRevision: input.basisRevision }),
      ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
      ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
    });
    if (expectationFailure !== null) return expectationFailure;
    const contentFailure = verifyArtifactStoreContentV1(stored.binding, stored.content);
    if (contentFailure !== null) return contentFailure;
    return { ok: true, identity: stored.binding, content: stored.content };
  }
}

class MemoryManifestStoreFake {
  readonly #current = new Map<string, unknown>();
  readonly #revision = new Map<string, number>();
  readonly #applied = new Map<string, { hash: string; value: unknown }>();
  readonly #calls = new Map<string, number>();

  constructor(private readonly faults: FaultPlan) {}

  #inject(method: string): boolean {
    this.faults.trace.push(`manifest.${method}`);
    const count = (this.#calls.get(method) ?? 0) + 1;
    this.#calls.set(method, count);
    return (
      this.faults.failAt?.method === `manifest.${method}` &&
      this.faults.failAt.nth === count
    );
  }

  /** Test-only: drop the stored manifest without touching the CAS revision. */
  dropManifest(scope = "run", scopeKey = SCOPE_KEY): void {
    this.#current.delete(partitionKey(scope, scopeKey));
  }

  /** Test-only: write a manifest that will not decode. */
  corrupt(scope = "run", scopeKey = SCOPE_KEY): void {
    this.#current.set(partitionKey(scope, scopeKey), {
      schemaVersion: 1,
      kind: MEMORY_CURRENT_MANIFEST_KIND_V1,
      broken: true,
    });
  }

  async readCurrent(input: { scope: string; scopeKey: string }): Promise<
    | { ok: true; status: "found"; manifest: unknown }
    | { ok: true; status: "absent" }
  > {
    this.faults.trace.push("manifest.readCurrent");
    const key = partitionKey(input.scope, input.scopeKey);
    const current = this.#current.get(key);
    if (current === undefined) return { ok: true, status: "absent" };
    return { ok: true, status: "found", manifest: current };
  }

  async compareAndSwap(input: {
    idempotencyKey: string;
    requestHash: string;
    scope: string;
    scopeKey: string;
    expectedRevision: number;
    manifest: { revision: number; manifestHash: string };
  }): Promise<
    | { ok: true; applied: boolean; manifest: unknown }
    | ArtifactStoreFailureV1
  > {
    if (this.#inject("compareAndSwap")) {
      return artifactStoreFailureV1("artifact_io_failed", "injected cas failure");
    }
    const key = partitionKey(input.scope, input.scopeKey);
    const appliedKey = `${key}\u0000${input.idempotencyKey}`;
    const prior = this.#applied.get(appliedKey);
    if (prior !== undefined) {
      if (prior.hash !== input.requestHash) {
        return artifactStoreFailureV1(
          "artifact_conflict",
          "idempotency key reused with a different request hash",
        );
      }
      return { ok: true, applied: false, manifest: prior.value };
    }
    const revision = this.#revision.get(key) ?? 0;
    if (input.expectedRevision !== revision) {
      return artifactStoreFailureV1(
        "artifact_stale",
        `expected revision ${input.expectedRevision} but the manifest is at ${revision}`,
      );
    }
    this.#revision.set(key, input.manifest.revision);
    this.#current.set(key, input.manifest);
    this.#applied.set(appliedKey, {
      hash: input.requestHash,
      value: input.manifest,
    });
    return { ok: true, applied: true, manifest: input.manifest };
  }
}

class MemoryReceiptStoreFake {
  readonly #receipts = new Map<string, MemoryDurableReceiptV1>();
  readonly #pending = new Set<string>();
  readonly #denied = new Set<string>();
  readonly #applied = new Map<string, { hash: string; receiptId: string }>();
  readonly #calls = new Map<string, number>();
  #storeDown = false;

  constructor(private readonly faults: FaultPlan) {}

  #key(scope: string, scopeKey: string, receiptId: string): string {
    return `${partitionKey(scope, scopeKey)}\u0000${receiptId}`;
  }

  #inject(method: string): boolean {
    this.faults.trace.push(`receipt.${method}`);
    const count = (this.#calls.get(method) ?? 0) + 1;
    this.#calls.set(method, count);
    return (
      this.faults.failAt?.method === `receipt.${method}` &&
      this.faults.failAt.nth === count
    );
  }

  /** Test-only: mark a receipt id as permanently pending. */
  markPending(receiptId: string): void {
    this.#pending.add(receiptId);
  }

  /** Test-only: simulate an ACL denial for one receipt id. */
  markDenied(receiptId: string): void {
    this.#denied.add(receiptId);
  }

  /** Test-only: simulate a receipt-store outage for lookups. */
  setStoreDown(down: boolean): void {
    this.#storeDown = down;
  }

  /**
   * Test-only: serve the receipt stored under `fromReceiptId` in place of
   * `toReceiptId`. Both receipts are individually valid and self-consistent, so
   * only cross-checking against the manifest entry can detect the swap.
   */
  spliceReceipt(fromReceiptId: string, toReceiptId: string): void {
    const from = this.#find(fromReceiptId);
    const to = this.#find(toReceiptId);
    if (from === undefined || to === undefined) {
      throw new Error("splice target not found");
    }
    this.#receipts.set(to[0], from[1]);
  }

  /** Test-only: tamper the stored receipt hash. */
  corruptReceipt(receiptId: string): void {
    const entry = this.#find(receiptId);
    if (entry === undefined) throw new Error("corrupt target not found");
    this.#receipts.set(
      entry[0],
      Object.freeze({ ...entry[1], receiptHash: `sha256:${"9".repeat(64)}` }),
    );
  }

  /** Test-only: delete a stored receipt. */
  dropReceipt(receiptId: string): void {
    const entry = this.#find(receiptId);
    if (entry === undefined) throw new Error("drop target not found");
    this.#receipts.delete(entry[0]);
  }

  #find(receiptId: string): [string, MemoryDurableReceiptV1] | undefined {
    return [...this.#receipts.entries()].find(
      ([, receipt]) => receipt.receiptId === receiptId,
    );
  }

  async putReceipt(input: {
    idempotencyKey: string;
    requestHash: string;
    receipt: MemoryDurableReceiptV1;
  }): Promise<
    | { ok: true; applied: boolean; receipt: MemoryDurableReceiptV1 }
    | ArtifactStoreFailureV1
  > {
    if (this.#inject("putReceipt")) {
      return artifactStoreFailureV1("artifact_io_failed", "injected receipt write failure");
    }
    const appliedKey = `${input.receipt.scope}\u0000${input.receipt.scopeKey}\u0000${input.idempotencyKey}`;
    const prior = this.#applied.get(appliedKey);
    if (prior !== undefined) {
      if (prior.hash !== input.requestHash) {
        return artifactStoreFailureV1(
          "artifact_conflict",
          "idempotency key reused with a different request hash",
        );
      }
      return { ok: true, applied: false, receipt: input.receipt };
    }
    this.#receipts.set(
      this.#key(input.receipt.scope, input.receipt.scopeKey, input.receipt.receiptId),
      input.receipt,
    );
    this.#applied.set(appliedKey, {
      hash: input.requestHash,
      receiptId: input.receipt.receiptId,
    });
    return { ok: true, applied: true, receipt: input.receipt };
  }

  async getReceipt(input: {
    scope: string;
    scopeKey: string;
    receiptId: string;
  }) {
    this.faults.trace.push("receipt.getReceipt");
    if (this.#storeDown) {
      return memoryDurabilityFailureV1(
        "memory_store_unavailable",
        "the receipt store is unavailable",
      );
    }
    if (this.#denied.has(input.receiptId)) {
      return memoryDurabilityFailureV1(
        "memory_store_denied",
        "the receipt store denied access",
      );
    }
    if (this.#pending.has(input.receiptId)) {
      return { ok: true as const, status: "pending" as const };
    }
    const stored = this.#receipts.get(
      this.#key(input.scope, input.scopeKey, input.receiptId),
    );
    if (stored === undefined) return { ok: true as const, status: "absent" as const };
    return { ok: true as const, status: "found" as const, receipt: stored };
  }

  async listReceipts(input: { scope: string; scopeKey: string; limit?: number }) {
    this.faults.trace.push("receipt.listReceipts");
    if (this.#storeDown) {
      return memoryDurabilityFailureV1(
        "memory_store_unavailable",
        "the receipt store is unavailable",
      );
    }
    const prefix = `${partitionKey(input.scope, input.scopeKey)}\u0000`;
    const scoped = [...this.#receipts.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, receipt]) => receipt);
    const all: MemoryReceiptSummaryV1[] = scoped.map((receipt) => ({
      receiptId: receipt.receiptId,
      requestId: receipt.requestId,
      basisRevision: receipt.basisRevision,
      contentHash: receipt.contentHash,
      receiptHash: receipt.receiptHash,
      committedAt: receipt.committedAt,
    }));
    const limit = input.limit ?? all.length;
    return {
      ok: true as const,
      receipts: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }
}

class MemoryAuditStoreFake {
  readonly appended: MemoryAuditReceiptV1[] = [];
  readonly seen = new Map<string, string>();
  readonly stored = new Map<string, MemoryAuditReceiptV1>();
  /** Report the stored receipt on append, like the SQLite audit log does. */
  returnStored = true;
  /** Replace what the audit log answers with, to model a divergent store. */
  overrideStored: ((offered: MemoryAuditReceiptV1) => MemoryAuditReceiptV1) | null = null;

  constructor(private readonly faults: FaultPlan) {}

  async append(input: {
    idempotencyKey: string;
    requestHash: string;
    receipt: MemoryAuditReceiptV1;
  }): Promise<
    | { ok: true; applied: boolean; receipt?: MemoryAuditReceiptV1 }
    | ArtifactStoreFailureV1
  > {
    this.faults.trace.push("audit.append");
    if (
      this.faults.failAt?.method === "audit.append" &&
      this.faults.failAt.nth === this.appended.length + 1
    ) {
      return artifactStoreFailureV1("artifact_io_failed", "injected audit failure");
    }
    const prior = this.seen.get(input.idempotencyKey);
    if (prior !== undefined) {
      const first = this.stored.get(input.idempotencyKey);
      const answer =
        this.overrideStored !== null && first !== undefined
          ? this.overrideStored(first)
          : first;
      return this.returnStored && answer !== undefined
        ? { ok: true, applied: false, receipt: answer }
        : { ok: true, applied: false };
    }
    this.seen.set(input.idempotencyKey, input.requestHash);
    this.stored.set(input.idempotencyKey, input.receipt);
    this.appended.push(input.receipt);
    return this.returnStored
      ? { ok: true, applied: true, receipt: input.receipt }
      : { ok: true, applied: true };
  }
}

class LeasePortFake implements MemoryLeasePort {
  #failures = 0;

  constructor(private readonly faults: FaultPlan) {}

  setFailures(count: number): void {
    this.#failures = count;
  }

  async validateLease(): Promise<{ ok: true } | ReturnType<typeof memoryDurabilityFailureV1>> {
    this.faults.trace.push("lease.validateLease");
    if (this.#failures > 0) return { ok: true };
    return { ok: true };
  }
}

const FIXED_NOW = "2026-10-06T00:00:00.000Z";
const SCOPE_KEY = "workspace-1/project-1/run-1";

function partitionKey(scope: string, scopeKey: string): string {
  return `${scope}\u0000${scopeKey}`;
}

interface Harness {
  readonly port: ContextMemoryDurabilityPort;
  readonly artifacts: MemoryArtifactStoreFake;
  readonly manifests: MemoryManifestStoreFake;
  readonly receipts: MemoryReceiptStoreFake;
  readonly audits: MemoryAuditStoreFake;
  readonly leases: LeasePortFake;
  readonly faults: FaultPlan;
}

function harness(
  options: { requireLease?: boolean; now?: () => Date } = {},
): Harness {
  const faults = newFaults();
  const artifacts = new MemoryArtifactStoreFake(faults);
  const manifests = new MemoryManifestStoreFake(faults);
  const receipts = new MemoryReceiptStoreFake(faults);
  const audits = new MemoryAuditStoreFake(faults);
  const leases = new LeasePortFake(faults);
  const port = createContextMemoryDurabilityV1({
    artifacts,
    receipts,
    manifests,
    audits,
    leases,
    now: options.now ?? ((): Date => new Date(FIXED_NOW)),
    requireLease: options.requireLease ?? false,
  });
  return { port, artifacts, manifests, receipts, audits, leases, faults };
}

function document(
  overrides: Partial<MemoryFactDocumentV1> = {},
): MemoryFactDocumentV1 {
  return {
    schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
    kind: "memory_fact_document_v1",
    source: "artifact",
    scope: "run",
    scopeKey: SCOPE_KEY,
    basisRevision: 7,
    facts: [
      {
        factId: "fact-decision-1",
        statement: "Use the frozen write set for this run.",
        basisRevision: 7,
        tags: ["decision"],
      },
      {
        factId: "fact-constraint-1",
        statement: "No second writer may target the Kernel.",
        basisRevision: 7,
        tags: ["constraint"],
      },
    ],
    summaries: [
      {
        summaryId: "summary-1",
        statement: "Two durable facts were recorded for basis 7.",
        derivedFrom: ["fact-decision-1", "fact-constraint-1"],
      },
    ],
    ...overrides,
  };
}

function commitInput(
  overrides: Partial<Parameters<ContextMemoryDurabilityPort["commit"]>[0]> = {},
): Parameters<ContextMemoryDurabilityPort["commit"]>[0] {
  return {
    requestId: "req-memory-1",
    scope: "run",
    scopeKey: SCOPE_KEY,
    artifactId: "memory-artifact-1",
    version: 1,
    basisRevision: 7,
    document: document(),
    whenToRead: "Read before choosing a previously discussed strategy.",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("memory durability commit order", () => {
  it("commits artifact, then receipt, then manifest in exactly that order", async () => {
    const h = harness();
    const result = await h.port.commit(commitInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.durable).toBe(true);
    expect(result.order).toEqual(["artifact", "receipt", "manifest"]);
    expect(result.replay).toBe(false);
    expect(result.factCount).toBe(2);
    expect(result.summaryCount).toBe(1);
    expect(result.manifestRevision).toBe(1);

    const writeTrace = h.faults.trace.filter((entry) =>
      ["artifact.prepare", "artifact.commitImmutable", "receipt.putReceipt", "manifest.compareAndSwap"].includes(entry),
    );
    expect(writeTrace).toEqual([
      "artifact.prepare",
      "artifact.commitImmutable",
      "receipt.putReceipt",
      "manifest.compareAndSwap",
    ]);
    const putIndex = h.faults.trace.indexOf("receipt.putReceipt");
    const lastGetIndex = h.faults.trace.lastIndexOf("receipt.getReceipt");
    const casIndex = h.faults.trace.indexOf("manifest.compareAndSwap");
    expect(lastGetIndex).toBeGreaterThan(putIndex);
    expect(casIndex).toBeGreaterThan(putIndex);
    expect(lastGetIndex).toBeLessThan(casIndex);
  });

  it("replays the same request idempotently without duplicating writes", async () => {
    const h = harness();
    const input = commitInput();
    const first = await h.port.commit(input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    const writesAfterFirst = h.faults.trace.filter((entry) =>
      ["artifact.prepare", "artifact.commitImmutable", "receipt.putReceipt", "manifest.compareAndSwap"].includes(entry),
    ).length;

    const second = await h.port.commit(input);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    expect(second.replay).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.manifestRevision).toBe(first.manifestRevision);

    const writesAfterSecond = h.faults.trace.filter((entry) =>
      ["artifact.prepare", "artifact.commitImmutable", "receipt.putReceipt", "manifest.compareAndSwap"].includes(entry),
    ).length;
    expect(writesAfterSecond).toBe(writesAfterFirst);
  });

  it("binds a second basis revision into the same manifest without losing the first", async () => {
    const h = harness();
    const first = await h.port.commit(commitInput());
    expect(first.ok).toBe(true);
    const second = await h.port.commit(
      commitInput({
        requestId: "req-memory-2",
        artifactId: "memory-artifact-2",
        version: 2,
        basisRevision: 8,
        document: document({
          basisRevision: 8,
          facts: [
            {
              factId: "fact-decision-2",
              statement: "Basis 8 supersedes the previous plan.",
              basisRevision: 8,
              tags: ["decision"],
            },
          ],
          summaries: [],
        }),
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    expect(second.manifestRevision).toBe(2);
    const lookup = await h.manifests.readCurrent({
      scope: "run",
      scopeKey: SCOPE_KEY,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error("expected a manifest");
    const manifest = decodeMemoryCurrentManifestV1(lookup.manifest);
    expect(manifest?.entries).toHaveLength(2);
    expect(manifest?.entries.map((entry) => entry.basisRevision)).toEqual([7, 8]);
  });

  it("rejects a request id that is reused for a different payload", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const conflicting = await h.port.commit(
      commitInput({
        document: document({
          facts: [
            {
              factId: "fact-decision-1",
              statement: "A materially different statement.",
              basisRevision: 7,
              tags: ["decision"],
            },
          ],
          summaries: [],
        }),
      }),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error("expected a conflict");
    expect(conflicting.code).toBe("memory_request_conflict");
    expect(conflicting.reexecute).toBe(false);
    expect(conflicting.replayPolicy).toBe(MEMORY_REPLAY_POLICY_V1);
  });
});

describe("memory durability crash and corruption recovery", () => {
  it("fails closed when the artifact store fails before any receipt exists", async () => {
    const h = harness();
    h.faults.failAt = { method: "artifact.commitImmutable", nth: 1, code: "artifact_io_failed" };
    const result = await h.port.commit(commitInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("artifact");
    expect(result.progress).toEqual({ artifact: false, receipt: false, manifest: false });
    expect(result.domain).toBe("memory");
    const audit = await h.port.recover({ scope: "run", scopeKey: SCOPE_KEY });
    expect(audit.ok).toBe(true);
    if (!audit.ok) throw new Error(audit.message);
    expect(audit.manifestRevision).toBeNull();
    expect(audit.effects).toHaveLength(0);
  });

  it("leaves no durable manifest when the crash happens after the artifact commit", async () => {
    const h = harness();
    h.faults.failAt = { method: "receipt.putReceipt", nth: 1, code: "artifact_io_failed" };
    const result = await h.port.commit(commitInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.stage).toBe("receipt");
    expect(result.progress).toEqual({ artifact: true, receipt: false, manifest: false });
    // No manifest exists, so nothing claims durable memory.
    const lookup = await h.manifests.readCurrent({ scope: "run", scopeKey: SCOPE_KEY });
    expect(lookup).toMatchObject({ ok: true, status: "absent" });
    const preflight = await h.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(preflight.message);
    expect(preflight.status).toBe("absent");
    expect(preflight.verified).toBe(false);
    expect(preflight.assurance).toBe("assurance_unknown");
  });

  it("never writes a manifest that claims a receipt the store does not hold", async () => {
    const h = harness();
    const first = await h.port.commit(commitInput());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);

    // The manifest still references the receipt, but the receipt itself is
    // gone: the next read must refuse rather than invent a durable copy.
    h.receipts.dropReceipt(first.receiptId);

    const preflight = await h.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(preflight.message);
    expect(preflight.verified).toBe(false);
    expect(preflight.status).not.toBe("durable");
    expect(preflight.assurance).toBe("assurance_unknown");
    expect(preflight.externalization.disclosed).toBe(false);

    const read = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.domain).toBe("memory");
  });

  it("fails closed on a corrupt receipt, a tampered receipt hash and a tampered artifact", async () => {
    const h = harness();
    const committed = await h.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);

    h.receipts.corruptReceipt(committed.receiptId);
    const corruptPreflight = await h.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(corruptPreflight.ok).toBe(true);
    if (!corruptPreflight.ok) throw new Error(corruptPreflight.message);
    expect(corruptPreflight.reason).toBe("receipt_hash_mismatch");
    expect(corruptPreflight.assurance).toBe("assurance_unknown");

    const h2 = harness();
    const committed2 = await h2.port.commit(commitInput());
    expect(committed2.ok).toBe(true);
    if (!committed2.ok) throw new Error(committed2.message);
    // Same byte length, different bytes: this must fail as a hash mismatch
    // rather than being misreported as a size mismatch.
    const original = encodeMemoryFactDocumentV1(document());
    const tampered = Uint8Array.from(original);
    tampered[0] = 0x5b;
    expect(tampered.byteLength).toBe(original.byteLength);
    h2.artifacts.tamper(committed2.storageRef, tampered);
    const tamperedPreflight = await h2.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(tamperedPreflight.ok).toBe(true);
    if (!tamperedPreflight.ok) throw new Error(tamperedPreflight.message);
    expect(tamperedPreflight.reason).toBe("artifact_hash_mismatch");
    expect(tamperedPreflight.assurance).toBe("assurance_unknown");

    // A truncated payload fails as a corrupt artifact and still blocks.
    const h3 = harness();
    const committed3 = await h3.port.commit(commitInput());
    if (!committed3.ok) throw new Error(committed3.message);
    h3.artifacts.tamper(committed3.storageRef, original.slice(0, 4));
    const truncatedPreflight = await h3.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(truncatedPreflight.ok).toBe(true);
    if (!truncatedPreflight.ok) throw new Error(truncatedPreflight.message);
    expect(truncatedPreflight.reason).toBe("artifact_corrupt");
    expect(truncatedPreflight.assurance).toBe("assurance_unknown");
    expect(truncatedPreflight.verified).toBe(false);
  });

  it("refuses a stale manifest revision and a CAS conflict without writing", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const stale = await h.port.commit(
      commitInput({
        requestId: "req-memory-3",
        artifactId: "memory-artifact-3",
        version: 3,
        basisRevision: 9,
        expectedManifestRevision: 0,
        document: document({
          basisRevision: 9,
          facts: [
            {
              factId: "fact-decision-3",
              statement: "Basis 9 must be rejected against a stale revision.",
              basisRevision: 9,
              tags: [],
            },
          ],
          summaries: [],
        }),
      }),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected a stale revision rejection");
    expect(stale.code).toBe("memory_manifest_stale");
    expect(stale.stage).toBe("manifest");
    expect(stale.reexecute).toBe(false);

    const h2 = harness();
    h2.faults.failAt = { method: "manifest.compareAndSwap", nth: 1 };
    const casFailure = await h2.port.commit(commitInput());
    expect(casFailure.ok).toBe(false);
    if (casFailure.ok) throw new Error("expected a CAS failure");
    expect(casFailure.stage).toBe("manifest");
    expect(casFailure.progress).toEqual({ artifact: true, receipt: true, manifest: false });
    expect(casFailure.reexecute).toBe(false);
    expect(casFailure.replayPolicy).toBe("no_automatic_replay");
  });

  it("reports an unverifiable manifest write as an unknown effect and does not replay it", async () => {
    const h = harness();
    // The manifest is absent before the CAS and unreadable after it, so the
    // post-write verification cannot prove what landed.
    let casApplied = false;
    const port = createContextMemoryDurabilityV1({
      artifacts: h.artifacts,
      receipts: h.receipts,
      audits: h.audits,
      leases: h.leases,
      now: (): Date => new Date(FIXED_NOW),
      manifests: {
        readCurrent: async (): Promise<
          | { ok: true; status: "found"; manifest: unknown }
          | { ok: true; status: "absent" }
        > => {
          if (!casApplied) return { ok: true, status: "absent" };
          return {
            ok: true,
            status: "found",
            manifest: { schemaVersion: 1, kind: MEMORY_CURRENT_MANIFEST_KIND_V1, unreadable: true },
          };
        },
        compareAndSwap: async (): Promise<{ ok: true; applied: boolean; manifest: unknown }> => {
          casApplied = true;
          return { ok: true, applied: true, manifest: {} };
        },
      },
    });
    const result = await port.commit(commitInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an unknown-effect failure");
    expect(result.code).toBe("memory_manifest_corrupt");
    expect(result.details?.effect).toBe("unknown");
    expect(result.reexecute).toBe(false);
    expect(result.progress).toEqual({ artifact: true, receipt: true, manifest: false });
  });

  it("treats a corrupt manifest as untrustworthy instead of overwriting it", async () => {
    const h = harness();
    h.manifests.corrupt();
    const preflight = await h.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(preflight.message);
    expect(preflight.reason).toBe("manifest_corrupt");
    expect(preflight.status).toBe("unknown");
    expect(preflight.assurance).toBe("assurance_unknown");

    const commitAttempt = await h.port.commit(commitInput());
    expect(commitAttempt.ok).toBe(false);
    if (commitAttempt.ok) throw new Error("expected a refusal");
    expect(commitAttempt.code).toBe("memory_manifest_corrupt");
    expect(commitAttempt.reexecute).toBe(false);
  });
});

describe("memory durability scope isolation", () => {
  it("keeps run, workItem and project scopes and their scope keys isolated", async () => {
    const h = harness();
    const cases = [
      { scope: "run" as const, scopeKey: "ws-1/run-1", artifactId: "memory-artifact-run" },
      { scope: "workItem" as const, scopeKey: "ws-1/work-item-1", artifactId: "memory-artifact-work" },
      { scope: "project" as const, scopeKey: "ws-1/project-1", artifactId: "memory-artifact-project" },
    ];
    for (const [index, entry] of cases.entries()) {
      const result = await h.port.commit(
        commitInput({
          requestId: `req-scope-${index}`,
          scope: entry.scope,
          scopeKey: entry.scopeKey,
          artifactId: entry.artifactId,
          document: document({ scope: entry.scope, scopeKey: entry.scopeKey }),
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.scope).toBe(entry.scope);
      expect(result.manifestRevision).toBe(1);
    }
    for (const entry of cases) {
      const read = await h.port.read({
        scope: entry.scope,
        scopeKey: entry.scopeKey,
        basisRevision: 7,
        acknowledgeDisclosure: true,
      });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.message);
      expect(read.scope).toBe(entry.scope);
      expect(read.scopeKey).toBe(entry.scopeKey);
      expect(read.exactFactCount).toBe(2);
    }
    // A scope key that was never written stays absent.
    const foreign = await h.port.preflight({
      scope: "run",
      scopeKey: "ws-1/run-2",
      basisRevision: 7,
      disclose: true,
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error(foreign.message);
    expect(foreign.status).toBe("absent");
    expect(foreign.verified).toBe(false);
  });

  it("refuses a document whose scope does not match the commit request", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({ document: document({ scopeKey: "ws-1/other-run" }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a scope mismatch");
    expect(result.code).toBe("memory_scope_mismatch");
  });

  it("derives a distinct partition per scope and scope key", () => {
    expect(memoryPartitionV1("run", "a")).not.toBe(memoryPartitionV1("run", "b"));
    expect(memoryPartitionV1("run", "a")).not.toBe(memoryPartitionV1("project", "a"));
    expect(memoryPartitionV1("run", "a")).not.toBe(memoryPartitionV1("workItem", "a"));
  });
});

describe("memory durability verified reads", () => {
  it("returns only hash-verified structured facts after a disclosure acknowledgement", async () => {
    const h = harness();
    const committed = await h.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    const read = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.message);
    expect(read.assurance).toBe("assurance_exact");
    expect(read.facts).toHaveLength(2);
    expect(read.facts.every((fact) => fact.exact)).toBe(true);
    expect(read.facts.every((fact) => fact.source === "artifact")).toBe(true);
    expect(read.facts[0]?.contentHash).toBe(committed.contentHash);
    expect(read.facts[0]?.basisRevision).toBe(7);
    expect(read.facts[0]?.scope).toBe("run");
    expect(read.facts[0]?.factHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A summary is never an exact fact source.
    expect(read.summaryIsExactFactSource).toBe(false);
    expect(read.summaries).toHaveLength(1);
    expect(read.summaries.every((summary) => summary.exact === false)).toBe(true);
    expect(read.summaries.every((summary) => summary.authoritative === false)).toBe(true);
    expect(read.summaries[0]).not.toHaveProperty("factId");
    expect(read.disclosure.path).toBe(committed.storageRef);
    expect(read.disclosure.fingerprint).toBe(committed.contentHash);
    expect(read.disclosure.readVia).toBe("artifact_store");
  });

  it("binds every returned fact to the artifact content hash", async () => {
    const h = harness();
    const committed = await h.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    const read = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    });
    if (!read.ok) throw new Error(read.message);
    const hashes = new Set(read.facts.map((fact) => fact.factHash));
    expect(hashes.size).toBe(read.facts.length);
    expect(read.readReceipt.contentHash).toBe(committed.contentHash);
    expect(read.readReceipt.acknowledgedDisclosure).toBe(true);
    expect(read.readReceipt.factIds).toEqual(read.facts.map((fact) => fact.factId));
  });

  it("refuses to return facts without an explicit disclosure acknowledgement", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const read = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: false,
    });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.code).toBe("memory_disclosure_missing");
  });

  it("refuses reads for a stale or unrecorded basis revision", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const stale = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 6,
      acknowledgeDisclosure: true,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected a refusal");
    expect(stale.domain).toBe("memory");
    expect(stale.reexecute).toBe(false);
  });

  it("returns the audited receipt when an identical read replays the audit entry", async () => {
    let tick = 0;
    const h = harness({
      now: (): Date => new Date(Date.parse(FIXED_NOW) + 1000 * tick++),
    });
    await h.port.commit(commitInput());
    const request = {
      scope: "run" as const,
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    };
    const first = await h.port.read(request);
    const second = await h.port.read(request);
    if (!first.ok || !second.ok) throw new Error("expected two verified reads");
    // Same request, same audit entry: both reads carry the one stored receipt.
    expect(h.audits.appended).toHaveLength(1);
    expect(second.readReceipt).toEqual(first.readReceipt);
    expect(second.readReceipt.receiptHash).toBe(h.audits.appended[0]?.receiptHash);
    expect(second.readReceipt.recordedAt).toBe(first.readReceipt.recordedAt);

    // A store that cannot return the receipt keeps the previous behaviour.
    h.audits.returnStored = false;
    const legacy = await h.port.read(request);
    if (!legacy.ok) throw new Error(legacy.message);
    expect(legacy.readReceipt.readReceiptId).toBe(first.readReceipt.readReceiptId);
  });

  it("refuses a read when the audit store answers with a different receipt", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const request = {
      scope: "run" as const,
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    };
    const first = await h.port.read(request);
    expect(first.ok).toBe(true);
    h.audits.overrideStored = (offered) =>
      ({ ...offered, contentHash: `sha256:${"c".repeat(64)}` }) as MemoryAuditReceiptV1;
    const diverged = await h.port.read(request);
    expect(diverged.ok).toBe(false);
    if (diverged.ok) throw new Error("expected a refusal");
    expect(diverged.code).toBe("memory_audit_write_failed");
    expect(diverged.reexecute).toBe(false);
  });

  it("records a read receipt through the audit port", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const read = await h.port.read({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      acknowledgeDisclosure: true,
    });
    expect(read.ok).toBe(true);
    expect(h.audits.appended).toHaveLength(1);
    expect(h.audits.appended[0]?.kind).toBe("memory_read_receipt_v1");
  });
});

describe("memory durability compaction authorization", () => {
  const compaction = (
    overrides: Partial<Parameters<ContextMemoryDurabilityPort["authorizeCompaction"]>[0]> = {},
  ): Parameters<ContextMemoryDurabilityPort["authorizeCompaction"]>[0] => ({
    scope: "run",
    scopeKey: SCOPE_KEY,
    basisRevision: 7,
    contextTokens: 16_001,
    contextWindow: 24_000,
    reserveTokens: 8_000,
    maskableToolResultTokens: 0,
    disclose: true,
    ...overrides,
  });

  it("authorizes compaction only after a durable preflight and disclosure", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const outcome = await h.port.authorizeCompaction(compaction());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.preflight.status).toBe("durable");
    expect(outcome.preflight.verified).toBe(true);
    expect(outcome.decision.action).toBe("compact");
    expect(outcome.authorization).toBe("compact_authorized");
    expect(outcome.action).toBe("compact");
    expect(outcome.assurance).toBe("assurance_exact");
    expect(outcome.receipt.disclosurePath).toBe(outcome.preflight.disclosure?.path);
    expect(outcome.receipt.whenToRead).toBeTruthy();
    expect(outcome.receipt.reexecute).toBe(false);
    expect(outcome.receipt.replayPolicy).toBe("no_automatic_replay");
  });

  it("prefers masking over compaction while maskable tool results remain", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const outcome = await h.port.authorizeCompaction(
      compaction({ maskableToolResultTokens: 500 }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.action).toBe("mask");
    expect(outcome.authorization).toBe("mask_authorized");
  });

  it("blocks compaction for absent, pending, unknown, stale and denied durable state", async () => {
    const absentHarness = harness();
    const absent = await absentHarness.port.authorizeCompaction(compaction());
    expect(absent.ok).toBe(true);
    if (!absent.ok) throw new Error(absent.message);
    expect(absent.action).toBe("blocked");
    expect(absent.assurance).toBe("assurance_unknown");
    expect(absent.authorization).toBe("blocked_policy");
    expect(absent.decision.reason).toBe("externalization_missing");
    expect(absent.preflight.verified).toBe(false);
    expect(absent.preflight.disclosed).toBe(false);

    const deniedHarness = harness();
    const committed = await deniedHarness.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    deniedHarness.receipts.markDenied(committed.receiptId);
    const denied = await deniedHarness.port.authorizeCompaction(compaction());
    expect(denied.ok).toBe(true);
    if (!denied.ok) throw new Error(denied.message);
    expect(denied.action).toBe("blocked");
    expect(denied.assurance).toBe("assurance_unknown");
    expect(denied.authorization).toBe("blocked_memory_error");
    expect(denied.error?.domain).toBe("memory");
    expect(denied.preflight.reason).toBe("receipt_denied");

    const corruptHarness = harness();
    const committedCorrupt = await corruptHarness.port.commit(commitInput());
    if (!committedCorrupt.ok) throw new Error(committedCorrupt.message);
    corruptHarness.receipts.corruptReceipt(committedCorrupt.receiptId);
    const corrupted = await corruptHarness.port.authorizeCompaction(compaction());
    expect(corrupted.ok).toBe(true);
    if (!corrupted.ok) throw new Error(corrupted.message);
    expect(corrupted.action).toBe("blocked");
    expect(corrupted.assurance).toBe("assurance_unknown");
    expect(corrupted.preflight.reason).toBe("receipt_hash_mismatch");

    const corruptManifestHarness = harness();
    await corruptManifestHarness.port.commit(commitInput());
    corruptManifestHarness.manifests.corrupt();
    const corruptManifest = await corruptManifestHarness.port.authorizeCompaction(compaction());
    expect(corruptManifest.ok).toBe(true);
    if (!corruptManifest.ok) throw new Error(corruptManifest.message);
    expect(corruptManifest.action).toBe("blocked");
    expect(corruptManifest.assurance).toBe("assurance_unknown");
    expect(corruptManifest.authorization).toBe("blocked_memory_error");
    expect(corruptManifest.preflight.reason).toBe("manifest_corrupt");

    const staleHarness = harness();
    await staleHarness.port.commit(commitInput());
    await staleHarness.port.commit(
      commitInput({
        requestId: "req-memory-8",
        artifactId: "memory-artifact-8",
        version: 8,
        basisRevision: 8,
        document: document({
          basisRevision: 8,
          facts: [
            {
              factId: "fact-decision-8",
              statement: "Basis 8 exists and makes 7 stale for surgery.",
              basisRevision: 8,
              tags: [],
            },
          ],
          summaries: [],
        }),
      }),
    );
    const stale = await staleHarness.port.authorizeCompaction(compaction());
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error(stale.message);
    expect(stale.action).toBe("blocked");
    expect(stale.assurance).toBe("assurance_unknown");
    expect(stale.preflight.reason).toBe("manifest_stale_revision");
  });

  it("blocks compaction when the durable copy exists but disclosure is not verified", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const outcome = await h.port.authorizeCompaction(compaction({ disclose: false }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.action).toBe("blocked");
    expect(outcome.assurance).toBe("assurance_unknown");
    expect(outcome.decision.reason).toBe("disclosure_missing");
    expect(outcome.preflight.verified).toBe(true);
    expect(outcome.preflight.disclosed).toBe(false);
  });

  it("never falls back to default compression for any non-verified durable state", async () => {
    // Every state in the requirement list must be blocked + assurance_unknown,
    // and none may silently degrade into a compact authorization.

    // absent
    const absent = await harness().port.authorizeCompaction(compaction());
    if (!absent.ok) throw new Error(absent.message);
    expect([absent.action, absent.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // pending
    const pendingHarness = harness();
    const pendingCommit = await pendingHarness.port.commit(commitInput());
    if (!pendingCommit.ok) throw new Error(pendingCommit.message);
    pendingHarness.receipts.markPending(pendingCommit.receiptId);
    const pending = await pendingHarness.port.authorizeCompaction(compaction());
    if (!pending.ok) throw new Error(pending.message);
    expect(pending.preflight.status).toBe("pending");
    expect(pending.preflight.reason).toBe("receipt_pending");
    expect([pending.action, pending.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // unknown (store unavailable)
    const downHarness = harness();
    const downCommit = await downHarness.port.commit(commitInput());
    if (!downCommit.ok) throw new Error(downCommit.message);
    downHarness.receipts.setStoreDown(true);
    const unknown = await downHarness.port.authorizeCompaction(compaction());
    if (!unknown.ok) throw new Error(unknown.message);
    expect(unknown.preflight.status).toBe("unknown");
    expect(unknown.preflight.reason).toBe("store_unavailable");
    expect(unknown.authorization).toBe("blocked_memory_error");
    expect([unknown.action, unknown.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // corrupt
    const corruptHarness = harness();
    const corruptCommit = await corruptHarness.port.commit(commitInput());
    if (!corruptCommit.ok) throw new Error(corruptCommit.message);
    corruptHarness.receipts.corruptReceipt(corruptCommit.receiptId);
    const corrupt = await corruptHarness.port.authorizeCompaction(compaction());
    if (!corrupt.ok) throw new Error(corrupt.message);
    expect(corrupt.preflight.reason).toBe("receipt_hash_mismatch");
    expect([corrupt.action, corrupt.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // denied
    const deniedHarness = harness();
    const deniedCommit = await deniedHarness.port.commit(commitInput());
    if (!deniedCommit.ok) throw new Error(deniedCommit.message);
    deniedHarness.receipts.markDenied(deniedCommit.receiptId);
    const denied = await deniedHarness.port.authorizeCompaction(compaction());
    if (!denied.ok) throw new Error(denied.message);
    expect(denied.preflight.reason).toBe("receipt_denied");
    expect([denied.action, denied.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // conflict: a valid but foreign receipt is served for this entry
    const conflictHarness = harness();
    const firstCommit = await conflictHarness.port.commit(commitInput());
    if (!firstCommit.ok) throw new Error(firstCommit.message);
    // A second, independently valid receipt in another scope key. It is
    // self-consistent, so only cross-checking it against this manifest entry
    // can reveal the substitution.
    const foreignCommit = await conflictHarness.port.commit(
      commitInput({
        requestId: "req-memory-foreign",
        scopeKey: "ws-1/run-2",
        artifactId: "memory-artifact-foreign",
        version: 2,
        document: document({ scopeKey: "ws-1/run-2" }),
      }),
    );
    if (!foreignCommit.ok) throw new Error(foreignCommit.message);
    expect(foreignCommit.receiptId).not.toBe(firstCommit.receiptId);
    conflictHarness.receipts.spliceReceipt(
      foreignCommit.receiptId,
      firstCommit.receiptId,
    );
    const conflict = await conflictHarness.port.authorizeCompaction(compaction());
    if (!conflict.ok) throw new Error(conflict.message);
    expect(conflict.preflight.reason).toBe("receipt_conflict");
    expect(conflict.preflight.verified).toBe(false);
    expect([conflict.action, conflict.assurance]).toEqual(["blocked", "assurance_unknown"]);
    expect(conflict.authorization).toBe("blocked_memory_error");

    // stale revision
    const staleHarness = harness();
    await staleHarness.port.commit(commitInput());
    await staleHarness.port.commit(
      commitInput({
        requestId: "req-memory-stale",
        artifactId: "memory-artifact-stale",
        version: 2,
        basisRevision: 9,
        document: document({
          basisRevision: 9,
          facts: [
            {
              factId: "fact-decision-9",
              statement: "A newer basis makes the older one stale.",
              basisRevision: 9,
              tags: [],
            },
          ],
          summaries: [],
        }),
      }),
    );
    const stale = await staleHarness.port.authorizeCompaction(compaction());
    if (!stale.ok) throw new Error(stale.message);
    expect(stale.preflight.reason).toBe("manifest_stale_revision");
    expect([stale.action, stale.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // entry missing: a durable receipt exists but the manifest does not
    // reference it, so the state is pending rather than durable.
    const missingHarness = harness();
    const orphanCommit = await missingHarness.port.commit(commitInput());
    if (!orphanCommit.ok) throw new Error(orphanCommit.message);
    missingHarness.manifests.dropManifest();
    const missing = await missingHarness.port.authorizeCompaction(compaction());
    if (!missing.ok) throw new Error(missing.message);
    expect(missing.preflight.status).toBe("pending");
    expect(missing.preflight.reason).toBe("receipt_pending");
    expect([missing.action, missing.assurance]).toEqual(["blocked", "assurance_unknown"]);

    // manifest entry missing and no receipt survives at all
    const emptyHarness = harness();
    const emptyCommit = await emptyHarness.port.commit(commitInput());
    if (!emptyCommit.ok) throw new Error(emptyCommit.message);
    emptyHarness.manifests.dropManifest();
    emptyHarness.receipts.dropReceipt(emptyCommit.receiptId);
    const empty = await emptyHarness.port.authorizeCompaction(compaction());
    if (!empty.ok) throw new Error(empty.message);
    expect(empty.preflight.status).toBe("absent");
    expect(empty.preflight.reason).toBe("manifest_absent");
    expect([empty.action, empty.assurance]).toEqual(["blocked", "assurance_unknown"]);
  });

  it("keeps provider errors separate from memory errors", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const provider = await h.port.authorizeCompaction(
      compaction({
        providerFailure: {
          code: "provider_rate_limited",
          message: "the provider is rate limited",
          retryable: true,
        },
      }),
    );
    expect(provider.ok).toBe(true);
    if (!provider.ok) throw new Error(provider.message);
    expect(provider.authorization).toBe("blocked_provider_error");
    expect(provider.action).toBe("blocked");
    expect(provider.assurance).toBe("assurance_unknown");
    expect(provider.error).toMatchObject({
      domain: "provider",
      code: "provider_rate_limited",
      retryable: true,
    });
    expect(provider.receipt.memoryErrorCode).toBeNull();
    expect(provider.receipt.providerErrorCode).toBe("provider_rate_limited");
    // A provider outage is not reported as a memory fault.
    expect(provider.preflight.reason).toBe("verified_durable");
    expect(provider.preflight.verified).toBe(true);
    expect(provider.reexecute).toBe(false);
  });

  it("does not let a provider error mask a missing durable copy", async () => {
    const h = harness();
    const outcome = await h.port.authorizeCompaction(
      compaction({
        providerFailure: { code: "provider_unavailable", message: "down" },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.action).toBe("blocked");
    expect(outcome.assurance).toBe("assurance_unknown");
    expect(outcome.preflight.verified).toBe(false);
    expect(outcome.preflight.status).toBe("absent");
    // The missing durable copy is a policy block, so the provider outage is
    // never used as the explanation for the refusal.
    expect(outcome.error).toBeNull();
    expect(outcome.decision.reason).toBe("externalization_missing");
    expect(outcome.receipt.providerErrorCode).toBe("provider_unavailable");
    expect(outcome.receipt.memoryErrorCode).toBeNull();
    expect(outcome.reexecute).toBe(false);
  });

  it("records a compaction receipt for every authorization", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const outcome = await h.port.authorizeCompaction(compaction());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.recorded).toBe(true);
    const kinds = h.audits.appended.map((receipt) => receipt.kind);
    expect(kinds).toContain("memory_compaction_receipt_v1");
    expect(outcome.receipt.maskThreshold).toBe(12_000);
    expect(outcome.receipt.compressionThreshold).toBe(16_000);
    expect(outcome.receipt.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("memory durability lease and fencing", () => {
  it("rejects a missing lease when the host requires one", async () => {
    const h = harness({ requireLease: true });
    const result = await h.port.commit(commitInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a lease rejection");
    expect(result.code).toBe("memory_lease_missing");
    expect(result.reexecute).toBe(false);
  });

  it("rejects an expired lease before any durable write", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({
        lease: {
          leaseId: "lease-1",
          ownerId: "owner-1",
          epoch: 1,
          expiresAt: "2026-10-05T23:59:59.000Z",
          partition: memoryPartitionV1("run", SCOPE_KEY),
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an expiry rejection");
    expect(result.code).toBe("memory_lease_expired");
    expect(result.stage).toBe("artifact");
    expect(result.progress).toEqual({ artifact: false, receipt: false, manifest: false });
    expect(h.faults.trace).not.toContain("artifact.commitImmutable");
  });

  it("rejects a lease that is fenced to another partition", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({
        lease: {
          leaseId: "lease-1",
          ownerId: "owner-1",
          epoch: 3,
          expiresAt: "2026-10-06T00:05:00.000Z",
          partition: memoryPartitionV1("project", SCOPE_KEY),
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a fence rejection");
    expect(result.code).toBe("memory_lease_fenced");
    expect(result.details?.fence).toBe("lease_partition_mismatch");
  });

  it("rejects a lease whose epoch is not a positive integer", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({
        lease: {
          leaseId: "lease-1",
          ownerId: "owner-1",
          epoch: 0,
          expiresAt: "2026-10-06T00:05:00.000Z",
          partition: memoryPartitionV1("run", SCOPE_KEY),
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an epoch rejection");
    expect(result.code).toBe("memory_invalid_input");
  });

  it("fails closed when no lease validator is configured for a lease-carrying request", async () => {
    const faults = newFaults();
    const artifacts = new MemoryArtifactStoreFake(faults);
    const manifests = new MemoryManifestStoreFake(faults);
    const receipts = new MemoryReceiptStoreFake(faults);
    const audits = new MemoryAuditStoreFake(faults);
    const port = createContextMemoryDurabilityV1({
      artifacts,
      receipts,
      manifests,
      audits,
      now: (): Date => new Date(FIXED_NOW),
    });
    const result = await port.commit(
      commitInput({
        lease: {
          leaseId: "lease-1",
          ownerId: "owner-1",
          epoch: 1,
          expiresAt: "2026-10-06T00:05:00.000Z",
          partition: memoryPartitionV1("run", SCOPE_KEY),
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validator rejection");
    expect(result.code).toBe("memory_lease_fenced");
    expect(result.details?.fence).toBe("lease_validator_missing");
  });
});

describe("memory durability safety boundaries", () => {
  it("rejects prompts, transcripts, messages and credentials before any write", async () => {
    const h = harness();
    const cases: readonly [string, Record<string, unknown>][] = [
      ["prompt field", { prompt: "You are a helpful agent." }],
      ["transcript field", { transcript: ["user: hi"] }],
      ["message list", { messages: [{ role: "user", content: "hi" }] }],
      ["credential field", { credential: "opaque" }],
      ["api key field", { apiKey: "sk-live-123" }],
    ];
    for (const [label, extra] of cases) {
      const result = await h.port.commit(
        commitInput({ document: { ...document(), ...extra } as MemoryFactDocumentV1 }),
      );
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error(`expected a rejection for ${label}`);
      expect(result.code).toBe("memory_content_rejected");
    }
    expect(h.faults.trace).not.toContain("artifact.commitImmutable");
  });

  it("rejects absolute host paths in facts before any write", async () => {
    const h = harness();
    const windowsPath = await h.port.commit(
      commitInput({
        document: document({
          facts: [
            {
              factId: "fact-path",
              statement: "The file lives at C:\\Users\\test\\memory.md",
              basisRevision: 7,
              tags: [],
            },
          ],
          summaries: [],
        }),
      }),
    );
    expect(windowsPath.ok).toBe(false);
    if (windowsPath.ok) throw new Error("expected a path rejection");
    expect(windowsPath.code).toBe("memory_content_rejected");

    const posixPath = await h.port.commit(
      commitInput({
        document: document({
          facts: [
            {
              factId: "fact-path",
              statement: "The file lives at /Users/test/.pactile/memory.md",
              basisRevision: 7,
              tags: [],
            },
          ],
          summaries: [],
        }),
      }),
    );
    expect(posixPath.ok).toBe(false);
    if (posixPath.ok) throw new Error("expected a path rejection");
    expect(posixPath.details?.violation).toContain("path");
  });

  it("rejects a credential-shaped whenToRead hint", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({ whenToRead: "Read with api_key: sk-live-123 first." }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.code).toBe("memory_content_rejected");
  });

  it("rejects a summary that tries to carry exact-fact evidence", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({
        document: document({
          summaries: [
            {
              summaryId: "summary-1",
              statement: "A summary claiming exactness.",
              derivedFrom: ["fact-decision-1"],
              factId: "fact-forged",
            } as never,
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.code).toBe("memory_content_rejected");
    expect(result.details?.violation).toContain("unknown_summary_field");
  });

  it("rejects a summary that invents a fact reference", async () => {
    const h = harness();
    const result = await h.port.commit(
      commitInput({
        document: document({
          summaries: [
            {
              summaryId: "summary-1",
              statement: "A summary citing a nonexistent fact.",
              derivedFrom: ["fact-does-not-exist"],
            },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.details?.violation).toBe("summary_derives_from_unknown_fact");
  });

  it("keeps durable payloads free of absolute paths and logical references only", async () => {
    const h = harness();
    const committed = await h.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    expect(committed.storageRef).toMatch(/^memory:\/\//);
    const lookup = await h.manifests.readCurrent({ scope: "run", scopeKey: SCOPE_KEY });
    if (!lookup.ok) throw new Error("expected a manifest");
    const encoded = JSON.stringify(lookup.manifest);
    // Strip the sanctioned logical references first: `memory://` is the only
    // scheme a durable record may carry, so anything path-like left over is a
    // leak.
    const withoutRefs = encoded.replace(/memory:\/\/[^"\\]*/gu, "<memory-ref>");
    expect(withoutRefs).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(withoutRefs).not.toMatch(/\/(?:Users|home|var|tmp|etc)\//);
    expect(encoded).not.toContain("prompt");
    expect(encoded).not.toContain("transcript");
    expect(encoded).not.toContain("credential");
    // The manifest carries only logical references for every entry.
    for (const ref of encoded.match(/memory:\/\/[^"\\]*/gu) ?? []) {
      expect(ref).toMatch(/^memory:\/\/[a-z][a-z0-9._:-]*\/[1-9]\d*\/[0-9a-f]{64}$/u);
    }
  });

  it("redacts absolute paths from failure messages", () => {
    const sanitized = sanitizeMemoryMessageV1(
      "cannot read C:\\Users\\test\\.pactile\\memory.json or /Users/test/state.json",
    );
    expect(sanitized).not.toContain("C:\\Users");
    expect(sanitized).not.toContain("/Users/test");
    expect(sanitized).toContain("<redacted-path>");
    const failure = memoryDurabilityFailureV1(
      "memory_artifact_missing",
      "missing at D:/MyHarness/pactile/secret.json",
    );
    expect(failure.message).not.toContain("D:/MyHarness");
    expect(failure.reexecute).toBe(false);
    expect(failure.replayPolicy).toBe("no_automatic_replay");
  });

  it("never emits a second store, Kernel writer or coordinator seam", () => {
    // The port surface is exactly these five operations; adding a writer,
    // coordinator or second store would change this list.
    const port = harness().port as unknown as Record<string, unknown>;
    expect(Object.keys(port)).toEqual([]);
    expect(typeof port.commit).toBe("function");
    expect(typeof port.preflight).toBe("function");
    expect(typeof port.read).toBe("function");
    expect(typeof port.authorizeCompaction).toBe("function");
    expect(typeof port.recover).toBe("function");
  });

  it("emits no absolute paths from the artifact storage reference helpers", () => {
    const parsed = parseArtifactStorageRefV1("memory://memory-artifact-1/1/..%2f..");
    expect(parsed.ok).toBe(false);
    const doc = document();
    const bytes = encodeMemoryFactDocumentV1(doc);
    expect(hashArtifactContentV1(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ARTIFACT_STORE_SCHEMA_VERSION).toBe(1);
  });
});

describe("memory durability recovery reporting", () => {
  it("reports an orphan receipt as a waiting effect that is never replayed", async () => {
    const h = harness();
    const committed = await h.port.commit(commitInput());
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    // Drop the manifest but keep the receipt: the receipt is an unknown effect.
    h.manifests.dropManifest();
    const recovery = await h.port.recover({ scope: "run", scopeKey: SCOPE_KEY });
    expect(recovery.ok).toBe(true);
    if (!recovery.ok) throw new Error(recovery.message);
    expect(recovery.replayPolicy).toBe("no_automatic_replay");
    expect(recovery.manifestTrusted).toBe(false);
    expect(recovery.effects).toHaveLength(1);
    expect(recovery.effects[0]).toMatchObject({
      status: "waiting",
      assurance: "assurance_unknown",
      reexecute: false,
      reason: "effect_pending",
    });
  });

  it("reports no effects for a fully verified durable state", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const recovery = await h.port.recover({ scope: "run", scopeKey: SCOPE_KEY });
    expect(recovery.ok).toBe(true);
    if (!recovery.ok) throw new Error(recovery.message);
    expect(recovery.manifestTrusted).toBe(true);
    expect(recovery.verifiedEntries).toBe(1);
    expect(recovery.effects).toHaveLength(0);
    expect(recovery.manifestRevision).toBe(1);
  });

  it("refuses recovery when the manifest is damaged", async () => {
    const h = harness();
    h.manifests.corrupt();
    const recovery = await h.port.recover({ scope: "run", scopeKey: SCOPE_KEY });
    expect(recovery.ok).toBe(false);
    if (recovery.ok) throw new Error("expected a refusal");
    expect(recovery.code).toBe("memory_manifest_corrupt");
  });
});

describe("memory durability document and receipt decoding", () => {
  it("round-trips a fact document canonically", () => {
    const doc = document();
    const first = encodeMemoryFactDocumentV1(doc);
    const second = encodeMemoryFactDocumentV1(doc);
    expect(hashArtifactContentV1(first)).toBe(hashArtifactContentV1(second));
    const decoded = decodeMemoryFactDocumentV1(JSON.parse(new TextDecoder().decode(first)));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.message);
    expect(decoded.document.facts).toHaveLength(2);
    expect(decoded.document.summaries[0]?.derivedFrom).toEqual([
      "fact-decision-1",
      "fact-constraint-1",
    ]);
  });

  it("rejects a fact whose basis revision drifts from the document", () => {
    const decoded = decodeMemoryFactDocumentV1({
      ...document(),
      facts: [
        {
          factId: "fact-decision-1",
          statement: "A drifting fact.",
          basisRevision: 99,
          tags: [],
        },
      ],
      summaries: [],
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a rejection");
    expect(decoded.details?.violation).toBe("fact_basis_revision_mismatch");
  });

  it("rejects a receipt whose storage reference disagrees with its fields", () => {
    const valid: MemoryDurableReceiptV1 = {
      schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
      kind: MEMORY_DURABLE_RECEIPT_KIND_V1,
      receiptId: "memory_receipt_v1_abc",
      requestId: "req-memory-1",
      requestHash: `sha256:${"a".repeat(64)}`,
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "memory-artifact-1",
      version: 1,
      basisRevision: 7,
      contentHash: `sha256:${"b".repeat(64)}`,
      byteLength: 10,
      storageRef: `memory://memory-artifact-1/2/${"b".repeat(64)}`,
      factCount: 1,
      summaryCount: 0,
      whenToRead: "Read me.",
      committedAt: FIXED_NOW,
      receiptHash: `sha256:${"c".repeat(64)}`,
    };
    expect(decodeMemoryDurableReceiptV1(valid)).toBeNull();
    expect(
      decodeMemoryDurableReceiptV1({
        ...valid,
        storageRef: `memory://memory-artifact-1/1/${"b".repeat(64)}`,
      }),
    ).toBeNull();
  });

  it("exposes manifest entries and validation helpers for hosts", () => {
    const entry = memoryManifestEntryFromReceiptV1({
      schemaVersion: MEMORY_DURABILITY_SCHEMA_VERSION,
      kind: MEMORY_DURABLE_RECEIPT_KIND_V1,
      receiptId: "memory_receipt_v1_abc",
      requestId: "req-memory-1",
      requestHash: `sha256:${"a".repeat(64)}`,
      scope: "run",
      scopeKey: SCOPE_KEY,
      artifactId: "memory-artifact-1",
      version: 1,
      basisRevision: 7,
      contentHash: `sha256:${"b".repeat(64)}`,
      byteLength: 10,
      storageRef: `memory://memory-artifact-1/1/${"b".repeat(64)}`,
      factCount: 1,
      summaryCount: 0,
      whenToRead: "Read me.",
      committedAt: FIXED_NOW,
      receiptHash: `sha256:${"c".repeat(64)}`,
    });
    expect(entry.storageRef).toMatch(/^memory:\/\//);
    expect(isArtifactScopeKeyV1(SCOPE_KEY)).toBe(true);
    expect(MEMORY_COMMIT_ORDER_V1).toEqual(["artifact", "receipt", "manifest"]);
  });

  it("keeps the preflight externalization payload compatible with the policy seam", async () => {
    const h = harness();
    await h.port.commit(commitInput());
    const preflight = await h.port.preflight({
      scope: "run",
      scopeKey: SCOPE_KEY,
      basisRevision: 7,
      disclose: true,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) throw new Error(preflight.message);
    const durablePreflight = preflight as MemoryPreflightV1;
    expect(durablePreflight.externalization.status).toBe("durable");
    expect(durablePreflight.externalization.disclosed).toBe(true);
    expect(durablePreflight.externalization.path).toBeTruthy();
    expect(durablePreflight.externalization.fingerprint).toBeTruthy();
    expect(durablePreflight.externalization.whenToRead).toBeTruthy();
  });

  it("rejects invalid commit identity inputs", async () => {
    const h = harness();
    for (const overrides of [
      { artifactId: "Invalid-Id" },
      { version: 0 },
      { basisRevision: -1 },
      { scopeKey: " padded" },
      { requestId: "BAD ID" },
    ]) {
      const result = await h.port.commit(commitInput(overrides));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected an invalid input rejection");
      expect(result.code).toBe("memory_invalid_input");
    }
  });
});


