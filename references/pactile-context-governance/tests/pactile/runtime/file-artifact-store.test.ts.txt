import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  formatArtifactStorageRefV1,
  hashArtifactContentV1,
  type ArtifactStoreCommitInputV1,
  type ArtifactStorePrepareInputV1,
} from "../../../src/core/index.js";

import {
  FILE_ARTIFACT_STORE_LAYOUT_VERSION,
  FileArtifactStore,
  FileArtifactStoreError,
} from "../../../src/pactile/runtime/file-artifact-store.js";

const encoder = new TextEncoder();
const roots: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-artifacts-"));
  roots.push(root);
  return root;
}

function storeRoot(): string {
  return path.join(fixtureRoot(), ".pactile", "runtime", "memory-artifacts");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function prepareInput(
  overrides: Partial<ArtifactStorePrepareInputV1> = {},
): ArtifactStorePrepareInputV1 {
  return {
    artifactId: "memory-artifact-1",
    scope: "run",
    scopeKey: "workspace-1/project-1/run/run-1",
    version: 1,
    basisRevision: 7,
    content: encoder.encode("payload-1"),
    ...overrides,
  };
}

function commitInputFor(
  overrides: Partial<ArtifactStoreCommitInputV1> = {},
): ArtifactStoreCommitInputV1 {
  const content = encoder.encode("payload-1");
  return {
    artifactId: "memory-artifact-1",
    scope: "run",
    scopeKey: "workspace-1/project-1/run/run-1",
    version: 1,
    basisRevision: 7,
    contentHash: hashArtifactContentV1(content),
    byteLength: content.byteLength,
    ...overrides,
  };
}

async function commitOne(
  store: FileArtifactStore,
  overrides: Partial<ArtifactStorePrepareInputV1> = {},
): Promise<string> {
  const prepared = await store.prepare(prepareInput(overrides));
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
  const committed = await store.commitImmutable({
    artifactId: prepared.identity.artifactId,
    scope: prepared.identity.scope,
    scopeKey: prepared.identity.scopeKey,
    version: prepared.identity.version,
    basisRevision: prepared.identity.basisRevision,
    contentHash: prepared.identity.contentHash,
    byteLength: prepared.identity.byteLength,
  });
  if (!committed.ok) throw new Error(`commit failed: ${committed.code}`);
  return committed.identity.storageRef;
}

/** Count every file below a directory; used to prove no second payload copy. */
function fileCount(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    count += entry.isDirectory() ? fileCount(target) : 1;
  }
  return count;
}

describe("FileArtifactStore lifecycle", () => {
  it("commits an immutable object and reads it back deterministically", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot(), now: () => new Date("2026-10-04T00:00:00.000Z") });
    const content = encoder.encode("payload-1");
    const prepared = await store.prepare(prepareInput());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected prepare success");
    expect(prepared.replay).toBe(false);
    const committed = await store.commitImmutable(
      commitInputFor({ contentHash: prepared.identity.contentHash }),
    );
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error("expected commit success");
    expect(committed.identity.storageRef).toBe(
      formatArtifactStorageRefV1(
        "memory-artifact-1",
        1,
        hashArtifactContentV1(content),
      ),
    );
    expect(committed.committedAt).toBe("2026-10-04T00:00:00.000Z");

    const read = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef: committed.identity.storageRef,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected read success");
    expect(new TextDecoder().decode(read.content)).toBe("payload-1");
    // Deterministic: the same logical reference always returns the same bytes.
    const second = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef: committed.identity.storageRef,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected read success");
    expect(Buffer.from(second.content).equals(Buffer.from(read.content))).toBe(true);
  });

  it("replays an identical prepare and commit without a second payload", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const first = await store.prepare(prepareInput());
    expect(first.ok).toBe(true);
    await store.commitImmutable(commitInputFor());
    const filesAfterCommit = fileCount(root);

    const secondPrepare = await store.prepare(prepareInput());
    expect(secondPrepare.ok).toBe(true);
    if (!secondPrepare.ok) throw new Error("expected prepare success");
    expect(secondPrepare.replay).toBe(true);
    const secondCommit = await store.commitImmutable(commitInputFor());
    expect(secondCommit.ok).toBe(true);
    if (!secondCommit.ok) throw new Error("expected commit success");
    expect(secondCommit.replay).toBe(true);
    expect(fileCount(root)).toBe(filesAfterCommit);

    const objects = fileCount(path.join(root, "objects"));
    expect(objects).toBe(1);
  });

  it("reopens the same storage root and reads the committed object back", async () => {
    const root = storeRoot();
    const first = new FileArtifactStore({ storageRoot: root });
    const storageRef = await commitOne(first);
    // A brand-new adapter instance (restart) must find the same object.
    const reopened = new FileArtifactStore({ storageRoot: root });
    const read = await reopened.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected read success");
    expect(new TextDecoder().decode(read.content)).toBe("payload-1");
    const diagnostics = reopened.diagnostics();
    expect(diagnostics.layoutVersion).toBe(FILE_ARTIFACT_STORE_LAYOUT_VERSION);
    expect(diagnostics.objectRoot.startsWith(root)).toBe(true);
  });

  it("keeps distinct versions and scopes as separate immutable objects", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    const versionOne = await commitOne(store);
    const versionTwo = await commitOne(store, {
      version: 2,
      content: encoder.encode("payload-2"),
      basisRevision: 8,
    });
    expect(versionOne).not.toBe(versionTwo);
    const readOne = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef: versionOne,
    });
    const readTwo = await store.read({
      artifactId: "memory-artifact-1",
      version: 2,
      storageRef: versionTwo,
    });
    expect(readOne.ok && new TextDecoder().decode(readOne.content)).toBe("payload-1");
    expect(readTwo.ok && new TextDecoder().decode(readTwo.content)).toBe("payload-2");
  });
});

