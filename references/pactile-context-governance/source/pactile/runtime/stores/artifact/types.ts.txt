/** Public types and adapter-local failure contracts for the filesystem ArtifactStore. */
import {
  ARTIFACT_STORE_SCHEMA_VERSION,
  type ArtifactStoreFailureV1,
  type ArtifactStoreObjectV1,
} from "../../../agent/memory/artifact-store.js";
import type { RuntimeFileSystem } from "../../paths.js";

export const FILE_ARTIFACT_STORE_LAYOUT_VERSION = 1 as const;
export type FileArtifactStoreLayoutVersion =
  typeof FILE_ARTIFACT_STORE_LAYOUT_VERSION;

/** Adapter-local misuse failures; port outcomes never throw. */
export type FileArtifactStoreErrorCode =
  | "artifact_store_invalid_options"
  | "artifact_store_io_failed";

export class FileArtifactStoreError extends Error {
  readonly code: FileArtifactStoreErrorCode;

  constructor(code: FileArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "FileArtifactStoreError";
    this.code = code;
    Object.setPrototypeOf(this, FileArtifactStoreError.prototype);
  }
}

export interface FileArtifactStoreDiagnostics {
  /** Explicit repository root that owns the canonical `.pactile/` tree. */
  readonly projectRoot: string;
  readonly storageRoot: string;
  readonly objectRoot: string;
  readonly recordRoot: string;
  readonly stagingRoot: string;
  readonly schemaVersion: typeof ARTIFACT_STORE_SCHEMA_VERSION;
  readonly layoutVersion: FileArtifactStoreLayoutVersion;
}

export interface FileArtifactStoreOptions {
  /**
   * Explicit repository root for the canonical `.pactile/` tree. When omitted,
   * it is inferred only from a storageRoot that is already below an exact
   * `.pactile` path component.
   */
  readonly projectRoot?: string;
  /**
   * Optional override below the canonical `.pactile/` tree. The default is
   * `<projectRoot>/.pactile/runtime/memory-artifacts`; an override cannot
   * escape `.pactile`.
   */
  readonly storageRoot?: string;
  /** Injectable filesystem seam for fault tests; defaults to node:fs. */
  readonly io?: RuntimeFileSystem;
  readonly now?: () => Date;
}

export type ArtifactRecordLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "failure"; readonly failure: ArtifactStoreFailureV1 }
  | { readonly kind: "record"; readonly record: ArtifactStoreObjectV1 };

export type ArtifactStageLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "failure"; readonly failure: ArtifactStoreFailureV1 }
  | { readonly kind: "stage"; readonly stage: ArtifactStoreObjectV1 };

export type ArtifactPayloadLookup =
  | { readonly kind: "failure"; readonly failure: ArtifactStoreFailureV1 }
  | { readonly kind: "content"; readonly content: Uint8Array };

export type RecordLookup = ArtifactRecordLookup;
export type StageLookup = ArtifactStageLookup;
export type PayloadLookup = ArtifactPayloadLookup;

