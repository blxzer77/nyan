/** Filesystem-backed immutable ArtifactStore repository adapter. */
import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_STORE_SCHEMA_VERSION,
  artifactStoreFailureV1,
  compareArtifactStoreBindingsV1,
  decodeArtifactStoreObjectV1,
  encodeArtifactStoreObjectV1,
  formatArtifactStorageRefV1,
  hashArtifactContentV1,
  parseArtifactStorageRefV1,
  validateArtifactStoreCommitInputV1,
  validateArtifactStorePrepareInputV1,
  validateArtifactStoreReadInputV1,
  verifyArtifactStoreContentV1,
  verifyArtifactStoreExpectationsV1,
  type ArtifactStoreBindingV1,
  type ArtifactStoreCommitInputV1,
  type ArtifactStoreCommitResultV1,
  type ArtifactStoreFailureV1,
  type ArtifactStoreObjectV1,
  type ArtifactStorePort,
  type ArtifactStorePrepareInputV1,
  type ArtifactStorePrepareResultV1,
  type ArtifactStoreReadInputV1,
  type ArtifactStoreReadResultV1,
} from "../../../agent/memory/artifact-store.js";
import {
  assertCanonicalWriteTarget,
  inferCanonicalProjectRoot,
  type RuntimeFileSystem,
} from "../../paths.js";
import {
  ArtifactBoundaryError,
  assertLexicallyInside,
  inspectPath,
  isRecordLike,
  keyHash,
  lstatOrNull,
  readFileBoundary,
  unlinkQuietly,
  writeTemporary,
} from "./filesystem.js";
import {
  FILE_ARTIFACT_STORE_LAYOUT_VERSION,
  FileArtifactStoreError,
  type PayloadLookup,
  type RecordLookup,
  type StageLookup,
  type FileArtifactStoreDiagnostics,
  type FileArtifactStoreOptions,
} from "./types.js";

/** Immutable, content-addressed memory artifact store below `.pactile/`. */
export class FileArtifactStore implements ArtifactStorePort {
  readonly projectRoot: string;
  readonly storageRoot: string;
  readonly schemaVersion = ARTIFACT_STORE_SCHEMA_VERSION;
  readonly layoutVersion = FILE_ARTIFACT_STORE_LAYOUT_VERSION;

