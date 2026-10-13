import {
  formatArtifactStorageRefV1,
  type ArtifactStoreBindingV1,
  type ArtifactStoreFailureV1,
  type ArtifactStorePort,
} from "../agent/memory/artifact-store.js";
import { canonicalizePactileJsonV1 } from "../shared/validation.js";

export interface RecordArtifactScopeV1 {
  readonly artifacts: ArtifactStorePort;
  readonly scopeKey: string;
  readonly version: number;
  readonly basisRevision: number;
}

type ImmutableWriteV1 =
  | { readonly ok: true; readonly binding: ArtifactStoreBindingV1 }
  | {
      readonly ok: false;
      readonly code: "artifact_prepare_failed" | "artifact_commit_failed";
      readonly failure: ArtifactStoreFailureV1;
    };

async function writeImmutable(
  input: RecordArtifactScopeV1,
  artifactId: string,
  record: object,
): Promise<ImmutableWriteV1> {
  const bytes = new TextEncoder().encode(canonicalizePactileJsonV1(record));
  const prepared = await input.artifacts.prepare({
    artifactId,
    scope: "run",
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    content: bytes,
  });
  if (!prepared.ok) {
    return { ok: false, code: "artifact_prepare_failed", failure: prepared };
  }
  const committed = await input.artifacts.commitImmutable({
    artifactId,
    scope: "run",
    scopeKey: input.scopeKey,
    version: input.version,
    basisRevision: input.basisRevision,
    contentHash: prepared.identity.contentHash,
    byteLength: prepared.identity.byteLength,
  });
  if (!committed.ok) {
    return { ok: false, code: "artifact_commit_failed", failure: committed };
  }
  return { ok: true, binding: committed.identity };
}

/**
 * A record embeds `createdAt`, so a retry with a later clock builds different
 * bytes for the same immutable artifact version and the store reports a
 * contentHash conflict. Return the `createdAt` of the artifact an earlier
 * attempt already committed so the caller can rebuild the record with it.
 * This only proposes a timestamp: the rebuilt record is written through the
 * immutable store again, which accepts it only when every other field is
 * identical. A different read, status, identity or operation therefore stays
 * a conflict.
 */
async function recordedCreatedAt(
  input: RecordArtifactScopeV1,
  artifactId: string,
  conflict: ArtifactStoreFailureV1,
): Promise<string | null> {
  const existingHash =
    conflict.code === "artifact_conflict" &&
    conflict.details?.field === "contentHash"
      ? conflict.details.existing
      : undefined;
  if (typeof existingHash !== "string") return null;
  const stored = await input.artifacts.read({
    artifactId,
    version: input.version,
    storageRef: formatArtifactStorageRefV1(
      artifactId,
      input.version,
      existingHash,
    ),
    scope: "run",
    scopeKey: input.scopeKey,
    basisRevision: input.basisRevision,
    contentHash: existingHash,
  });
  if (!stored.ok) return null;
  let earlier: unknown;
  try {
    earlier = JSON.parse(new TextDecoder().decode(stored.content)) as unknown;
  } catch {
    return null;
  }
  if (typeof earlier !== "object" || earlier === null || Array.isArray(earlier))
    return null;
  const createdAt = (earlier as Record<string, unknown>).createdAt;
  return typeof createdAt === "string" ? createdAt : null;
}

export type PersistRecordArtifactResultV1<T> =
  | {
      readonly ok: true;
      readonly binding: ArtifactStoreBindingV1;
      readonly record: T;
    }
  | {
      readonly ok: false;
      readonly code:
        | "artifact_prepare_failed"
        | "artifact_commit_failed"
        | "record_invalid";
      readonly message: string;
    };

/**
 * Commit one immutable record artifact, adopting what an earlier attempt of
 * the same operation already committed.
 *
 * `build` must be a pure function of its `createdAt` argument. `validate`
 * runs on a record rebuilt with an adopted timestamp (the initial record is
 * validated by the caller before any artifact is written).
 */
export async function persistRecordArtifactV1<T extends object>(
  input: RecordArtifactScopeV1 & {
    readonly artifactId: string;
    readonly createdAt: string;
    readonly build: (createdAt: string) => T;
    readonly validate?: (record: T) => void;
  },
): Promise<PersistRecordArtifactResultV1<T>> {
  let record = input.build(input.createdAt);
  let written = await writeImmutable(input, input.artifactId, record);
  if (!written.ok) {
    const earlier = await recordedCreatedAt(
      input,
      input.artifactId,
      written.failure,
    );
    if (earlier !== null && earlier !== input.createdAt) {
      record = input.build(earlier);
      try {
        input.validate?.(record);
      } catch (error) {
        return {
          ok: false,
          code: "record_invalid",
          message:
            error instanceof Error
              ? error.message
              : "earlier governance record is invalid",
        };
      }
      written = await writeImmutable(input, input.artifactId, record);
    }
  }
  if (!written.ok) {
    return {
      ok: false,
      code: written.code,
      message: written.failure.message,
    };
  }
  return { ok: true, binding: written.binding, record };
}
