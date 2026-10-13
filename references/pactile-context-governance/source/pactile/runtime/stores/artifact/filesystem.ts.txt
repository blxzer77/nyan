/** Filesystem boundary and atomic-write primitives for the ArtifactStore adapter. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeFileSystem } from "../../paths.js";

export type ArtifactBoundaryCode = "artifact_path_escape" | "artifact_io_failed";

/** Internal signal carrying a structured, fail-closed port outcome. */
export class ArtifactBoundaryError extends Error {
  constructor(
    readonly code: ArtifactBoundaryCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean>> | null = null,
  ) {
    super(message);
    this.name = "ArtifactBoundaryError";
    Object.setPrototypeOf(this, ArtifactBoundaryError.prototype);
  }
}

export function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorCodeIs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function lstatOrNull(io: RuntimeFileSystem, target: string): fs.Stats | null {
  try {
    return io.lstatSync(target);
  } catch (error) {
    if (errorCodeIs(error, "ENOENT")) return null;
    throw new ArtifactBoundaryError(
      "artifact_io_failed",
      "failed to inspect artifact store path",
    );
  }
}

export function assertLexicallyInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ArtifactBoundaryError(
      "artifact_path_escape",
      "artifact store path resolves outside the storage root",
    );
  }
}

/** Walk every existing component below the lexical root and refuse symlinks, non-regular files and hard links. */
export function inspectPath(
  io: RuntimeFileSystem,
  root: string,
  realRoot: string,
  target: string,
): fs.Stats | null {
  assertLexicallyInside(root, target);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  let current = root;
  let stat: fs.Stats | null = null;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const candidate = lstatOrNull(io, current);
    if (candidate === null) return null;
    if (candidate.isSymbolicLink()) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store path traverses a symbolic link",
      );
    }
    if (candidate.isFile() && candidate.nlink > 1) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store path is a multi-linked file",
      );
    }
    if (index < parts.length - 1 && !candidate.isDirectory()) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store path traverses a non-directory component",
      );
    }
    stat = candidate;
  }
  if (stat !== null) {
    let real: string;
    try {
      real = io.realpathSync(target);
    } catch {
      throw new ArtifactBoundaryError(
        "artifact_io_failed",
        "failed to resolve artifact store path",
      );
    }
    assertLexicallyInside(realRoot, real);
  }
  return stat;
}

export function readFileBoundary(io: RuntimeFileSystem, target: string): Uint8Array {
  try {
    return io.readFileSync(target);
  } catch (error) {
    if (errorCodeIs(error, "ENOENT")) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store file disappeared during the operation",
      );
    }
    throw new ArtifactBoundaryError(
      "artifact_io_failed",
      "failed to read artifact store file",
    );
  }
}

/** Exclusive same-directory temp write; the caller renames it into place. */
export function writeTemporary(
  io: RuntimeFileSystem,
  directory: string,
  prefix: string,
  content: Uint8Array | string,
): string {
  const temporary = path.join(directory, `${prefix}.tmp-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = io.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = io.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new ArtifactBoundaryError(
        "artifact_path_escape",
        "artifact store temp file is not an exclusive regular file",
      );
    }
    io.writeFileSync(descriptor, content);
    io.fsyncSync(descriptor);
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        io.closeSync(descriptor);
        descriptor = undefined;
      } catch {
        /* the original failure is the reportable one */
      }
    }
    if (error instanceof ArtifactBoundaryError) throw error;
    throw new ArtifactBoundaryError(
      "artifact_io_failed",
      "failed to stage artifact store file",
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        io.closeSync(descriptor);
      } catch {
        /* the original failure is the reportable one */
      }
    }
  }
}

export function unlinkQuietly(io: RuntimeFileSystem, target: string): void {
  try {
    io.unlinkSync(target);
  } catch {
    /* leftover temp files are harmless and remain discoverable */
  }
}

export function keyHash(artifactId: string, version: number): string {
  return createHash("sha256")
    .update(`${artifactId}\u0000${version}`, "utf8")
    .digest("hex");
}