  readonly #io: RuntimeFileSystem;
  readonly #now: () => Date;
  readonly #realRoot: string;
  readonly #objectRoot: string;
  readonly #recordRoot: string;
  readonly #stagingRoot: string;
  constructor(options: FileArtifactStoreOptions) {
    const rawOptions: unknown = options;
    if (!isRecordLike(rawOptions)) {
      throw new FileArtifactStoreError(
        "artifact_store_invalid_options",
        "artifact store options must be an object",
      );
    }
    const io = options.io ?? fs;
    const requestedProjectRoot = options.projectRoot;
    if (
      requestedProjectRoot !== undefined &&
      (typeof requestedProjectRoot !== "string" ||
        requestedProjectRoot.trim().length === 0 ||
        !path.isAbsolute(requestedProjectRoot))
    ) {
      throw new FileArtifactStoreError(
        "artifact_store_invalid_options",
        "projectRoot must be an explicit absolute repository path",
      );
    }
    const requestedStorageRoot = options.storageRoot;
    if (
      requestedStorageRoot !== undefined &&
      (typeof requestedStorageRoot !== "string" ||
        requestedStorageRoot.trim().length === 0 ||
        !path.isAbsolute(requestedStorageRoot))
    ) {
      throw new FileArtifactStoreError(
        "artifact_store_invalid_options",
        "storageRoot must be an explicit absolute path below .pactile",
      );
    }
    const inferredProjectRoot =
      requestedStorageRoot === undefined
        ? null
        : inferCanonicalProjectRoot(requestedStorageRoot);
    const projectRoot = path.resolve(
      requestedProjectRoot ?? inferredProjectRoot ?? "",
    );
    if (
      (requestedProjectRoot === undefined && inferredProjectRoot === null) ||
      (projectRoot === path.parse(projectRoot).root &&
        requestedProjectRoot === undefined)
    ) {
      throw new FileArtifactStoreError(
        "artifact_store_invalid_options",
        "projectRoot must be explicit or inferable from a path below .pactile",
      );
    }
    const root = path.resolve(
      requestedStorageRoot ??
        path.join(projectRoot, ".pactile", "runtime", "memory-artifacts"),
    );
    const canonicalRoot = path.join(projectRoot, ".pactile");
    const relativeToCanonical = path.relative(canonicalRoot, root);
    if (
      relativeToCanonical.startsWith(`..${path.sep}`) ||
      relativeToCanonical === ".." ||
      path.isAbsolute(relativeToCanonical)
    ) {
      throw new FileArtifactStoreError(
        "artifact_store_invalid_options",
        "storageRoot must remain inside the canonical .pactile tree",
      );
    }
    this.projectRoot = projectRoot;
    this.storageRoot = root;
    this.#io = io;
    this.#now = options.now ?? (() => new Date());
    try {
      const projectStat = lstatOrNull(io, projectRoot);
      if (
        projectStat === null ||
        projectStat.isSymbolicLink() ||
        !projectStat.isDirectory() ||
        path.relative(io.realpathSync(projectRoot), projectRoot) !== ""
      ) {
        throw new FileArtifactStoreError(
          "artifact_store_io_failed",
          "projectRoot must be a real directory",
        );
      }
      // Check the exact canonical spelling before creating missing directories.
      assertCanonicalWriteTarget(projectRoot, root, io);
      const existing = lstatOrNull(io, root);
      if (existing === null) {
        io.mkdirSync(root, { recursive: true, mode: 0o700 });
      } else if (existing.isSymbolicLink()) {
        throw new FileArtifactStoreError(
          "artifact_store_io_failed",
          "storageRoot must not be a symbolic link",
        );
      } else if (!existing.isDirectory()) {
        throw new FileArtifactStoreError(
          "artifact_store_io_failed",
          "storageRoot must be a directory",
        );
      }
      assertCanonicalWriteTarget(projectRoot, root, io);
      this.#realRoot = io.realpathSync(root);
      if (path.relative(this.#realRoot, root) !== "") {
        throw new FileArtifactStoreError(
          "artifact_store_io_failed",
          "storageRoot must not traverse a symbolic link",
        );
      }
    } catch (error) {
      if (error instanceof FileArtifactStoreError) throw error;
      throw new FileArtifactStoreError(
        "artifact_store_io_failed",
        "storageRoot is not usable inside the canonical .pactile tree",
      );
    }
    this.#objectRoot = path.join(root, "objects");
    this.#recordRoot = path.join(root, "records");
    this.#stagingRoot = path.join(root, "staging");
  }

  diagnostics(): FileArtifactStoreDiagnostics {
    return {
      projectRoot: this.projectRoot,
      storageRoot: this.storageRoot,
      objectRoot: this.#objectRoot,
      recordRoot: this.#recordRoot,
      stagingRoot: this.#stagingRoot,
      schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
      layoutVersion: FILE_ARTIFACT_STORE_LAYOUT_VERSION,
    };
  }

  async prepare(
    input: ArtifactStorePrepareInputV1,
  ): Promise<ArtifactStorePrepareResultV1> {
    return this.#guard(this.#artifactIdOf(input), () => this.#prepare(input));
  }

  async commitImmutable(
    input: ArtifactStoreCommitInputV1,
  ): Promise<ArtifactStoreCommitResultV1> {
    return this.#guard(this.#artifactIdOf(input), () => this.#commit(input));
  }

  async read(
    input: ArtifactStoreReadInputV1,
  ): Promise<ArtifactStoreReadResultV1> {
    return this.#guard(this.#artifactIdOf(input), () => this.#read(input));
  }

  #artifactIdOf(input: unknown): string | null {
    return isRecordLike(input) && typeof input.artifactId === "string"
      ? input.artifactId
      : null;
  }