describe("FileArtifactStore fail-closed refusals", () => {
  it("rejects malformed prepare input without touching storage", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const cases: readonly [string, Partial<ArtifactStorePrepareInputV1>][] = [
      ["empty artifact id", { artifactId: "" }],
      ["path-like artifact id", { artifactId: "../escape" }],
      ["unknown scope", { scope: "session" as ArtifactStorePrepareInputV1["scope"] }],
      ["empty scope key", { scopeKey: "" }],
      ["zero version", { version: 0 }],
      ["negative basis", { basisRevision: -1 }],
    ];
    for (const [label, overrides] of cases) {
      const result = await store.prepare(prepareInput(overrides));
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.code, label).toBe("artifact_invalid_input");
    }
    expect(fileCount(path.join(root, "objects"))).toBe(0);
  });

  it("refuses a declared hash that does not match the prepared bytes", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    const result = await store.prepare(
      prepareInput({ expectedContentHash: `sha256:${"a".repeat(64)}` }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("artifact_hash_mismatch");
  });

  it("refuses committing a version that was never prepared", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    const result = await store.commitImmutable(commitInputFor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("artifact_not_prepared");
  });

  it("refuses an immutable overwrite with a different hash, scope or basis", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    await commitOne(store);
    const cases: readonly [string, Partial<ArtifactStoreCommitInputV1>][] = [
      ["hash", { contentHash: hashArtifactContentV1(encoder.encode("payload-9")) }],
      ["size", { byteLength: 99 }],
      ["basis", { basisRevision: 8 }],
      ["scope", { scope: "project" }],
      ["scopeKey", { scopeKey: "workspace-1/project-1/project" }],
    ];
    for (const [label, overrides] of cases) {
      const result = await store.commitImmutable(commitInputFor(overrides));
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.code, label).toBe("artifact_conflict");
    }
    // A conflicting prepare for the same version is refused for the same reason.
    const conflictingPrepare = await store.prepare(
      prepareInput({ content: encoder.encode("payload-9") }),
    );
    expect(conflictingPrepare.ok).toBe(false);
    if (conflictingPrepare.ok) throw new Error("expected refusal");
    expect(conflictingPrepare.code).toBe("artifact_conflict");
  });

  it("refuses an unknown artifact, a version mismatch and a hash mismatch on read", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    const storageRef = await commitOne(store);
    const unknown = await store.read({
      artifactId: "memory-artifact-2",
      version: 1,
      storageRef: storageRef.replace("memory-artifact-1", "memory-artifact-2"),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("artifact_not_found");

    const wrongVersion = await store.read({
      artifactId: "memory-artifact-1",
      version: 2,
      storageRef,
    });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.code).toBe("artifact_ref_invalid");

    const staleRef = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef: formatArtifactStorageRefV1(
        "memory-artifact-1",
        1,
        hashArtifactContentV1(encoder.encode("other")),
      ),
    });
    expect(staleRef.ok).toBe(false);
    if (!staleRef.ok) expect(staleRef.code).toBe("artifact_stale");
  });

  it("refuses scope mismatch and stale basis expectations on read", async () => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    const storageRef = await commitOne(store);
    const mismatchedScope = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
      scope: "workItem",
    });
    expect(mismatchedScope.ok).toBe(false);
    if (!mismatchedScope.ok) expect(mismatchedScope.code).toBe("artifact_scope_mismatch");

    const mismatchedKey = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
      scopeKey: "workspace-1/project-1/project",
    });
    expect(mismatchedKey.ok).toBe(false);
    if (!mismatchedKey.ok) expect(mismatchedKey.code).toBe("artifact_scope_mismatch");

    const staleBasis = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
      basisRevision: 6,
    });
    expect(staleBasis.ok).toBe(false);
    if (!staleBasis.ok) expect(staleBasis.code).toBe("artifact_stale");
  });

  it.each([
    ["absolute path", "/etc/artifacts/1"],
    ["Windows drive path", "C:/artifacts/1/aa"],
    ["traversal", "memory://memory-artifact-1/1/../../etc/passwd"],
    ["dot segment", "memory://memory-artifact-1/1/.."],
    ["percent encoding", "memory://memory-artifact-1/1/%2e%2e"],
    ["scheme swap", "file://memory-artifact-1/1/aa"],
    ["backslash", "memory://memory-artifact-1\\1\\aa"],
  ])("refuses a %s storageRef without returning content", async (_label, storageRef) => {
    const store = new FileArtifactStore({ storageRoot: storeRoot() });
    await commitOne(store);
    const result = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(["artifact_ref_invalid", "artifact_path_escape"]).toContain(result.code);
    expect(result).not.toHaveProperty("content");
  });

  it("detects a truncated or tampered committed payload", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const storageRef = await commitOne(store);
    const objectRoot = path.join(root, "objects");
    const [bucket] = fs.readdirSync(objectRoot);
    if (bucket === undefined) throw new Error("expected an object bucket");
    const [objectName] = fs.readdirSync(path.join(objectRoot, bucket));
    if (objectName === undefined) throw new Error("expected an object file");
    const objectPath = path.join(objectRoot, bucket, objectName);

    const original = fs.readFileSync(objectPath);
    fs.writeFileSync(objectPath, original.subarray(0, 2));
    const truncated = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.code).toBe("artifact_size_mismatch");

    fs.writeFileSync(objectPath, Buffer.concat([Buffer.from("TAMPERED"), original.subarray(8)]));
    const tampered = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.code).toBe("artifact_hash_mismatch");

    fs.writeFileSync(objectPath, original);
    const restored = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(restored.ok).toBe(true);
  });

  it("reports a deleted committed payload as missing", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const storageRef = await commitOne(store);
    fs.rmSync(path.join(root, "objects"), { recursive: true, force: true });
    const result = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("artifact_not_found");
  });

  it("refuses a storage root inside a symlink escape", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-outside-"));
    roots.push(outside);
    const linkPath = path.join(fixtureRoot(), ".pactile", "linked-artifacts");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.symlinkSync(outside, linkPath, "dir");
    } catch {
      return; // Symlink creation may be unavailable without the right policy.
    }
    expect(() => new FileArtifactStore({ storageRoot: linkPath })).toThrowError(
      FileArtifactStoreError,
    );
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });

  it("refuses a file where a record bucket is expected instead of guessing", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const storageRef = await commitOne(store);
    const recordRoot = path.join(root, "records");
    const [bucket] = fs.readdirSync(recordRoot);
    if (bucket === undefined) throw new Error("expected a record bucket");
    const bucketPath = path.join(recordRoot, bucket);
    fs.rmSync(bucketPath, { recursive: true, force: true });
    fs.writeFileSync(bucketPath, "not-a-directory");
    const result = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("artifact_path_escape");
  });

  it("rejects an unusable storage root option", () => {
    expect(() => new FileArtifactStore({ storageRoot: "relative/path" })).toThrowError(
      FileArtifactStoreError,
    );
    expect(() => new FileArtifactStore({ storageRoot: path.join(fixtureRoot(), "app-data", "artifacts") })).toThrowError(
      FileArtifactStoreError,
    );
    expect(() => new FileArtifactStore({ storageRoot: "   " })).toThrowError(
      FileArtifactStoreError,
    );
  });

  it("persists only the immutable binding and never prompt, transcript or WorkItem facts", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    await commitOne(store, {
      content: encoder.encode('{"prompt":"must-not-be-metadata"}'),
    });
    const recordRoot = path.join(root, "records");
    const [bucket] = fs.readdirSync(recordRoot);
    if (bucket === undefined) throw new Error("expected a record bucket");
    const [recordName] = fs.readdirSync(path.join(recordRoot, bucket));
    if (recordName === undefined) throw new Error("expected a record file");
    const record = JSON.parse(
      fs.readFileSync(path.join(recordRoot, bucket, recordName), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "artifactId",
      "basisRevision",
      "byteLength",
      "committedAt",
      "contentHash",
      "schemaVersion",
      "scope",
      "scopeKey",
      "storageRef",
      "version",
    ]);
    for (const forbidden of [
      "prompt",
      "transcript",
      "messages",
      "workItem",
      "gate",
      "settlement",
    ]) {
      expect(record).not.toHaveProperty(forbidden);
    }
  });

  it("reads by exact binding path and never falls back to a full-disk search", async () => {
    const root = storeRoot();
    const store = new FileArtifactStore({ storageRoot: root });
    const content = encoder.encode("payload-1");
    const storageRef = await commitOne(store);
    // An identical byte copy elsewhere below the storage root must never be
    // discovered by a search: only the recorded content-addressed path counts.
    const decoy = path.join(root, "decoy");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "payload-1.bin"), content);
    fs.rmSync(path.join(root, "objects"), { recursive: true, force: true });
    const result = await store.read({
      artifactId: "memory-artifact-1",
      version: 1,
      storageRef,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("artifact_not_found");
  });
});