  #guard<TResult>(
    artifactId: string | null,
    action: () => TResult,
  ): TResult | ArtifactStoreFailureV1 {
    try {
      return action();
    } catch (error) {
      if (error instanceof ArtifactBoundaryError) {
        return artifactStoreFailureV1(
          error.code,
          error.message,
          artifactId,
          error.details,
        );
      }
      return artifactStoreFailureV1(
        "artifact_io_failed",
        "artifact store operation failed",
        artifactId,
        {
          reason: error instanceof Error ? error.name : typeof error,
        },
      );
    }
  }

  #binding(
    identity: {
      readonly artifactId: string;
      readonly scope: ArtifactStoreCommitInputV1["scope"];
      readonly scopeKey: string;
      readonly version: number;
      readonly basisRevision: number;
    },
    contentHash: string,
    byteLength: number,
  ): ArtifactStoreBindingV1 {
    return Object.freeze({
      artifactId: identity.artifactId,
      scope: identity.scope,
      scopeKey: identity.scopeKey,
      version: identity.version,
      basisRevision: identity.basisRevision,
      contentHash,
      byteLength,
      storageRef: formatArtifactStorageRefV1(
        identity.artifactId,
        identity.version,
        contentHash,
      ),
    });
  }

  #objectPath(contentHash: string): string {
    const hex = contentHash.slice("sha256:".length);
    return path.join(this.#objectRoot, hex.slice(0, 2), hex);
  }

  #recordPath(artifactId: string, version: number): string {
    const key = keyHash(artifactId, version);
    return path.join(this.#recordRoot, key.slice(0, 2), `${key}.json`);
  }

  #stageBlobPath(artifactId: string, version: number): string {
    return path.join(this.#stagingRoot, `${keyHash(artifactId, version)}.blob`);
  }

  #stageRecordPath(artifactId: string, version: number): string {
    return path.join(this.#stagingRoot, `${keyHash(artifactId, version)}.json`);
  }

  #prepare(input: ArtifactStorePrepareInputV1): ArtifactStorePrepareResultV1 {
    const invalid = validateArtifactStorePrepareInputV1(input);
    if (invalid !== null) return invalid;
    const contentHash = hashArtifactContentV1(input.content);
    if (
      input.expectedContentHash !== undefined &&
      input.expectedContentHash !== contentHash
    ) {
      return artifactStoreFailureV1(
        "artifact_hash_mismatch",
        "prepared payload does not match the declared content hash",
        input.artifactId,
        { computed: contentHash, declared: input.expectedContentHash },
      );
    }
    const identity = this.#binding(
      input,
      contentHash,
      input.content.byteLength,
    );
    const existing = this.#readRecord(identity.artifactId, identity.version);
    if (existing.kind === "failure") return existing.failure;
    if (existing.kind === "record") {
      const conflict = compareArtifactStoreBindingsV1(
        existing.record,
        identity,
      );
      if (conflict !== null) return conflict;
      return {
        ok: true,
        replay: true,
        identity: existing.record,
        preparedAt: existing.record.committedAt,
      };
    }
    const stage = this.#readStage(identity.artifactId, identity.version);
    if (stage.kind === "failure") return stage.failure;
    if (stage.kind === "stage") {
      const conflict = compareArtifactStoreBindingsV1(stage.stage, identity);
      if (conflict !== null) return conflict;
      return {
        ok: true,
        replay: true,
        identity: stage.stage,
        preparedAt: stage.stage.committedAt,
      };
    }
    // A missing or undecodable stage is pre-commit residue and safe to replace.
    const preparedAt = this.#now().toISOString();
    const stagedRecord: ArtifactStoreObjectV1 = Object.freeze({
      ...identity,
      schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
      committedAt: preparedAt,
    });
    this.#writeAtomic(
      this.#stageBlobPath(identity.artifactId, identity.version),
      input.content,
    );
    this.#writeAtomic(
      this.#stageRecordPath(identity.artifactId, identity.version),
      encodeArtifactStoreObjectV1(stagedRecord),
    );
    return { ok: true, replay: false, identity, preparedAt };
  }

  #commit(input: ArtifactStoreCommitInputV1): ArtifactStoreCommitResultV1 {
    const invalid = validateArtifactStoreCommitInputV1(input);
    if (invalid !== null) return invalid;
    const identity = this.#binding(input, input.contentHash, input.byteLength);
    const existing = this.#readRecord(identity.artifactId, identity.version);
    if (existing.kind === "failure") return existing.failure;
    if (existing.kind === "record") {
      const conflict = compareArtifactStoreBindingsV1(
        existing.record,
        identity,
      );
      if (conflict !== null) return conflict;
      return {
        ok: true,
        replay: true,
        identity: existing.record,
        committedAt: existing.record.committedAt,
      };
    }
    const stage = this.#readStage(identity.artifactId, identity.version);
    if (stage.kind === "failure") return stage.failure;
    if (stage.kind === "corrupt") {
      return artifactStoreFailureV1(
        "artifact_corrupt",
        "prepared artifact record is damaged",
        identity.artifactId,
      );
    }
    if (stage.kind === "missing") {
      return artifactStoreFailureV1(
        "artifact_not_prepared",
        `artifact ${identity.artifactId}/${identity.version} was not prepared`,
        identity.artifactId,
        { version: identity.version },
      );
    }
    const stageConflict = compareArtifactStoreBindingsV1(stage.stage, identity);
    if (stageConflict !== null) return stageConflict;
    const payload = this.#readStageBlob(stage.stage);
    if (payload.kind === "failure") return payload.failure;
    const contentFailure = verifyArtifactStoreContentV1(
      stage.stage,
      payload.content,
    );
    if (contentFailure !== null) return contentFailure;

    this.#commitObject(stage.stage, payload.content);
    const committedAt = this.#now().toISOString();
    const record: ArtifactStoreObjectV1 = Object.freeze({
      ...identity,
      schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
      committedAt,
    });
    const recordFailure = this.#commitRecord(record);
    if (recordFailure !== null) return recordFailure;
    unlinkQuietly(
      this.#io,
      this.#stageBlobPath(identity.artifactId, identity.version),
    );
    unlinkQuietly(
      this.#io,
      this.#stageRecordPath(identity.artifactId, identity.version),
    );
    return { ok: true, replay: false, identity, committedAt };
  }

  #read(input: ArtifactStoreReadInputV1): ArtifactStoreReadResultV1 {
    const invalid = validateArtifactStoreReadInputV1(input);
    if (invalid !== null) return invalid;
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
        {
          referencedArtifactId: parsed.reference.artifactId,
          referencedVersion: parsed.reference.version,
        },
      );
    }
    const existing = this.#readRecord(input.artifactId, input.version);
    if (existing.kind === "failure") return existing.failure;
    if (existing.kind === "missing") {
      return artifactStoreFailureV1(
        "artifact_not_found",
        `no committed artifact ${input.artifactId}/${input.version}`,
        input.artifactId,
        { version: input.version },
      );
    }
    const record = existing.record;
    if (record.contentHash !== parsed.reference.contentHash) {
      return artifactStoreFailureV1(
        "artifact_stale",
        "storageRef does not match the committed content hash of this artifact version",
        input.artifactId,
        {
          committed: record.contentHash,
          referenced: parsed.reference.contentHash,
        },
      );
    }
    const expectationFailure = verifyArtifactStoreExpectationsV1(record, {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
      ...(input.basisRevision === undefined
        ? {}
        : { basisRevision: input.basisRevision }),
      ...(input.contentHash === undefined
        ? {}
        : { contentHash: input.contentHash }),
      ...(input.byteLength === undefined
        ? {}
        : { byteLength: input.byteLength }),
    });
    if (expectationFailure !== null) return expectationFailure;
    const payload = this.#readObject(record);
    if (payload.kind === "failure") return payload.failure;
    const contentFailure = verifyArtifactStoreContentV1(
      record,
      payload.content,
    );
    if (contentFailure !== null) return contentFailure;
    return { ok: true, identity: record, content: payload.content };
  }

  #readRecord(artifactId: string, version: number): RecordLookup {
    const target = this.#recordPath(artifactId, version);
    const stat = this.#inspect(target);
    if (stat === null) return { kind: "missing" };
    if (!stat.isFile()) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "artifact record path is not a regular file",
          artifactId,
          { version },
        ),
      };
    }
    const decoded = this.#decodeStored(target, artifactId, version);
    if (decoded.kind === "failure") return decoded;
    const record = decoded.record;
    if (record.artifactId !== artifactId || record.version !== version) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "artifact record does not match its storage location",
          artifactId,
          { version },
        ),
      };
    }
    return { kind: "record", record };
  }

  #readStage(artifactId: string, version: number): StageLookup {
    const target = this.#stageRecordPath(artifactId, version);
    const stat = this.#inspect(target);
    if (stat === null) return { kind: "missing" };
    if (!stat.isFile()) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "staged artifact record path is not a regular file",
          artifactId,
          { version },
        ),
      };
    }
    const decoded = this.#decodeStored(target, artifactId, version);
    if (decoded.kind === "failure") {
      return decoded.failure.code === "artifact_io_failed"
        ? { kind: "failure", failure: decoded.failure }
        : { kind: "corrupt" };
    }
    return { kind: "stage", stage: decoded.record };
  }

  #decodeStored(
    target: string,
    artifactId: string,
    version: number,
  ):
    | { readonly kind: "failure"; readonly failure: ArtifactStoreFailureV1 }
    | { readonly kind: "record"; readonly record: ArtifactStoreObjectV1 } {
    const text = readFileBoundary(this.#io, target);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(text).toString("utf8"));
    } catch {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "artifact record is not parseable JSON",
          artifactId,
          { version },
        ),
      };
    }
    const record = decodeArtifactStoreObjectV1(parsed);
    if (record === null) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "artifact record is not a valid immutable artifact binding",
          artifactId,
          { version },
        ),
      };
    }
    return { kind: "record", record };
  }

  #readStageBlob(stage: ArtifactStoreObjectV1): PayloadLookup {
    const target = this.#stageBlobPath(stage.artifactId, stage.version);
    const stat = this.#inspect(target);
    if (stat === null) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_not_prepared",
          "prepared artifact payload is missing",
          stage.artifactId,
          { version: stage.version },
        ),
      };
    }
    if (!stat.isFile()) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "prepared artifact payload is not a regular file",
          stage.artifactId,
          { version: stage.version },
        ),
      };
    }
    return { kind: "content", content: readFileBoundary(this.#io, target) };
  }

  #readObject(record: ArtifactStoreObjectV1): PayloadLookup {
    const target = this.#objectPath(record.contentHash);
    const stat = this.#inspect(target);
    if (stat === null) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_not_found",
          "committed artifact payload is missing",
          record.artifactId,
          { version: record.version },
        ),
      };
    }
    if (!stat.isFile()) {
      return {
        kind: "failure",
        failure: artifactStoreFailureV1(
          "artifact_corrupt",
          "committed artifact payload is not a regular file",
          record.artifactId,
          { version: record.version },
        ),
      };
    }
    return { kind: "content", content: readFileBoundary(this.#io, target) };
  }

  #inspect(target: string): fs.Stats | null {
    this.#assertRoot();
    return inspectPath(this.#io, this.storageRoot, this.#realRoot, target);
  }

  #assertRoot(): void {
    try {
      assertCanonicalWriteTarget(this.projectRoot, this.storageRoot, this.#io);
    } catch {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact storage root is outside the canonical .pactile tree",
      );
    }
    const stat = lstatOrNull(this.#io, this.storageRoot);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact storage root is missing or no longer a directory",
      );
    }
  }

  #ensureDirectory(target: string): void {
    assertCanonicalWriteTarget(this.projectRoot, target, this.#io);
    assertLexicallyInside(this.storageRoot, target);
    const stat = this.#inspect(target);
    if (stat === null) {
      try {
        this.#io.mkdirSync(target, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw new ArtifactBoundaryError(
          "artifact_io_failed",
          "failed to create artifact store directory",
          error instanceof Error ? { reason: error.name } : null,
        );
      }
      this.#inspect(target);
      return;
    }
    if (!stat.isDirectory()) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store path is not a directory",
      );
    }
  }

  /** Same-directory temp write followed by an atomic rename. */
  #writeAtomic(target: string, content: Uint8Array | string): void {
    this.#assertRoot();
    const directory = path.dirname(target);
    this.#ensureDirectory(directory);
    const temporary = writeTemporary(
      this.#io,
      directory,
      path.basename(target),
      content,
    );
    try {
      this.#inspect(target);
      this.#io.renameSync(temporary, target);
    } catch (error) {
      unlinkQuietly(this.#io, temporary);
      if (error instanceof ArtifactBoundaryError) throw error;
      throw new ArtifactBoundaryError(
        "artifact_io_failed",
        "failed to commit artifact store file",
      );
    }
  }

  /** Content-addressed immutable write; an existing object is reused only
   * after its bytes are proven to match the same content hash. */
  #commitObject(record: ArtifactStoreBindingV1, content: Uint8Array): void {
    const target = this.#objectPath(record.contentHash);
    const stat = this.#inspect(target);
    if (stat !== null) {
      if (!stat.isFile()) {
        throw new ArtifactBoundaryError(
          "artifact_path_escape",
          "artifact object path is not a regular file",
        );
      }
      const existing = readFileBoundary(this.#io, target);
      const failure = verifyArtifactStoreContentV1(record, existing);
      if (failure !== null) {
        throw new ArtifactBoundaryError(
          "artifact_io_failed",
          "existing content-addressed object does not match its committed hash",
          { committed: record.contentHash },
        );
      }
      return;
    }
    this.#writeAtomic(target, content);
    const stored = readFileBoundary(this.#io, target);
    const readBack = verifyArtifactStoreContentV1(record, stored);
    if (readBack !== null) {
      throw new ArtifactBoundaryError(
        "artifact_io_failed",
        "committed artifact payload failed its read-back verification",
        { committed: record.contentHash },
      );
    }
  }

  /** Records are first-writer-wins; a racing identical record is a replay. */
  #commitRecord(record: ArtifactStoreObjectV1): ArtifactStoreFailureV1 | null {
    const target = this.#recordPath(record.artifactId, record.version);
    const stat = this.#inspect(target);
    if (stat === null) {
      this.#writeAtomic(target, encodeArtifactStoreObjectV1(record));
      return null;
    }
    const decoded = this.#decodeStored(
      target,
      record.artifactId,
      record.version,
    );
    if (decoded.kind === "failure") return decoded.failure;
    return compareArtifactStoreBindingsV1(decoded.record, record);
  }
}
